/**
 * The integration guide (UX-090; 13 section 11.1) cannot go stale silently: every source file it
 * names must exist, and every function it names must be exported from the file it is said to be in.
 * These checks are the part of criteria 1 and 5 that a test can hold; the quick start (criterion 2)
 * and the generated reference (criterion 3) are not checked here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = readFileSync(join(HOST, 'docs', 'integration-guide.md'), 'utf8');

/** The five obligations of 13 section 11.1, in order, as the guide's `##` headings. */
const OBLIGATIONS = [
  '## 1. The token endpoint',
  '## 2. The page glue',
  '## 3. The webhook receiver',
  "## 4. The host's own catalogue",
  '## 5. Notifications',
];

/** The glue's sections, named as page-glue.ts refers to them (UX-093 cross-references). */
const GLUE_SECTIONS = [
  '### Tokens: getToken and renewal',
  "### The host's directory",
  '### When the token is refused',
  '### Errors',
  '### Sharing',
  '### Leaving the page',
];

/** Each named function or constant of the guide, and the file that exports it. */
const NAMED: ReadonlyArray<readonly [string, string]> = [
  ['attachEditor', 'src/lib/glue/page-glue.ts'],
  ['flushBeforeNavigation', 'src/lib/glue/page-glue.ts'],
  ['tokenSource', 'src/lib/glue/page-glue.ts'],
  ['directoryResolver', 'src/lib/glue/page-glue.ts'],
  ['principalSearch', 'src/lib/glue/page-glue.ts'],
  ['AUTH_RETRY_WINDOW_MS', 'src/lib/glue/page-glue.ts'],
  ['verifyWebhook', 'src/lib/server/webhook-receiver.ts'],
  ['NO_STORE', 'src/lib/server/request.ts'],
  ['tenantRegistration', 'scripts/lib/stack.ts'],
];

/** Repository paths the guide names in backticks: each must exist under the reference host. */
function pathsNamed(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    const token = m[1] ?? '';
    if (/^(src|scripts|test|seed)\//.test(token) && /\.(ts|svelte|json|md)$/.test(token))
      found.add(token);
  }
  return [...found];
}

function section(title: string): string {
  const start = GUIDE.indexOf(title);
  if (start < 0) return '';
  const rest = GUIDE.slice(start + title.length);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('integration guide (UX-090)', () => {
  it('has the five obligations of 13 section 11.1, in order', () => {
    let at = -1;
    for (const heading of OBLIGATIONS) {
      const found = GUIDE.indexOf(`\n${heading}\n`);
      expect(found, heading).toBeGreaterThan(at);
      at = found;
    }
  });

  it('gives a worked example (a fenced code block) for each obligation', () => {
    for (const heading of OBLIGATIONS) {
      const body = section(`\n${heading}\n`);
      expect(body, heading).toMatch(/```[a-z]*\n[\s\S]*?```/);
    }
  });

  it('has the glue sections that page-glue.ts refers to', () => {
    for (const heading of GLUE_SECTIONS) expect(GUIDE, heading).toContain(`\n${heading}\n`);
  });

  it('states who owns what: identity, catalogue, sharing and notifications for the host, editing for the editor', () => {
    const body = section('## Who owns what');
    expect(body).toMatch(
      /The host owns identity, the document catalogue, sharing and notifications\./,
    );
    expect(body).toMatch(
      /The editor owns editing, the rights on parts, fields and history, and the output\./,
    );
  });

  it('names only source files that exist', () => {
    const paths = pathsNamed(GUIDE);
    expect(paths.length).toBeGreaterThan(10);
    const missing = paths.filter((p) => !existsSync(join(HOST, p)));
    expect(missing).toEqual([]);
  });

  it.each(NAMED)('%s is exported from %s', (name, file) => {
    const source = readFileSync(join(HOST, file), 'utf8');
    expect(source).toMatch(
      new RegExp(`export\\s+(async\\s+)?(function|const|class)\\s+${name}\\b`),
    );
    expect(GUIDE).toContain(name);
  });
});
