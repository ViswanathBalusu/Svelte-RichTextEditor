/**
 * FND-008: the groups of the source string table that only code loaded on demand shows
 * (`src/i18n/late/*.ts`) are not in the first load. A group is correct when: its keys are in no other
 * part of the table; every file that names one of its keys imports it (so the strings are there
 * before the file draws them); and no key that a file builds at run time from a prefix is in a
 * group (a file cannot name the group it needs for a key it has not spelt out).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { EN_GB_CORE } from '../src/i18n/en-GB-core.ts';
import { LATE_KEY_HEADS, SOURCE_TABLE } from '../src/i18n/source.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(here, '..', 'src');
const ELEMENT_SRC = join(here, '..', '..', 'element', 'src');
const LATE = join(SRC, 'i18n', 'late');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
  });
}

/** The groups: file name of `late/` to the keys it holds, read from the whole table's source. */
async function groups(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const name of readdirSync(LATE)) {
    const group = name.replace(/\.ts$/, '');
    const module = (await import(`../src/i18n/late/${group}.ts`)) as Record<
      string,
      Record<string, unknown>
    >;
    const table = Object.values(module).find((v) => typeof v === 'object' && v !== null);
    out.set(group, Object.keys(table ?? {}));
  }
  return out;
}

const posix = (p: string): string => p.split(sep).join('/');

describe('the groups of the source table that load on demand (FND-008)', () => {
  it('hold keys that are in no other part, and together with the core are the whole table', async () => {
    const all = await groups();
    expect(all.size).toBeGreaterThan(10);
    const seen = new Map<string, string>();
    for (const [group, keys] of all)
      for (const key of keys) {
        expect(Object.hasOwn(EN_GB_CORE, key), `${key} is in the core and in ${group}`).toBe(false);
        expect(seen.get(key), `${key} is in ${seen.get(key)} and in ${group}`).toBeUndefined();
        seen.set(key, group);
      }
    expect(Object.keys(EN_GB).length).toBe(Object.keys(EN_GB_CORE).length + seen.size);
    expect(Object.keys(SOURCE_TABLE).length).toBe(Object.keys(EN_GB).length);
  });

  it('have the first part of every key in the list the source table keeps', async () => {
    const heads = new Set<string>();
    for (const keys of (await groups()).values())
      for (const key of keys) heads.add(key.split('.')[0]!);
    expect([...heads].sort()).toEqual([...LATE_KEY_HEADS].sort());
    // Keys the shell builds from a name that is not a key (`command.*`, `pane.*`) stay in the core.
    for (const head of [
      'command',
      'pane',
      'synonyms',
      'reason',
      'group',
      'header',
      'toolbar',
      'status',
    ])
      expect(heads.has(head), head).toBe(false);
  });

  it('are imported by every file that names one of their keys', async () => {
    const owner = new Map<string, string>();
    for (const [group, keys] of await groups()) for (const key of keys) owner.set(key, group);
    const literal = /(['"`])([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)\1/g;
    const missing: string[] = [];
    for (const file of [...walk(SRC), ...walk(ELEMENT_SRC)]) {
      const path = posix(relative(join(here, '..', '..'), file));
      if (path.startsWith('ui/src/i18n/')) continue;
      const text = readFileSync(file, 'utf8');
      const needs = new Set<string>();
      for (const m of text.matchAll(literal)) {
        const group = owner.get(m[2]!);
        if (group !== undefined) needs.add(group);
      }
      for (const group of needs)
        if (!new RegExp(`i18n/late/${group}\\.ts'`).test(text))
          missing.push(`${path} names a key of the ${group} group and does not import it`);
    }
    expect(missing).toEqual([]);
  });

  it('hold no key that a file builds at run time from a prefix', async () => {
    const dynamic = /[`'"]([a-zA-Z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*\.)(?:\$\{|['"]\s*\+)/g;
    const prefixes = new Map<string, string>();
    for (const file of [...walk(SRC), ...walk(ELEMENT_SRC)]) {
      const path = posix(relative(join(here, '..', '..'), file));
      for (const m of readFileSync(file, 'utf8').matchAll(dynamic))
        if (!prefixes.has(m[1]!)) prefixes.set(m[1]!, path);
    }
    const inGroups: string[] = [];
    for (const [group, keys] of await groups())
      for (const key of keys)
        for (const [prefix, file] of prefixes)
          if (key.startsWith(prefix))
            inGroups.push(`${key} (${group}) is built from "${prefix}" in ${file}`);
    expect(inGroups).toEqual([]);
  });
});
