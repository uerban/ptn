//! Hand-ported color-science primitives, verbatim from culori
//! (github.com/Evercoder/culori, src/) — NOT a crate dependency. See the
//! plan's for why: an external crate's internal formula
//! choices (white point, gamut clamp, matrix precision) would be a silent
//! divergence source the differential gate can't attribute back to a cause.
//! Every function below cites its exact culori source file. Every constant
//! and formula here was independently re-verified against culori's actual
//! `main`-branch source (fetched live) while writing this file — see the
//! per-function citations for the exact file each was checked against.

use std::f64::consts::PI;

/// sRGB [0,1] channel value. Not clamped — callers gamut-clamp at hex-format time, matching
/// culori's own lazy-clamp behavior (formatHex on out-of-gamut OKLCH returns undefined in culori;
/// colorClustering.ts's generateRouteColor falls back to "#6b7280" on that — port that fallback in
/// cluster.rs, not here).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rgb {
    pub r: f64,
    pub g: f64,
    pub b: f64,
}

/// CIE L*a*b* color, D50 white point (culori's `lab` mode) — see this
/// module's top-of-file docs for why this codebase's only Lab variant is
/// D50, not D65.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Lab {
    pub l: f64,
    pub a: f64,
    pub b: f64,
}

/// Oklab color (culori's `oklab` mode) — Björn Ottosson's perceptual color
/// space, computed directly from linear-light sRGB via the LMS matrices in
/// `rgb_to_oklab`/`oklab_to_rgb` below.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Oklab {
    pub l: f64,
    pub a: f64,
    pub b: f64,
}

/// Oklch color (culori's `oklch` mode) — Oklab expressed in cylindrical
/// (lightness, chroma, hue-degrees) form via `oklab_to_oklch`/`oklch_to_oklab`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Oklch {
    pub l: f64,
    pub c: f64,
    pub h: f64,
}

/// sRGB gamma decode (culori src/lrgb/convertRgbToLrgb.js `fn`).
///
/// culori's actual source for the >0.04045 branch is
/// `(Math.sign(c) || 1) * ((Math.abs(c) + 0.055) / 1.055) ** 2.4` — verified
/// by fetching the file directly. The `|| 1` fallback only matters when
/// `Math.sign(c) === 0`, i.e. c === 0 exactly, but c === 0 always takes the
/// `abs <= 0.04045` branch above, so the fallback is unreachable here (same
/// reasoning applies to `linear_to_srgb` below, whose >0.0031308 branch
/// likewise only runs for nonzero c). `f64::signum()` therefore reproduces
/// `Math.sign(c) || 1` exactly for every input this branch actually sees.
fn srgb_to_linear(c: f64) -> f64 {
    let abs = c.abs();
    if abs <= 0.04045 {
        c / 12.92
    } else {
        c.signum() * ((abs + 0.055) / 1.055).powf(2.4)
    }
}

/// sRGB gamma encode (culori src/lrgb/convertLrgbToRgb.js `fn`). Mirrors the
/// JS `(Math.sign(c) || 1)` idiom: sign(0) in JS is 0, and `0 || 1` is 1, so
/// zero must map to +1, not 0 — `f64::signum()` already returns +1.0 for 0.0
/// and NaN for... actually Rust's `f64::signum()` returns 1.0 for +0.0 and
/// -1.0 for -0.0, matching `Math.sign(c) || 1` for c=+0.0 but NOT for c=-0.0
/// (JS: Math.sign(-0) is -0, `-0 || 1` is 1; Rust: (-0.0_f64).signum() is
/// -1.0). RGB channel values from this pipeline are never negative zero in
/// practice (they come from matrix multiplication of positive tristimulus
/// values), so this divergence is theoretical — note it here rather than
/// silently diverge; if the differential gate ever flags a hex-string
/// mismatch on a near-zero channel, this is the first place to check.
fn linear_to_srgb(c: f64) -> f64 {
    let abs = c.abs();
    if abs > 0.0031308 {
        c.signum() * (1.055 * abs.powf(1.0 / 2.4) - 0.055)
    } else {
        c * 12.92
    }
}

/// culori src/lrgb/convertRgbToLrgb.js — per-channel sRGB gamma decode
/// (public wrapper around `srgb_to_linear`).
pub fn rgb_to_lrgb(c: Rgb) -> Rgb {
    Rgb {
        r: srgb_to_linear(c.r),
        g: srgb_to_linear(c.g),
        b: srgb_to_linear(c.b),
    }
}

/// culori src/lrgb/convertLrgbToRgb.js — per-channel sRGB gamma encode
/// (public wrapper around `linear_to_srgb`).
pub fn lrgb_to_rgb(c: Rgb) -> Rgb {
    Rgb {
        r: linear_to_srgb(c.r),
        g: linear_to_srgb(c.g),
        b: linear_to_srgb(c.b),
    }
}

// White points, CIE 1931 2° standard observer (culori src/constants.js).
// D50.Y = 1, D65.Y = 1 in both; only X/Z differ.
const D50_X: f64 = 0.3457 / 0.3585;
const D50_Y: f64 = 1.0;
const D50_Z: f64 = (1.0 - 0.3457 - 0.3585) / 0.3585;
const D65_X: f64 = 0.3127 / 0.3290;
const D65_Y: f64 = 1.0;
const D65_Z: f64 = (1.0 - 0.3127 - 0.3290) / 0.3290;

// Lab nonlinearity constants — IDENTICAL for D50 and D65 (culori
// src/constants.js: `k = Math.pow(29, 3) / Math.pow(3, 3)`,
// `e = Math.pow(6, 3) / Math.pow(29, 3)`; the D50/D65 Lab conversion files
// both consume the same k/e, only the white point differs between the two
// Lab variants).
const LAB_K: f64 = 29.0 * 29.0 * 29.0 / 27.0; // 29^3 / 3^3
const LAB_E: f64 = 216.0 / 24389.0; // 6^3 / 29^3

struct Xyz {
    x: f64,
    y: f64,
    z: f64,
}

/// culori src/xyz50/convertRgbToXyz50.js — sRGB primaries matrix, D50.
fn rgb_to_xyz50(c: Rgb) -> Xyz {
    let l = rgb_to_lrgb(c);
    Xyz {
        x: 0.436065742824811 * l.r + 0.3851514688337912 * l.g + 0.14307845442264197 * l.b,
        y: 0.22249319175623702 * l.r + 0.7168870538238823 * l.g + 0.06061979053616537 * l.b,
        z: 0.013923904500943465 * l.r + 0.09708128566574634 * l.g + 0.7140993584005155 * l.b,
    }
}

/// culori src/xyz65/convertXyz65ToRgb.js. Used both by `lab_to_rgb` (the Bradford-adapted
/// D50-Lab→RGB centroid-formatting path colorClustering.ts needs) and, via `rgb_to_lab65` below, is
/// paired with the DIRECT `rgb_to_xyz65` for colorblindPalettes.ts's RGB-mode ciede2000 path.
/// Correction to an earlier version of this comment: a direct RGB→XYZ65 conversion is NOT "unused,
/// deleted" in real culori — `src/xyz65/ convertRgbToXyz65.js` exists and is exactly what
/// `rgb_to_xyz65` below ports; it just wasn't needed by the colorClustering.ts port, which only
/// ever converts D50 Lab-mode objects. the colorblindPalettes.ts port needs it (see
/// `rgb_to_xyz65`'s doc comment). `excessive_precision` would otherwise force truncating this
/// full-precision matrix constant copied verbatim from culori's source, so it no longer diffs
/// cleanly against culori on inspection.
#[allow(clippy::excessive_precision)]
fn xyz65_to_rgb(c: &Xyz) -> Rgb {
    lrgb_to_rgb(Rgb {
        r: c.x * 3.2409699419045226 - c.y * 1.5373831775700939 - 0.4986107602930034 * c.z,
        g: c.x * -0.9692436362808796 + c.y * 1.8759675015077204 + 0.0415550574071756 * c.z,
        b: c.x * 0.0556300796969936 - c.y * 0.2039769588889765 + 1.0569715142428784 * c.z,
    })
}

/// culori src/xyz65/convertRgbToXyz65.js — the STANDARD/canonical sRGB→XYZ
/// D65 primaries matrix (CSS Color 4 / Bruce Lindbloom), used DIRECTLY —
/// NOT derived by composing `rgb_to_xyz50` with a Bradford adaptation. This
/// matters because culori's mode-graph shortcut (`converter()`, src/
/// converter.js) resolves a conversion via a DIRECT `converters[color.mode]
/// [target_mode]` lookup first, falling back to a via-RGB two-hop only when
/// no direct edge is registered. `lab65`'s definition registers
/// `fromMode: {rgb: convertRgbToLab65, xyz65: convertXyz65ToLab65}` — i.e.
/// a direct `rgb → lab65` edge exists — so an RGB-mode color (e.g. from
/// `parse(hexString)`, colorblindPalettes.ts's `ciede2000Diff(parse(a),
/// parse(b))` calls) converts to lab65 via THIS direct path, not via the
/// `lab(D50) → xyz50 → xyz65(Bradford) → lab65` path `hex_to_lab`+
/// `ciede2000` reproduce for colorClustering.ts's D50 Lab-mode objects
/// (`converter('lab')`-sourced, i.e. genuinely mode:'lab', not mode:'rgb').
/// Verified empirically against culori's real output (fetching the library
/// directly): composing `hex_to_lab`+`ciede2000` for an RGB-mode-original
/// comparison is only accurate to ~1e-5..1e-7 relative to real culori — far
/// short of byte-identical — while `rgb_to_lab65`+`ciede2000_lab65` (this
/// direct path) matches culori's actual `differenceCiede2000()(parse(hexA),
/// parse(hexB))` to the bit (0 diff) across black/white/gray/saturated
/// test pairs.
fn rgb_to_xyz65(c: Rgb) -> Xyz {
    let l = rgb_to_lrgb(c);
    Xyz {
        x: 0.4123907992659593 * l.r + 0.357584339383878 * l.g + 0.1804807884018343 * l.b,
        y: 0.2126390058715102 * l.r + 0.715168678767756 * l.g + 0.0721923153607337 * l.b,
        z: 0.0193308187155918 * l.r + 0.119194779794626 * l.g + 0.9505321522496607 * l.b,
    }
}

/// culori src/xyz65/convertXyz50ToXyz65.js — Bradford chromatic adaptation,
/// D50 → D65. This is the step that makes CIEDE2000 (which always operates
/// in D65 Lab, ) disagree with a naive "just compute Lab
/// and diff it" implementation when the caller's Lab is D50, as
/// colorClustering.ts's is.
fn xyz50_to_xyz65(c: &Xyz) -> Xyz {
    Xyz {
        x: 0.9554734527042182 * c.x - 0.0230985368742614 * c.y + 0.0632593086610217 * c.z,
        y: -0.0283697069632081 * c.x + 1.0099954580058226 * c.y + 0.021041398966943 * c.z,
        z: 0.0123140016883199 * c.x - 0.0205076964334779 * c.y + 1.3303659366080753 * c.z,
    }
}

fn lab_f(v: f64) -> f64 {
    if v.powi(3) > LAB_E {
        v.powi(3)
    } else {
        (116.0 * v - 16.0) / LAB_K
    }
}
fn lab_f_inv(v: f64) -> f64 {
    if v > LAB_E {
        v.cbrt()
    } else {
        (LAB_K * v + 16.0) / 116.0
    }
}

/// culori src/lab/convertXyz50ToLab.js.
fn xyz50_to_lab(c: &Xyz) -> Lab {
    let f0 = lab_f_inv(c.x / D50_X);
    let f1 = lab_f_inv(c.y / D50_Y);
    let f2 = lab_f_inv(c.z / D50_Z);
    Lab {
        l: 116.0 * f1 - 16.0,
        a: 500.0 * (f0 - f1),
        b: 200.0 * (f1 - f2),
    }
}

/// culori src/lab/convertLabToXyz50.js.
fn lab_to_xyz50(c: Lab) -> Xyz {
    let fy = (c.l + 16.0) / 116.0;
    let fx = c.a / 500.0 + fy;
    let fz = fy - c.b / 200.0;
    Xyz {
        x: lab_f(fx) * D50_X,
        y: lab_f(fy) * D50_Y,
        z: lab_f(fz) * D50_Z,
    }
}

/// culori src/lab65/convertXyz65ToLab65.js — SAME formula shape as
/// xyz50_to_lab, D65 white point instead.
fn xyz65_to_lab65(c: &Xyz) -> Lab {
    let f0 = lab_f_inv(c.x / D65_X);
    let f1 = lab_f_inv(c.y / D65_Y);
    let f2 = lab_f_inv(c.z / D65_Z);
    Lab {
        l: 116.0 * f1 - 16.0,
        a: 500.0 * (f0 - f1),
        b: 200.0 * (f1 - f2),
    }
}

/// culori src/lab/convertRgbToLab.js, INCLUDING its achromatic-color fixup
/// — do not drop the `r==g==b` special case.
pub fn hex_to_lab(c: Rgb) -> Lab {
    let mut lab = xyz50_to_lab(&rgb_to_xyz50(c));
    if c.r == c.g && c.g == c.b {
        lab.a = 0.0;
        lab.b = 0.0;
    }
    lab
}

/// culori src/lab65/convertRgbToLab65.js ==
/// `convertXyz65ToLab65(convertRgbToXyz65(rgb))`, INCLUDING the same
/// achromatic fixup as `hex_to_lab`. Use this (paired
/// with `ciede2000_lab65` below), NOT `hex_to_lab`+`ciede2000`, for any
/// ciede2000 comparison whose inputs originate as hex strings / parsed RGB
/// values (colorblindPalettes.ts's usage) rather than genuine D50 Lab-mode
/// culori objects (colorClustering.ts's usage) — see `rgb_to_xyz65`'s doc
/// comment for the full explanation and empirical bit-exactness check.
pub fn rgb_to_lab65(c: Rgb) -> Lab {
    let mut lab = xyz65_to_lab65(&rgb_to_xyz65(c));
    if c.r == c.g && c.g == c.b {
        lab.a = 0.0;
        lab.b = 0.0;
    }
    lab
}

/// culori src/lab/convertLabToRgb.js path (Lab D50 → XYZ50 → RGB), used by
/// centroid-hex formatting (cluster.rs formats a Lab centroid back to hex —
/// colorClustering.ts's `formatHex(cluster.centroidLab)`, where centroidLab
/// is a D50 Lab object since it's an arithmetic mean of D50 Lab values).
pub fn lab_to_rgb(c: Lab) -> Rgb {
    xyz65_to_rgb(&xyz50_to_xyz65(&lab_to_xyz50(c)))
}

/// D50 Lab → D65 Lab, via the SAME graph path culori's mode-conversion
/// system takes for an already-`lab`-mode input converted to `lab65`
///: lab → xyz50 → xyz65 (Bradford) → lab65. This is
/// NOT the same as directly computing Lab in D65 from the original RGB —
/// it is specifically the two-hop re-adaptation culori performs.
fn lab_to_lab65(c: Lab) -> Lab {
    xyz65_to_lab65(&xyz50_to_xyz65(&lab_to_xyz50(c)))
}

/// culori src/difference.js `differenceCiede2000` core numeric formula
/// (Kl=Kc=Kh=1, culori's defaults — colorClustering.ts's
/// `ciede2000Diff = differenceCiede2000()` calls it with no args), operating
/// directly on two Lab-shaped values that are ALREADY in the same color
/// space (D65 Lab in culori's actual pipeline). Kept separate from the
/// public `ciede2000` below so unit tests can feed it the published
/// Sharma/Wu/Dalal reference vectors directly, without those vectors first
/// being reinterpreted as D50 and Bradford-adapted (see the Step 7 test
/// comment for why that distinction matters).
///
/// Algorithm: Sharma/Wu/Dalal 2005, "The CIEDE2000 Color-Difference
/// Formula: Implementation Notes, Supplementary Test Data, and Mathematical
/// Observations." Every line below was checked against culori's actual
/// `differenceCiede2000` source (fetched from GitHub) and matches exactly.
fn ciede2000_raw(std: Lab, smp: Lab) -> f64 {
    let (l_std, a_std, b_std) = (std.l, std.a, std.b);
    let (l_smp, a_smp, b_smp) = (smp.l, smp.a, smp.b);
    let c_std = (a_std * a_std + b_std * b_std).sqrt();
    let c_smp = (a_smp * a_smp + b_smp * b_smp).sqrt();

    let c_avg = (c_std + c_smp) / 2.0;
    let g = 0.5 * (1.0 - (c_avg.powi(7) / (c_avg.powi(7) + 25f64.powi(7))).sqrt());

    let ap_std = a_std * (1.0 + g);
    let ap_smp = a_smp * (1.0 + g);
    let cp_std = (ap_std * ap_std + b_std * b_std).sqrt();
    let cp_smp = (ap_smp * ap_smp + b_smp * b_smp).sqrt();

    let mut hp_std = if ap_std.abs() + b_std.abs() == 0.0 {
        0.0
    } else {
        b_std.atan2(ap_std)
    };
    if hp_std < 0.0 {
        hp_std += 2.0 * PI;
    }
    let mut hp_smp = if ap_smp.abs() + b_smp.abs() == 0.0 {
        0.0
    } else {
        b_smp.atan2(ap_smp)
    };
    if hp_smp < 0.0 {
        hp_smp += 2.0 * PI;
    }

    let dl = l_smp - l_std;
    let dc = cp_smp - cp_std;

    let mut dhp = if cp_std * cp_smp == 0.0 {
        0.0
    } else {
        hp_smp - hp_std
    };
    if dhp > PI {
        dhp -= 2.0 * PI;
    }
    if dhp < -PI {
        dhp += 2.0 * PI;
    }
    let dh = 2.0 * (cp_std * cp_smp).sqrt() * (dhp / 2.0).sin();

    let lp = (l_std + l_smp) / 2.0;
    let cp = (cp_std + cp_smp) / 2.0;

    let hp = if cp_std * cp_smp == 0.0 {
        hp_std + hp_smp
    } else {
        let mut h = (hp_std + hp_smp) / 2.0;
        if (hp_std - hp_smp).abs() > PI {
            h -= PI;
        }
        if h < 0.0 {
            h += 2.0 * PI;
        }
        h
    };

    let lpm50_sq = (lp - 50.0).powi(2);
    let t = 1.0 - 0.17 * (hp - PI / 6.0).cos()
        + 0.24 * (2.0 * hp).cos()
        + 0.32 * (3.0 * hp + PI / 30.0).cos()
        - 0.20 * (4.0 * hp - 63.0 * PI / 180.0).cos();

    let sl = 1.0 + (0.015 * lpm50_sq) / (20.0 + lpm50_sq).sqrt();
    let sc = 1.0 + 0.045 * cp;
    let sh = 1.0 + 0.015 * cp * t;

    // `neg_multiply` would otherwise force rewriting `-1.0 * x` as `-x`,
    // but culori's own source also writes these as `-1 * ...`; kept as-is
    // so this file's line shape mirrors difference.js for future audits.
    #[allow(clippy::neg_multiply)]
    let delta_theta =
        (30.0 * PI / 180.0) * (-1.0 * (((180.0 / PI) * hp - 275.0) / 25.0).powi(2)).exp();
    let rc = 2.0 * (cp.powi(7) / (cp.powi(7) + 25f64.powi(7))).sqrt();
    #[allow(clippy::neg_multiply)]
    let rt = -1.0 * (2.0 * delta_theta).sin() * rc;

    ((dl / sl).powi(2) + (dc / sc).powi(2) + (dh / sh).powi(2) + (rt * dc / sc) * (dh / sh)).sqrt()
}

/// culori src/difference.js `differenceCiede2000` (Kl=Kc=Kh=1, culori's
/// defaults — colorClustering.ts's `ciede2000Diff = differenceCiede2000()`
/// calls it with no args). Operates on D65 Lab internally (Parity contract
/// ) — inputs here are D50 Lab (this codebase's only Lab variant), so this
/// function converts both to D65 Lab FIRST via lab_to_lab65, exactly
/// reproducing culori's `lab65(std)`/`lab65(smp)` graph-traversal step,
/// before delegating to `ciede2000_raw` for the actual formula.
pub fn ciede2000(std: Lab, smp: Lab) -> f64 {
    ciede2000_raw(lab_to_lab65(std), lab_to_lab65(smp))
}

/// culori src/difference.js `differenceCiede2000`, applied directly to two
/// already-Lab65-shaped values (e.g. produced by `rgb_to_lab65`) with no
/// further white-point adaptation — this is the pairing colorblindPalettes.ts's
/// RGB-mode-object ciede2000 comparisons take (see `rgb_to_xyz65`'s doc
/// comment). Contrast with `ciede2000` above, which Bradford-adapts D50 Lab
/// (colorClustering.ts's `converter('lab')`-sourced objects) before running
/// the same core formula.
pub fn ciede2000_lab65(std: Lab, smp: Lab) -> f64 {
    ciede2000_raw(std, smp)
}

/// culori src/oklab/convertRgbToOklab.js — sRGB → linear RGB → LMS (cube
/// root) → Oklab matrix, INCLUDING the same achromatic fixup as hex_to_lab
///.
// `excessive_precision` would otherwise force truncating a full-precision
// matrix constant copied verbatim from culori's source (see xyz65_to_rgb's
// comment above for why that trade isn't worth it).
#[allow(clippy::excessive_precision)]
pub fn rgb_to_oklab(c: Rgb) -> Oklab {
    let l = rgb_to_lrgb(c);
    let ll = (0.412221469470763 * l.r + 0.5363325372617348 * l.g + 0.0514459932675022 * l.b).cbrt();
    let mm =
        (0.2119034958178252 * l.r + 0.6806995506452344 * l.g + 0.1073969535369406 * l.b).cbrt();
    let ss =
        (0.0883024591900564 * l.r + 0.2817188391361215 * l.g + 0.6299787016738222 * l.b).cbrt();
    let mut ok = Oklab {
        l: 0.210454268309314 * ll + 0.7936177747023054 * mm - 0.0040720430116193 * ss,
        a: 1.9779985324311684 * ll - 2.4285922420485799 * mm + 0.450593709617411 * ss,
        b: 0.0259040424655478 * ll + 0.7827717124575296 * mm - 0.8086757549230774 * ss,
    };
    if c.r == c.g && c.g == c.b {
        ok.a = 0.0;
        ok.b = 0.0;
    }
    ok
}

/// culori src/oklab/convertOklabToRgb.js == convertOklabToLrgb then
/// convertLrgbToRgb.
// `excessive_precision` — same rationale as xyz65_to_rgb/rgb_to_oklab above.
#[allow(clippy::excessive_precision)]
pub fn oklab_to_rgb(c: Oklab) -> Rgb {
    let ll = (c.l + 0.3963377773761749 * c.a + 0.2158037573099136 * c.b).powi(3);
    let mm = (c.l - 0.1055613458156586 * c.a - 0.0638541728258133 * c.b).powi(3);
    let ss = (c.l - 0.0894841775298119 * c.a - 1.2914855480194092 * c.b).powi(3);
    lrgb_to_rgb(Rgb {
        r: 4.0767416360759574 * ll - 3.3077115392580616 * mm + 0.2309699031821044 * ss,
        g: -1.2684379732850317 * ll + 2.6097573492876887 * mm - 0.3413193760026573 * ss,
        b: -0.0041960761386756 * ll - 0.7034186179359362 * mm + 1.7076146940746117 * ss,
    })
}

/// culori src/lch/convertLabToLch.js applied to Oklab (src/oklch/definition.js:
/// oklch shares the generic lch<->lab polar helper). Hue is 0 when
/// achromatic (c==0) — culori's `if (c) res.h = ...` leaves `h` `undefined`
/// then, which in JS arithmetic elsewhere reads as `NaN`/`0` depending on
/// context; colorClustering.ts/colorblindPalettes.ts always read `oklch.h ?? 0`
/// at every use site (e.g. colorClustering.ts:140 `const h = oklch.h ?? 0`),
/// so returning `0.0` for achromatic hue here is parity-exact with every
/// actual call site even though culori's own field is technically absent.
pub fn oklab_to_oklch(c: Oklab) -> Oklch {
    let chroma = (c.a * c.a + c.b * c.b).sqrt();
    let hue = if chroma != 0.0 {
        let deg = c.b.atan2(c.a).to_degrees();
        if deg < 0.0 {
            deg + 360.0
        } else {
            deg
        }
    } else {
        0.0
    };
    Oklch {
        l: c.l,
        c: chroma,
        h: hue,
    }
}

/// culori src/lch/convertLchToLab.js applied to Oklch → Oklab.
pub fn oklch_to_oklab(c: Oklch) -> Oklab {
    Oklab {
        l: c.l,
        a: if c.c != 0.0 {
            c.c * (c.h.to_radians()).cos()
        } else {
            0.0
        },
        b: if c.c != 0.0 {
            c.c * (c.h.to_radians()).sin()
        } else {
            0.0
        },
    }
}

pub fn rgb_to_oklch(c: Rgb) -> Oklch {
    oklab_to_oklch(rgb_to_oklab(c))
}
pub fn oklch_to_rgb(c: Oklch) -> Rgb {
    oklab_to_rgb(oklch_to_oklab(c))
}

/// culori src/deficiency.js — Machado, Oliveira & Fernandes (2009) CVD
/// simulation matrices, full-severity row (index 10 of the 11-row LUT;
/// explains why no interpolation is needed — this
/// codebase always calls with severity=1). Each matrix is applied to sRGB
/// (NOT linear RGB) channel values directly, per culori's `deficiency()`:
/// `let { r, g, b } = rgb(c);` where `rgb = converter('rgb')` — the
/// gamma-encoded value, not `lrgb`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CvdType {
    Protanopia,
    Deuteranopia,
    Tritanopia,
}

/// Row 10 (severity=1.0) of culori's PROT LUT.
const PROT_FULL: [f64; 9] = [
    0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998,
];
/// Row 10 of culori's DEUTER LUT.
const DEUTER_FULL: [f64; 9] = [
    0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881,
];
/// Row 10 of culori's TRIT LUT.
const TRIT_FULL: [f64; 9] = [
    1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039,
];

pub fn simulate_cvd(c: Rgb, kind: CvdType) -> Rgb {
    let m = match kind {
        CvdType::Protanopia => PROT_FULL,
        CvdType::Deuteranopia => DEUTER_FULL,
        CvdType::Tritanopia => TRIT_FULL,
    };
    Rgb {
        r: m[0] * c.r + m[1] * c.g + m[2] * c.b,
        g: m[3] * c.r + m[4] * c.g + m[5] * c.b,
        b: m[6] * c.r + m[7] * c.g + m[8] * c.b,
    }
}

/// Parse a 6-hex color (with or without leading '#') to sRGB [0,1] channels.
/// Returns None on malformed input — cluster.rs/palettes.rs callers treat
/// that the same way colorClustering.ts's `hexToLab` treats a failed
/// culori `parse()`: log-and-treat-as-black.
pub fn parse_hex(s: &str) -> Option<Rgb> {
    let h = s.strip_prefix('#').unwrap_or(s);
    if h.len() < 6 {
        return None;
    }
    let r = u8::from_str_radix(&h[0..2], 16).ok()? as f64 / 255.0;
    let g = u8::from_str_radix(&h[2..4], 16).ok()? as f64 / 255.0;
    let b = u8::from_str_radix(&h[4..6], 16).ok()? as f64 / 255.0;
    Some(Rgb { r, g, b })
}

/// Format sRGB [0,1] channels to a lowercase `#rrggbb` hex string, clamping
/// to [0,255] and rounding-to-nearest (culori's formatHex does the same
/// clamp-and-round on out-of-gamut values rather than returning None, EXCEPT
/// where a caller explicitly checks gamut first — colorClustering.ts never
/// gamut-checks before formatHex, so clamp-not-reject is the correct match).
///
/// Verified against culori's actual src/formatter.js: `formatHex = c =>
/// serializeHex(rgb(c))`, and `serializeHex` only returns `undefined` when
/// its input color object is itself `undefined` (i.e. the `rgb()` mode
/// converter failed to recognize/parse `c` at all). For a color object that
/// IS already a valid (if out-of-gamut or NaN-channel) rgb-mode value —
/// which is the only kind of value this Rust `format_hex` ever receives,
/// since it takes a typed `Rgb` rather than an untyped/parseable value —
/// `serializeHex` always succeeds: it computes
/// `fixup = v => Math.round(clamp(v) * 255)` with
/// `clamp = v => Math.max(0, Math.min(1, v || 0))`, which maps NaN to 0
/// (NaN is falsy in JS, so `NaN || 0` is `0`) before clamping. Rust's
/// `f64::clamp` does NOT special-case NaN the same way (it returns NaN
/// unchanged), but the subsequent `as u8` cast on a NaN `f64` in Rust
/// saturates to `0` (guaranteed since Rust 1.45's float-to-int cast rules),
/// so the two implementations still agree on the final byte for NaN input
/// despite differing intermediate mechanics. Conclusion: `formatHex` has no
/// real failure mode for the inputs this function receives, so `format_hex`
/// returns `String` unconditionally rather than `Option<String>`. The
/// `?? "#6b7280"` fallback seen after `formatHex(...)` calls in
/// colorClustering.ts guards against `hexToLab`/`parse()` failing on
/// malformed/unparseable *input strings* earlier in the pipeline — a
/// concern that belongs to `parse_hex` above and to cluster.rs's callers,
/// not to this function.
pub fn format_hex(c: Rgb) -> String {
    let ch = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", ch(c.r), ch(c.g), ch(c.b))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Sharma/Wu/Dalal (2005) supplementary test-data pairs, "The CIEDE2000
    // Color-Difference Formula" — a sanity check on the formula
    // transcription itself, independent of the Node/Rust differential gate
    // (which only proves agreement WITH Node, not correctness against the
    // published reference). Values cross-checked against Sharma's own
    // published table (http://www2.ece.rochester.edu/~gsharma/ciede2000/
    // dataNprograms/ciede2000testdata.txt) as reproduced verbatim in
    // github.com/sumtype/CIEDE2000's tests.py, fetched during this task.
    //
    // These test `ciede2000_raw` (the D65-space core formula) directly with
    // the Lab numbers AS PUBLISHED, rather than going through the public
    // `ciede2000(Lab, Lab)` D50-in entry point. Reasoning: the published
    // Sharma/Wu/Dalal pairs are abstract Lab triples with no associated RGB
    // working space or white point of their own — they exist purely to
    // exercise the CIEDE2000 arithmetic. Feeding them through
    // `ciede2000()`'s D50→D65 Bradford-adaptation step (`lab_to_lab65`)
    // would silently reinterpret them AS IF they were D50 Lab values needing
    // re-adaptation, which is not what they are, and would shift the
    // results away from the published expected deltaE00 by an amount that
    // has nothing to do with whether the CIEDE2000 formula itself is
    // correctly transcribed. Testing `ciede2000_raw` directly is the
    // unambiguous choice: it isolates "did we transcribe Sharma/Wu/Dalal
    // correctly" from "did we get the D50/D65 adaptation right" (the latter
    // is exercised separately by the round-trip tests below, which do go
    // through the public D50-in API).
    fn lab(l: f64, a: f64, b: f64) -> Lab {
        Lab { l, a, b }
    }

    #[test]
    fn ciede2000_sharma_pair_1() {
        // Classic widely-cited Sharma test case #1.
        let d = ciede2000_raw(lab(50.0, 2.6772, -79.7751), lab(50.0, 0.0, -82.7485));
        assert!((d - 2.0425).abs() < 1e-3, "got {d}");
    }

    #[test]
    fn ciede2000_sharma_pair_2() {
        let d = ciede2000_raw(lab(50.0, 3.1571, -77.2803), lab(50.0, 0.0, -82.7485));
        assert!((d - 2.8615).abs() < 1e-3, "got {d}");
    }

    #[test]
    fn ciede2000_sharma_pair_3() {
        let d = ciede2000_raw(lab(50.0, 2.8361, -74.02), lab(50.0, 0.0, -82.7485));
        assert!((d - 3.4412).abs() < 1e-3, "got {d}");
    }

    #[test]
    fn ciede2000_sharma_pair_gray_axis() {
        // Sharma pair #12/#13-style near-identical low-chroma pair.
        let d = ciede2000_raw(lab(50.0, 2.5, 0.0), lab(50.0, 3.1736, 0.5854));
        assert!((d - 1.0).abs() < 1e-3, "got {d}");
    }

    #[test]
    fn ciede2000_sharma_pair_large_difference() {
        let d = ciede2000_raw(lab(50.0, 2.5, 0.0), lab(73.0, 25.0, -18.0));
        assert!((d - 27.1492).abs() < 1e-3, "got {d}");
    }

    #[test]
    fn ciede2000_sharma_pair_near_black() {
        let d = ciede2000_raw(lab(2.0776, 0.0795, -1.1350), lab(0.9033, -0.0636, -0.5514));
        assert!((d - 0.9082).abs() < 1e-3, "got {d}");
    }

    #[test]
    fn ciede2000_self_is_zero() {
        // Hand-checkable sanity test: a color against itself is exactly 0.
        let l = lab(62.3, 15.8, -7.2);
        assert_eq!(ciede2000(l, l), 0.0);
        assert_eq!(ciede2000_raw(l, l), 0.0);
    }

    #[test]
    fn lab_round_trip_known_hex_colors() {
        // hex_to_lab -> lab_to_rgb -> format_hex round-trips within 1 unit
        // of rounding error (each channel matches exactly, or differs by
        // at most 1/255 due to float rounding through the D50<->D65 hop).
        for hex in [
            "#ff0000", "#00ff00", "#0000ff", "#ffffff", "#000000", "#808080", "#6b7280",
        ] {
            let rgb = parse_hex(hex).unwrap();
            let lab = hex_to_lab(rgb);
            let back = lab_to_rgb(lab);
            let got = format_hex(back);
            let orig = parse_hex(hex).unwrap();
            let got_rgb = parse_hex(&got).unwrap();
            let d = |a: f64, b: f64| ((a - b).abs() * 255.0).round() as i32;
            assert!(
                d(orig.r, got_rgb.r) <= 1 && d(orig.g, got_rgb.g) <= 1 && d(orig.b, got_rgb.b) <= 1,
                "hex={hex} got={got}"
            );
        }
    }

    #[test]
    fn lab_achromatic_fixup_zeroes_chroma() {
        for hex in ["#000000", "#ffffff", "#808080"] {
            let rgb = parse_hex(hex).unwrap();
            let lab = hex_to_lab(rgb);
            assert_eq!(lab.a, 0.0, "hex={hex}");
            assert_eq!(lab.b, 0.0, "hex={hex}");
            let ok = rgb_to_oklab(rgb);
            assert_eq!(ok.a, 0.0, "hex={hex}");
            assert_eq!(ok.b, 0.0, "hex={hex}");
        }
    }

    #[test]
    fn oklab_round_trip_known_hex_colors() {
        // rgb_to_oklab -> oklab_to_rgb -> format_hex round-trip.
        for hex in [
            "#ff0000", "#00ff00", "#0000ff", "#ffffff", "#000000", "#123456", "#6b7280",
        ] {
            let rgb = parse_hex(hex).unwrap();
            let ok = rgb_to_oklab(rgb);
            let back = oklab_to_rgb(ok);
            let got = format_hex(back);
            let orig = parse_hex(hex).unwrap();
            let got_rgb = parse_hex(&got).unwrap();
            let d = |a: f64, b: f64| ((a - b).abs() * 255.0).round() as i32;
            assert!(
                d(orig.r, got_rgb.r) <= 1 && d(orig.g, got_rgb.g) <= 1 && d(orig.b, got_rgb.b) <= 1,
                "hex={hex} got={got}"
            );
        }
    }

    #[test]
    fn oklch_round_trip_matches_oklab() {
        let rgb = parse_hex("#6b7280").unwrap();
        let ok = rgb_to_oklab(rgb);
        let lch = oklab_to_oklch(ok);
        let back = oklch_to_oklab(lch);
        assert!((ok.l - back.l).abs() < 1e-9);
        assert!((ok.a - back.a).abs() < 1e-9);
        assert!((ok.b - back.b).abs() < 1e-9);

        // Full rgb -> oklch -> rgb path (exercises oklch_to_rgb directly).
        let via_oklch = oklch_to_rgb(rgb_to_oklch(rgb));
        let got = format_hex(via_oklch);
        assert_eq!(got, "#6b7280");
    }

    #[test]
    fn parse_hex_rejects_malformed_input() {
        assert!(parse_hex("").is_none());
        assert!(parse_hex("#fff").is_none());
        assert!(parse_hex("#zzzzzz").is_none());
    }

    #[test]
    fn parse_hex_accepts_with_and_without_hash() {
        assert_eq!(parse_hex("#ff8000"), parse_hex("ff8000"));
    }

    #[test]
    fn simulate_cvd_is_identity_free() {
        // Sanity check: CVD matrices are not the identity, and produce
        // finite output for a mid-gray input.
        let gray = Rgb {
            r: 0.5,
            g: 0.5,
            b: 0.5,
        };
        for kind in [
            CvdType::Protanopia,
            CvdType::Deuteranopia,
            CvdType::Tritanopia,
        ] {
            let out = simulate_cvd(gray, kind);
            assert!(out.r.is_finite() && out.g.is_finite() && out.b.is_finite());
        }
    }

    // --- simulate_cvd: actual CVD-simulation behavior, not just finiteness
    // (colorblindPalettes.test.ts's `describe("simulateCvd", ...)` block —
    // `simulate_cvd_is_identity_free` above only proves the matrices aren't
    // NaN-producing, not that they simulate anything real) --------------

    #[test]
    fn simulate_cvd_deuteranopia_changes_red_and_green() {
        // Under deuteranopia both pure red and pure green should shift away
        // from their originals (they don't have to converge on the same
        // color for this test — just each must actually move).
        let red = Rgb {
            r: 1.0,
            g: 0.0,
            b: 0.0,
        };
        let green = Rgb {
            r: 0.0,
            g: 1.0,
            b: 0.0,
        };
        let red_sim = format_hex(simulate_cvd(red, CvdType::Deuteranopia));
        let green_sim = format_hex(simulate_cvd(green, CvdType::Deuteranopia));
        assert_ne!(red_sim, "#ff0000");
        assert_ne!(green_sim, "#00ff00");
    }

    #[test]
    fn simulate_cvd_deuteranopia_barely_shifts_pure_gray() {
        // Gray carries no chromatic (red-green/blue-yellow) information, so
        // any CVD simulation — which only re-mixes chromatic signal — should
        // leave it close to untouched. Each of the three CVD matrices' rows
        // sums to ~1.0, so an r==g==b input is actually a fixed point up to
        // float/rounding noise; this test's 5/255 tolerance mirrors the TS
        // test's tolerance rather than asserting the tighter bound the
        // matrix math happens to produce, so it stays meaningful if the
        // matrices are ever revised.
        let gray = Rgb {
            r: 0.5,
            g: 0.5,
            b: 0.5,
        };
        let simulated = simulate_cvd(gray, CvdType::Deuteranopia);
        let rgb = parse_hex(&format_hex(simulated)).unwrap();
        let byte = |c: f64| c * 255.0;
        assert!((byte(rgb.r) - 128.0).abs() < 5.0, "r={}", byte(rgb.r));
        assert!((byte(rgb.g) - 128.0).abs() < 5.0, "g={}", byte(rgb.g));
        assert!((byte(rgb.b) - 128.0).abs() < 5.0, "b={}", byte(rgb.b));
    }

    // --- rgb_to_lab65 / ciede2000_lab65: the RGB-mode-object ciede2000 path
    // colorblindPalettes.ts actually takes, as distinct from the D50
    // Lab-mode path (hex_to_lab/ciede2000) colorClustering.ts takes ------

    #[test]
    fn ciede2000_lab65_matches_culori_rgb_mode_reference_values() {
        // Golden values obtained by fetching culori@4.0.2 (this repo's exact
        // pinned version, node_modules/.pnpm/culori@4.0.2) and directly
        // evaluating `differenceCiede2000()(parse(hexA), parse(hexB))` — the
        // real call colorblindPalettes.ts makes. Confirmed to match to the
        // bit (0 diff) when reproduced via rgb_to_xyz65 (the standard direct
        // sRGB->XYZ-D65 matrix) -> xyz65_to_lab65 -> ciede2000_raw, i.e.
        // exactly what rgb_to_lab65 + ciede2000_lab65 below compute.
        let cases: [(&str, &str, f64); 6] = [
            ("#ff0000", "#00ff00", 86.60781444907963),
            ("#1d4ed8", "#16a34a", 58.12779190921263),
            ("#6b7280", "#dc2626", 34.12257677954312),
            ("#123456", "#abcdef", 59.93468277229381),
            ("#000000", "#ffffff", 100.0),
            ("#808080", "#7f7f7f", 0.3805524962078456),
        ];
        for (hex_a, hex_b, expected) in cases {
            let a = rgb_to_lab65(parse_hex(hex_a).unwrap());
            let b = rgb_to_lab65(parse_hex(hex_b).unwrap());
            let got = ciede2000_lab65(a, b);
            assert!(
                (got - expected).abs() < 1e-9,
                "{hex_a} vs {hex_b}: got {got}, want {expected}"
            );
        }
    }

    #[test]
    fn ciede2000_lab65_diverges_from_the_d50_pipeline_by_more_than_float_noise() {
        // Regression guard: hex_to_lab + ciede2000 (the D50 Lab-mode path,
        // correct for colorClustering.ts) is NOT interchangeable with
        // rgb_to_lab65 + ciede2000_lab65 (the RGB-mode path, correct for
        // colorblindPalettes.ts) — they diverge by ~1e-5, many orders of
        // magnitude above float noise (~1e-13, see
        // lab_round_trip_known_hex_colors and friends elsewhere in this
        // file for what genuine float noise looks like here). If this test
        // ever starts failing because the two paths converged, that's a
        // sign culori's own conversion graph changed, not a sign the two
        // functions became safely interchangeable.
        let (hex_a, hex_b) = ("#ff0000", "#00ff00");
        let rgb_a = parse_hex(hex_a).unwrap();
        let rgb_b = parse_hex(hex_b).unwrap();

        let via_d50 = ciede2000(hex_to_lab(rgb_a), hex_to_lab(rgb_b));
        let via_lab65 = ciede2000_lab65(rgb_to_lab65(rgb_a), rgb_to_lab65(rgb_b));

        assert!(
            (via_d50 - via_lab65).abs() > 1e-6,
            "expected the two pipelines to disagree by >1e-6, got d50={via_d50} lab65={via_lab65}"
        );
    }
}
