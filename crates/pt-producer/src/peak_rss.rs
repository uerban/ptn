//! Peak resident memory of this process, logged when the producer exits so
//! operators can see how close a city's republish comes to its container
//! memory limit before it is killed for crossing it.

/// Peak resident set size in KiB, or `None` when the platform cannot say.
pub fn peak_rss_kib() -> Option<u64> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: getrusage writes into the provided struct and nothing else.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: getrusage returned 0, so the struct is initialised.
    let max = unsafe { usage.assume_init() }.ru_maxrss;
    let max = u64::try_from(max).ok()?;
    // Linux reports KiB; macOS reports bytes.
    Some(if cfg!(target_os = "macos") {
        max / 1024
    } else {
        max
    })
}

/// The exit log line: `[producer] peak_rss_mib=N`.
pub fn line(kib: u64) -> String {
    format!("[producer] peak_rss_mib={}", kib.div_ceil(1024))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_a_plausible_peak() {
        let held = vec![1u8; 32 * 1024 * 1024];
        std::hint::black_box(&held);
        let kib = peak_rss_kib().expect("getrusage works on supported platforms");
        assert!(kib >= 32 * 1024, "peak {kib} KiB below the 32 MiB held");
        assert!(kib < 64 * 1024 * 1024, "peak {kib} KiB is implausible");
    }

    #[test]
    fn line_rounds_up_to_whole_mib() {
        assert_eq!(line(1), "[producer] peak_rss_mib=1");
        assert_eq!(line(1024), "[producer] peak_rss_mib=1");
        assert_eq!(line(1025), "[producer] peak_rss_mib=2");
    }
}
