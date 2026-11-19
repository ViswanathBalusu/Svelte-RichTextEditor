//! First-fit line breaking of one paragraph (WASM-008; 02 §9.3, §9.7; 09 §7.1).
//!
//! The rule is the layout engine's own (`packages/layout/src/lines.ts`, FE-081), in integers:
//!
//! - a line ends only at a break opportunity or at the end of its forced-break segment (a newline
//!   ends a segment and has no width);
//! - each line takes as many opportunities as fit, measured without its trailing spaces, tabs and
//!   newline (first fit); nothing fits: the first opportunity after the line start takes the word,
//!   which overflows;
//! - the first line starts at `indent_left + indent_first`, every other at `indent_left`, and every
//!   line is `column_width - indent_right - x` wide;
//! - a tab moves to the next tab stop past the position (or to the next multiple of the default
//!   spacing), and the text after it, up to the next tab, is placed by the stop: left at it, right
//!   ending at it, centre centred on it (half the width rounded down to whole twips) and decimal
//!   with its first full stop on it. Text wider than the space left starts where the tab began.
//!
//! The break opportunities are an input: the offsets at which the Unicode line breaking algorithm
//! (UAX #14) allows a break. Producing them is `WASM-007`.
//!
//! Hyphenation (WASM-009) adds a second kind of candidate: the offsets inside a word at which a
//! hyphen may stand (`Params::hyphens`, found by `hyphenate.rs`). A line that ends at one takes the
//! width of a hyphen (`Measure::hyphen`) and reports `hyphen`. A hyphen candidate that does not fit
//! never ends the search, because the word's own end, still ahead, may fit where the hyphen does not;
//! and when nothing fits, the whole word is taken as before and is not split.
//!
//! Offsets are UTF-16 code units of the block's text, in which an inline atom is one unit and a
//! bookmark none (09 §7.1). Every length is in advance units (`shaping.rs`). Justification: every
//! line but the last reports the space it needs to reach its available width and the number of
//! spaces that share it (ordinary and no-break spaces, not the trailing run of spaces, no-break
//! spaces and tabs); the word spacing is the first divided by the second, which the caller does,
//! so that nothing is rounded here. Tabs never stretch.

const SPACE: u16 = 0x20;
const NEWLINE: u16 = 0x0a;
const TAB: u16 = 0x09;
const NO_BREAK_SPACE: u16 = 0xa0;
const FULL_STOP: u16 = 0x2e;

/// Advance units in one twip: the unit that a centred tab rounds to.
const UNITS_PER_TWIP: i64 = 64;

/// How a tab stop aligns the text after the tab.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
    Decimal,
}

impl Align {
    /// From the code of the call interface: 0 left, 1 centre, 2 right, 3 decimal; anything else is left.
    pub fn from_code(code: i32) -> Self {
        match code {
            1 => Align::Center,
            2 => Align::Right,
            3 => Align::Decimal,
            _ => Align::Left,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stop {
    pub position: i64,
    pub align: Align,
}

/// What a paragraph is broken with. Lengths are in advance units.
pub struct Params<'a> {
    pub text: &'a [u16],
    /// Offsets at which a break is allowed, ascending.
    pub opportunities: &'a [u32],
    /// Offsets inside words at which a hyphen may stand, ascending. A candidate that is also a break
    /// opportunity is a plain opportunity. Empty when hyphenation is off.
    pub hyphens: &'a [u32],
    pub column_width: i64,
    pub indent_left: i64,
    pub indent_right: i64,
    /// Added to `indent_left` on the first line; negative for a hanging indent.
    pub indent_first: i64,
    /// Tab stops, from the column's left edge, in any order.
    pub stops: Vec<Stop>,
    /// The spacing of default stops past the last custom one; 0 for none.
    pub default_tab: i64,
    /// Report the space each line but the last needs to reach its width.
    pub justify: bool,
}

/// One line of the result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Line {
    /// The offset of the line's first code unit.
    pub from: u32,
    /// The offset after its last (the next line's start).
    pub to: u32,
    pub x: i64,
    /// The width of the line without its trailing spaces, tabs and newline.
    pub width: i64,
    /// Justified lines: the space to add; 0 for others.
    pub extra: i64,
    /// Justified lines: the number of spaces that share `extra`; 0 for others.
    pub spaces: u32,
    /// The line ends at a hyphen candidate: a hyphen is drawn after its last unit and is in `width`.
    pub hyphen: bool,
}

/// The width of text[a, b) in advance units, as the caller shapes it (box runs count their width).
pub trait Measure {
    type Error;
    fn span(&mut self, a: usize, b: usize) -> Result<i64, Self::Error>;
    /// The width of the hyphen drawn when a line ends at offset `at` (in the face of the unit
    /// before it).
    fn hyphen(&mut self, at: usize) -> Result<i64, Self::Error>;
}

fn is_trailing(c: u16) -> bool {
    c == SPACE || c == NEWLINE || c == TAB
}

fn is_trailing_blank(c: u16) -> bool {
    c == SPACE || c == NO_BREAK_SPACE || c == TAB
}

/// The number of spaces of `text[from, to)` that justification may stretch.
pub fn stretchable_spaces(text: &[u16], from: usize, to: usize) -> u32 {
    let mut end = to;
    while end > from && is_trailing_blank(text[end - 1]) {
        end -= 1;
    }
    let count = text[from..end]
        .iter()
        .filter(|&&c| c == SPACE || c == NO_BREAK_SPACE)
        .count();
    u32::try_from(count).unwrap_or(u32::MAX)
}

struct Breaker<'a, 'p, M> {
    p: &'a Params<'p>,
    stops: Vec<Stop>,
    measure: &'a mut M,
}

impl<M> Breaker<'_, '_, M> {
    /// The next stop past `at`: a custom one, else the default spacing, else `at` itself.
    fn next_stop(&self, at: i64) -> Stop {
        if let Some(stop) = self.stops.iter().find(|s| s.position > at) {
            return *stop;
        }
        if self.p.default_tab > 0 {
            return Stop {
                position: (at.div_euclid(self.p.default_tab) + 1) * self.p.default_tab,
                align: Align::Left,
            };
        }
        Stop {
            position: at,
            align: Align::Left,
        }
    }
}

impl<M: Measure> Breaker<'_, '_, M> {
    fn span(&mut self, a: usize, b: usize) -> Result<i64, M::Error> {
        if b <= a {
            return Ok(0);
        }
        self.measure.span(a, b)
    }

    /// Where the text after a tab at `at`, text[seg_start, seg_end), starts.
    fn place_after_tab(
        &mut self,
        at: i64,
        seg_start: usize,
        seg_end: usize,
    ) -> Result<i64, M::Error> {
        let stop = self.next_stop(at);
        let start = match stop.align {
            Align::Left => stop.position,
            Align::Right => stop.position - self.span(seg_start, seg_end)?,
            Align::Center => {
                // Half the width, rounded down to whole twips (the model's `placeTab`, CDM-044).
                let width = self.span(seg_start, seg_end)?;
                stop.position - width.div_euclid(2 * UNITS_PER_TWIP) * UNITS_PER_TWIP
            }
            Align::Decimal => {
                let dot = self.p.text[seg_start.min(self.p.text.len())..]
                    .iter()
                    .position(|&c| c == FULL_STOP)
                    .map(|i| i + seg_start);
                let end = match dot {
                    Some(d) if d < seg_end => d,
                    _ => seg_end,
                };
                stop.position - self.span(seg_start, end)?
            }
        };
        Ok(at.max(start))
    }

    /// The position reached from `start` after text[a, b), tabs placing the text after them.
    fn advance_from(&mut self, start: i64, a: usize, b: usize) -> Result<i64, M::Error> {
        let mut at = start;
        let mut cursor = a;
        for i in a..b {
            if self.p.text[i] != TAB {
                continue;
            }
            at += self.span(cursor, i)?;
            let mut end = i + 1;
            while end < b && self.p.text[end] != TAB {
                end += 1;
            }
            at = self.place_after_tab(at, i + 1, end)?;
            cursor = i + 1;
        }
        Ok(at + self.span(cursor, b)?)
    }

    /// A line's fit, from its start x, without its trailing spaces, tabs and newline.
    fn fit_width(&mut self, a: usize, x: i64, b: usize) -> Result<i64, M::Error> {
        let mut end = b;
        while end > a && is_trailing(self.p.text[end - 1]) {
            end -= 1;
        }
        Ok(self.advance_from(x, a, end)? - x)
    }

    /// The fit of a line ending at a candidate: a hyphen candidate adds the hyphen's width.
    fn fit_candidate(&mut self, a: usize, x: i64, b: usize, hyphen: bool) -> Result<i64, M::Error> {
        let width = self.fit_width(a, x, b)?;
        Ok(if hyphen {
            width + self.measure.hyphen(b)?
        } else {
            width
        })
    }
}

/// Breaks the paragraph. Errors are the measure's.
pub fn break_lines<M: Measure>(p: &Params, measure: &mut M) -> Result<Vec<Line>, M::Error> {
    let n = p.text.len();
    let mut stops = p.stops.clone();
    stops.sort_by_key(|s| s.position);
    let mut b = Breaker { p, stops, measure };
    let mut lines: Vec<Line> = Vec::new();

    // Forced-break segments: each runs up to and including a newline; the text after the last
    // newline is a segment of its own (empty when the paragraph ends with a newline).
    let mut bounds: Vec<(usize, usize)> = Vec::new();
    let mut seg_start = 0;
    for (i, &c) in p.text.iter().enumerate() {
        if c == NEWLINE {
            bounds.push((seg_start, i + 1));
            seg_start = i + 1;
        }
    }
    bounds.push((seg_start, n));

    let start_x = |first: bool| {
        if first {
            p.indent_left + p.indent_first
        } else {
            p.indent_left
        }
    };

    for (s_start, s_end) in bounds {
        if s_start == s_end {
            let x = start_x(lines.is_empty());
            let width = b.fit_width(s_start, x, s_start)?;
            lines.push(plain(s_start, s_start, x, width, false));
            continue;
        }
        let mut candidates: Vec<(usize, bool)> = p
            .opportunities
            .iter()
            .map(|&o| o as usize)
            .filter(|&o| o > s_start && o < s_end)
            .map(|o| (o, false))
            .collect();
        for &h in p.hyphens {
            let h = h as usize;
            if h > s_start && h < s_end && !candidates.iter().any(|&(o, _)| o == h) {
                candidates.push((h, true));
            }
        }
        candidates.sort_by_key(|&(o, _)| o);
        candidates.push((s_end, false));

        let mut pos = s_start;
        let mut k = 0;
        while pos < s_end {
            while k < candidates.len() && candidates[k].0 <= pos {
                k += 1;
            }
            let x = start_x(lines.is_empty());
            let avail = p.column_width - p.indent_right - x;
            let mut best: Option<(usize, bool)> = None;
            for &(o, hyphen) in &candidates[k..] {
                if b.fit_candidate(pos, x, o, hyphen)? <= avail {
                    best = Some((o, hyphen));
                } else if !hyphen {
                    break;
                }
            }
            // Nothing fits: the first opportunity after the line start takes the overflowing word.
            let (to, hyphen) = match best {
                Some(found) => found,
                None => candidates[k..]
                    .iter()
                    .copied()
                    .find(|&(_, hyphen)| !hyphen)
                    .unwrap_or(candidates[k]),
            };
            let width = b.fit_candidate(pos, x, to, hyphen)?;
            lines.push(plain(pos, to, x, width, hyphen));
            pos = to;
        }
    }

    if p.justify {
        let last = lines.len().saturating_sub(1);
        for (i, line) in lines.iter_mut().enumerate() {
            if i == last {
                continue;
            }
            let spaces = stretchable_spaces(p.text, line.from as usize, line.to as usize);
            let avail = p.column_width - p.indent_right - line.x;
            let extra = avail - line.width;
            if spaces > 0 && extra > 0 {
                line.spaces = spaces;
                line.extra = extra;
            }
        }
    }
    Ok(lines)
}

fn plain(from: usize, to: usize, x: i64, width: i64, hyphen: bool) -> Line {
    Line {
        from: u32::try_from(from).unwrap_or(u32::MAX),
        to: u32::try_from(to).unwrap_or(u32::MAX),
        x,
        width,
        extra: 0,
        spaces: 0,
        hyphen,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::convert::Infallible;

    /// Every code unit is 100 wide, but a newline is 0 (it is trimmed) and `#` is 400 (an atom).
    struct Fixed<'a>(&'a [u16]);
    impl Measure for Fixed<'_> {
        type Error = Infallible;
        fn span(&mut self, a: usize, b: usize) -> Result<i64, Infallible> {
            Ok(self.0[a..b]
                .iter()
                .map(|&c| if c == u16::from(b'#') { 400 } else { 100 })
                .sum())
        }
        fn hyphen(&mut self, _at: usize) -> Result<i64, Infallible> {
            Ok(100)
        }
    }

    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    /// Opportunities after each run of spaces, as a stand-in for UAX #14 in these tests.
    fn after_spaces(text: &[u16]) -> Vec<u32> {
        (1..text.len())
            .filter(|&i| text[i - 1] == SPACE && text[i] != SPACE)
            .map(|i| u32::try_from(i).unwrap())
            .collect()
    }

    fn params<'a>(text: &'a [u16], opp: &'a [u32], column: i64) -> Params<'a> {
        Params {
            text,
            opportunities: opp,
            hyphens: &[],
            column_width: column,
            indent_left: 0,
            indent_right: 0,
            indent_first: 0,
            stops: vec![],
            default_tab: 0,
            justify: false,
        }
    }

    fn run(p: &Params) -> Vec<Line> {
        let mut m = Fixed(p.text);
        break_lines(p, &mut m).unwrap()
    }

    fn starts(lines: &[Line]) -> Vec<(u32, u32)> {
        lines.iter().map(|l| (l.from, l.to)).collect()
    }

    #[test]
    fn takes_as_many_words_as_fit_and_measures_without_the_trailing_space() {
        let text = units("aa bb cc dd ee");
        let opp = after_spaces(&text);
        // "aa bb" is 5 units = 500 and "aa bb " would be 600 with its space, but the space does not count.
        let lines = run(&params(&text, &opp, 500));
        assert_eq!(starts(&lines), vec![(0, 6), (6, 12), (12, 14)]);
        assert_eq!(lines[0].width, 500);
        assert_eq!(lines[2].width, 200);
        // A column one unit narrower leaves each word on its own line.
        let narrow = run(&params(&text, &opp, 499));
        assert_eq!(narrow.len(), 5);
    }

    #[test]
    fn a_word_wider_than_the_line_overflows_alone() {
        let text = units("aaaaaaaa bb");
        let opp = after_spaces(&text);
        let lines = run(&params(&text, &opp, 300));
        assert_eq!(starts(&lines), vec![(0, 9), (9, 11)]);
        assert_eq!(lines[0].width, 800);
    }

    #[test]
    fn a_newline_ends_a_line_and_has_no_width() {
        let text = units("ab\ncd ef\n");
        let opp = after_spaces(&text);
        let lines = run(&params(&text, &opp, 1000));
        // "ab\n", "cd ef\n" and the empty line after the last newline.
        assert_eq!(starts(&lines), vec![(0, 3), (3, 9), (9, 9)]);
        assert_eq!(lines[0].width, 200);
        assert_eq!(lines[1].width, 500);
        assert_eq!(lines[2].width, 0);
    }

    #[test]
    fn an_empty_paragraph_is_one_empty_line() {
        let text = units("");
        let lines = run(&params(&text, &[], 1000));
        assert_eq!(starts(&lines), vec![(0, 0)]);
    }

    #[test]
    fn indents_narrow_the_lines_and_the_first_line_has_its_own_start() {
        let text = units("aa bb cc dd");
        let opp = after_spaces(&text);
        let mut p = params(&text, &opp, 700);
        p.indent_left = 100;
        p.indent_right = 100;
        p.indent_first = 200;
        let lines = run(&p);
        // First line: x = 300, 300 available: "aa" (200) fits, "aa bb" (500) does not.
        assert_eq!((lines[0].x, starts(&lines)[0]), (300, (0, 3)));
        // The others: x = 100, 500 available: "bb cc" is 500.
        assert_eq!((lines[1].x, starts(&lines)[1]), (100, (3, 9)));
        // A hanging indent starts the first line left of the others.
        let mut hang = params(&text, &opp, 700);
        hang.indent_left = 300;
        hang.indent_first = -200;
        assert_eq!(run(&hang)[0].x, 100);
    }

    #[test]
    fn an_atom_counts_as_one_unit_and_its_width_is_the_measures() {
        // Offsets count the atom as one code unit; here `#` stands for it and is 400 wide.
        let text = units("a #b cc");
        let opp = after_spaces(&text);
        let lines = run(&params(&text, &opp, 600));
        assert_eq!(starts(&lines), vec![(0, 2), (2, 5), (5, 7)]);
        assert_eq!(lines[1].width, 500);
    }

    #[test]
    fn tabs_advance_to_the_stop_and_to_the_default_spacing() {
        let text = units("a\tb");
        let mut p = params(&text, &[], 2000);
        p.stops = vec![Stop {
            position: 500,
            align: Align::Left,
        }];
        // "a" is 100, the tab goes to the stop at 500, "b" is 100: the line is 600 wide.
        assert_eq!(run(&p)[0].width, 600);
        // Past the last stop the default spacing applies: the next multiple of 300 after 100 is 300.
        let mut d = params(&text, &[], 2000);
        d.default_tab = 300;
        assert_eq!(run(&d)[0].width, 400);
        // With neither, the tab has no width.
        assert_eq!(run(&params(&text, &[], 2000))[0].width, 200);
    }

    #[test]
    fn stops_align_the_text_after_the_tab() {
        let text = units("a\tbbbb");
        let width = |align: Align| {
            let mut p = params(&text, &[], 3000);
            p.stops = vec![Stop {
                position: 1000,
                align,
            }];
            run(&p)[0].width
        };
        // Left: the text starts at the stop. Right: it ends at the stop. Centre: half of it (400) is left of it.
        assert_eq!(width(Align::Left), 1400);
        assert_eq!(width(Align::Right), 1000);
        // Half of 400 units is 200 = 3.125 twips, rounded down to 3 twips = 192 units.
        assert_eq!(width(Align::Center), 1000 - 192 + 400);
        // Decimal with no full stop: the end of the text is on the stop.
        assert_eq!(width(Align::Decimal), 1000);
    }

    #[test]
    fn a_decimal_stop_puts_the_full_stop_on_it() {
        let text = units("a\t12.50");
        let mut p = params(&text, &[], 3000);
        p.stops = vec![Stop {
            position: 1000,
            align: Align::Decimal,
        }];
        // "12" is 200 left of the stop; ".50" is 300 right of it.
        assert_eq!(run(&p)[0].width, 1000 - 200 + 500);
    }

    #[test]
    fn text_wider_than_the_space_left_of_a_right_stop_starts_where_the_tab_began() {
        let text = units("aaa\tbbbbbbb");
        let mut p = params(&text, &[], 5000);
        p.stops = vec![Stop {
            position: 400,
            align: Align::Right,
        }];
        // "aaa" is 300, the 700 of text cannot end at 400, so it starts at 300.
        assert_eq!(run(&p)[0].width, 1000);
    }

    #[test]
    fn a_trailing_tab_does_not_count_towards_the_fit() {
        let text = units("aa\t");
        let mut p = params(&text, &[], 200);
        p.default_tab = 1000;
        let lines = run(&p);
        assert_eq!(starts(&lines), vec![(0, 3)]);
        assert_eq!(lines[0].width, 200);
    }

    #[test]
    fn justified_lines_report_the_space_they_need_and_the_spaces_that_share_it() {
        let text = units("aa bb cc dd");
        let opp = after_spaces(&text);
        let mut p = params(&text, &opp, 700);
        p.justify = true;
        let lines = run(&p);
        // "aa bb " is 500 wide of 700: 200 to share among the one space inside (the trailing one is not).
        assert_eq!(starts(&lines), vec![(0, 6), (6, 11)]);
        assert_eq!((lines[0].extra, lines[0].spaces), (200, 1));
        // The last line is not justified.
        assert_eq!((lines[1].extra, lines[1].spaces), (0, 0));
    }

    #[test]
    fn only_ordinary_and_no_break_spaces_stretch_and_not_the_trailing_ones_or_tabs() {
        let text: Vec<u16> = "a b\u{a0}c \t".encode_utf16().collect();
        assert_eq!(stretchable_spaces(&text, 0, text.len()), 2);
        let tabs = units("a\tb");
        assert_eq!(stretchable_spaces(&tabs, 0, tabs.len()), 0);
        let blank = units("   ");
        assert_eq!(stretchable_spaces(&blank, 0, blank.len()), 0);
    }

    #[test]
    fn a_justified_line_already_at_its_width_or_without_spaces_gets_nothing() {
        let text = units("aaaaa bbbbbbbbbbbb c");
        let opp = after_spaces(&text);
        let mut p = params(&text, &opp, 500);
        p.justify = true;
        let lines = run(&p);
        // The first line is 500 wide of 500; the second overflows; neither is stretched.
        assert!(lines.iter().all(|l| l.extra == 0 && l.spaces == 0));
    }

    #[test]
    fn the_result_is_the_same_whatever_order_the_stops_are_given_in() {
        let text = units("a\tb\tc");
        let stops = |order: [i64; 2]| {
            let mut p = params(&text, &[], 5000);
            p.stops = order
                .iter()
                .map(|&position| Stop {
                    position,
                    align: Align::Left,
                })
                .collect();
            run(&p)[0].width
        };
        assert_eq!(stops([300, 800]), stops([800, 300]));
    }

    fn hyphenated<'a>(
        text: &'a [u16],
        opp: &'a [u32],
        hyphens: &'a [u32],
        column: i64,
    ) -> Params<'a> {
        let mut p = params(text, opp, column);
        p.hyphens = hyphens;
        p
    }

    #[test]
    fn a_line_may_end_at_a_hyphen_candidate_and_takes_the_hyphen_width() {
        let text = units("aaaa bbbbbbbb cc");
        let opp = after_spaces(&text);
        let lines = run(&hyphenated(&text, &opp, &[8, 11], 700));
        assert_eq!(starts(&lines), vec![(0, 5), (5, 11), (11, 16)]);
        assert_eq!(
            lines.iter().map(|l| l.hyphen).collect::<Vec<_>>(),
            vec![false, true, false]
        );
        // "bbb" and "bbb" and the drawn hyphen, 600 + 100.
        assert_eq!(lines[1].width, 700);
        // Without candidates the word overflows alone, as before.
        let plain_lines = run(&params(&text, &opp, 700));
        assert_eq!(starts(&plain_lines), vec![(0, 5), (5, 14), (14, 16)]);
        assert!(plain_lines.iter().all(|l| !l.hyphen));
    }

    #[test]
    fn a_hyphen_that_does_not_fit_does_not_stop_the_word_that_does() {
        let text = units("aaaa bbbbbbbb cc");
        let opp = after_spaces(&text);
        // "bbbbbbbb" is exactly 800 wide: the candidates inside it (900 with the hyphen) must not
        // end the search before the word's end is tried.
        let lines = run(&hyphenated(&text, &opp, &[8, 11], 800));
        assert_eq!(starts(&lines), vec![(0, 5), (5, 14), (14, 16)]);
        assert!(lines.iter().all(|l| !l.hyphen));
    }

    #[test]
    fn a_word_that_fits_nowhere_is_not_split() {
        let text = units("bbbbbbbb");
        let lines = run(&hyphenated(&text, &[], &[3, 6], 300));
        assert_eq!(starts(&lines), vec![(0, 8)]);
        assert!(!lines[0].hyphen);
    }

    #[test]
    fn a_long_word_is_split_as_often_as_it_takes() {
        let text = units("bbbbbbbb");
        let lines = run(&hyphenated(&text, &[], &[3, 6], 400));
        assert_eq!(starts(&lines), vec![(0, 3), (3, 6), (6, 8)]);
        assert_eq!(
            lines.iter().map(|l| l.hyphen).collect::<Vec<_>>(),
            vec![true, true, false]
        );
        assert_eq!(lines[0].width, 400);
    }

    #[test]
    fn a_hyphen_candidate_on_an_opportunity_is_the_opportunity() {
        let text = units("aaaa bbbbbbbb cc");
        let opp = after_spaces(&text);
        let lines = run(&hyphenated(&text, &opp, &[5, 14], 700));
        assert!(lines.iter().all(|l| !l.hyphen));
        assert_eq!(starts(&lines), vec![(0, 5), (5, 14), (14, 16)]);
    }

    #[test]
    fn a_hyphenated_line_that_is_justified_counts_its_hyphen() {
        let text = units("aa bbbbbbbb");
        let opp = after_spaces(&text);
        let mut p = hyphenated(&text, &opp, &[6], 600);
        p.justify = true;
        let lines = run(&p);
        // "aa bbb" + hyphen is 700 and does not fit 600: "aa " goes alone, then the word is split.
        assert_eq!(starts(&lines), vec![(0, 3), (3, 6), (6, 11)]);
        let mut q = hyphenated(&text, &opp, &[6], 700);
        q.justify = true;
        let lines = run(&q);
        assert_eq!(starts(&lines), vec![(0, 6), (6, 11)]);
        assert!(lines[0].hyphen);
        assert_eq!(
            (lines[0].width, lines[0].extra, lines[0].spaces),
            (700, 0, 0)
        );
    }
}
