/**
 * The browser-extension statement of the integration guide (SEC-011 criterion 3; ADR 0425; 10 §6).
 * The guide must say that extensions run with the user's privileges and cannot be prevented, and
 * what the editor guarantees: their edits arrive as ordinary input and pass the same checks. A test
 * cannot judge the prose; it checks that the statement is in the limits section and that the
 * decision record and the spec agree with it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(HOST, '..', '..');
const GUIDE = readFileSync(join(HOST, 'docs', 'integration-guide.md'), 'utf8');

function limitsSection(): string {
  const start = GUIDE.indexOf('\n## Limits of the embedding\n');
  if (start < 0) return '';
  const rest = GUIDE.slice(start + 1);
  const next = rest.indexOf('\n## ', 1);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('integration guide, browser extensions (SEC-011 criterion 3)', () => {
  const bullet =
    limitsSection()
      .split('\n')
      .find((l) => l.startsWith('- **Browser extensions (SEC-011).**')) ?? '';

  it('says extensions run with the user privileges and cannot be prevented', () => {
    expect(bullet).not.toBe('');
    expect(bullet).toContain("runs with the user's privileges");
    expect(bullet).toContain('cannot prevent it');
  });

  it('says what the editor guarantees', () => {
    expect(bullet).toContain('arrives as ordinary input');
    expect(bullet).toContain('schema keeps only valid content');
    expect(bullet).toContain('permission_denied');
  });

  it('says what it does not promise', () => {
    expect(bullet).toContain('does not promise that an extension cannot read');
  });
});

describe('the decision record of the policy (SEC-011 criterion 1)', () => {
  const adr = readFileSync(
    join(REPO, 'docs', 'adr', '0425-w8-SEC-011-browser-extension-policy.md'),
    'utf8',
  );

  it('is accepted on owner decision 199 and states the position and the guarantee', () => {
    expect(adr).toContain('**Status:** accepted');
    expect(adr).toContain('owner decision 199');
    expect(adr).toContain("run in the user's browser with the user's privileges");
    expect(adr).toContain('cannot prevent');
    expect(adr).toContain('ordinary input');
    expect(adr).toContain('`permission_denied`');
  });

  it('is cited by the spec and the guide', () => {
    expect(readFileSync(join(REPO, 'docs', 'spec', '10-security.md'), 'utf8')).toContain(
      'ADR 0425',
    );
    expect(bulletOf()).toContain('ADR 0425');
  });
});

function bulletOf(): string {
  return (
    limitsSection()
      .split('\n')
      .find((l) => l.startsWith('- **Browser extensions (SEC-011).**')) ?? ''
  );
}
