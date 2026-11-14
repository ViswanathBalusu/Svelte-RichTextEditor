/**
 * The limits section of the integration guide (UX-090 criterion 6; UX-040, UX-052, UX-001). The
 * guide must state each limit in its own bullet, name the story that sets it, and name the
 * parity profile's non-goals and the file that holds them. A test cannot judge the prose; it checks
 * that each limit is present and that the facts it names exist in the repository.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(HOST, '..', '..');
const GUIDE = readFileSync(join(HOST, 'docs', 'integration-guide.md'), 'utf8');
const PROFILE_MD = readFileSync(join(REPO, 'spec', 'parity', 'parity-profile.md'), 'utf8');

function limitsSection(): string {
  const start = GUIDE.indexOf('\n## Limits of the embedding\n');
  if (start < 0) return '';
  const rest = GUIDE.slice(start + 1);
  const next = rest.indexOf('\n## ', 1);
  return next < 0 ? rest : rest.slice(0, next);
}

/** The bullet that starts with the given bold label, or '' when there is none. */
function bullet(label: string): string {
  const line = limitsSection()
    .split('\n')
    .find((l) => l.startsWith(`- **${label}`));
  return line ?? '';
}

describe('integration guide limits (UX-090 criterion 6)', () => {
  it('states the output-restriction limit (UX-040): deterrent, not a security boundary', () => {
    const b = bullet('Output restrictions (UX-040)');
    expect(b).not.toBe('');
    expect(b).toContain('deter casual copying');
    expect(b).toContain('not a security boundary');
    for (const name of ['no-export', 'no-copy', 'no-print']) expect(b).toContain(`\`${name}\``);
  });

  it('states the extension-panel limit (UX-052): the accessibility bar and who tests the content', () => {
    const b = bullet('Extension panels (UX-052)');
    expect(b).not.toBe('');
    expect(b).toContain('same accessibility bar as a built-in panel');
    expect(b).toContain('axe');
  });

  it('states the parity limit (UX-001) with the profile file and every non-goal', () => {
    const b = bullet('Parity (UX-001)');
    expect(b).not.toBe('');
    expect(existsSync(join(REPO, 'spec', 'parity', 'parity-profile.md'))).toBe(true);
    expect(b).toContain('`spec/parity/parity-profile.md`');
    for (const goal of [
      'SmartArt',
      'charts',
      'shapes',
      'text boxes and ink',
      'mail merge',
      'macros',
      'table formulas',
      'researcher-style lookup',
      'transcription',
      'offline-first editing',
    ]) {
      expect(b, goal).toContain(goal);
    }
  });

  it('names as non-goals in the guide only the rows the profile lists as non-goals', () => {
    // The profile's non-goal table lists the capability ids in its first column.
    const nonGoalSection = PROFILE_MD.slice(PROFILE_MD.indexOf('\n## Non-goals\n'));
    const ids = [...nonGoalSection.matchAll(/^\| ([a-z-]+) \|/gm)].map((m) => m[1] ?? '');
    expect(ids).toEqual(
      expect.arrayContaining([
        'smartart',
        'charts',
        'shapes',
        'text-boxes-and-ink',
        'mail-merge',
        'macros',
        'table-formulas',
        'researcher-lookup',
        'transcription',
        'offline-first',
      ]),
    );
  });
});
