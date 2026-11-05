//! Re-emit a JSON document the way JavaScript's `JSON.stringify(JSON.parse(s))`
//! would, without building a `serde_json::Value` tree.
//!
//! ## Why this exists
//!
//! The Node backend's `GET /api/gtfs/manifest` route replies with
//! `reply.send(snapshot.parsed)` (`packages/backend/src/routes/gtfsManifest.ts`)
//! — i.e. it re-serialises the *parsed* object through Fastify's
//! `JSON.stringify`. It does NOT echo the on-disk file, which the producer
//! writes pretty-printed with two-space indent
//! (`crates/pt-producer/src/schedule_tiles/artifacts.rs`
//! `write_bundle_manifest` → `serde_json::to_vec_pretty`). Byte parity with
//! Node therefore means "compact, JS number spelling", not "the file's bytes".
//!
//! Two things a naive `serde_json` round-trip gets wrong:
//!
//! 1. **Integer-valued floats.** `serde_json` writes an `f64` of `1.0` as
//!    `1.0`; JS writes `1`. Schedule-tile `bbox` corners are `f64` and a
//!    grid-aligned cell edge lands on an exact integer, so this is reachable.
//! 2. **Unknown fields.** Deserialising into a typed struct drops fields the
//!    struct does not name. [`crate::schedule_tile_manifest::ScheduleTileManifest`]
//!    does exactly that on purpose (Postel rule, so an older pt-serve binary
//!    survives a newer producer). Node has no such struct — it echoes whatever
//!    the file holds. Serving from the typed struct would fork the two planes
//!    the first time the producer grows a field.
//!
//! Walking the source text instead of a tree fixes both at once: field order
//! and unknown fields survive by construction, and the only tokens rewritten
//! are numbers.
//!
//! ## What this assumes about the input
//!
//! The input is producer-written JSON (`serde_json`), not arbitrary
//! internet JSON. Two `JSON.parse`/`JSON.stringify` behaviours are therefore
//! deliberately NOT emulated, because `serde_json` cannot produce input that
//! would trigger them:
//!
//! - **Escape renormalisation.** JS re-escapes strings on output, so a source
//!   `"\u00e9"` comes back as a raw `é`. `serde_json` never emits `\u`-escapes
//!   for printable non-ASCII (it writes raw UTF-8), and it escapes exactly the
//!   set JS escapes (`"`, `\`, and controls below 0x20) in the same lowercase
//!   `\u00XX` spelling. String tokens are therefore copied verbatim.
//! - **Duplicate keys.** `JSON.parse` keeps the last occurrence; this pass
//!   keeps both. `serde_json` never writes a duplicate key from a map.
//!
//! Both assumptions hold for every file this is used on. If that ever stops
//! being true, the failure is a byte-parity diff caught by the route-parity
//! gate, not silent corruption.

use std::fmt::Write as _;

/// Input was not well-formed JSON (or held a number token that is not a valid
/// JSON number). Carries a byte offset into the source to make triage cheap.
#[derive(Debug, PartialEq, Eq)]
pub struct JsJsonError {
    pub offset: usize,
    pub reason: &'static str,
}

impl std::fmt::Display for JsJsonError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} at byte {}", self.reason, self.offset)
    }
}

impl std::error::Error for JsJsonError {}

/// Compact `src` and rewrite every number token into JS spelling.
///
/// Equivalent to `JSON.stringify(JSON.parse(src))` under the input
/// assumptions documented on this module. Structural validation is
/// intentionally shallow: this is a re-emitter, not a validator — the caller
/// has already (or will) parse the same bytes into a typed struct, which is
/// what rejects a malformed document.
pub fn compact_normalize(src: &[u8]) -> Result<Vec<u8>, JsJsonError> {
    let mut out = Vec::with_capacity(src.len());
    let mut i = 0usize;
    while i < src.len() {
        let b = src[i];
        match b {
            // Whitespace between tokens — the only thing `to_vec_pretty` adds.
            b' ' | b'\t' | b'\n' | b'\r' => {
                i += 1;
            }
            // Strings are copied verbatim, escapes included (see module docs).
            b'"' => {
                let start = i;
                i += 1;
                loop {
                    let Some(&c) = src.get(i) else {
                        return Err(JsJsonError {
                            offset: start,
                            reason: "unterminated string",
                        });
                    };
                    match c {
                        b'\\' => {
                            // Skip the escape marker AND the escaped byte, so a
                            // `\"` does not read as the closing quote.
                            i += 2;
                        }
                        b'"' => {
                            i += 1;
                            break;
                        }
                        _ => i += 1,
                    }
                }
                if i > src.len() {
                    return Err(JsJsonError {
                        offset: start,
                        reason: "unterminated string",
                    });
                }
                out.extend_from_slice(&src[start..i]);
            }
            // Number token: `-`? digits (`.` digits)? (`e` sign? digits)?
            b'-' | b'0'..=b'9' => {
                let start = i;
                i += 1;
                while i < src.len()
                    && matches!(src[i], b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')
                {
                    i += 1;
                }
                let raw = std::str::from_utf8(&src[start..i]).map_err(|_| JsJsonError {
                    offset: start,
                    reason: "number token is not UTF-8",
                })?;
                let rendered = normalize_number_token(raw).ok_or(JsJsonError {
                    offset: start,
                    reason: "invalid number token",
                })?;
                out.extend_from_slice(rendered.as_bytes());
            }
            // Structural bytes and the `true`/`false`/`null` literals.
            _ => {
                out.push(b);
                i += 1;
            }
        }
    }
    Ok(out)
}

/// Significant digits (no leading/trailing zeros) plus `n`, the position of the
/// decimal point relative to them — the spec's `s` and `n` in
/// ECMA-262 `Number::toString`. `digits` empty means the value is zero.
struct Decimal {
    digits: String,
    n: i32,
}

impl Decimal {
    /// Strip the zeros that carry no information, moving `n` to compensate.
    fn normalized(mut digits: String, mut n: i32) -> Self {
        let leading = digits.len() - digits.trim_start_matches('0').len();
        digits.drain(..leading);
        n -= leading as i32;
        let trailing = digits.len() - digits.trim_end_matches('0').len();
        digits.truncate(digits.len() - trailing);
        Decimal { digits, n }
    }
}

/// Split a JSON number token into significant digits + decimal-point position,
/// WITHOUT going through `f64`. Returns `None` if the token is not a valid JSON
/// number.
fn decimal_from_token(raw: &str) -> Option<Decimal> {
    let body = raw.strip_prefix('-').unwrap_or(raw);
    let (significand, exp) = match body.split_once(['e', 'E']) {
        Some((s, e)) => (s, e.parse::<i32>().ok()?),
        None => (body, 0),
    };
    let (int_part, frac_part) = match significand.split_once('.') {
        Some((i, f)) => (i, f),
        None => (significand, ""),
    };
    if int_part.is_empty() && frac_part.is_empty() {
        return None;
    }
    if !int_part.bytes().all(|b| b.is_ascii_digit())
        || !frac_part.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let mut digits = String::with_capacity(int_part.len() + frac_part.len());
    digits.push_str(int_part);
    digits.push_str(frac_part);
    // The point sits after the integer digits, then slides by the exponent.
    let n = int_part.len() as i32 + exp;
    Some(Decimal::normalized(digits, n))
}

/// Shortest-roundtrip decimal for a finite non-zero `f64`, via `{:e}`.
fn decimal_from_f64(v: f64) -> Decimal {
    // `{:e}` yields shortest-roundtrip digits as `d[.ddd]e<exp>`, where the
    // value is `d.ddd × 10^exp`.
    let exp_form = format!("{:e}", v.abs());
    let (mantissa, exp) = exp_form.split_once('e').expect("{:e} always emits an 'e'");
    let exp10: i32 = exp.parse().expect("{:e} always emits an integer exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    Decimal::normalized(digits, exp10 + 1)
}

/// Render a JSON number token the way `JSON.stringify(JSON.parse(tok))` would.
///
/// The digits come from the SOURCE token whenever the source is already a
/// shortest-roundtrip spelling of its double; only the presentation is
/// rewritten. That matters because Rust's `{:e}` and V8 do not always pick the
/// same 17-digit spelling when two of them round-trip to the same double
/// (measured: 2 disagreements in 8997 random doubles, e.g. V8 says
/// `1720260045454016.2` where Rust says `1720260045454016.3`). The producer
/// writes these files with `serde_json`, whose ryu backend agrees with V8 on
/// digits (measured: 0 disagreements in 20000 random doubles), so echoing the
/// source digits sidesteps the divergence entirely on every file this actually
/// sees.
///
/// A source token carrying MORE digits than the double can justify (a
/// hand-written `12345678901234567890`) is not a shortest spelling, so it falls
/// back to the `f64` path — which is exactly what `JSON.parse` does to it.
fn normalize_number_token(raw: &str) -> Option<String> {
    let value: f64 = raw.parse().ok()?;
    if !value.is_finite() {
        return None;
    }
    let from_f64 = if value == 0.0 {
        Decimal {
            digits: String::new(),
            n: 0,
        }
    } else {
        decimal_from_f64(value)
    };
    let from_token = decimal_from_token(raw)?;
    // A spelling can never be SHORTER than the shortest-roundtrip one, so
    // equal length means the source is itself a shortest spelling — prefer it.
    let chosen = if from_token.digits.len() <= from_f64.digits.len() {
        from_token
    } else {
        from_f64
    };
    Some(render_decimal(raw.starts_with('-'), &chosen))
}

/// Format `v` exactly as ECMA-262 `Number::toString(v, 10)` does — the
/// spelling `JSON.stringify` emits for a finite number.
///
/// Rust's own `Display` never switches to exponent notation (`1e21` prints as
/// `1000000000000000000000`, `1e-7` as `0.0000001`), and `LowerExp` always
/// does (`123` prints as `1.23e2`). Neither matches JS on its own, so the
/// shortest-roundtrip digits are taken from `{:e}` and re-laid-out per the
/// spec's five cases.
///
/// Non-finite inputs cannot occur inside JSON (there is no `NaN`/`Infinity`
/// literal). They map to `null`, which is what `JSON.stringify` does with them.
pub fn ecma_number_to_string(v: f64) -> String {
    if !v.is_finite() {
        return "null".to_string();
    }
    // Covers both `0` and `-0`: JS renders negative zero as "0".
    if v == 0.0 {
        return "0".to_string();
    }
    render_decimal(v < 0.0, &decimal_from_f64(v))
}

/// The five presentation cases of ECMA-262 `Number::toString`, applied to
/// already-normalised significant digits.
fn render_decimal(negative: bool, dec: &Decimal) -> String {
    let digits = dec.digits.as_str();
    if digits.is_empty() {
        // JS renders both `0` and `-0` as "0".
        return "0".to_string();
    }
    let k = digits.len() as i32;
    let n = dec.n;

    let mut s = String::with_capacity(digits.len() + 8);
    if negative {
        s.push('-');
    }
    if k <= n && n <= 21 {
        // Integer with trailing zeros: 1e20 -> "100000000000000000000".
        s.push_str(digits);
        for _ in 0..(n - k) {
            s.push('0');
        }
    } else if 0 < n && n <= 21 {
        // Decimal point inside the digits: 54.5 -> "54.5".
        s.push_str(&digits[..n as usize]);
        s.push('.');
        s.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        // Leading-zero decimal: 1e-6 -> "0.000001".
        s.push_str("0.");
        for _ in 0..(-n) {
            s.push('0');
        }
        s.push_str(digits);
    } else {
        // Exponential. JS always signs the exponent: "1e+21", "1e-7".
        if k == 1 {
            s.push_str(digits);
        } else {
            s.push_str(&digits[..1]);
            s.push('.');
            s.push_str(&digits[1..]);
        }
        let e = n - 1;
        let _ = write!(s, "e{}{}", if e < 0 { '-' } else { '+' }, e.abs());
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm(s: &str) -> String {
        String::from_utf8(compact_normalize(s.as_bytes()).expect("valid JSON")).unwrap()
    }

    #[test]
    fn integral_floats_lose_the_decimal_point() {
        // The reason this module exists: serde_json writes `1.0`, JS writes `1`.
        assert_eq!(ecma_number_to_string(1.0), "1");
        assert_eq!(ecma_number_to_string(-1.0), "-1");
        assert_eq!(ecma_number_to_string(123.0), "123");
        assert_eq!(norm(r#"{"minLat":1.0}"#), r#"{"minLat":1}"#);
    }

    #[test]
    fn zero_and_negative_zero_both_render_as_zero() {
        assert_eq!(ecma_number_to_string(0.0), "0");
        assert_eq!(ecma_number_to_string(-0.0), "0");
        assert_eq!(norm(r#"{"a":-0.0}"#), r#"{"a":0}"#);
    }

    #[test]
    fn fractional_values_keep_shortest_roundtrip_digits() {
        assert_eq!(ecma_number_to_string(54.5), "54.5");
        assert_eq!(ecma_number_to_string(0.1), "0.1");
        assert_eq!(ecma_number_to_string(54.68333), "54.68333");
        assert_eq!(ecma_number_to_string(-25.2797), "-25.2797");
    }

    /// The four boundaries where ECMA-262 switches presentation. Rust's own
    /// `Display`/`LowerExp` disagree with JS on every one of these.
    #[test]
    fn exponent_boundaries_match_javascript() {
        assert_eq!(ecma_number_to_string(1e20), "100000000000000000000");
        assert_eq!(ecma_number_to_string(1e21), "1e+21");
        assert_eq!(ecma_number_to_string(1e-6), "0.000001");
        assert_eq!(ecma_number_to_string(1e-7), "1e-7");
        assert_eq!(ecma_number_to_string(1.5e300), "1.5e+300");
        assert_eq!(ecma_number_to_string(5e-324), "5e-324");
        assert_eq!(
            ecma_number_to_string(1.7976931348623157e308),
            "1.7976931348623157e+308"
        );
    }

    #[test]
    fn large_integers_round_through_f64_like_json_parse_does() {
        // JS numbers are doubles, so `JSON.parse` rounds this the same way.
        assert_eq!(
            norm(r#"{"n":12345678901234567890}"#),
            r#"{"n":12345678901234567000}"#
        );
        // Exactly representable integers survive untouched.
        assert_eq!(
            norm(r#"{"n":9007199254740991}"#),
            r#"{"n":9007199254740991}"#
        );
    }

    #[test]
    fn pretty_printed_input_becomes_compact() {
        let pretty = "{\n  \"a\": 1,\n  \"b\": [\n    1,\n    2\n  ]\n}";
        assert_eq!(norm(pretty), r#"{"a":1,"b":[1,2]}"#);
    }

    #[test]
    fn key_order_is_preserved_verbatim() {
        // Not alphabetical — this is the whole point of walking the text.
        assert_eq!(norm(r#"{"z":1,"a":2,"m":3}"#), r#"{"z":1,"a":2,"m":3}"#);
    }

    #[test]
    fn unknown_fields_survive() {
        let src = r#"{"schemaVersion":1,"futureRevField":{"nested":[true,null]}}"#;
        assert_eq!(norm(src), src);
    }

    #[test]
    fn strings_are_copied_verbatim_including_escapes_and_unicode() {
        let src = r#"{"s":"a\"b\\c\u001fd","u":"Žagarinė","slash":"a/b"}"#;
        assert_eq!(norm(src), src);
    }

    /// Whitespace and number-like bytes inside a string must not be touched —
    /// the scanner has to know it is inside a quoted token.
    #[test]
    fn whitespace_and_digits_inside_strings_are_not_rewritten() {
        let src = r#"{"s":"  1.0  ","t":"1e21"}"#;
        assert_eq!(norm(src), src);
    }

    /// An escaped backslash must not swallow the closing quote.
    #[test]
    fn trailing_escaped_backslash_terminates_the_string() {
        let src = r#"{"s":"c:\\","n":1.0}"#;
        assert_eq!(norm(src), r#"{"s":"c:\\","n":1}"#);
    }

    #[test]
    fn literals_pass_through() {
        assert_eq!(
            norm(r#"{"a":true,"b":false,"c":null}"#),
            r#"{"a":true,"b":false,"c":null}"#
        );
    }

    #[test]
    fn negative_exponent_source_tokens_are_renormalised() {
        // serde_json would never write these, but JSON permits them and JS
        // would renormalise on re-stringify.
        assert_eq!(
            norm(r#"{"a":1E2,"b":1e+2,"c":0.5e1}"#),
            r#"{"a":100,"b":100,"c":5}"#
        );
    }

    /// Differential regression net against V8. Left side is exactly what
    /// `serde_json` (ryu) writes for some double — i.e. what the producer puts
    /// on disk; right side is what `JSON.stringify` emits for that same double
    /// — i.e. what Node's manifest route replies. Generated by round-tripping
    /// 20000 random doubles through both, then sampling every case where the
    /// two spellings differ (plus a fixed-stride spread of the rest).
    ///
    /// Keeping it as a table rather than a live oracle means CI needs no Node
    /// process to defend this parity.
    #[test]
    fn producer_tokens_render_as_node_would() {
        const CASES: &[(&str, &str)] = &[
            ("-5.107163227240719e+16", "-51071632272407190"),
            ("-4.981044617602562e+20", "-498104461760256200000"),
            ("2206129156231902.0", "2206129156231902"),
            ("-1.5132844518179254e+18", "-1513284451817925400"),
            ("5.5045791248877675e-6", "0.0000055045791248877675"),
            ("-2495148768788000.0", "-2495148768788000"),
            ("1.6095958331437824e-6", "0.0000016095958331437824"),
            ("3.677989935263997e+16", "36779899352639970"),
            ("6.066111602794263e+18", "6066111602794263000"),
            ("2.2351461488456118e+17", "223514614884561180"),
            ("-5.972295081275636e+16", "-59722950812756360"),
            ("1.4615440145756496e-6", "0.0000014615440145756496"),
            ("5.987315110675979e-6", "0.000005987315110675979"),
            ("4.644943675809837e-6", "0.000004644943675809837"),
            ("7.854967912095208e+16", "78549679120952080"),
            ("-1.0196631142733192e+20", "-101966311427331920000"),
            ("1.3256263648388346e+16", "13256263648388346"),
            ("-4763326193864706.0", "-4763326193864706"),
            ("7.348957816087059e+17", "734895781608705900"),
            ("-1.1874401836912878e+18", "-1187440183691287800"),
            ("-2.537927043339076e+18", "-2537927043339076000"),
            ("-9.396671104127023e+18", "-9396671104127023000"),
            ("-5.6356314884228494e+20", "-563563148842284940000"),
            ("1.612183791633562e+16", "16121837916335620"),
            ("-6.575646811516124e+19", "-65756468115161240000"),
            ("1.9649392896665956e+16", "19649392896665956"),
            ("3.354714262184089e+20", "335471426218408900000"),
            ("-4.724134250179233e+16", "-47241342501792330"),
            ("3.074018620972263e+17", "307401862097226300"),
            ("-1.0715526779668202e+18", "-1071552677966820200"),
            ("-3.1467270797554464e+17", "-314672707975544640"),
            ("-4.5762483582375174e+19", "-45762483582375174000"),
            ("2.3615160965062666e+17", "236151609650626660"),
            ("3.4182018950985953e+18", "3418201895098595300"),
            ("-1.304211310118089e+19", "-13042113101180890000"),
            ("-5.717134855700941e+20", "-571713485570094100000"),
            ("-5.755247219893602e+18", "-5755247219893602000"),
            ("4.16259393319563e+16", "41625939331956300"),
            ("2.021027781018014e+18", "2021027781018014000"),
            ("-5.0296305695666405e+19", "-50296305695666405000"),
            ("7.339609037802225e+20", "733960903780222500000"),
            ("4.310866914890143e+19", "43108669148901430000"),
            ("-4.5750022079588864e+18", "-4575002207958886400"),
            ("7.826365683408644e+17", "782636568340864400"),
            ("7.280601153168302e+16", "72806011531683020"),
            ("3.6487519882660204e+20", "364875198826602040000"),
            ("-1.2474121727559889e+19", "-12474121727559889000"),
            ("7.304796851008611e-6", "0.000007304796851008611"),
            ("1.2797165072192906e+16", "12797165072192906"),
            ("-3531771037530438.0", "-3531771037530438"),
            ("3.73411133079809e+20", "373411133079809000000"),
            ("3.4239081947490687e-6", "0.0000034239081947490687"),
            ("-6.539034081980428e+19", "-65390340819804280000"),
            ("5.935809754800879e-6", "0.000005935809754800879"),
            ("-3.5234191392793928e+19", "-35234191392793928000"),
            ("1.581139554450506e+17", "158113955445050600"),
            ("1.0356443469202515e+18", "1035644346920251500"),
            ("-1.2567031583478488e+16", "-12567031583478488"),
            ("3.475134488157132e+18", "3475134488157132000"),
            ("-1.3267282553573349e-6", "-0.0000013267282553573349"),
            ("-1.5929876941125242e-282", "-1.5929876941125242e-282"),
            ("2.496549788084994e+238", "2.496549788084994e+238"),
            ("9.189575176807533e+52", "9.189575176807533e+52"),
            ("-1.2274809297487533e+237", "-1.2274809297487533e+237"),
            ("1.1140256315552132e-158", "1.1140256315552132e-158"),
            ("4.580319281155397e+147", "4.580319281155397e+147"),
            ("-0.0001247851761879394", "-0.0001247851761879394"),
            ("3.5009601192966197e-51", "3.5009601192966197e-51"),
            ("1.3333087948926848e-259", "1.3333087948926848e-259"),
            ("-221.70837989005537", "-221.70837989005537"),
            ("-4.137470167083946e-164", "-4.137470167083946e-164"),
            ("-0.4470634126038048", "-0.4470634126038048"),
            ("-1.3282581657901884e-229", "-1.3282581657901884e-229"),
            ("-1.6991788223251681e-66", "-1.6991788223251681e-66"),
            ("-1.3247880997604406e+54", "-1.3247880997604406e+54"),
            ("2.4593535424259476e+151", "2.4593535424259476e+151"),
            ("-1.929638982821152e-12", "-1.929638982821152e-12"),
            ("-2.157115306102216e-22", "-2.157115306102216e-22"),
            ("1.7549826500699725e+177", "1.7549826500699725e+177"),
            ("5.113922780829232e-38", "5.113922780829232e-38"),
            ("-2.1860863284486907e+276", "-2.1860863284486907e+276"),
            ("-1.61773761902711e-45", "-1.61773761902711e-45"),
            ("1.5981381869800334e-302", "1.5981381869800334e-302"),
            ("2.307947200855229e+25", "2.307947200855229e+25"),
            ("2.705937151886718e+121", "2.705937151886718e+121"),
            ("-8.687709539098595e+217", "-8.687709539098595e+217"),
            ("-1.649397137403643e-56", "-1.649397137403643e-56"),
            ("5.742596167979823e-110", "5.742596167979823e-110"),
            ("7.624728556500804e+65", "7.624728556500804e+65"),
            ("1.1413060555931976e+235", "1.1413060555931976e+235"),
            ("-2.8484520428510007e-25", "-2.8484520428510007e-25"),
            ("1.92980738077688", "1.92980738077688"),
            ("4.176478024821114e+140", "4.176478024821114e+140"),
            ("-7.870358352431775e+281", "-7.870358352431775e+281"),
            ("1.0220642536223389e+223", "1.0220642536223389e+223"),
            ("-1.9309432158158322e+154", "-1.9309432158158322e+154"),
            ("4.661206686263389e+24", "4.661206686263389e+24"),
            ("3.463558124442603e-14", "3.463558124442603e-14"),
            ("-1.4432658159459483e-130", "-1.4432658159459483e-130"),
            ("-1.1553013851730564e-187", "-1.1553013851730564e-187"),
            ("-1.0634411884278214e-218", "-1.0634411884278214e-218"),
            ("4.4505508012986383e+201", "4.4505508012986383e+201"),
            ("1.2103200582316199e+177", "1.2103200582316199e+177"),
            ("-6.517544175440494e-292", "-6.517544175440494e-292"),
            ("6.015306102322304e+180", "6.015306102322304e+180"),
            ("2.2396417523147e-280", "2.2396417523147e-280"),
            ("1.756753589420351e-134", "1.756753589420351e-134"),
            ("2.26988672793454e-257", "2.26988672793454e-257"),
            ("-6.7172629775303995e-136", "-6.7172629775303995e-136"),
            ("-6.802509586494681e-218", "-6.802509586494681e-218"),
            ("2.2273991920810256e-241", "2.2273991920810256e-241"),
            ("428262.85939452366", "428262.85939452366"),
            ("6.443554552096089e-271", "6.443554552096089e-271"),
            ("-1.0492152751084424e+259", "-1.0492152751084424e+259"),
            ("-3170.543586389572", "-3170.543586389572"),
            ("-1.0864125375634744e+155", "-1.0864125375634744e+155"),
            ("-1.1326791071667961e+196", "-1.1326791071667961e+196"),
            ("-3.2108784449484375e+25", "-3.2108784449484375e+25"),
            ("-1.0377470401319901e+18", "-1037747040131990100"),
            ("4.816337930472127e-260", "4.816337930472127e-260"),
        ];
        for (ryu, js) in CASES {
            assert_eq!(&norm(ryu), js, "input {ryu}");
        }
    }

    #[test]
    fn unterminated_string_is_an_error_not_a_panic() {
        let err = compact_normalize(br#"{"a":"oops"#).unwrap_err();
        assert_eq!(err.reason, "unterminated string");
    }

    #[test]
    fn invalid_number_token_is_an_error_not_a_panic() {
        let err = compact_normalize(br#"{"a":1.2.3}"#).unwrap_err();
        assert_eq!(err.reason, "invalid number token");
    }

    /// A realistic slice of the schedule-tile manifest, including the
    /// integral-`bbox` case that motivated the whole module.
    #[test]
    fn schedule_tile_manifest_shape_round_trips() {
        let pretty = r#"{
  "schemaVersion": 1,
  "bundleHash": "abc123",
  "generatedAt": 1752300000000,
  "tileSize": 6000,
  "subdivisions": {
    "1_2": {
      "leaves": [
        {
          "suffix": "0",
          "bbox": {
            "minLat": 54.0,
            "maxLat": 54.5,
            "minLon": 25.25,
            "maxLon": 25.5
          },
          "compressedBytes": 123,
          "oversized": false
        }
      ]
    }
  }
}"#;
        assert_eq!(
            norm(pretty),
            r#"{"schemaVersion":1,"bundleHash":"abc123","generatedAt":1752300000000,"tileSize":6000,"subdivisions":{"1_2":{"leaves":[{"suffix":"0","bbox":{"minLat":54,"maxLat":54.5,"minLon":25.25,"maxLon":25.5},"compressedBytes":123,"oversized":false}]}}}"#
        );
    }
}
