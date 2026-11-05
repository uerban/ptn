//! Fault-injection knobs for the publish protocol.
//!
//! the producer's crash-safety guarantees rest on rename atomicity + fsync ordering + the
//! `.publishing` staging convention. To prove those guarantees we need a way to crash the producer
//! at well-defined boundaries and assert post-conditions. This module defines the boundaries.
//!
//! `FaultPoint::from_env()` reads `PT_PRODUCER_FAULT_INJECT` once at start of
//! tick. Each variant maps to a specific abort point inside `refresh.rs`. The
//! abort uses `std::process::exit(42)` (sentinel = "fault-injected") so tests
//! can distinguish a fault-injected abort from a real ENOSPC / lock failure
//! (both of which exit with status 1).
//!
//! ## Design notes
//!
//! - **Production-safe.** The env var is unset in prod; `FaultPoint::from_env`
//!   returns `None` and every `maybe_fault(...)` call short-circuits. No
//!   runtime cost beyond a single env lookup at start-of-tick.
//! - **One fault per run.** A given PT_PRODUCER_FAULT_INJECT value fires at
//!   exactly one point. To exercise two faults you run the producer twice.
//! - **`EnospcStep3` + `MidRenameCopyup` are simulated, not real.** ENOSPC is
//!   surfaced by returning `io::Error::from_raw_os_error(28)` at the bundle-
//!   write call site; overlayfs copy-up failure is approximated with
//!   `io::ErrorKind::PermissionDenied` at the rename call site. Both
//!   approximations are documented at the call sites in `refresh.rs`.

/// Exit code used by every fault-injected abort. Distinct from `1` (real
/// publish failure) so the test harness can assert "this was a deliberate
/// abort, not a real producer bug".
pub const FAULT_INJECT_EXIT_CODE: i32 = 42;

/// Env var name. Operators NEVER set this in production; CI sets it from the
/// fault-injection test harness.
pub const FAULT_INJECT_ENV: &str = "PT_PRODUCER_FAULT_INJECT";

/// One named abort point in the publish protocol. The string values map to
/// `PT_PRODUCER_FAULT_INJECT` env values; the variants map to specific call
/// sites in `refresh.rs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FaultPoint {
    /// Crash after step 4 (PTB + transfers + manifest written to staging,
    /// fsync'd) but BEFORE the staging-dir rename in step 7.
    ///
    /// Post-condition: `<data_root>/.publishing/<gen>/{bundle.ptb,
    /// generation.json}` exist on disk; `<data_root>/generations/<gen>/`
    /// does NOT exist; `current.json` is unchanged.
    AfterStep4,

    /// Crash between step 5 (manifest fsync) and step 7 (rename).
    BetweenStep5AndStep7,

    /// Run step 7 (rename to `generations/<gen>/`), then deliberately fail
    /// validation in step 8 — the staging directory has been committed to
    /// the visible-generations namespace, but `current.json` MUST NOT flip.
    AfterStep7ValidateFail,

    /// Crash after step 9 (`current.json` flipped) but BEFORE step 10
    /// (SIGHUP). Asserts the running pt-serve has not yet been signalled
    /// AND a restart would still find the new generation as current.
    AfterStep9,

    /// Crash AFTER step 10 (SIGHUP sent). The full publish succeeded; the
    /// abort is just for symmetry with the test matrix. Post-condition is
    /// indistinguishable from a clean exit immediately after step 10.
    AfterSighup,

    /// Approximate overlayfs copy-up failure mid-rename in step 7. We can't
    /// actually trigger this without an overlayfs mount, so the simulation
    /// is `io::ErrorKind::PermissionDenied` at the rename. Real overlayfs
    /// would return EXDEV-ish; the test asserts the staging dir survives
    /// for forensics regardless of which errno fires.
    MidRenameCopyup,

    /// Simulate ENOSPC at the bundle-write call site in step 3. Real ENOSPC
    /// would surface from `write(2)`; we synthesise it with
    /// `io::Error::from_raw_os_error(28)` (Linux ENOSPC). Post-condition:
    /// staging dir survives for janitor sweep, no `current.json` flip.
    EnospcStep3,

    /// Hold the producer.lock for 2 seconds AFTER acquire, then exit
    /// successfully. Used by `tests/publish_protocol_faults.rs::
    /// concurrent_producers_serialize_via_lock` to deterministically
    /// force a second producer to race a held lock without depending on
    /// OS-scheduler luck. Fires immediately after `producer_lock::acquire`
    /// returns on the FIRST publish tick and ONLY in the periodic-refresh
    /// codepath; the test pairs this with a second producer that runs
    /// without the fault. NOT meant for production scenarios.
    HoldLockFor2s,
}

impl FaultPoint {
    /// Read `PT_PRODUCER_FAULT_INJECT` once, parse, return the matched variant.
    /// `None` means the env var is absent or doesn't match a known fault
    /// point (an unknown value is a no-op — fault injection is opt-in).
    pub fn from_env() -> Option<Self> {
        let val = std::env::var(FAULT_INJECT_ENV).ok()?;
        Self::parse(val.as_str())
    }

    /// Parse from a string. Public for tests that want to drive the matrix
    /// without touching the process env.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "after_step_4" => Some(Self::AfterStep4),
            "between_step_5_and_step_7" => Some(Self::BetweenStep5AndStep7),
            "after_step_7_validate_fail" => Some(Self::AfterStep7ValidateFail),
            "after_step_9" => Some(Self::AfterStep9),
            "after_sighup" => Some(Self::AfterSighup),
            "mid_rename_copyup" => Some(Self::MidRenameCopyup),
            "enospc_step_3" => Some(Self::EnospcStep3),
            "hold_lock_for_2s" => Some(Self::HoldLockFor2s),
            _ => None,
        }
    }

    /// String name (the env-value form). Used in stderr logging.
    pub fn as_env_str(self) -> &'static str {
        match self {
            Self::AfterStep4 => "after_step_4",
            Self::BetweenStep5AndStep7 => "between_step_5_and_step_7",
            Self::AfterStep7ValidateFail => "after_step_7_validate_fail",
            Self::AfterStep9 => "after_step_9",
            Self::AfterSighup => "after_sighup",
            Self::MidRenameCopyup => "mid_rename_copyup",
            Self::EnospcStep3 => "enospc_step_3",
            Self::HoldLockFor2s => "hold_lock_for_2s",
        }
    }
}

/// If `active` matches `expected`, log + abort the process with the fault-
/// injection exit code. Called at every documented abort point in
/// `refresh.rs`.
pub fn maybe_abort_at(active: Option<FaultPoint>, expected: FaultPoint) {
    if active == Some(expected) {
        eprintln!(
            "[producer] FAULT_INJECT={} — aborting with exit code {}",
            expected.as_env_str(),
            FAULT_INJECT_EXIT_CODE,
        );
        // Flush stderr so the test harness sees the line before the process
        // dies. (Most stderr is line-buffered to a terminal but block-
        // buffered to a pipe — the explicit flush is paranoia.)
        use std::io::Write as _;
        let _ = std::io::stderr().flush();
        std::process::exit(FAULT_INJECT_EXIT_CODE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_all_known_variants() {
        let cases = &[
            ("after_step_4", FaultPoint::AfterStep4),
            (
                "between_step_5_and_step_7",
                FaultPoint::BetweenStep5AndStep7,
            ),
            (
                "after_step_7_validate_fail",
                FaultPoint::AfterStep7ValidateFail,
            ),
            ("after_step_9", FaultPoint::AfterStep9),
            ("after_sighup", FaultPoint::AfterSighup),
            ("mid_rename_copyup", FaultPoint::MidRenameCopyup),
            ("enospc_step_3", FaultPoint::EnospcStep3),
            ("hold_lock_for_2s", FaultPoint::HoldLockFor2s),
        ];
        for (s, fp) in cases {
            assert_eq!(FaultPoint::parse(s), Some(*fp), "parse {s}");
            assert_eq!(fp.as_env_str(), *s, "round-trip {s}");
        }
    }

    #[test]
    fn unknown_value_parses_to_none() {
        assert_eq!(FaultPoint::parse(""), None);
        assert_eq!(FaultPoint::parse("not_a_fault"), None);
        assert_eq!(FaultPoint::parse("AFTER_STEP_4"), None); // case-sensitive
    }

    /// `maybe_abort_at` is a no-op when `active` doesn't match. (We can't
    /// test the abort branch directly without exiting the test process.)
    #[test]
    fn maybe_abort_is_noop_when_no_match() {
        // None active: no-op.
        maybe_abort_at(None, FaultPoint::AfterStep4);
        // Different variant active: no-op.
        maybe_abort_at(Some(FaultPoint::AfterStep9), FaultPoint::AfterStep4);
    }
}
