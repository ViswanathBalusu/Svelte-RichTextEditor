/**
 * The math gate (09 §6.3; EXP-049, EXP-050). Math is the only place where TeX written by a user
 * reaches the engine, so every `latex` attribute passes two independent checks:
 *
 * 1. A lexical scan of this module. Every control word must be on the generated allow-list
 *    (`allow-list.ts`: what `amsmath` and the math font provide and KaTeX supports), so
 *    definitions, primitives, file and shell access and commands that paint outside their box are
 *    refused in any spelling, `^^` included. `%`, `#`, `~` and `$` are refused; `&` and `\\` only
 *    inside an allowed environment, and `\\` takes no optional argument. Only `aligned`,
 *    `gathered`, `cases` and the matrix environments are allowed: the display environment is the
 *    class's `equation`, so editor and typesetter count equation numbers the same way. Text in
 *    `\text{...}` is plain characters only. Spaces (`\hspace`, `\kern`, `\mkern`, `\mskip`) take a
 *    non-negative length up to the bounds of `DIMENSION_BOUNDS` (ADR 0046). At most 4,000
 *    characters and nesting depth 50.
 * 2. KaTeX in strict mode with `trust` off and a macro expansion limit (`katex.ts`). What KaTeX
 *    rejects is rejected.
 *
 * One implementation for the authority (invariant I8, through `mathGateReason`), the converter and
 * the editor (EXP-049 criterion 6): the module is universal and imports nothing of the converter.
 */
import { ALLOW_LIST } from './allow-list.ts';
import { katexRejects } from './katex.ts';

export type GateResult = { ok: true } | { ok: false; reason: string };

export const MATH_LIMITS = { length: 4000, depth: 50 } as const;

/**
 * The largest length a space command may take, per unit (ADR 0046): 2 em, the width of `\qquad`,
 * in each unit at the class's 11 pt default size, rounded down.
 */
export const DIMENSION_BOUNDS: Readonly<Record<string, number>> = {
  pt: 22,
  bp: 22,
  mm: 7,
  cm: 0.7,
  in: 0.3,
  em: 2,
  ex: 4,
  mu: 36,
};

/** Commands whose argument is text: plain characters only. */
const TEXT_COMMANDS = new Set([
  'text',
  'textrm',
  'textbf',
  'textit',
  'textsf',
  'texttt',
  'textnormal',
  'operatorname',
]);
const TEXT_ARGUMENT = /^\{([A-Za-z0-9 .,;:!?'()/+=-]*)\}/;

/** Control symbols that may appear: spaces, escaped specials and the row end. */
const SYMBOLS = new Set([',', ';', ':', '!', '{', '}', '|', ' ', '\\', '%', '#', '&', '_', '$']);

const ASCII_PLAIN = /^[A-Za-z0-9 \t\n\r+\-*/=<>()[\]|,.;:!?'^_]$/;

/** Unicode characters allowed as they are: Greek, math symbols, arrows and a few Latin-1 signs. */
const UNICODE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ac, 0x00ac],
  [0x00b0, 0x00b1],
  [0x00b7, 0x00b7],
  [0x00d7, 0x00d7],
  [0x00f7, 0x00f7],
  [0x0391, 0x03a9],
  [0x03b1, 0x03c9],
  [0x03d1, 0x03d1],
  [0x03d5, 0x03d6],
  [0x03f0, 0x03f1],
  [0x03f5, 0x03f5],
  [0x2026, 0x2026],
  [0x2032, 0x2034],
  [0x2100, 0x214f],
  [0x2190, 0x21ff],
  [0x2200, 0x22ff],
  [0x2308, 0x230b],
  [0x27e8, 0x27e9],
  [0x2a00, 0x2aff],
];

function unicodeAllowed(cp: number): boolean {
  return UNICODE_RANGES.some(([a, b]) => cp >= a && cp <= b);
}

const COMMANDS: Readonly<Record<string, string>> = ALLOW_LIST.commands;
const ENVIRONMENTS: ReadonlySet<string> = new Set(ALLOW_LIST.environments);

const refuse = (reason: string): GateResult => ({ ok: false, reason });

function dimensionOk(value: string, unit: string): boolean {
  const n = Number(value);
  const max = DIMENSION_BOUNDS[unit];
  return max !== undefined && Number.isFinite(n) && n >= 0 && n <= max;
}

/** The lexical half of the gate; KaTeX's half is in `mathGate`. */
export function scanMath(latex: string): GateResult {
  if (typeof latex !== 'string') return refuse('not a string');
  if (latex.length > MATH_LIMITS.length) return refuse('longer than 4,000 characters');
  if (latex.includes('^^')) return refuse('the ^^ notation is not allowed');
  if (/\n[ \t\r]*\n/.test(latex)) return refuse('a blank line ends a paragraph');
  let depth = 0;
  const envs: string[] = [];
  let i = 0;
  while (i < latex.length) {
    const ch = latex[i]!;
    if (ch === '\\') {
      const word = /^[A-Za-z]+/.exec(latex.slice(i + 1));
      if (word) {
        const name = word[0];
        i += 1 + name.length;
        if (name === 'begin' || name === 'end') {
          const env = /^\{([A-Za-z]+\*?)\}/.exec(latex.slice(i));
          if (!env || !ENVIRONMENTS.has(env[1]!))
            return refuse(`\\${name} needs one of the allowed environments`);
          if (name === 'begin') {
            envs.push(env[1]!);
            if (depth + envs.length > MATH_LIMITS.depth) return refuse('nesting deeper than 50');
          } else if (envs.pop() !== env[1]) return refuse('environments do not nest');
          i += env[0].length;
          continue;
        }
        const arity = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
        if (arity === undefined) return refuse(`\\${name} is not on the allow-list`);
        if (TEXT_COMMANDS.has(name)) {
          const arg = TEXT_ARGUMENT.exec(latex.slice(i));
          if (!arg) return refuse(`\\${name} takes plain text only`);
          i += arg[0].length;
        } else if (arity === 'dimen') {
          const re =
            name === 'hspace'
              ? /^\s*\{\s*([0-9]+(?:\.[0-9]+)?)\s*(pt|bp|mm|cm|in|em|ex)\s*\}/
              : /^\s*([0-9]+(?:\.[0-9]+)?)\s*(pt|bp|mm|cm|in|em|ex)/;
          const m = re.exec(latex.slice(i));
          if (!m || !dimensionOk(m[1]!, m[2]!))
            return refuse(`\\${name} needs a length from 0 to 2 em (ADR 0046)`);
          i += m[0].length;
        } else if (arity === 'muskip') {
          const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*mu/.exec(latex.slice(i));
          if (!m || !dimensionOk(m[1]!, 'mu'))
            return refuse(`\\${name} needs a length from 0 to 36 mu (ADR 0046)`);
          i += m[0].length;
          if (/^\s*(?:plus|minus)\b/.test(latex.slice(i)))
            return refuse(`\\${name} takes no stretch or shrink`);
        }
        continue;
      }
      const symbol = latex[i + 1];
      if (symbol === undefined || !SYMBOLS.has(symbol)) return refuse('control symbol not allowed');
      if (symbol === '\\') {
        if (envs.length === 0) return refuse('\\\\ outside an environment');
        if (/^\s*[[*]/.test(latex.slice(i + 2))) return refuse('\\\\ takes no argument here');
      }
      i += 2;
      continue;
    }
    if (ch === '{') {
      depth++;
      if (depth + envs.length > MATH_LIMITS.depth) return refuse('nesting deeper than 50');
    } else if (ch === '}') {
      depth--;
      if (depth < 0) return refuse('unbalanced braces');
    } else if (ch === '&') {
      if (envs.length === 0) return refuse('& outside an alignment environment');
    } else if (ch === '%' || ch === '#' || ch === '~' || ch === '$') {
      return refuse(`an unescaped ${ch} is not allowed`);
    } else if (!ASCII_PLAIN.test(ch)) {
      const cp = latex.codePointAt(i)!;
      if (!unicodeAllowed(cp))
        return refuse(`character U+${cp.toString(16).toUpperCase().padStart(4, '0')} not allowed`);
      if (cp > 0xffff) i++;
    }
    i++;
  }
  if (depth !== 0) return refuse('unbalanced braces');
  if (envs.length !== 0) return refuse('unclosed environment');
  return { ok: true };
}

/** The gate: both halves (09 §6.3). */
export function mathGate(latex: string, display: boolean): GateResult {
  const scan = scanMath(latex);
  if (!scan.ok) return scan;
  const k = katexRejects(latex, display);
  if (k !== null) return refuse(`KaTeX: ${k}`);
  return { ok: true };
}

/**
 * The gate in the form the authority injects (`RoomInit.mathGate`): null when the value passes,
 * else the reason (invariant I8; EXP-051).
 */
export function mathGateReason(latex: string, display: boolean): string | null {
  const r = mathGate(latex, display);
  return r.ok ? null : r.reason;
}
