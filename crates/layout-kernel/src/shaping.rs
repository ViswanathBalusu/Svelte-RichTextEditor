//! Shaping and measurement behind the measurement interface (WASM-006; 02 §9.1, §9.3).
//!
//! A run of text, shaped in one face at one size, gives one advance for each UTF-16 code unit of the
//! run, in a fixed unit with fixed rounding, so that the answer is the same in every runtime and
//! every browser. The functions here are plain: they take what they need and keep nothing, apart
//! from the cache, which is keyed so that a later font load can never be answered from an older one.
//!
//! # Unit and rounding
//!
//! The size of a run is a whole number of twentieths of a point (twips). An advance is a whole
//! number of sixty-fourths of a twip, that is 1/1280 of a point (`ADVANCE_UNITS_PER_POINT`). It is
//! `round(font_units * size_twips * 64 / units_per_em)` with halves rounded up (towards positive
//! infinity), computed in 64-bit integers: no floating point is involved. The glyphs of one cluster
//! are summed in font units before rounding, and the advance of a run is the sum of the rounded
//! advances of its code units, so a run's width is exactly the sum of its parts.
//!
//! # Which code unit carries an advance
//!
//! A cluster is the text that shaping kept together (a letter and its marks, a ligature). Its advance
//! is on the cluster's first code unit; every other code unit of the cluster, and the second unit of
//! a surrogate pair, carries 0. A lone surrogate is shaped as U+FFFD, one unit.

use std::collections::HashMap;

/// Advance units in one point: the unit of every advance this module returns.
pub const ADVANCE_UNITS_PER_POINT: i64 = 1280;
/// Advance units in one twip (a twentieth of a point).
const UNITS_PER_TWIP: i64 = 64;

/// Why a run was not shaped. The text of `code` is part of the call interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShapeFailure {
    /// No face is held under the alias.
    UnknownFace,
    /// A feature of the list is not in HarfBuzz's syntax.
    BadFeature,
    /// The shaper refused the run.
    Failed,
    /// The size is 0.
    BadSize,
}

impl ShapeFailure {
    pub fn code(self) -> &'static str {
        match self {
            ShapeFailure::UnknownFace => "unknown_face",
            ShapeFailure::BadFeature => "bad_feature",
            ShapeFailure::Failed => "shape_failed",
            ShapeFailure::BadSize => "bad_size",
        }
    }
}

/// `value` font units at `size_twips` in a face of `units_per_em`, in advance units, rounded half up.
pub fn scale_units(value: i64, size_twips: u32, units_per_em: u32) -> i64 {
    let upem = i128::from(units_per_em.max(1));
    let numerator = i128::from(value) * i128::from(size_twips) * i128::from(UNITS_PER_TWIP);
    // floor(numerator / upem + 1/2), exact for negative values too.
    let rounded = (2 * numerator + upem).div_euclid(2 * upem);
    i64::try_from(rounded).unwrap_or(if rounded < 0 { i64::MIN } else { i64::MAX })
}

/// Puts each glyph's advance (in font units) on the first code unit of its cluster. `glyphs` are
/// `(cluster, advance)` pairs, where `cluster` is the UTF-16 offset of the cluster's first unit;
/// `len` is the number of code units of the run. A cluster beyond the run is put on the last unit.
pub fn spread_advances(glyphs: impl IntoIterator<Item = (u32, i32)>, len: usize) -> Vec<i64> {
    let mut out = vec![0i64; len];
    if len == 0 {
        return out;
    }
    for (cluster, advance) in glyphs {
        let at = usize::try_from(cluster).unwrap_or(len - 1).min(len - 1);
        out[at] += i64::from(advance);
    }
    out
}

/// The advances of a run in advance units, from the advances of its code units in font units.
pub fn to_advance_units(font_units: &[i64], size_twips: u32, units_per_em: u32) -> Vec<i32> {
    font_units
        .iter()
        .map(|&v| {
            let scaled = scale_units(v, size_twips, units_per_em);
            i32::try_from(scaled).unwrap_or(if scaled < 0 { i32::MIN } else { i32::MAX })
        })
        .collect()
}

/// What an answer of the cache is valid for. `face_epoch` is the epoch at which the face was loaded
/// (02 §6): after a later load of the same alias it is another number, so the old answers never hit.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ShapeKey {
    pub alias: String,
    pub face_epoch: u32,
    pub size_twips: u32,
    pub language: String,
    pub features: String,
    pub text: Vec<u16>,
}

/// How many code units of text the cache holds before it is emptied. The rule is the simplest one:
/// the whole cache goes when it is full, so a pass after that measures again and nothing is stale.
pub const CACHE_LIMIT_UNITS: usize = 1 << 22;

/// The shaping cache (02 §9.3): by face alias and its epoch, size, language, features and text.
#[derive(Default)]
pub struct ShapeCache {
    entries: HashMap<ShapeKey, Vec<i32>>,
    units: usize,
    hits: u32,
    misses: u32,
}

impl ShapeCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// The answer for `key`, computed by `shape` when the cache has none. A failure is not kept.
    pub fn get_or_shape(
        &mut self,
        key: ShapeKey,
        shape: impl FnOnce() -> Result<Vec<i32>, ShapeFailure>,
    ) -> Result<Vec<i32>, ShapeFailure> {
        if let Some(found) = self.entries.get(&key) {
            self.hits = self.hits.wrapping_add(1);
            return Ok(found.clone());
        }
        self.misses = self.misses.wrapping_add(1);
        let answer = shape()?;
        if self.units + key.text.len() > CACHE_LIMIT_UNITS {
            self.entries.clear();
            self.units = 0;
        }
        self.units += key.text.len();
        self.entries.insert(key, answer.clone());
        Ok(answer)
    }

    /// Drops every answer made for the face under `alias`: its face changed or went.
    pub fn invalidate(&mut self, alias: &str) {
        self.entries.retain(|key, _| key.alias != alias);
        self.units = self.entries.keys().map(|key| key.text.len()).sum();
    }

    /// Drops everything.
    pub fn clear(&mut self) {
        self.entries.clear();
        self.units = 0;
    }

    pub fn hits(&self) -> u32 {
        self.hits
    }

    pub fn misses(&self) -> u32 {
        self.misses
    }

    pub fn entries(&self) -> usize {
        self.entries.len()
    }

    /// The code units of text the cache holds.
    pub fn units(&self) -> usize {
        self.units
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_font_units_to_advance_units_with_halves_rounded_up() {
        // 1000 units per em at 10 pt (200 twips): one font unit is 0.2 twip = 12.8 advance units.
        assert_eq!(scale_units(1000, 200, 1000), 12_800);
        assert_eq!(scale_units(500, 200, 1000), 6_400);
        // 12.8 rounds to 13, 25.6 to 26, 38.4 to 38.
        assert_eq!(scale_units(1, 200, 1000), 13);
        assert_eq!(scale_units(2, 200, 1000), 26);
        assert_eq!(scale_units(3, 200, 1000), 38);
        // An exact half goes up (towards positive infinity): 0.5 -> 1, -0.5 -> 0, 1.5 -> 2, -1.5 -> -1.
        assert_eq!(scale_units(1, 1, 128), 1);
        assert_eq!(scale_units(-1, 1, 128), 0);
        assert_eq!(scale_units(3, 1, 128), 2);
        assert_eq!(scale_units(-3, 1, 128), -1);
        // More cases, for both signs.
        assert_eq!(scale_units(1, 2, 1000), 0);
        assert_eq!(scale_units(5, 1, 640), 1);
        assert_eq!(scale_units(-5, 1, 640), 0);
        assert_eq!(scale_units(-6, 1, 640), -1);
    }

    #[test]
    fn a_zero_unit_em_does_not_divide_by_zero() {
        assert_eq!(scale_units(10, 200, 0), 10 * 200 * 64);
    }

    #[test]
    fn the_unit_is_a_1280th_of_a_point() {
        // 12 pt = 240 twips; one em of a 1000-unit face is 12 pt = 15360 advance units.
        assert_eq!(scale_units(1000, 240, 1000), 12 * ADVANCE_UNITS_PER_POINT);
    }

    #[test]
    fn puts_a_cluster_s_advance_on_its_first_code_unit() {
        // "fi" is one glyph for two units; "a" then a combining mark are two glyphs on one cluster.
        let glyphs = [(0, 700), (2, 500), (2, 0), (3, 300)];
        assert_eq!(spread_advances(glyphs, 4), vec![700, 0, 500, 300]);
        // A surrogate pair is one cluster of two units: the second carries 0.
        assert_eq!(spread_advances([(0, 400), (2, 300)], 3), vec![400, 0, 300]);
    }

    #[test]
    fn the_glyphs_of_a_cluster_are_summed_before_rounding() {
        let spread = spread_advances([(0, 1), (0, 1), (0, 1)], 2);
        assert_eq!(spread, vec![3, 0]);
        // 3 font units at 200 twips in 1000 per em: 38.4 -> 38, where three roundings of 12.8 give 39.
        assert_eq!(to_advance_units(&spread, 200, 1000), vec![38, 0]);
    }

    #[test]
    fn an_empty_run_and_a_cluster_beyond_the_run_are_safe() {
        assert!(spread_advances([(0, 5)], 0).is_empty());
        assert_eq!(spread_advances([(9, 5)], 2), vec![0, 5]);
        assert!(to_advance_units(&[], 200, 1000).is_empty());
    }

    fn key(alias: &str, epoch: u32, size: u32, text: &str) -> ShapeKey {
        ShapeKey {
            alias: alias.to_string(),
            face_epoch: epoch,
            size_twips: size,
            language: String::new(),
            features: String::new(),
            text: text.encode_utf16().collect(),
        }
    }

    #[test]
    fn answers_from_the_cache_by_face_size_language_features_and_text() {
        let mut cache = ShapeCache::new();
        let mut calls = 0;
        let mut ask = |k: ShapeKey| {
            cache
                .get_or_shape(k, || {
                    calls += 1;
                    Ok(vec![calls])
                })
                .unwrap()
        };
        assert_eq!(ask(key("a", 1, 200, "hello")), vec![1]);
        assert_eq!(ask(key("a", 1, 200, "hello")), vec![1]);
        // Each part of the key makes another entry.
        assert_eq!(ask(key("a", 1, 240, "hello")), vec![2]);
        assert_eq!(ask(key("b", 1, 200, "hello")), vec![3]);
        assert_eq!(ask(key("a", 1, 200, "world")), vec![4]);
        let mut lang = key("a", 1, 200, "hello");
        lang.language = "de".to_string();
        assert_eq!(ask(lang), vec![5]);
        let mut feat = key("a", 1, 200, "hello");
        feat.features = "kern=0".to_string();
        assert_eq!(ask(feat), vec![6]);
        assert_eq!(cache.hits(), 1);
        assert_eq!(cache.misses(), 6);
        assert_eq!(cache.entries(), 6);
    }

    #[test]
    fn a_later_font_load_cannot_be_answered_from_an_older_one() {
        let mut cache = ShapeCache::new();
        cache
            .get_or_shape(key("a", 1, 200, "hi"), || Ok(vec![10]))
            .unwrap();
        cache
            .get_or_shape(key("b", 2, 200, "hi"), || Ok(vec![20]))
            .unwrap();
        // The face `a` was loaded again at epoch 3: the old answer is not found, even before it is dropped.
        let again = cache
            .get_or_shape(key("a", 3, 200, "hi"), || Ok(vec![11]))
            .unwrap();
        assert_eq!(again, vec![11]);
        // Dropping the alias frees its answers and leaves the others.
        cache.invalidate("a");
        assert_eq!(cache.entries(), 1);
        assert_eq!(cache.units(), 2);
        let b = cache
            .get_or_shape(key("b", 2, 200, "hi"), || Ok(vec![0]))
            .unwrap();
        assert_eq!(b, vec![20]);
    }

    #[test]
    fn a_failure_is_not_kept_and_a_full_cache_is_emptied() {
        let mut cache = ShapeCache::new();
        assert_eq!(
            cache.get_or_shape(key("a", 1, 200, "x"), || Err(ShapeFailure::Failed)),
            Err(ShapeFailure::Failed)
        );
        assert_eq!(cache.entries(), 0);
        let long = "y".repeat(CACHE_LIMIT_UNITS);
        cache
            .get_or_shape(key("a", 1, 200, "x"), || Ok(vec![1]))
            .unwrap();
        cache
            .get_or_shape(key("a", 1, 200, &long), || Ok(vec![2]))
            .unwrap();
        // The first entry went when the second did not fit; the second is held.
        assert_eq!(cache.entries(), 1);
        cache.clear();
        assert_eq!(cache.units(), 0);
    }
}
