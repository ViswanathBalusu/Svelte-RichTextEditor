/**
 * The integration guide on the `sub` claim (PRO-009 criterion 7; 05 §3.1; 08 §13). The guide must
 * say that the identifier is opaque and stable, that hosts should not use e-mail addresses, and
 * that the service stores a per-tenant surrogate. A test cannot judge the prose; it checks that
 * each statement is present in the section about `sub`, and that the specification still says what
 * the guide repeats.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(HOST, '..', '..');
const GUIDE = readFileSync(join(HOST, 'docs', 'integration-guide.md'), 'utf8');
const PROTOCOL = readFileSync(join(REPO, 'docs', 'spec', '05-protocol.md'), 'utf8');
const HISTORY = readFileSync(join(REPO, 'docs', 'spec', '08-history.md'), 'utf8');

/** The section about `sub`: from its heading to the next heading of any level. */
function subSection(): string {
  const start = GUIDE.indexOf('\n### The user identifier: `sub`\n');
  if (start < 0) return '';
  const rest = GUIDE.slice(start + 1);
  const next = rest.search(/\n#{1,6} /);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('integration guide: the `sub` claim (PRO-009 criterion 7)', () => {
  it('has a section about `sub` inside the token endpoint chapter', () => {
    const chapter = GUIDE.indexOf('\n## 1. The token endpoint\n');
    const section = GUIDE.indexOf('\n### The user identifier: `sub`\n');
    const nextChapter = GUIDE.indexOf('\n## 2. ');
    expect(chapter).toBeGreaterThanOrEqual(0);
    expect(section).toBeGreaterThan(chapter);
    expect(section).toBeLessThan(nextChapter);
  });

  it('says the identifier is opaque and stable', () => {
    const s = subSection();
    expect(s).toContain('- **Opaque.**');
    expect(s).toContain('- **Stable.**');
    expect(s).toContain('the same `sub` for the same person in every token');
  });

  it('says hosts should not use e-mail addresses', () => {
    const s = subSection();
    expect(s).toContain('- **Not an e-mail address.**');
    expect(s).toContain('Do not use e-mail addresses as `sub`');
  });

  it('gives the reason: the service stores a per-tenant surrogate (08 section 13)', () => {
    const s = subSection();
    expect(s).toContain('per-tenant surrogate identifier');
    expect(s).toContain('08 section 13');
  });

  it('repeats what the specification says', () => {
    // 05 §3.1, the row of `sub`.
    const row = PROTOCOL.split('\n').find((l) => l.startsWith('| `sub` |')) ?? '';
    expect(row).toContain('Opaque, stable user identifier');
    expect(row).toContain('SHOULD NOT use e-mail addresses');
    expect(row).toContain('per-tenant surrogate');
    // 08 §13: the log holds surrogates, and erasing a person deletes the mapping row.
    expect(HISTORY).toContain("per-tenant surrogate identifiers, not the host's `sub` values");
    expect(HISTORY).toContain('Erasing a person deletes that row');
  });
});
