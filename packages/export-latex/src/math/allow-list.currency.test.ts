/**
 * EXP-049 criterion 5, part (Node.js only): the generated allow-list file is current. The test
 * recomputes the list from `candidates.ts` with the same code the generator uses, and checks that
 * `allow-list.ts` holds the same data, fingerprint, KaTeX version and refusals. It also checks that
 * the KaTeX version the package installs is the one the list was generated with. The part that
 * still needs the TeX engine (every entry compiles under the class's math setup) is not here.
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { ALLOW_LIST } from './allow-list.ts';
import { computeAllowList } from './allow-list-source.ts';
import { KATEX_VERSION } from './katex.ts';

const installedKatex = (createRequire(import.meta.url)('katex/package.json') as { version: string })
  .version;

describe('math allow-list currency (EXP-049 criterion 5, part)', () => {
  it('holds the commands and environments that the generator computes now', async () => {
    const d = await computeAllowList();
    expect(ALLOW_LIST.version).toBe(d.version);
    expect(Object.fromEntries(d.commands.map((c) => [c.name, c.arity]))).toEqual({
      ...ALLOW_LIST.commands,
    });
    expect([...ALLOW_LIST.environments]).toEqual(d.environments);
  });

  it('has the fingerprint of its own content, as the generator computes it', async () => {
    const d = await computeAllowList();
    expect(ALLOW_LIST.fingerprint).toBe(d.fingerprint);
    expect(ALLOW_LIST.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records the KaTeX version that the package installs and the gate runs', async () => {
    const d = await computeAllowList();
    expect(ALLOW_LIST.katex).toBe(installedKatex);
    expect(KATEX_VERSION).toBe(installedKatex);
    expect(d.katex).toBe(installedKatex);
  });

  it('records the refusals the generator makes, so a review sees them', async () => {
    const d = await computeAllowList();
    expect(ALLOW_LIST.refused).toEqual(d.refused);
  });

  it('keeps the command names sorted, which the generator relies on for a stable fingerprint', () => {
    const names = Object.keys(ALLOW_LIST.commands);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});
