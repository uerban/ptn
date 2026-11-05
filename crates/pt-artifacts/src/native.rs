//! Native structural checks before a release becomes visible. Walking input is
//! streamed; PTAS/PTWG use the same decoders as serving clients. POI is a flat
//! tar.gz corpus (manifest.json and Brotli bundles), never arbitrary tar paths.
use pt_shared::{
    osm_manifest::digest,
    poi_bundle_wire::{PoiBundle, Tier},
    poi_manifest_wire::PoiManifest,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{self, BufRead, BufReader, Read, Write},
    path::Path,
};

pub const MAX_NATIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_LINE_BYTES: u64 = 16 * 1024 * 1024;
fn invalid(message: impl ToString) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

pub fn corpus_ids(city: &str) -> &[&str] {
    match city {
        "tricity" => &["gdansk", "gdynia", "sopot"],
        "vilnius" => &["vilnius"],
        "tbilisi" => &["tbilisi"],
        _ => &[],
    }
}

/// Decode to a private staging file with an exact decoded-size ceiling. Native
/// loaders never receive a decompression bomb, even from a correctly signed file.
pub fn decode_to(
    source: &Path,
    destination: &Path,
    compression: pt_shared::osm_manifest::Compression,
    expected: u64,
) -> io::Result<()> {
    use pt_shared::osm_manifest::Compression;
    if expected == 0 || expected > pt_shared::osm_manifest::MAX_OBJECT_BYTES {
        return Err(invalid("decoded object size limit"));
    }
    let file = File::open(source)?;
    let mut reader: Box<dyn Read> = match compression {
        Compression::None => Box::new(file),
        Compression::Gzip => Box::new(flate2::read::MultiGzDecoder::new(file)),
        Compression::Brotli => Box::new(brotli::Decompressor::new(file, 64 * 1024)),
    };
    let result = (|| {
        let mut out = File::create(destination)?;
        let count = io::copy(&mut reader.by_ref().take(expected + 1), &mut out)?;
        if count != expected {
            return Err(invalid("decoded size mismatch"));
        }
        out.flush()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

pub fn validate(name: &str, city: &str, decoded: &Path, poi_directory: &Path) -> io::Result<()> {
    match name {
        "walking" => walking(decoded),
        "addresses" => {
            let bytes = read_bounded(File::open(decoded)?, MAX_NATIVE_BYTES)?;
            let index = pt_geocode::AddrIndex::from_bytes(bytes.into()).map_err(invalid)?;
            if index.meta().city_id.as_deref() != Some(city) {
                return Err(invalid("address city mismatch"));
            }
            Ok(())
        }
        "walkGraph" => {
            let bytes = read_bounded(File::open(decoded)?, MAX_NATIVE_BYTES)?;
            let graph = pt_walk::format::decode(&bytes).map_err(invalid)?;
            if graph.meta().city_id != city || graph.point_count() > pt_walk::MAX_ARTIFACT_POINTS {
                return Err(invalid("walk graph city or point limit mismatch"));
            }
            Ok(())
        }
        "poi" => poi(city, decoded, poi_directory),
        _ => Err(invalid("unknown component")),
    }
}

fn read_bounded(reader: impl Read, limit: u64) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(invalid("native allocation limit exceeded"));
    }
    Ok(bytes)
}

fn walking(path: &Path) -> io::Result<()> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut line = Vec::new();
    let mut features = 0u64;
    loop {
        line.clear();
        let count = reader
            .by_ref()
            .take(MAX_LINE_BYTES + 1)
            .read_until(b'\n', &mut line)?;
        if count == 0 {
            break;
        }
        if count as u64 > MAX_LINE_BYTES {
            return Err(invalid("walking feature exceeds line limit"));
        }
        let text = std::str::from_utf8(&line)
            .map_err(invalid)?
            .trim_start_matches('\u{1e}')
            .trim();
        if text.is_empty() {
            continue;
        }
        let feature: serde_json::Value = serde_json::from_str(text).map_err(invalid)?;
        if feature["type"] != "Feature" {
            return Err(invalid("walking input is not a feature"));
        }
        let geometry = &feature["geometry"];
        match geometry["type"].as_str() {
            Some("LineString") => coordinates(&geometry["coordinates"])?,
            Some("MultiLineString") => {
                for line in geometry["coordinates"]
                    .as_array()
                    .ok_or_else(|| invalid("invalid polylines"))?
                {
                    coordinates(line)?;
                }
            }
            _ => return Err(invalid("unsupported walking geometry")),
        }
        features += 1;
    }
    if features == 0 {
        return Err(invalid("empty walking input"));
    }
    Ok(())
}

fn coordinates(value: &serde_json::Value) -> io::Result<()> {
    let points = value
        .as_array()
        .ok_or_else(|| invalid("invalid coordinates"))?;
    if points.len() < 2 {
        return Err(invalid("short walking line"));
    }
    for point in points {
        let lon = point
            .get(0)
            .and_then(|v| v.as_f64())
            .ok_or_else(|| invalid("invalid longitude"))?;
        let lat = point
            .get(1)
            .and_then(|v| v.as_f64())
            .ok_or_else(|| invalid("invalid latitude"))?;
        if !(-180.0..=180.0).contains(&lon) || !(-90.0..=90.0).contains(&lat) {
            return Err(invalid("coordinate outside earth"));
        }
    }
    Ok(())
}

fn poi(city: &str, path: &Path, destination: &Path) -> io::Result<()> {
    let mut archive = tar::Archive::new(File::open(path)?);
    fs::create_dir_all(destination)?;
    let mut inventory = BTreeMap::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let name = entry
            .path()?
            .to_str()
            .ok_or_else(|| invalid("non-UTF8 corpus path"))?
            .to_owned();
        if !entry.header().entry_type().is_file()
            || name.starts_with('.')
            || name.contains("..")
            || !name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"_.-".contains(&b))
            || (name != "manifest.json" && !name.ends_with(".br"))
            || inventory.len() >= 7
        {
            return Err(invalid("unsafe corpus member"));
        }
        if inventory.contains_key(&name) {
            return Err(invalid("duplicate corpus member"));
        }
        let bytes = read_bounded(&mut entry, MAX_NATIVE_BYTES)?;
        inventory.insert(name.clone(), (bytes.len() as u64, digest(&bytes)));
        fs::write(destination.join(name), bytes)?;
    }
    let manifest: PoiManifest =
        serde_json::from_slice(&fs::read(destination.join("manifest.json"))?).map_err(invalid)?;
    if manifest.schema_version != 1 || manifest.bundles.is_empty() {
        return Err(invalid("invalid POI manifest"));
    }
    let mut named = BTreeSet::new();
    for item in manifest.bundles {
        if !corpus_ids(city).contains(&item.city_id.as_str())
            || !named.insert(item.filename.clone())
            || inventory.get(&item.filename) != Some(&(item.size_bytes, item.sha256))
        {
            return Err(invalid("POI inventory or city mismatch"));
        }
        let decoded = read_bounded(
            brotli::Decompressor::new(File::open(destination.join(&item.filename))?, 65536),
            MAX_NATIVE_BYTES,
        )?;
        let bundle: PoiBundle = serde_json::from_slice(&decoded).map_err(invalid)?;
        let filename = match bundle.meta.tier {
            Tier::Strict => format!("{}.br", item.city_id),
            Tier::Loose => format!("{}.loose.br", item.city_id),
        };
        if filename != item.filename
            || bundle.meta.city_id != item.city_id
            || bundle.meta.entry_count != bundle.entries.len() as u64
            || bundle.entries.iter().any(|p| {
                p.tier != bundle.meta.tier
                    || !(-90.0..=90.0).contains(&p.lat)
                    || !(-180.0..=180.0).contains(&p.lon)
            })
        {
            return Err(invalid("invalid native POI bundle"));
        }
    }
    if named.len() + 1 != inventory.len() {
        return Err(invalid("unadvertised corpus member"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_address_reader_enforces_city() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("address");
        let rows = [pt_geocode::AddrRow {
            label: "Street 1".into(),
            lat: 54.0,
            lon: 25.0,
        }];
        let keys = [pt_geocode::AddrKey {
            key: "street 1".into(),
            row_id: 0,
        }];
        let meta = pt_geocode::ArtifactMeta {
            city_id: Some("vilnius".into()),
            source: Some("fixture".into()),
            generated_at: "2026-10-29T00:00:00Z".into(),
        };
        fs::write(
            &path,
            pt_geocode::AddrIndex::pack(&rows, &keys, &meta).unwrap(),
        )
        .unwrap();
        validate("addresses", "vilnius", &path, dir.path()).unwrap();
        assert!(validate("addresses", "oslo", &path, dir.path()).is_err());
    }

    #[test]
    fn poi_archive_checks_inventory_city_and_rejects_links() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("corpus.tar");
        let bundle = br#"{"meta":{"cityId":"vilnius","tier":"loose","entryCount":0},"entries":[]}"#;
        let mut compressed = Vec::new();
        {
            let mut writer = brotli::CompressorWriter::new(&mut compressed, 4096, 4, 22);
            writer.write_all(bundle).unwrap();
        }
        let manifest = serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"bundles":[{"cityId":"vilnius","filename":"vilnius.loose.br","sizeBytes":compressed.len(),"sha256":digest(&compressed)}]})).unwrap();
        let mut archive = tar::Builder::new(File::create(&path).unwrap());
        for (name, bytes) in [
            ("manifest.json", &manifest),
            ("vilnius.loose.br", &compressed),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            archive.append_data(&mut header, name, &bytes[..]).unwrap();
        }
        archive.finish().unwrap();
        drop(archive);
        poi("vilnius", &path, &dir.path().join("valid")).unwrap();
        assert!(poi("tbilisi", &path, &dir.path().join("wrong-city")).is_err());
        let mut archive = tar::Builder::new(File::create(&path).unwrap());
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_mode(0o644);
        header.set_link_name("outside").unwrap();
        header.set_cksum();
        archive
            .append_data(&mut header, "evil.br", &b""[..])
            .unwrap();
        archive.finish().unwrap();
        drop(archive);
        assert!(poi("vilnius", &path, &dir.path().join("links")).is_err());
    }

    #[test]
    fn rejects_walking_corruption_and_bad_coordinates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("walking");
        for data in [
            "",
            "not json",
            r#"{"type":"Feature","geometry":{"type":"LineString","coordinates":[[181,0],[0,0]]}}"#,
        ] {
            fs::write(&path, data).unwrap();
            assert!(walking(&path).is_err());
        }
        fs::write(&path, "\u{1e}{\"type\":\"Feature\",\"geometry\":{\"type\":\"LineString\",\"coordinates\":[[1,2],[3,4]]}}\n").unwrap();
        walking(&path).unwrap();
    }
    #[test]
    fn bounds_decoding_and_removes_failed_output() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in");
        let output = dir.path().join("out");
        fs::write(&input, b"oversized").unwrap();
        assert!(decode_to(
            &input,
            &output,
            pt_shared::osm_manifest::Compression::None,
            1
        )
        .is_err());
        assert!(!output.exists());
    }
}
