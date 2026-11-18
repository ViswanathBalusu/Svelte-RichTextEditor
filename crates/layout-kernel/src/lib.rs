//! The layout kernel (ADR 0016, decision 2): a compute kernel behind the measurement interface of
//! the layout engine (02 §9.1), compiled to WebAssembly and loaded on demand (WASM-002).
//!
//! WASM-001 is the toolchain: three calls that prove the build and the package end to end. WASM-005
//! adds the font faces (`faces`) and WASM-006 shaping and measurement with HarfRust (`shaping`). The kernel reads no file, no clock and no system font: every input
//! is a byte slice, a string or a number given by the caller, and fonts arrive only as the bytes of
//! the files the manifest names, checked against the manifest's SHA-256.
//!
//! The crate forbids unsafe code. The glue that wasm-bindgen writes is not part of this crate.

#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::str::FromStr;

use harfrust::{shape, Buffer, Feature, Font, Language, ShapeOptions, ShaperFont};
use wasm_bindgen::prelude::*;

pub mod faces;
pub mod sha256;
pub mod shaping;

use faces::{FaceStore, Loaded};
use shaping::{
    scale_units, spread_advances, to_advance_units, ShapeCache, ShapeFailure, ShapeKey,
    ADVANCE_UNITS_PER_POINT,
};

thread_local! {
    /// The faces of this instance. A module instance runs on one thread, so the state is per instance.
    static FACES: RefCell<FaceStore<Font>> = const { RefCell::new(FaceStore::new()) };
    /// The answers of the shaper, by face, epoch, size, language, features and text (02 §9.3).
    static SHAPES: RefCell<ShapeCache> = RefCell::new(ShapeCache::new());
}

/// The version of the call interface. It changes when a call of the kernel changes its meaning, or
/// when a call is added.
pub const ABI_VERSION: u32 = 3;

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
        assert_eq!(abi_version(), 3);
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
