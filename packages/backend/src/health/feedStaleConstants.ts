/**
 * Feed-staleness threshold (days). When the active generation's
 * `feed_start_date` lies further in the past than this, `/api/health/ready`
 * surfaces `serviceWindowStale=true` so the upstream alerting can page
 * before the 90-day service-window bitmask runs out (10-day buffer between
 * staleness alert and total exhaustion).
 *
 * **Mirrored in Rust** as `pt_serve::ops::readiness::FEED_STALE_DAYS`. The
 * pt-serve `build.rs` greps THIS file at compile time and emits the value
 * into `NODE_FEED_STALE_DAYS`, which the integration test
 * `crates/pt-serve/tests/feed_stale_constant.rs` asserts equal to the Rust
 * constant. Any divergence breaks the Rust build, not silently — never
 * change one without the other.
 */
export const FEED_STALE_DAYS = 80 as const;
