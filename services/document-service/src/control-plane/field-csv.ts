// Spreadsheet-format output of field values (FRW-064, owner decision 44: CSV, with formula
// neutralising). The neutralising applies only here. `GET /field-values` returns values unchanged.
//
// Rule: a value whose first character is `=`, `+`, `-` or `@` gets a single apostrophe in front of
// it, so a spreadsheet application reads the cell as text. This covers a negative number too, since
// a number that starts with `-` is neutralised like any other value. A reader of the CSV removes one
// leading apostrophe when it is followed by one of those four characters to read the value back.
// A value with none of those first characters is written unchanged.
//
// Cells are quoted as RFC 4180 requires when they hold a comma, a double quote or a line break.

/** The first characters that a spreadsheet would read as a formula or a signed number. */
const FORMULA_START = new Set(['=', '+', '-', '@']);

/** The value with its leading formula character neutralised; any other value is returned as it is. */
export function neutraliseCell(value: string): string {
  const first = value.charAt(0);
  return FORMULA_START.has(first) ? `'${value}` : value;
}

/** One CSV cell: neutralised, then quoted when needed. */
export function csvCell(value: string): string {
  const safe = neutraliseCell(value);
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * A CSV document of key and value pairs, with a header row and CRLF line endings (RFC 4180). The
 * rows keep the order they are given in.
 */
export function fieldValuesCsv(rows: ReadonlyArray<{ key: string; value: string }>): string {
  const lines = ['key,value', ...rows.map((r) => `${csvCell(r.key)},${csvCell(r.value)}`)];
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * The text of one field value as a cell, before neutralising: no value is an empty cell, a string is
 * itself (a number is a decimal string in a field), a boolean is `true` or `false`, and a value that
 * is an object, such as the adopted image of a signature or the redaction marker of a projection, is
 * its JSON text.
 */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
