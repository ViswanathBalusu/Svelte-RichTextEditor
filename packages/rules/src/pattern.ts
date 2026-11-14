/**
 * Patterns for `matches` and `validation.pattern` (12 §3.2, §5.2; ADR 0030 §5). A restricted
 * regular-expression subset, compiled to a Thompson automaton and run by simulating every thread
 * at once (a Pike machine without captures). Each instruction is visited at most once per input
 * position, so a match costs at most 2 × (instructions) × (code points + 1) steps whatever the
 * pattern: there is no backtracking and no pathological input. No user pattern ever reaches the
 * runtime's own regular-expression engine.
 *
 * The subset: literals; `.` (any code point); classes `[...]` and `[^...]` with ranges; the escapes
 * `\d \D \w \W \s \S` (ASCII definitions), `\t \n \r \f \v`, `\xHH`, `\uHHHH`, `\u{H...}` and escaped
 * syntax characters; groups `(...)` and `(?:...)`; alternation `|`; the quantifiers `* + ? {n}
 * {n,} {n,m}` and their lazy forms (laziness does not change whether a value matches); `^` and `$`.
 * A pattern must match the whole value, as the HTML `pattern` attribute does. Matching works on
 * Unicode code points and is case-sensitive.
 */
import { LIMITS } from './limits.ts';

export type PatternProblemCode = 'pattern_syntax' | 'pattern_unsupported' | 'pattern_limit';

export interface PatternProblem {
  code: PatternProblemCode;
  /** A stable name for the construct, such as `back-reference` or `repetition count`. */
  construct: string;
  /** Offset in code points. */
  index: number;
  message: string;
}

export interface Pattern {
  readonly source: string;
  /** Instructions after counted repetitions are expanded. */
  readonly size: number;
  readonly op: Uint8Array;
  readonly x: Int32Array;
  readonly y: Int32Array;
  readonly sets: ReadonlyArray<Int32Array | null>;
}

export type CompileResult = { ok: true; pattern: Pattern } | { ok: false; problem: PatternProblem };

export interface MatchResult {
  matched: boolean;
  /** Instructions visited and characters tested; never more than maxMatchSteps(). */
  steps: number;
}

const MAX_CP = 0x10ffff;
const ANY = [0, MAX_CP];
const DIGIT = [0x30, 0x39];
const WORD = [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a];
const SPACE = [0x09, 0x0d, 0x20, 0x20];
/** Characters that may be escaped to stand for themselves, plus `-`. */
const SYNTAX = new Set(Array.from('^$\\.*+?()[]{}|/-', (c) => c.codePointAt(0)!));

type PNode =
  | { t: 'set'; r: number[] }
  | { t: 'seq'; items: PNode[] }
  | { t: 'alt'; alts: PNode[] }
  | { t: 'rep'; node: PNode; min: number; max: number }
  | { t: 'bol' }
  | { t: 'eol' };

class PatternFailure extends Error {
  readonly problem: PatternProblem;
  constructor(problem: PatternProblem) {
    super(problem.message);
    this.problem = problem;
  }
}

/** Sorts and merges inclusive ranges given as flat pairs. */
function mergeRanges(pairs: number[]): number[] {
  const list: Array<[number, number]> = [];
  for (let i = 0; i < pairs.length; i += 2) list.push([pairs[i]!, pairs[i + 1]!]);
  list.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  for (const [lo, hi] of list) {
    const last = out.length - 1;
    if (out.length && lo <= out[last]! + 1) out[last] = Math.max(out[last]!, hi);
    else out.push(lo, hi);
  }
  return out;
}

function complement(r: number[]): number[] {
  const out: number[] = [];
  let next = 0;
  for (let i = 0; i < r.length; i += 2) {
    if (r[i]! > next) out.push(next, r[i]! - 1);
    next = r[i + 1]! + 1;
  }
  if (next <= MAX_CP) out.push(next, MAX_CP);
  return out;
}

const hexValue = (c: number | undefined): number =>
  c === undefined
    ? -1
    : c >= 0x30 && c <= 0x39
      ? c - 0x30
      : c >= 0x41 && c <= 0x46
        ? c - 0x37
        : c >= 0x61 && c <= 0x66
          ? c - 0x57
          : -1;

const ch = (s: string): number => s.codePointAt(0)!;

class Parser {
  private readonly cps: number[];
  private i = 0;

  constructor(cps: number[]) {
    this.cps = cps;
  }

  private fail(code: PatternProblemCode, construct: string, message: string, at = this.i): never {
    throw new PatternFailure({ code, construct, index: at, message });
  }

  private peek(offset = 0): number | undefined {
    return this.cps[this.i + offset];
  }

  parse(): PNode {
    const node = this.alternation();
    if (this.i < this.cps.length)
      this.fail('pattern_syntax', 'unmatched parenthesis', 'there is a ")" without a "("');
    return node;
  }

  private alternation(): PNode {
    const alts = [this.sequence()];
    while (this.peek() === ch('|')) {
      this.i++;
      alts.push(this.sequence());
    }
    return alts.length === 1 ? alts[0]! : { t: 'alt', alts };
  }

  private sequence(): PNode {
    const items: PNode[] = [];
    while (this.i < this.cps.length && this.peek() !== ch('|') && this.peek() !== ch(')'))
      items.push(this.quantified());
    return items.length === 1 ? items[0]! : { t: 'seq', items };
  }

  private quantified(): PNode {
    const atom = this.atom();
    const at = this.i;
    const q = this.quantifier();
    if (!q) return atom;
    if (atom.t === 'bol' || atom.t === 'eol')
      this.fail('pattern_syntax', 'nothing to repeat', 'an anchor (^ or $) cannot be repeated', at);
    if (this.peek() === ch('?')) this.i++; // lazy: no effect on whether the whole value matches
    const next = this.i;
    if (this.quantifier())
      this.fail(
        'pattern_unsupported',
        'quantifier after quantifier',
        'a quantifier cannot follow another quantifier (possessive quantifiers are not supported)',
        next,
      );
    return { t: 'rep', node: atom, min: q.min, max: q.max };
  }

  /** Reads a quantifier if one starts here; a brace that does not form one is left alone. */
  private quantifier(): { min: number; max: number } | null {
    const c = this.peek();
    if (c === ch('*')) return (this.i++, { min: 0, max: -1 });
    if (c === ch('+')) return (this.i++, { min: 1, max: -1 });
    if (c === ch('?')) return (this.i++, { min: 0, max: 1 });
    if (c !== ch('{')) return null;
    const start = this.i;
    let j = this.i + 1;
    const digits = (): number | null => {
      let v = 0;
      let n = 0;
      while (this.cps[j] !== undefined && this.cps[j]! >= 0x30 && this.cps[j]! <= 0x39) {
        v = n < 7 ? v * 10 + (this.cps[j]! - 0x30) : v;
        n++;
        j++;
      }
      return n === 0 ? null : n > 6 ? Number.MAX_SAFE_INTEGER : v;
    };
    const min = digits();
    if (min === null) return null;
    let max = min;
    if (this.cps[j] === ch(',')) {
      j++;
      max = this.cps[j] === ch('}') ? -1 : (digits() ?? -2);
      if (max === -2) return null;
    }
    if (this.cps[j] !== ch('}')) return null;
    this.i = j + 1;
    if (max !== -1 && min > max)
      this.fail(
        'pattern_syntax',
        'quantifier order',
        'in {n,m}, n must not be larger than m',
        start,
      );
    if (min > LIMITS.patternRepeat || max > LIMITS.patternRepeat)
      this.fail(
        'pattern_limit',
        'repetition count',
        `a repetition count may be at most ${LIMITS.patternRepeat}`,
        start,
      );
    return { min, max };
  }

  private atom(): PNode {
    const c = this.peek()!;
    switch (c) {
      case ch('('):
        return this.group();
      case ch('['):
        return this.characterClass();
      case ch('.'):
        this.i++;
        return { t: 'set', r: ANY };
      case ch('^'):
        this.i++;
        return { t: 'bol' };
      case ch('$'):
        this.i++;
        return { t: 'eol' };
      case ch('\\'): {
        const e = this.escape(false);
        return { t: 'set', r: e.set };
      }
      case ch('*'):
      case ch('+'):
      case ch('?'):
        return this.fail(
          'pattern_syntax',
          'nothing to repeat',
          'a quantifier needs something before it',
        );
      case ch('{'):
        if (this.quantifierAhead())
          this.fail(
            'pattern_syntax',
            'nothing to repeat',
            'a quantifier needs something before it',
          );
        return this.fail(
          'pattern_syntax',
          'lone brace',
          'a brace must be escaped (\\{) unless it is a quantifier such as {2,5}',
        );
      case ch('}'):
        return this.fail('pattern_syntax', 'lone brace', 'a closing brace must be escaped (\\})');
      case ch(']'):
        return this.fail(
          'pattern_syntax',
          'lone bracket',
          'a closing bracket must be escaped (\\])',
        );
      default:
        this.i++;
        return { t: 'set', r: [c, c] };
    }
  }

  private quantifierAhead(): boolean {
    const save = this.i;
    try {
      return this.quantifier() !== null;
    } catch {
      return true;
    } finally {
      this.i = save;
    }
  }

  private group(): PNode {
    const start = this.i;
    this.i++;
    if (this.peek() === ch('?')) {
      const next = this.peek(1);
      if (next === ch(':')) this.i += 2;
      else if (next === ch('=') || next === ch('!'))
        this.fail(
          'pattern_unsupported',
          'look-ahead',
          'look-ahead (?= and (?! is not supported',
          start,
        );
      else if (next === ch('<') && (this.peek(2) === ch('=') || this.peek(2) === ch('!')))
        this.fail(
          'pattern_unsupported',
          'look-behind',
          'look-behind (?<= and (?<! is not supported',
          start,
        );
      else if (next === ch('<'))
        this.fail(
          'pattern_unsupported',
          'named group',
          'named groups (?<name>...) are not supported; use (?:...)',
          start,
        );
      else
        this.fail(
          'pattern_unsupported',
          'group modifier',
          'group modifiers and flags such as (?i) are not supported',
          start,
        );
    }
    const node = this.alternation();
    if (this.peek() !== ch(')'))
      this.fail('pattern_syntax', 'missing parenthesis', 'a "(" is not closed', start);
    this.i++;
    return node;
  }

  /** After a backslash. Returns the set and, for a single character, that character. */
  private escape(inClass: boolean): { set: number[]; single: number | null } {
    const start = this.i;
    this.i++;
    const c = this.peek();
    if (c === undefined)
      return this.fail(
        'pattern_syntax',
        'trailing backslash',
        'the pattern ends with a backslash',
        start,
      );
    this.i++;
    const one = (v: number) => ({ set: [v, v], single: v });
    switch (c) {
      case ch('d'):
        return { set: DIGIT, single: null };
      case ch('D'):
        return { set: complement(DIGIT), single: null };
      case ch('w'):
        return { set: WORD, single: null };
      case ch('W'):
        return { set: complement(WORD), single: null };
      case ch('s'):
        return { set: SPACE, single: null };
      case ch('S'):
        return { set: complement(SPACE), single: null };
      case ch('t'):
        return one(0x09);
      case ch('n'):
        return one(0x0a);
      case ch('r'):
        return one(0x0d);
      case ch('f'):
        return one(0x0c);
      case ch('v'):
        return one(0x0b);
      case ch('x'): {
        const h1 = hexValue(this.peek());
        const h2 = hexValue(this.peek(1));
        if (h1 < 0 || h2 < 0)
          this.fail('pattern_syntax', 'escape', '\\x needs two hexadecimal digits', start);
        this.i += 2;
        return one(h1 * 16 + h2);
      }
      case ch('u'): {
        if (this.peek() === ch('{')) {
          let v = 0;
          let n = 0;
          this.i++;
          while (hexValue(this.peek()) >= 0) {
            v = v * 16 + hexValue(this.peek());
            n++;
            this.i++;
            if (v > MAX_CP) break;
          }
          if (n === 0 || v > MAX_CP || this.peek() !== ch('}'))
            this.fail(
              'pattern_syntax',
              'escape',
              '\\u{...} needs a code point up to 10FFFF',
              start,
            );
          this.i++;
          return one(v);
        }
        let v = 0;
        for (let k = 0; k < 4; k++) {
          const h = hexValue(this.peek());
          if (h < 0)
            this.fail('pattern_syntax', 'escape', '\\u needs four hexadecimal digits', start);
          v = v * 16 + h;
          this.i++;
        }
        return one(v);
      }
      case ch('k'):
        return this.fail(
          'pattern_unsupported',
          'back-reference',
          'named back-references (\\k<name>) are not supported',
          start,
        );
      case ch('b'):
      case ch('B'):
        return this.fail(
          'pattern_unsupported',
          'word boundary',
          inClass
            ? '\\b inside a class is not supported'
            : 'word boundaries (\\b, \\B) are not supported',
          start,
        );
      case ch('p'):
      case ch('P'):
        return this.fail(
          'pattern_unsupported',
          'unicode property escape',
          'Unicode property escapes (\\p{...}) are not supported',
          start,
        );
      case ch('c'):
        return this.fail(
          'pattern_unsupported',
          'control escape',
          'control escapes (\\cX) are not supported',
          start,
        );
      default:
        if (c >= 0x31 && c <= 0x39)
          return this.fail(
            'pattern_unsupported',
            'back-reference',
            `back-references (\\${String.fromCodePoint(c)}) are not supported`,
            start,
          );
        if (SYNTAX.has(c)) return one(c);
        return this.fail(
          'pattern_unsupported',
          'escape',
          `the escape \\${String.fromCodePoint(c)} is not supported`,
          start,
        );
    }
  }

  private characterClass(): PNode {
    const start = this.i;
    this.i++;
    let negate = false;
    if (this.peek() === ch('^')) {
      negate = true;
      this.i++;
    }
    const pairs: number[] = [];
    for (;;) {
      const c = this.peek();
      if (c === undefined)
        this.fail('pattern_syntax', 'unterminated class', 'a "[" is not closed', start);
      if (c === ch(']')) {
        this.i++;
        break;
      }
      const lo = this.classAtom();
      if (this.peek() === ch('-') && this.peek(1) !== undefined && this.peek(1) !== ch(']')) {
        const dash = this.i;
        this.i++;
        const hi = this.classAtom();
        if (lo.single === null || hi.single === null)
          this.fail(
            'pattern_syntax',
            'class escape in range',
            'a class such as \\d cannot be the end of a range',
            dash,
          );
        if (lo.single > hi.single)
          this.fail(
            'pattern_syntax',
            'range order',
            'a range must go from the lower to the higher character',
            dash,
          );
        pairs.push(lo.single, hi.single);
      } else pairs.push(...lo.set);
    }
    const merged = mergeRanges(pairs);
    return { t: 'set', r: negate ? complement(merged) : merged };
  }

  private classAtom(): { set: number[]; single: number | null } {
    const c = this.peek()!;
    if (c === ch('\\')) return this.escape(true);
    this.i++;
    return { set: [c, c], single: c };
  }
}

// Instructions of the automaton.
const CHAR = 0;
const SPLIT = 1;
const JMP = 2;
const BOL = 3;
const EOL = 4;
const MATCH = 5;

class Emitter {
  op: number[] = [];
  x: number[] = [];
  y: number[] = [];
  sets: Array<Int32Array | null> = [];

  emit(op: number, x = 0, y = 0, set: Int32Array | null = null): number {
    if (this.op.length >= LIMITS.patternProgram)
      throw new PatternFailure({
        code: 'pattern_limit',
        construct: 'program size',
        index: 0,
        message: `the pattern is too complex: more than ${LIMITS.patternProgram} instructions once repetitions are expanded`,
      });
    this.op.push(op);
    this.x.push(x);
    this.y.push(y);
    this.sets.push(set);
    return this.op.length - 1;
  }

  get pc(): number {
    return this.op.length;
  }

  node(n: PNode): void {
    switch (n.t) {
      case 'set': {
        const pc = this.emit(CHAR, 0, 0, Int32Array.from(n.r));
        this.x[pc] = pc + 1;
        return;
      }
      case 'bol':
      case 'eol': {
        const pc = this.emit(n.t === 'bol' ? BOL : EOL);
        this.x[pc] = pc + 1;
        return;
      }
      case 'seq':
        for (const item of n.items) this.node(item);
        return;
      case 'alt': {
        const jumps: number[] = [];
        n.alts.forEach((alt, k) => {
          if (k < n.alts.length - 1) {
            const split = this.emit(SPLIT);
            this.x[split] = split + 1;
            this.node(alt);
            jumps.push(this.emit(JMP));
            this.y[split] = this.pc;
          } else this.node(alt);
        });
        for (const j of jumps) this.x[j] = this.pc;
        return;
      }
      case 'rep': {
        for (let k = 0; k < n.min; k++) this.node(n.node);
        if (n.max === -1) {
          const split = this.emit(SPLIT);
          this.x[split] = split + 1;
          this.node(n.node);
          const jmp = this.emit(JMP);
          this.x[jmp] = split;
          this.y[split] = this.pc;
          return;
        }
        const splits: number[] = [];
        for (let k = n.min; k < n.max; k++) {
          const split = this.emit(SPLIT);
          this.x[split] = split + 1;
          splits.push(split);
          this.node(n.node);
        }
        for (const s of splits) this.y[s] = this.pc;
        return;
      }
    }
  }
}

const cache = new Map<string, CompileResult>();

/** Compiles a pattern, or names the first construct outside the subset. Results are cached. */
export function compilePattern(source: string): CompileResult {
  const hit = cache.get(source);
  if (hit) return hit;
  const result = compileUncached(source);
  if (cache.size > 1000) cache.clear();
  cache.set(source, result);
  return result;
}

function compileUncached(source: string): CompileResult {
  const cps = Array.from(source, (c) => c.codePointAt(0)!);
  if (cps.length > LIMITS.patternLength)
    return {
      ok: false,
      problem: {
        code: 'pattern_limit',
        construct: 'pattern length',
        index: LIMITS.patternLength,
        message: `a pattern may be at most ${LIMITS.patternLength} characters long`,
      },
    };
  try {
    const tree = new Parser(cps).parse();
    const e = new Emitter();
    e.node(tree);
    e.emit(MATCH);
    return {
      ok: true,
      pattern: {
        source,
        size: e.op.length,
        op: Uint8Array.from(e.op),
        x: Int32Array.from(e.x),
        y: Int32Array.from(e.y),
        sets: e.sets,
      },
    };
  } catch (err) {
    if (err instanceof PatternFailure) return { ok: false, problem: err.problem };
    throw err;
  }
}

/** The most steps a match of a value of `length` code points can take. */
export function maxMatchSteps(p: Pattern, length: number): number {
  return 2 * p.size * (length + 1);
}

function inSet(set: Int32Array, c: number): boolean {
  let lo = 0;
  let hi = (set.length >> 1) - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c < set[2 * mid]!) hi = mid - 1;
    else if (c > set[2 * mid + 1]!) lo = mid + 1;
    else return true;
  }
  return false;
}

/** True when the pattern matches the whole value. Linear in the value's length. */
export function matchPattern(p: Pattern, value: string): MatchResult {
  const input = Array.from(value, (c) => c.codePointAt(0)!);
  const n = input.length;
  const size = p.size;
  const mark = new Int32Array(size).fill(-1);
  let clist = new Int32Array(size);
  let nlist = new Int32Array(size);
  let steps = 0;
  // Each visit pushes at most two instructions and each instruction is visited once per position.
  const stack = new Int32Array(2 * size + 2);

  // Follows jumps, splits and anchors from `pc0` at position `pos` and records the threads that
  // wait on a character or have matched. `mark` holds the last position each instruction was
  // visited at, so no instruction is visited twice at one position.
  const add = (list: Int32Array, len: number, pc0: number, pos: number): number => {
    let sp = 0;
    stack[sp++] = pc0;
    while (sp > 0) {
      const pc = stack[--sp]!;
      if (mark[pc] === pos) continue;
      mark[pc] = pos;
      steps++;
      switch (p.op[pc]) {
        case JMP:
          stack[sp++] = p.x[pc]!;
          break;
        case SPLIT:
          stack[sp++] = p.y[pc]!;
          stack[sp++] = p.x[pc]!;
          break;
        case BOL:
          if (pos === 0) stack[sp++] = p.x[pc]!;
          break;
        case EOL:
          if (pos === n) stack[sp++] = p.x[pc]!;
          break;
        default:
          list[len++] = pc;
      }
    }
    return len;
  };

  let cn = add(clist, 0, 0, 0);
  for (let i = 0; i < n && cn > 0; i++) {
    const c = input[i]!;
    let nn = 0;
    for (let k = 0; k < cn; k++) {
      const pc = clist[k]!;
      steps++;
      if (p.op[pc] === CHAR && inSet(p.sets[pc]!, c)) nn = add(nlist, nn, p.x[pc]!, i + 1);
    }
    const t = clist;
    clist = nlist;
    nlist = t;
    cn = nn;
    if (cn === 0) return { matched: false, steps };
  }
  for (let k = 0; k < cn; k++) if (p.op[clist[k]!] === MATCH) return { matched: true, steps };
  return { matched: false, steps };
}
