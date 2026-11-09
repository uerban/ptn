//! Read-only bridge from authenticated installer activation to serving generations.
//! The installer owns activation/rollback; the server never rewrites its state.
use super::{handle::build_generation_with_policy, BuildInputs, Generation};
use crate::ops::{Metrics, ServerConfig};
use pt_artifacts::transit_install::{self, InstalledSelection};
use pt_shared::validate::errors::{IoErr, ValidationError};
use pt_shared::{clock::Clock, manifest::GenerationManifest, osm_manifest::valid_digest};
use std::{io, sync::Arc};

fn invalid(message: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message.to_string())
}

pub fn trusted_keys(config: &ServerConfig) -> io::Result<Vec<[u8; 32]>> {
    config
        .transit_trusted_key
        .iter()
        .map(|value| {
            if !valid_digest(value) {
                return Err(invalid("expected a lowercase 32-byte transit public key"));
            }
            let mut key = [0; 32];
            for (i, byte) in key.iter_mut().enumerate() {
                *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).map_err(invalid)?;
            }
            Ok(key)
        })
        .collect()
}

pub fn validate_config(config: &ServerConfig) -> io::Result<()> {
    if let Some(root) = &config.transit_store_root {
        transit_install::activation_path(root, &config.city_slug)?;
        if trusted_keys(config)?.is_empty() {
            return Err(invalid("installed transit requires --transit-trusted-key"));
        }
        if config.force_current.is_some() {
            return Err(invalid(
                "installed transit cannot use --force-current; use pt-transit rollback",
            ));
        }
    } else if !config.transit_trusted_key.is_empty() {
        return Err(invalid(
            "--transit-trusted-key requires --transit-store-root",
        ));
    }
    Ok(())
}

pub fn resolve(
    config: &ServerConfig,
    clock: &dyn Clock,
) -> Result<InstalledSelection, ValidationError> {
    validate_config(config).map_err(|e| ValidationError::Io(IoErr::from(e)))?;
    let root = config
        .transit_store_root
        .as_deref()
        .ok_or_else(|| ValidationError::Io(IoErr::from(invalid("missing transit store root"))))?;
    transit_install::read_current(
        root,
        &config.city_slug,
        &trusted_keys(config).map_err(|e| ValidationError::Io(IoErr::from(e)))?,
        clock.now(),
    )
    .map_err(|e| ValidationError::Io(IoErr::from(e)))
}

pub fn build(
    config: &ServerConfig,
    selection: &InstalledSelection,
    clock: &dyn Clock,
    metrics: &Arc<Metrics>,
    startup: bool,
    epoch: u64,
) -> Result<Generation, ValidationError> {
    let bytes = std::fs::read(selection.files.join("generation.json"))
        .map_err(|e| ValidationError::Io(IoErr::from(e)))?;
    let manifest: GenerationManifest =
        serde_json::from_slice(&bytes).map_err(|e| ValidationError::Io(IoErr::from(invalid(e))))?;
    let bundle_path = selection.files.join("bundle.ptb");
    let transfers_path = selection.files.join("transfers.bin");
    let mut generation = build_generation_with_policy(
        BuildInputs {
            manifest: &manifest,
            bundle_path: &bundle_path,
            transfers_path: manifest.has_transfers.then_some(transfers_path.as_path()),
            expected_city: &config.city_slug,
            clock,
            is_startup: startup,
            epoch,
            metrics: Some(metrics.clone()),
            city_tz_iana_default: config.city_tz_iana_default.as_deref(),
            pattern_mode: config.pattern_mode.into(),
        },
        config.page_warm_mode.enabled(),
        Some(config.log_format),
        selection.activation.current.geometry_selected && !config.without_geometry,
        false,
    )?;
    generation.transit_selection = Some(selection.activation.current.selection.clone());
    Ok(generation)
}

pub fn load(
    config: &ServerConfig,
    clock: &dyn Clock,
    metrics: &Arc<Metrics>,
) -> Result<Generation, ValidationError> {
    let selection = resolve(config, clock)?;
    build(config, &selection, clock, metrics, true, 0)
}
