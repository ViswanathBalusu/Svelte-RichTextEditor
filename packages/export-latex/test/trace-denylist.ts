/**
 * The denylist of primitives that no emitter or gate may reach (decision 212 of
 * docs/owner-decisions-2026-11-15.md: "nothing unexpected" in a token trace means a denylist of
 * dangerous primitives, ADR 0320). Used by the trace tests of EXP-046 and EXP-053 (Node.js only).
 */

/** Primitives with I/O, shell, catcode or engine-level effects. None may appear in a value's trace. */
export const DANGEROUS: ReadonlySet<string> = new Set([
  'input',
  'endinput',
  'openin',
  'openout',
  'closein',
  'closeout',
  'read',
  'readline',
  'write',
  'immediate',
  'special',
  'directlua',
  'latelua',
  'luaexec',
  'catcode',
  'shellescape',
  'pdfshellescape',
]);

/** The names (as `\word`) that are on the denylist, sorted. */
export function dangerousIn(names: Iterable<string>): string[] {
  const out: string[] = [];
  for (const n of names) if (n.startsWith('\\') && DANGEROUS.has(n.slice(1))) out.push(n);
  return out.sort();
}
