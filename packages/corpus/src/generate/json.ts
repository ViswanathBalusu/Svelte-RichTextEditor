/**
 * JSON text for the corpus files, in exactly the layout Prettier gives a `.json` file with the
 * repository's settings (print width 100), so that `pnpm lint` (`prettier --check .`) accepts the
 * generated files as they are:
 *
 * - every non-empty object is written expanded, one member per line; Prettier keeps an object
 *   expanded when its source has a line break after `{` (option `objectWrap: "preserve"`);
 * - an array that holds an object is expanded, one element per line;
 * - an array of plain values stays on one line when it fits in the print width, together with the
 *   comma that follows it; otherwise numbers are filled line by line and other values go one per
 *   line.
 *
 * Strings are written by `JSON.stringify` and kept as written by Prettier. Widths are only computed
 * for keys and for arrays of plain values. Keys must be ASCII; a list with other characters must be
 * too long for one line on its ASCII characters alone. The printer throws on anything else rather
 * than guess, and test/json-layout.test.ts compares it with Prettier itself.
 */

const PRINT_WIDTH = 100;

type Plain = string | number | boolean | null;

function isPlain(v: unknown): v is Plain {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function isAscii(s: string): boolean {
  return asciiCount(s) === s.length;
}

function asciiCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) >= 0x20 && s.charCodeAt(i) <= 0x7e) n++;
  return n;
}

function plainText(v: Plain, where: string): string {
  if (typeof v === 'number' && !Number.isSafeInteger(v))
    throw new RangeError(`${where}: only integers are allowed, got ${v}`);
  return JSON.stringify(v);
}

const pad = (n: number): string => ' '.repeat(n);

/** True for a value that Prettier always prints over several lines here. */
function forcesBreak(v: unknown): boolean {
  if (isPlain(v)) return false;
  if (Array.isArray(v)) return v.some(forcesBreak);
  return Object.keys(v as object).length > 0;
}

function printValue(
  value: unknown,
  indent: number,
  column: number,
  trailing: number,
  where: string,
): string {
  if (isPlain(value)) return plainText(value, where);
  if (Array.isArray(value)) return printArray(value, indent, column, trailing, where);
  if (typeof value === 'object')
    return printObject(value as Record<string, unknown>, indent, where);
  throw new TypeError(`${where}: ${typeof value} is not JSON`);
}

function printObject(obj: Record<string, unknown>, indent: number, where: string): string {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  if (keys.length === 0) return '{}';
  const inner = indent + 2;
  const lines = keys.map((key, i) => {
    const keyText = `${JSON.stringify(key)}: `;
    if (!isAscii(keyText)) throw new RangeError(`${where}: non-ASCII key ${keyText}`);
    const trailing = i < keys.length - 1 ? 1 : 0;
    return (
      pad(inner) +
      keyText +
      printValue(obj[key], inner, inner + keyText.length, trailing, `${where}/${key}`)
    );
  });
  return `{\n${lines.join(',\n')}\n${pad(indent)}}`;
}

function printArray(
  items: unknown[],
  indent: number,
  column: number,
  trailing: number,
  where: string,
): string {
  if (items.length === 0) return '[]';
  const inner = indent + 2;
  if (items.every(isPlain)) {
    const texts = items.map((v, i) => plainText(v, `${where}/${i}`));
    const flat = `[${texts.join(', ')}]`;
    // Prettier measures display width. For ASCII that is the length; otherwise the ASCII characters
    // alone give a lower bound, which settles the long lists that occur here.
    const fits = column + asciiCount(flat) + trailing <= PRINT_WIDTH;
    if (fits && !isAscii(flat))
      throw new RangeError(`${where}: cannot measure a short list with non-ASCII text`);
    if (fits) return flat;
    if (items.every((v) => typeof v === 'number')) return fillNumbers(texts, indent);
    return `[\n${texts.map((t) => pad(inner) + t).join(',\n')}\n${pad(indent)}]`;
  }
  // An expanded object forces every enclosing array to break, so each element gets its own line.
  // Arrays that hold only arrays or empty objects would need Prettier's fitting rules; none occur.
  if (!items.some(forcesBreak)) throw new RangeError(`${where}: this array shape is not supported`);
  const lines = items.map(
    (v, i) =>
      pad(inner) + printValue(v, inner, inner, i < items.length - 1 ? 1 : 0, `${where}/${i}`),
  );
  return `[\n${lines.join(',\n')}\n${pad(indent)}]`;
}

/** Prettier's `fill` for arrays of numbers: as many per line as fit, each followed by its comma. */
function fillNumbers(texts: string[], indent: number): string {
  const inner = indent + 2;
  const parts = texts.map((t, i) => (i < texts.length - 1 ? `${t},` : t));
  let out = `[\n${pad(inner)}`;
  let column = inner;
  parts.forEach((part, i) => {
    out += part;
    const next = parts[i + 1];
    if (next === undefined) return;
    if (column + part.length + 1 + next.length <= PRINT_WIDTH) {
      out += ' ';
      column += part.length + 1;
    } else {
      out += `\n${pad(inner)}`;
      column = inner;
    }
  });
  return `${out}\n${pad(indent)}]`;
}

/** The text of a corpus JSON file: Prettier's layout and a final line feed. */
export function formatJson(value: unknown): string {
  return `${printValue(value, 0, 0, 0, '')}\n`;
}
