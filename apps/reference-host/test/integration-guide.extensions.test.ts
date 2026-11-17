/**
 * The extensions section of the integration guide (UX-050 criterion 4, UX-052 criterion 4; 13
 * section 7). A test cannot judge the prose. It checks that the section is there and says what the
 * criteria ask: that tier 1 runs in the page with the host's trust, and that it lists the
 * accessibility requirements a panel is held to. It also checks the facts the list rests on, in
 * the editor's own tests: the pane host's keys, the status item's text alternative, and axe.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(HOST, '..', '..');
const GUIDE = readFileSync(join(HOST, 'docs', 'integration-guide.md'), 'utf8');

function section(title: string): string {
  const start = GUIDE.indexOf(`\n## ${title}`);
  if (start < 0) return '';
  const rest = GUIDE.slice(start + 1);
  const next = rest.indexOf('\n## ', 1);
  return next < 0 ? rest : rest.slice(0, next);
}

const EXTENSIONS = section('Extensions (UX-050, UX-052; 13 section 7)');

describe('integration guide, extensions (UX-050 criterion 4)', () => {
  it('has the section', () => {
    expect(EXTENSIONS).not.toBe('');
  });

  it('says a tier 1 extension runs in the page with the host’s trust', () => {
    expect(EXTENSIONS).toContain('Tier 1 extensions run in the page, with the host');
    expect(EXTENSIONS).toContain('trust');
    expect(EXTENSIONS).toContain('the user’s token'.replace('’', "'"));
    expect(EXTENSIONS).toContain('does not sandbox');
  });

  it('says how a bad entry is reported', () => {
    expect(EXTENSIONS).toContain('`de-error`');
    expect(EXTENSIONS).toContain('`fatal` false');
  });
});

describe('integration guide, extension panels (UX-052 criterion 4)', () => {
  const requirements = EXTENSIONS.split('\n').filter((l) => /^\d+\. \*\*/.test(l));

  it('lists the accessibility requirements, numbered, with a bold lead each', () => {
    expect(requirements.length).toBeGreaterThanOrEqual(6);
    expect(EXTENSIONS).toContain('same accessibility bar as a built-in panel');
  });

  it.each([
    ['a heading and accessible names', 'accessible name'],
    ['keyboard use, Ctrl+F6 and Escape', 'Ctrl+F6'],
    ['focus taken on opening', 'moves focus into the panel'],
    ['a text alternative for a status item', 'text alternative'],
    ['the --de- properties', '`--de-`'],
    ['axe with no violations', 'axe with no violations'],
    ['the strict content security policy', 'strict content security policy'],
  ])('states the requirement on %s', (_name, phrase) => {
    expect(EXTENSIONS.toLowerCase()).toContain(phrase.toLowerCase());
  });

  it('is backed by the editor’s own browser tests of a contributed panel', () => {
    const spec = readFileSync(
      join(REPO, 'packages', 'ui', 'e2e', 'extension-contributions.spec.ts'),
      'utf8',
    );
    expect(spec).toContain("press('Control+F6')");
    expect(spec).toContain('axe(page)');
    expect(spec).toContain('.de-visually-hidden');
    expect(spec).toContain('--de-text');
  });
});
