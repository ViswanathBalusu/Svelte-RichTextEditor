// PRO-101 criterion 5 (lane V-PRO-086-102): the integration guide describes the three backend tiers
// of 05 section 9, says what each may announce, and says that a relay is for trusted clients only
// (SYN-044). The check reads the guide's text; the guide itself is the artifact.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = readFileSync(join(HOST, 'docs', 'integration-guide.md'), 'utf8');

/** The section of the guide that describes the tiers, from its heading to the next `##` heading. */
function tiersSection(): string {
  const start = GUIDE.indexOf('## Backend tiers');
  expect(start).toBeGreaterThan(-1);
  const rest = GUIDE.slice(start + 1);
  const next = rest.indexOf('\n## ');
  return next === -1 ? GUIDE.slice(start) : GUIDE.slice(start, start + 1 + next);
}

describe('the integration guide describes the backend tiers (PRO-101 criterion 5)', () => {
  it('names each of the three tiers with what it may announce', () => {
    const s = tiersSection();
    expect(s).toMatch(/^\| Native \|.*\| Everything \|$/m);
    expect(s).toMatch(/^\| Sidecar-backed \|.*\| Only what the authority service supports \|$/m);
    expect(s).toMatch(/^\| Relay \|.*`mode: "relay"`.*`regions`, `suggest-enforced` or `fields`/m);
  });

  it('says a relay is for trusted clients only and cites SYN-044', () => {
    const s = tiersSection();
    expect(s).toContain('A relay is for trusted clients only.');
    expect(s).toContain('(SYN-044)');
  });

  it('points to the authority service interface of 05 section 10', () => {
    expect(tiersSection()).toContain('05 section 10');
  });
});
