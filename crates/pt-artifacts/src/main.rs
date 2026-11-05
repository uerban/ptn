use clap::{Parser, Subcommand};
use pt_artifacts::{
    install::{self, LocalRepository, Repository},
    store::Store,
    transport::HttpsRepository,
};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Read},
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Parser)]
#[command(about = "Install independent, signed PTN city artifacts")]
struct Cli {
    #[arg(long)]
    config: PathBuf,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Sync,
    Run,
    Status,
    Pin { city: String },
    Unpin { city: String },
    Rollback { city: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Config {
    root: PathBuf,
    /// Absent: every city stays unavailable until an operator configures one.
    #[serde(default)]
    source: Option<Source>,
    trusted_keys: Vec<String>,
    cities: BTreeMap<String, Policy>,
    #[serde(default = "daily")]
    interval_seconds: u64,
    /// Absent: retain every release (no consumer can be proven idle).
    #[serde(default)]
    retention: Option<Retention>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Retention {
    /// Writable directory shared with every lease-holding consumer.
    lease_root: PathBuf,
    /// How long an unreferenced release stays fetchable by browsers that
    /// discovered its immutable URLs. Must cover a full refresh interval.
    #[serde(default = "week")]
    grace_seconds: u64,
}
fn week() -> u64 {
    7 * 86400
}
fn daily() -> u64 {
    86400
}

/// Failed startup/refresh must not wait the full (normally daily) cadence.
/// Sleep durations use the monotonic clock; wall-clock changes cannot extend
/// backoff. Successful cycles restore the configured cadence immediately.
#[derive(Default)]
struct RefreshSchedule {
    failures: u32,
}
impl RefreshSchedule {
    fn next_delay(&mut self, success: bool, interval: u64, entropy: u64) -> Duration {
        let base = if success {
            self.failures = 0;
            interval
        } else {
            self.failures = self.failures.saturating_add(1);
            (60u64.saturating_mul(1u64 << (self.failures - 1).min(3)))
                .min(300)
                .min(interval)
        };
        Duration::from_secs(base.saturating_add(entropy % (base / 10 + 1)))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Policy {
    #[serde(default = "required_producer_inputs")]
    required: Vec<String>,
}
fn required_producer_inputs() -> Vec<String> {
    vec!["walking".into(), "addresses".into()]
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
enum Source {
    Https { url: String },
    Local { directory: PathBuf },
}
enum Transport {
    Https(HttpsRepository),
    Local(LocalRepository),
}
impl Repository for Transport {
    fn open(&self, relative: &str) -> io::Result<Box<dyn Read>> {
        match self {
            Self::Https(repo) => repo.open(relative),
            Self::Local(repo) => repo.open(relative),
        }
    }
}

fn keys(values: &[String]) -> io::Result<Vec<[u8; 32]>> {
    values
        .iter()
        .map(|value| {
            if !pt_shared::osm_manifest::valid_digest(value) {
                return Err(io::Error::other(
                    "trusted keys must be 32-byte lowercase hex Ed25519 public keys",
                ));
            }
            let mut result = [0; 32];
            for (i, byte) in result.iter_mut().enumerate() {
                *byte =
                    u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).map_err(io::Error::other)?;
            }
            Ok(result)
        })
        .collect()
}

fn cycle(config: &Config, transport: &Transport, keys: &[[u8; 32]]) -> io::Result<()> {
    let store = Store::open(&config.root)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_secs() as i64;
    let mut failures = 0;
    for (city, policy) in &config.cities {
        let required: Vec<_> = policy.required.iter().map(String::as_str).collect();
        let result = install::sync(&store, transport, city, keys, now, &required);
        let message = result.as_ref().err().map(ToString::to_string);
        if let Err(error) = store.record_refresh(city, now, message.as_deref()) {
            failures += 1;
            eprintln!("{city}: could not persist refresh status: {error}");
        }
        match result {
            Ok(changed) => eprintln!(
                "{city}: {}",
                if changed {
                    "activated"
                } else {
                    "unchanged or pinned"
                }
            ),
            Err(error) => {
                failures += 1;
                eprintln!("{city}: refresh failed: {error}");
            }
        }
    }
    let cities: Vec<_> = config.cities.keys().map(String::as_str).collect();
    if let Err(error) = store.compose_poi(&cities) {
        failures += 1;
        eprintln!("POI composition failed; last working aggregate retained: {error}");
    }
    if let Some(retention) = &config.retention {
        let policy = pt_artifacts::retention::Policy {
            grace_seconds: retention.grace_seconds,
            lease_root: retention.lease_root.clone(),
        };
        match store.prune(&cities, &policy, now) {
            Ok(report) if report.deferred => eprintln!("retention: consumer resolving; deferred"),
            Ok(report) => eprintln!(
                "retention: removed {} releases, {} POI compositions, {} objects",
                report.releases_removed.len(),
                report.compositions_removed.len(),
                report.objects_removed
            ),
            // Pruning never affects serving; report and retry next cycle.
            Err(error) => eprintln!("retention failed; releases retained: {error}"),
        }
    }
    if failures > 0 {
        return Err(io::Error::other(format!(
            "{failures} city refreshes failed; installed releases retained"
        )));
    }
    Ok(())
}

const NO_SOURCE: &str = "no artifact source configured";

/// A stack can start before its artifact source is configured. Stay up and
/// report every city unavailable instead of crash-looping on the config.
fn unconfigured(config: &Config, once: bool) -> Result<(), Box<dyn std::error::Error>> {
    let store = Store::open(&config.root)?;
    loop {
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
        for city in config.cities.keys() {
            store.record_refresh(city, now, Some(NO_SOURCE))?;
        }
        eprintln!("{NO_SOURCE}; every city is unavailable");
        if once {
            return Err(NO_SOURCE.into());
        }
        std::thread::sleep(Duration::from_secs(config.interval_seconds));
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    let config: Config = serde_json::from_slice(&fs::read(cli.config)?)?;
    if config.cities.is_empty() || config.interval_seconds < 60 {
        return Err("configure cities and an interval of at least 60 seconds".into());
    }
    if config
        .retention
        .as_ref()
        .is_some_and(|r| r.grace_seconds < config.interval_seconds)
    {
        return Err("retention graceSeconds must be at least intervalSeconds".into());
    }
    for policy in config.cities.values() {
        if policy
            .required
            .iter()
            .any(|name| !["walking", "addresses", "walkGraph", "poi"].contains(&name.as_str()))
        {
            return Err("unknown required component".into());
        }
    }
    match cli.command {
        Command::Status => {
            let store = Store::open(&config.root)?;
            let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
            let statuses: BTreeMap<_, _> = config
                .cities
                .keys()
                .map(|city| {
                    store
                        .operational_status(city, now)
                        .map(|status| (city, status))
                })
                .collect::<io::Result<_>>()?;
            println!("{}", serde_json::to_string_pretty(&statuses)?);
        }
        Command::Pin { city } | Command::Unpin { city } | Command::Rollback { city }
            if !config.cities.contains_key(&city) =>
        {
            return Err("city is not enabled in this deployment".into())
        }
        Command::Pin { city } => Store::open(&config.root)?.set_pinned(&city, true)?,
        Command::Unpin { city } => Store::open(&config.root)?.set_pinned(&city, false)?,
        Command::Rollback { city } => {
            let store = Store::open(&config.root)?;
            let state = store.rollback(&city)?;
            let cities: Vec<_> = config.cities.keys().map(String::as_str).collect();
            store.compose_poi(&cities)?;
            println!("{}", serde_json::to_string(&state)?);
        }
        command @ (Command::Sync | Command::Run) => {
            let Some(source) = &config.source else {
                return unconfigured(&config, matches!(command, Command::Sync));
            };
            let keys = keys(&config.trusted_keys)?;
            if keys.is_empty() {
                return Err("at least one trusted signing key is required".into());
            }
            let transport = match source {
                Source::Https { url } => Transport::Https(HttpsRepository::new(url)?),
                Source::Local { directory } => Transport::Local(LocalRepository(directory.clone())),
            };
            let mut schedule = RefreshSchedule::default();
            loop {
                let result = cycle(&config, &transport, &keys);
                if matches!(command, Command::Sync) {
                    return result.map_err(Into::into);
                }
                let success = result.is_ok();
                if let Err(error) = result {
                    eprintln!("{error}");
                }
                // Bound jitter to 10%; lock is released between refresh cycles so
                // operator commands can pin/rollback without stopping the manager.
                let entropy = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .subsec_nanos() as u64;
                std::thread::sleep(schedule.next_delay(success, config.interval_seconds, entropy));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_refresh_retries_promptly_and_success_restores_cadence() {
        let mut schedule = RefreshSchedule::default();
        for expected in [60, 120, 240, 300, 300] {
            assert_eq!(schedule.next_delay(false, daily(), 0).as_secs(), expected);
        }
        assert_eq!(schedule.next_delay(true, daily(), 0).as_secs(), daily());
        assert_eq!(schedule.next_delay(false, daily(), 0).as_secs(), 60);
    }

    #[test]
    fn retry_respects_short_intervals_and_bounded_jitter() {
        let mut schedule = RefreshSchedule::default();
        for _ in 0..20 {
            let delay = schedule.next_delay(false, 60, u64::MAX).as_secs();
            assert!((60..=66).contains(&delay));
        }
        let delay = schedule.next_delay(true, daily(), u64::MAX).as_secs();
        assert!((daily()..=daily() + daily() / 10).contains(&delay));
    }
}
