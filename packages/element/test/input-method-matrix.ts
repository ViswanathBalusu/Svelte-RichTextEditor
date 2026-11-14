/**
 * The input-method matrix (FE-123, criterion 1): the composition and dead-key cases the editing
 * surface must pass, each with the way it is driven. A case is automated only where a browser lets
 * Playwright drive that input method step by step (`DRIVER_FACTS`, from e2e/s1-input-drivers.spec.ts
 * and e2e/s1-composition.spec.ts); the rest need a scripted manual pass, recorded per browser and
 * version (criterion 3, not written yet).
 *
 * Data only: the drivers that run these cases are the e2e suites. Languages and platforms are the
 * ones the story names: Japanese, Chinese and Korean composition, dead keys, and one Android and
 * one iOS keyboard.
 */

/** How a case is driven: automated through the browser, or by a scripted manual pass. */
export type Driver = 'automated' | 'manual';

export interface InputMethodCase {
  readonly id: string;
  /** Language or input family the case covers. */
  readonly kind: 'composition' | 'dead-key' | 'mobile-keyboard';
  readonly language: 'ja' | 'zh' | 'ko' | 'fr' | 'en';
  /** The keyboard, platform or input method the sequence is shaped like. */
  readonly method: string;
  /** The keystrokes or composition updates, in order. */
  readonly steps: readonly string[];
  /** The text the case commits, or the text the dead key and base letter produce. */
  readonly commit: string;
  /** Driver per browser family: Chromium (Chrome, Edge), Gecko (Firefox), WebKit (Safari). */
  readonly drivers: { readonly chromium: Driver; readonly gecko: Driver; readonly webkit: Driver };
  /** What is automated around a manual case, where something is. */
  readonly note?: string;
}

export type BrowserFamily = 'chromium' | 'gecko' | 'webkit';

/**
 * What Playwright 1.65 can drive in each browser family, as e2e/s1-input-drivers.spec.ts and
 * e2e/s1-composition.spec.ts assert it (spike S1, SPK-014). The e2e spec checks these values
 * against what each browser does, and the matrix test derives every case's driver from them.
 *
 * - `stepwiseComposition`: a composition driven update by update. Chromium only, through the
 *   devtools protocol's `Input.imeSetComposition`; WebKit and Firefox expose no such command.
 * - `commitOnlyComposition`: a composition that opens and commits its whole text in one update
 *   (`keyboard.insertText`). Firefox only; it does not exercise the intermediate updates.
 * - `deadKeyPress`: a dead key pressed through the keyboard API. No browser: Playwright answers
 *   `Unknown key: "Dead"`.
 * - `mobileKeyboard`: an Android or iOS on-screen keyboard. No desktop browser drives one.
 */
export const DRIVER_FACTS = {
  stepwiseComposition: { chromium: true, gecko: false, webkit: false },
  commitOnlyComposition: { chromium: false, gecko: true, webkit: false },
  deadKeyPress: { chromium: false, gecko: false, webkit: false },
  mobileKeyboard: { chromium: false, gecko: false, webkit: false },
} as const satisfies Record<string, Record<BrowserFamily, boolean>>;

/** The driver a case can have in a browser family, from the facts above. */
export function driverFromFacts(kind: InputMethodCase['kind'], family: BrowserFamily): Driver {
  const fact =
    kind === 'composition'
      ? DRIVER_FACTS.stepwiseComposition
      : kind === 'dead-key'
        ? DRIVER_FACTS.deadKeyPress
        : DRIVER_FACTS.mobileKeyboard;
  return fact[family] ? 'automated' : 'manual';
}

/** Notes shared by the cases: what is automated around their manual passes. */
const GECKO_COMMIT_ONLY =
  'Firefox: only a one-step commit (keyboard.insertText) is automated (e2e/s1-composition.spec.ts, "one-step commit"); the stepwise case is manual.';
const DEAD_KEY_SIMULATION =
  'Chromium: the event sequences of a Windows and a macOS dead key are simulated through the devtools protocol (e2e/s1-composition.spec.ts, "dead keys"); a real keyboard layout is not, so every browser has the manual pass.';

export const INPUT_METHOD_MATRIX: readonly InputMethodCase[] = [
  {
    id: 'ja-romaji-kana-kanji',
    kind: 'composition',
    language: 'ja',
    method: 'Japanese IME, romaji input',
    steps: ['k', 'か', 'かn', 'かな'],
    commit: '仮名',
    drivers: { chromium: 'automated', gecko: 'manual', webkit: 'manual' },
    note: GECKO_COMMIT_ONLY,
  },
  {
    id: 'zh-pinyin',
    kind: 'composition',
    language: 'zh',
    method: 'Chinese pinyin IME',
    steps: ['n', 'ni', 'nih', 'niha', 'nihao'],
    commit: '你好',
    drivers: { chromium: 'automated', gecko: 'manual', webkit: 'manual' },
    note: GECKO_COMMIT_ONLY,
  },
  {
    id: 'ko-hangul-2set',
    kind: 'composition',
    language: 'ko',
    method: 'Korean Hangul 2-set IME',
    steps: ['ㅎ', '하', '한'],
    commit: '한',
    drivers: { chromium: 'automated', gecko: 'manual', webkit: 'manual' },
    note: GECKO_COMMIT_ONLY,
  },
  {
    id: 'fr-dead-acute',
    kind: 'dead-key',
    language: 'fr',
    method: 'French keyboard, dead acute accent',
    steps: ['´', 'e'],
    commit: 'é',
    drivers: { chromium: 'manual', gecko: 'manual', webkit: 'manual' },
    note: DEAD_KEY_SIMULATION,
  },
  {
    id: 'en-us-intl-dead-circumflex',
    kind: 'dead-key',
    language: 'en',
    method: 'US International keyboard, dead circumflex',
    steps: ['^', 'o'],
    commit: 'ô',
    drivers: { chromium: 'manual', gecko: 'manual', webkit: 'manual' },
    note: DEAD_KEY_SIMULATION,
  },
  {
    id: 'android-gboard-ja',
    kind: 'mobile-keyboard',
    language: 'ja',
    method: 'Android on-screen keyboard (Gboard), Japanese composition',
    steps: ['k', 'か', 'かな'],
    commit: '仮名',
    drivers: { chromium: 'manual', gecko: 'manual', webkit: 'manual' },
  },
  {
    id: 'ios-keyboard-ko',
    kind: 'mobile-keyboard',
    language: 'ko',
    method: 'iOS on-screen keyboard, Korean composition',
    steps: ['ㄱ', '구', '국'],
    commit: '국',
    drivers: { chromium: 'manual', gecko: 'manual', webkit: 'manual' },
  },
];

/** The editing surfaces each case runs in: the main body and the two sub-editors (FE-123 criterion 2). */
export const MATRIX_EDITORS = ['main', 'footnote', 'header'] as const;

/** Whether remote commits arrive while the composition is open (FE-123 criterion 2). */
export const MATRIX_REMOTE_MODES = ['none', 'during-composition'] as const;

export interface MatrixRun {
  readonly case: InputMethodCase;
  readonly editor: (typeof MATRIX_EDITORS)[number];
  readonly remote: (typeof MATRIX_REMOTE_MODES)[number];
}

/** Every case in every editor and with and without remote commits. */
export function matrixRuns(cases: readonly InputMethodCase[] = INPUT_METHOD_MATRIX): MatrixRun[] {
  const runs: MatrixRun[] = [];
  for (const c of cases)
    for (const editor of MATRIX_EDITORS)
      for (const remote of MATRIX_REMOTE_MODES) runs.push({ case: c, editor, remote });
  return runs;
}
