//! Turn a `WalkPath` into walking directions.
//!
//! 1. Group consecutive segments into runs by attr.
//! 2. Give off-network links (attr `None`) to the neighbouring run.
//! 3. Fold runs shorter than `MIN_RUN_M` into the previous one, except
//!    crossings and stairs, which a pedestrian must be told about however short.
//! 4. Collapse noise (`collapse`): an ordinary run that continues the same
//!    name (Street and Path alike, unnamed included) with a minor turn, and a
//!    short ordinary run the path keeps its heading across.
//! 5. Split ordinary runs at junctions inside them where the path really
//!    turns (`split_at_junctions`): one street or footway can bend at a
//!    junction where other ways go straight on.
//! 6. Emit Depart, then one step per remaining run, then Arrive. Turn labels
//!    come from `BEARING_WINDOW_M` headings either side of the turn point,
//!    never from a single OSM segment.
//!
//! A crossing or stairs step carries a turn when the path turns onto it by
//! `JUNCTION_TURN_DEG` or more.
//!
//! A Straight step right after a crossing or stairs is kept even on the same
//! name: the guidance card shows one step at a time, and that step says
//! which way to carry on at the far side.

use crate::format::{attr_class, attr_name, pack_attr, WayClass};
use crate::geo::{bearing_deg, dist, Projection, Xy};
use crate::route::WalkPath;

pub const MIN_RUN_M: f64 = 8.0;
/// Turn angles compare the path's heading over this many metres before the
/// turn point with its heading over this many metres after it, so a short
/// OSM segment at a junction cannot set the label.
pub const BEARING_WINDOW_M: f64 = 12.0;
/// Ordinary runs shorter than this between two others fold away when the
/// path keeps its heading across them.
pub const SHORT_RUN_M: f64 = 15.0;
/// A junction inside a run can be a turn when the path turns at least this
/// much there over `BEARING_WINDOW_M`, and a cluster of them is one when
/// its net turn is at least this much.
pub const JUNCTION_TURN_DEG: f64 = 45.0;
/// Junction turns at most this far apart along the path are judged
/// together, by their net turn.
pub const CLUSTER_M: f64 = 15.0;
/// The longer window that confirms the split point of a cluster: its turn
/// over this many metres either side must also reach `JUNCTION_TURN_DEG`,
/// the same way round as the net turn. It drops a lone sharp kink that
/// the path soon straightens out of.
pub const CONFIRM_WINDOW_M: f64 = 25.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepKind {
    Depart,
    Turn,
    Cross,
    Stairs,
    Arrive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Turn {
    Straight,
    SlightLeft,
    SlightRight,
    Left,
    Right,
    SharpLeft,
    SharpRight,
    UTurn,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub kind: StepKind,
    pub turn: Option<Turn>,
    pub name_id: u32,
    pub distance_m: f64,
    /// Index into `WalkPath::points` where this step begins.
    pub start_index: usize,
}

impl StepKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Depart => "depart",
            Self::Turn => "turn",
            Self::Cross => "cross",
            Self::Stairs => "stairs",
            Self::Arrive => "arrive",
        }
    }
}

impl Turn {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Straight => "straight",
            Self::SlightLeft => "slight-left",
            Self::SlightRight => "slight-right",
            Self::Left => "left",
            Self::Right => "right",
            Self::SharpLeft => "sharp-left",
            Self::SharpRight => "sharp-right",
            Self::UTurn => "u-turn",
        }
    }
}

/// Turns at least this sharp are a U-turn.
const UTURN_DEG: f64 = 170.0;

/// `delta` = outgoing − incoming bearing, normalised to [−180, 180);
/// positive is to the right.
pub fn classify_turn(delta: f64) -> Turn {
    let a = delta.abs();
    let right = delta > 0.0;
    match a {
        a if a < 20.0 => Turn::Straight,
        a if a < 60.0 => {
            if right {
                Turn::SlightRight
            } else {
                Turn::SlightLeft
            }
        }
        a if a < 120.0 => {
            if right {
                Turn::Right
            } else {
                Turn::Left
            }
        }
        a if a < UTURN_DEG => {
            if right {
                Turn::SharpRight
            } else {
                Turn::SharpLeft
            }
        }
        _ => Turn::UTurn,
    }
}

#[derive(Debug, Clone, Copy)]
struct Run {
    attr: Option<u32>,
    first: usize,
    last: usize,
    len: f64,
    /// The turn into this run when it was already measured (a split at a
    /// junction cluster, or a cluster skipped just before this run);
    /// otherwise `Geom::turn_into` gives it.
    turn: Option<f64>,
}

fn special(attr: Option<u32>) -> bool {
    attr.is_some_and(|a| matches!(attr_class(a), WayClass::Crossing | WayClass::Steps))
}

fn name(r: &Run) -> u32 {
    r.attr.map_or(0, attr_name)
}

/// Turns at most this sharp (Straight and Slight) are not worth a step on
/// their own: along the same name, or around a short kink.
const MINOR_TURN_DEG: f64 = 60.0;

/// The path in local metres, with the distance from the start to each point,
/// so a bearing can be taken between any two distances along it.
struct Geom {
    xy: Vec<Xy>,
    /// `cum[i]` = metres from the start to `points[i]`, summed from `seg_len`.
    cum: Vec<f64>,
}

impl Geom {
    fn new(p: &WalkPath) -> Self {
        let proj = Projection::new(p.points[0].0);
        let xy = p
            .points
            .iter()
            .map(|&(la, lo)| proj.project(la, lo))
            .collect();
        let mut cum = Vec::with_capacity(p.points.len());
        cum.push(0.0);
        for &l in &p.seg_len {
            cum.push(cum[cum.len() - 1] + l);
        }
        Self { xy, cum }
    }

    /// The point `d` metres along the path, clamped to its ends.
    fn at(&self, d: f64) -> Xy {
        let last = self.cum.len() - 1;
        if last == 0 {
            return self.xy[0];
        }
        let d = d.clamp(0.0, self.cum[last]);
        // First point at or beyond `d`; the segment ends there.
        let j = self.cum.partition_point(|&c| c < d).clamp(1, last);
        let (c0, c1) = (self.cum[j - 1], self.cum[j]);
        let t = if c1 > c0 { (d - c0) / (c1 - c0) } else { 1.0 };
        let (a, b) = (self.xy[j - 1], self.xy[j]);
        (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
    }

    /// Bearing between two distances along the path; `None` when the chord
    /// is too short to have one.
    fn bearing(&self, from: f64, to: f64) -> Option<f64> {
        let (a, b) = (self.at(from), self.at(to));
        (dist(a, b) > 1e-3).then(|| bearing_deg(a, b))
    }

    /// Turn from the path's heading over the `BEARING_WINDOW_M` before
    /// `turn_in` to its heading over the window after `turn_out`, the
    /// latter cut at `ahead_limit`. Positive is to the right; 0 when either
    /// heading is undefined.
    fn turn(&self, turn_in: f64, turn_out: f64, ahead_limit: f64) -> f64 {
        self.turn_over(BEARING_WINDOW_M, turn_in, turn_out, ahead_limit)
    }

    /// `turn` with windows of `w` metres.
    fn turn_over(&self, w: f64, turn_in: f64, turn_out: f64, ahead_limit: f64) -> f64 {
        let incoming = self.bearing(turn_in - w, turn_in);
        let outgoing = self.bearing(turn_out, (turn_out + w).min(ahead_limit));
        match (incoming, outgoing) {
            (Some(i), Some(o)) => (o - i + 540.0).rem_euclid(360.0) - 180.0,
            _ => 0.0,
        }
    }

    fn start(&self, r: &Run) -> f64 {
        self.cum[r.first]
    }

    fn end(&self, r: &Run) -> f64 {
        self.cum[r.last + 1]
    }

    /// The turn where `r` begins, looking along `r` only.
    fn turn_into(&self, r: &Run) -> f64 {
        self.turn(self.start(r), self.start(r), self.end(r))
    }
}

fn merge_equal(runs: Vec<Run>) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::with_capacity(runs.len());
    for r in runs {
        match out.last_mut() {
            Some(last) if last.attr == r.attr => {
                last.last = r.last;
                last.len += r.len;
            }
            _ => out.push(r),
        }
    }
    out
}

/// Merge runs that would only produce noise, until nothing changes:
/// - an ordinary run continuing an ordinary run of the same name (named or
///   both unnamed, Street or Path) with a minor turn between them;
/// - an ordinary run shorter than `SHORT_RUN_M` between two runs, when the
///   heading before it and the heading after it differ by a minor turn (a
///   dog-leg). It goes to the previous run, or to the next one when the
///   previous run is a crossing or stairs.
///
/// Crossings and stairs never merge, however short.
fn collapse(g: &Geom, mut runs: Vec<Run>) -> Vec<Run> {
    loop {
        let mut changed = false;
        let mut i = 1;
        while i < runs.len() {
            let (prev, r) = (runs[i - 1], runs[i]);
            let ordinary = !special(prev.attr) && !special(r.attr);
            if ordinary && name(&prev) == name(&r) && g.turn_into(&r).abs() < MINOR_TURN_DEG {
                runs[i - 1].last = r.last;
                runs[i - 1].len += r.len;
                runs.remove(i);
                changed = true;
                continue;
            }
            if i + 1 < runs.len() && !special(r.attr) && r.len < SHORT_RUN_M {
                let next = runs[i + 1];
                let net = g.turn(g.start(&r), g.end(&r), g.end(&next));
                if net.abs() < MINOR_TURN_DEG {
                    if !special(prev.attr) {
                        runs[i - 1].last = r.last;
                        runs[i - 1].len += r.len;
                        runs.remove(i);
                        changed = true;
                        continue;
                    }
                    if !special(next.attr) {
                        runs[i + 1].first = r.first;
                        runs[i + 1].len += r.len;
                        runs.remove(i);
                        changed = true;
                        continue;
                    }
                }
            }
            i += 1;
        }
        if !changed {
            return runs;
        }
    }
}

/// Split each ordinary run where the path turns at junctions inside it.
///
/// Candidates are interior points with 3 or more choices whose
/// `BEARING_WINDOW_M` turn is at least `JUNCTION_TURN_DEG`. Candidates at
/// most `CLUSTER_M` apart form one cluster, judged by its net turn: the
/// heading over the window before its first point against the heading over
/// the window after its last. A cluster whose net turn is under
/// `JUNCTION_TURN_DEG` is a jog (a sidewalk offset, a dog-leg across a
/// crossing) and says nothing. Otherwise the run splits once, at the
/// cluster point turning hardest the same way as the net turn (else its
/// first point), labelled by the net turn, when that point's
/// `CONFIRM_WINDOW_M` turn agrees. A split closer than `SHORT_RUN_M` to the
/// run start, to the previous split or to the run end is skipped, so no stub
/// step appears. When one is skipped near the run end, the next run's turn
/// is measured from the heading before the cluster instead, so its step can
/// say that turn. The pieces keep the run's attr and are not merged again.
fn split_at_junctions(g: &Geom, p: &WalkPath, runs: Vec<Run>) -> Vec<Run> {
    let choices: &[u8] = if p.choices.len() == p.points.len() {
        &p.choices
    } else {
        &[]
    };
    let mut out = Vec::with_capacity(runs.len());
    // Start of a cluster skipped just before the end of the previous run.
    let mut carry: Option<f64> = None;
    for mut r in runs {
        if let Some(from) = carry.take() {
            if r.turn.is_none() {
                let mut t = g.turn(from, g.start(&r), g.end(&r));
                // Two turns a few metres apart can add up past a U-turn;
                // that is a hairpin around a corner, not turning back on
                // the spot.
                if t.abs() >= UTURN_DEG && g.turn_into(&r).abs() < UTURN_DEG {
                    t = (UTURN_DEG - 1.0).copysign(t);
                }
                r.turn = Some(t);
            }
        }
        if special(r.attr) {
            out.push(r);
            continue;
        }
        let end = g.end(&r);
        // (point, own turn) of each candidate, in path order.
        let cands: Vec<(usize, f64)> = (r.first + 1..=r.last)
            .filter(|&k| choices.get(k).copied().unwrap_or(0) >= 3)
            .map(|k| (k, g.turn(g.cum[k], g.cum[k], end)))
            .filter(|&(_, t)| t.abs() >= JUNCTION_TURN_DEG)
            .collect();
        let mut piece = r;
        let mut i = 0;
        while i < cands.len() {
            let mut j = i + 1;
            while j < cands.len() && g.cum[cands[j].0] - g.cum[cands[j - 1].0] <= CLUSTER_M {
                j += 1;
            }
            let cluster = &cands[i..j];
            i = j;
            let (first, last) = (cluster[0].0, cluster[cluster.len() - 1].0);
            let net = g.turn(g.cum[first], g.cum[last], end);
            if net.abs() < JUNCTION_TURN_DEG {
                continue;
            }
            let k = cluster
                .iter()
                .filter(|&&(_, t)| (t > 0.0) == (net > 0.0))
                .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
                .map_or(first, |&(k, _)| k);
            if g.cum[k] - g.cum[piece.first] < SHORT_RUN_M {
                continue;
            }
            if end - g.cum[k] < SHORT_RUN_M {
                carry = Some(g.cum[first]);
                continue;
            }
            let long = g.turn_over(CONFIRM_WINDOW_M, g.cum[k], g.cum[k], end);
            if long.abs() < JUNCTION_TURN_DEG || (long > 0.0) != (net > 0.0) {
                continue;
            }
            out.push(Run {
                last: k - 1,
                len: p.seg_len[piece.first..k].iter().sum(),
                ..piece
            });
            piece.first = k;
            piece.turn = Some(net);
        }
        if piece.first != r.first {
            piece.len = p.seg_len[piece.first..=piece.last].iter().sum();
        }
        out.push(piece);
    }
    out
}

/// Which way to turn onto a crossing or stairs: only when the path turns
/// by `JUNCTION_TURN_DEG` or more into it; carrying straight on says nothing.
fn special_turn(g: &Geom, r: &Run) -> Option<Turn> {
    let t = r.turn.unwrap_or_else(|| g.turn_into(r));
    (t.abs() >= JUNCTION_TURN_DEG).then(|| classify_turn(t))
}

/// Walking directions for `p`: Depart, one step per run, Arrive. The step
/// distances sum to `p.distance_m`.
///
/// Reads `p.choices` to find junctions inside a run; when its length does
/// not match `p.points` (a hand-built path), every point counts as 0.
///
/// An empty path (no points) has no directions and returns `[]`; a
/// one-point path is Depart 0 m + Arrive. `WalkIndex::route` always returns
/// at least the two query endpoints, so neither happens for routed paths.
pub fn steps(p: &WalkPath) -> Vec<Step> {
    if p.points.is_empty() {
        return Vec::new();
    }
    let mut runs: Vec<Run> = merge_equal(
        p.segments
            .iter()
            .enumerate()
            .map(|(i, &attr)| Run {
                attr,
                first: i,
                last: i,
                len: p.seg_len[i],
                turn: None,
            })
            .collect(),
    );

    // Off-network links take the attr of the next real run, else the previous.
    let fallback = pack_attr(0, WayClass::Path);
    for i in 0..runs.len() {
        if runs[i].attr.is_none() {
            let next = runs[i + 1..].iter().find_map(|r| r.attr);
            let prev = runs[..i].iter().rev().find_map(|r| r.attr);
            runs[i].attr = Some(next.or(prev).unwrap_or(fallback));
        }
    }
    let runs = merge_equal(runs);

    // Fold short ordinary runs into the previous run.
    let mut folded: Vec<Run> = Vec::with_capacity(runs.len());
    for r in runs {
        match folded.last_mut() {
            Some(last) if last.attr == r.attr || (r.len < MIN_RUN_M && !special(r.attr)) => {
                last.last = r.last;
                last.len += r.len;
            }
            _ => folded.push(r),
        }
    }
    // A short ordinary first run folds forward instead.
    if folded.len() > 1 && folded[0].len < MIN_RUN_M && !special(folded[0].attr) {
        let first = folded.remove(0);
        folded[0].first = first.first;
        folded[0].len += first.len;
    }

    let g = Geom::new(p);
    let folded = split_at_junctions(&g, p, collapse(&g, folded));

    let mut out = Vec::with_capacity(folded.len() + 2);
    if folded.is_empty() {
        out.push(Step {
            kind: StepKind::Depart,
            turn: None,
            name_id: 0,
            distance_m: 0.0,
            start_index: 0,
        });
    }
    for (i, r) in folded.iter().enumerate() {
        let attr = r.attr.unwrap_or(fallback);
        let (kind, turn) = if i == 0 {
            (StepKind::Depart, None)
        } else {
            match attr_class(attr) {
                WayClass::Crossing => (StepKind::Cross, special_turn(&g, r)),
                WayClass::Steps => (StepKind::Stairs, special_turn(&g, r)),
                _ => {
                    let t = r.turn.unwrap_or_else(|| g.turn_into(r));
                    (StepKind::Turn, Some(classify_turn(t)))
                }
            }
        };
        out.push(Step {
            kind,
            turn,
            name_id: attr_name(attr),
            distance_m: r.len,
            start_index: r.first,
        });
    }
    out.push(Step {
        kind: StepKind::Arrive,
        turn: None,
        name_id: 0,
        distance_m: 0.0,
        start_index: p.points.len() - 1,
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geo::{dist, Projection};
    use crate::testutil::{ll, LAT0};

    fn path(points_m: &[(f64, f64)], segments: &[Option<u32>]) -> WalkPath {
        with_choices(points_m, segments, &vec![0; points_m.len()])
    }

    fn with_choices(points_m: &[(f64, f64)], segments: &[Option<u32>], choices: &[u8]) -> WalkPath {
        let proj = Projection::new(LAT0);
        let points: Vec<(f64, f64)> = points_m.iter().map(|&(x, y)| ll(x, y)).collect();
        let xy: Vec<_> = points
            .iter()
            .map(|&(la, lo)| proj.project(la, lo))
            .collect();
        let seg_len: Vec<f64> = xy.windows(2).map(|w| dist(w[0], w[1])).collect();
        WalkPath {
            distance_m: seg_len.iter().sum(),
            points,
            segments: segments.to_vec(),
            seg_len,
            choices: choices.to_vec(),
        }
    }

    const A: u32 = 1 << 8; // name 1, Street
    const B: u32 = 2 << 8; // name 2, Street
    const C: u32 = 3 << 8; // name 3, Street

    fn kinds(s: &[Step]) -> Vec<StepKind> {
        s.iter().map(|s| s.kind).collect()
    }

    #[test]
    fn classifies_turn_angles() {
        assert_eq!(classify_turn(10.0), Turn::Straight);
        assert_eq!(classify_turn(-19.0), Turn::Straight);
        assert_eq!(classify_turn(30.0), Turn::SlightRight);
        assert_eq!(classify_turn(-30.0), Turn::SlightLeft);
        assert_eq!(classify_turn(90.0), Turn::Right);
        assert_eq!(classify_turn(-90.0), Turn::Left);
        assert_eq!(classify_turn(-150.0), Turn::SharpLeft);
        assert_eq!(classify_turn(150.0), Turn::SharpRight);
        assert_eq!(classify_turn(175.0), Turn::UTurn);
        assert_eq!(classify_turn(-175.0), Turn::UTurn);
    }

    #[test]
    fn left_turn_with_links_absorbed() {
        let p = path(
            &[
                (0.0, -5.0),
                (0.0, 0.0),
                (100.0, 0.0),
                (100.0, 100.0),
                (105.0, 100.0),
            ],
            &[None, Some(A), Some(B), None],
        );
        let s = steps(&p);
        assert_eq!(
            kinds(&s),
            vec![StepKind::Depart, StepKind::Turn, StepKind::Arrive]
        );
        assert_eq!((s[0].name_id, s[0].start_index), (1, 0));
        assert!((s[0].distance_m - 105.0).abs() < 0.1);
        assert_eq!(
            (s[1].turn, s[1].name_id, s[1].start_index),
            (Some(Turn::Left), 2, 2)
        );
        assert!((s[1].distance_m - 105.0).abs() < 0.1);
        assert_eq!((s[2].start_index, s[2].distance_m), (4, 0.0));
    }

    #[test]
    fn short_runs_fold_into_the_previous_one() {
        let p = path(
            &[(0.0, 0.0), (100.0, 0.0), (105.0, 0.0), (105.0, 100.0)],
            &[Some(A), Some(C), Some(B)],
        );
        let s = steps(&p);
        assert_eq!(
            kinds(&s),
            vec![StepKind::Depart, StepKind::Turn, StepKind::Arrive]
        );
        assert!((s[0].distance_m - 105.0).abs() < 0.1);
        assert_eq!((s[1].turn, s[1].name_id), (Some(Turn::Left), 2));
    }

    #[test]
    fn crossings_survive_even_when_short() {
        let path_attr = pack_attr(0, WayClass::Path);
        let cross = pack_attr(0, WayClass::Crossing);
        let p = path(
            &[(0.0, 0.0), (50.0, 0.0), (56.0, 0.0), (100.0, 0.0)],
            &[Some(path_attr), Some(cross), Some(path_attr)],
        );
        let s = steps(&p);
        assert_eq!(
            kinds(&s),
            vec![
                StepKind::Depart,
                StepKind::Cross,
                StepKind::Turn,
                StepKind::Arrive
            ]
        );
        assert_eq!(s[1].start_index, 1);
        assert!((s[1].distance_m - 6.0).abs() < 0.1);
        assert_eq!(s[2].turn, Some(Turn::Straight));
    }

    #[test]
    fn stairs_are_their_own_step() {
        let stairs = pack_attr(0, WayClass::Steps);
        let p = path(
            &[(0.0, 0.0), (50.0, 0.0), (50.0, 30.0)],
            &[Some(A), Some(stairs)],
        );
        let s = steps(&p);
        assert_eq!(
            kinds(&s),
            vec![StepKind::Depart, StepKind::Stairs, StepKind::Arrive]
        );
        // East along A, then north up the stairs.
        assert_eq!(s[1].turn, Some(Turn::Left));
    }

    #[test]
    fn straight_walk_is_depart_then_arrive() {
        let p = path(&[(0.0, 0.0), (10.0, 0.0)], &[None]);
        let s = steps(&p);
        assert_eq!(kinds(&s), vec![StepKind::Depart, StepKind::Arrive]);
        assert_eq!(s[0].name_id, 0);
        assert!((s[0].distance_m - 10.0).abs() < 0.1);
    }

    #[test]
    fn a_short_jog_at_the_junction_does_not_set_the_turn() {
        // East along A, then B leaves with a 1.4 m jog before heading north.
        let p = path(
            &[(0.0, 0.0), (100.0, 0.0), (101.0, 1.0), (101.0, 100.0)],
            &[Some(A), Some(B), Some(B)],
        );
        let s = steps(&p);
        assert_eq!(
            kinds(&s),
            vec![StepKind::Depart, StepKind::Turn, StepKind::Arrive]
        );
        assert_eq!((s[1].turn, s[1].name_id), (Some(Turn::Left), 2));
    }

    #[test]
    fn unnamed_path_onto_unnamed_street_is_one_step() {
        let p = path(
            &[(0.0, 0.0), (50.0, 0.0), (100.0, 2.0)],
            &[
                Some(pack_attr(0, WayClass::Path)),
                Some(pack_attr(0, WayClass::Street)),
            ],
        );
        let s = steps(&p);
        assert_eq!(kinds(&s), vec![StepKind::Depart, StepKind::Arrive]);
        assert!((s[0].distance_m - p.distance_m).abs() < 1e-9);
    }

    #[test]
    fn straight_on_along_the_same_name_is_not_a_step() {
        let p = path(
            &[(0.0, 0.0), (50.0, 0.0), (100.0, 3.0)],
            &[Some(A), Some(pack_attr(1, WayClass::Path))],
        );
        let s = steps(&p);
        assert_eq!(kinds(&s), vec![StepKind::Depart, StepKind::Arrive]);
        assert_eq!(s[0].name_id, 1);
    }

    #[test]
    fn a_real_turn_between_unnamed_ways_is_kept() {
        let p = path(
            &[(0.0, 0.0), (50.0, 0.0), (50.0, 50.0)],
            &[
                Some(pack_attr(0, WayClass::Path)),
                Some(pack_attr(0, WayClass::Street)),
            ],
        );
        let s = steps(&p);
        assert_eq!(
            kinds(&s),
            vec![StepKind::Depart, StepKind::Turn, StepKind::Arrive]
        );
        assert_eq!(s[1].turn, Some(Turn::Left));
    }

    #[test]
    fn a_short_dog_leg_folds_away() {
        // A, a 9.9 m kink on C, then A again on the same heading.
        let p = path(
            &[(0.0, 0.0), (100.0, 0.0), (107.0, 7.0), (200.0, 7.0)],
            &[Some(A), Some(C), Some(A)],
        );
        let s = steps(&p);
        assert_eq!(kinds(&s), vec![StepKind::Depart, StepKind::Arrive]);
        assert!((s[0].distance_m - p.distance_m).abs() < 1e-9);
    }

    #[test]
    fn a_short_run_with_a_real_turn_survives() {
        // 12 m on C is short, but A → B is a left turn, so C stays a step.
        let p = path(
            &[(0.0, 0.0), (100.0, 0.0), (100.0, 12.0), (0.0, 12.0)],
            &[Some(A), Some(C), Some(B)],
        );
        let s = steps(&p);
        assert_eq!(
            kinds(&s),
            vec![
                StepKind::Depart,
                StepKind::Turn,
                StepKind::Turn,
                StepKind::Arrive
            ]
        );
        assert_eq!(s[1].name_id, 3);
    }

    #[test]
    fn a_three_metre_crossing_is_kept() {
        let path_attr = pack_attr(0, WayClass::Path);
        let cross = pack_attr(0, WayClass::Crossing);
        let p = path(
            &[(0.0, 0.0), (50.0, 0.0), (53.0, 0.0), (100.0, 0.0)],
            &[Some(path_attr), Some(cross), Some(path_attr)],
        );
        let s = steps(&p);
        assert_eq!(
            kinds(&s),
            vec![
                StepKind::Depart,
                StepKind::Cross,
                StepKind::Turn,
                StepKind::Arrive
            ]
        );
        assert!((s[1].distance_m - 3.0).abs() < 0.1);
    }

    #[test]
    fn empty_and_single_point_paths() {
        let empty = WalkPath {
            points: vec![],
            segments: vec![],
            seg_len: vec![],
            distance_m: 0.0,
            choices: vec![],
        };
        assert!(steps(&empty).is_empty());
        let one = WalkPath {
            points: vec![ll(0.0, 0.0)],
            segments: vec![],
            seg_len: vec![],
            distance_m: 0.0,
            choices: vec![],
        };
        let s = steps(&one);
        assert_eq!(kinds(&s), vec![StepKind::Depart, StepKind::Arrive]);
        assert_eq!((s[0].start_index, s[1].start_index), (0, 0));
    }

    #[test]
    fn a_turn_at_a_junction_inside_one_run_is_announced() {
        let p = with_choices(
            &[(0.0, 0.0), (100.0, 0.0), (100.0, 100.0)],
            &[Some(A), Some(A)],
            &[0, 3, 0],
        );
        let s = steps(&p);
        assert_eq!(
            kinds(&s),
            vec![StepKind::Depart, StepKind::Turn, StepKind::Arrive]
        );
        assert_eq!(
            (s[1].turn, s[1].name_id, s[1].start_index),
            (Some(Turn::Left), 1, 1)
        );
        assert!((s[0].distance_m - 100.0).abs() < 0.1);
        assert!((s[1].distance_m - 100.0).abs() < 0.1);
    }

    #[test]
    fn a_bend_with_nothing_to_choose_is_not_a_step() {
        let p = with_choices(
            &[(0.0, 0.0), (100.0, 0.0), (100.0, 100.0)],
            &[Some(A), Some(A)],
            &[0, 2, 0],
        );
        assert_eq!(kinds(&steps(&p)), vec![StepKind::Depart, StepKind::Arrive]);
    }

    #[test]
    fn a_sidewalk_jog_at_junctions_is_not_a_turn() {
        // East, 8 m south, east again: each corner turns about 63° over
        // 12 m, but only about 25° over 25 m, so neither is a real turn.
        let p = with_choices(
            &[(0.0, 0.0), (100.0, 0.0), (100.0, -8.0), (200.0, -8.0)],
            &[Some(A), Some(A), Some(A)],
            &[0, 3, 3, 0],
        );
        assert_eq!(kinds(&steps(&p)), vec![StepKind::Depart, StepKind::Arrive]);
    }

    // Two jogs on one unnamed footway in Vilnius (points in metres, from a
    // real route): the path turns hard at two junctions a few metres apart
    // but carries on almost as before.

    #[test]
    fn a_real_jog_turning_back_7_m_later_is_not_a_step() {
        // −88° then +120° 7 m later; net about +30°.
        let p = with_choices(
            &[
                (-20.3, -17.8),
                (-45.3, -53.5),
                (-57.9, -61.8),
                (-54.1, -68.0),
                (-68.0, -68.3),
                (-99.3, -70.1),
                (-104.7, -66.8),
            ],
            &[Some(A); 6],
            &[0, 0, 3, 3, 0, 0, 0],
        );
        assert_eq!(kinds(&steps(&p)), vec![StepKind::Depart, StepKind::Arrive]);
    }

    #[test]
    fn a_real_jog_back_to_the_same_heading_is_not_a_step() {
        // −89° then +97° 13.5 m later, back within about 10° of the heading.
        let p = with_choices(
            &[
                (-846.1, -194.2),
                (-863.5, -207.0),
                (-872.7, -209.1),
                (-887.8, -210.6),
                (-886.8, -224.0),
                (-892.5, -223.7),
                (-895.8, -223.6),
                (-909.3, -223.3),
                (-924.9, -223.4),
            ],
            &[Some(A); 8],
            &[0, 3, 0, 4, 3, 3, 0, 0, 0],
        );
        assert_eq!(kinds(&steps(&p)), vec![StepKind::Depart, StepKind::Arrive]);
    }

    #[test]
    fn a_turn_spread_over_a_junction_cluster_is_one_step() {
        // East, +50° at one junction, +45° 10 m on at the next: one right
        // turn of about 95°, at the first junction (the larger own turn).
        let (s50, c50) = (50f64.to_radians().sin(), 50f64.to_radians().cos());
        let (s95, c95) = (95f64.to_radians().sin(), 95f64.to_radians().cos());
        let p1 = (100.0, 0.0);
        let p2 = (p1.0 + 10.0 * c50, p1.1 - 10.0 * s50);
        let p3 = (p2.0 + 100.0 * c95, p2.1 - 100.0 * s95);
        let p = with_choices(&[(0.0, 0.0), p1, p2, p3], &[Some(A); 3], &[0, 3, 3, 0]);
        let s = steps(&p);
        assert_eq!(
            kinds(&s),
            vec![StepKind::Depart, StepKind::Turn, StepKind::Arrive],
            "{s:?}"
        );
        assert_eq!((s[1].turn, s[1].start_index), (Some(Turn::Right), 1));
        assert!((s[0].distance_m - 100.0).abs() < 0.1);
    }

    #[test]
    fn a_stair_step_wider_than_a_cluster_is_two_turns() {
        // Left, then right 18 m on: too far apart to be one jog.
        let p = with_choices(
            &[(0.0, 0.0), (100.0, 0.0), (100.0, 18.0), (200.0, 18.0)],
            &[Some(A); 3],
            &[0, 3, 3, 0],
        );
        let s = steps(&p);
        assert_eq!(
            kinds(&s),
            vec![
                StepKind::Depart,
                StepKind::Turn,
                StepKind::Turn,
                StepKind::Arrive
            ]
        );
        assert_eq!(
            (s[1].turn, s[2].turn),
            (Some(Turn::Left), Some(Turn::Right))
        );
    }

    #[test]
    fn a_junction_just_before_the_run_end_is_no_stub_step() {
        // A turns left 3 m before B begins: the turn onto B says it.
        let p = with_choices(
            &[(0.0, 0.0), (97.0, 0.0), (97.0, 3.0), (97.0, 100.0)],
            &[Some(A), Some(A), Some(B)],
            &[0, 3, 3, 0],
        );
        let s = steps(&p);
        assert_eq!(
            kinds(&s),
            vec![StepKind::Depart, StepKind::Turn, StepKind::Arrive],
            "{s:?}"
        );
        assert_eq!((s[1].turn, s[1].name_id), (Some(Turn::Left), 2));
    }

    #[test]
    fn a_turn_just_before_a_crossing_or_stairs_goes_on_that_step() {
        for (class, kind) in [
            (WayClass::Crossing, StepKind::Cross),
            (WayClass::Steps, StepKind::Stairs),
        ] {
            let p = with_choices(
                &[
                    (0.0, 0.0),
                    (97.0, 0.0),
                    (97.0, 3.0),
                    (97.0, 13.0),
                    (97.0, 60.0),
                ],
                &[Some(A), Some(A), Some(pack_attr(0, class)), Some(A)],
                &[0, 3, 3, 3, 0],
            );
            let s = steps(&p);
            assert_eq!(
                kinds(&s),
                vec![StepKind::Depart, kind, StepKind::Turn, StepKind::Arrive],
                "{s:?}"
            );
            assert_eq!(s[1].turn, Some(Turn::Left));
            assert_eq!(s[2].turn, Some(Turn::Straight));
        }
    }

    #[test]
    fn a_turn_a_few_metres_before_a_crossing_is_measured_before_it() {
        // A turns left at a junction 6 m before the crossing: too close to
        // split, and a 12 m window ending at the crossing would straddle the
        // corner. The crossing still says which way.
        let cross = pack_attr(0, WayClass::Crossing);
        let p = with_choices(
            &[
                (0.0, 0.0),
                (94.0, 0.0),
                (94.0, 6.0),
                (94.0, 16.0),
                (94.0, 60.0),
            ],
            &[Some(A), Some(A), Some(cross), Some(A)],
            &[0, 3, 3, 3, 0],
        );
        let s = steps(&p);
        assert_eq!(
            kinds(&s),
            vec![
                StepKind::Depart,
                StepKind::Cross,
                StepKind::Turn,
                StepKind::Arrive
            ],
            "{s:?}"
        );
        assert_eq!(s[1].turn, Some(Turn::Left));
    }

    #[test]
    fn a_hairpin_around_a_corner_is_a_sharp_turn() {
        // West along A, left at a junction, 10 m south, left onto B: the
        // turn onto B, measured from before the junction, is 180°.
        let p = with_choices(
            &[(100.0, 0.0), (0.0, 0.0), (0.0, -10.0), (100.0, -10.0)],
            &[Some(A), Some(A), Some(B)],
            &[0, 3, 3, 0],
        );
        let s = steps(&p);
        assert_eq!(
            kinds(&s),
            vec![StepKind::Depart, StepKind::Turn, StepKind::Arrive],
            "{s:?}"
        );
        assert_eq!((s[1].turn, s[1].name_id), (Some(Turn::SharpLeft), 2));
    }

    #[test]
    fn straight_across_a_crossing_has_no_turn() {
        let cross = pack_attr(0, WayClass::Crossing);
        let p = path(
            &[(0.0, 0.0), (50.0, 0.0), (56.0, 0.0), (100.0, 0.0)],
            &[Some(A), Some(cross), Some(A)],
        );
        assert_eq!(steps(&p)[1].turn, None);
    }

    #[test]
    fn missing_choices_count_as_none() {
        let mut p = with_choices(
            &[(0.0, 0.0), (100.0, 0.0), (100.0, 100.0)],
            &[Some(A), Some(A)],
            &[0, 3, 0],
        );
        p.choices.pop();
        assert_eq!(kinds(&steps(&p)), vec![StepKind::Depart, StepKind::Arrive]);
    }

    #[test]
    fn exposes_wire_strings() {
        assert_eq!(StepKind::Stairs.as_str(), "stairs");
        assert_eq!(Turn::SlightLeft.as_str(), "slight-left");
        assert_eq!(Turn::UTurn.as_str(), "u-turn");
    }
}
