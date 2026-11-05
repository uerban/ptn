//! Skip a tick's bundle build when its inputs match the last build's.
//!
//! The bundle a tick builds, and so its generation id, is a pure function of
//! the feed zips' contents (in order), the window anchor, the city zone
//! (offset and IANA name), the in-seat derivation switch, and the producer's
//! own code and effective sidecar inputs/settings. The publish protocol already turns a rebuild of an existing
//! generation into a `Noop`, but only after building the whole bundle: about
//! a minute and a half of one core for Paris on every hourly tick, and the
//! whole wait after a restart. Recording each build's inputs next to the
//! generation they produced lets a tick answer "already current" without
//! building.
//!
//! The producer's code is identified by hashing its own executable, so any
//! rebuilt binary counts as new inputs. A false "changed" costs one ordinary
//! build; a false "unchanged" would keep a stale bundle up, so every input
//! that reaches the bundle bytes must be part of the key.

use std::path::Path;
use std::sync::OnceLock;

use crate::build::sha256_hex;
use crate::cli::DeriveInseat;
use crate::download::FeedRecord;

/// The record of the last build, kept in the data root. Not part of any
/// generation: pt-serve never reads it, and deleting it only costs the next
/// tick a full build.
pub(crate) const RECORD_FILENAME: &str = "producer-inputs.json";

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    inputs_key: String,
    generation_id: String,
}

/// Everything that determines the bundle and its independently changing sidecars.
pub(crate) struct BuildInputs<'a> {
    pub feeds: &'a [FeedRecord],
    pub anchor: u32,
    pub tz_offset_seconds: Option<i32>,
    pub tz_iana: &'a str,
    pub derive_inseat: DeriveInseat,
    pub publication_inputs_sha256: &'a str,
}

impl BuildInputs<'_> {
    /// The key for these inputs, or `None` when the producer cannot identify
    /// its own code, in which case every tick builds.
    pub(crate) fn key(&self) -> Option<String> {
        Some(self.key_for_code(producer_code_sha()?))
    }

    fn key_for_code(&self, code_sha: &str) -> String {
        let mut text = format!("pt-producer build inputs 1\ncode {code_sha}\n");
        for feed in self.feeds {
            text.push_str(&format!("feed {}\n", feed.sha_hex));
        }
        let derive = match self.derive_inseat {
            DeriveInseat::Auto => "auto",
            DeriveInseat::Off => "off",
        };
        text.push_str(&format!(
            "anchor {}\ntz-offset {:?}\ntz-iana {}\nderive-inseat {derive}\n",
            self.anchor, self.tz_offset_seconds, self.tz_iana
        ));
        text.push_str(&format!(
            "publication-inputs {}\n",
            self.publication_inputs_sha256
        ));
        sha256_hex(text.as_bytes())
    }
}

/// sha256 of the running executable, read once per process.
pub(crate) fn producer_code_sha() -> Option<&'static str> {
    static SHA: OnceLock<Option<String>> = OnceLock::new();
    SHA.get_or_init(|| {
        let read = std::env::current_exe().and_then(std::fs::read);
        match read {
            Ok(bytes) => Some(sha256_hex(&bytes)),
            Err(e) => {
                eprintln!(
                    "[producer] WARN cannot hash the producer executable ({e}); \
                     every tick will build the bundle"
                );
                None
            }
        }
    })
    .as_deref()
}

/// The generation `key`'s inputs produced last time, if it is still on disk.
pub(crate) fn unchanged_generation(data_root: &Path, key: &str) -> Option<String> {
    let bytes = std::fs::read(data_root.join(RECORD_FILENAME)).ok()?;
    let record: Record = serde_json::from_slice(&bytes).ok()?;
    if record.inputs_key != key || !is_sha256_hex(&record.generation_id) {
        return None;
    }
    let manifest = data_root
        .join("generations")
        .join(&record.generation_id)
        .join("generation.json");
    let pointer: pt_shared::manifest::PointerManifest =
        serde_json::from_slice(&std::fs::read(data_root.join("current.json")).ok()?).ok()?;
    (manifest.exists() && pointer.generation_id == record.generation_id)
        .then_some(record.generation_id)
}

/// Record that `key`'s inputs produce `generation_id`. Best effort: a failed
/// write only means the next tick builds again.
pub(crate) fn record(data_root: &Path, key: &str, generation_id: &str) {
    let write = || -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(&Record {
            inputs_key: key.to_string(),
            generation_id: generation_id.to_string(),
        })
        .map_err(std::io::Error::other)?;
        let tmp = data_root.join(format!("{RECORD_FILENAME}.tmp"));
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, data_root.join(RECORD_FILENAME))
    };
    if let Err(e) = write() {
        eprintln!("[producer] WARN could not record the build inputs (non-fatal): {e}");
    }
}

fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn feed(sha: &str) -> FeedRecord {
        FeedRecord {
            url: "file:///feed.zip".into(),
            zip_path: PathBuf::from("/feed.zip"),
            sha_hex: sha.into(),
            etag: None,
        }
    }

    #[test]
    fn every_bundle_input_changes_the_key() {
        let feeds = [feed("aa"), feed("bb")];
        let base = BuildInputs {
            feeds: &feeds,
            anchor: 20261011,
            tz_offset_seconds: None,
            tz_iana: "Europe/Paris",
            derive_inseat: DeriveInseat::Auto,
            publication_inputs_sha256: "fixture",
        };
        let k = base.key_for_code("c1");
        assert_eq!(k, base.key_for_code("c1"), "the key is deterministic");
        assert_ne!(k, base.key_for_code("c2"), "producer code");

        let swapped = [feed("bb"), feed("aa")];
        let one = [feed("aa")];
        let changed = [feed("aa"), feed("cc")];
        for (what, other) in [
            (
                "feed order",
                BuildInputs {
                    feeds: &swapped,
                    ..base
                },
            ),
            (
                "feed count",
                BuildInputs {
                    feeds: &one,
                    ..base
                },
            ),
            (
                "feed content",
                BuildInputs {
                    feeds: &changed,
                    ..base
                },
            ),
            (
                "anchor",
                BuildInputs {
                    anchor: 20261012,
                    ..base
                },
            ),
            (
                "tz offset",
                BuildInputs {
                    tz_offset_seconds: Some(3600),
                    ..base
                },
            ),
            (
                "tz iana",
                BuildInputs {
                    tz_iana: "Europe/Vilnius",
                    ..base
                },
            ),
            (
                "in-seat",
                BuildInputs {
                    derive_inseat: DeriveInseat::Off,
                    ..base
                },
            ),
        ] {
            assert_ne!(other.key_for_code("c1"), k, "{what} must change the key");
        }
    }

    #[test]
    fn a_recorded_generation_answers_only_its_own_key() {
        let dir = tempfile::tempdir().unwrap();
        let gen = "ab".repeat(32);
        std::fs::create_dir_all(dir.path().join("generations").join(&gen)).unwrap();
        std::fs::write(
            dir.path()
                .join("generations")
                .join(&gen)
                .join("generation.json"),
            b"{}",
        )
        .unwrap();
        assert_eq!(
            unchanged_generation(dir.path(), "k1"),
            None,
            "no record yet"
        );

        std::fs::write(
            dir.path().join("current.json"),
            serde_json::to_vec(&pt_shared::manifest::PointerManifest {
                manifest_schema_version: 1,
                generation_id: gen.clone(),
                city_slug: "test".into(),
                created_at: "2026-10-30T00:00:00Z".into(),
            })
            .unwrap(),
        )
        .unwrap();
        record(dir.path(), "k1", &gen);
        assert_eq!(unchanged_generation(dir.path(), "k1"), Some(gen.clone()));
        assert_eq!(unchanged_generation(dir.path(), "k2"), None);
        assert!(!dir.path().join(format!("{RECORD_FILENAME}.tmp")).exists());

        // The janitor (or an operator) removed the generation: build again.
        std::fs::remove_dir_all(dir.path().join("generations").join(&gen)).unwrap();
        assert_eq!(unchanged_generation(dir.path(), "k1"), None);
    }

    #[test]
    fn a_damaged_record_means_build() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(RECORD_FILENAME), b"not json").unwrap();
        assert_eq!(unchanged_generation(dir.path(), "k1"), None);
        // A generation id that is not a sha must never become a path.
        std::fs::write(
            dir.path().join(RECORD_FILENAME),
            br#"{"inputsKey":"k1","generationId":"../../etc"}"#,
        )
        .unwrap();
        assert_eq!(unchanged_generation(dir.path(), "k1"), None);
    }

    #[test]
    fn the_running_binary_has_a_code_sha() {
        let sha = producer_code_sha().expect("the test binary is readable");
        assert!(is_sha256_hex(sha));
    }
}
