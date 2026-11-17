/**
 * The shadow-root statement of the integration guide (SEC-009 criterion 5; 10 §3.1). The guide must
 * say that the open shadow root is readable by the host page and that this is acceptable because
 * the host already holds the token. A test cannot judge the prose; it checks that the statement is
 * there, in the limits section, and that the fact it rests on holds: the element attaches its
 * shadow root in `open` mode.
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

describe('integration guide, the shadow root (SEC-009 criterion 5)', () => {
  const bullet =
    limitsSection()
      .split('\n')
      .find((l) => l.startsWith('- **The shadow root (SEC-009).**')) ?? '';

  it('says the open shadow root is readable by the host page', () => {
    expect(bullet).not.toBe('');
    expect(bullet).toContain('open shadow root');
    expect(bullet).toContain('not a security boundary');
    expect(bullet).toContain('your page can read it');
  });

  it('says why that is acceptable: the host already holds the token', () => {
    expect(bullet).toContain('That is acceptable');
    expect(bullet).toContain("already holds the user's token");
  });

  it('rests on a fact: the element attaches its shadow root in open mode', () => {
    const source = readFileSync(join(REPO, 'packages', 'element', 'src', 'doc-editor.ts'), 'utf8');
    expect(source).toContain("attachShadow({ mode: 'open' })");
    expect(source).not.toContain("mode: 'closed'");
  });
});
