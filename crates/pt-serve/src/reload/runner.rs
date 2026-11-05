//!
//! The runner owns the reload state machine: read pointer → re-read target
//! generation.json → no-op classification → mmap → structural + metadata
//! validate → `Index::build` (pre-swap) → warm → write `last-good.json`
//! (PRE-SWAP, rev 3) → `ArcSwap` swap → bump epoch → drain old.
//!
//! ## Trigger surface
//!
//! Two ways to invoke a single reload pass:
//!
//! - [`ReloadRunner::run_one`] — synchronous, returns the outcome. Used by tests AND by the signal
//! loop ([`ReloadRunner::signal_loop`]).
//! - [`ReloadRunner::trigger_reload`] — equivalent to
//! receiving a SIGHUP without actually delivering one. Tests prefer this over real signal delivery
//! ('s "reserve actual SIGHUP for end-to-end tests" guidance). It enqueues a pending-reload via the
//! same latch path the signal loop uses.
//!
//! ## Pending-reload latch
//!
//! A second SIGHUP arriving while a reload is in flight sets a latch. After
//! the current reload completes (success or failure), the runner consults
//! the latch and runs exactly one follow-up. Consulting AFTER swap-or-abort
//! ensures `mapped_generation_count` never exceeds 2 even under coalescing.

use crate::bundle::{build_generation_with_page_warm, BuildInputs, Generation};
use crate::ops::metrics::{ReloadCause, ReloadResult};
use crate::ops::{Metrics, ServerConfig};
use crate::reload::test_barrier::ReloadBarrier;
use arc_swap::ArcSwap;
use pt_shared::clock::Clock;
use pt_shared::manifest::{GenerationManifest, PointerManifest};
use pt_shared::validate::errors::{IoErr, OperatorError, ProducerError, ValidationError};
use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

/// Outcome of a single reload pass. Returned by [`ReloadRunner::run_one`] so
/// tests can assert on the post-reload world without polling counters.
///
/// (Not `PartialEq` because `ValidationError` isn't `PartialEq` — its
/// `StructuralError` payload from pt-core deliberately doesn't impl it.)
#[derive(Debug, Clone)]
pub enum ReloadOutcome {
    /// A new generation was adopted; the old one is being drained.
    Adopted { generation_id: String },
    /// The on-disk manifest matched the live generation byte-for-byte. No
    /// swap was performed. Counters: `reload_total{result="noop",cause=""}` +1;
    /// `reload_consecutive_failures` UNCHANGED (rev 3 fix).
    Noop,
    /// Validation failed. The live generation is untouched. Counters:
    /// `reload_total{result="failed",cause=<cause_label>}` +1;
    /// `reload_consecutive_failures` +1; `last-good.json` UNCHANGED.
    Failed(ValidationError),
}

impl ReloadOutcome {
    /// `true` iff the outcome is `Adopted`. Sugar for tests.
    pub fn is_adopted(&self) -> bool {
        matches!(self, Self::Adopted { .. })
    }
    /// `true` iff the outcome is `Noop`. Sugar for tests.
    pub fn is_noop(&self) -> bool {
        matches!(self, Self::Noop)
    }
    /// `true` iff the outcome is `Failed`. Sugar for tests.
    pub fn is_failed(&self) -> bool {
        matches!(self, Self::Failed(_))
    }
}

/// Shared shutdown flag the (not-yet-implemented) worker pool will read on SIGTERM.
pub type ShutdownFlag = Arc<AtomicBool>;

/// The reload runner. Spawned on its own thread; owns the
/// `ArcSwap<Generation>` handle along with `ServerCtx`, plus the latch +
/// epoch counter.
pub struct ReloadRunner {
    /// The single source of truth for the active generation. The runner
    /// stores into this on a successful adoption; HTTP workers load_full
    /// per request.
    gen_handle: Arc<ArcSwap<Generation>>,
    /// Operator config — owns `data_root` + `city_slug`. The runner reads both via
    /// `self.config.data_root` / `self.config.city_slug` rather than holding redundant copies; the
    /// constructor previously took `data_root: PathBuf` + `city: String` because earlier
    /// ServerConfig revisions didn't carry them yet. Both fields are stable on ServerConfig now, so
    /// the redundant fields are gone.
    config: Arc<ServerConfig>,
    /// Per-instance metrics surface. The runner increments
    /// `reload_total`, `reload_consecutive_failures`, etc.; the Generation
    /// it constructs also carries this Arc so its Drop decrements
    /// `mapped_generation_count`.
    metrics: Arc<Metrics>,
    /// Wall-clock source. `validate_metadata` reads it for createdAt skew.
    clock: Arc<dyn Clock>,
    /// Pending-reload latch. Set when a SIGHUP arrives while a reload is in flight; consulted after
    /// the in-flight reload completes (so a third overlapping generation can never exist).
    pending_latch: Arc<AtomicBool>,
    /// `in_flight` is the rendezvous between the signal loop's "should I
    /// just set the latch?" check and the runner's own "I'm starting a
    /// reload now" claim. Set on entry to `run_one`, cleared on exit.
    in_flight: Arc<AtomicBool>,
    /// Monotonic epoch counter — each adopted generation gets the next
    /// value. The startup `Generation` is `epoch=0`; the first reload
    /// allocates `epoch=1`.
    next_epoch: Arc<AtomicU64>,
    /// Shutdown flag set on SIGTERM. The worker pool reads this on its
    /// recv_timeout loop to exit cleanly.
    shutdown: ShutdownFlag,
    /// Test-only barrier inserted between validation and swap. When `Some`, the runner calls
    /// `park()` on it after building the new generation but BEFORE the ArcSwap. The deterministic
    /// coalescing test holds the runner here while it publishes a second generation, then releases
    /// the barrier — proving the pending-reload latch picks up the latest pointer.
    test_barrier: Option<Arc<ReloadBarrier>>,
}

impl ReloadRunner {
    /// Construct a fresh runner pre-loaded with the startup `Generation`
    /// (already in `gen_handle`). `data_root` + `city` come from `config`;
    /// `next_epoch` starts at 1 because the startup generation is
    /// `epoch=0`.
    pub fn new(
        gen_handle: Arc<ArcSwap<Generation>>,
        config: Arc<ServerConfig>,
        metrics: Arc<Metrics>,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            gen_handle,
            config,
            metrics,
            clock,
            pending_latch: Arc::new(AtomicBool::new(false)),
            in_flight: Arc::new(AtomicBool::new(false)),
            next_epoch: Arc::new(AtomicU64::new(1)),
            shutdown: Arc::new(AtomicBool::new(false)),
            test_barrier: None,
        }
    }

    /// Construct a runner WITH a test-only barrier installed between
    /// validation and swap. The deterministic coalescing test uses this
    /// builder; production callers go through [`ReloadRunner::new`].
    pub fn new_with_barrier(
        gen_handle: Arc<ArcSwap<Generation>>,
        config: Arc<ServerConfig>,
        metrics: Arc<Metrics>,
        clock: Arc<dyn Clock>,
        barrier: Arc<ReloadBarrier>,
    ) -> Self {
        let mut r = Self::new(gen_handle, config, metrics, clock);
        r.test_barrier = Some(barrier);
        r
    }

    /// Clone the shutdown flag — the worker pool will read this from its accept loop. Stage 1
    /// exports the handle so wiring is plumbed even before the pool exists.
    pub fn shutdown_flag(&self) -> ShutdownFlag {
        Arc::clone(&self.shutdown)
    }

    /// Current consecutive-reload-failure count (the `reload_consecutive_failures`
    /// gauge). Read by the reload-poll loop ([`crate::reload::poll::run_poll_loop`])
    /// to size its exponential backoff; `run_one` resets it to 0 on the next
    /// success or no-op.
    pub fn consecutive_failures(&self) -> u64 {
        self.metrics.reload_consecutive_failures()
    }

    /// Test-only / internal trigger: behaves identically to receiving a
    /// SIGHUP. Returns the [`ReloadOutcome`] AFTER the reload (and any
    /// latch-driven follow-up) completes.
    ///
    /// This is the surface tests use to drive reload deterministically
    /// without delivering an actual signal (signal delivery in cargo's
    /// test harness has subtle threading quirks; see signals.rs).
    pub fn trigger_reload(&self) -> ReloadOutcome {
        self.handle_sighup_event()
    }

    /// The signal-loop entry point — owns the typed-signal iterator and
    /// dispatches on `SIGHUP` / `SIGTERM`.
    ///
    /// Intended to be called from a dedicated thread spawned by `main.rs`:
    /// `std::thread::spawn(move || runner.signal_loop(signals));`
    ///
    /// Returns when SIGTERM is received OR the signal stream errors.
    pub fn signal_loop(&self, mut signals: signal_hook::iterator::Signals) {
        for signum in signals.forever() {
            match signum {
                signal_hook::consts::SIGHUP => {
                    let _ = self.handle_sighup_event();
                }
                signal_hook::consts::SIGTERM => {
                    self.shutdown.store(true, Ordering::SeqCst);
                    break;
                }
                _ => { /* ignore */ }
            }
        }
    }

    /// Process a single SIGHUP event. If a reload is already in flight,
    /// set the pending-reload latch and return the [`ReloadOutcome::Noop`]
    /// placeholder (the in-flight reload's outcome is unknown to this
    /// caller). Otherwise run a fresh reload, then consult the latch and
    /// run a follow-up if it was set during the in-flight pass.
    fn handle_sighup_event(&self) -> ReloadOutcome {
        if self.in_flight.swap(true, Ordering::SeqCst) {
            // Another reload is already running — set the latch and bow out.
            self.pending_latch.store(true, Ordering::SeqCst);
            self.metrics.inc_reload_pending_coalesced_total();
            // The caller (the in-flight runner) will pick up the latch on
            // its way out. Return a noop placeholder; tests that need a
            // real outcome use `trigger_reload` from a single-threaded
            // context where coalescing is exercised via the test barrier.
            return ReloadOutcome::Noop;
        }
        let outcome = self.run_one();
        self.in_flight.store(false, Ordering::SeqCst);

        // Drain the latch AFTER the new generation has been retired-or- swapped — never with the
        // new mmap still live alongside the old.
        //
        // `run_one` may only ever execute while holding `in_flight`: with two
        // trigger sources (signal thread + poll thread) sharing this runner, a
        // blind `store(true)` after the release above would race a concurrent
        // trigger that just acquired the flag — two `run_one`s in parallel,
        // each mapping a generation before swapping, transiently violating
        // the `mapped_generation_count <= 2` invariant. So the follow-up must
        // RE-ACQUIRE via `swap`; if another trigger won the flag, it owns the
        // latch drain on its own way out and we leave it to them.
        //
        // The follow-up outcome is intentionally discarded: callers receive
        // only the FIRST reload's outcome (which is what triggered this
        // entrypoint). The follow-up's state is reflected through the metrics
        // surface (`reload_total{result,cause}`,
        // `current_generation_info{generation_id}`,
        // `reload_last_success_timestamp_seconds`) — operators should query
        // metrics, not the return value, for the follow-up's adoption state.
        loop {
            if !self.pending_latch.load(Ordering::SeqCst) {
                break;
            }
            if self.in_flight.swap(true, Ordering::SeqCst) {
                // Another trigger holds the flag; it drains the latch on its
                // way out (it either consumes this latch or re-latches).
                break;
            }
            // Re-acquired. Only the holder consumes the latch, so this swap
            // observes any latch set up to this point; a latch set AFTER it
            // is caught by the next loop iteration (we still hold the flag
            // through run_one, so late triggers latch rather than run).
            if self.pending_latch.swap(false, Ordering::SeqCst) {
                let _follow = self.run_one();
            }
            self.in_flight.store(false, Ordering::SeqCst);
        }
        outcome
    }

    /// Execute one full reload pass. Used by tests AND by
    /// `handle_sighup_event`. Updates metrics per the spec's `reload_total`
    /// and `reload_consecutive_failures` rules, plus the
    /// `reload_duration_seconds` histogram (sampled here so the timed region
    /// spans the full pointer-read → adopt-or-fail path).
    pub fn run_one(&self) -> ReloadOutcome {
        let pass_start = std::time::Instant::now();
        let result = self.run_one_inner();
        // Sample duration BEFORE the per-outcome metric updates so the
        // histogram observation reflects only the work done in the
        // reload pass itself, not the bookkeeping below.
        let elapsed_secs = pass_start.elapsed().as_secs_f64();
        self.metrics.reload_duration_seconds.observe(elapsed_secs);
        match &result {
            Ok(InnerOutcome::Adopted { generation_id }) => {
                self.metrics
                    .inc_reload_total(ReloadResult::Ok, ReloadCause::None);
                self.metrics.reset_reload_consecutive_failures();
                let now_unix = self
                    .clock
                    .now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                self.metrics
                    .set_reload_last_success_timestamp_seconds(now_unix);
                self.metrics
                    .record_generation_adopted(generation_id, now_unix);
                // a successful adopt-from-current proves the pointer is healthy again — clear the
                // startup-fallback flag so `/ready` no longer reports `servingLastGoodFallback`.
                self.metrics.set_startup_fallback_active(false);
                ReloadOutcome::Adopted {
                    generation_id: generation_id.clone(),
                }
            }
            Ok(InnerOutcome::Noop) => {
                self.metrics
                    .inc_reload_total(ReloadResult::Noop, ReloadCause::None);
                // NOTE: noop does NOT reset reload_consecutive_failures
                // (rev 3 fix — explicit absence of a reset call here is
                // load-bearing; reviewers please do not add one).
                ReloadOutcome::Noop
            }
            Err(e) => {
                let cause = ReloadCause::from_label(e.cause_label());
                self.metrics.inc_reload_total(ReloadResult::Failed, cause);
                self.metrics.inc_reload_consecutive_failures();
                if let ValidationError::Operator(OperatorError::UnsupportedManifestSchemaVersion(
                    v,
                )) = e
                {
                    self.metrics.inc_reload_manifest_version_unsupported(*v);
                }
                ReloadOutcome::Failed(e.clone())
            }
        }
    }

    fn run_one_inner(&self) -> Result<InnerOutcome, ValidationError> {
        // ---- 1. read current.json ----
        let ptr = read_pointer_manifest(&self.config.data_root.join("current.json"))?;
        // ---- 2. no-op classification: re-read target generation.json
        //         (do NOT short-circuit on id alone — bytes may be corrupt
        //          even when the pointer hasn't moved).
        let current_gen = self.gen_handle.load();
        let current_gen_id = current_gen.generation_id.clone();
        let current_bundle_sha = current_gen.bundle_sha256.clone();
        // Drop the load handle before potentially long mmap+validate work.
        drop(current_gen);

        let gen_dir = self
            .config
            .data_root
            .join("generations")
            .join(&ptr.generation_id);
        let manifest_path = gen_dir.join("generation.json");
        let target = read_target_manifest(&manifest_path)?;

        let bundle_path = gen_dir.join("bundle.ptb");
        let transfers_path = if target.has_transfers {
            Some(gen_dir.join("transfers.bin"))
        } else {
            None
        };

        // Cheap on-disk precheck — catches truncation/growth when the pointer
        // hasn't moved. Same-size in-place corruption is caught by the no-op
        // path's re-hash below, or by the full validate on the rebuild path.
        let on_disk_size = fs::metadata(&bundle_path)
            .map_err(|e| ValidationError::Io(IoErr::from(e)))?
            .len();
        if on_disk_size != target.bundle_size_bytes {
            return Err(ProducerError::BundleSizeMismatch {
                expected: target.bundle_size_bytes,
                actual: on_disk_size,
            }
            .into());
        }

        // Same pointer — classify as a no-op only when we can positively
        // verify the manifest still describes both the bytes we serve and the
        // bytes on disk. A live generation without a bundle sha (startup via
        // `from_paths`) cannot be verified, so fall through to a full rebuild
        // (which re-validates hashes structurally) instead of trusting an
        // unverifiable no-op.
        if ptr.generation_id == current_gen_id && !current_bundle_sha.is_empty() {
            // A bundle_sha disagreement between the target manifest and the live generation is a
            // producer-side generationId reuse violation.
            if target.bundle_sha256 != current_bundle_sha {
                return Err(ProducerError::GenerationIdHashMismatch.into());
            }
            // The size precheck above can't see same-size in-place
            // corruption; re-hash the on-disk bytes so Noop really means
            // "manifest, served bytes, and on-disk bytes all agree". Reloads
            // only fire on pointer-mtime change or SIGHUP, so this streaming
            // read is rare, not per-poll.
            let computed = file_sha256_hex(&bundle_path)?;
            if !computed.eq_ignore_ascii_case(&target.bundle_sha256) {
                return Err(ProducerError::BundleHashMismatch {
                    expected: target.bundle_sha256.clone(),
                    computed,
                }
                .into());
            }
            return Ok(InnerOutcome::Noop);
        }

        // ---- 3-7. build the new generation via the shared builder ----
        let epoch = self.next_epoch.fetch_add(1, Ordering::SeqCst);
        let new_gen = build_generation_with_page_warm(
            BuildInputs {
                manifest: &target,
                bundle_path: &bundle_path,
                transfers_path: transfers_path.as_deref(),
                expected_city: &self.config.city_slug,
                clock: self.clock.as_ref(),
                is_startup: false,
                epoch,
                metrics: Some(Arc::clone(&self.metrics)),
                city_tz_iana_default: self.config.city_tz_iana_default.as_deref(),
                pattern_mode: self.config.pattern_mode.into(),
            },
            self.config.page_warm_mode.enabled(),
            Some(self.config.log_format),
        )?;

        // ---- 8. write last-good.json PRE-SWAP (rev 3 ordering) ----
        //
        // If this write fails, abort the reload as `ValidationError::Io`.
        // The live generation is untouched (we haven't called
        // `gen_handle.store` yet).
        write_last_good_pointer(&self.config.data_root, &ptr).map_err(|e| {
            ValidationError::Io(IoErr {
                kind: e.kind(),
                msg: format!("write last-good.json: {e}"),
            })
        })?;

        // ---- 8.5 (test only): park between validation+last-good and swap ----
        //
        // The coalescing test installs a `ReloadBarrier` so it can publish a
        // SECOND generation while this reload is parked here. After the
        // test releases the barrier, the original reload proceeds to swap;
        // the SIGHUP delivered while parked sets the pending-reload latch,
        // and the runner's outer loop picks up the new pointer.
        if let Some(b) = self.test_barrier.as_ref() {
            b.park();
        }

        // ---- 9. swap ----
        let gen_id = new_gen.generation_id.clone();
        self.gen_handle.store(Arc::new(new_gen));
        // Note: the old `Arc<Generation>` returned by `store` is dropped
        // when the last in-flight worker releases its load_full clone.
        // That triggers `Generation::drop`, which decrements
        // `mapped_generation_count` and bumps `generation_retired_total`.

        Ok(InnerOutcome::Adopted {
            generation_id: gen_id,
        })
    }
}

/// Internal outcome before metric labels are attached. The public surface is
/// [`ReloadOutcome`] which carries the cloned `ValidationError` (so tests can
/// pattern-match on it).
enum InnerOutcome {
    Adopted { generation_id: String },
    Noop,
}

// ---------------------------------------------------------------------------
// IO helpers — pointer / manifest read, last-good write
// ---------------------------------------------------------------------------

/// Stream a file through SHA-256, returning lowercase hex. 1 MiB read buffer
/// — the bundle can be tens of MB and the no-op precheck must not
/// materialize it.
fn file_sha256_hex(path: &Path) -> Result<String, ValidationError> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut f = fs::File::open(path).map_err(|e| ValidationError::Io(IoErr::from(e)))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| ValidationError::Io(IoErr::from(e)))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// Read + parse a pointer manifest from disk. Returns ValidationError::Io on
/// any failure (missing file, malformed JSON, etc.) so the runner has one
/// uniform error class for the read path.
fn read_pointer_manifest(path: &Path) -> Result<PointerManifest, ValidationError> {
    let text = fs::read_to_string(path).map_err(|e| ValidationError::Io(IoErr::from(e)))?;
    serde_json::from_str(&text).map_err(|e| {
        ValidationError::Io(IoErr {
            kind: io::ErrorKind::InvalidData,
            msg: format!("pointer {} malformed: {e}", path.display()),
        })
    })
}

/// Read + parse a generation manifest from disk.
fn read_target_manifest(path: &Path) -> Result<GenerationManifest, ValidationError> {
    let text = fs::read_to_string(path).map_err(|e| ValidationError::Io(IoErr::from(e)))?;
    serde_json::from_str(&text).map_err(|e| {
        ValidationError::Io(IoErr {
            kind: io::ErrorKind::InvalidData,
            msg: format!("manifest {} malformed: {e}", path.display()),
        })
    })
}

/// Write `last-good.json` PRE-SWAP (rev 3 ordering) via the standard
/// write-tmp + rename + fsync idiom. The tmp sibling is `last-good.json.tmp`;
/// a producer-style atomic swap means a partially-written file is never
/// observable as `last-good.json`.
fn write_last_good_pointer(data_root: &Path, ptr: &PointerManifest) -> io::Result<()> {
    let final_path = data_root.join("last-good.json");
    let tmp_path = data_root.join("last-good.json.tmp");
    let bytes = serde_json::to_vec_pretty(ptr).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("serialize last-good.json: {e}"),
        )
    })?;
    {
        use std::io::Write;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp_path)?;
        f.write_all(&bytes)?;

        use std::os::fd::AsFd;
        pt_shared::fsync::durable(f.as_fd())?;
    }
    fs::rename(&tmp_path, &final_path)?;
    // Fsync the parent dir so the rename is durable too (durable_dir handles
    // the macOS dir-fd F_FULLFSYNC quirk). The producer path
    // (crates/pt-producer/src/refresh.rs) propagates this error via
    // `?`; we MUST do the same so a failed parent fsync surfaces as a reload
    // failure rather than a silently-non-durable last-good pointer. A torn
    // last-good after a power loss would either block pt-serve startup or
    // (worse) point at a wrong generation.
    use std::os::fd::AsFd;
    let dir = fs::File::open(data_root)?;
    pt_shared::fsync::durable_dir(dir.as_fd())?;
    Ok(())
}
