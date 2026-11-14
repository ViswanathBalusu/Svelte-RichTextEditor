/**
 * The published artifacts of the rules package (FRW-020), as text: the JSON Schema of the
 * language, the fixtures with the preset definitions and the limits, and a manifest with the
 * rules version and the SHA-256 of each file. The generate script writes them under spec/rules; a
 * test regenerates them and fails when the files differ.
 */
import { sha256Hex } from '@docedit/model';
import { PROFILE } from './conformance.ts';
import { FIXTURES } from './fixtures/index.ts';
import { generateRulesSchema } from './schema.ts';
import { RULES_STATUS, RULES_VERSION } from './version.ts';

export interface Artifact {
  /** Path relative to the repository root. */
  path: string;
  text: string;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** `spec/rules/rules-1` for `rules/1`. */
export const artifactBase = (version = RULES_VERSION): string =>
  `spec/rules/${version.replace('/', '-')}`;

export async function generateArtifacts(): Promise<Artifact[]> {
  const base = artifactBase();
  const files: Artifact[] = [
    { path: `${base}.schema.json`, text: json(generateRulesSchema()) },
    { path: `${base}.fixtures.json`, text: json(FIXTURES) },
  ];
  const manifest = {
    rules: RULES_VERSION,
    status: RULES_STATUS,
    ...PROFILE,
    generator: 'packages/rules/scripts/generate.ts',
    decision: 'docs/adr/0030-rule-semantics.md',
    cases: FIXTURES.cases.length,
    files: Object.fromEntries(
      await Promise.all(files.map(async (f) => [f.path, await sha256Hex(f.text)] as const)),
    ),
  };
  files.push({ path: `${base}.manifest.json`, text: json(manifest) });
  return files;
}

interface PublishedCase {
  id: string;
  expect: unknown;
  [member: string]: unknown;
}

/**
 * The published cases whose expected result changed, or that disappeared, while their inputs and
 * the rules version stayed the same. A new rules version is the only way to change them (FRW-020).
 */
export function changedUnderSameVersion(
  published: { rules: string; cases: readonly PublishedCase[] },
  current: { rules: string; cases: readonly PublishedCase[] },
): string[] {
  if (published.rules !== current.rules) return [];
  const now = new Map(current.cases.map((c) => [c.id, c] as const));
  const out: string[] = [];
  for (const old of published.cases) {
    const c = now.get(old.id);
    if (!c) {
      out.push(`${old.id}: a published case was removed under ${current.rules}`);
      continue;
    }
    const { expect: was, ...inputWas } = old;
    const { expect: is, ...inputIs } = c;
    if (
      JSON.stringify(inputWas) === JSON.stringify(inputIs) &&
      JSON.stringify(was) !== JSON.stringify(is)
    )
      out.push(`${old.id}: the expected result changed under ${current.rules}`);
  }
  return out;
}
