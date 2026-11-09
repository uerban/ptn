use ed25519_dalek::{Signer, SigningKey};
use pt_artifacts::transit_catalog::{self, Catalog, Checkpoint, Selection};
use pt_shared::osm_manifest::{digest, timestamp_seconds};

fn now() -> i64 {
    timestamp_seconds("2026-11-06T00:00:00Z").unwrap()
}
fn catalog() -> Catalog {
    Catalog {
        schema_version: 1,
        city: "vilnius".into(),
        sequence: 2,
        pack_id: digest(b"pack"),
        generation_id: digest(b"generation"),
        published_at: "2026-11-06T00:00:00Z".into(),
        expires_at: "2026-12-06T00:00:00Z".into(),
        selections: vec![Selection {
            sha256: digest(b"descriptor"),
            bytes: 100,
            geometry_selected: false,
        }],
    }
}

#[test]
fn authenticates_exact_bytes_city_keys_and_distinct_domain() {
    let key = SigningKey::from_bytes(&[3; 32]);
    let rotated = SigningKey::from_bytes(&[4; 32]);
    let keys = [
        key.verifying_key().to_bytes(),
        rotated.verifying_key().to_bytes(),
    ];
    for key in [key, rotated] {
        let (bytes, sig) = transit_catalog::prepare(&catalog(), &key, now()).unwrap();
        assert!(transit_catalog::verify(&bytes, &sig, &keys, "vilnius", None, now()).is_ok());
        assert!(transit_catalog::verify(&bytes, &sig, &[], "vilnius", None, now()).is_err());
        assert!(transit_catalog::verify(&bytes, &sig, &keys, "oslo", None, now()).is_err());
        let mut changed = bytes.clone();
        changed.push(b' ');
        assert!(transit_catalog::verify(&changed, &sig, &keys, "vilnius", None, now()).is_err());
        for domain in [
            b"PTN-OSM-CATALOG-v1\0".as_slice(),
            b"PTN-TRANSIT-SELECTION-v1\0",
            b"",
        ] {
            let sig = key.sign(&[domain, &bytes].concat()).to_bytes();
            assert!(transit_catalog::verify(&bytes, &sig, &keys, "vilnius", None, now()).is_err());
        }
    }
}

#[test]
fn prevents_rollback_equivocation_and_stale_or_future_heads() {
    let key = SigningKey::from_bytes(&[3; 32]);
    let keys = [key.verifying_key().to_bytes()];
    let (bytes, sig) = transit_catalog::prepare(&catalog(), &key, now()).unwrap();
    let checkpoint = Checkpoint {
        sequence: 2,
        sha256: digest(&bytes),
    };
    assert!(
        transit_catalog::verify(&bytes, &sig, &keys, "vilnius", Some(&checkpoint), now()).is_ok()
    );
    for checkpoint in [
        Checkpoint {
            sequence: 3,
            sha256: digest(&bytes),
        },
        Checkpoint {
            sequence: 2,
            sha256: digest(b"other"),
        },
    ] {
        assert!(
            transit_catalog::verify(&bytes, &sig, &keys, "vilnius", Some(&checkpoint), now())
                .is_err()
        );
    }
    let prior = Checkpoint {
        sequence: 1,
        sha256: digest(b"prior"),
    };
    assert!(transit_catalog::verify(&bytes, &sig, &keys, "vilnius", Some(&prior), now()).is_ok());
    assert!(
        transit_catalog::verify(&bytes, &sig, &keys, "vilnius", None, now() + 31 * 86400).is_err()
    );
    assert!(transit_catalog::verify(&bytes, &sig, &keys, "vilnius", None, now() - 301).is_err());
    assert!(transit_catalog::verify(&bytes, &sig, &keys, "vilnius", None, now() - 300).is_ok());
}

#[test]
fn rejects_invalid_or_ambiguous_catalogs_even_with_valid_signatures() {
    let key = SigningKey::from_bytes(&[3; 32]);
    let keys = [key.verifying_key().to_bytes()];
    for case in 0..10 {
        let mut head = catalog();
        match case {
            0 => head.schema_version = 2,
            1 => head.sequence = 0,
            2 => head.pack_id = "bad".into(),
            3 => head.city = "../vilnius".into(),
            4 => head.expires_at = head.published_at.clone(),
            5 => head.selections.clear(),
            6 => head.selections.push(head.selections[0].clone()),
            7 => head.selections[0].bytes = 0,
            8 => {
                head.selections[0].bytes =
                    pt_artifacts::transit_export::MAX_DESCRIPTOR_BYTES as u64 + 1
            }
            _ => head.selections.push(Selection {
                geometry_selected: true,
                ..head.selections[0].clone()
            }),
        }
        assert!(transit_catalog::prepare(&head, &key, now()).is_err());
        let bytes = serde_json::to_vec(&head).unwrap();
        let sig = key
            .sign(&transit_catalog::signing_message(&bytes).unwrap())
            .to_bytes();
        assert!(transit_catalog::verify(&bytes, &sig, &keys, &head.city, None, now()).is_err());
    }
    assert!(
        transit_catalog::signing_message(&vec![0; transit_catalog::MAX_CATALOG_BYTES + 1]).is_err()
    );
}

#[test]
fn binds_selection_bytes_pack_generation_and_geometry() {
    let key = SigningKey::from_bytes(&[3; 32]);
    let keys = [key.verifying_key().to_bytes()];
    let head = catalog();
    let inventory = serde_json::json!({
        "schemaVersion":1,"city":"vilnius","packId":head.pack_id,"generationId":head.generation_id,
        "geometrySelected":false,"omittedGeometry":[],"excludedExtras":[],"selectedBytes":3,
        "files":(["pack.json","generation.json","bundle.ptb"].map(|path|serde_json::json!({
            "path":path,"kind":"metadata","sha256":digest(b"a"),"sizeBytes":1
        })))
    });
    let bytes = serde_json::to_vec(&inventory).unwrap();
    let sig = key
        .sign(&[b"PTN-TRANSIT-SELECTION-v1\0".as_slice(), &bytes].concat())
        .to_bytes();
    let mut head = Catalog {
        selections: vec![Selection {
            sha256: digest(&bytes),
            bytes: bytes.len() as u64,
            geometry_selected: false,
        }],
        ..head
    };
    assert!(transit_catalog::verify_selection(&head, &bytes, &sig, &keys, false).is_ok());
    assert!(transit_catalog::verify_selection(&head, &bytes, &sig, &keys, true).is_err());
    head.pack_id = digest(b"different pack");
    assert!(transit_catalog::verify_selection(&head, &bytes, &sig, &keys, false).is_err());
    head.pack_id = inventory["packId"].as_str().unwrap().into();
    head.generation_id = digest(b"different generation");
    assert!(transit_catalog::verify_selection(&head, &bytes, &sig, &keys, false).is_err());
    head.generation_id = inventory["generationId"].as_str().unwrap().into();
    head.selections[0].sha256 = digest(b"different bytes");
    assert!(transit_catalog::verify_selection(&head, &bytes, &sig, &keys, false).is_err());
}
