use clap::Parser;
use ed25519_dalek::SigningKey;
use std::{fs, path::PathBuf};

#[derive(Parser)]
#[command(about = "Export and sign a transit selection into a new offline staging directory")]
struct Args {
    #[arg(long)]
    generation: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long)]
    without_geometry: bool,
    /// File containing an Ed25519 32-byte seed as lowercase hex. Keep on builder.
    #[arg(long)]
    signing_key: PathBuf,
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let text = fs::read_to_string(args.signing_key)?;
    let seed = text.trim();
    if !pt_shared::osm_manifest::valid_digest(seed) {
        return Err("expected an Ed25519 seed as 64 lowercase hex characters".into());
    }
    let mut bytes = [0; 32];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&seed[i * 2..i * 2 + 2], 16)?;
    }
    pt_artifacts::transit_native::validate(
        &args.generation,
        !args.without_geometry,
        std::time::SystemTime::now(),
    )?;
    let id = pt_artifacts::transit_export::export(
        &args.generation,
        &args.output,
        !args.without_geometry,
        &SigningKey::from_bytes(&bytes),
    )?;
    println!("{id}");
    Ok(())
}
