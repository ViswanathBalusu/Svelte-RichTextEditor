/**
 * The converter between LaTeX and Office math (09 §6.1; EXP-054 decision 234; EXP-096, EXP-105).
 * It is our own code: no TeX engine, no file, no other converter. LaTeX of the allow-list below is
 * read into a tree shaped like MathML (the intermediate form of 09 §6.1), and the tree is written
 * as LaTeX or as Office math (`math-omml.ts`). Anything the tables and the grammar do not cover
 * is refused with a `MathConvertError`: "not converted", never a guess.
 *
 * The input is untrusted, so it is bounded: length, nesting depth and node count. The output of
 * `toLatex` is built only from the tables and from text that has passed `safeText`, so it holds no
 * command that is not in the tables below. It still goes through the math gate of 09 §6.3 before it
 * is stored (EXP-105); this module does not replace the gate.
 */

export class MathConvertError extends Error {
  override name = 'MathConvertError';
}

/** The bounds of the converter (09 §6.3 limits length to 4,000 characters and depth to 50). */
export const MATH_LIMITS = { length: 4000, depth: 50, nodes: 8000 } as const;

export type MathNode =
  | { k: 'row'; items: MathNode[] }
  /** An identifier: a letter, a Greek letter or a name. `style` p is upright, b is bold. */
  | { k: 'mi'; text: string; style?: 'p' | 'b' }
  | { k: 'mn'; text: string }
  | { k: 'mo'; text: string }
  | { k: 'mtext'; text: string }
  | { k: 'script'; base: MathNode; sub: MathNode | null; sup: MathNode | null }
  | { k: 'frac'; num: MathNode; den: MathNode; bar: boolean }
  | { k: 'root'; body: MathNode; degree: MathNode | null }
  | {
      k: 'nary';
      op: string;
      sub: MathNode | null;
      sup: MathNode | null;
      under: boolean;
      body: MathNode;
    }
  | { k: 'fence'; open: string; close: string; body: MathNode }
  | { k: 'accent'; mark: string; base: MathNode }
  | { k: 'bar'; bottom: boolean; base: MathNode }
  | { k: 'limit'; base: MathNode; under: MathNode | null; over: MathNode | null }
  | { k: 'matrix'; rows: MathNode[][] };

// ---------------------------------------------------------------------------------------------
// Tables.

const GREEK_LOWER: Record<string, string> = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ϵ',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  varpi: 'ϖ',
  rho: 'ρ',
  varrho: 'ϱ',
  sigma: 'σ',
  varsigma: 'ς',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'ϕ',
  varphi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
};
const GREEK_UPPER: Record<string, string> = {
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
};
/** Greek letters and the other letter-like symbols that are identifiers. */
const LETTERS: Record<string, string> = {
  ...GREEK_LOWER,
  ...GREEK_UPPER,
  hbar: 'ℏ',
  ell: 'ℓ',
  aleph: 'ℵ',
  Re: 'ℜ',
  Im: 'ℑ',
};

/** Symbols that are operators or relations. */
const SYMBOLS: Record<string, string> = {
  pm: '±',
  mp: '∓',
  times: '×',
  div: '÷',
  cdot: '⋅',
  ast: '∗',
  star: '⋆',
  circ: '∘',
  bullet: '∙',
  leq: '≤',
  le: '≤',
  geq: '≥',
  ge: '≥',
  neq: '≠',
  ne: '≠',
  approx: '≈',
  equiv: '≡',
  sim: '∼',
  simeq: '≃',
  cong: '≅',
  propto: '∝',
  ll: '≪',
  gg: '≫',
  subset: '⊂',
  supset: '⊃',
  subseteq: '⊆',
  supseteq: '⊇',
  in: '∈',
  notin: '∉',
  ni: '∋',
  cup: '∪',
  cap: '∩',
  setminus: '∖',
  wedge: '∧',
  vee: '∨',
  neg: '¬',
  lnot: '¬',
  forall: '∀',
  exists: '∃',
  nexists: '∄',
  emptyset: '∅',
  varnothing: '∅',
  infty: '∞',
  partial: '∂',
  nabla: '∇',
  to: '→',
  rightarrow: '→',
  leftarrow: '←',
  leftrightarrow: '↔',
  Rightarrow: '⇒',
  Leftarrow: '⇐',
  Leftrightarrow: '⇔',
  mapsto: '↦',
  uparrow: '↑',
  downarrow: '↓',
  ldots: '…',
  dots: '…',
  cdots: '⋯',
  vdots: '⋮',
  ddots: '⋱',
  prime: '′',
  angle: '∠',
  perp: '⊥',
  parallel: '∥',
  mid: '∣',
  oplus: '⊕',
  otimes: '⊗',
  degree: '°',
  '%': '%',
  '#': '#',
  '&': '&',
  $: '$',
};

/** Delimiters of `\left` and `\right`, and the bare characters that are fences. */
const DELIMITERS: Record<string, string> = {
  '(': '(',
  ')': ')',
  '[': '[',
  ']': ']',
  '|': '|',
  '/': '/',
  '.': '',
  '{': '{',
  '}': '}',
  langle: '⟨',
  rangle: '⟩',
  lfloor: '⌊',
  rfloor: '⌋',
  lceil: '⌈',
  rceil: '⌉',
  lvert: '|',
  rvert: '|',
  lVert: '‖',
  rVert: '‖',
  '‖': '‖',
  backslash: '\\',
};

const NARY: Record<string, { op: string; under: boolean }> = {
  sum: { op: '∑', under: true },
  prod: { op: '∏', under: true },
  coprod: { op: '∐', under: true },
  int: { op: '∫', under: false },
  iint: { op: '∬', under: false },
  iiint: { op: '∭', under: false },
  oint: { op: '∮', under: false },
  bigcup: { op: '⋃', under: true },
  bigcap: { op: '⋂', under: true },
  bigvee: { op: '⋁', under: true },
  bigwedge: { op: '⋀', under: true },
  bigoplus: { op: '⨁', under: true },
  bigotimes: { op: '⨂', under: true },
};

const FUNCTIONS = new Set([
  'sin',
  'cos',
  'tan',
  'cot',
  'sec',
  'csc',
  'arcsin',
  'arccos',
  'arctan',
  'sinh',
  'cosh',
  'tanh',
  'coth',
  'log',
  'ln',
  'lg',
  'exp',
  'det',
  'gcd',
  'deg',
  'dim',
  'ker',
  'hom',
  'arg',
  'Pr',
  'lim',
  'limsup',
  'liminf',
  'max',
  'min',
  'sup',
  'inf',
]);
/** Functions whose subscript goes under them (`\lim_{x \to 0}`). */
const LIMIT_FUNCTIONS = new Set([
  'lim',
  'limsup',
  'liminf',
  'max',
  'min',
  'sup',
  'inf',
  'det',
  'gcd',
  'Pr',
]);

const ACCENTS: Record<string, string> = {
  hat: '̂',
  widehat: '̂',
  check: '̌',
  tilde: '̃',
  widetilde: '̃',
  acute: '́',
  grave: '̀',
  dot: '̇',
  ddot: '̈',
  breve: '̆',
  bar: '̄',
  vec: '⃗',
};
/** The command that prints each accent (the first name of the table above). */
const ACCENT_NAME: Record<string, string> = {
  '̂': 'hat',
  '̌': 'check',
  '̃': 'tilde',
  '́': 'acute',
  '̀': 'grave',
  '̇': 'dot',
  '̈': 'ddot',
  '̆': 'breve',
  '̄': 'bar',
  '⃗': 'vec',
};

const SPACES: Record<string, string> = {
  ',': ' ',
  ':': ' ',
  ';': ' ',
  quad: ' ',
  qquad: '  ',
  ' ': ' ',
};
const SPACE_COMMAND: Record<string, string> = {
  ' ': '\\,',
  ' ': '\\:',
  ' ': '\\;',
  ' ': '\\quad',
  '  ': '\\qquad',
  ' ': '\\ ',
};

const BRACKET_ENVS: Record<string, [string, string]> = {
  matrix: ['', ''],
  pmatrix: ['(', ')'],
  bmatrix: ['[', ']'],
  Bmatrix: ['{', '}'],
  vmatrix: ['|', '|'],
  Vmatrix: ['‖', '‖'],
};

/** Double-struck capitals; the others are in the block that starts at U+1D538. */
const DOUBLE_STRUCK: Record<string, string> = {
  C: 'ℂ',
  H: 'ℍ',
  N: 'ℕ',
  P: 'ℙ',
  Q: 'ℚ',
  R: 'ℝ',
  Z: 'ℤ',
};
const doubleStruck = (c: string): string =>
  DOUBLE_STRUCK[c] ?? String.fromCodePoint(0x1d538 + c.charCodeAt(0) - 65);
const FROM_DOUBLE_STRUCK = new Map<string, string>();
for (let i = 0; i < 26; i++) {
  const c = String.fromCharCode(65 + i);
  FROM_DOUBLE_STRUCK.set(doubleStruck(c), c);
}

/** Reverse tables, first name wins. */
const reverse = (t: Record<string, string>): Map<string, string> => {
  const m = new Map<string, string>();
  for (const [name, ch] of Object.entries(t)) if (!m.has(ch)) m.set(ch, name);
  return m;
};
export const LETTER_NAME = reverse(LETTERS);
export const SYMBOL_NAME = reverse(SYMBOLS);
const DELIMITER_NAME = reverse({
  langle: '⟨',
  rangle: '⟩',
  lfloor: '⌊',
  rfloor: '⌋',
  lceil: '⌈',
  rceil: '⌉',
});
export { FROM_DOUBLE_STRUCK, FUNCTIONS, ACCENT_NAME, SPACE_COMMAND, BRACKET_ENVS };
export const NARY_OF = new Map(
  Object.entries(NARY).map(([name, v]) => [v.op, { name, under: v.under }]),
);
const ASCII_OPERATORS = new Set([
  '+',
  '=',
  '<',
  '>',
  '(',
  ')',
  '[',
  ']',
  '|',
  '/',
  '!',
  ',',
  ';',
  ':',
  '.',
  '?',
]);
/** The characters a reader of Office math accepts as an operator, besides the symbol table. */
export const isOperatorChar = (c: string): boolean =>
  ASCII_OPERATORS.has(c) ||
  c === '−' ||
  c === '′' ||
  c === '″' ||
  SYMBOL_NAME.has(c) ||
  DELIMITER_NAME.has(c) ||
  c === '‖' ||
  c === '∗' ||
  c in SPACE_COMMAND;

// ---------------------------------------------------------------------------------------------
// Tree helpers.

export const row = (items: MathNode[]): MathNode => ({ k: 'row', items });
const empty = (): MathNode => row([]);

// ---------------------------------------------------------------------------------------------
// LaTeX to tree.

type Token =
  | { t: '{' | '}' | '^' | '_' | '&' | 'end' }
  | { t: 'cmd'; name: string }
  | { t: 'char'; ch: string };

class Parser {
  private pos = 0;
  private depth = 0;
  private nodes = 0;
  private peeked: Token | null = null;

  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  private fail(why: string): never {
    throw new MathConvertError(why);
  }

  private count(): void {
    if (++this.nodes > MATH_LIMITS.nodes) this.fail('the equation has too many parts');
  }

  private read(): Token {
    const s = this.src;
    while (this.pos < s.length && /\s/.test(s[this.pos]!)) this.pos++;
    if (this.pos >= s.length) return { t: 'end' };
    const c = s[this.pos++]!;
    if (c === '{' || c === '}' || c === '^' || c === '_' || c === '&') return { t: c };
    if (c === '\\') {
      const m = /^[A-Za-z]+/.exec(s.slice(this.pos));
      if (m) {
        this.pos += m[0].length;
        return { t: 'cmd', name: m[0] };
      }
      if (this.pos >= s.length) this.fail('a backslash at the end');
      return { t: 'cmd', name: s[this.pos++]! };
    }
    return { t: 'char', ch: c };
  }

  peek(): Token {
    this.peeked ??= this.read();
    return this.peeked;
  }

  next(): Token {
    const t = this.peek();
    this.peeked = null;
    return t;
  }

  private isChar(t: Token, ch: string): boolean {
    return t.t === 'char' && t.ch === ch;
  }

  private enter(): void {
    if (++this.depth > MATH_LIMITS.depth) this.fail('the equation is nested too deeply');
  }

  parse(): MathNode {
    if (this.src.length > MATH_LIMITS.length)
      this.fail('the equation is longer than 4,000 characters');
    const body = this.row(() => false);
    if (this.peek().t !== 'end') this.fail('unbalanced braces or a stray separator');
    return body;
  }

  /** Atoms until `stop` says so, or until a token that ends the row (`}`, `&`, `\\`, `\right`, `\end`). */
  private row(stop: (t: Token) => boolean): MathNode {
    this.enter();
    const items: MathNode[] = [];
    for (;;) {
      const t = this.peek();
      if (t.t === 'end' || t.t === '}' || t.t === '&') break;
      if (t.t === 'cmd' && (t.name === '\\' || t.name === 'right' || t.name === 'end')) break;
      if (stop(t)) break;
      items.push(this.atom());
    }
    this.depth--;
    return items.length === 1 ? items[0]! : row(items);
  }

  /** A base with its scripts. */
  private atom(): MathNode {
    const first = this.peek();
    let base: MathNode;
    if (first.t === '^' || first.t === '_') base = empty();
    else base = this.primary();
    if (base.k === 'nary') return base;
    let sub: MathNode | null = null;
    let sup: MathNode | null = null;
    for (;;) {
      const t = this.peek();
      if (t.t === '^') {
        this.next();
        if (sup) this.fail('a double superscript');
        sup = this.arg();
      } else if (t.t === '_') {
        this.next();
        if (sub) this.fail('a double subscript');
        sub = this.arg();
      } else if (this.isChar(t, "'")) {
        this.next();
        if (sup) this.fail('a prime after a superscript');
        let primes = 1;
        while (this.isChar(this.peek(), "'")) {
          this.next();
          primes++;
        }
        if (primes > 2) this.fail('more than two primes');
        sup = { k: 'mo', text: primes === 1 ? '′' : '″' };
      } else break;
    }
    if (!sub && !sup) return base;
    this.count();
    if (base.k === 'mi' && base.style === 'p' && LIMIT_FUNCTIONS.has(base.text))
      return { k: 'limit', base, under: sub, over: sup };
    return { k: 'script', base, sub, sup };
  }

  /** One argument: a group, or a single token. */
  private arg(): MathNode {
    const t = this.peek();
    if (t.t === '{') {
      this.next();
      const body = this.row(() => false);
      if (this.next().t !== '}') this.fail('a group is not closed');
      return body.k === 'row' ? body : row([body]);
    }
    if (t.t === 'end' || t.t === '}' || t.t === '^' || t.t === '_' || t.t === '&')
      this.fail('an argument is missing');
    return this.primary();
  }

  private rawGroup(): string {
    if (this.next().t !== '{') this.fail('a group is expected');
    let out = '';
    let depth = 0;
    for (;;) {
      // Raw characters: the tokenizer is not used, so spaces and punctuation stay as typed. No
      // token is read ahead here, because the caller has just consumed the command.
      if (this.pos >= this.src.length) this.fail('a group is not closed');
      const c = this.src[this.pos++]!;
      if (c === '{') {
        depth++;
        out += c;
      } else if (c === '}') {
        if (depth === 0) return out;
        depth--;
        out += c;
      } else out += c;
    }
  }

  private safeText(text: string): string {
    // eslint-disable-next-line no-control-regex -- control characters are the thing refused
    if (/[\\{}$&#^_~%\u0000-\u001f]/.test(text) || text.length > 500)
      this.fail('text with a character TeX reads');
    return text;
  }

  private delimiter(): string {
    const t = this.next();
    let key: string | null = null;
    if (t.t === 'char') key = t.ch;
    else if (t.t === 'cmd') key = t.name;
    else if (t.t === '{' || t.t === '}') key = t.t;
    if (key === null || !(key in DELIMITERS)) this.fail('a delimiter that is not on the list');
    return DELIMITERS[key]!;
  }

  private primary(): MathNode {
    this.count();
    const t = this.next();
    switch (t.t) {
      case '{': {
        const body = this.row(() => false);
        if (this.next().t !== '}') this.fail('a group is not closed');
        return body.k === 'row' ? body : row([body]);
      }
      case 'char':
        return this.character(t.ch);
      case 'cmd':
        return this.command(t.name);
      default:
        return this.fail('a token that cannot start an expression');
    }
  }

  private character(c: string): MathNode {
    if (/[A-Za-z]/.test(c)) return { k: 'mi', text: c };
    if (/[0-9]/.test(c)) {
      let text = c;
      for (;;) {
        // Digits and one decimal point between digits form one number.
        const rest = this.src.slice(this.pos);
        const m = /^(\d+|\.\d)/.exec(rest);
        if (!m || this.peeked) break;
        if (m[0].startsWith('.') && text.includes('.')) break;
        text += m[0];
        this.pos += m[0].length;
      }
      return { k: 'mn', text };
    }
    if (c === '-') return { k: 'mo', text: '−' };
    if (c === '*') return { k: 'mo', text: '∗' };
    if (ASCII_OPERATORS.has(c)) return { k: 'mo', text: c };
    return this.fail(`the character ${JSON.stringify(c)} is not on the list`);
  }

  private command(name: string): MathNode {
    if (name in LETTERS) return { k: 'mi', text: LETTERS[name]! };
    if (name in SYMBOLS) return { k: 'mo', text: SYMBOLS[name]! };
    if (name in SPACES) return { k: 'mo', text: SPACES[name]! };
    if (name === '{' || name === '}') return { k: 'mo', text: name };
    if (name === '|') return { k: 'mo', text: '‖' };
    if (
      name === 'langle' ||
      name === 'rangle' ||
      name === 'lfloor' ||
      name === 'rfloor' ||
      name === 'lceil' ||
      name === 'rceil'
    )
      return { k: 'mo', text: DELIMITERS[name]! };
    if (FUNCTIONS.has(name)) return { k: 'mi', text: name, style: 'p' };
    if (name in NARY) return this.nary(name);
    if (name in ACCENTS) return { k: 'accent', mark: ACCENTS[name]!, base: this.arg() };
    switch (name) {
      case 'frac':
      case 'dfrac':
      case 'tfrac':
        return { k: 'frac', num: this.arg(), den: this.arg(), bar: true };
      case 'binom':
        return { k: 'frac', num: this.arg(), den: this.arg(), bar: false };
      case 'sqrt': {
        let degree: MathNode | null = null;
        if (this.isChar(this.peek(), '[')) {
          this.next();
          degree = this.row((t) => this.isChar(t, ']'));
          if (!this.isChar(this.next(), ']')) this.fail('the root index is not closed');
        }
        return { k: 'root', body: this.arg(), degree };
      }
      case 'overline':
        return { k: 'bar', bottom: false, base: this.arg() };
      case 'underline':
        return { k: 'bar', bottom: true, base: this.arg() };
      case 'text':
      case 'textrm':
        return { k: 'mtext', text: this.safeText(this.rawGroup()) };
      case 'mathrm':
      case 'operatorname': {
        const text = this.rawGroup();
        if (!/^[A-Za-z0-9]{1,40}$/.test(text)) this.fail('a name that is not letters and digits');
        return { k: 'mi', text, style: 'p' };
      }
      case 'mathbf': {
        const text = this.rawGroup();
        if (!/^[A-Za-z0-9]{1,40}$/.test(text)) this.fail('a name that is not letters and digits');
        return { k: 'mi', text, style: 'b' };
      }
      case 'mathbb': {
        const text = this.rawGroup();
        if (!/^[A-Z]{1,10}$/.test(text)) this.fail('double-struck capitals only');
        return { k: 'mi', text: [...text].map(doubleStruck).join('') };
      }
      case 'mathit':
        return this.arg();
      case 'left': {
        const open = this.delimiter();
        this.enter();
        const body = this.row(() => false);
        this.depth--;
        const closer = this.next();
        if (closer.t !== 'cmd' || closer.name !== 'right') this.fail('\\left without \\right');
        return { k: 'fence', open, close: this.delimiter(), body };
      }
      case 'begin':
        return this.environment();
      case 'limits':
      case 'nolimits':
        return this.fail('\\limits after something that is not a big operator');
      default:
        return this.fail(`the command \\${name} is not on the list`);
    }
  }

  private nary(name: string): MathNode {
    const spec = NARY[name]!;
    let under = spec.under;
    let sub: MathNode | null = null;
    let sup: MathNode | null = null;
    for (;;) {
      const t = this.peek();
      if (t.t === 'cmd' && (t.name === 'limits' || t.name === 'nolimits')) {
        this.next();
        under = t.name === 'limits';
      } else if (t.t === '_') {
        this.next();
        if (sub) this.fail('a double subscript');
        sub = this.arg();
      } else if (t.t === '^') {
        this.next();
        if (sup) this.fail('a double superscript');
        sup = this.arg();
      } else break;
    }
    // The summand is the next term; none when the row ends here.
    const t = this.peek();
    const ends =
      t.t === 'end' ||
      t.t === '}' ||
      t.t === '&' ||
      (t.t === 'cmd' && (t.name === '\\' || t.name === 'right' || t.name === 'end'));
    const body = ends ? empty() : this.atom();
    return { k: 'nary', op: spec.op, sub, sup, under, body };
  }

  private environment(): MathNode {
    const name = this.rawGroup();
    const fence = BRACKET_ENVS[name];
    if (!fence) this.fail(`the environment ${name} is not on the list`);
    const rows: MathNode[][] = [];
    let current: MathNode[] = [];
    for (;;) {
      current.push(this.row(() => false));
      const t = this.next();
      if (t.t === '&') continue;
      if (t.t === 'cmd' && t.name === '\\') {
        rows.push(current);
        current = [];
        continue;
      }
      if (t.t === 'cmd' && t.name === 'end') {
        const closing = this.rawGroup();
        if (closing !== name) this.fail('\\end does not match \\begin');
        // A last row that is one empty cell comes from a trailing \\ and is not a row.
        const last = current;
        if (!(
          last.length === 1 &&
          last[0]!.k === 'row' &&
          last[0]!.items.length === 0 &&
          rows.length > 0
        ))
          rows.push(last);
        break;
      }
      this.fail('an environment is not closed');
    }
    const width = rows[0]?.length ?? 0;
    if (!rows.length || rows.some((r) => r.length !== width)) this.fail('rows of different widths');
    if (rows.length > 30 || width > 30) this.fail('a matrix that is too large');
    const matrix: MathNode = { k: 'matrix', rows };
    return fence[0] === '' && fence[1] === ''
      ? matrix
      : { k: 'fence', open: fence[0], close: fence[1], body: matrix };
  }
}

/** Reads LaTeX of the allow-list. Throws `MathConvertError` for anything else. */
export function parseLatex(latex: string): MathNode {
  return new Parser(latex).parse();
}

// ---------------------------------------------------------------------------------------------
// Tree to LaTeX.

const wordEnd = /\\[A-Za-z]+$/;

/** Concatenates pieces of LaTeX, keeping a space where a command name would run into a letter. */
function glue(parts: string[]): string {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    if (wordEnd.test(out) && /^[A-Za-z]/.test(p)) out += ' ';
    out += p;
  }
  return out;
}

const isSimple = (s: string): boolean => /^(?:[A-Za-z0-9]|\\[A-Za-z]+)$/.test(s);

function braced(n: MathNode): string {
  const s = print(n);
  return isSimple(s) || /^\\[A-Za-z]+$/.test(s) ? s : `{${s}}`;
}

function printText(s: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are the thing refused
  if (/[\\{}$&#^_~%\u0000-\u001f]/.test(s))
    throw new MathConvertError('text with a character TeX reads');
  return `\\text{${s}}`;
}

function printMi(n: Extract<MathNode, { k: 'mi' }>): string {
  const t = n.text;
  if (n.style === 'p') return FUNCTIONS.has(t) ? `\\${t}` : `\\mathrm{${t}}`;
  if (n.style === 'b') return `\\mathbf{${t}}`;
  if ([...t].length === 1) {
    const ds = FROM_DOUBLE_STRUCK.get(t);
    if (ds) return `\\mathbb{${ds}}`;
    const name = LETTER_NAME.get(t);
    if (name) return `\\${name}`;
    if (/^[A-Za-z]$/.test(t)) return t;
    throw new MathConvertError('a letter that is not on the list');
  }
  // Several letters in one identifier: print each, as the reader makes one `mi` of each.
  return glue([...t].map((c) => printMi({ k: 'mi', text: c })));
}

function printMo(text: string): string {
  if (text in SPACE_COMMAND) return SPACE_COMMAND[text]!;
  if (text === '−') return '-';
  if (text === '∗') return '\\ast';
  if (text === '‖') return '\\|';
  if (text === '{' || text === '}') return `\\${text}`;
  if (text === '′') return "'";
  if (text === '″') return "''";
  const sym = SYMBOL_NAME.get(text);
  if (sym) return `\\${sym}`;
  const del = DELIMITER_NAME.get(text);
  if (del) return `\\${del}`;
  if (ASCII_OPERATORS.has(text)) return text;
  throw new MathConvertError(`the operator ${JSON.stringify(text)} is not on the list`);
}

function delimiterText(d: string): string {
  if (d === '') return '.';
  if (d === '{' || d === '}') return `\\${d}`;
  if (d === '‖') return '\\|';
  if (d === '\\') return '\\backslash';
  const del = DELIMITER_NAME.get(d);
  if (del) return `\\${del}`;
  if (['(', ')', '[', ']', '|', '/'].includes(d)) return d;
  throw new MathConvertError(`the delimiter ${JSON.stringify(d)} is not on the list`);
}

const ENV_OF = new Map(
  Object.entries(BRACKET_ENVS).map(([name, [o, c]]) => [`${o}\u0000${c}`, name]),
);

function printMatrix(m: Extract<MathNode, { k: 'matrix' }>, env: string): string {
  const rows = m.rows.map((r) => r.map(print).join(' & ')).join(' \\\\ ');
  return `\\begin{${env}} ${rows} \\end{${env}}`;
}

/** Writes the tree as LaTeX. Throws `MathConvertError` for a part the tables do not cover. */
export function print(n: MathNode): string {
  switch (n.k) {
    case 'row':
      return glue(n.items.map(print));
    case 'mi':
      return printMi(n);
    case 'mn':
      if (!/^[0-9]+(?:\.[0-9]+)?$/.test(n.text))
        throw new MathConvertError('a number that is not digits');
      return n.text;
    case 'mo':
      return printMo(n.text);
    case 'mtext':
      return printText(n.text);
    case 'script': {
      const base =
        n.base.k === 'row' && n.base.items.length !== 1
          ? `{${print(n.base)}}`
          : n.base.k === 'script'
            ? `{${print(n.base)}}`
            : print(n.base);
      const prime = n.sup && n.sup.k === 'mo' && (n.sup.text === '′' || n.sup.text === '″');
      let out = base;
      if (n.sub) out = glue([out, '_', braced(n.sub)]);
      if (n.sup) out = glue([out, prime ? print(n.sup) : `^${braced(n.sup)}`]);
      return out;
    }
    case 'frac':
      return `\\${n.bar ? 'frac' : 'binom'}${wrapArg(n.num)}${wrapArg(n.den)}`;
    case 'root':
      return n.degree ? `\\sqrt[${print(n.degree)}]${wrapArg(n.body)}` : `\\sqrt${wrapArg(n.body)}`;
    case 'nary': {
      const name = NARY_OF.get(n.op);
      if (!name) throw new MathConvertError('a big operator that is not on the list');
      let out = `\\${name.name}`;
      if (n.under !== name.under) out += n.under ? '\\limits' : '\\nolimits';
      if (n.sub) out += `_${braced(n.sub)}`;
      if (n.sup) out += `^${braced(n.sup)}`;
      const body = print(n.body);
      if (!body) return out;
      // A space after the operator and its limits: `\sum_{i=1}^n i`, not `^ni`.
      return `${out} ${n.body.k === 'row' && n.body.items.length > 1 ? `{${body}}` : body}`;
    }
    case 'fence': {
      if (n.body.k === 'matrix') {
        const env = ENV_OF.get(`${n.open}\u0000${n.close}`);
        if (env) return printMatrix(n.body, env);
      }
      return `\\left${delimiterText(n.open)} ${print(n.body)} \\right${delimiterText(n.close)}`;
    }
    case 'accent': {
      const name = ACCENT_NAME[n.mark];
      if (!name) throw new MathConvertError('an accent that is not on the list');
      return `\\${name}${wrapArg(n.base)}`;
    }
    case 'bar':
      return `\\${n.bottom ? 'underline' : 'overline'}${wrapArg(n.base)}`;
    case 'limit': {
      let out = print(n.base);
      if (n.under) out = glue([out, '_', braced(n.under)]);
      if (n.over) out += `^${braced(n.over)}`;
      return out;
    }
    case 'matrix':
      return printMatrix(n, 'matrix');
  }
}

/** An argument of a command: always in braces, so that `\frac{1}{2}` and `\hat{x}` read back the same. */
function wrapArg(n: MathNode): string {
  return `{${print(n)}}`;
}

/** Writes the tree as LaTeX, trimmed. */
export function toLatex(n: MathNode): string {
  return print(n).trim();
}
