use pt_core::coord_quant::{decode_e7, encode_lat_e7, encode_lon_e7};
#[derive(serde::Deserialize)]
struct Row {
    r#in: String,
    axis: String,
    i32: Option<i32>,
    prod_hex: Option<String>,
    reject: Option<bool>,
}
fn parse(s: &str) -> f64 {
    match s {
        "nan" => f64::NAN,
        "inf" => f64::INFINITY,
        _ => s.parse().unwrap(),
    }
}
#[test]
fn coord_oracle_table() {
    let rows: Vec<Row> = serde_json::from_str(include_str!(
        "../../pt-core/tests/fixtures/coord-oracle.json"
    ))
    .unwrap();
    assert!(rows.len() >= 20);
    for r in &rows {
        let x = parse(&r.r#in);
        let enc = if r.axis == "lat" {
            encode_lat_e7(x)
        } else {
            encode_lon_e7(x)
        };
        if r.reject == Some(true) {
            assert_eq!(enc, None, "{} must reject", r.r#in);
            continue;
        }
        if let Some(h) = &r.prod_hex {
            assert_eq!(
                format!("{:016x}", (x * 1e7).to_bits()),
                *h,
                "prod {}",
                r.r#in
            );
        }
        assert_eq!(enc, Some(r.i32.unwrap()), "encode {}", r.r#in);
        assert!(
            (decode_e7(r.i32.unwrap()) - x).abs() <= 0.5e-7,
            "decode tol {}",
            r.r#in
        );
    }
}
