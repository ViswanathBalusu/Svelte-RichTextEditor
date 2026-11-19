//! The Unicode Bidirectional Algorithm, UAX #9 (WASM-015; 02 §11; ADR 0016), for one paragraph.
//!
//! The paragraph is resolved once: explicit embeddings, overrides and isolates (X1 to X8), isolating
//! run sequences (X10), weak types (W1 to W7), paired brackets (N0), neutrals (N1, N2) and implicit
//! levels (I1, I2). A line is then ordered: trailing whitespace goes to the paragraph level (L1) and
//! the levels are reversed from the highest down (L2). The result for a line is a list of visual
//! runs, each a range of logical UTF-16 offsets and its level, from the left edge to the right.
//!
//! The data (Bidi_Class, paired brackets) is generated into `bidi_data.rs` from one Unicode version.
//! The algorithm treats the text as one paragraph: a paragraph separator keeps the paragraph level.
//! Characters the algorithm removes (X9: embedding and override controls, boundary neutrals) keep a
//! level, that of the character before them, so that offsets stay whole.
#![allow(clippy::needless_range_loop)]

use crate::bidi_data::{BRACKETS, CLASS_RANGES};

/// Bidi_Class, in the order of the generated tables.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Class {
    L,
    R,
    AL,
    EN,
    ES,
    ET,
    AN,
    CS,
    NSM,
    BN,
    B,
    S,
    WS,
    ON,
    LRE,
    LRO,
    RLE,
    RLO,
    PDF,
    LRI,
    RLI,
    FSI,
    PDI,
}

const ALL: [Class; 23] = [
    Class::L,
    Class::R,
    Class::AL,
    Class::EN,
    Class::ES,
    Class::ET,
    Class::AN,
    Class::CS,
    Class::NSM,
    Class::BN,
    Class::B,
    Class::S,
    Class::WS,
    Class::ON,
    Class::LRE,
    Class::LRO,
    Class::RLE,
    Class::RLO,
    Class::PDF,
    Class::LRI,
    Class::RLI,
    Class::FSI,
    Class::PDI,
];

/// The Bidi_Class of a character (L for any code point the table does not list).
pub fn class_of(c: char) -> Class {
    let cp = c as u32;
    let at = CLASS_RANGES.partition_point(|&(_, last, _)| last < cp);
    match CLASS_RANGES.get(at) {
        Some(&(first, _, class)) if first <= cp => ALL[usize::from(class)],
        _ => Class::L,
    }
}

/// The paired bracket of `c` and whether `c` opens: `None` when `c` is not a paired bracket.
fn bracket(c: char) -> Option<(u32, bool)> {
    let cp = c as u32;
    BRACKETS
        .binary_search_by_key(&cp, |&(b, _, _)| b)
        .ok()
        .map(|i| (BRACKETS[i].1, BRACKETS[i].2))
}

/// Canonically equivalent brackets are one bracket (U+2329 and U+232A are U+3008 and U+3009).
fn canonical(cp: u32) -> u32 {
    match cp {
        0x2329 => 0x3008,
        0x232a => 0x3009,
        other => other,
    }
}

/// The base direction asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Ltr,
    Rtl,
    /// The first strong character decides (P2, P3); left to right when there is none.
    Auto,
}

impl Direction {
    /// From the call interface: 0 left to right, 1 right to left, anything else automatic.
    pub fn from_code(code: i32) -> Self {
        match code {
            0 => Direction::Ltr,
            1 => Direction::Rtl,
            _ => Direction::Auto,
        }
    }
}

const MAX_DEPTH: u8 = 125;
const MAX_BRACKET_STACK: usize = 63;

fn is_isolate_initiator(c: Class) -> bool {
    matches!(c, Class::LRI | Class::RLI | Class::FSI)
}

/// X9: these characters take no part in the resolution.
fn is_removed(c: Class) -> bool {
    matches!(
        c,
        Class::LRE | Class::LRO | Class::RLE | Class::RLO | Class::PDF | Class::BN
    )
}

fn is_neutral(c: Class) -> bool {
    matches!(
        c,
        Class::B
            | Class::S
            | Class::WS
            | Class::ON
            | Class::FSI
            | Class::LRI
            | Class::RLI
            | Class::PDI
    )
}

/// A resolved paragraph.
#[derive(Debug, Clone)]
pub struct Paragraph {
    /// The paragraph embedding level: 0 or 1.
    pub level: u8,
    /// The resolved level of each character.
    pub levels: Vec<u8>,
    /// The original class of each character, which L1 needs.
    original: Vec<Class>,
}

/// BD9: for each isolate initiator the index of its matching PDI, and for each PDI its initiator.
fn match_isolates(classes: &[Class]) -> (Vec<Option<usize>>, Vec<Option<usize>>) {
    let mut pdi_of = vec![None; classes.len()];
    let mut initiator_of = vec![None; classes.len()];
    let mut open: Vec<usize> = Vec::new();
    for (i, &c) in classes.iter().enumerate() {
        if is_isolate_initiator(c) {
            open.push(i);
        } else if c == Class::PDI {
            if let Some(start) = open.pop() {
                pdi_of[start] = Some(i);
                initiator_of[i] = Some(start);
            }
        }
    }
    (pdi_of, initiator_of)
}

/// P2 and P3 over `[from, to)`: the level of the first strong character, skipping isolates.
fn first_strong_level(
    classes: &[Class],
    pdi_of: &[Option<usize>],
    from: usize,
    to: usize,
) -> Option<u8> {
    let mut i = from;
    while i < to {
        match classes[i] {
            Class::L => return Some(0),
            Class::R | Class::AL => return Some(1),
            c if is_isolate_initiator(c) => match pdi_of[i] {
                Some(end) => i = end,
                None => return None,
            },
            _ => {}
        }
        i += 1;
    }
    None
}

struct Entry {
    level: u8,
    /// The override: `Some(L)` or `Some(R)`.
    over: Option<Class>,
    isolate: bool,
}

fn next_odd(level: u8) -> u8 {
    (level + 1) | 1
}

fn next_even(level: u8) -> u8 {
    (level + 2) & !1
}

/// Resolves a paragraph (UAX #9, rules P2 to I2).
pub fn resolve(text: &[char], direction: Direction) -> Paragraph {
    let n = text.len();
    let original: Vec<Class> = text.iter().map(|&c| class_of(c)).collect();
    let (pdi_of, initiator_of) = match_isolates(&original);
    let level = match direction {
        Direction::Ltr => 0,
        Direction::Rtl => 1,
        Direction::Auto => first_strong_level(&original, &pdi_of, 0, n).unwrap_or(0),
    };
    let mut classes = original.clone();
    let mut levels = vec![level; n];

    // X1 to X8.
    let mut stack = vec![Entry {
        level,
        over: None,
        isolate: false,
    }];
    let (mut overflow_isolates, mut overflow_embeddings, mut valid_isolates) =
        (0usize, 0usize, 0usize);
    for i in 0..n {
        let top_level = stack.last().map_or(level, |e| e.level);
        let top_over = stack.last().and_then(|e| e.over);
        match original[i] {
            Class::RLE | Class::LRE | Class::RLO | Class::LRO => {
                levels[i] = top_level;
                let rtl = matches!(original[i], Class::RLE | Class::RLO);
                let new = if rtl {
                    next_odd(top_level)
                } else {
                    next_even(top_level)
                };
                if new <= MAX_DEPTH && overflow_isolates == 0 && overflow_embeddings == 0 {
                    stack.push(Entry {
                        level: new,
                        over: match original[i] {
                            Class::RLO => Some(Class::R),
                            Class::LRO => Some(Class::L),
                            _ => None,
                        },
                        isolate: false,
                    });
                } else if overflow_isolates == 0 {
                    overflow_embeddings += 1;
                }
            }
            Class::RLI | Class::LRI | Class::FSI => {
                levels[i] = top_level;
                if let Some(o) = top_over {
                    classes[i] = o;
                }
                let rtl = match original[i] {
                    Class::RLI => true,
                    Class::LRI => false,
                    _ => {
                        let end = pdi_of[i].unwrap_or(n);
                        first_strong_level(&original, &pdi_of, i + 1, end) == Some(1)
                    }
                };
                let new = if rtl {
                    next_odd(top_level)
                } else {
                    next_even(top_level)
                };
                if new <= MAX_DEPTH && overflow_isolates == 0 && overflow_embeddings == 0 {
                    valid_isolates += 1;
                    stack.push(Entry {
                        level: new,
                        over: None,
                        isolate: true,
                    });
                } else {
                    overflow_isolates += 1;
                }
            }
            Class::PDI => {
                if overflow_isolates > 0 {
                    overflow_isolates -= 1;
                } else if valid_isolates > 0 {
                    overflow_embeddings = 0;
                    while stack.last().is_some_and(|e| !e.isolate) {
                        stack.pop();
                    }
                    stack.pop();
                    valid_isolates -= 1;
                }
                levels[i] = stack.last().map_or(level, |e| e.level);
                if let Some(o) = stack.last().and_then(|e| e.over) {
                    classes[i] = o;
                }
            }
            Class::PDF => {
                levels[i] = top_level;
                if overflow_isolates == 0 {
                    if overflow_embeddings > 0 {
                        overflow_embeddings -= 1;
                    } else if stack.last().is_some_and(|e| !e.isolate) && stack.len() >= 2 {
                        stack.pop();
                    }
                }
            }
            Class::B => levels[i] = level,
            Class::BN => levels[i] = top_level,
            _ => {
                levels[i] = top_level;
                if let Some(o) = top_over {
                    classes[i] = o;
                }
            }
        }
    }

    // X9 and X10: level runs of the characters that remain, chained into isolating run sequences.
    // They are cut by the explicit levels of X1 to X8; the resolved levels are written to `levels`.
    let explicit = levels.clone();
    let kept: Vec<usize> = (0..n).filter(|&i| !is_removed(original[i])).collect();
    let mut runs: Vec<Vec<usize>> = Vec::new();
    for &i in &kept {
        match runs.last_mut() {
            Some(run) if explicit[*run.last().unwrap_or(&i)] == explicit[i] => run.push(i),
            _ => runs.push(vec![i]),
        }
    }
    let mut run_of = vec![usize::MAX; n];
    for (r, run) in runs.iter().enumerate() {
        for &i in run {
            run_of[i] = r;
        }
    }
    let mut position_in_kept = vec![usize::MAX; n];
    for (p, &i) in kept.iter().enumerate() {
        position_in_kept[i] = p;
    }
    let mut sequences: Vec<Vec<usize>> = Vec::new();
    for run in &runs {
        let first = run[0];
        if original[first] == Class::PDI && initiator_of[first].is_some() {
            continue;
        }
        let mut sequence: Vec<usize> = run.clone();
        loop {
            let last = *sequence.last().unwrap_or(&first);
            let next = if is_isolate_initiator(original[last]) {
                pdi_of[last]
            } else {
                None
            };
            match next {
                Some(pdi) if run_of[pdi] != usize::MAX && runs[run_of[pdi]][0] == pdi => {
                    sequence.extend_from_slice(&runs[run_of[pdi]]);
                }
                _ => break,
            }
        }
        sequences.push(sequence);
    }

    for sequence in &sequences {
        let seq_level = explicit[sequence[0]];
        let first_pos = position_in_kept[sequence[0]];
        let last = sequence[sequence.len() - 1];
        let before = if first_pos == 0 {
            level
        } else {
            explicit[kept[first_pos - 1]]
        };
        let after = if is_isolate_initiator(original[last]) && pdi_of[last].is_none() {
            level
        } else {
            match kept.get(position_in_kept[last] + 1) {
                Some(&next) => explicit[next],
                None => level,
            }
        };
        let edge = |other: u8| {
            if seq_level.max(other) % 2 == 0 {
                Class::L
            } else {
                Class::R
            }
        };
        resolve_sequence(
            text,
            sequence,
            &classes,
            &original,
            seq_level,
            edge(before),
            edge(after),
            &mut levels,
        );
    }

    // Removed characters take the level of the character before them.
    let mut previous = level;
    for i in 0..n {
        if is_removed(original[i]) {
            levels[i] = previous;
        } else {
            previous = levels[i];
        }
    }
    Paragraph {
        level,
        levels,
        original,
    }
}

fn strong_for_neutrals(c: Class) -> Class {
    match c {
        Class::L => Class::L,
        _ => Class::R,
    }
}

/// W1 to I2 for one isolating run sequence. Writes the resolved levels into `levels`.
#[allow(clippy::too_many_arguments)]
fn resolve_sequence(
    text: &[char],
    sequence: &[usize],
    classes: &[Class],
    original: &[Class],
    seq_level: u8,
    sos: Class,
    eos: Class,
    levels: &mut [u8],
) {
    let len = sequence.len();
    let mut cls: Vec<Class> = sequence.iter().map(|&i| classes[i]).collect();
    let before_w1 = cls.clone();
    let _ = original;

    // W1: a non-spacing mark takes the type of the character before it.
    for k in 0..len {
        if cls[k] == Class::NSM {
            cls[k] = if k == 0 {
                sos
            } else if matches!(
                cls[k - 1],
                Class::LRI | Class::RLI | Class::FSI | Class::PDI
            ) {
                Class::ON
            } else {
                cls[k - 1]
            };
        }
    }
    // W2: a European number after an Arabic letter is an Arabic number.
    let mut strong = sos;
    for k in 0..len {
        match cls[k] {
            Class::L | Class::R | Class::AL => strong = cls[k],
            Class::EN if strong == Class::AL => cls[k] = Class::AN,
            _ => {}
        }
    }
    // W3.
    for c in cls.iter_mut() {
        if *c == Class::AL {
            *c = Class::R;
        }
    }
    // W4: one separator between two numbers of one kind.
    for k in 1..len.saturating_sub(1) {
        let (prev, next) = (cls[k - 1], cls[k + 1]);
        match cls[k] {
            Class::ES if prev == Class::EN && next == Class::EN => cls[k] = Class::EN,
            Class::CS if prev == Class::EN && next == Class::EN => cls[k] = Class::EN,
            Class::CS if prev == Class::AN && next == Class::AN => cls[k] = Class::AN,
            _ => {}
        }
    }
    // W5: terminators next to a European number.
    let mut k = 0;
    while k < len {
        if cls[k] == Class::ET {
            let start = k;
            while k < len && cls[k] == Class::ET {
                k += 1;
            }
            let touches =
                (start > 0 && cls[start - 1] == Class::EN) || (k < len && cls[k] == Class::EN);
            if touches {
                for c in &mut cls[start..k] {
                    *c = Class::EN;
                }
            }
        } else {
            k += 1;
        }
    }
    // W6.
    for c in cls.iter_mut() {
        if matches!(*c, Class::ES | Class::ET | Class::CS) {
            *c = Class::ON;
        }
    }
    // W7: a European number after a left-to-right letter is a left-to-right letter.
    let mut strong = sos;
    for k in 0..len {
        match cls[k] {
            Class::L | Class::R => strong = cls[k],
            Class::EN if strong == Class::L => cls[k] = Class::L,
            _ => {}
        }
    }

    // N0: paired brackets.
    let embedding = if seq_level % 2 == 0 {
        Class::L
    } else {
        Class::R
    };
    let mut open: Vec<(u32, usize)> = Vec::new();
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    for k in 0..len {
        if cls[k] != Class::ON {
            continue;
        }
        let ch = text[sequence[k]];
        if let Some((pair, opens)) = bracket(ch) {
            if opens {
                if open.len() == MAX_BRACKET_STACK {
                    break;
                }
                open.push((canonical(pair), k));
            } else if let Some(at) = open
                .iter()
                .rposition(|&(want, _)| want == canonical(ch as u32))
            {
                pairs.push((open[at].1, k));
                open.truncate(at);
            }
        }
    }
    pairs.sort_unstable();
    let direction_of = |c: Class| match c {
        Class::L => Some(Class::L),
        Class::R | Class::EN | Class::AN => Some(Class::R),
        _ => None,
    };
    for (o, c) in pairs {
        let (mut found_embedding, mut found_opposite) = (false, false);
        for k in o + 1..c {
            match direction_of(cls[k]) {
                Some(d) if d == embedding => found_embedding = true,
                Some(_) => found_opposite = true,
                None => {}
            }
        }
        let set = if found_embedding {
            Some(embedding)
        } else if found_opposite {
            let mut context = sos;
            for k in (0..o).rev() {
                if let Some(d) = direction_of(cls[k]) {
                    context = d;
                    break;
                }
            }
            Some(if context != embedding {
                context
            } else {
                embedding
            })
        } else {
            None
        };
        if let Some(d) = set {
            for bracket_at in [o, c] {
                cls[bracket_at] = d;
                let mut after = bracket_at + 1;
                while after < len && before_w1[after] == Class::NSM {
                    cls[after] = d;
                    after += 1;
                }
            }
        }
    }

    // N1 and N2: neutrals take the direction of their neighbours when both agree, else the embedding's.
    let mut k = 0;
    while k < len {
        if is_neutral(cls[k]) {
            let start = k;
            while k < len && is_neutral(cls[k]) {
                k += 1;
            }
            let leading = if start == 0 {
                sos
            } else {
                strong_for_neutrals(cls[start - 1])
            };
            let trailing = if k == len {
                eos
            } else {
                strong_for_neutrals(cls[k])
            };
            let d = if leading == trailing {
                leading
            } else {
                embedding
            };
            for c in &mut cls[start..k] {
                *c = d;
            }
        } else {
            k += 1;
        }
    }

    // I1 and I2.
    for k in 0..len {
        let bump = if seq_level % 2 == 0 {
            match cls[k] {
                Class::R => 1,
                Class::AN | Class::EN => 2,
                _ => 0,
            }
        } else {
            match cls[k] {
                Class::L | Class::EN | Class::AN => 1,
                _ => 0,
            }
        };
        levels[sequence[k]] = seq_level + bump;
    }
}

impl Paragraph {
    /// The levels of the line `[from, to)` after L1: separators, and whitespace and isolate
    /// formatting characters before them or at the end of the line, go to the paragraph level.
    pub fn line_levels(&self, from: usize, to: usize) -> Vec<u8> {
        let mut levels = self.levels[from..to].to_vec();
        let mut reset = true;
        for i in (from..to).rev() {
            let class = self.original[i];
            let at = i - from;
            if matches!(class, Class::S | Class::B) {
                levels[at] = self.level;
                reset = true;
            } else if reset
                && (matches!(
                    class,
                    Class::WS | Class::FSI | Class::LRI | Class::RLI | Class::PDI
                ) || is_removed(class))
            {
                levels[at] = self.level;
            } else {
                reset = false;
            }
        }
        levels
    }

    /// L2: the logical indexes of the line `[from, to)` in visual order, left to right, and the
    /// level of each character (as `line_levels` gives them).
    pub fn visual_order(&self, from: usize, to: usize) -> (Vec<usize>, Vec<u8>) {
        let levels = self.line_levels(from, to);
        let mut order: Vec<usize> = (from..to).collect();
        let highest = levels.iter().copied().max().unwrap_or(0);
        let lowest_odd = levels.iter().copied().filter(|l| l % 2 == 1).min();
        if let Some(lowest_odd) = lowest_odd {
            let mut level = highest;
            while level >= lowest_odd {
                let mut k = 0;
                while k < order.len() {
                    if levels[order[k] - from] >= level {
                        let start = k;
                        while k < order.len() && levels[order[k] - from] >= level {
                            k += 1;
                        }
                        order[start..k].reverse();
                    } else {
                        k += 1;
                    }
                }
                if level == 0 {
                    break;
                }
                level -= 1;
            }
        }
        (order, levels)
    }
}

/// A visual run: logical character indexes `start..end` in one direction, at one level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VisualRun {
    pub start: usize,
    pub end: usize,
    pub level: u8,
}

/// The visual runs of the line `[from, to)`, left to right.
pub fn visual_runs(paragraph: &Paragraph, from: usize, to: usize) -> Vec<VisualRun> {
    let (order, levels) = paragraph.visual_order(from, to);
    let mut runs: Vec<VisualRun> = Vec::new();
    let mut k = 0;
    while k < order.len() {
        let level = levels[order[k] - from];
        let mut end = k + 1;
        if end < order.len() && levels[order[end] - from] == level {
            // Continue while the logical index steps by one the same way.
            let step_up = order[end] == order[k] + 1;
            let step_down = order[k] == order[end] + 1;
            if step_up || step_down {
                while end < order.len()
                    && levels[order[end] - from] == level
                    && ((step_up && order[end] == order[end - 1] + 1)
                        || (step_down && order[end - 1] == order[end] + 1))
                {
                    end += 1;
                }
            }
        }
        let low = order[k..end].iter().copied().min().unwrap_or(order[k]);
        let high = order[k..end].iter().copied().max().unwrap_or(order[k]);
        runs.push(VisualRun {
            start: low,
            end: high + 1,
            level,
        });
        k = end;
    }
    runs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chars(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    fn runs(s: &str, direction: Direction) -> Vec<(usize, usize, u8)> {
        let text = chars(s);
        let p = resolve(&text, direction);
        visual_runs(&p, 0, text.len())
            .iter()
            .map(|r| (r.start, r.end, r.level))
            .collect()
    }

    const ALEF: char = '\u{05d0}';
    const BET: char = '\u{05d1}';

    #[test]
    fn classes_come_from_the_tables() {
        assert_eq!(class_of('a'), Class::L);
        assert_eq!(class_of(ALEF), Class::R);
        assert_eq!(class_of('\u{0627}'), Class::AL);
        assert_eq!(class_of('1'), Class::EN);
        assert_eq!(class_of('\u{0661}'), Class::AN);
        assert_eq!(class_of(' '), Class::WS);
        assert_eq!(class_of('('), Class::ON);
        assert_eq!(class_of('\u{2067}'), Class::RLI);
        assert_eq!(class_of('\u{2069}'), Class::PDI);
        assert_eq!(class_of('\u{0301}'), Class::NSM);
        assert_eq!(class_of('\u{10ffff}'), Class::BN);
    }

    #[test]
    fn left_to_right_text_is_one_run_at_level_zero() {
        assert_eq!(runs("abc def", Direction::Auto), vec![(0, 7, 0)]);
        assert_eq!(runs("", Direction::Ltr), Vec::<(usize, usize, u8)>::new());
    }

    #[test]
    fn the_first_strong_character_sets_the_direction_when_it_is_automatic() {
        let hebrew = format!("{ALEF}{BET} abc");
        let p = resolve(&chars(&hebrew), Direction::Auto);
        assert_eq!(p.level, 1);
        assert_eq!(resolve(&chars("1 abc"), Direction::Auto).level, 0);
        assert_eq!(resolve(&chars("123"), Direction::Auto).level, 0);
        assert_eq!(resolve(&chars(&hebrew), Direction::Ltr).level, 0);
        assert_eq!(resolve(&chars("abc"), Direction::Rtl).level, 1);
    }

    #[test]
    fn hebrew_inside_left_to_right_text_is_one_reversed_run() {
        let s = format!("abc {ALEF}{BET} def");
        assert_eq!(
            runs(&s, Direction::Ltr),
            vec![(0, 4, 0), (4, 6, 1), (6, 10, 0)]
        );
    }

    #[test]
    fn latin_inside_right_to_left_text_is_raised_and_the_line_reverses() {
        let s = format!("{ALEF}{BET} abc");
        // Levels 1 1 1 2 2 2: the Latin run first on the left, then the Hebrew and the space.
        assert_eq!(runs(&s, Direction::Rtl), vec![(3, 6, 2), (0, 3, 1)]);
    }

    #[test]
    fn a_european_number_after_an_arabic_letter_is_an_arabic_number() {
        let text = chars("\u{0627}1");
        let p = resolve(&text, Direction::Auto);
        assert_eq!(p.levels, vec![1, 2]);
        // After a Hebrew letter it stays a European number at level 2 in right-to-left text.
        let text = chars(&format!("{ALEF}1"));
        assert_eq!(resolve(&text, Direction::Auto).levels, vec![1, 2]);
        // After a Latin letter in left-to-right text it is a Latin letter's number: level 0.
        assert_eq!(resolve(&chars("a1"), Direction::Ltr).levels, vec![0, 0]);
    }

    #[test]
    fn a_separator_between_two_numbers_joins_them() {
        // W4: 1,2 is one number; W5: the % after 1 is part of it.
        let text = chars(&format!("{ALEF} 1,2 3%"));
        let p = resolve(&text, Direction::Auto);
        assert_eq!(p.levels, vec![1, 1, 2, 2, 2, 1, 2, 2]);
    }

    #[test]
    fn brackets_take_the_direction_of_what_they_enclose_n0() {
        // In left-to-right text, (Hebrew) is pulled to the right-to-left side as a pair.
        let s = format!("a ({ALEF}{BET}) b");
        let p = resolve(&chars(&s), Direction::Ltr);
        // a, space at 0; ( at 1 because the context before it is L matching the embedding... the
        // pair holds only R, the context is L, so the brackets follow the embedding (L).
        assert_eq!(p.levels, vec![0, 0, 0, 1, 1, 0, 0, 0]);
        // After a Hebrew letter the same pair is right-to-left.
        let s = format!("{ALEF} ({ALEF}{BET}) b");
        let p = resolve(&chars(&s), Direction::Ltr);
        assert_eq!(p.levels, vec![1, 1, 1, 1, 1, 1, 0, 0]);
    }

    #[test]
    fn explicit_embeddings_and_isolates_raise_levels_and_keep_their_characters() {
        // RLE a PDF: a is at level 2 (an L in an odd embedding); the controls keep the level before.
        let s = "\u{202b}a\u{202c}";
        let p = resolve(&chars(s), Direction::Ltr);
        assert_eq!(p.levels, vec![0, 2, 2]);
        // RLI a PDI: the isolate raises a to level 2; the initiator and the PDI stay at level 0.
        let s = "x\u{2067}a\u{2069}y";
        let p = resolve(&chars(s), Direction::Ltr);
        assert_eq!(p.levels, vec![0, 0, 2, 0, 0]);
        // RLO overrides: Latin letters inside it read right to left.
        let s = "\u{202e}abc\u{202c}";
        let p = resolve(&chars(s), Direction::Ltr);
        assert_eq!(p.levels[1..4], [1, 1, 1]);
    }

    #[test]
    fn a_sequence_is_bounded_by_the_explicit_levels_of_its_neighbours_not_their_resolved_ones() {
        // An Arabic-Indic digit at level 0 resolves to level 2; the embedding after it starts from
        // the explicit level 0 (found by fuzzing against the browsers, WASM-015).
        let s = "\u{662}\u{202b} b2";
        let p = resolve(&chars(s), Direction::Ltr);
        assert_eq!(p.levels, vec![2, 2, 1, 2, 2]);
    }

    #[test]
    fn an_isolate_without_a_pdi_runs_to_the_end() {
        let s = format!("\u{2067}{ALEF}");
        let p = resolve(&chars(&s), Direction::Ltr);
        assert_eq!(p.levels, vec![0, 1]);
    }

    #[test]
    fn first_strong_isolate_looks_inside_itself() {
        let s = format!("a\u{2068}{ALEF}\u{2069}");
        let p = resolve(&chars(&s), Direction::Ltr);
        assert_eq!(p.levels[2], 1);
    }

    #[test]
    fn trailing_whitespace_goes_to_the_paragraph_level_l1() {
        let s = format!("{ALEF}{BET}  ");
        let text = chars(&s);
        let p = resolve(&text, Direction::Ltr);
        assert_eq!(p.line_levels(0, 4), vec![1, 1, 0, 0]);
        // A tab (a segment separator) and the spaces before it reset as well.
        let s = format!("{ALEF} \tb");
        let p = resolve(&chars(&s), Direction::Rtl);
        assert_eq!(p.line_levels(0, 4), vec![1, 1, 1, 2]);
    }

    #[test]
    fn a_line_inside_a_paragraph_is_ordered_by_its_own_levels() {
        let s = format!("{ALEF}{BET}{ALEF} abc");
        let text = chars(&s);
        let p = resolve(&text, Direction::Rtl);
        // The first line is the Hebrew word and the space after it.
        let first = visual_runs(&p, 0, 4);
        assert_eq!(
            first,
            vec![VisualRun {
                start: 0,
                end: 4,
                level: 1
            }]
        );
    }

    #[test]
    fn surrogate_pairs_are_one_character_for_the_classes() {
        // U+1E900 is an Adlam letter (R).
        assert_eq!(class_of('\u{1e900}'), Class::R);
    }
}
