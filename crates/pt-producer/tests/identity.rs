use pt_producer::pass1::identity::IdentityInterner;

#[test]
fn intern_returns_dense_ids_in_insertion_order() {
    let mut i = IdentityInterner::<String>::new();
    assert_eq!(i.intern("a".into()), 0);
    assert_eq!(i.intern("b".into()), 1);
    assert_eq!(i.intern("a".into()), 0);
    assert_eq!(i.intern("c".into()), 2);
    assert_eq!(i.len(), 3);
}

#[test]
fn finalize_remaps_to_sorted_order_for_determinism() {
    let mut a = IdentityInterner::<String>::new();
    a.intern("c".into());
    a.intern("a".into());
    a.intern("b".into());

    let mut b = IdentityInterner::<String>::new();
    b.intern("a".into());
    b.intern("b".into());
    b.intern("c".into());

    let af = a.finalize();
    let bf = b.finalize();

    assert_eq!(af.lookup("a"), Some(0));
    assert_eq!(af.lookup("b"), Some(1));
    assert_eq!(af.lookup("c"), Some(2));
    assert_eq!(bf.lookup("a"), Some(0));
    assert_eq!(bf.lookup("b"), Some(1));
    assert_eq!(bf.lookup("c"), Some(2));
}

#[test]
fn finalize_returns_remap_from_pre_to_post() {
    let mut i = IdentityInterner::<String>::new();
    let pre_c = i.intern("c".into());
    let pre_a = i.intern("a".into());
    let pre_b = i.intern("b".into());
    let final_table = i.finalize();
    assert_eq!(
        final_table.remap()[pre_c as usize],
        final_table.lookup("c").unwrap()
    );
    assert_eq!(
        final_table.remap()[pre_a as usize],
        final_table.lookup("a").unwrap()
    );
    assert_eq!(
        final_table.remap()[pre_b as usize],
        final_table.lookup("b").unwrap()
    );
}

#[test]
fn finalize_returns_sorted_keys_slice() {
    let mut i = IdentityInterner::<String>::new();
    i.intern("c".into());
    i.intern("a".into());
    i.intern("b".into());
    let table = i.finalize();
    assert_eq!(table.keys(), &["a".to_string(), "b".into(), "c".into()]);
}
