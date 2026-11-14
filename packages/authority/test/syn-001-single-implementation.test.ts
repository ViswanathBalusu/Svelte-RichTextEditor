// SYN-001 criterion 4 (lane U-SYN-001-018): the room, the transient authority, the local backend and
// the authority service import the `authority` package and contain no implementation of their own of
// `rebaseOver`, `applySteps`, `checkInvariants` and `mapRanges`. The check reads the production
// sources (not the tests) of every package and service, so it runs in `pnpm test` without a container.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const NAMES = ['rebaseOver', 'applySteps', 'checkInvariants', 'mapRanges'] as const;
const DECLARATION = new RegExp(
  String.raw`(?:\bfunction\s+|\b(?:const|let|var)\s+)(${NAMES.join('|')})\b`,
  'g',
);

/** Production TypeScript sources under the given top-level directories (no tests, no build output). */
function sources(dirs: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts'))
        out.push(full);
    }
  };
  for (const d of dirs) walk(join(root, d));
  return out;
}

const rel = (file: string) => relative(root, file).split('\\').join('/');
const read = (file: string) => readFileSync(file, 'utf8');
const mentions = (text: string, name: string) => new RegExp(`\\b${name}\\b`).test(text);

const SERVICE_AND_CLIENT_DIRS = [
  'packages/backend-mock/src',
  'packages/backend-dep/src',
  'packages/engine/src',
  'services/document-service/src',
];
const OWN_PACKAGE = 'packages/authority/src';

describe('one implementation of the four functions (SYN-001 criterion 4)', () => {
  it('declares each of the four functions once, in the authority package', () => {
    const declared = new Map<string, string[]>(NAMES.map((n) => [n, []]));
    for (const file of sources([OWN_PACKAGE])) {
      for (const m of read(file).matchAll(DECLARATION)) {
        declared.get(m[1]!)!.push(rel(file));
      }
    }
    for (const name of NAMES) {
      expect(declared.get(name), name).toHaveLength(1);
    }
  });

  it('contains no declaration of the four functions outside the authority package', () => {
    const found: string[] = [];
    for (const file of sources(['packages', 'services', 'apps'])) {
      if (rel(file).startsWith('packages/authority/')) continue;
      for (const m of read(file).matchAll(DECLARATION)) found.push(`${rel(file)}: ${m[1]}`);
    }
    expect(found).toEqual([]);
  });

  it('imports the package wherever the local backend, the authority service and the engine use one of them', () => {
    const users: string[] = [];
    for (const file of sources(SERVICE_AND_CLIENT_DIRS)) {
      const text = read(file);
      if (!NAMES.some((n) => mentions(text, n))) continue;
      users.push(rel(file));
      expect(text, rel(file)).toMatch(/from '@docedit\/authority'/);
    }
    // The local backend and the authority service both reach the functions through the package.
    expect(users).toEqual(
      expect.arrayContaining([
        'packages/backend-mock/src/document.ts',
        'services/document-service/src/data-plane/tasks.ts',
      ]),
    );
  });

  it('keeps the room and the transient authority on the package (they are Room in process)', () => {
    const roomHost = read(join(root, 'services/document-service/src/data-plane/room-host.ts'));
    expect(roomHost).toMatch(/\bRoom\b[\s\S]*?from '@docedit\/authority'/);
    const roomSource = read(join(root, 'packages/authority/src/room/room.ts'));
    expect(roomSource).toMatch(/from '\.\.\/rebase\.ts'/);
    expect(roomSource).toMatch(/from '\.\.\/ranges\.ts'/);
    expect(roomSource).toMatch(/from '\.\.\/invariants\.ts'/);
  });

  it('keeps the local backend free of a step application of its own', () => {
    const backend = read(join(root, 'packages/backend-mock/src/document.ts'));
    expect(backend).not.toMatch(/\.apply\(/);
  });
});
