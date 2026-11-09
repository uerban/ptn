use clap::{Parser, Subcommand};
use pt_artifacts::{
    install::{LocalRepository, Repository},
    transit_install::{Policy, TransitStore},
    transport::HttpsRepository,
};
use std::{
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Parser)]
#[command(about = "Install signed transit packs without feeds or builders")]
struct Args {
    /// Transit state is isolated below ROOT/transit.
    #[arg(long)]
    root: PathBuf,
    #[arg(long)]
    city: Option<String>,
    /// Configured public keys as 64 lowercase hex characters.
    #[arg(long)]
    trusted_key: Vec<String>,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Verify served cities and selected download sizes.
    Cities {
        #[arg(long, conflicts_with = "source_directory")]
        source_url: Option<String>,
        #[arg(long, conflicts_with = "source_url")]
        source_directory: Option<PathBuf>,
    },
    Sync {
        #[arg(long, conflicts_with = "source_directory")]
        source_url: Option<String>,
        #[arg(long, conflicts_with = "source_url")]
        source_directory: Option<PathBuf>,
        #[arg(long)]
        without_geometry: bool,
        /// Install the exact immutable head advertised by signed discovery.
        #[arg(long)]
        from_discovery: bool,
        #[arg(long, default_value_t=4*1024*1024*1024u64)]
        max_file_bytes: u64,
        #[arg(long, default_value_t=8*1024*1024*1024u64)]
        max_selected_bytes: u64,
    },
    Status,
    /// Revalidate the current installed selection offline and print its path.
    Verify,
    Pin,
    Unpin,
    /// Revalidate, switch to previous selection and pin it. Preserve checkpoint.
    Rollback,
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    let keys = args
        .trusted_key
        .iter()
        .map(|value| {
            if !pt_shared::osm_manifest::valid_digest(value) {
                return Err("expected a 32-byte lowercase hex public key");
            }
            let mut key = [0; 32];
            for (i, byte) in key.iter_mut().enumerate() {
                *byte = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16)
                    .map_err(|_| "invalid public key")?;
            }
            Ok(key)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if matches!(
        args.command,
        Command::Sync { .. } | Command::Cities { .. } | Command::Verify | Command::Rollback
    ) && keys.is_empty()
    {
        return Err("at least one configured --trusted-key is required".into());
    }
    if !matches!(args.command, Command::Cities { .. }) && args.city.is_none() {
        return Err("--city is required for this command".into());
    }
    let city = args.city.as_deref().unwrap_or("");
    let store = TransitStore::open(&args.root)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_secs()
        .try_into()?;
    match args.command {
        Command::Cities {
            source_url,
            source_directory,
        } => {
            let repository = source(source_url, source_directory)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&store.discover(repository.as_ref(), &keys, now)?)?
            );
        }
        Command::Status => println!("{}", serde_json::to_string_pretty(&store.status(city)?)?),
        Command::Pin => store.set_pinned(city, true)?,
        Command::Unpin => store.set_pinned(city, false)?,
        Command::Rollback => store.rollback(city, &keys, now)?,
        Command::Verify => println!("{}", store.validate_current(city, &keys, now)?.display()),
        Command::Sync {
            source_url,
            source_directory,
            without_geometry,
            from_discovery,
            max_file_bytes,
            max_selected_bytes,
        } => {
            let repository = source(source_url, source_directory)?;
            let policy = Policy {
                geometry: !without_geometry,
                max_file_bytes,
                max_selected_bytes,
                ..Policy::default()
            };
            let changed = if from_discovery {
                store.sync_discovered(repository.as_ref(), city, &keys, now, &policy)?
            } else {
                store.sync(repository.as_ref(), city, &keys, now, &policy)?
            };
            println!("{}", if changed { "activated" } else { "unchanged" });
        }
    }
    Ok(())
}

fn source(
    url: Option<String>,
    directory: Option<PathBuf>,
) -> Result<Box<dyn Repository>, Box<dyn std::error::Error>> {
    match (url, directory) {
        (Some(url), None) => Ok(Box::new(HttpsRepository::new(&url)?)),
        (None, Some(path)) => Ok(Box::new(LocalRepository(path))),
        _ => Err("requires --source-url or --source-directory".into()),
    }
}
