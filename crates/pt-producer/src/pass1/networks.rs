//! GTFS route networks: `routes.network_id`, or `networks.txt` with
//! `route_networks.txt`. The two forms are mutually exclusive within a feed.
//! <https://gtfs.org/documentation/schedule/reference/#networkstxt>

use crate::error::{Error, Result};
use crate::pass1::attrs::RouteAttrs;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

/// One network used by at least one published route.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NetworkAttrs {
    pub id: String,
    /// GTFS `network_name`; empty when the feed has none.
    pub name: String,
}

/// What one feed's `routes.txt` contributed to the route union.
#[derive(Debug, Default)]
pub struct RouteScan {
    /// Every `route_id` in this feed. `Some(pre_id)` when this feed owns the
    /// route; `None` when an earlier feed already defined it.
    pub routes: HashMap<String, Option<u32>>,
    pub has_network_column: bool,
}

fn malformed(path: &Path, detail: impl std::fmt::Display) -> Error {
    Error::MalformedGtfs(format!("{}: {detail}", path.display()))
}

fn rows(path: &Path, required: &[&str]) -> Result<Vec<Vec<String>>> {
    let file = crate::csv_open::open_csv_skip_bom(path)?;
    let mut reader = csv::Reader::from_reader(file);
    let headers = reader.headers()?.clone();
    let columns = required
        .iter()
        .map(|column| {
            headers
                .iter()
                .position(|h| h == *column)
                .ok_or_else(|| malformed(path, format!("missing {column}")))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut out = Vec::new();
    for record in reader.records() {
        let record = record?;
        out.push(
            columns
                .iter()
                .map(|&i| record.get(i).unwrap_or("").to_string())
                .collect(),
        );
    }
    Ok(out)
}

fn network_names(path: &Path) -> Result<BTreeMap<String, String>> {
    let file = crate::csv_open::open_csv_skip_bom(path)?;
    let mut reader = csv::Reader::from_reader(file);
    let headers = reader.headers()?.clone();
    let id_at = headers
        .iter()
        .position(|h| h == "network_id")
        .ok_or_else(|| malformed(path, "missing network_id"))?;
    let name_at = headers.iter().position(|h| h == "network_name");
    let mut names = BTreeMap::new();
    for record in reader.records() {
        let record = record?;
        let id = record.get(id_at).unwrap_or("");
        if id.is_empty() {
            return Err(malformed(path, "empty network_id"));
        }
        let name = name_at.and_then(|i| record.get(i)).unwrap_or("");
        if names.insert(id.to_string(), name.to_string()).is_some() {
            return Err(malformed(path, format!("duplicate network_id {id}")));
        }
    }
    Ok(names)
}

/// Validate one feed's network declarations and apply them to the routes that
/// feed owns. `union` keeps the first definition of each network ID.
pub fn apply_feed_networks(
    dir: &Path,
    scan: &RouteScan,
    attrs: &mut [RouteAttrs],
    union: &mut BTreeMap<String, String>,
) -> Result<()> {
    let networks_path = dir.join("networks.txt");
    let assignments_path = dir.join("route_networks.txt");
    if scan.has_network_column {
        for forbidden in [&networks_path, &assignments_path] {
            if forbidden.exists() {
                return Err(malformed(
                    forbidden,
                    "forbidden when routes.txt has network_id",
                ));
            }
        }
        for pre_id in scan.routes.values().flatten() {
            let network_id = &attrs[*pre_id as usize].network_id;
            if !network_id.is_empty() {
                union.entry(network_id.clone()).or_default();
            }
        }
        return Ok(());
    }

    let names = if networks_path.exists() {
        network_names(&networks_path)?
    } else {
        BTreeMap::new()
    };
    if assignments_path.exists() {
        let mut assigned = HashSet::new();
        for row in rows(&assignments_path, &["network_id", "route_id"])? {
            let (network_id, route_id) = (&row[0], &row[1]);
            if !names.contains_key(network_id) {
                return Err(malformed(
                    &assignments_path,
                    format!("unknown network_id {network_id}"),
                ));
            }
            let Some(owner) = scan.routes.get(route_id) else {
                return Err(malformed(
                    &assignments_path,
                    format!("unknown route_id {route_id}"),
                ));
            };
            if !assigned.insert(route_id.clone()) {
                return Err(malformed(
                    &assignments_path,
                    format!("duplicate route_id {route_id}"),
                ));
            }
            if let Some(pre_id) = owner {
                attrs[*pre_id as usize].network_id = network_id.clone();
            }
        }
    }
    for (id, name) in names {
        union.entry(id).or_insert(name);
    }
    Ok(())
}

/// Networks referenced by a published route, sorted by ID.
pub fn used_networks(union: BTreeMap<String, String>, attrs: &[RouteAttrs]) -> Vec<NetworkAttrs> {
    let used: HashSet<&str> = attrs.iter().map(|a| a.network_id.as_str()).collect();
    union
        .into_iter()
        .filter(|(id, _)| used.contains(id.as_str()))
        .map(|(id, name)| NetworkAttrs { id, name })
        .collect()
}

#[cfg(test)]
mod tests {
    use crate::error::Error;
    use crate::pass1::counts::{run_pass1_union, Pass1Result};
    use crate::pass1::networks::NetworkAttrs;
    use std::path::{Path, PathBuf};

    const ROUTES: &str = "route_id,route_type\nR1,3\nR2,3\n";

    fn feed(root: &Path, name: &str, routes: &str, extra: &[(&str, &str)]) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir(&dir).unwrap();
        let route = routes.lines().nth(1).unwrap().split(',').next().unwrap();
        let trip = format!("{name}T");
        for (file, body) in [
            ("stops.txt", "stop_id,stop_name,stop_lat,stop_lon\nS1,A,0,0\nS2,B,0,0\n".to_string()),
            ("routes.txt", routes.to_string()),
            ("trips.txt", format!("route_id,service_id,trip_id\n{route},Sv,{trip}\n")),
            ("calendar.txt", "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nSv,1,1,1,1,1,1,1,20260101,20271231\n".to_string()),
            ("stop_times.txt", format!("trip_id,stop_id,arrival_time,departure_time,stop_sequence\n{trip},S1,08:00:00,08:00:00,1\n{trip},S2,08:05:00,08:05:00,2\n")),
        ] {
            std::fs::write(dir.join(file), body).unwrap();
        }
        for (file, body) in extra {
            std::fs::write(dir.join(file), body).unwrap();
        }
        dir
    }

    fn network_of<'a>(p1: &'a Pass1Result, route: &str) -> &'a str {
        let at = p1.routes.keys().iter().position(|k| k == route).unwrap();
        &p1.routes_attrs[at].network_id
    }

    fn network(id: &str, name: &str) -> NetworkAttrs {
        NetworkAttrs {
            id: id.into(),
            name: name.into(),
        }
    }

    fn rejected(routes: &str, extra: &[(&str, &str)], expected: &str) {
        let tmp = tempfile::tempdir().unwrap();
        let dir = feed(tmp.path(), "a", routes, extra);
        match run_pass1_union(&[dir]) {
            Err(Error::MalformedGtfs(message)) => {
                assert!(message.contains(expected), "{message}")
            }
            Err(other) => panic!("unexpected error: {other}"),
            Ok(_) => panic!("feed should be rejected"),
        }
    }

    #[test]
    fn reads_optional_route_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let routes = "route_id,route_type,route_desc,route_url,route_sort_order\nR1,3,Desc,https://r.example,7\nR2,3,,,bad\nR3,3,,,4294967295\n";
        let p1 = run_pass1_union(&[feed(tmp.path(), "a", routes, &[])]).unwrap();
        assert_eq!(p1.routes_attrs[0].desc, "Desc");
        assert_eq!(p1.routes_attrs[0].url, "https://r.example");
        assert_eq!(p1.routes_attrs[0].sort_order, Some(7));
        assert_eq!(p1.routes_attrs[1].sort_order, None);
        assert_eq!(p1.routes_attrs[2].sort_order, None);
    }

    #[test]
    fn reads_network_column() {
        let tmp = tempfile::tempdir().unwrap();
        let routes = "route_id,route_type,network_id\nR1,3,n\nR2,3,\n";
        let p1 = run_pass1_union(&[feed(tmp.path(), "a", routes, &[])]).unwrap();
        assert_eq!(network_of(&p1, "R1"), "n");
        assert_eq!(network_of(&p1, "R2"), "");
        assert_eq!(p1.networks, vec![network("n", "")]);
    }

    #[test]
    fn reads_network_tables_and_drops_unused() {
        let tmp = tempfile::tempdir().unwrap();
        let extra = [
            (
                "networks.txt",
                "network_id,network_name\nb,Unused\na,City\n",
            ),
            ("route_networks.txt", "network_id,route_id\na,R2\n"),
        ];
        let p1 = run_pass1_union(&[feed(tmp.path(), "a", ROUTES, &extra)]).unwrap();
        assert_eq!(network_of(&p1, "R1"), "");
        assert_eq!(network_of(&p1, "R2"), "a");
        assert_eq!(p1.networks, vec![network("a", "City")]);
    }

    #[test]
    fn networks_file_alone_is_valid() {
        let tmp = tempfile::tempdir().unwrap();
        let extra = [("networks.txt", "network_id\na\n")];
        let p1 = run_pass1_union(&[feed(tmp.path(), "a", ROUTES, &extra)]).unwrap();
        assert!(p1.networks.is_empty());
    }

    #[test]
    fn rejects_network_column_with_either_table() {
        let routes = "route_id,route_type,network_id\nR1,3,\n";
        rejected(routes, &[("networks.txt", "network_id\na\n")], "forbidden");
        rejected(
            routes,
            &[("route_networks.txt", "network_id,route_id\n")],
            "forbidden",
        );
    }

    #[test]
    fn rejects_invalid_network_tables() {
        let names = ("networks.txt", "network_id\na\n");
        rejected(
            ROUTES,
            &[("networks.txt", "network_id\na\na\n")],
            "duplicate network_id",
        );
        rejected(
            ROUTES,
            &[names, ("route_networks.txt", "network_id,route_id\nz,R1\n")],
            "unknown network_id",
        );
        rejected(
            ROUTES,
            &[names, ("route_networks.txt", "network_id,route_id\na,Z\n")],
            "unknown route_id",
        );
        rejected(
            ROUTES,
            &[
                names,
                ("route_networks.txt", "network_id,route_id\na,R1\na,R1\n"),
            ],
            "duplicate route_id",
        );
    }

    #[test]
    fn first_feed_owns_shared_routes_and_network_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let first = feed(
            tmp.path(),
            "a",
            ROUTES,
            &[
                (
                    "networks.txt",
                    "network_id,network_name\nn,First\nm,Other\n",
                ),
                ("route_networks.txt", "network_id,route_id\nn,R1\n"),
            ],
        );
        let second = feed(
            tmp.path(),
            "b",
            "route_id,route_type\nR1,3\nR3,3\n",
            &[
                (
                    "networks.txt",
                    "network_id,network_name\nn,Second\nm,Other\n",
                ),
                ("route_networks.txt", "network_id,route_id\nm,R1\nn,R3\n"),
            ],
        );
        let p1 = run_pass1_union(&[first, second]).unwrap();
        assert_eq!(network_of(&p1, "R1"), "n");
        assert_eq!(network_of(&p1, "R3"), "n");
        assert_eq!(p1.networks, vec![network("n", "First")]);
    }

    #[test]
    fn feeds_may_use_different_input_forms() {
        let tmp = tempfile::tempdir().unwrap();
        let first = feed(
            tmp.path(),
            "a",
            "route_id,route_type,network_id\nR1,3,col\n",
            &[],
        );
        let second = feed(
            tmp.path(),
            "b",
            "route_id,route_type\nR2,3\n",
            &[
                ("networks.txt", "network_id,network_name\ntab,Table\n"),
                ("route_networks.txt", "network_id,route_id\ntab,R2\n"),
            ],
        );
        let p1 = run_pass1_union(&[first, second]).unwrap();
        assert_eq!(
            p1.networks,
            vec![network("col", ""), network("tab", "Table")]
        );
    }
}
