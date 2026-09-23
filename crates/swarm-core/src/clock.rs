//! Wall-clock timestamps as signed Unix-epoch offsets.
//!
//! Every persisted or wire-visible timestamp in `swarm-core` (event
//! envelopes, bus messages, metrics samples, lock info, session and
//! worker start times) is an `i64` offset from the Unix epoch. These two
//! helpers are the one place that conversion happens.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Time elapsed since the Unix epoch, or zero when the system clock
/// reads earlier than the epoch.
fn since_epoch() -> Duration {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
}

/// Milliseconds since the Unix epoch (`0` if the clock reads before it).
pub fn unix_millis() -> i64 {
    i64::try_from(since_epoch().as_millis()).unwrap_or(i64::MAX)
}

/// Whole seconds since the Unix epoch (`0` if the clock reads before it).
pub fn unix_secs() -> i64 {
    i64::try_from(since_epoch().as_secs()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_millis_and_secs_agree() {
        let secs = unix_secs();
        let millis = unix_millis();
        assert!(secs > 0, "system clock should read after the Unix epoch");
        assert!((millis / 1000 - secs).abs() <= 1);
    }
}
