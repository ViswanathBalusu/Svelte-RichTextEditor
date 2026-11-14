/**
 * Text for the corpus (FND-006). Everything here is original: the word lists, the sentence
 * patterns and the Chinese, Japanese and Korean sentences were written for this corpus, and the
 * prose is assembled from them by a seeded generator. Nothing is copied from another work, so the
 * provenance of every word is this file (see SOURCES in sources.ts).
 *
 * The generated English reads as plausible but meaningless prose. It contains ligature-rich words
 * (office, efficient, fjord, suffix) and kerning pairs at sentence starts (To, Va, Wa, Ye, AV), which
 * the layout and painting harnesses need (FE stories on painted widths).
 */
import type { Rng } from './random.ts';

interface Noun {
  one: string;
  many: string;
}

const noun = (one: string, many = `${one}s`): Noun => ({ one, many });

const NOUNS: readonly Noun[] = [
  noun('document'),
  noun('paragraph'),
  noun('section'),
  noun('table'),
  noun('figure'),
  noun('caption'),
  noun('footnote'),
  noun('heading'),
  noun('page'),
  noun('margin'),
  noun('column'),
  noun('region'),
  noun('style'),
  noun('typeface'),
  noun('line'),
  noun('word'),
  noun('reader'),
  noun('author'),
  noun('editor'),
  noun('reviewer'),
  noun('draft'),
  noun('version'),
  noun('record'),
  noun('change'),
  noun('outline'),
  noun('list'),
  noun('item'),
  noun('chapter'),
  noun('appendix', 'appendices'),
  noun('index', 'indexes'),
  noun('reference'),
  noun('summary', 'summaries'),
  noun('report'),
  noun('workflow'),
  noun('office'),
  noun('archive'),
  noun('template'),
  noun('layout'),
  noun('printer'),
  noun('river'),
  noun('valley', 'valleys'),
  noun('harbour'),
  noun('meadow'),
  noun('forest'),
  noun('garden'),
  noun('bridge'),
  noun('window'),
  noun('lantern'),
  noun('compass', 'compasses'),
  noun('journal'),
  noun('ledger'),
  noun('harvest'),
  noun('season'),
  noun('signal'),
  noun('pattern'),
  noun('measure'),
  noun('balance'),
  noun('surface'),
  noun('boundary', 'boundaries'),
  noun('channel'),
  noun('offset'),
  noun('fjord'),
  noun('suffix', 'suffixes'),
  noun('waveform'),
  noun('avenue'),
  noun('tower'),
  noun('workshop'),
  noun('beacon'),
  noun('quarry', 'quarries'),
  noun('schedule'),
];

const ADJECTIVES: readonly string[] = [
  'careful',
  'quiet',
  'steady',
  'narrow',
  'wide',
  'early',
  'late',
  'final',
  'shared',
  'local',
  'formal',
  'plain',
  'clear',
  'brief',
  'long',
  'short',
  'simple',
  'small',
  'large',
  'modest',
  'patient',
  'official',
  'efficient',
  'difficult',
  'gentle',
  'bright',
  'distant',
  'familiar',
  'regular',
  'separate',
  'complete',
  'partial',
  'previous',
  'current',
  'stable',
  'fluent',
  'swift',
  'tidy',
  'sturdy',
  'hidden',
  'open',
  'level',
  'even',
  'awkward',
  'flawless',
  'western',
  'northern',
  'coastal',
];

interface Verb {
  /** Third person singular: "checks". */
  s: string;
  /** Plural and infinitive: "check". */
  base: string;
}

const verb = (base: string, s = `${base}s`): Verb => ({ s, base });

const VERBS: readonly Verb[] = [
  verb('check'),
  verb('follow'),
  verb('mark'),
  verb('carry', 'carries'),
  verb('hold'),
  verb('keep'),
  verb('move'),
  verb('measure'),
  verb('record'),
  verb('reach'),
  verb('join'),
  verb('split'),
  verb('frame'),
  verb('balance'),
  verb('describe'),
  verb('repeat'),
  verb('shelter'),
  verb('outline'),
  verb('number'),
  verb('align'),
  verb('offset'),
  verb('affirm'),
  verb('shuffle'),
  verb('fill'),
  verb('flank'),
  verb('gather'),
  verb('trace'),
  verb('support'),
  verb('replace'),
  verb('approach', 'approaches'),
  verb('watch', 'watches'),
  verb('cross', 'crosses'),
  verb('finish', 'finishes'),
  verb('return'),
  verb('extend'),
  verb('signal'),
];

const ADVERBS: readonly string[] = [
  'quietly',
  'slowly',
  'gradually',
  'often',
  'rarely',
  'usually',
  'carefully',
  'evenly',
  'briefly',
  'again',
  'early',
  'later',
  'together',
  'efficiently',
  'officially',
  'steadily',
];

const PREPOSITIONS: readonly string[] = [
  'across',
  'along',
  'behind',
  'beside',
  'beyond',
  'near',
  'under',
  'over',
  'through',
  'within',
  'after',
  'before',
  'towards',
  'around',
];

const QUANTITIES: readonly string[] = [
  'two',
  'three',
  'four',
  'several',
  'many',
  'a few',
  'twelve',
  'fifty',
];

/** "a" or "an". The adjectives above are chosen so that the first letter decides. */
function article(word: string): string {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A seeded writer of English-like prose. */
export class Prose {
  readonly #rng: Rng;

  constructor(rng: Rng) {
    this.#rng = rng;
  }

  #np(): string {
    const r = this.#rng;
    const n = r.pick(NOUNS).one;
    switch (r.int(5)) {
      case 0:
        return `the ${n}`;
      case 1:
        return `the ${r.pick(ADJECTIVES)} ${n}`;
      case 2:
        return article(`${r.pick(ADJECTIVES)} ${n}`);
      case 3:
        return `each ${n}`;
      default:
        return `this ${n}`;
    }
  }

  #plural(): string {
    const r = this.#rng;
    return r.chance(0.5) ? r.pick(NOUNS).many : `${r.pick(ADJECTIVES)} ${r.pick(NOUNS).many}`;
  }

  /** One sentence, ending with a full stop. */
  sentence(): string {
    const r = this.#rng;
    const v = r.pick(VERBS);
    const v2 = r.pick(VERBS);
    let s: string;
    switch (r.int(12)) {
      case 0:
        s = `${this.#np()} ${v.s} ${this.#np()}`;
        break;
      case 1:
        s = `${this.#np()} ${v.s} ${this.#np()} ${r.pick(PREPOSITIONS)} ${this.#np()}`;
        break;
      case 2:
        s = `when ${this.#np()} ${v.s} ${r.pick(ADVERBS)}, ${this.#np()} ${v2.s} ${this.#np()}`;
        break;
      case 3:
        s = `${this.#np()} and ${this.#np()} ${v.base} ${this.#np()} ${r.pick(PREPOSITIONS)} ${this.#np()}`;
        break;
      case 4:
        s = `${this.#np()} ${v.s} ${r.pick(QUANTITIES)} ${this.#plural()} before ${this.#np()} ${v2.s}`;
        break;
      case 5:
        s = `${r.pick(ADVERBS)}, ${this.#np()} ${v.s} ${this.#np()} ${r.pick(PREPOSITIONS)} ${this.#np()}`;
        break;
      case 6:
        s = `${this.#np()}, which ${v.s} ${this.#np()}, ${v2.s} ${r.pick(ADVERBS)}`;
        break;
      case 7:
        s = `to ${v.base} ${this.#np()}, ${this.#np()} ${v2.s} ${this.#np()}`;
        break;
      case 8:
        s = `yet ${this.#np()} ${v.s} ${this.#np()} ${r.pick(PREPOSITIONS)} ${this.#np()}`;
        break;
      case 9:
        s = `various ${this.#plural()} ${v.base} ${this.#np()} ${r.pick(PREPOSITIONS)} ${this.#np()}`;
        break;
      case 10:
        s = `water ${v.s} ${this.#np()} while ${this.#np()} ${v2.s} ${this.#np()}`;
        break;
      default:
        s = `${this.#np()} ${v.s} ${this.#np()}; ${this.#np()} ${v2.s} ${r.pick(ADVERBS)}`;
        break;
    }
    return `${capitalise(s)}.`;
  }

  /** Sentences joined by spaces until the text has at least `minWords` words. */
  paragraph(minWords: number): string {
    const out: string[] = [];
    let words = 0;
    while (words < minWords) {
      const s = this.sentence();
      out.push(s);
      words += s.split(' ').length;
    }
    return out.join(' ');
  }

  /** Sentences until the text has at least `minLength` characters (UTF-16 code units, all ASCII). */
  longParagraph(minLength: number): string {
    const out: string[] = [];
    let length = -1;
    while (length < minLength) {
      const s = this.sentence();
      out.push(s);
      length += s.length + 1;
    }
    return out.join(' ');
  }

  /** A short title in title case, such as "Steady Margins and Bridges". */
  title(): string {
    const r = this.#rng;
    const words =
      r.int(3) === 0
        ? [r.pick(ADJECTIVES), r.pick(NOUNS).many]
        : [r.pick(ADJECTIVES), r.pick(NOUNS).many, 'and', r.pick(NOUNS).many];
    return words.map((w) => (w === 'and' ? w : capitalise(w))).join(' ');
  }

  /** A noun phrase without an article, such as "steady margin". */
  phrase(): string {
    const r = this.#rng;
    return `${r.pick(ADJECTIVES)} ${r.pick(NOUNS).one}`;
  }

  /** Words for a list item: one short clause without a final full stop. */
  clause(): string {
    const r = this.#rng;
    return capitalise(`${this.#np()} ${r.pick(VERBS).s} ${this.#np()}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Chinese, Japanese and Korean. Simple original sentences about documents and editing, written
// for this corpus. They carry the punctuation, mixed scripts and line-breaking cases that layout
// and export need: full-width punctuation, brackets, Latin words inside CJK text, and Hangul with
// spaces between words.

export const CHINESE: readonly string[] = [
  '本段文字用于检验中文的排版效果。',
  '编辑器需要正确处理标点符号、行首和行尾的禁则，以及中文与西文之间的间距。',
  '每个句子都由程序从固定的短句中选出，内容本身没有特别的含义。',
  '表格、脚注和页眉中也可能出现中文。',
  '文档由段落、标题、列表和表格组成，样式决定它们的外观。',
  '多人协作时，每一次修改都会记录在提交日志中。',
  '导出PDF时，换行和分页的位置应当与编辑器中一致。',
  '“引号”和（括号）在行首或行尾时需要特别处理。',
  '这一页的页码由页脚中的域自动计算。',
  '目录中的条目根据带有大纲级别的标题生成。',
];

export const JAPANESE: readonly string[] = [
  'この段落は日本語の組版を確認するためのものです。',
  '句読点や括弧の扱い、行頭と行末の禁則処理が正しく行われる必要があります。',
  '文章はあらかじめ用意した短い文から選ばれており、内容に特別な意味はありません。',
  '表や脚注、ヘッダーにも日本語が現れることがあります。',
  'テキストのレイアウトは、エディターとPDFで一致させます。',
  '共同編集では、すべての変更が履歴に記録されます。',
  'ひらがな、カタカナ、漢字が一つの文の中に混在します。',
  '「かぎ括弧」や『二重かぎ括弧』も行頭と行末で扱いが変わります。',
  'ページ番号はフッターのフィールドで自動的に計算されます。',
  '見出しのアウトラインレベルから目次が作られます。',
];

export const KOREAN: readonly string[] = [
  '이 문단은 한국어 조판을 확인하기 위한 것입니다.',
  '띄어쓰기와 문장 부호, 줄 바꿈 규칙이 올바르게 처리되어야 합니다.',
  '문장은 미리 준비한 짧은 문장에서 골라 만들었으며 내용에 특별한 의미는 없습니다.',
  '표와 각주, 머리글에도 한글이 나타날 수 있습니다.',
  '문서는 문단, 제목, 목록, 표로 이루어지며 스타일이 모양을 정합니다.',
  '공동 편집에서는 모든 변경 사항이 기록됩니다.',
  'PDF로 내보낼 때 줄과 쪽이 나뉘는 위치는 편집기와 같아야 합니다.',
  '한글과 English 단어가 한 문장 안에 섞여 있습니다.',
  '쪽 번호는 바닥글의 필드가 자동으로 계산합니다.',
  '목차는 개요 수준이 있는 제목에서 만들어집니다.',
];

export type CjkLanguage = 'zh' | 'ja' | 'ko';

export const CJK_LANG_TAGS: Readonly<Record<CjkLanguage, string>> = {
  zh: 'zh-Hans-CN',
  ja: 'ja-JP',
  ko: 'ko-KR',
};

const CJK_SENTENCES: Readonly<Record<CjkLanguage, readonly string[]>> = {
  zh: CHINESE,
  ja: JAPANESE,
  ko: KOREAN,
};

/** CJK text of at least `minChars` code points; Korean sentences are separated by spaces. */
export function cjkText(rng: Rng, lang: CjkLanguage, minChars: number): string {
  const sentences = CJK_SENTENCES[lang];
  const out: string[] = [];
  let n = 0;
  let last = -1;
  while (n < minChars) {
    let i = rng.int(sentences.length);
    if (i === last) i = (i + 1) % sentences.length;
    last = i;
    const s = sentences[i]!;
    out.push(s);
    n += [...s].length;
  }
  return out.join(lang === 'ko' ? ' ' : '');
}

// ---------------------------------------------------------------------------------------------
// Fixed English passages, written for this corpus.

export const TYPOGRAPHY_SAMPLES: readonly string[] = [
  'Characters that TeX treats specially must arrive as typed: 50% of R&D costs, item #12, $300, a_b, {braces}, ~/notes, x^2 and a backslash \\ in C:\\temp.',
  "Dashes and quotes stay as written: an en dash – and an em dash —, “double” and ‘single’ quotes, ``TeX quotes'', two hyphens -- and three ---.",
  'Spacing is kept exactly:  two spaces here, a no-break space between 10\u00a0km, a soft hy\u00adphen, and an ellipsis…',
  'Ligatures and kerning: office, efficient, affluent, fjord, shuffle, suffix, flagship; AVATAR, Toward, Wave, Yes, LTA, P.V.',
];

export const SIMPLE_EQUATIONS: readonly string[] = [
  'E = mc^2',
  'a^2 + b^2 = c^2',
  '\\alpha + \\beta = \\gamma',
  '\\sqrt{2} \\approx 1.414',
  '\\frac{1}{2} + \\frac{1}{3} = \\frac{5}{6}',
  'e^{i\\pi} + 1 = 0',
  "x_{n+1} = x_n - \\frac{f(x_n)}{f'(x_n)}",
  '\\sin^2 \\theta + \\cos^2 \\theta = 1',
  'n! = n \\cdot (n-1)!',
  '\\lim_{n \\to \\infty} \\left(1 + \\frac{1}{n}\\right)^n = e',
];

export const DISPLAY_EQUATIONS: readonly string[] = [
  '\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}',
  '\\int_{0}^{1} x^{2} dx = \\frac{1}{3}',
  '\\begin{aligned} (a+b)^2 &= a^2 + 2ab + b^2 \\\\ (a-b)^2 &= a^2 - 2ab + b^2 \\end{aligned}',
  'f(x) = \\begin{cases} x & x \\geq 0 \\\\ -x & x < 0 \\end{cases}',
  'I = \\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix}',
  '\\binom{n}{k} = \\frac{n!}{k!(n-k)!}',
  '\\prod_{i=1}^{n} q^{i} = q^{\\frac{n(n+1)}{2}}',
  '\\begin{gathered} x + y = 10 \\\\ x - y = 2 \\end{gathered}',
];
