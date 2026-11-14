//! Text kernel for spikes S5 (SPK-018) and S10 (SPK-023), ADR 0016.
//!
//! One WebAssembly module that shapes with HarfRust and, with the `kernel` feature, finds UAX #14
//! break opportunities with `unicode-linebreak`, breaks paragraphs first-fit (02 §9.3) and, when
//! asked, hyphenates English words with TeX patterns through `hypher`. It is reached through a
//! plain C ABI, so it needs no JavaScript glue: the host writes its input into a buffer the module
//! owns, calls a function, and reads the result from another buffer the module owns.
//! `src/shapers/harfrust.ts` and `src/kernel/rust.ts` are the TypeScript side.
//!
//! The crate has no unsafe blocks. The exported functions need `#[no_mangle]`, which the
//! `unsafe_code` lint also reports, so the lint is allowed on the export module alone.
//!
//! Units: shaping results are in font units; paragraph input and output are in points, with every
//! run carrying its size.
#![deny(unsafe_code)]

use harfrust::{shape, Buffer, Feature, Font, ShapeOptions, ShaperFont, Tag};
use std::cell::RefCell;
use std::collections::HashMap;

/// One font file, parsed once.
struct LoadedFont {
    font: Font,
    upem: f32,
}

#[derive(Default)]
struct State {
    input: Vec<u8>,
    output: Vec<u8>,
    fonts: Vec<LoadedFont>,
    /// Width of a piece of text in font units, by font and UTF-16 text (the segment cache).
    widths: HashMap<(u32, Vec<u16>), i32>,
    shaped: u64,
    cache_hits: u64,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

/// Feature switches for experiments: bit 0 turns kerning off, bit 1 standard ligatures off.
fn features(flags: u32) -> Vec<Feature> {
    let mut out = Vec::new();
    if flags & 1 != 0 {
        out.push(Feature::new(Tag::new(b"kern"), 0, ..));
    }
    if flags & 2 != 0 {
        out.push(Feature::new(Tag::new(b"liga"), 0, ..));
        out.push(Feature::new(Tag::new(b"clig"), 0, ..));
    }
    out
}

#[cfg_attr(not(feature = "kernel"), allow(dead_code))]
fn read_u32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn utf16_of(b: &[u8], at: usize, units: usize) -> Vec<u16> {
    (0..units)
        .map(|i| u16::from_le_bytes([b[at + 2 * i], b[at + 2 * i + 1]]))
        .collect()
}

/// Shapes UTF-16 text; clusters are UTF-16 offsets into `text`.
fn shape_utf16(font: &Font, text: &[u16], flags: u32) -> Option<Buffer> {
    let shaper = ShaperFont::new(font);
    let mut buffer = Buffer::new();
    let mut i = 0u32;
    for c in char::decode_utf16(text.iter().copied()) {
        let c = c.unwrap_or(char::REPLACEMENT_CHARACTER);
        buffer.push(c as u32, i);
        i += c.len_utf16() as u32;
    }
    buffer.guess_segment_properties();
    let feats = features(flags);
    shape(&shaper, &mut buffer, ShapeOptions::new().features(&feats)).ok()?;
    Some(buffer)
}

/// The advance width of `text` in font units, through the segment cache.
fn width_units(state: &mut State, font_id: u32, text: &[u16]) -> i32 {
    if text.is_empty() {
        return 0;
    }
    let key = (font_id, text.to_vec());
    if let Some(w) = state.widths.get(&key) {
        state.cache_hits += 1;
        return *w;
    }
    let w = match state.fonts.get(font_id as usize) {
        Some(f) => shape_utf16(&f.font, text, 0)
            .map(|b| b.glyph_positions().iter().map(|p| p.x_advance).sum())
            .unwrap_or(0),
        None => 0,
    };
    state.shaped += 1;
    state.widths.insert(key, w);
    w
}

fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn put_i32(out: &mut Vec<u8>, v: i32) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// Segmentation, first-fit line breaking and hyphenation (S10).
#[cfg(feature = "kernel")]
mod kernel {
    use super::{read_u32, width_units, State};
    use unicode_linebreak::{linebreaks, BreakOpportunity};

    pub(crate) fn read_f32(b: &[u8], at: usize) -> f32 {
        f32::from_bits(read_u32(b, at))
    }

    pub(crate) fn put_f32(out: &mut Vec<u8>, v: f32) {
        out.extend_from_slice(&v.to_le_bytes());
    }

    #[derive(Clone, Copy)]
    pub(crate) struct Run {
        pub(crate) font: u32,
        pub(crate) size: f32,
        pub(crate) start: usize,
        pub(crate) end: usize,
    }

    /// Width in points of `text[from..to]`, measured run by run (a piece never crosses a run).
    fn width_pt(state: &mut State, runs: &[Run], text: &[u16], from: usize, to: usize) -> f32 {
        let mut total = 0.0f32;
        for r in runs {
            let a = from.max(r.start);
            let b = to.min(r.end);
            if a >= b {
                continue;
            }
            let upem = state.fonts.get(r.font as usize).map_or(1000.0, |f| f.upem);
            let units = width_units(state, r.font, &text[a..b]);
            total += units as f32 * r.size / upem;
        }
        total
    }

    fn is_space(u: u16) -> bool {
        u == 0x20 || u == 0x09 || u == 0x3000
    }

    /// One line of the result: `[start, end)` in UTF-16 units, its width without trailing spaces.
    pub(crate) struct Line {
        pub(crate) start: usize,
        pub(crate) end: usize,
        pub(crate) width: f32,
        pub(crate) hyphenated: bool,
        pub(crate) mandatory: bool,
    }

    /// A break opportunity: a line may end before `at` (UTF-16 offset).
    struct Opportunity {
        at: usize,
        mandatory: bool,
    }

    fn opportunities(text: &[u16]) -> Vec<Opportunity> {
        let s: String = char::decode_utf16(text.iter().copied())
            .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect();
        // Byte offset to UTF-16 offset.
        let mut map = Vec::with_capacity(s.len() + 1);
        let mut u = 0usize;
        for c in s.chars() {
            for _ in 0..c.len_utf8() {
                map.push(u);
            }
            u += c.len_utf16();
        }
        map.push(u);
        linebreaks(&s)
            .map(|(byte, kind)| Opportunity {
                at: map[byte],
                mandatory: kind == BreakOpportunity::Mandatory,
            })
            .collect()
    }

    /// Hyphenation points (UTF-16 offsets inside `[start, end)`) of the word at the start of the
    /// piece, by TeX patterns. Only words of five or more letters are hyphenated.
    fn hyphen_points(text: &[u16], start: usize, end: usize) -> Vec<usize> {
        let mut word_end = start;
        while word_end < end && !is_space(text[word_end]) {
            word_end += 1;
        }
        let word: String = char::decode_utf16(text[start..word_end].iter().copied())
            .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect();
        if word.chars().count() < 5 || !word.chars().all(char::is_alphabetic) {
            return Vec::new();
        }
        let mut points = Vec::new();
        let mut at = start;
        let syllables: Vec<&str> = hypher::hyphenate(&word, hypher::Lang::English).collect();
        for (i, syl) in syllables.iter().enumerate() {
            at += syl.encode_utf16().count();
            if i + 1 < syllables.len() {
                points.push(at);
            }
        }
        points
    }

    const EPSILON: f32 = 1e-3;

    /// First-fit line breaking (02 §9.3) over UAX #14 opportunities. Trailing spaces hang: they do
    /// not count towards the fit. A piece wider than the line on an empty line overflows. With
    /// `hyphenate`, a word that does not fit is split at the last TeX-pattern hyphenation point
    /// whose prefix and a hyphen still fit.
    pub(crate) fn break_paragraph(
        state: &mut State,
        runs: &[Run],
        text: &[u16],
        width: f32,
        hyphenate: bool,
    ) -> Vec<Line> {
        let ops = opportunities(text);
        let hyphen_run = runs.first().copied();
        let hyphen: Vec<u16> = vec![0x2d];
        let mut lines = Vec::new();
        let mut line_start = 0usize;
        // Width of the line so far including trailing spaces, and without them.
        let mut full = 0.0f32;
        let mut content = 0.0f32;
        let mut seg_start = 0usize;
        for op in ops {
            let mut piece_start = seg_start;
            let piece_end = op.at;
            seg_start = op.at;
            loop {
                let mut core_end = piece_end;
                while core_end > piece_start && is_space(text[core_end - 1]) {
                    core_end -= 1;
                }
                let core = width_pt(state, runs, text, piece_start, core_end);
                let whole = core + width_pt(state, runs, text, core_end, piece_end);
                if piece_start > line_start && full + core > width + EPSILON {
                    let mut split = None;
                    if hyphenate {
                        if let Some(hr) = hyphen_run {
                            let upem = state.fonts.get(hr.font as usize).map_or(1000.0, |f| f.upem);
                            let hyph_w = width_units(state, hr.font, &hyphen) as f32 * hr.size / upem;
                            for p in hyphen_points(text, piece_start, core_end).into_iter().rev() {
                                let w = width_pt(state, runs, text, piece_start, p);
                                if full + w + hyph_w <= width + EPSILON {
                                    split = Some((p, full + w + hyph_w));
                                    break;
                                }
                            }
                        }
                    }
                    if let Some((p, w)) = split {
                        lines.push(Line { start: line_start, end: p, width: w, hyphenated: true, mandatory: false });
                        line_start = p;
                        piece_start = p;
                    } else {
                        lines.push(Line { start: line_start, end: piece_start, width: content, hyphenated: false, mandatory: false });
                        line_start = piece_start;
                    }
                    full = 0.0;
                    content = 0.0;
                    continue;
                }
                content = full + core;
                full += whole;
                break;
            }
            if op.mandatory {
                lines.push(Line { start: line_start, end: op.at, width: content, hyphenated: false, mandatory: true });
                line_start = op.at;
                full = 0.0;
                content = 0.0;
            }
        }
        lines
    }
}

/// The functions the host calls. Pointers are offsets into the module's memory.
#[allow(unsafe_code)]
mod exports {
    use super::*;

    /// Makes the input buffer `len` bytes long and returns where it starts.
    #[no_mangle]
    pub extern "C" fn tk_input(len: u32) -> u32 {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            s.input.clear();
            s.input.resize(len as usize, 0);
            s.input.as_mut_ptr() as usize as u32
        })
    }

    #[no_mangle]
    pub extern "C" fn tk_output_ptr() -> u32 {
        STATE.with(|s| s.borrow_mut().output.as_mut_ptr() as usize as u32)
    }

    #[no_mangle]
    pub extern "C" fn tk_output_len() -> u32 {
        STATE.with(|s| s.borrow().output.len() as u32)
    }

    /// Parses the input buffer as a font file (face 0) and keeps it; returns its identifier or -1.
    /// The buffer's bytes move into the font, so the module holds one copy of each file.
    #[no_mangle]
    pub extern "C" fn tk_font_load() -> i32 {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            let bytes = std::mem::take(&mut s.input);
            match Font::new(bytes, 0) {
                Some(font) => {
                    let upem = f32::from(font.units_per_em());
                    s.fonts.push(LoadedFont { font, upem });
                    (s.fonts.len() - 1) as i32
                }
                None => -1,
            }
        })
    }

    #[no_mangle]
    pub extern "C" fn tk_font_upem(font: u32) -> u32 {
        STATE.with(|s| s.borrow().fonts.get(font as usize).map_or(0, |f| f.upem as u32))
    }

    /// Shapes the input buffer (UTF-16LE text). Output: per glyph, glyph id, cluster (UTF-16
    /// offset), x advance and x offset in font units, as four 32-bit integers. Returns the number
    /// of glyphs, or -1 when the font is unknown or shaping fails.
    #[no_mangle]
    pub extern "C" fn tk_shape(font: u32, flags: u32) -> i32 {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            let units = s.input.len() / 2;
            let text = utf16_of(&s.input, 0, units);
            let Some(f) = s.fonts.get(font as usize) else { return -1 };
            let Some(buffer) = shape_utf16(&f.font, &text, flags) else { return -1 };
            let mut out = Vec::with_capacity(buffer.len() * 16);
            for (info, pos) in buffer.glyph_infos().iter().zip(buffer.glyph_positions()) {
                put_u32(&mut out, info.glyph_id);
                put_u32(&mut out, info.cluster);
                put_i32(&mut out, pos.x_advance);
                put_i32(&mut out, pos.x_offset);
            }
            s.output = out;
            buffer.len() as i32
        })
    }

    /// The advance width of the input text (UTF-16LE) in font units, through the segment cache.
    #[no_mangle]
    pub extern "C" fn tk_width(font: u32) -> i32 {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            let units = s.input.len() / 2;
            let text = utf16_of(&s.input, 0, units);
            width_units(&mut s, font, &text)
        })
    }

    /// Breaks one paragraph. Input, little-endian: run count, text length in UTF-16 units, line
    /// width in points, hyphenation flag, then per run font id, size in points, start and end,
    /// then the text. Output: per line start, end, width in points and flags (bit 0 hyphenated,
    /// bit 1 mandatory break). Returns the number of lines.
    #[cfg(feature = "kernel")]
    #[no_mangle]
    pub extern "C" fn tk_break() -> u32 {
        use super::kernel::{break_paragraph, put_f32, read_f32, Run};
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            let b = std::mem::take(&mut s.input);
            let n_runs = read_u32(&b, 0) as usize;
            let len = read_u32(&b, 4) as usize;
            let width = read_f32(&b, 8);
            let hyphenate = read_u32(&b, 12) != 0;
            let mut runs = Vec::with_capacity(n_runs);
            for i in 0..n_runs {
                let at = 16 + i * 16;
                runs.push(Run {
                    font: read_u32(&b, at),
                    size: read_f32(&b, at + 4),
                    start: read_u32(&b, at + 8) as usize,
                    end: read_u32(&b, at + 12) as usize,
                });
            }
            let text = utf16_of(&b, 16 + n_runs * 16, len);
            s.input = b;
            let lines = break_paragraph(&mut s, &runs, &text, width, hyphenate);
            let mut out = Vec::with_capacity(lines.len() * 16);
            for l in &lines {
                put_u32(&mut out, l.start as u32);
                put_u32(&mut out, l.end as u32);
                put_f32(&mut out, l.width);
                put_u32(&mut out, u32::from(l.hyphenated) | (u32::from(l.mandatory) << 1));
            }
            s.output = out;
            lines.len() as u32
        })
    }

    /// Empties the segment cache (a cold start for measurements).
    #[no_mangle]
    pub extern "C" fn tk_cache_clear() {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            s.widths.clear();
            s.shaped = 0;
            s.cache_hits = 0;
        })
    }

    /// Writes the counters (segments shaped, cache hits, cache entries) to the output buffer.
    #[no_mangle]
    pub extern "C" fn tk_stats() -> u32 {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            let mut out = Vec::new();
            put_u32(&mut out, s.shaped as u32);
            put_u32(&mut out, s.cache_hits as u32);
            put_u32(&mut out, s.widths.len() as u32);
            s.output = out;
            3
        })
    }
}
