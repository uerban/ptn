use clap::Parser;
use pt_serve::{
    acquire_pidfile, enforce_rss_budget, log_event, spawn_shutdown_observer,
    verify_producer_sentinel, DrainController, LogLevel, LoopbackPool, Metrics, PidfileError,
    ReloadRunner, RssDecision, SentinelError, ServerConfig, ServerCtx, WorkerPool,
};
use pt_shared::clock::{Clock, SystemClock};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

fn main() {
    // Stage 0: health-probe fast path. The compose healthcheck runs
    // `/pt-serve --health-probe` with NONE of the launch flags, but
    // `ServerConfig::parse()` marks `--max-rss-bytes` / `--data-root` /
    // `--city-slug` / … as required and aborts (clap exit 2) before we could
    // ever inspect a parsed `health_probe`. The probe only needs the metrics
    // address, so resolve it straight from argv/env HERE — before parse — and
    // exit. Running before `config.validate()` also matters: validate writes a
    // sentinel into `data_root`, and the probe must not touch it.
    let argv: Vec<String> = std::env::args().collect();
    if let Some(addr) =
        pt_serve::ops::health_probe::probe_target_if_requested(&argv, |k| std::env::var(k).ok())
    {
        match pt_serve::ops::health_probe::probe(&addr) {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("health-probe: {e}");
                std::process::exit(1);
            }
        }
    }

    // Stage 1: clap parse. clap handles `--help` / `--version` / parse errors
    // itself (prints to stderr, exits non-zero), so we only see `config`
    // when type-level validation passed.
    let mut config = ServerConfig::parse();
    // Stage 2: runtime filesystem + bounds validation. The clap layer covers
    // types + required-ness but cannot reach the filesystem.
    if let Err(e) = config.validate() {
        eprintln!("pt-serve: invalid config: {e}");
        std::process::exit(2);
    }
    match config.validated_poi_manifest.as_ref() {
        None => log_event(
            config.log_format,
            LogLevel::Info,
            "poi_preflight_disabled",
            &[("configured", "false")],
        ),
        Some(pt_serve::poi::catalog::PoiPreflightState::Cold) => {
            let bundle_dir = config
                .poi_bundle_dir
                .as_deref()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default();
            log_event(
                config.log_format,
                LogLevel::Warn,
                "poi_preflight_cold",
                &[("configured", "true"), ("bundleDir", &bundle_dir)],
            );
        }
        Some(pt_serve::poi::catalog::PoiPreflightState::Ready(ready)) => {
            let city_count = ready.cities.len().to_string();
            log_event(
                config.log_format,
                LogLevel::Info,
                "poi_preflight_ready",
                &[("configured", "true"), ("cityCount", &city_count)],
            );
            // Advisory, deliberately not fatal: the figure charges Brotli's
            // incompressible worst case for responses the cache stores
            // compressed, so it runs several times high on real corpora.
            // Refusing a corpus on it left POI dead in deployments whose cache
            // would never have thrashed. Surfaced so a genuine thrash risk is
            // still operable.
            if let Some(pressure) = ready.envelope_exceeds_cache_budget {
                let required = pressure.required_bytes.to_string();
                let budget = pressure.budget_bytes.to_string();
                log_event(
                    config.log_format,
                    LogLevel::Warn,
                    "poi_tile_cache_envelope_pressure",
                    &[
                        ("worstCaseRequiredBytes", &required),
                        ("budgetBytes", &budget),
                        ("estimateIsWorstCase", "true"),
                        ("poiServingAffected", "false"),
                    ],
                );
            }
        }
        Some(pt_serve::poi::catalog::PoiPreflightState::Failed(error)) => log_event(
            config.log_format,
            LogLevel::Error,
            "poi_preflight_failed",
            &[
                ("configured", "true"),
                ("error", error),
                ("transitReadinessAffected", "false"),
            ],
        ),
    }

    // kernel-released exclusive lock on the operator-supplied pidfile path. Acquired AFTER config
    // validation (so we surface "invalid config" before "pidfile already locked") but BEFORE any
    // other side-effecting work (load_initial_generation, RSS guard, listener bind). Two pt-serves
    // racing the same pidfile path lose this way: the second exits non-zero with the first's PID in
    // stderr and never reaches `load`. After the first dies — SIGKILL, OOM, clean exit — the kernel
    // reaps the lock and a successor can acquire it.
    //
    // The guard is bound to `main`'s stack frame and dropped at the very end
    // (after the shutdown observer's process::exit, which doesn't run Drop,
    // so the file unlink in Drop is the courtesy-only path). The kernel lock
    // release is what actually matters.
    let _pidfile_guard = match acquire_pidfile(&config.pidfile_path) {
        Ok(g) => {
            log_event(
                config.log_format,
                LogLevel::Info,
                "pidfile_acquired",
                &[
                    ("path", &config.pidfile_path.to_string_lossy()),
                    ("pid", &std::process::id().to_string()),
                ],
            );
            g
        }
        Err(PidfileError::AlreadyLocked { existing_pid }) => {
            let pid_str = existing_pid
                .map(|p| p.to_string())
                .unwrap_or_else(|| "unknown".into());
            log_event(
                config.log_format,
                LogLevel::Error,
                "pidfile_already_locked",
                &[
                    ("path", &config.pidfile_path.to_string_lossy()),
                    ("existingPid", &pid_str),
                ],
            );
            eprintln!(
                "pt-serve: pidfile {:?} already locked by pid={}; refusing to start",
                config.pidfile_path, pid_str
            );
            std::process::exit(1);
        }
        Err(e) => {
            log_event(
                config.log_format,
                LogLevel::Error,
                "pidfile_acquire_failed",
                &[("detail", &e.to_string())],
            );
            std::process::exit(1);
        }
    };

    // Verify the independently configured stable data-root identity BEFORE
    // loading current.json. Unbound legacy configurations retain their old
    // device/inode diagnostic; configured roots survive remounts and restores.
    //
    // Done AFTER pidfile acquire (so "another pt-serve already running"
    // wins the diagnostic) and BEFORE load_initial_generation (so a wrong-
    // mount data root produces a clear error rather than a confusing
    // "stale generation" surface).
    //
    // Only unconfigured legacy roots may omit their old stat sentinel.
    // Configured roots must be explicitly bound, including before first publish.
    if let Err(e) = verify_producer_sentinel(&config.data_root) {
        let reason = match &e {
            SentinelError::Identity(_) => "data_root_identity",
            SentinelError::StatDataRoot { .. } => "stat_data_root",
            SentinelError::ReadFile { .. } => "read_file",
            SentinelError::Malformed { .. } => "malformed",
            SentinelError::Mismatch { .. } => "mismatch",
        };
        log_event(
            config.log_format,
            LogLevel::Error,
            "sentinel_verify_failed",
            &[
                ("reason", reason),
                ("detail", &e.to_string()),
                ("dataRoot", &config.data_root.to_string_lossy()),
            ],
        );
        eprintln!("pt-serve: sentinel verification failed: {e}");
        std::process::exit(1);
    } else {
        log_event(
            config.log_format,
            LogLevel::Info,
            "sentinel_verify_ok",
            &[("dataRoot", &config.data_root.to_string_lossy())],
        );
    }

    // Deploy-ordering: advertise this binary's PTB READ-CAPABILITY at STARTUP,
    // independent of (and BEFORE) loading any generation. The producer's
    // version gate keys off this file to decide whether a compatible consumer
    // exists before it publishes a bundle. Writing it here — rather than
    // only after a successful load — removes the bootstrap chicken-and-egg:
    //   * Producer-first / stale-pt-serve / fresh-data-root rollouts no longer
    //     leave the sentinel Absent while a compatible pt-serve is in fact
    //     running, so the producer's "absent ⇒ no compatible server" fail-
    //     closed gate (refresh.rs step 2.5) is safe — a running binary has
    //     already written its version by the time the producer's next refresh tick
    //     reads it.
    // The value is the binary's own PTB_VERSION and is overwritten every startup.
    // A failed write is a WARN, not fatal; the producer fails closed for the
    // current PTB v1 contract.
    if let Err(e) = pt_serve::ops::version_sentinel::write_pt_serve_version(
        &config.data_root,
        pt_core::PTB_VERSION,
    ) {
        log_event(
            config.log_format,
            LogLevel::Warn,
            "version_sentinel_write_failed",
            &[("detail", &e.to_string())],
        );
    }

    // P4 is data-root-only. The reload runner reads `<data_root>/current.json` on startup to pick
    // the initial generation; P3's `--bundle` direct mode is gone. Boot the initial generation via
    // the loader, NOT via `Generation::from_paths` (which is now test-only).
    let metrics = Metrics::new();
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);

    let initial = pt_serve::bundle::load_initial_generation_with_force_and_page_warm(
        &config.data_root,
        &config.city_slug,
        clock.as_ref(),
        &metrics,
        config.force_current.as_deref(),
        config.log_format,
        config.city_tz_iana_default.as_deref(),
        config.pattern_mode.into(),
        config.page_warm_mode.enabled(),
    )
    .unwrap_or_else(|e| {
        eprintln!("pt-serve: startup load failed: {e}");
        std::process::exit(1);
    });

    // tzdb horizon. Forces operators to rebuild pt-serve when the compiled-in bundled tzdb release
    // is over 2 years old (hard exit) or warn at 1 year. The gauge `pt_serve_tzdb_release_age_days`
    // gives operators a cheap freshness signal in their Prometheus stack.
    //
    // Fleet-wide time-bomb hazard: every city's pt-serve binary shares the
    // SAME compiled-in tzdb release date, so hard expiry is a synchronized
    // fleet-wide crash on the SAME calendar day. PT_SERVE_TZDB_ALLOW_STALE
    // downgrades the exit(1) to a WARN so an operator can defer the crash
    // during an incident. Default behaviour (env unset) preserves the
    // existing exit(1) contract to enforce rebuild hygiene.
    //
    // The gauge is set BEFORE the gate, but note the metrics LISTENER doesn't
    // bind until WorkerPool::new (far below this block). So on the default
    // hard-exit path the process dies before any socket exists — the gauge is
    // NOT scrapeable there. The gauge is observable only while the process stays
    // alive: the WARN window (>1y, <2y — Ok path, listener binds normally) and
    // under PT_SERVE_TZDB_ALLOW_STALE (process continues). Hard expiry itself
    // is observable ONLY via the `tzdb_horizon_failure` ERROR log + the
    // container restart-count — alert on those, plus on the gauge crossing
    // ~540 days during the WARN window to pre-empt the synchronized expiry.
    {
        use pt_serve::ops::tzdb_horizon::{check_horizon, TzdbError};
        let tzdb_result = check_horizon();
        let tzdb_age = match &tzdb_result {
            Ok(age) => *age,
            Err(TzdbError::Expired { age_days, .. }) => *age_days,
        };
        metrics.set_tzdb_release_age_days(tzdb_age);
        if let Err(e) = tzdb_result {
            log_event(
                config.log_format,
                LogLevel::Error,
                "tzdb_horizon_failure",
                &[("detail", &e.to_string())],
            );
            let allow_stale = std::env::var("PT_SERVE_TZDB_ALLOW_STALE")
                .ok()
                .map(|v| !v.is_empty())
                .unwrap_or(false);
            if allow_stale {
                log_event(
                    config.log_format,
                    LogLevel::Warn,
                    "tzdb_horizon_stale_override",
                    &[(
                        "detail",
                        "PT_SERVE_TZDB_ALLOW_STALE is set; continuing despite expired tzdb",
                    )],
                );
            } else {
                std::process::exit(1);
            }
        }
    }

    // `--max-rss` startup guard. We have the loaded generation in hand → we know payload +
    // transfers sizes. Project the steady-state RSS against the operator-pinned ceiling BEFORE we
    // bind any listener so a too-tight budget surfaces as a clean exit (code 1, JSON breakdown on
    // stderr) rather than an OOMKill mid-request later. The check is hard-coded against the 2x
    // factor documented in `ops::rss_guard`; the 3-point bracketing test in `tests/rss_guard.rs`
    // pins that factor exactly.
    let payload_bytes = initial.payload_bytes_len();
    let transfers_bytes = initial.transfers_bytes_len();
    match enforce_rss_budget(&config, payload_bytes, transfers_bytes) {
        RssDecision::Accept { estimate_bytes } => {
            log_event(
                config.log_format,
                LogLevel::Info,
                "rss_guard_accept",
                &[
                    ("estimateBytes", &estimate_bytes.to_string()),
                    ("limitBytes", &config.max_rss_bytes.to_string()),
                    ("payloadBytes", &payload_bytes.to_string()),
                    ("transfersBytes", &transfers_bytes.to_string()),
                ],
            );
        }
        RssDecision::Reject {
            estimate_bytes,
            limit_bytes,
            breakdown,
        } => {
            log_event(
                config.log_format,
                LogLevel::Error,
                "rss_guard_reject",
                &[
                    ("estimateBytes", &estimate_bytes.to_string()),
                    ("limitBytes", &limit_bytes.to_string()),
                    ("breakdown", &breakdown.to_json()),
                ],
            );
            eprintln!(
                "pt-serve: rss-guard reject — projected RSS {} bytes exceeds max-rss-bytes {} bytes; refusing to bind",
                estimate_bytes, limit_bytes
            );
            std::process::exit(1);
        }
    }

    // Record the startup generation as the first adoption so the info-gauge
    // surface (`current_generation_info` + `current_generation_adopted_timestamp_seconds`)
    // is non-empty from the first scrape.
    let startup_unix = clock
        .now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    metrics.record_generation_adopted(&initial.generation_id, startup_unix);

    let listen_addr = config.listen_addr.clone();
    let metrics_listen_addr = config.metrics_listen_addr.clone();
    let loopback_listen_addr = config.loopback_listen_addr.clone();
    let loopback_worker_count = config.loopback_worker_count;
    let city_slug = config.city_slug.clone();
    let worker_pool_size = config.worker_pool_size;
    let prestop_grace = Duration::from_secs(config.prestop_grace_secs);
    let request_timeout = Duration::from_millis(config.request_timeout_ms);
    let ctx = ServerCtx::new(initial, config, Arc::clone(&metrics));

    // ---- Reload runner: spawn the dedicated thread BEFORE the worker pool, so the typed signal
    // iterator is the only thread that will observe SIGHUP/SIGTERM events.
    let shutdown_flag = match pt_serve::reload::signals::install_signal_handlers() {
        Ok(signals) => {
            let runner = Arc::new(ReloadRunner::new(
                Arc::clone(&ctx.gen_handle),
                Arc::clone(&ctx.config),
                Arc::clone(&metrics),
                Arc::clone(&clock),
            ));
            let shutdown = runner.shutdown_flag();
            let r2 = Arc::clone(&runner);
            std::thread::Builder::new()
                .name("pt-serve-reload".into())
                .spawn(move || r2.signal_loop(signals))
                .expect("spawn reload thread");
            log_event(
                ctx.config.log_format,
                LogLevel::Info,
                "reload_thread_armed",
                &[("signals", "SIGHUP,SIGTERM")],
            );
            // Self-reload: poll current.json so we adopt new generations without
            // the cross-container SIGHUP (which can't land in compose). Disabled
            // when interval == 0 (tests / SIGHUP-only). run_poll_loop also early-
            // returns on a zero interval, but gate the spawn too.
            if ctx.config.reload_poll_interval_secs > 0 {
                let r3 = Arc::clone(&runner);
                let data_root = ctx.config.data_root.clone();
                let interval = std::time::Duration::from_secs(ctx.config.reload_poll_interval_secs);
                std::thread::Builder::new()
                    .name("pt-serve-reload-poll".into())
                    .spawn(move || pt_serve::reload::poll::run_poll_loop(r3, data_root, interval))
                    .expect("spawn reload-poll thread");
                log_event(
                    ctx.config.log_format,
                    LogLevel::Info,
                    "reload_poll_thread_armed",
                    &[(
                        "interval_secs",
                        &ctx.config.reload_poll_interval_secs.to_string(),
                    )],
                );
            }

            // GTFS-RT poll thread (Node-retirement RT slice 2 — the fetch
            // half; parsing/state landed in PR #426). Fetches TripUpdates
            // feeds and publishes per-cycle snapshots into ctx.rt for
            // /health/rt and the future rtTile / departures-merge readers.
            // Mirrors the reload-poll thread: plain blocking thread, same
            // shutdown flag, no tokio.
            if ctx.rt.enabled() {
                let urls = ctx.config.rt_urls();
                let feed_count = urls.len();
                let rt_poller = pt_serve::rt::RtPoller::new(urls)
                    .expect("rt_urls() yields non-empty, no-empty-string urls");
                let rt_state = Arc::clone(&ctx.rt);
                let rt_clock: Arc<dyn Clock> = Arc::clone(&clock);
                let rt_shutdown = Arc::clone(&shutdown);
                let rt_log_format = ctx.config.log_format;
                let rt_interval = Duration::from_millis(ctx.config.rt_poll_interval_ms);
                let agent = pt_serve::rt::fetch::rt_agent();
                let rt_ctx = Arc::clone(&ctx);
                std::thread::Builder::new()
                    .name("pt-serve-rt-poll".into())
                    .spawn(move || {
                        pt_serve::rt::runner::run_rt_poll_loop(
                            rt_poller,
                            rt_state,
                            rt_clock,
                            rt_log_format,
                            rt_interval,
                            rt_shutdown,
                            move |url| pt_serve::rt::fetch::fetch_feed(&agent, url),
                            move || Some(rt_ctx.current_generation()),
                        )
                    })
                    .expect("spawn rt-poll thread");
                log_event(
                    ctx.config.log_format,
                    LogLevel::Info,
                    "rt_poll_thread_armed",
                    &[
                        ("feeds", &feed_count.to_string()),
                        ("interval_ms", &ctx.config.rt_poll_interval_ms.to_string()),
                    ],
                );
            }

            Some(shutdown)
        }
        Err(e) => {
            log_event(
                ctx.config.log_format,
                LogLevel::Warn,
                "reload_thread_install_failed",
                &[("detail", &e.to_string())],
            );
            None
        }
    };

    // WorkerPool binds both listeners (main + aux) and spawns `worker_pool_size` main workers + 1
    // aux worker. The aux listener serves the lightweight scrape surface so a /plan storm on main
    // can't head-of-line-block Prometheus or k8s probes.
    let pool = WorkerPool::new(
        &listen_addr,
        &metrics_listen_addr,
        worker_pool_size,
        Arc::clone(&ctx),
    )
    .expect("worker pool bind");
    let main_addr = pool.main_addr();
    let aux_addr = pool.aux_addr();

    // Stage-C C2c: the loopback listener (`:9002`) serves ONLY
    // `GET /api/<city>/scheduled-departures-for-stop`. It SHARES the main
    // pool's stop flag (`pool.stop_flag()`) so the SIGTERM-triggered
    // `stop_accepting()` inside the DrainController drains both pools; the
    // loopback pool is joined alongside the main pool below. Isolation from
    // external reach comes from the absence of a host-port mapping for 9002
    // in compose + the nginx isolation CI gate — NOT from the bind address
    // (it binds 0.0.0.0:9002).
    let loopback_pool = LoopbackPool::new(
        &loopback_listen_addr,
        loopback_worker_count,
        Arc::clone(&ctx),
        pool.stop_flag(),
    )
    .expect("loopback pool bind");
    let loopback_addr = loopback_pool.addr();

    eprintln!(
        "pt-serve: listening on {main_addr} (main) {aux_addr} (aux) {loopback_addr} (loopback) city={city_slug} workers={worker_pool_size} loopback_workers={loopback_worker_count}"
    );
    println!("pt-serve listening on http://{main_addr}");
    let _ = std::io::Write::flush(&mut std::io::stdout());

    // the SIGTERM-triggered shutdown observer hands control to the DrainController, which runs the
    // four-stage drain (ready=503, sleep, stop_accepting, bounded join) and returns the exit code.
    // The observer thread blocks polling the shutdown flag; when SIGTERM arrives, it invokes the
    // controller and then `std::process::exit`s with the outcome's code. Main blocks on a oneshot
    // mpsc that never receives, so the only exit path is the observer's process::exit.
    //
    // This matches the operator-facing diagnostic logged above ("reload disabled") and avoids the
    // surprise of an immediate drain on signal install failure.
    if let Some(shutdown) = shutdown_flag {
        let metrics_clone = Arc::clone(&metrics);
        let controller = DrainController::new(pool, metrics_clone, prestop_grace, request_timeout);
        spawn_shutdown_observer(shutdown, move || {
            // The controller's stage-3 `stop_accepting()` flips the SHARED
            // stop flag, so the loopback workers exit their recv loop too;
            // we join the loopback pool right after the controller drains
            // the main pool so all worker threads are reaped before exit.
            let outcome = controller.initiate_drain();
            loopback_pool.join();
            eprintln!(
                "pt-serve: drain complete in {:?} (stage_1→stage_3 grace={:?}, stage_3→stage_4 join={:?}); exit_code={}",
                outcome.total_duration,
                outcome
                    .stage_3_stop_accepting_at
                    .saturating_duration_since(outcome.stage_1_ready_503_at),
                outcome
                    .stage_4_join_complete_at
                    .saturating_duration_since(outcome.stage_3_stop_accepting_at),
                outcome.exit_code,
            );
            std::process::exit(outcome.exit_code);
        });
        // Park main until the observer process::exits. The oneshot
        // channel never receives because the observer terminates the
        // process before sending; `recv()` on a closed channel returns
        // Err when the sender drops, so we use a blocking recv on a
        // channel whose sender is held forever in scope.
        let (_park_tx, park_rx) = mpsc::channel::<()>();
        let _ = park_rx.recv();
        // recv only returns when _park_tx drops — which we hold here.
        // So in practice this line is never reached; std::process::exit
        // from the observer is the actual exit path.
        std::process::exit(0);
    } else {
        // Signal handler install failed (already logged above). Pool runs
        // until kill -9; main parks on the same dead-recv pattern so the
        // workers stay live.
        let (_park_tx, park_rx) = mpsc::channel::<()>();
        let _ = park_rx.recv();
        // Defensive drain on the off-chance recv returns (it never should).
        let controller =
            DrainController::new(pool, Arc::clone(&metrics), prestop_grace, request_timeout);
        let exit_code = controller.initiate_drain().exit_code;
        loopback_pool.join();
        std::process::exit(exit_code);
    }
}
