/**
 * The integration guide links to the parity profile version of its own release (UX-001
 * criterion 5; UX-090). The guide and the profile are in one repository, so a release holds one
 * version of each. The guide states the profile's version and date in a relative link; this test
 * fails when the stated version is not the version of the generated profile the link opens.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(HOST, '..', '..');
const GUIDE_DIR = join(HOST, 'docs');
const GUIDE = readFileSync(join(GUIDE_DIR, 'integration-guide.md'), 'utf8');
const PROFILE_MD_PATH = join(REPO, 'spec', 'parity', 'parity-profile.md');

interface ProfileHead {
  readonly version: number;
  readonly date: string;
}

function profileHead(): ProfileHead {
  const parsed: unknown = JSON.parse(
    readFileSync(join(REPO, 'spec', 'parity', 'parity-profile.json'), 'utf8'),
  );
  if (typeof parsed !== 'object' || parsed === null) throw new Error('profile is not an object');
  const { version, date } = parsed as { version?: unknown; date?: unknown };
  if (typeof version !== 'number' || typeof date !== 'string') {
    throw new Error('profile has no version or date');
  }
  return { version, date };
}

/** Every link of the guide whose text names a parity profile version. */
function versionLinks(): { version: number; date: string; target: string }[] {
  const pattern = /\[parity profile version (\d+) \((\d{4}-\d{2}-\d{2})\)\]\(([^)\s]+)\)/g;
  return [...GUIDE.matchAll(pattern)].map((m) => ({
    version: Number(m[1]),
    date: m[2] ?? '',
    target: m[3] ?? '',
  }));
}

describe('integration guide and the parity profile version (UX-001 criterion 5)', () => {
  it('links to the profile exactly once, with a version and a date', () => {
    expect(versionLinks()).toHaveLength(1);
  });

  it('links by a relative path that opens the generated profile of the same checkout', () => {
    const [link] = versionLinks();
    expect(link).toBeDefined();
    const target = link?.target ?? '';
    expect(target).not.toMatch(/^[a-z]+:|^\//i);
    const opened = resolve(GUIDE_DIR, target);
    expect(opened).toBe(resolve(PROFILE_MD_PATH));
    expect(existsSync(opened)).toBe(true);
  });

  it('states the version and date of the machine-readable profile', () => {
    const [link] = versionLinks();
    const head = profileHead();
    expect(link?.version).toBe(head.version);
    expect(link?.date).toBe(head.date);
  });

  it('states the version and date the linked file itself carries', () => {
    const [link] = versionLinks();
    const md = readFileSync(PROFILE_MD_PATH, 'utf8');
    expect(md).toContain(`\nVersion ${String(link?.version)}, ${link?.date ?? ''}. `);
  });

  it('names no other parity profile version anywhere in the guide', () => {
    const named = [...GUIDE.matchAll(/parity profile version (\d+)/gi)].map((m) => Number(m[1]));
    expect(named).toEqual([profileHead().version]);
  });
});
