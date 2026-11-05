use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

pub fn install_signal_handler() -> Arc<AtomicBool> {
    let stop = Arc::new(AtomicBool::new(false));
    // Log registration failures so an unresponsive-to-SIGTERM producer leaves a
    // breadcrumb in `docker logs` rather than appearing to hang. The idle
    // loop's `max_secs` cap still bounds runtime if both registrations fail.
    if let Err(e) = signal_hook::flag::register(signal_hook::consts::SIGTERM, stop.clone()) {
        eprintln!("[producer] WARN: SIGTERM handler registration failed: {e}");
    }
    if let Err(e) = signal_hook::flag::register(signal_hook::consts::SIGINT, stop.clone()) {
        eprintln!("[producer] WARN: SIGINT handler registration failed: {e}");
    }
    stop
}

pub fn sleep_until_term(stop: &AtomicBool, max_secs: u64) {
    let mut elapsed = 0u64;
    while !stop.load(Ordering::SeqCst) && elapsed < max_secs {
        std::thread::sleep(Duration::from_secs(1));
        elapsed += 1;
    }
}
