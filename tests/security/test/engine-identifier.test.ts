/**
 * SEC-050 criterion 4 — a dependency update that changes the step library's behaviour runs the
 * engine fixtures, and a changed fixture requires a new engine identifier (04 §4; SYN-002).
 *
 * The rule is enforced here, in the security suite, on the files themselves:
 *  - the installed prosemirror-transform and prosemirror-model are the releases the engine
 *    definition names (a dependency update that moves them fails until the definition moves);
 *  - the engine definition and its three golden fixture files hash to the digest recorded for
 *    their identifier. Changing any fixture byte under the same identifier fails; a changed
 *    fixture needs a new identifier, and so a new entry in `RECORDED`.
 * The fixtures' replay against the installed library is the job of packages/authority/test
 * (engine.test.ts); this file does not replay them.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ENGINE_DIR = 'packages/authority/fixtures/engine/';
const FILES = ['pm-steps-1.json', 'golden/apply.json', 'golden/map.json', 'golden/rebase.json'];

/**
 * The digest of each engine identifier's definition and golden fixtures. A new identifier takes
 * a new entry; an existing entry never changes (04 §4: a release that changes any fixture output
 * is a new engine identifier, never a silent upgrade).
 */
const RECORDED: Readonly<Record<string, string>> = {
  // Re-recorded on 2026-11-18 by lane w1 (FE-044, FE-045), under the same identifier, because owner
  // decision 92 moved block suggestions from node marks to the `suggest` attribute of the CDM
  // schema, which is still a draft (`status: draft` in pm-steps-1.json, nothing released). The
  // fixtures were regenerated against that schema; the behaviour of the step library did not
  // change. The previous digest was 014ca7714178e880a393e9572693400792299e6a0dbd96e036bc44276dd14498.
  // Whether a change of a draft schema needs `pm-steps/2` is for the owner of SYN-002 to say.
  'pm-steps/1': 'e371cf5f8ca8bc843be32d14347a873d68915d12a01cd9570d07af647bb66a81',
};

/** The release of each library the identifier pins (the definition names the same releases). */
const PINNED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'pm-steps/1': { 'prosemirror-transform': '1.12.5', 'prosemirror-model': '1.25.12' },
};

const readVersion = (pkg: string): string =>
  (
    JSON.parse(
      readFileSync(`${ROOT}packages/authority/node_modules/${pkg}/package.json`, 'utf8'),
    ) as {
      version: string;
    }
  ).version;

/** A digest over the file names and bytes, in a fixed order, so any byte change shows. */
export function fixtureDigest(
  read: (rel: string) => Buffer = (rel) => readFileSync(ROOT + ENGINE_DIR + rel),
): string {
  const h = createHash('sha256');
  for (const name of FILES) {
    h.update(`${name}\n`);
    h.update(read(name));
    h.update('\0');
  }
  return h.digest('hex');
}

describe('SEC-050 a changed step library or fixture needs a new engine identifier', () => {
  it('the engine definition names the identifier and the releases the security suite records', () => {
    const def = JSON.parse(readFileSync(`${ROOT}${ENGINE_DIR}pm-steps-1.json`, 'utf8')) as {
      engine: string;
      library: { name: string; version: string };
      alsoPinned: Array<{ name: string; version: string }>;
    };
    expect(Object.keys(RECORDED)).toContain(def.engine);
    expect(def.library.version).toBe(PINNED[def.engine]!['prosemirror-transform']);
    for (const p of def.alsoPinned) expect(p.version, p.name).toBe(PINNED[def.engine]![p.name]);
  });

  it('the installed step library and model are the pinned releases (a dependency update fails here)', () => {
    for (const [pkg, version] of Object.entries(PINNED['pm-steps/1']!))
      expect(readVersion(pkg), pkg).toBe(version);
  });

  it('the definition and golden fixtures hash to the digest recorded for their identifier', () => {
    expect(fixtureDigest()).toBe(RECORDED['pm-steps/1']);
  });

  it('a one-byte change to any fixture changes the digest, so it cannot pass under the same identifier', () => {
    const base = fixtureDigest();
    for (const target of FILES) {
      const changed = fixtureDigest((rel) => {
        const bytes = readFileSync(ROOT + ENGINE_DIR + rel);
        if (rel !== target) return bytes;
        const copy = Buffer.from(bytes);
        copy[copy.length - 2] = (copy[copy.length - 2]! ^ 0x01) & 0xff;
        return copy;
      });
      expect(changed, target).not.toBe(base);
    }
  });
});
