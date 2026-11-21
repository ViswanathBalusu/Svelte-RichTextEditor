//! The Unicode conformance tests of the kernel's segmentation (WASM-007).
//!
//! `LineBreakTest.txt` (Unicode 15.0.0, the version `unicode-linebreak` 0.1.5 implements) and
//! `GraphemeBreakTest.txt` (Unicode 17.0.0, the version `unicode-segmentation` 1.13.3 implements)
//! are the Unicode Consortium's files, kept as downloaded in `tests/data/` (see `SOURCES.json`).
//! Each line is a string of code points with `÷` where a boundary is and `×` where there is none.
//! The kernel's answer is in UTF-16 offsets, so the expected boundaries are turned into offsets
//! too, which also tests the mapping from the crate's byte offsets for characters outside the BMP.
//!
//! The kernel's line breaking is the crate's pair table with three corrections (`segment.rs`). The
//! test file shows a few hundred pairs of characters and a few dozen longer strings, which is thin
//! for rules that look at a whole number. So this file also holds a second implementation, written
//! rule by rule from the text of UAX #14 (`reference`), and compares the two on random text.

use docedit_layout_kernel::segment::{
    grapheme_boundaries, line_breaks, GRAPHEME_UNICODE, LINE_BREAK_UNICODE,
};

/// One case of a test file: its UTF-16 text and the UTF-16 offsets of its `÷` marks.
struct Case {
    line: usize,
    text: Vec<u16>,
    breaks: Vec<u32>,
}

/// The cases of a test file: a line is `[÷×] code point ([÷×] code point)* [÷×]`, then a comment.
fn cases(file: &str) -> Vec<Case> {
    let mut out = Vec::new();
    for (index, raw) in file.lines().enumerate() {
        let body = raw.split('#').next().unwrap_or("").trim();
        if body.is_empty() {
            continue;
        }
        let mut text: Vec<u16> = Vec::new();
        let mut breaks = Vec::new();
        for token in body.split_whitespace() {
            match token {
                "÷" => breaks.push(u32::try_from(text.len()).expect("offset")),
                "×" => {}
                hex => {
                    let value = u32::from_str_radix(hex, 16).expect("a code point in hex");
                    let c = char::from_u32(value).expect("a scalar value");
                    let mut buffer = [0u16; 2];
                    text.extend_from_slice(c.encode_utf16(&mut buffer));
                }
            }
        }
        out.push(Case {
            line: index + 1,
            text,
            breaks,
        });
    }
    out
}

/// The unicode version in the header's first line, `# LineBreakTest-15.0.0.txt`.
fn header_version(file: &str) -> String {
    let first = file.lines().next().unwrap_or("");
    first
        .trim_start_matches('#')
        .trim()
        .rsplit('-')
        .next()
        .unwrap_or("")
        .trim_end_matches(".txt")
        .to_string()
}

fn version_text(v: (u64, u64, u64)) -> String {
    format!("{}.{}.{}", v.0, v.1, v.2)
}

const LINE_BREAK_TEST: &str = include_str!("data/unicode-15.0.0/LineBreakTest.txt");
const GRAPHEME_BREAK_TEST: &str = include_str!("data/unicode-17.0.0/GraphemeBreakTest.txt");

/// The text of a case as characters (the test files hold no lone surrogate).
fn chars_of(text: &[u16]) -> Vec<char> {
    char::decode_utf16(text.iter().copied())
        .map(|c| c.expect("a scalar value"))
        .collect()
}

/// The kernel's opportunities as `(UTF-16 offset, mandatory)`.
fn kernel(text: &[u16]) -> Vec<(u32, bool)> {
    line_breaks(text)
        .chunks_exact(2)
        .map(|pair| (pair[0], pair[1] == 1))
        .collect()
}

/// The reference's opportunities as `(UTF-16 offset, mandatory)`.
fn reference_offsets(chars: &[char]) -> Vec<(u32, bool)> {
    let mut starts = Vec::with_capacity(chars.len() + 1);
    let mut utf16 = 0u32;
    for c in chars {
        starts.push(utf16);
        utf16 += u32::try_from(c.len_utf16()).expect("1 or 2");
    }
    starts.push(utf16);
    reference::breaks(chars)
        .into_iter()
        .map(|(index, mandatory)| (starts[index], mandatory))
        .collect()
}

#[test]
fn the_test_files_are_the_versions_the_crates_implement() {
    let (a, b, c) = LINE_BREAK_UNICODE;
    assert_eq!(
        header_version(LINE_BREAK_TEST),
        version_text((u64::from(a), u64::from(b), u64::from(c)))
    );
    assert_eq!(
        header_version(GRAPHEME_BREAK_TEST),
        version_text(GRAPHEME_UNICODE)
    );
}

/// The lines of a break test on which `got` does not give the file's answer. The test file marks
/// the start of the text with `×` (LB2), so only later `÷` are opportunities; the end of the text
/// is always one (LB3).
fn line_break_failures(got: impl Fn(&Case) -> Vec<u32>) -> (usize, Vec<String>) {
    let all = cases(LINE_BREAK_TEST);
    let mut failures = Vec::new();
    for case in &all {
        let expected: Vec<u32> = case.breaks.iter().copied().filter(|&o| o > 0).collect();
        let got = got(case);
        if got != expected {
            failures.push(format!(
                "line {}: expected {expected:?}, got {got:?}, text {:04x?}",
                case.line, case.text
            ));
        }
    }
    (all.len(), failures)
}

#[test]
fn line_breaks_pass_the_unicode_line_break_test() {
    let (count, failures) =
        line_break_failures(|case| kernel(&case.text).iter().map(|&(o, _)| o).collect());
    assert!(count > 7000, "the file was read: {count} cases");
    assert!(
        failures.is_empty(),
        "{} of {count} cases failed, the first ones:\n{}",
        failures.len(),
        failures
            .iter()
            .take(10)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn the_reference_passes_the_unicode_line_break_test() {
    let (count, failures) = line_break_failures(|case| {
        reference_offsets(&chars_of(&case.text))
            .iter()
            .map(|&(o, _)| o)
            .collect()
    });
    assert!(
        failures.is_empty(),
        "{} of {count} cases failed, the first ones:\n{}",
        failures.len(),
        failures
            .iter()
            .take(10)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// Characters that cover every line breaking class, the classes the crate resolves (AI, CJ, SA,
/// XX), and both sides of each table of `segment_data.rs`. The classes that numbers are made of
/// and the marks that join their base are listed more than once, so that random text meets them
/// more often.
const POOL: &[char] = &[
    '\u{000B}',  // BK
    '\u{000D}',  // CR
    '\u{000A}',  // LF
    '\u{0085}',  // NL
    '\u{0020}',  // SP
    '\u{0020}',  // SP
    '\u{200B}',  // ZW
    '\u{200D}',  // ZWJ
    '\u{0308}',  // CM
    '\u{0308}',  // CM
    '\u{2060}',  // WJ
    '\u{00A0}',  // GL
    '\u{2014}',  // B2
    '\u{2010}',  // BA
    '\u{00B4}',  // BB
    '\u{002D}',  // HY
    '\u{FFFC}',  // CB
    '\u{007D}',  // CL
    '\u{3001}',  // CL (wide)
    '\u{0029}',  // CP
    '\u{0029}',  // CP
    '\u{0021}',  // EX
    '\u{2024}',  // IN
    '\u{30FB}',  // NS
    '\u{0028}',  // OP
    '\u{0028}',  // OP
    '\u{FF08}',  // OP (East Asian width F)
    '\u{300C}',  // OP (East Asian width W)
    '\u{FF62}',  // OP (East Asian width H)
    '\u{0022}',  // QU
    '\u{002C}',  // IS
    '\u{002E}',  // IS
    '\u{0030}',  // NU
    '\u{0037}',  // NU
    '\u{0039}',  // NU
    '\u{0025}',  // PO
    '\u{0025}',  // PO
    '\u{0024}',  // PR
    '\u{005C}',  // PR
    '\u{002F}',  // SY
    '\u{002F}',  // SY
    '\u{00A7}',  // AI
    '\u{0061}',  // AL
    '\u{0041}',  // AL
    '\u{3041}',  // CJ
    '\u{261D}',  // EB
    '\u{1F3FB}', // EM
    '\u{1F3FB}', // EM
    '\u{AC00}',  // H2
    '\u{AC01}',  // H3
    '\u{05D0}',  // HL
    '\u{4E00}',  // ID
    '\u{1F600}', // ID (an assigned pictograph)
    '\u{1100}',  // JL
    '\u{1160}',  // JV
    '\u{11A8}',  // JT
    '\u{1F1E6}', // RI
    '\u{1F1E7}', // RI
    '\u{0E01}',  // SA (a letter)
    '\u{0E31}',  // SA (a combining mark, which the crate takes as AL)
    '\u{E000}',  // XX
    '\u{1F02C}', // ID, unassigned and Extended_Pictographic
    '\u{1FFFD}', // ID, unassigned and Extended_Pictographic
    '\u{1F0A0}', // ID, an assigned pictograph beside an unassigned one
];

/// A small generator of pseudo-random numbers (xorshift64*), so that the run is the same each time.
struct Random(u64);

impl Random {
    fn draw(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        usize::try_from(self.draw() % u64::try_from(n).expect("a small number")).expect("small")
    }
}

#[test]
fn the_pool_has_a_character_of_every_class_but_the_surrogates() {
    use unicode_linebreak::{break_property, BreakClass};
    // The classes are numbered 0 to 42 in the order of the crate's enum, `Unknown` (XX) last. A
    // string of characters cannot hold a surrogate (SG); the kernel reads one as U+FFFD.
    assert_eq!(BreakClass::Unknown as u8, 42);
    let mut seen = [false; 43];
    for &c in POOL {
        seen[usize::from(break_property(u32::from(c)) as u8)] = true;
    }
    let missing: Vec<usize> = (0..43).filter(|&class| !seen[class]).collect();
    assert_eq!(missing, vec![usize::from(BreakClass::Surrogate as u8)]);
}

#[test]
fn the_kernel_and_the_reference_agree_on_random_text() {
    let mut random = Random(0x9E37_79B9_7F4A_7C15);
    let mut opportunities = 0usize;
    for round in 0..300_000 {
        let length = 1 + random.below(12);
        let chars: Vec<char> = (0..length)
            .map(|_| POOL[random.below(POOL.len())])
            .collect();
        let mut text: Vec<u16> = Vec::new();
        for c in &chars {
            let mut buffer = [0u16; 2];
            text.extend_from_slice(c.encode_utf16(&mut buffer));
        }
        let mine = kernel(&text);
        let theirs = reference_offsets(&chars);
        assert_eq!(
            mine,
            theirs,
            "round {round}: the kernel (left) and the reference (right) differ on {:04X?}",
            chars.iter().map(|&c| u32::from(c)).collect::<Vec<_>>()
        );
        opportunities += mine.len();
    }
    assert!(opportunities > 600_000, "{opportunities} opportunities");
}

#[test]
fn grapheme_boundaries_pass_the_unicode_grapheme_break_test() {
    let all = cases(GRAPHEME_BREAK_TEST);
    assert!(all.len() > 700, "the file was read: {} cases", all.len());
    let mut failures = Vec::new();
    for case in &all {
        let got = grapheme_boundaries(&case.text);
        if got != case.breaks {
            failures.push(format!(
                "line {}: expected {:?}, got {got:?}, text {:04x?}",
                case.line, case.breaks, case.text
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases failed, the first ones:\n{}",
        failures.len(),
        all.len(),
        failures
            .iter()
            .take(10)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

#[test]
fn every_boundary_of_the_grapheme_test_is_a_boundary_of_the_text_not_inside_a_pair() {
    for case in cases(GRAPHEME_BREAK_TEST) {
        for &offset in &grapheme_boundaries(&case.text) {
            let at = usize::try_from(offset).expect("offset");
            if let Some(&unit) = case.text.get(at) {
                assert!(
                    !(0xDC00..0xE000).contains(&unit),
                    "line {}: a boundary at {offset} is inside a surrogate pair",
                    case.line
                );
            }
        }
    }
}

/// The line breaking rules of UAX #14 for Unicode 15.0.0 (revision 49), one after the other as the
/// annex lists them, with the number rules of its Example 7 in place of LB25, which is what the
/// test file of that version follows. It is slow and plain on purpose: it looks back through the
/// text for each position where the kernel's crate runs a state machine. It shares with the kernel
/// the class of a character (`unicode_linebreak::break_property`) and the two tables of
/// `segment_data.rs`, and nothing else.
mod reference {
    use docedit_layout_kernel::segment_data::{EAST_ASIAN_OPEN, EXTPICT_UNASSIGNED};
    use unicode_linebreak::break_property;
    use unicode_linebreak::BreakClass::{
        self, After as BA, Alphabetic as AL, Ambiguous as AI, Before as BB, BeforeAndAfter as B2,
        CarriageReturn as CR, CloseParenthesis as CP, ClosePunctuation as CL, CombiningMark as CM,
        ComplexContext as SA, ConditionalJapaneseStarter as CJ, Contingent as CB, EmojiBase as EB,
        EmojiModifier as EM, Exclamation as EX, HangulLJamo as JL, HangulLvSyllable as H2,
        HangulLvtSyllable as H3, HangulTJamo as JT, HangulVJamo as JV, HebrewLetter as HL,
        Hyphen as HY, Ideographic as ID, InfixSeparator as IS, Inseparable as IN, LineFeed as LF,
        Mandatory as BK, NextLine as NL, NonBreakingGlue as GL, NonStarter as NS, Numeric as NU,
        OpenPunctuation as OP, Postfix as PO, Prefix as PR, Quotation as QU,
        RegionalIndicator as RI, Space as SP, Surrogate as SG, Symbol as SY, Unknown as XX,
        WordJoiner as WJ, ZeroWidthJoiner as ZWJ, ZeroWidthSpace as ZW,
    };

    fn listed(ranges: &[(u32, u32)], c: char) -> bool {
        let cp = u32::from(c);
        ranges
            .iter()
            .any(|&(first, last)| first <= cp && cp <= last)
    }

    /// The text with rules LB1, LB9 and LB10 applied.
    struct Text<'a> {
        chars: &'a [char],
        /// LB1, as the crate resolves it: AI, SG, XX and SA are AL (SA whatever its
        /// General_Category, the crate's tailoring), and CJ is NS.
        raw: Vec<BreakClass>,
        /// LB9: a combining mark or joiner that belongs to the character before it.
        joined: Vec<bool>,
        /// The class a character acts as: its base's when joined, AL for a mark that has no base
        /// (LB10), its own otherwise.
        acts: Vec<BreakClass>,
    }

    impl<'a> Text<'a> {
        fn new(chars: &'a [char]) -> Self {
            let raw: Vec<BreakClass> = chars
                .iter()
                .map(|&c| match break_property(u32::from(c)) {
                    AI | SG | XX | SA => AL,
                    CJ => NS,
                    class => class,
                })
                .collect();
            let mut joined = vec![false; chars.len()];
            let mut acts = raw.clone();
            for i in 0..chars.len() {
                if matches!(raw[i], CM | ZWJ) {
                    if i > 0 && !matches!(raw[i - 1], BK | CR | LF | NL | SP | ZW) {
                        joined[i] = true;
                        acts[i] = acts[i - 1];
                    } else {
                        acts[i] = AL;
                    }
                }
            }
            Text {
                chars,
                raw,
                joined,
                acts,
            }
        }

        /// The first character of the unit (a base and its marks) that holds character `i`.
        fn base(&self, mut i: usize) -> usize {
            while self.joined[i] {
                i -= 1;
            }
            i
        }

        /// The base of the unit before the unit whose base is `base`.
        fn unit_before(&self, base: usize) -> Option<usize> {
            base.checked_sub(1).map(|i| self.base(i))
        }

        /// The base of the unit after the unit that holds character `i`.
        fn unit_after(&self, i: usize) -> Option<usize> {
            (i + 1..self.chars.len()).find(|&j| !self.joined[j])
        }

        /// Whether the unit at `base` ends `NU (NU | SY | IS)*`.
        fn ends_a_number(&self, base: usize) -> bool {
            let mut at = Some(base);
            while let Some(unit) = at {
                match self.acts[unit] {
                    NU => return true,
                    SY | IS => at = self.unit_before(unit),
                    _ => return false,
                }
            }
            false
        }

        /// Whether a line may break before character `i` (0 < i < length), rule by rule.
        fn breaks_before(&self, i: usize) -> bool {
            let raw = &self.raw;
            // LB4, LB5: hard line breaks.
            if raw[i - 1] == BK {
                return true;
            }
            if raw[i - 1] == CR && raw[i] == LF {
                return false;
            }
            if matches!(raw[i - 1], CR | LF | NL) {
                return true;
            }
            // LB6, LB7: not before a hard line break, a space or a zero width space.
            if matches!(raw[i], BK | CR | LF | NL | SP | ZW) {
                return false;
            }
            // LB8: ZW SP* ÷. `last` is the last character before the spaces that precede `i`.
            let last = (0..i).rev().find(|&j| raw[j] != SP);
            if last.is_some_and(|j| raw[j] == ZW) {
                return true;
            }
            // LB8a: ZWJ ×.
            if raw[i - 1] == ZWJ {
                return false;
            }
            // LB9: not inside a unit.
            if self.joined[i] {
                return false;
            }
            let unit = self.base(i - 1);
            let a = self.acts[unit];
            let b = self.acts[i];
            // The class before the spaces that precede `i`, for the rules written `X SP* ×`.
            let spaced = last.map(|j| self.acts[j]);
            // LB11, LB12, LB12a: word joiner and glue.
            if a == WJ || b == WJ || a == GL {
                return false;
            }
            if b == GL && !matches!(a, SP | BA | HY) {
                return false;
            }
            // LB13.
            if matches!(b, CL | CP | EX | IS | SY) {
                return false;
            }
            // LB14 to LB17.
            if spaced == Some(OP)
                || (spaced == Some(QU) && b == OP)
                || (matches!(spaced, Some(CL | CP)) && b == NS)
                || (spaced == Some(B2) && b == B2)
            {
                return false;
            }
            // LB18.
            if a == SP {
                return true;
            }
            // LB19.
            if a == QU || b == QU {
                return false;
            }
            // LB20.
            if a == CB || b == CB {
                return true;
            }
            // LB21, LB21a, LB21b, LB22.
            if matches!(b, BA | HY | NS) || a == BB {
                return false;
            }
            if matches!(a, HY | BA) && self.unit_before(unit).is_some_and(|u| self.acts[u] == HL) {
                return false;
            }
            if (a == SY && b == HL) || b == IN {
                return false;
            }
            // LB23, LB23a, LB24.
            if (matches!(a, AL | HL) && b == NU) || (a == NU && matches!(b, AL | HL)) {
                return false;
            }
            if (a == PR && matches!(b, ID | EB | EM)) || (matches!(a, ID | EB | EM) && b == PO) {
                return false;
            }
            if (matches!(a, PR | PO) && matches!(b, AL | HL))
                || (matches!(a, AL | HL) && matches!(b, PR | PO))
            {
                return false;
            }
            // LB25 as Example 7 of section 8.2 writes it.
            let next = self.unit_after(i).map(|u| self.acts[u]);
            if matches!(a, PR | PO) && (b == NU || (matches!(b, OP | HY) && next == Some(NU))) {
                return false;
            }
            if matches!(a, OP | HY) && b == NU {
                return false;
            }
            if a == NU && matches!(b, NU | SY | IS) {
                return false;
            }
            if self.ends_a_number(unit) && matches!(b, NU | SY | IS | CL | CP) {
                return false;
            }
            if matches!(b, PO | PR)
                && (self.ends_a_number(unit)
                    || (matches!(a, CL | CP)
                        && self
                            .unit_before(unit)
                            .is_some_and(|u| self.ends_a_number(u))))
            {
                return false;
            }
            // LB26, LB27: Korean syllable blocks.
            if (a == JL && matches!(b, JL | JV | H2 | H3))
                || (matches!(a, JV | H2) && matches!(b, JV | JT))
                || (matches!(a, JT | H3) && b == JT)
            {
                return false;
            }
            if (matches!(a, JL | JV | JT | H2 | H3) && b == PO)
                || (a == PR && matches!(b, JL | JV | JT | H2 | H3))
            {
                return false;
            }
            // LB28, LB29.
            if (matches!(a, AL | HL) && matches!(b, AL | HL)) || (a == IS && matches!(b, AL | HL)) {
                return false;
            }
            // LB30. No closing parenthesis has East Asian width F, W or H in this version.
            if matches!(a, AL | HL | NU) && b == OP && !listed(EAST_ASIAN_OPEN, self.chars[i]) {
                return false;
            }
            if a == CP && matches!(b, AL | HL | NU) {
                return false;
            }
            // LB30a: regional indicators pair up from the start of their run.
            if a == RI && b == RI {
                let mut run = 1;
                let mut at = self.unit_before(unit);
                while let Some(u) = at {
                    if self.acts[u] != RI {
                        break;
                    }
                    run += 1;
                    at = self.unit_before(u);
                }
                if run % 2 == 1 {
                    return false;
                }
            }
            // LB30b.
            if b == EM && (a == EB || listed(EXTPICT_UNASSIGNED, self.chars[unit])) {
                return false;
            }
            // LB31.
            true
        }
    }

    /// The opportunities of `chars`, as the index of the character after each break (the length
    /// for the end of the text, LB3) and whether the break is mandatory. LB2: none at the start.
    pub fn breaks(chars: &[char]) -> Vec<(usize, bool)> {
        let text = Text::new(chars);
        let mut out = Vec::new();
        for i in 1..chars.len() {
            if text.breaks_before(i) {
                let hard = text.raw[i - 1] == BK
                    || matches!(text.raw[i - 1], LF | NL)
                    || (text.raw[i - 1] == CR && text.raw[i] != LF);
                out.push((i, hard));
            }
        }
        if !chars.is_empty() {
            out.push((chars.len(), true));
        }
        out
    }
}
