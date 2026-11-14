/**
 * Font substitution for imported DOCX files (EXP-106, 09 §12, 02 §6).
 *
 * The CDM keeps the family the file names (SR-M12 of the second review: substitution is for display
 * and typesetting only), so this module never rewrites the document. It works out, for every family
 * the imported document names, the family the editor uses instead, and lists the result:
 *
 * - a family in the manifest is replaced by the manifest's family (Calibri by Carlito, and so on);
 * - a family that is already open and metric-compatible (Carlito, Liberation Sans, ...) is used as it is;
 * - any other family has no metric-compatible substitute: the default family is used and the
 *   substitution says that the document will reflow (Aptos, for example).
 *
 * The manifest is an ordered list. The first entry that names a family decides, so a tenant entry
 * placed before the built-in entries takes precedence over them (EXP-106, criterion 4).
 *
 * Universal: no file system, no network, no clock.
 */

/** One line of the font manifest: the family a file names, and the family the editor uses instead. */
export interface FontManifestEntry {
  family: string;
  replacement: string;
  source: 'builtin' | 'tenant';
}

/**
 * The built-in entries (02 §6). The default family is not in the list: it is the fallback for every
 * family the manifest lacks, see {@link DEFAULT_IMPORT_FONT}.
 */
export const BUILTIN_FONT_MANIFEST: readonly FontManifestEntry[] = [
  { family: 'Calibri', replacement: 'Carlito', source: 'builtin' },
  { family: 'Cambria', replacement: 'Caladea', source: 'builtin' },
  { family: 'Arial', replacement: 'Liberation Sans', source: 'builtin' },
  { family: 'Times New Roman', replacement: 'Liberation Serif', source: 'builtin' },
  { family: 'Courier New', replacement: 'Liberation Mono', source: 'builtin' },
];

/**
 * The family used for a family that the manifest lacks. The spec does not name it (02 §6 says only
 * that Aptos reflows); the value is a proposed default recorded in docs/adr/0144 (open question).
 */
export const DEFAULT_IMPORT_FONT = 'Liberation Sans';

/** Open families that need no substitute: the editor shows them as they are, and they are not listed. */
export const OPEN_FONT_FAMILIES: ReadonlySet<string> = new Set([
  'carlito',
  'caladea',
  'liberation sans',
  'liberation serif',
  'liberation mono',
]);

export interface FontSubstitution {
  /** The family the file names, spelt as the file first spelt it. */
  from: string;
  /** The family the editor uses. */
  to: string;
  /** `builtin` or `tenant` for a manifest entry; `default` when the manifest lacks the family. */
  source: 'builtin' | 'tenant' | 'default';
  /** True when the substitute is not metric-compatible, so the document will reflow. */
  reflow: boolean;
  /** A line for the user, for example the reflow warning. */
  message: string;
}

export interface FontSubstitutionOptions {
  /** The ordered manifest; tenant entries first, then the built-in ones. Default: the built-in list. */
  manifest?: readonly FontManifestEntry[];
  /** The family used when the manifest lacks one. Default: {@link DEFAULT_IMPORT_FONT}. */
  defaultFamily?: string;
}

/** Families compare without case and surrounding spaces, as Word compares them. */
export const familyKey = (family: string): string =>
  family.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The substitutions for the families a document names, each family once, in order of first
 * appearance. A family used as it is (open and metric-compatible) gives no line.
 */
export function substituteFonts(
  families: Iterable<string>,
  options: FontSubstitutionOptions = {},
): FontSubstitution[] {
  const manifest = options.manifest ?? BUILTIN_FONT_MANIFEST;
  const defaultFamily = options.defaultFamily ?? DEFAULT_IMPORT_FONT;
  if (!defaultFamily.trim()) throw new RangeError('the default font family is empty');
  const seen = new Set<string>();
  const out: FontSubstitution[] = [];
  for (const raw of families) {
    const key = familyKey(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const from = raw.trim().replace(/\s+/g, ' ');
    const entry = manifest.find((e) => familyKey(e.family) === key);
    if (entry) {
      out.push({
        from,
        to: entry.replacement,
        source: entry.source,
        reflow: false,
        message: `${from} is shown as ${entry.replacement}`,
      });
      continue;
    }
    if (OPEN_FONT_FAMILIES.has(key)) continue;
    out.push({
      from,
      to: defaultFamily,
      source: 'default',
      reflow: true,
      message: `${from} has no metric-compatible substitute; ${defaultFamily} is used and the document will reflow`,
    });
  }
  return out;
}

/**
 * The family names of a JSON tree: the values of `fontFamily` marks (`{type, attrs: {value}}`) and of
 * `fontFamily` attributes, in document order. It reads only the data it is given.
 */
export function familiesOf(root: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [root];
  // A depth-first walk that keeps document order: children are pushed in reverse.
  while (stack.length) {
    const n = stack.pop();
    if (Array.isArray(n)) {
      for (let i = n.length - 1; i >= 0; i--) stack.push(n[i]);
      continue;
    }
    if (!n || typeof n !== 'object') continue;
    const o = n as Record<string, unknown>;
    if (o['type'] === 'fontFamily') {
      const attrs = o['attrs'] as Record<string, unknown> | undefined;
      if (typeof attrs?.['value'] === 'string') out.push(attrs['value']);
    }
    const ff = o['fontFamily'];
    if (typeof ff === 'string') out.push(ff);
    const keys = Object.keys(o);
    for (let i = keys.length - 1; i >= 0; i--) stack.push(o[keys[i]!]);
  }
  return out;
}
