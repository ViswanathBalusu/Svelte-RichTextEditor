/**
 * SEC-056 criterion 5 (10 §4): the integration guide asks hosts not to use e-mail addresses as the
 * user identifier, and says why and what the service stores instead.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const GUIDE = readFileSync(
  new URL('../../../apps/reference-host/docs/integration-guide.md', import.meta.url),
  'utf8',
);

describe('SEC-056 criterion 5: the integration guide on e-mail addresses as sub', () => {
  it('has a section on the user identifier that tells hosts not to use e-mail addresses', () => {
    const start = GUIDE.indexOf('### The user identifier: `sub`');
    expect(start).toBeGreaterThan(-1);
    const next = GUIDE.indexOf('\n## ', start);
    const section = GUIDE.slice(start, next === -1 ? undefined : next);
    expect(section).toMatch(/Not an e-mail address\.\*\* Do not use e-mail addresses as `sub`/);
    expect(section).toMatch(/personal data/);
    expect(section).toMatch(/surrogate/);
  });
});
