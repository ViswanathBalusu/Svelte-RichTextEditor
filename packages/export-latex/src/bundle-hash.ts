/**
 * The bundle hash input (EXP-005 criterion 6). The hash is SHA-256 over one line per file, then one
 * line for the options. The options are in `manifest.json`, which is not hashed itself, so without
 * this line an option that reaches no file would leave the hash unchanged and two jobs with
 * different options could share a cached result. Universal: no Node.js or browser API.
 */

/** The canonical JSON of a value: object keys sorted at every level, `undefined` members left out. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The text the bundle hash is the SHA-256 of: `name hash` for each file in name order, then
 * `#options <digest>`, where `optionsDigest` is the SHA-256 of `canonicalJson(manifest.options)`.
 */
export function bundleHashInput(
  fileHashes: Readonly<Record<string, string>>,
  optionsDigest: string,
): string {
  const lines = Object.keys(fileHashes)
    .sort()
    .map((n) => `${n} ${fileHashes[n]}`);
  lines.push(`#options ${optionsDigest}`);
  return lines.join('\n');
}
