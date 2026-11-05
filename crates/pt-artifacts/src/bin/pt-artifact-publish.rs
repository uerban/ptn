use clap::Parser;
use ed25519_dalek::SigningKey;
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Parser)]
#[command(about = "Validate and publish a signed immutable city OSM release")]
struct Args {
    #[arg(long)]
    repository: PathBuf,
    #[arg(long)]
    manifest: PathBuf,
    #[arg(long)]
    objects: PathBuf,
    /// Ed25519 private key: an unencrypted PKCS#8 PEM file
    /// (`openssl genpkey -algorithm ed25519`), or the 32-byte seed as lowercase hex.
    #[arg(long)]
    signing_key: PathBuf,
    /// Trusted public keys, including the current key and old keys during rotation.
    #[arg(long, required = true)]
    trusted_key: Vec<String>,
}
fn decode(value: &str) -> Result<[u8; 32], &'static str> {
    if !pt_shared::osm_manifest::valid_digest(value) {
        return Err("expected 32-byte lowercase hex key");
    }
    let mut key = [0; 32];
    for (i, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).map_err(|_| "invalid key")?;
    }
    Ok(key)
}
/// DER prefix of an unencrypted PKCS#8 v1 Ed25519 key; the seed follows it.
const PKCS8_ED25519: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];
fn signing_seed(text: &str) -> Result<[u8; 32], &'static str> {
    let text = text.trim();
    let Some(body) = text
        .strip_prefix("-----BEGIN PRIVATE KEY-----")
        .and_then(|rest| rest.strip_suffix("-----END PRIVATE KEY-----"))
    else {
        return decode(text);
    };
    use base64::Engine;
    let compact: String = body.split_whitespace().collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(compact)
        .map_err(|_| "invalid PEM base64")?;
    match der.strip_prefix(&PKCS8_ED25519[..]) {
        Some(seed) if seed.len() == 32 => Ok(seed.try_into().expect("checked length")),
        _ => Err("PEM key is not an unencrypted PKCS#8 Ed25519 private key"),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let key = SigningKey::from_bytes(&signing_seed(&fs::read_to_string(&args.signing_key)?)?);
    let trust = args
        .trusted_key
        .iter()
        .map(|v| decode(v))
        .collect::<Result<Vec<_>, _>>()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
    let release = pt_artifacts::publish::publish(
        &args.repository,
        &args.manifest,
        &args.objects,
        &key,
        &trust,
        now,
    )?;
    println!("{release}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 8410 section 10.3 example key.
    const PEM: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEINTuctv5E1hK1bbY8fdp+K06/nwoy/HU++CXqI9EdVhC\n-----END PRIVATE KEY-----\n";
    const SEED: &str = "d4ee72dbf913584ad5b6d8f1f769f8ad3afe7c28cbf1d4fbe097a88f44755842";

    #[test]
    fn pem_and_hex_give_the_same_seed() {
        assert_eq!(signing_seed(PEM).unwrap(), decode(SEED).unwrap());
        assert_eq!(
            signing_seed(&format!("{SEED}\n")).unwrap(),
            decode(SEED).unwrap()
        );
    }

    #[test]
    fn rejects_other_pem_keys() {
        // A PKCS#8 header around non-Ed25519 bytes.
        let other = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VuBCIEINTuctv5E1hK1bbY8fdp+K06/nwoy/HU++CXqI9EdVhC\n-----END PRIVATE KEY-----";
        assert!(signing_seed(other).is_err());
        assert!(
            signing_seed("-----BEGIN PRIVATE KEY-----\n!!\n-----END PRIVATE KEY-----").is_err()
        );
    }
}
