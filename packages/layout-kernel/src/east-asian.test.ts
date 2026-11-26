/**
 * WASM-016 criterion 1: line breaking by language for East Asian text, through the package's
 * wrapper on the real build in Node.js. The rules are tested in the crate
 * (`crates/layout-kernel/src/segment.rs`); these tests check the wrapper and give per-language
 * samples as a reader of the plan (docs/adr/0208-lane-FE-105-117.md, "Plan for FE-112", section 3)
 * would write them. A sample is a sentence and the offsets before which a line may break, the end of
 * the text excluded.
 */
import { describe, expect, it } from 'vitest';
import { kernelIsBuilt, loadNodeKernel } from '../node/index.ts';

const built = kernelIsBuilt();
if (process.env['DOCEDIT_KERNEL_REQUIRED'] === '1' && !built)
  throw new Error('dist/ is not built: run build:wasm first');

/** Japanese: a plain sentence, and the cases that kinsoku names. */
const JAPANESE: ReadonlyArray<readonly [string, string, readonly number[]]> = [
  ['a comma never starts a line', '今日は、晴れ', [1, 2, 4, 5]],
  ['a small kana never starts a line', 'きゃく', [2]],
  ['the prolonged sound mark and a small tsu never start a line', 'カーペット', [2, 4]],
  ['an opening bracket never ends a line, a closing one never starts one', '字「語」', [1]],
  ['no break goes before the ideographic space', 'あ　い', [2]],
  [
    'a small tsu, a full stop and the brackets of a quotation follow the kinsoku rules',
    '彼は言った。「行こう」と',
    [1, 2, 4, 6, 8, 9, 11],
  ],
];

const CHINESE: ReadonlyArray<readonly [string, string, readonly number[]]> = [
  ['a break before an opening quote and after the full stop', '他说“你好”，再见', [1, 2, 4, 7, 8]],
  ['a break after a closing quote before an ideograph', '“你好”再见', [2, 4, 5]],
  ['no break after an opening quote and the space behind it', '你“ 好', [1]],
  ['a Latin sentence is not changed', 'He said “hi” now', [3, 8, 13]],
];

const KOREAN: ReadonlyArray<readonly [string, string, readonly number[]]> = [
  ['breaks at spaces only', '한국어 문장을 씁니다', [4, 8]],
  ['breaks after a hyphen', '가-나', [2]],
  ['Latin letters stay with Hangul', '한abc', []],
];

describe.skipIf(!built)('line breaking by language (WASM-016)', () => {
  const groups = [
    ['ja', JAPANESE],
    ['zh-Hans', CHINESE],
    ['ko-KR', KOREAN],
  ] as const;

  for (const [language, samples] of groups) {
    for (const [name, text, offsets] of samples) {
      it(`${language}: ${name}`, async () => {
        const kernel = await loadNodeKernel();
        expect(kernel.segmenter.opportunities(text, language)).toEqual(offsets);
      });
    }
  }

  it('gives the default answer without a language, with an empty one and with another language', async () => {
    const kernel = await loadNodeKernel();
    const text = '한국어 문장을 씁니다';
    const plain = kernel.segmenter.opportunities(text);
    expect(plain).toEqual([1, 2, 4, 5, 6, 8, 9, 10]);
    expect(kernel.segmenter.opportunities(text, '')).toEqual(plain);
    expect(kernel.segmenter.opportunities(text, 'en')).toEqual(plain);
    expect(kernel.segmenter.lineBreaks(text, 'en')).toEqual(kernel.segmenter.lineBreaks(text));
  });

  it('keeps the mandatory break at the end of the text and after a hard line break', async () => {
    const kernel = await loadNodeKernel();
    expect(kernel.segmenter.lineBreaks('한\n국', 'ko')).toEqual([
      { offset: 2, mandatory: true },
      { offset: 3, mandatory: true },
    ]);
  });

  it('reads the language tag in either case and with a region or a script', async () => {
    const kernel = await loadNodeKernel();
    const text = '한국어 문장을 씁니다';
    for (const tag of ['ko', 'KO', 'ko-KR', 'ko_KR', 'kor'])
      expect(kernel.segmenter.opportunities(text, tag), tag).toEqual([4, 8]);
    for (const tag of ['zh', 'zh-Hant-TW', 'yue-HK'])
      expect(kernel.segmenter.opportunities('“你好”再见', tag), tag).toEqual([2, 4, 5]);
  });

  it('never breaks inside a surrogate pair', async () => {
    const kernel = await loadNodeKernel();
    // U+20BB7, an ideograph outside the BMP, in Japanese text.
    const text = '𠮷野家';
    expect(kernel.segmenter.opportunities(text, 'ja')).toEqual([2, 3]);
  });
});
