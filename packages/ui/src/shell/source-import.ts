/**
 * Import of sources from BibTeX and CSL-JSON files (UX-103 criterion 3; 13 §3; 07 §5.3; CDM-052).
 * The parsers only read text. They check the grammar, report each problem with its place, and
 * report keys (BibTeX) or ids (CSL-JSON) that occur more than once. They create nothing: the
 * sources pane turns the entries into commits through the log. Keys are compared without regard
 * to case, as BibTeX looks citations up that way (ADR 0137, decision 1).
 */

export interface SourceEntry {
  /** The entry type in lower case, such as `article`. */
  readonly type: string;
  /** The key or id as written. */
  readonly key: string;
  /** Field values as text. Braces and quotes around a value are removed; arrays are kept as JSON. */
  readonly fields: Readonly<Record<string, string>>;
  /** The 1-based line of a BibTeX entry, or the 1-based position in a CSL-JSON array. */
  readonly at: number;
}

export interface ImportProblem {
  /** The 1-based line for BibTeX, or the 1-based array position for CSL-JSON. */
  readonly at: number;
  readonly message: string;
}

export interface DuplicateKey {
  readonly key: string;
  /** The `at` of each entry with this key, in file order. */
  readonly at: readonly number[];
}

export interface SourceImport {
  readonly entries: readonly SourceEntry[];
  readonly problems: readonly ImportProblem[];
  readonly duplicates: readonly DuplicateKey[];
}

const TYPE = /[A-Za-z]+/y;
const FIELD_NAME = /[A-Za-z][A-Za-z0-9_:.+/-]*/y;
const BARE_VALUE = /[A-Za-z0-9_:.+/-]+/y;
const KEY_FORBIDDEN = /[\s{}(),=#"]/;

interface Read {
  readonly entry: SourceEntry | null;
  readonly problems: readonly ImportProblem[];
  readonly next: number;
}

/** Parses a BibTeX file. Comments and @string or @preamble blocks are skipped without error. */
export function parseBibtex(text: string): SourceImport {
  const starts = lineStarts(text);
  const entries: SourceEntry[] = [];
  const problems: ImportProblem[] = [];
  let pos = 0;
  for (;;) {
    const at = text.indexOf('@', pos);
    if (at < 0) break;
    const r = readEntry(text, at, starts);
    if (r.entry) entries.push(r.entry);
    problems.push(...r.problems);
    pos = Math.max(r.next, at + 1);
  }
  return {
    entries,
    problems,
    duplicates: duplicatesOf(entries.map((e) => [e.key, e.at] as const)),
  };
}

/** Parses a CSL-JSON file: an array of objects, each with a string `id` and a string `type`. */
export function parseCslJson(text: string): SourceImport {
  const entries: SourceEntry[] = [];
  const problems: ImportProblem[] = [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      entries,
      problems: [{ at: 1, message: 'The file is not valid JSON.' }],
      duplicates: [],
    };
  }
  if (!Array.isArray(data)) {
    return {
      entries,
      problems: [{ at: 1, message: 'The file must hold an array of sources.' }],
      duplicates: [],
    };
  }
  data.forEach((item: unknown, i) => {
    const at = i + 1;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      problems.push({ at, message: 'A source must be an object.' });
      return;
    }
    const rec = item as Record<string, unknown>;
    const id = rec['id'];
    const type = rec['type'];
    if (typeof id !== 'string' || id.trim() === '' || KEY_FORBIDDEN.test(id)) {
      problems.push({ at, message: 'A source needs a text id without spaces or braces.' });
      return;
    }
    if (typeof type !== 'string' || type.trim() === '') {
      problems.push({ at, message: 'A source needs a text type.' });
      return;
    }
    const fields: Record<string, string> = {};
    for (const [name, value] of Object.entries(rec)) {
      if (name === 'id' || name === 'type') continue;
      fields[name] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    entries.push({ type: type.toLowerCase(), key: id, fields, at });
  });
  return {
    entries,
    problems,
    duplicates: duplicatesOf(entries.map((e) => [e.key, e.at] as const)),
  };
}

function readEntry(text: string, at: number, starts: readonly number[]): Read {
  const lineOf = (pos: number) => lineIndex(starts, pos);
  const fail = (message: string, pos: number): Read => {
    // Recovery: resume at the next line that starts an entry, so later entries still import.
    void pos;
    const nl = text.indexOf('\n@', at + 1);
    return {
      entry: null,
      problems: [{ at: lineOf(at), message }],
      next: nl < 0 ? text.length : nl + 1,
    };
  };

  let p = at + 1;
  TYPE.lastIndex = p;
  const typeMatch = TYPE.exec(text);
  if (!typeMatch) return fail('An entry type is expected after @.', p);
  const type = typeMatch[0].toLowerCase();
  p = TYPE.lastIndex;
  p = skipSpace(text, p);
  const open = text[p];
  if (open !== '{' && open !== '(') return fail("'{' or '(' is expected after the entry type.", p);
  const close = open === '{' ? '}' : ')';
  const bodyStart = p;
  p++;

  if (type === 'comment' || type === 'string' || type === 'preamble') {
    const end = balancedEnd(text, bodyStart, open, close);
    if (end < 0) return fail('The block is not closed.', bodyStart);
    return { entry: null, problems: [], next: end };
  }

  p = skipSpace(text, p);
  const keyEnd = indexOfAny(text, p, [',', close]);
  if (keyEnd < 0) return fail('The entry is not closed.', p);
  const key = text.slice(p, keyEnd).trim();
  if (key === '' || KEY_FORBIDDEN.test(key))
    return fail('A key without spaces or braces is expected.', p);
  p = keyEnd;

  const fields: Record<string, string> = {};
  const problems: ImportProblem[] = [];
  const line = lineOf(at);
  for (;;) {
    p = skipSpace(text, p);
    if (p >= text.length) return fail('The entry is not closed.', p);
    if (text[p] === ',') {
      p++;
      continue;
    }
    if (text[p] === close) {
      p++;
      break;
    }
    FIELD_NAME.lastIndex = p;
    const nameMatch = FIELD_NAME.exec(text);
    if (!nameMatch) return fail('A field name or the end of the entry is expected.', p);
    const name = nameMatch[0].toLowerCase();
    p = skipSpace(text, FIELD_NAME.lastIndex);
    if (text[p] !== '=') return fail("'=' is expected after a field name.", p);
    p = skipSpace(text, p + 1);

    let value = '';
    for (;;) {
      const part = readValuePart(text, p);
      if (!part) return fail('A field value is expected.', p);
      value += part.value;
      p = skipSpace(text, part.next);
      if (text[p] !== '#') break;
      p = skipSpace(text, p + 1);
    }
    if (name in fields)
      problems.push({ at: line, message: `The field ${name} is given twice; the first is kept.` });
    else fields[name] = value;
  }
  return { entry: { type, key, fields, at: line }, problems, next: p };
}

/** One part of a field value: braced, quoted, a number or a macro name. */
function readValuePart(text: string, p: number): { value: string; next: number } | null {
  const c = text[p];
  if (c === '{') {
    const end = balancedEnd(text, p, '{', '}');
    return end < 0 ? null : { value: text.slice(p + 1, end - 1), next: end };
  }
  if (c === '"') {
    let depth = 0;
    for (let i = p + 1; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '"' && depth === 0) return { value: text.slice(p + 1, i), next: i + 1 };
    }
    return null;
  }
  BARE_VALUE.lastIndex = p;
  const m = BARE_VALUE.exec(text);
  return m ? { value: m[0], next: BARE_VALUE.lastIndex } : null;
}

/** The index just after the bracket that closes the one at `open`, or -1. */
function balancedEnd(text: string, open: number, o: string, c: string): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++;
    else if (text[i] === c) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function skipSpace(text: string, p: number): number {
  let i = p;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

function indexOfAny(text: string, from: number, chars: readonly string[]): number {
  for (let i = from; i < text.length; i++) if (chars.includes(text[i]!)) return i;
  return -1;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** The 1-based line holding `pos`. */
function lineIndex(starts: readonly number[], pos: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function duplicatesOf(pairs: readonly (readonly [string, number])[]): DuplicateKey[] {
  const seen = new Map<string, { key: string; at: number[] }>();
  for (const [key, at] of pairs) {
    const k = key.toLowerCase();
    const hit = seen.get(k);
    if (hit) hit.at.push(at);
    else seen.set(k, { key, at: [at] });
  }
  return [...seen.values()].filter((v) => v.at.length > 1).map((v) => ({ key: v.key, at: v.at }));
}
