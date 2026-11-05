fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: emit_projection <bundle.ptb>");
    let bytes = std::fs::read(&path).expect("read bundle");
    let r = pt_core::Reader::from_bytes(bytes).expect("decode bundle");
    print!("{}", pt_core::projection::project(&r));
}
