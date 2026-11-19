//! Hyphenation with TeX patterns (WASM-009; 02 §9.3; ADR 0016).
//!
//! The algorithm is Liang's, the one TeX uses: a word is padded with `.` at both ends, every pattern
//! that occurs in it sets the levels of the gaps it covers (the highest level wins), and a gap with
//! an odd level may take a hyphen. Exceptions (a word with its hyphens marked) replace the patterns
//! for that word. A hyphen is allowed only when at least `left` characters stand before it and at
//! least `right` after it, which are the language's `\lefthyphenmin` and `\righthyphenmin`.
//!
//! The kernel holds no pattern data of its own. A language arrives as the text of its TeX pattern
//! file (one pattern a line) and of its exception file, loaded when a document needs it and released
//! when it does not. A language the kernel has not been given is not hyphenated, and nothing fails.
//!
//! Words are maximal runs of letters and combining marks. A run of text that holds a digit or any
//! other character is not a word and is left alone. The language of a word is the language of the run
//! its first letter is in.

use std::collections::{BTreeMap, HashMap};

/// Why a language was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HyphenFailure {
    /// The tag is empty.
    EmptyTag,
    /// The pattern text holds no pattern.
    NoPatterns,
    /// A minimum of characters is not a whole number from 1 to 8.
    BadMinimum,
}

impl HyphenFailure {
    /// The code the call interface throws.
    pub fn code(self) -> &'static str {
        match self {
            HyphenFailure::EmptyTag => "empty_tag",
            HyphenFailure::NoPatterns => "no_patterns",
            HyphenFailure::BadMinimum => "bad_minimum",
        }
    }
}

/// The patterns, exceptions and minimums of one language.
#[derive(Debug, Clone)]
pub struct Patterns {
    /// Letters of the pattern (with `.` for a word boundary) to the levels of its gaps (one more
    /// than letters).
    map: HashMap<Vec<char>, Vec<u8>>,
    longest: usize,
    /// A word without hyphens, to the character indexes before which a hyphen may stand.
    exceptions: HashMap<Vec<char>, Vec<usize>>,
    left: usize,
    right: usize,
}

fn lower(c: char) -> char {
    let mut it = c.to_lowercase();
    match (it.next(), it.next()) {
        (Some(one), None) => one,
        _ => c,
    }
}

impl Patterns {
    /// Reads a TeX pattern file and an exception file. Blank lines and lines that begin with `%`
    /// are skipped. `left` and `right` are the minimum characters before and after a hyphen.
    pub fn parse(
        patterns: &str,
        exceptions: &str,
        left: usize,
        right: usize,
    ) -> Result<Self, HyphenFailure> {
        if !(1..=8).contains(&left) || !(1..=8).contains(&right) {
            return Err(HyphenFailure::BadMinimum);
        }
        let mut map: HashMap<Vec<char>, Vec<u8>> = HashMap::new();
        let mut longest = 0;
        for line in patterns.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('%') {
                continue;
            }
            let mut letters: Vec<char> = Vec::new();
            let mut levels: Vec<u8> = vec![0];
            for c in line.chars() {
                if let Some(d) = c.to_digit(10) {
                    // A digit sets the level of the gap before the next letter.
                    let at = levels.len() - 1;
                    levels[at] = u8::try_from(d).unwrap_or(0);
                } else {
                    letters.push(lower(c));
                    levels.push(0);
                }
            }
            if letters.is_empty() {
                continue;
            }
            longest = longest.max(letters.len());
            let slot = map.entry(letters).or_insert_with(|| vec![0; levels.len()]);
            for (have, &new) in slot.iter_mut().zip(levels.iter()) {
                *have = (*have).max(new);
            }
        }
        if map.is_empty() {
            return Err(HyphenFailure::NoPatterns);
        }
        let mut by_word: HashMap<Vec<char>, Vec<usize>> = HashMap::new();
        for line in exceptions.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('%') {
                continue;
            }
            let mut word: Vec<char> = Vec::new();
            let mut at: Vec<usize> = Vec::new();
            for c in line.chars() {
                if c == '-' {
                    at.push(word.len());
                } else {
                    word.push(lower(c));
                }
            }
            by_word.insert(word, at);
        }
        Ok(Patterns {
            map,
            longest,
            exceptions: by_word,
            left,
            right,
        })
    }

    /// The number of patterns.
    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// True when the language holds no pattern (never so for a parsed language).
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// The minimum characters before and after a hyphen.
    pub fn minimums(&self) -> (usize, usize) {
        (self.left, self.right)
    }

    /// The character indexes of `word` before which a hyphen may stand, ascending: index `k` means
    /// between `word[k - 1]` and `word[k]`.
    pub fn points(&self, word: &[char]) -> Vec<usize> {
        let n = word.len();
        if n < self.left + self.right {
            return Vec::new();
        }
        let folded: Vec<char> = word.iter().map(|&c| lower(c)).collect();
        let allowed = |k: usize| k >= self.left && k + self.right <= n;
        if let Some(found) = self.exceptions.get(&folded) {
            return found.iter().copied().filter(|&k| allowed(k)).collect();
        }
        let mut padded: Vec<char> = Vec::with_capacity(n + 2);
        padded.push('.');
        padded.extend_from_slice(&folded);
        padded.push('.');
        let mut levels = vec![0u8; padded.len() + 1];
        for start in 0..padded.len() {
            let longest = self.longest.min(padded.len() - start);
            for len in 1..=longest {
                if let Some(pattern) = self.map.get(&padded[start..start + len]) {
                    for (j, &level) in pattern.iter().enumerate() {
                        let slot = &mut levels[start + j];
                        *slot = (*slot).max(level);
                    }
                }
            }
        }
        // The gap before word[k] is the gap before padded[k + 1].
        (1..n)
            .filter(|&k| allowed(k) && levels[k + 1] % 2 == 1)
            .collect()
    }
}

/// The languages the kernel holds, by lowercase tag, with their aliases.
#[derive(Debug, Default)]
pub struct HyphenStore {
    languages: BTreeMap<String, Patterns>,
    aliases: BTreeMap<String, String>,
}

/// A tag as the store keys it: lowercase, with `_` read as `-`.
fn key(tag: &str) -> String {
    tag.trim().to_ascii_lowercase().replace('_', "-")
}

impl HyphenStore {
    pub const fn new() -> Self {
        HyphenStore {
            languages: BTreeMap::new(),
            aliases: BTreeMap::new(),
        }
    }

    /// Holds a language under its tag, replacing one held before.
    pub fn load(
        &mut self,
        tag: &str,
        patterns: &str,
        exceptions: &str,
        left: usize,
        right: usize,
    ) -> Result<usize, HyphenFailure> {
        let tag = key(tag);
        if tag.is_empty() {
            return Err(HyphenFailure::EmptyTag);
        }
        let parsed = Patterns::parse(patterns, exceptions, left, right)?;
        let count = parsed.len();
        self.languages.insert(tag, parsed);
        Ok(count)
    }

    /// Lets `alias` (`en`, `en-GB`) stand for a held language. Returns false when `tag` is not held.
    pub fn alias(&mut self, alias: &str, tag: &str) -> bool {
        let (alias, tag) = (key(alias), key(tag));
        if alias.is_empty() || !self.languages.contains_key(&tag) {
            return false;
        }
        self.aliases.insert(alias, tag);
        true
    }

    /// Frees a language and the aliases that stood for it.
    pub fn release(&mut self, tag: &str) -> bool {
        let tag = key(tag);
        self.aliases.retain(|_, target| *target != tag);
        self.languages.remove(&tag).is_some()
    }

    pub fn release_all(&mut self) {
        self.languages.clear();
        self.aliases.clear();
    }

    pub fn has(&self, tag: &str) -> bool {
        self.find(tag).is_some()
    }

    /// The tags held, ascending.
    pub fn tags(&self) -> Vec<String> {
        self.languages.keys().cloned().collect()
    }

    /// The language for a BCP 47 tag: the tag itself, then the tag with its last subtag cut off,
    /// until one is held (an alias counts as held). `None` for an empty tag or no match.
    pub fn find(&self, tag: &str) -> Option<&Patterns> {
        let mut tag = key(tag);
        while !tag.is_empty() {
            let name = self.aliases.get(&tag).unwrap_or(&tag);
            if let Some(found) = self.languages.get(name) {
                return Some(found);
            }
            match tag.rfind('-') {
                Some(cut) => tag.truncate(cut),
                None => break,
            }
        }
        None
    }
}

fn is_word_char(c: char) -> bool {
    c.is_alphabetic() || is_mark(c)
}

/// Combining marks, by the blocks that hold them (the kernel has no Unicode property tables).
fn is_mark(c: char) -> bool {
    matches!(c as u32,
        0x0300..=0x036f | 0x0483..=0x0489 | 0x0591..=0x05bd | 0x0610..=0x061a
        | 0x064b..=0x065f | 0x0900..=0x0903 | 0x093a..=0x094f | 0x1ab0..=0x1aff
        | 0x1dc0..=0x1dff | 0x20d0..=0x20ff | 0xfe20..=0xfe2f)
}

/// Where a hyphen may stand in `text` (UTF-16 offsets, ascending). `run_ends` are the exclusive ends
/// of the runs and `languages` their BCP 47 tags; a word takes the language of the run its first
/// letter is in. Only the words of languages the store holds are hyphenated.
pub fn word_points(
    store: &HyphenStore,
    text: &[u16],
    run_ends: &[u32],
    languages: &[String],
) -> Vec<u32> {
    let mut out: Vec<u32> = Vec::new();
    if store.languages.is_empty() {
        return out;
    }
    // Characters with the offset of their first code unit.
    let mut chars: Vec<(char, u32)> = Vec::with_capacity(text.len());
    let mut offset = 0u32;
    for decoded in char::decode_utf16(text.iter().copied()) {
        let c = decoded.unwrap_or('\u{fffd}');
        chars.push((c, offset));
        offset += u32::try_from(c.len_utf16()).unwrap_or(1);
    }
    let run_of = |at: u32| run_ends.iter().position(|&end| at < end);
    let mut i = 0;
    while i < chars.len() {
        if !is_word_char(chars[i].0) {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && is_word_char(chars[i].0) {
            i += 1;
        }
        // A word touching a digit or a letter-like symbol on either side is not a word.
        let glued = |at: usize| chars.get(at).is_some_and(|(c, _)| c.is_alphanumeric());
        if (start > 0 && glued(start - 1)) || glued(i) {
            continue;
        }
        let Some(run) = run_of(chars[start].1) else {
            continue;
        };
        let Some(language) = languages.get(run).and_then(|tag| store.find(tag)) else {
            continue;
        };
        let word: Vec<char> = chars[start..i].iter().map(|&(c, _)| c).collect();
        for k in language.points(&word) {
            out.push(chars[start + k].1);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A few patterns of TeX's English file (hyph-en-us), enough for "table" and "hyphenation".
    const EN: &str =
        "% a comment\n.ach4\na1b\nta4ble\nb1l\nhy3ph\nhe2n\nn1a\nen1a\nph1en\nion5at\n1tio\n";

    fn word(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    fn en() -> Patterns {
        Patterns::parse(EN, "", 2, 3).unwrap()
    }

    #[test]
    fn the_highest_level_of_the_patterns_that_match_decides_and_odd_levels_allow() {
        // "a1b" and "b1l" and "ta4ble": the 4 between a and b of "table" beats the 1 of "a1b".
        let p = en();
        assert_eq!(p.points(&word("table")), Vec::<usize>::new());
        // hy3ph, ph1en, en1a/n1a and 1tio give hy-ph-en-a-tion; the even he2n marks no gap.
        assert_eq!(p.points(&word("hyphenation")), vec![2, 4, 6, 7]);
    }

    #[test]
    fn at_least_left_characters_stand_before_and_right_after() {
        let loose = Patterns::parse(EN, "", 1, 1).unwrap();
        let tight = Patterns::parse(EN, "", 4, 4).unwrap();
        assert!(loose.points(&word("hyphenation")).contains(&2));
        assert_eq!(tight.points(&word("hyphenation")), vec![4, 6, 7]);
        assert!(tight.points(&word("hyphen")).is_empty());
        assert!(en().points(&word("ab")).is_empty());
    }

    #[test]
    fn an_exception_replaces_the_patterns_for_its_word() {
        let p = Patterns::parse(EN, "ta-ble\nphil-an-thropic\n", 2, 2).unwrap();
        assert_eq!(p.points(&word("table")), vec![2]);
        let q = Patterns::parse(EN, "hyp-hen-ation\n", 2, 2).unwrap();
        assert_eq!(q.points(&word("hyphenation")), vec![3, 6]);
        assert_eq!(q.points(&word("HYPHENATION")), vec![3, 6]);
    }

    #[test]
    fn capitals_are_matched_as_lowercase_letters() {
        let p = en();
        assert_eq!(
            p.points(&word("Hyphenation")),
            p.points(&word("hyphenation"))
        );
    }

    #[test]
    fn an_empty_pattern_file_or_a_bad_minimum_is_refused() {
        assert_eq!(
            Patterns::parse("% nothing\n\n", "", 2, 2).unwrap_err(),
            HyphenFailure::NoPatterns
        );
        assert_eq!(
            Patterns::parse(EN, "", 0, 2).unwrap_err(),
            HyphenFailure::BadMinimum
        );
        assert_eq!(
            Patterns::parse(EN, "", 2, 9).unwrap_err(),
            HyphenFailure::BadMinimum
        );
    }

    #[test]
    fn the_store_finds_a_language_by_its_tag_then_by_the_tag_cut_short() {
        let mut s = HyphenStore::new();
        assert!(s.find("en-US").is_none());
        s.load("en-US", EN, "", 2, 3).unwrap();
        assert!(s.has("en-us") && s.has("EN_us"));
        assert!(!s.has("en"));
        assert!(s.alias("en", "en-us"));
        assert!(s.has("en") && s.has("en-AU"));
        assert!(!s.alias("de", "de-1996"));
        assert_eq!(s.tags(), vec!["en-us".to_string()]);
        assert!(s.release("en-us"));
        assert!(!s.has("en") && !s.has("en-us"));
        assert_eq!(
            s.load("", EN, "", 2, 3).unwrap_err(),
            HyphenFailure::EmptyTag
        );
    }

    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn words_are_found_in_text_by_the_language_of_their_run() {
        let mut s = HyphenStore::new();
        s.load("en", EN, "", 2, 3).unwrap();
        let text = units("hyphenation 12hyphenation hyphenation");
        // One run in English, one in a language the store does not hold.
        let first = u32::try_from("hyphenation 12hyphenation ".len()).unwrap();
        let ends = [first, u32::try_from(text.len()).unwrap()];
        let langs = ["en".to_string(), "xx".to_string()];
        let points = word_points(&s, &text, &ends, &langs);
        // Only the first word of the first run: "12hyphenation" touches digits.
        assert_eq!(points, vec![2, 4, 6, 7]);
    }

    #[test]
    fn nothing_is_found_without_a_language_and_surrogate_pairs_keep_their_offsets() {
        let s = HyphenStore::new();
        let t = units("hyphenation");
        assert!(word_points(&s, &t, &[11], &["en".to_string()]).is_empty());
        let mut s = HyphenStore::new();
        s.load("en", EN, "", 1, 1).unwrap();
        // 𝔘 (U+1D518) is a letter in two code units; the word starts after the space.
        let text = units("\u{1d518} hyphenation");
        let points = word_points(
            &s,
            &text,
            &[u32::try_from(text.len()).unwrap()],
            &["en".to_string()],
        );
        assert!(points.iter().all(|&p| p >= 3));
        assert_eq!(points.first().copied(), Some(3 + 2));
    }
}
