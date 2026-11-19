//! `0x23` decode cases shared with the TypeScript loader.

use pt_core::route_side::{encode_route_side_table, RouteSideRow, RouteSideTable};

const CASES: &str =
    include_str!("../../../packages/shared/src/ptb/__fixtures__/route-side-table.tsv");

fn hex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).unwrap())
        .collect()
}

fn render(table: &RouteSideTable<'_>) -> String {
    let networks: Vec<String> = (0..table.network_count())
        .map(|i| {
            let (id, name) = table.network(i);
            format!("{id}:{name}")
        })
        .collect();
    let optional = |value: Option<u32>| value.map_or("-".to_string(), |v| v.to_string());
    let routes: Vec<String> = (0..table.route_count())
        .map(|i| {
            let row = table.route(i);
            format!(
                "{},{},{},{}",
                row.desc_idx,
                row.url_idx,
                optional(row.sort_order),
                optional(row.network_ord)
            )
        })
        .collect();
    format!(
        "networks={} routes={}",
        networks.join(";"),
        routes.join(";")
    )
}

#[test]
fn shared_decode_cases() {
    let mut count = 0;
    for line in CASES.lines() {
        let cells: Vec<&str> = line.split('\t').collect();
        let [name, routes, strings, body, expected] = cells[..] else {
            panic!("bad fixture row: {line}");
        };
        let bytes = hex(body);
        let actual =
            match RouteSideTable::decode(&bytes, routes.parse().unwrap(), strings.parse().unwrap())
            {
                Ok(Some(table)) => render(&table),
                Ok(None) => "absent".to_string(),
                Err(_) => "malformed".to_string(),
            };
        assert_eq!(actual, expected, "case {name}");
        count += 1;
    }
    assert_eq!(count, 13);
}

#[test]
fn encode_round_trips() {
    let rows = [
        RouteSideRow {
            desc_idx: 4,
            url_idx: 5,
            sort_order: Some(7),
            network_ord: Some(1),
        },
        RouteSideRow {
            desc_idx: 0,
            url_idx: 0,
            sort_order: None,
            network_ord: None,
        },
    ];
    let body = encode_route_side_table(&[(1, 2), (3, 0)], &rows);
    let table = RouteSideTable::decode(&body, 2, 6).unwrap().unwrap();
    assert_eq!(table.network(1), (3, 0));
    assert_eq!(table.route(0), rows[0]);
    assert_eq!(table.route(1), rows[1]);
}
