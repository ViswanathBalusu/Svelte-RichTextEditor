/**
 * Pseudo-locales for testing (UX-064), built from the source table and loaded on demand:
 *
 * - `en-XA`: every letter accented, every message about 40 percent longer and bracketed, so that a
 *   hard-coded string, a clipped label or a concatenated sentence shows at a glance;
 * - `ar-XB`: right to left. Each message is wrapped in right-to-left override marks, so it reads
 *   mirrored, and the interface takes `dir="rtl"`.
 *
 * Placeholders such as `{count}` are kept unchanged, so parameters still work.
 */
import { EN_GB } from './en-GB.ts';
import type { LocaleTable, Message, StringTable } from './types.ts';

const ACCENTS: Readonly<Record<string, string>> = {
  a: 'á',
  b: 'ƀ',
  c: 'ç',
  d: 'ð',
  e: 'é',
  f: 'ƒ',
  g: 'ĝ',
  h: 'ĥ',
  i: 'í',
  j: 'ĵ',
  k: 'ķ',
  l: 'ļ',
  m: 'ɱ',
  n: 'ñ',
  o: 'ó',
  p: 'þ',
  q: 'ǫ',
  r: 'ŕ',
  s: 'š',
  t: 'ţ',
  u: 'ú',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ý',
  z: 'ž',
  A: 'Á',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Ð',
  E: 'É',
  F: 'Ƒ',
  G: 'Ĝ',
  H: 'Ĥ',
  I: 'Í',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ļ',
  M: 'Ṁ',
  N: 'Ñ',
  O: 'Ó',
  P: 'Þ',
  Q: 'Ǫ',
  R: 'Ŕ',
  S: 'Š',
  T: 'Ţ',
  U: 'Ú',
  V: 'Ṽ',
  W: 'Ŵ',
  X: 'Ẋ',
  Y: 'Ý',
  Z: 'Ž',
};

/** Splits a message into literal text and `{placeholder}` parts. */
function parts(text: string): Array<{ literal: boolean; text: string }> {
  const out: Array<{ literal: boolean; text: string }> = [];
  const re = /\{[A-Za-z]+\}/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) out.push({ literal: true, text: text.slice(last, m.index) });
    out.push({ literal: false, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ literal: true, text: text.slice(last) });
  return out;
}

/** Accents letters, lengthens by about 40 percent and brackets the result. */
export function accentText(text: string): string {
  let letters = 0;
  const body = parts(text)
    .map((p) => {
      if (!p.literal) return p.text;
      return [...p.text]
        .map((ch) => {
          const accented = ACCENTS[ch];
          if (accented) letters++;
          return accented ?? ch;
        })
        .join('');
    })
    .join('');
  const padding = '·'.repeat(Math.ceil(letters * 0.4));
  return `[${body}${padding}]`;
}

/** Wraps a message in a right-to-left override, keeping placeholders as they are. */
export function bidiText(text: string): string {
  return `‮${text}‬`;
}

function mapTable(table: StringTable, f: (text: string) => string): StringTable {
  const out: Record<string, Message> = {};
  for (const [key, message] of Object.entries(table)) {
    if (typeof message === 'string') out[key] = f(message);
    else {
      const forms: Record<string, string> = {};
      for (const [category, text] of Object.entries(message)) forms[category] = f(text);
      out[key] = { ...forms, other: f(message.other) };
    }
  }
  return out;
}

export function accented(source: StringTable = EN_GB): LocaleTable {
  return { strings: mapTable(source, accentText), dir: 'ltr' };
}

export function bidi(source: StringTable = EN_GB): LocaleTable {
  return { strings: mapTable(source, bidiText), dir: 'rtl' };
}
