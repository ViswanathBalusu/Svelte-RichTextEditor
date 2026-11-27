//! Word-boundary line breaking for Thai, Lao, Khmer and Burmese (WASM-016; owner decision 282).
//!
//! These scripts are written without spaces between words, so the line-break rules of UAX #14 find
//! no place to break inside a run of them, and the dictionaries of ICU4X do. The dictionaries are
//! large, so they live in this module and in no other: the layout kernel (`docedit-layout-kernel`)
//! stays the size it is, and a page fetches this file only when a document holds one of the scripts.
//!
//! One call, `southeast_asian_breaks`, returns the offsets inside a run of these scripts at which a
//! line may break. The caller adds them to the opportunities of the kernel. Offsets are UTF-16 code
//! units of the text, the rule of 09 §7.1.
//!
//! The crate forbids unsafe code. The glue that wasm-bindgen writes is not part of this crate.

#![forbid(unsafe_code)]

use icu_segmenter::options::LineBreakOptions;
use icu_segmenter::LineSegmenter;
use wasm_bindgen::prelude::*;

/// The version of the call interface. It changes when a call changes its meaning or is added.
pub const ABI_VERSION: u32 = 1;

/// The version of the crate, as `major.minor.patch`.
#[wasm_bindgen]
pub fn sea_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// The version of the call interface (`ABI_VERSION`).
#[wasm_bindgen]
pub fn sea_abi_version() -> u32 {
    ABI_VERSION
}

/// True when a UTF-16 code unit belongs to Thai, Lao, Khmer or Burmese: Thai, Lao, Myanmar,
/// Khmer, Khmer Symbols, Myanmar Extended-A and Myanmar Extended-B. All are in the Basic
/// Multilingual Plane, so no surrogate is in a run.
pub fn is_southeast_asian(unit: u16) -> bool {
    matches!(
        unit,
        0x0E00..=0x0EFF | 0x1000..=0x109F | 0x1780..=0x17FF | 0x19E0..=0x19FF | 0xA9E0..=0xA9FF
            | 0xAA60..=0xAA7F
    )
}

/// The offsets inside the maximal runs of these scripts at which a line may break, ascending. The
/// first and the last offset of a run are not returned: the rules of UAX #14 decide those, and the
/// kernel answers them. Text with no such run gives an empty list and loads no dictionary.
pub fn breaks(text: &[u16]) -> Vec<u32> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut segmenter: Option<icu_segmenter::LineSegmenterBorrowed<'static>> = None;
    while start < text.len() {
        if !text.get(start).copied().is_some_and(is_southeast_asian) {
            start += 1;
            continue;
        }
        let mut end = start;
        while text.get(end).copied().is_some_and(is_southeast_asian) {
            end += 1;
        }
        let Some(run) = text.get(start..end) else {
            break;
        };
        // The segmenter is made on the first run: the dictionaries are read on demand.
        let segmenter = segmenter.get_or_insert_with(|| {
            let mut s = LineSegmenter::new_for_non_complex_scripts(LineBreakOptions::default());
            s.load_dictionary();
            s
        });
        let base = u32::try_from(start).unwrap_or(u32::MAX);
        let len = run.len();
        for offset in segmenter.segment_utf16(run) {
            if offset > 0 && offset < len {
                out.push(base.saturating_add(u32::try_from(offset).unwrap_or(u32::MAX)));
            }
        }
        start = end;
    }
    out
}

/// The offsets inside runs of Thai, Lao, Khmer and Burmese at which a line may break
/// (`breaks`), as UTF-16 offsets of `text`, ascending.
#[wasm_bindgen]
pub fn southeast_asian_breaks(text: &[u16]) -> Vec<u32> {
    breaks(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    #[test]
    fn text_without_these_scripts_has_no_breaks() {
        assert!(breaks(&units("Hello world, 1.5 and 日本語")).is_empty());
        assert!(breaks(&[]).is_empty());
    }

    #[test]
    fn thai_breaks_between_words() {
        // "I eat rice": ฉัน (I) กิน (eat) ข้าว (rice).
        let text = units("ฉันกินข้าว");
        assert_eq!(breaks(&text), vec![3, 6]);
    }

    #[test]
    fn a_run_is_cut_out_of_the_text_around_it() {
        let text = units("Eat: ฉันกินข้าว!");
        // The run starts at offset 5 and ends at 15; the breaks lie inside it.
        assert_eq!(breaks(&text), vec![8, 11]);
    }

    #[test]
    fn lao_khmer_and_burmese_break_between_words() {
        // "I eat rice" in each script; the offsets are UTF-16 code units, and each is the start of a
        // word the dictionary found (Lao keeps "eat rice" as one word).
        assert_eq!(breaks(&units("ຂ້ອຍກິນເຂົ້າ")), vec![4]);
        assert_eq!(breaks(&units("ខ្ញុំញុំាបាយ")), vec![5, 9]);
        assert_eq!(breaks(&units("ကျွန်တော်ထမင်းစားတယ်")), vec![9, 17]);
    }

    #[test]
    fn a_longer_thai_sentence_has_a_break_at_each_word() {
        // "Welcome, everyone": สวัสดี ครับ ทุก คน ยินดี ต้อนรับ.
        assert_eq!(
            breaks(&units("สวัสดีครับทุกคนยินดีต้อนรับ")),
            vec![6, 10, 13, 15, 20]
        );
    }

    #[test]
    fn breaks_are_ascending_and_never_at_the_ends_of_a_run() {
        let text = units("ฉันกินข้าว ຂ້ອຍກິນເຂົ້າ abc ကျွန်တော်ထမင်းစားတယ်");
        let found = breaks(&text);
        assert!(found.windows(2).all(|pair| pair[0] < pair[1]));
        for offset in found {
            let at = usize::try_from(offset).unwrap_or(usize::MAX);
            assert!(is_southeast_asian(text[at - 1]) && is_southeast_asian(text[at]));
        }
    }

    #[test]
    fn the_scripts_are_told_apart_from_the_rest() {
        assert!(is_southeast_asian(0x0E01));
        assert!(is_southeast_asian(0x0E81));
        assert!(is_southeast_asian(0x1780));
        assert!(is_southeast_asian(0x1000));
        assert!(!is_southeast_asian(u16::from(b'a')));
        assert!(!is_southeast_asian(0x3042));
        assert!(!is_southeast_asian(0xD800));
    }
}
