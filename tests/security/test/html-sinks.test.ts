/**
 * SEC-005 (static part) — the component source uses no HTML-string sink. The criterion asks that the
 * only uses of `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` and
 * `new Function` are the reviewed ProseMirror paste-parser sites. The allow-list below is that
 * review: it is empty, because no such site exists in the source today. An entry needs a reason and
 * a review, and any new use fails this test until it is added here with one.
 *
 * Scope: the non-test source of every package, service and app (`src/`, and `.svelte` components).
 * Test files, test helpers (`testing.ts`) and `test/` folders are out of scope, because they do not
 * ship. That scope is a decision of this story, recorded in docs/adr/0121-security-backlog-batch.md.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** `{@html` is the Svelte equivalent of an HTML-string sink. */
export const SINK =
  /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\.write(ln)?\s*\(|\beval\s*\(|\bnew\s+Function\s*\(|\{@html\b/g;

/** The reviewed sites: `file` relative to the repository root, with the reason. Empty today. */
export const REVIEWED_SITES: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: 'packages/painter/src/repaint.ts',
    reason:
      'Reads `outerHTML` only as a serialisation key, to match an existing child with a desired element so that unchanged nodes are kept. It writes no HTML and parses no string into the page. Reviewed in the SEC-005 pass of the stabiliser round 1; the owner of the painter package should confirm it.',
  },
];

const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|svelte)$/;
const TEST_NAME = /\.(test|spec)\.|\.universal\.test\./;

/** Non-test source files under the `src` directory of every workspace package, service and app. */
export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const group of ['packages', 'services', 'apps']) {
    const groupDir = join(root, group);
    let members: string[];
    try {
      members = readdirSync(groupDir);
    } catch {
      continue;
    }
    for (const member of members) {
      const src = join(groupDir, member, 'src');
      if (existsDir(src)) walk(src, out);
    }
  }
  return out;
}

function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'test' || name === 'tests') continue;
      walk(full, out);
    } else if (SOURCE_EXT.test(name) && !TEST_NAME.test(name) && name !== 'testing.ts') {
      out.push(full);
    }
  }
}

/** Every sink use in `text`, as the matched token with its line number (1-based). */
export function sinkUses(text: string): Array<{ token: string; line: number }> {
  const uses: Array<{ token: string; line: number }> = [];
  text.split(/\r?\n/).forEach((line, i) => {
    // A comment that names a sink (for example "never `innerHTML`") is prose, not a call. Only
    // code lines are scanned; a sink written in code is still flagged.
    const t = line.trimStart();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    for (const m of line.matchAll(SINK)) uses.push({ token: m[0], line: i + 1 });
  });
  return uses;
}

describe('SEC-005: the component source uses no HTML-string sink', () => {
  it('the scanner flags each sink form, and nothing in plain code', () => {
    expect(sinkUses('el.innerHTML = x; el.outerHTML = y;').map((u) => u.token)).toEqual([
      'innerHTML',
      'outerHTML',
    ]);
    expect(sinkUses("el.insertAdjacentHTML('beforeend', s)")).toHaveLength(1);
    expect(sinkUses('document.write("x")')).toHaveLength(1);
    expect(sinkUses('eval(code); new Function("a")')).toHaveLength(2);
    expect(sinkUses('<div {@html body}></div>')).toHaveLength(1);
    expect(sinkUses('const name = "textContent"; el.textContent = name;')).toHaveLength(0);
  });

  it('the only uses in the non-test source are the reviewed sites (none today)', () => {
    const files = sourceFiles(ROOT);
    expect(files.length).toBeGreaterThan(0);
    const found: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file).split(sep).join('/');
      const reviewed = REVIEWED_SITES.some((s) => s.file === rel);
      if (reviewed) continue;
      for (const use of sinkUses(readFileSync(file, 'utf8'))) {
        found.push(`${rel}:${use.line} ${use.token}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('every reviewed site names a file that exists and gives a reason', () => {
    for (const site of REVIEWED_SITES) {
      expect(site.reason.length).toBeGreaterThan(0);
      expect(() => readFileSync(join(ROOT, site.file), 'utf8')).not.toThrow();
    }
  });
});
