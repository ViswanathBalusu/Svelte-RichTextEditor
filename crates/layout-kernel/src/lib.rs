//! The layout kernel (ADR 0016, decision 2): a compute kernel behind the measurement interface of
//! the layout engine (02 §9.1), compiled to WebAssembly and loaded on demand (WASM-002).
//!
//! WASM-001 is the toolchain: three calls that prove the build and the package end to end. WASM-005
//! adds the font faces (`faces`), WASM-006 shaping and measurement with HarfRust (`shaping`) and
//! WASM-008 first-fit line breaking (`linebreak`), WASM-009 hyphenation with TeX patterns
//! (`hyphenate`) and WASM-007 Unicode segmentation (`segment`: UAX #14 and UAX #29). The kernel
//! reads no file, no clock and no system font: every input is a byte slice, a string or a number
//! given by the caller, and fonts arrive only as the bytes of the files the manifest names, checked
//! against the manifest's SHA-256.
//!
//! The crate forbids unsafe code. The glue that wasm-bindgen writes is not part of this crate.

#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::str::FromStr;

use harfrust::{shape, Buffer, Feature, Font, Language, ShapeOptions, ShaperFont};
use wasm_bindgen::prelude::*;

pub mod bidi;
pub mod bidi_data;
pub mod faces;
pub mod hyphenate;
pub mod linebreak;
pub mod segment;
pub mod segment_data;
pub mod sha256;
pub mod shaping;

use bidi::{resolve as resolve_bidi, visual_runs, Direction};
use faces::{FaceStore, Loaded};
use hyphenate::{word_points, HyphenStore};
use linebreak::{break_lines, Align, Measure, Params, Stop};
use shaping::{
    scale_units, spread_advances, to_advance_units, ShapeCache, ShapeFailure, ShapeKey,
    ADVANCE_UNITS_PER_POINT,
};

thread_local! {
    /// The faces of this instance. A module instance runs on one thread, so the state is per instance.
    static FACES: RefCell<FaceStore<Font>> = const { RefCell::new(FaceStore::new()) };
    /// The answers of the shaper, by face, epoch, size, language, features and text (02 §9.3).
    static SHAPES: RefCell<ShapeCache> = RefCell::new(ShapeCache::new());
    /// The hyphenation languages the page has loaded (WASM-009). Empty until a document needs one.
    static HYPHENS: RefCell<HyphenStore> = const { RefCell::new(HyphenStore::new()) };
}

/// The version of the call interface. It changes when a call of the kernel changes its meaning, or
/// when a call is added.
pub const ABI_VERSION: u32 = 7;

/// The version of the crate, as `major.minor.patch`.
#[wasm_bindgen]
pub fn kernel_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// The version of the call interface (`ABI_VERSION`).
#[wasm_bindgen]
pub fn abi_version() -> u32 {
    ABI_VERSION
}

/// The 32-bit FNV-1a hash of `data`. A fixed, dependency-free function with a known answer, so that
/// a test in Node.js can tell that bytes cross the boundary and a result comes back unchanged.
#[wasm_bindgen]
pub fn checksum(data: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in data {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// The SHA-256 of `data` as 64 lowercase hexadecimal digits, the form of the font manifest.
#[wasm_bindgen]
pub fn sha256_hex(data: &[u8]) -> String {
    sha256::sha256_hex(data)
}

/// Holds the font file `bytes` under `alias` for `owner` (the empty string is the platform's own
/// fonts, anything else is a tenant), if the file's SHA-256 is `sha256`. Returns 1 when the face is
/// new (the font epoch advanced) and 0 when the same face was held already. Throws an error whose
/// message is the code: `empty_alias`, `bad_hash`, `hash_mismatch`, `not_a_font` or
/// `owner_conflict`.
#[wasm_bindgen]
pub fn face_load(owner: &str, alias: &str, sha256: &str, bytes: &[u8]) -> Result<u32, JsError> {
    let loaded = FACES.with(|faces| {
        faces
            .borrow_mut()
            .load(owner, alias, sha256, bytes, |file| {
                Font::new(file.to_vec(), 0)
            })
    });
    match loaded {
        Ok(Loaded::New) => {
            // A new face under this alias: what was shaped with an older one is not its answer.
            SHAPES.with(|shapes| shapes.borrow_mut().invalidate(alias));
            Ok(1)
        }
        Ok(Loaded::Already) => Ok(0),
        Err(error) => Err(JsError::new(error.code())),
    }
}

/// Frees the face under `alias`. True when there was one.
#[wasm_bindgen]
pub fn face_release(alias: &str) -> bool {
    SHAPES.with(|shapes| shapes.borrow_mut().invalidate(alias));
    FACES.with(|faces| faces.borrow_mut().release(alias))
}

/// Frees every face of `owner`; returns how many.
#[wasm_bindgen]
pub fn face_release_owner(owner: &str) -> u32 {
    SHAPES.with(|shapes| shapes.borrow_mut().clear());
    FACES.with(|faces| faces.borrow_mut().release_owner(owner))
}

/// Frees every face.
#[wasm_bindgen]
pub fn face_release_all() {
    SHAPES.with(|shapes| shapes.borrow_mut().clear());
    FACES.with(|faces| faces.borrow_mut().release_all());
}

/// True when a face is held under `alias`.
#[wasm_bindgen]
pub fn face_has(alias: &str) -> bool {
    FACES.with(|faces| faces.borrow().has(alias))
}

/// The owner of the face under `alias`, or `undefined` when none is held.
#[wasm_bindgen]
pub fn face_owner(alias: &str) -> Option<String> {
    FACES.with(|faces| faces.borrow().owner(alias).map(str::to_string))
}

/// The number of faces held.
#[wasm_bindgen]
pub fn faces_count() -> u32 {
    FACES.with(|faces| u32::try_from(faces.borrow().count()).unwrap_or(u32::MAX))
}

/// The bytes the faces hold, apart from the module's own memory.
#[wasm_bindgen]
pub fn faces_bytes_held() -> u32 {
    FACES.with(|faces| u32::try_from(faces.borrow().bytes_held()).unwrap_or(u32::MAX))
}

/// The font epoch: how many faces have been loaded in this instance.
#[wasm_bindgen]
pub fn font_epoch() -> u32 {
    FACES.with(|faces| faces.borrow().epoch())
}

/// The advance units in one point (1280): the unit of every advance the kernel returns. A size is
/// given in twentieths of a point and an advance is the font's value scaled to it and rounded to a
/// whole number of these units, halves up, in integer arithmetic (`shaping.rs`).
#[wasm_bindgen]
pub fn advance_units_per_point() -> u32 {
    u32::try_from(ADVANCE_UNITS_PER_POINT).unwrap_or(u32::MAX)
}

/// Shapes `text` (UTF-16) and returns the font's advances in font units for each code unit, with
/// every cluster's advance on its first unit.
fn shape_font_units(
    font: &Font,
    text: &[u16],
    language: &str,
    features: &str,
) -> Result<Vec<i64>, ShapeFailure> {
    let mut chosen = Vec::new();
    for part in features.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        chosen.push(Feature::from_str(part).map_err(|_| ShapeFailure::BadFeature)?);
    }
    let shaper = ShaperFont::new(font);
    let mut buffer = Buffer::new();
    let mut at = 0u32;
    for decoded in char::decode_utf16(text.iter().copied()) {
        let ch = decoded.unwrap_or(char::REPLACEMENT_CHARACTER);
        buffer.push(u32::from(ch), at);
        at += u32::try_from(ch.len_utf16()).unwrap_or(1);
    }
    if !language.is_empty() {
        if let Ok(parsed) = Language::from_str(language) {
            buffer.set_language(Some(parsed));
        }
    }
    buffer.guess_segment_properties();
    shape(&shaper, &mut buffer, ShapeOptions::new().features(&chosen))
        .map_err(|_| ShapeFailure::Failed)?;
    Ok(spread_advances(
        buffer
            .glyph_infos()
            .iter()
            .zip(buffer.glyph_positions())
            .map(|(info, position)| (info.cluster, position.x_advance)),
        text.len(),
    ))
}

/// The advance of each code unit of a run, in advance units, through the cache.
fn run_advances(
    alias: &str,
    size_twips: u32,
    language: &str,
    features: &str,
    text: &[u16],
) -> Result<Vec<i32>, ShapeFailure> {
    if size_twips == 0 {
        return Err(ShapeFailure::BadSize);
    }
    let (font, face_epoch) = FACES
        .with(|faces| {
            let faces = faces.borrow();
            faces.get(alias).cloned().zip(faces.loaded_epoch(alias))
        })
        .ok_or(ShapeFailure::UnknownFace)?;
    let key = ShapeKey {
        alias: alias.to_string(),
        face_epoch,
        size_twips,
        language: language.to_string(),
        features: features.to_string(),
        text: text.to_vec(),
    };
    SHAPES.with(|shapes| {
        shapes.borrow_mut().get_or_shape(key, || {
            let units = shape_font_units(&font, text, language, features)?;
            Ok(to_advance_units(
                &units,
                size_twips,
                u32::from(font.units_per_em()),
            ))
        })
    })
}

/// Shapes a run of UTF-16 text in the face under `alias` at `size_twips` (twentieths of a point),
/// for `language` (a BCP 47 tag, or empty) with `features` (HarfBuzz syntax, comma separated, or
/// empty), and returns the advance of each code unit in advance units (1/1280 pt). The second unit
/// of a surrogate pair and the interior of a ligature or cluster carry 0; the units sum to the
/// run's width. Throws `unknown_face`, `bad_feature`, `shape_failed` or `bad_size`.
#[wasm_bindgen]
pub fn shape_advances(
    alias: &str,
    size_twips: u32,
    language: &str,
    features: &str,
    text: &[u16],
) -> Result<Vec<i32>, JsError> {
    run_advances(alias, size_twips, language, features, text)
        .map_err(|failure| JsError::new(failure.code()))
}

/// The width of the same run: the sum of its advances, in advance units.
#[wasm_bindgen]
pub fn shape_width(
    alias: &str,
    size_twips: u32,
    language: &str,
    features: &str,
    text: &[u16],
) -> Result<i32, JsError> {
    let advances = run_advances(alias, size_twips, language, features, text)
        .map_err(|failure| JsError::new(failure.code()))?;
    let total: i64 = advances.iter().map(|&a| i64::from(a)).sum();
    Ok(i32::try_from(total).unwrap_or(if total < 0 { i32::MIN } else { i32::MAX }))
}

/// The ascent, the descent (as a positive number) and the line gap of the face at `size_twips`, in
/// advance units: from the typographic metrics when the font asks for them, else `hhea`, else
/// `OS/2`, else the Windows metrics. Throws `unknown_face` or `bad_size`.
#[wasm_bindgen]
pub fn face_line_metrics(alias: &str, size_twips: u32) -> Result<Vec<i32>, JsError> {
    if size_twips == 0 {
        return Err(JsError::new(ShapeFailure::BadSize.code()));
    }
    let font = FACES
        .with(|faces| faces.borrow().get(alias).cloned())
        .ok_or_else(|| JsError::new(ShapeFailure::UnknownFace.code()))?;
    let metrics = font.metrics();
    let line = if metrics.use_typo_metrics {
        metrics.typo_line.or(metrics.hhea_line)
    } else {
        metrics.hhea_line.or(metrics.typo_line)
    };
    // The metrics are 16.16 fixed point in font units; scale with the 16 fractional bits kept.
    let upem = u32::try_from(u64::from(font.units_per_em().max(1)) * 65_536).unwrap_or(u32::MAX);
    let scale = |bits: i64| {
        let value = scale_units(bits, size_twips, upem);
        i32::try_from(value).unwrap_or(if value < 0 { i32::MIN } else { i32::MAX })
    };
    let (ascent, descent, gap) = match (line, metrics.win_line) {
        (Some(line), _) => (
            scale(line.ascender.to_bits()),
            -scale(line.descender.to_bits()),
            scale(line.line_gap.to_bits()),
        ),
        (None, Some(win)) => (
            scale(win.ascender.to_bits()),
            -scale(win.descender.to_bits()),
            0,
        ),
        (None, None) => (0, 0, 0),
    };
    Ok(vec![ascent, descent, gap])
}

/// The runs of a paragraph, as arrays that are the same length: the end of each run in code units,
/// the face alias, the size in twips, the language and the features of a text run, and the width of
/// a box run (an inline atom; -1 for a text run).
struct RunMeasure<'a> {
    ends: &'a [u32],
    aliases: &'a [String],
    sizes: &'a [u32],
    languages: &'a [String],
    features: &'a [String],
    boxes: &'a [i32],
    text: &'a [u16],
}

impl Measure for RunMeasure<'_> {
    type Error = ShapeFailure;

    /// The width of a hyphen (U+002D) set in the run of the unit before `at`; a box has none.
    fn hyphen(&mut self, at: usize) -> Result<i64, ShapeFailure> {
        let before = at.saturating_sub(1);
        let Some(i) = self.ends.iter().position(|&end| before < end as usize) else {
            return Ok(0);
        };
        if self.boxes[i] >= 0 {
            return Ok(0);
        }
        let advances = run_advances(
            &self.aliases[i],
            self.sizes[i],
            &self.languages[i],
            &self.features[i],
            &[0x2d],
        )?;
        Ok(advances.iter().map(|&v| i64::from(v)).sum())
    }

    /// The width of text[a, b): a text run is shaped over the part of it inside the range (through
    /// the cache), a box run counts its whole width when the range touches it.
    fn span(&mut self, a: usize, b: usize) -> Result<i64, ShapeFailure> {
        let mut total = 0i64;
        let mut start = 0usize;
        for (i, &end) in self.ends.iter().enumerate() {
            let end = end as usize;
            let (low, high) = (a.max(start), b.min(end));
            if low < high {
                let width = self.boxes[i];
                if width >= 0 {
                    total += i64::from(width);
                } else {
                    let advances = run_advances(
                        &self.aliases[i],
                        self.sizes[i],
                        &self.languages[i],
                        &self.features[i],
                        &self.text[low..high],
                    )?;
                    total += advances.iter().map(|&v| i64::from(v)).sum::<i64>();
                }
            }
            start = end;
        }
        Ok(total)
    }
}

/// Breaks one paragraph into lines by first fit (`linebreak.rs`), shaping each run through the cache.
///
/// `text` is the block's text with each inline atom as one code unit (09 §7.1). The runs are the
/// parallel arrays `run_ends` (exclusive ends, ascending, the last the text's length), `run_aliases`,
/// `run_sizes` (twips), `run_languages`, `run_features` and `run_boxes` (the width of an atom in
/// advance units, or -1 for a text run). `opportunities` are the offsets at which a break is allowed.
/// `geometry` is `[column_width, indent_left, indent_right, indent_first, default_tab_stop]` and
/// `tab_stops` pairs of `[position, align]` (0 left, 1 centre, 2 right, 3 decimal), all lengths in
/// advance units. The answer is seven numbers for each line: `from`, `to`, `x`, `width`, and for a
/// justified line the space it needs (`extra`) and the number of spaces that share it, and 1 when
/// the line ends at a hyphen (the hyphen is in `width`), else 0. With `hyphenate` the words of the
/// languages loaded by `hyphen_load` may be split (WASM-009); without it no pattern is consulted. Throws
/// `bad_request`, or what shaping throws (`unknown_face`, `bad_feature`, `shape_failed`, `bad_size`).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn break_paragraph(
    text: &[u16],
    run_ends: &[u32],
    run_aliases: Vec<String>,
    run_sizes: &[u32],
    run_languages: Vec<String>,
    run_features: Vec<String>,
    run_boxes: &[i32],
    opportunities: &[u32],
    geometry: &[i32],
    tab_stops: &[i32],
    justify: bool,
    hyphenate: bool,
) -> Result<Vec<i32>, JsError> {
    let bad = || JsError::new(ShapeFailure::BadRequest.code());
    let runs = run_ends.len();
    if run_aliases.len() != runs
        || run_sizes.len() != runs
        || run_languages.len() != runs
        || run_features.len() != runs
        || run_boxes.len() != runs
        || geometry.len() != 5
        || tab_stops.len() % 2 != 0
    {
        return Err(bad());
    }
    let mut previous = 0u32;
    for &end in run_ends {
        if end < previous {
            return Err(bad());
        }
        previous = end;
    }
    if usize::try_from(previous).unwrap_or(usize::MAX) != text.len() {
        return Err(bad());
    }
    let stops = tab_stops
        .chunks_exact(2)
        .map(|pair| Stop {
            position: i64::from(pair[0]),
            align: Align::from_code(pair[1]),
        })
        .collect();
    let hyphens = if hyphenate {
        HYPHENS.with(|store| word_points(&store.borrow(), text, run_ends, &run_languages))
    } else {
        Vec::new()
    };
    let params = Params {
        text,
        opportunities,
        hyphens: &hyphens,
        column_width: i64::from(geometry[0]),
        indent_left: i64::from(geometry[1]),
        indent_right: i64::from(geometry[2]),
        indent_first: i64::from(geometry[3]),
        stops,
        default_tab: i64::from(geometry[4]),
        justify,
    };
    let mut measure = RunMeasure {
        ends: run_ends,
        aliases: &run_aliases,
        sizes: run_sizes,
        languages: &run_languages,
        features: &run_features,
        boxes: run_boxes,
        text,
    };
    let lines =
        break_lines(&params, &mut measure).map_err(|failure| JsError::new(failure.code()))?;
    let clamp = |v: i64| i32::try_from(v).unwrap_or(if v < 0 { i32::MIN } else { i32::MAX });
    let mut out = Vec::with_capacity(lines.len() * 7);
    for line in lines {
        out.push(clamp(i64::from(line.from)));
        out.push(clamp(i64::from(line.to)));
        out.push(clamp(line.x));
        out.push(clamp(line.width));
        out.push(clamp(line.extra));
        out.push(clamp(i64::from(line.spaces)));
        out.push(i32::from(line.hyphen));
    }
    Ok(out)
}

/// The text as characters (a lone surrogate is U+FFFD) and the UTF-16 offset of each, with the
/// length at the end.
fn characters(text: &[u16]) -> (Vec<char>, Vec<usize>) {
    let mut chars = Vec::with_capacity(text.len());
    let mut offsets = Vec::with_capacity(text.len() + 1);
    let mut at = 0usize;
    for decoded in char::decode_utf16(text.iter().copied()) {
        let c = decoded.unwrap_or(char::REPLACEMENT_CHARACTER);
        chars.push(c);
        offsets.push(at);
        at += c.len_utf16();
    }
    offsets.push(text.len());
    (chars, offsets)
}

/// The paragraph level and the resolved level of each UTF-16 unit of a paragraph (UAX #9; WASM-015):
/// the answer is the paragraph level (0 or 1) followed by one level for each unit. `direction` is 0
/// for left to right, 1 for right to left and anything else for automatic (the first strong
/// character). The levels are those of the paragraph before a line is cut: L1 is applied by
/// `bidi_visual_runs`.
#[wasm_bindgen]
pub fn bidi_levels(text: &[u16], direction: i32) -> Vec<u8> {
    let (chars, _) = characters(text);
    let paragraph = resolve_bidi(&chars, Direction::from_code(direction));
    let mut out = Vec::with_capacity(text.len() + 1);
    out.push(paragraph.level);
    for (c, level) in chars.iter().zip(paragraph.levels.iter()) {
        for _ in 0..c.len_utf16() {
            out.push(*level);
        }
    }
    out
}

/// The visual runs of the line `[from, to)` of a paragraph, left to right (UAX #9, L1 and L2;
/// WASM-015): three numbers for each run, its first and last-plus-one UTF-16 offset (logical) and
/// its level. An odd level reads right to left. Throws `bad_request` when the line is out of range
/// or begins or ends inside a surrogate pair.
#[wasm_bindgen]
pub fn bidi_visual_runs(
    text: &[u16],
    direction: i32,
    from: u32,
    to: u32,
) -> Result<Vec<u32>, JsError> {
    let (chars, offsets) = characters(text);
    let (from, to) = (from as usize, to as usize);
    let (Some(first), Some(last)) = (
        offsets.iter().position(|&o| o == from),
        offsets.iter().position(|&o| o == to),
    ) else {
        return Err(JsError::new(ShapeFailure::BadRequest.code()));
    };
    if first > last {
        return Err(JsError::new(ShapeFailure::BadRequest.code()));
    }
    let paragraph = resolve_bidi(&chars, Direction::from_code(direction));
    let mut out = Vec::new();
    for run in visual_runs(&paragraph, first, last) {
        out.push(u32::try_from(offsets[run.start]).unwrap_or(u32::MAX));
        out.push(u32::try_from(offsets[run.end]).unwrap_or(u32::MAX));
        out.push(u32::from(run.level));
    }
    Ok(out)
}

/// The line-break opportunities of a text by UAX #14 (WASM-007), as a flat list of pairs for each
/// opportunity, ascending: the UTF-16 offset of the first unit after the break, and 1 when the
/// break is mandatory (after a hard line break, and at the end of the text) or 0 when it is only
/// allowed. The end of a non-empty text is always the last opportunity; an empty text has none.
/// The Unicode version is `segment_unicode_versions`.
#[wasm_bindgen]
pub fn line_break_opportunities(text: &[u16]) -> Vec<u32> {
    segment::line_breaks(text)
}

/// The extended grapheme cluster boundaries of a text by UAX #29 (WASM-007), ascending, as UTF-16
/// offsets: the start, the start of every cluster after the first, and the end of the text.
#[wasm_bindgen]
pub fn grapheme_cluster_boundaries(text: &[u16]) -> Vec<u32> {
    segment::grapheme_boundaries(text)
}

/// The Unicode versions of the segmentation data, six numbers: major, minor and update of the line
/// breaking (UAX #14), then of the grapheme clusters (UAX #29). They differ when the two crates
/// implement different versions of Unicode (`segment.rs`).
#[wasm_bindgen]
pub fn segment_unicode_versions() -> Vec<u32> {
    let (a, b, c) = segment::LINE_BREAK_UNICODE;
    let (d, e, f) = segment::GRAPHEME_UNICODE;
    [u64::from(a), u64::from(b), u64::from(c), d, e, f]
        .iter()
        .map(|&v| u32::try_from(v).unwrap_or(u32::MAX))
        .collect()
}
/// Holds a hyphenation language (WASM-009): the text of its TeX pattern file (one pattern a line),
/// the text of its exception file (one word a line, hyphens marked; may be empty), and the minimum
/// characters before and after a hyphen (`\lefthyphenmin` and `\righthyphenmin`, 1 to 8). A language
/// held under the tag is replaced. Returns the number of patterns. Throws `empty_tag`, `no_patterns`
/// or `bad_minimum`.
#[wasm_bindgen]
pub fn hyphen_load(
    tag: &str,
    patterns: &str,
    exceptions: &str,
    left: u32,
    right: u32,
) -> Result<u32, JsError> {
    let (left, right) = (left as usize, right as usize);
    HYPHENS
        .with(|store| {
            store
                .borrow_mut()
                .load(tag, patterns, exceptions, left, right)
        })
        .map(|count| u32::try_from(count).unwrap_or(u32::MAX))
        .map_err(|failure| JsError::new(failure.code()))
}

/// Lets `alias` (`en`, `en-GB`) stand for a loaded language. False when `tag` is not loaded.
#[wasm_bindgen]
pub fn hyphen_alias(alias: &str, tag: &str) -> bool {
    HYPHENS.with(|store| store.borrow_mut().alias(alias, tag))
}

/// Frees a hyphenation language. False when it was not loaded.
#[wasm_bindgen]
pub fn hyphen_release(tag: &str) -> bool {
    HYPHENS.with(|store| store.borrow_mut().release(tag))
}

/// Frees every hyphenation language.
#[wasm_bindgen]
pub fn hyphen_release_all() {
    HYPHENS.with(|store| store.borrow_mut().release_all());
}

/// True when text tagged `tag` would be hyphenated: the tag, or the tag cut short, is loaded.
#[wasm_bindgen]
pub fn hyphen_has(tag: &str) -> bool {
    HYPHENS.with(|store| store.borrow().has(tag))
}

/// The tags of the loaded languages, ascending, joined by commas.
#[wasm_bindgen]
pub fn hyphen_tags() -> String {
    HYPHENS.with(|store| store.borrow().tags().join(","))
}

/// Where a hyphen may stand in a word of one language: UTF-16 offsets into `word`, ascending. Empty
/// when the language is not loaded or the word is too short. The word is hyphenated whole, wherever
/// it stands in a text; `break_paragraph` finds the words of a paragraph itself.
#[wasm_bindgen]
pub fn hyphenate_word(tag: &str, word: &[u16]) -> Vec<u32> {
    let end = u32::try_from(word.len()).unwrap_or(u32::MAX);
    HYPHENS.with(|store| word_points(&store.borrow(), word, &[end], &[tag.to_string()]))
}

/// What the shaping cache has done: hits, misses, entries and the code units of text it holds.
#[wasm_bindgen]
pub fn shape_cache_stats() -> Vec<u32> {
    SHAPES.with(|shapes| {
        let shapes = shapes.borrow();
        vec![
            shapes.hits(),
            shapes.misses(),
            u32::try_from(shapes.entries()).unwrap_or(u32::MAX),
            u32::try_from(shapes.units()).unwrap_or(u32::MAX),
        ]
    })
}

/// Empties the shaping cache.
#[wasm_bindgen]
pub fn shape_cache_clear() {
    SHAPES.with(|shapes| shapes.borrow_mut().clear());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_crate_version_and_the_interface_version() {
        assert_eq!(kernel_version(), env!("CARGO_PKG_VERSION"));
        assert_eq!(abi_version(), 7);
    }

    #[test]
    fn checksum_matches_the_published_fnv_1a_values() {
        // The test vectors of the FNV reference (32-bit FNV-1a).
        assert_eq!(checksum(b""), 0x811c_9dc5);
        assert_eq!(checksum(b"a"), 0xe40c_292c);
        assert_eq!(checksum(b"foobar"), 0xbf9c_f968);
    }

    #[test]
    fn checksum_depends_on_every_byte_and_on_their_order() {
        assert_ne!(checksum(b"ab"), checksum(b"ba"));
        assert_ne!(checksum(b"abc"), checksum(b"abd"));
    }
}
