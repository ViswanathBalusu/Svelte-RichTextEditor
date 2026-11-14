/**
 * RFC 8785 JSON Canonicalization Scheme (FND-005; 01 §8).
 *
 * - Object members are sorted by the UTF-16 code units of their names.
 * - Numbers use the ECMAScript Number-to-String algorithm, which is what JSON.stringify applies.
 * - Strings are escaped as JSON.stringify escapes them (", \, control characters below U+0020);
 *   everything else is written as is.
 * - No whitespace.
 *
 * Input must be I-JSON (RFC 7493): finite numbers, no lone surrogates, no undefined values.
 * Anything else throws, so that two implementations can never disagree silently.
 */

export class CanonicalizationError extends TypeError {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} at ${path || '/'}`);
    this.name = 'CanonicalizationError';
    this.path = path;
  }
}

const MAX_DEPTH = 1000;

export function canonicalize(value: unknown): string {
  const parts: string[] = [];
  write(value, parts, '', 0, new Set());
  return parts.join('');
}

function write(
  value: unknown,
  out: string[],
  path: string,
  depth: number,
  seen: Set<object>,
): void {
  if (depth > MAX_DEPTH) throw new CanonicalizationError('nesting too deep', path);
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value))
        throw new CanonicalizationError(`number is not finite (${value})`, path);
      out.push(JSON.stringify(value));
      return;
    case 'string':
      out.push(quote(value, path));
      return;
    case 'object':
      break;
    default:
      throw new CanonicalizationError(`unsupported value of type ${typeof value}`, path);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalizationError('cyclic structure', path);
  seen.add(obj);
  if (Array.isArray(obj)) {
    out.push('[');
    for (let i = 0; i < obj.length; i++) {
      if (i > 0) out.push(',');
      const item: unknown = obj[i];
      if (item === undefined)
        throw new CanonicalizationError('undefined array element', `${path}/${i}`);
      write(item, out, `${path}/${i}`, depth + 1, seen);
    }
    out.push(']');
  } else {
    const proto = Object.getPrototypeOf(obj) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalizationError('only plain objects can be canonicalised', path);
    }
    const record = obj as Record<string, unknown>;
    // Array.prototype.sort without a comparator compares UTF-16 code units, as RFC 8785 §3.2.3 requires.
    const keys = Object.keys(record).sort();
    out.push('{');
    let first = true;
    for (const key of keys) {
      const v = record[key];
      if (v === undefined)
        throw new CanonicalizationError(`undefined value for member "${key}"`, path);
      if (!first) out.push(',');
      first = false;
      out.push(quote(key, path), ':');
      write(v, out, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, depth + 1, seen);
    }
    out.push('}');
  }
  seen.delete(obj);
}

function quote(text: string, path: string): string {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new CanonicalizationError('lone surrogate in string', path);
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new CanonicalizationError('lone surrogate in string', path);
    }
  }
  return JSON.stringify(text);
}

/** Parses JSON text and returns its canonical form. */
export function canonicalizeText(json: string): string {
  return canonicalize(JSON.parse(json) as unknown);
}
