//! Unicode segmentation (WASM-007; 02 §9.3, §9.6): the line-break opportunities of UAX #14 and the
//! grapheme cluster boundaries of UAX #29, in UTF-16 code units, the offsets of the layout tree
//! (09 §7.1).
//!
//! Two crates carry the algorithms and their data, each pinned to an exact version in
//! `Cargo.toml`: `unicode-linebreak` (UAX #14) and `unicode-segmentation` (UAX #29). They implement
//! different versions of Unicode, and the kernel records both (`LINE_BREAK_UNICODE` and
//! `GRAPHEME_UNICODE`): upgrading either is a deliberate change that re-runs the conformance tests
//! of `tests/segmentation.rs` against the matching test files in `tests/data/`.
//!
//! The functions take UTF-16 text, as the layout engine and the browsers hold it. A lone surrogate
//! is read as U+FFFD, which is one unit as well, so every offset stays an offset of the caller's
//! text. A break or boundary is never reported inside a surrogate pair.
//!
//! # Line breaking: what the crate does, and what is added here
//!
//! `unicode-linebreak` 0.1.5 runs the pair table of the default algorithm of Unicode 15.0.0. The
//! Unicode Consortium's test file for that version (`LineBreakTest.txt`) expects three things the
//! crate does not do, and `correct` adds them, so that the kernel passes every case of the file:
//!
//! - **Numbers (LB25).** The test file follows the rules of Example 7 in section 8.2 of UAX #14
//!   (its header says so), which look at a whole number and not only at a pair of characters:
//!   `(PR | PO) × (OP | HY)? NU`, `(OP | HY) × NU`, `NU × (NU | SY | IS)`,
//!   `NU (NU | SY | IS)* × (NU | SY | IS | CL | CP)` and `NU (NU | SY | IS)* (CL | CP)? × (PO | PR)`.
//!   The crate keeps the pairs of the plain rule together wherever they stand. So a break is allowed
//!   here between a prefix or postfix and an opening bracket that no digit follows (`%(`), between a
//!   closing bracket and a prefix or postfix when no number precedes (`}%`), and between a separator
//!   and a digit when no number precedes (`a.2`); and none is allowed between a separator inside a
//!   number and a prefix or postfix (`1.%`).
//! - **Brackets of East Asian width (LB30).** A line may break between a letter or a number and an
//!   opening bracket whose East_Asian_Width is F, W or H (`dog（`); the crate does not read the
//!   width. Unicode 15.0.0 has no closing parenthesis (CP) of such a width, so the second half of
//!   the rule needs nothing (`scripts/segment-data.ts` fails if a later version has one).
//! - **Unassigned pictographs (LB30b).** No break between an unassigned Extended_Pictographic code
//!   point and an emoji modifier; the crate has no such class.
//!
//! The two tables these need are generated into `segment_data.rs` from the Unicode Character
//! Database of the same version. One tailoring of the crate stays: a character of class SA (Thai,
//! Lao, Khmer and the like) is taken as AL whatever its General_Category, where the default rule
//! LB1 takes a combining mark of that class as CM. No break is found inside such text (that needs a
//! dictionary), and no rule of a language is applied: East Asian and South-East Asian rules are
//! WASM-016.

use unicode_linebreak::BreakClass::{
    Alphabetic as AL, Ambiguous as AI, CarriageReturn as CR, CloseParenthesis as CP,
    ClosePunctuation as CL, CombiningMark as CM, ComplexContext as SA,
    ConditionalJapaneseStarter as CJ, EmojiModifier as EM, HebrewLetter as HL,
    InfixSeparator as IS, LineFeed as LF, Mandatory as BK, NextLine as NL, NonStarter as NS,
    Numeric as NU, OpenPunctuation as OP, Postfix as PO, Prefix as PR, Space as SP,
    Surrogate as SG, Symbol as SY, Unknown as XX, ZeroWidthJoiner as ZWJ, ZeroWidthSpace as ZW,
};
use unicode_linebreak::{break_property, linebreaks, BreakClass, BreakOpportunity};
use unicode_segmentation::UnicodeSegmentation;

use crate::segment_data::{EAST_ASIAN_OPEN, EXTPICT_UNASSIGNED};

/// The Unicode version that `unicode-linebreak` implements (UAX #14), as `(major, minor, update)`.
/// The tables of `segment_data.rs` are of the same version (a test compares them).
pub const LINE_BREAK_UNICODE: (u8, u8, u8) = unicode_linebreak::UNICODE_VERSION;

/// The Unicode version that `unicode-segmentation` implements (UAX #29), as `(major, minor, update)`.
pub const GRAPHEME_UNICODE: (u64, u64, u64) = unicode_segmentation::UNICODE_VERSION;

/// No opportunity, an allowed break and a mandatory break before a character.
const NONE: u8 = 0;
const ALLOWED: u8 = 1;
const MANDATORY: u8 = 2;

/// The text as a `String` (a lone surrogate is U+FFFD) and, for each byte offset of the string
/// where a character starts, its UTF-16 offset: `starts` holds `(byte, utf16)` pairs in ascending
/// order, one for each character, with the end of the text as the last pair.
fn decode(text: &[u16]) -> (String, Vec<(usize, u32)>) {
    let mut s = String::with_capacity(text.len());
    let mut starts = Vec::with_capacity(text.len() + 1);
    let mut utf16 = 0u32;
    for decoded in char::decode_utf16(text.iter().copied()) {
        let c = decoded.unwrap_or(char::REPLACEMENT_CHARACTER);
        starts.push((s.len(), utf16));
        s.push(c);
        // A character is one or two UTF-16 units; `len_utf16` is never more than 2.
        utf16 += u32::try_from(c.len_utf16()).unwrap_or(1);
    }
    starts.push((s.len(), utf16));
    (s, starts)
}

/// The index in `starts` of the character that starts at `byte`. `from` is where to start looking
/// and is moved on, because the offsets asked for ascend.
fn index_at(starts: &[(usize, u32)], from: &mut usize, byte: usize) -> usize {
    while *from + 1 < starts.len() && starts[*from].0 < byte {
        *from += 1;
    }
    *from
}

/// Whether `c` is in one of the ascending ranges `(first, last)`.
fn in_ranges(ranges: &[(u32, u32)], c: char) -> bool {
    let cp = u32::from(c);
    let at = ranges.partition_point(|&(_, last)| last < cp);
    matches!(ranges.get(at), Some(&(first, _)) if first <= cp)
}

/// The line breaking class of a character as the crate's pair table takes it (rule LB1): the
/// classes AI, SG, XX and SA are AL, and CJ is NS.
fn class_of(c: char) -> BreakClass {
    match break_property(u32::from(c)) {
        AI | SG | XX | SA => AL,
        CJ => NS,
        class => class,
    }
}

/// Changes what the crate found into what the test file of Unicode 15.0.0 expects (see the head of
/// this file). `found[i]` is the opportunity before character `i`, and `found[chars.len()]` the
/// one at the end of the text.
///
/// The rules that are added compare two neighbours after rule LB9 has joined every combining mark
/// and zero width joiner to the character before it (and LB10 has made a mark that has no such
/// character an AL), so the text is first cut into those units. A break is only ever allowed here
/// where no rule above LB25 forbids one for the pair in question; the one such rule that looks at
/// the single character before the break and not at the unit is LB8a (no break after a zero width
/// joiner), which is kept.
fn correct(chars: &[char], found: &mut [u8]) {
    let classes: Vec<BreakClass> = chars.iter().map(|&c| class_of(c)).collect();
    // Each unit: its class, and the index of its first character.
    let mut units: Vec<(BreakClass, usize)> = Vec::with_capacity(chars.len());
    for (i, &class) in classes.iter().enumerate() {
        if matches!(class, CM | ZWJ) {
            let joins = i > 0 && !matches!(classes[i - 1], BK | CR | LF | NL | SP | ZW);
            if !joins {
                units.push((AL, i));
            }
        } else {
            units.push((class, i));
        }
    }
    // Whether a unit ends `NU (NU | SY | IS)*`: the part of a number that the rules look back at.
    let mut in_number = vec![false; units.len()];
    for (u, &(class, _)) in units.iter().enumerate() {
        in_number[u] = class == NU || (matches!(class, SY | IS) && u > 0 && in_number[u - 1]);
    }
    for u in 1..units.len() {
        let (before, base) = units[u - 1];
        let (after, at) = units[u];
        if classes[at - 1] == ZWJ {
            continue;
        }
        let allowed = match (before, after) {
            // LB30: only an opening bracket that is not of East Asian width stays with the word.
            (AL | HL | NU, OP) => in_ranges(EAST_ASIAN_OPEN, chars[at]),
            // (PR | PO) × (OP | HY)? NU: the bracket stays only when a digit follows it.
            (PR | PO, OP) => units.get(u + 1).map(|&(class, _)| class) != Some(NU),
            // NU (NU | SY | IS)* (CL | CP)? × (PO | PR): the bracket must close a number.
            (CL | CP, PO | PR) => !(u >= 2 && in_number[u - 2]),
            // NU (NU | SY | IS)* × NU: the separator must be inside a number.
            (IS | SY, NU) => !in_number[u - 1],
            _ => false,
        };
        if allowed && found[at] == NONE {
            found[at] = ALLOWED;
        }
        let forbidden = match (before, after) {
            // NU (NU | SY | IS)* × (PO | PR), where the plain rule knows only NU × (PO | PR).
            (IS | SY, PO | PR) => in_number[u - 1],
            // LB30b: [\p{Extended_Pictographic}&\p{Cn}] × EM.
            (_, EM) => in_ranges(EXTPICT_UNASSIGNED, chars[base]),
            _ => false,
        };
        if forbidden && found[at] == ALLOWED {
            found[at] = NONE;
        }
    }
}

/// The line-break opportunities of `text` by UAX #14, as pairs `[offset, mandatory]` for each
/// opportunity, ascending: the UTF-16 offset of the first unit after the break, and 1 when the
/// break is mandatory (after a hard line break, and at the end of the text) or 0 when it is
/// allowed. The end of a non-empty text is always the last opportunity (rule LB3). An empty text
/// has none.
#[must_use]
pub fn line_breaks(text: &[u16]) -> Vec<u32> {
    let (s, starts) = decode(text);
    let chars: Vec<char> = s.chars().collect();
    let mut found = vec![NONE; chars.len() + 1];
    let mut from = 0usize;
    for (byte, kind) in linebreaks(&s) {
        let mandatory = kind == BreakOpportunity::Mandatory;
        found[index_at(&starts, &mut from, byte)] = if mandatory { MANDATORY } else { ALLOWED };
    }
    correct(&chars, &mut found);
    let mut out = Vec::new();
    for (i, &kind) in found.iter().enumerate() {
        if kind != NONE {
            out.push(starts[i].1);
            out.push(u32::from(kind == MANDATORY));
        }
    }
    out
}

/// The grapheme cluster boundaries of `text` by UAX #29 (extended grapheme clusters), ascending,
/// as UTF-16 offsets: the start of the text, the start of every cluster after the first, and the
/// end of the text. An empty text has one, 0.
#[must_use]
pub fn grapheme_boundaries(text: &[u16]) -> Vec<u32> {
    let (s, starts) = decode(text);
    let mut out = Vec::new();
    let mut from = 0usize;
    for (byte, _) in s.grapheme_indices(true) {
        out.push(starts[index_at(&starts, &mut from, byte)].1);
    }
    let end = starts.last().map_or(0, |&(_, utf16)| utf16);
    if out.last() != Some(&end) {
        out.push(end);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    /// The offsets of the opportunities of `s`, without the kind of each.
    fn offsets(s: &str) -> Vec<u32> {
        line_breaks(&units(s))
            .chunks_exact(2)
            .map(|pair| pair[0])
            .collect()
    }

    #[test]
    fn finds_the_break_after_a_space_and_the_end() {
        assert_eq!(line_breaks(&units("Hello world!")), vec![6, 0, 12, 1]);
    }

    #[test]
    fn an_empty_text_has_no_opportunity_and_one_boundary() {
        assert!(line_breaks(&[]).is_empty());
        assert_eq!(grapheme_boundaries(&[]), vec![0]);
    }

    #[test]
    fn a_hard_line_break_is_mandatory() {
        assert_eq!(line_breaks(&units("a\nb")), vec![2, 1, 3, 1]);
    }

    #[test]
    fn offsets_are_utf16_units_after_a_surrogate_pair() {
        // U+1F600 is two units; the space after it is at unit 2, the break after the space at 3.
        let text = units("\u{1F600} x");
        assert_eq!(text.len(), 4);
        assert_eq!(line_breaks(&text), vec![3, 0, 4, 1]);
        assert_eq!(grapheme_boundaries(&text), vec![0, 2, 3, 4]);
    }

    #[test]
    fn a_lone_surrogate_is_one_unit_and_never_splits_the_rest() {
        let text = [0x61u16, 0xD800, 0x62];
        assert_eq!(grapheme_boundaries(&text), vec![0, 1, 2, 3]);
        assert_eq!(line_breaks(&text), vec![3, 1]);
    }

    #[test]
    fn a_combining_mark_stays_with_its_base() {
        // "e" and U+0301 are one cluster; "x" is another.
        assert_eq!(grapheme_boundaries(&units("e\u{301}x")), vec![0, 2, 3]);
    }

    #[test]
    fn a_family_emoji_is_one_cluster() {
        let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
        let text = units(family);
        assert_eq!(grapheme_boundaries(&text), vec![0, 8]);
    }

    #[test]
    fn a_regional_indicator_pair_is_one_cluster_and_a_third_starts_another() {
        let flags = units("\u{1F1E9}\u{1F1EA}\u{1F1EB}");
        assert_eq!(grapheme_boundaries(&flags), vec![0, 4, 6]);
    }

    #[test]
    fn crlf_is_one_cluster() {
        assert_eq!(grapheme_boundaries(&units("a\r\nb")), vec![0, 1, 3, 4]);
    }

    #[test]
    fn records_both_unicode_versions() {
        assert_eq!(LINE_BREAK_UNICODE, (15, 0, 0));
        assert_eq!(GRAPHEME_UNICODE, (17, 0, 0));
    }

    #[test]
    fn the_generated_tables_are_of_the_version_the_line_break_crate_implements() {
        let (major, minor, update) = LINE_BREAK_UNICODE;
        assert_eq!(
            crate::segment_data::UNICODE_VERSION,
            format!("{major}.{minor}.{update}")
        );
        // Every bracket of the table is opening punctuation for the crate too, and the ranges
        // ascend without touching, which the search relies on.
        for table in [EAST_ASIAN_OPEN, EXTPICT_UNASSIGNED] {
            for pair in table.windows(2) {
                assert!(pair[0].1 < pair[1].0);
            }
            assert!(table.iter().all(|&(first, last)| first <= last));
        }
        for &(first, last) in EAST_ASIAN_OPEN {
            for cp in first..=last {
                assert_eq!(break_property(cp), OP, "U+{cp:04X}");
            }
        }
        assert!(in_ranges(EAST_ASIAN_OPEN, '\u{FF08}'));
        assert!(!in_ranges(EAST_ASIAN_OPEN, '('));
        assert!(in_ranges(EXTPICT_UNASSIGNED, '\u{1FFFD}'));
        assert!(!in_ranges(EXTPICT_UNASSIGNED, '\u{1F600}'));
    }

    #[test]
    fn a_line_may_break_before_an_opening_bracket_of_east_asian_width() {
        // LB30: the fullwidth parenthesis is wide, the ASCII one is not.
        assert_eq!(offsets("dog\u{FF08}x"), vec![3, 5]);
        assert_eq!(offsets("dog(x"), vec![5]);
        assert_eq!(offsets("12\u{300C}x"), vec![2, 4]);
        // A combining mark belongs to the letter (LB9); a joiner forbids the break (LB8a).
        assert_eq!(offsets("a\u{308}\u{FF08}x"), vec![2, 4]);
        assert_eq!(offsets("a\u{200D}\u{FF08}x"), vec![4]);
        // After a space the break was always there, and after a quotation mark there is none.
        assert_eq!(offsets("a \u{FF08}x"), vec![2, 4]);
        assert_eq!(offsets("\"\u{FF08}x"), vec![3]);
    }

    #[test]
    fn a_number_is_kept_whole_and_its_neighbours_are_not() {
        // Inside a number nothing changes: separators, a closing bracket and a postfix stay.
        assert_eq!(offsets("1,234.56%"), vec![9]);
        assert_eq!(offsets("(12)% x"), vec![6, 7]);
        assert_eq!(offsets("$(12) x"), vec![6, 7]);
        assert_eq!(offsets("$-5 x"), vec![4, 5]);
        // A separator that no number precedes does not hold the digit after it.
        assert_eq!(offsets("a.2"), vec![2, 3]);
        assert_eq!(offsets("a/2"), vec![2, 3]);
        assert_eq!(offsets("1.2"), vec![3]);
        assert_eq!(offsets("1/2"), vec![3]);
        // A closing bracket that closes no number does not hold a postfix or a prefix.
        assert_eq!(offsets("}%"), vec![1, 2]);
        assert_eq!(offsets("a)$"), vec![2, 3]);
        assert_eq!(offsets("1}%"), vec![3]);
        // A prefix or postfix holds an opening bracket only when a digit follows the bracket.
        assert_eq!(offsets("%(a"), vec![1, 3]);
        assert_eq!(offsets("%(1"), vec![3]);
        assert_eq!(offsets("\\(s\\)"), vec![1, 5]);
        // A separator inside a number holds the postfix after it; outside a number it does not.
        assert_eq!(offsets("1.%"), vec![3]);
        assert_eq!(offsets("1,,$"), vec![4]);
        assert_eq!(offsets("a.%"), vec![2, 3]);
        // Marks join their base before the rules look (LB9), and a space ends a number.
        assert_eq!(offsets("a.\u{308}2"), vec![3, 4]);
        assert_eq!(offsets("1\u{308}.\u{308}2"), vec![5]);
        assert_eq!(offsets("1 .2"), vec![3, 4]);
        // No break after a zero width joiner, whatever the pair (LB8a).
        assert_eq!(offsets("a.\u{200D}2"), vec![4]);
    }

    #[test]
    fn an_emoji_modifier_stays_with_an_unassigned_pictograph() {
        // LB30b: U+1F02C is unassigned and Extended_Pictographic; U+4E00 is an ideograph.
        assert_eq!(offsets("\u{1F02C}\u{1F3FF}"), vec![4]);
        assert_eq!(offsets("\u{1F02C}\u{308}\u{1F3FF}"), vec![5]);
        assert_eq!(offsets("\u{4E00}\u{1F3FF}"), vec![1, 3]);
    }
}
