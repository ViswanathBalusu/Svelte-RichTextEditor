// FRW-058 criterion 1: the wording check over the repository's product text, with the maintained
// phrase list of FRW-058 itself (`OVERCLAIM_PHRASES`, packages/authority/src/workflow/language.ts).
// It runs under `pnpm test`, which CI runs, so a match fails the build.
//
// Scope (owner decision 99, 2026-11-15: the word "qualified" may name signature levels in the
// specification; the check covers interface texts and outward-facing documents): the text files
// under packages, services, apps, infra and spec (the machine-readable API descriptions), the docs
// that are not reviewed records, PRODUCT.md and README.md. The certificate template and every
// interface string are under services and packages. Not scanned: test sources (their phrases are
// test data), build output, and the reviewed records that state the rule or quote the word lists
// (the specification, the decision records, the stories, the review notes and the legal note). A line
// that says the product does not provide the claim is a negation, not a claim. SEC-043
// (tests/security/test/language-check.test.ts) scans the same text for its own list of forms; this
// file adds the phrases of the FRW-058 list that it does not hold.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findOverclaims, OVERCLAIM_PHRASES } from '../src/index.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SCAN_ROOTS = [
  'packages',
  'services',
  'apps',
  'infra',
  'spec',
  'docs',
  'PRODUCT.md',
  'README.md',
];
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.worktrees',
  'dist',
  'build',
  'coverage',
  'test-results',
  'corpus',
  'playwright-report',
  'out',
  'target',
]);
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.svelte',
  '.html',
  '.md',
  '.json',
  '.yaml',
  '.yml',
  '.txt',
  '.css',
  '.tex',
  '.ps1',
  '.sh',
]);
const TEST_SOURCE = /\.(test|spec)\.[a-z]+$/;
const REVIEWED_CONTEXT: readonly (string | RegExp)[] = [
  /^docs\/spec\//,
  /^docs\/adr\//,
  /^docs\/stories\//,
  /^docs\/review\//,
  'docs/research/2026-11-06-legal-note.md',
  // The list itself quotes the phrases to forbid them.
  'packages/authority/src/workflow/language.ts',
];
const NEGATION =
  /\b(never|not|no|nor|without|avoid|avoids|forbid|forbids|forbidden|must not|does not|do not|cannot|false|untrue|refuse|refused|reject|rejected|unless)\b|n't\b/i;

interface Finding {
  file: string;
  line: number;
  phrase: string;
  text: string;
}

const reviewed = (file: string): boolean =>
  REVIEWED_CONTEXT.some((p) => (typeof p === 'string' ? p === file : p.test(file)));

/** The phrases of the FRW-058 list in one text, line by line, except in a reviewed record. */
function scanText(file: string, text: string): Finding[] {
  if (reviewed(file)) return [];
  const out: Finding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (NEGATION.test(line)) return;
    for (const phrase of findOverclaims(line))
      out.push({ file, line: i + 1, phrase, text: line.trim().slice(0, 160) });
  });
  return out;
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

function productTextFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const full = join(REPO, root);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    for (const f of st.isDirectory() ? walk(full) : [full]) {
      if (!TEXT_EXTENSIONS.has(extname(f)) || TEST_SOURCE.test(f)) continue;
      files.push(relative(REPO, f).split(sep).join('/'));
    }
  }
  return files.sort();
}

describe('FRW-058 criterion 1: the repository text does not over-claim', () => {
  it('flags every phrase of the list, lets negated and reviewed text through (control)', () => {
    for (const phrase of OVERCLAIM_PHRASES)
      expect(scanText('packages/x/src/ui.ts', `Now with a ${phrase}.`), phrase).toHaveLength(1);
    expect(scanText('packages/x/src/ui.ts', 'Never say "qualified signature".')).toEqual([]);
    expect(scanText('docs/spec/12-fields-rules-workflow.md', 'A qualified signature.')).toEqual([]);
    expect(scanText('packages/x/src/ui.ts', 'A schema-qualified name.')).toEqual([]);
  });

  it('scans a real set of files, so an empty scan cannot pass', () => {
    const files = productTextFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('PRODUCT.md');
    expect(files).toContain('apps/reference-host/docs/integration-guide.md');
    expect(files.some((f) => f.startsWith('spec/'))).toBe(true);
    expect(files.some((f) => f.startsWith('packages/'))).toBe(true);
    expect(files.some((f) => f.startsWith('services/'))).toBe(true);
  });

  it('finds no phrase of the list in the product text outside the reviewed records', () => {
    const findings: Finding[] = [];
    for (const file of productTextFiles())
      findings.push(...scanText(file, readFileSync(join(REPO, file), 'utf8')));
    const report = findings
      .map((f) => `${f.file}:${f.line} "${f.phrase}" in: ${f.text}`)
      .join('\n');
    expect(findings, report).toEqual([]);
  });
});
