/**
 * SEC-043, criterion 1: a language check over the repository's product text. The check flags the
 * over-claims that 12 section 8.3 and ADR 0013 forbid ("qualified" as a signature level, "legally
 * binding everywhere" and the phrases of the legal note's word lists) unless the line says the
 * product does not provide them, or the file is a reviewed record that states the prohibition.
 *
 * Scope: text files under packages, services, apps, infra and docs, plus PRODUCT.md and README.md.
 * Not scanned: test sources (their phrases are test data), node_modules and build output, and
 * binary files. Reviewed records (the spec, the ADRs, the stories, the review notes and the legal
 * note, which holds the word lists) are exempt, because they are where the rule is written down.
 * Criterion 2 (the certificate of completion and the evidence record) and criterion 3 (counsel's
 * review) are not covered here: see the Notes of SEC-043.
 *
 * The check runs under `pnpm test` (the node project of vitest.config.ts). Its wiring into the CI
 * workflow lives in .github, which this lane does not edit.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

const SCAN_ROOTS = ['packages', 'services', 'apps', 'infra', 'docs', 'PRODUCT.md', 'README.md'];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'test-results',
  'corpus',
  'playwright-report',
  'out',
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

/** Test sources: their phrases are test data, not product text. */
const TEST_SOURCE = /\.(test|spec)\.[a-z]+$/;

/**
 * Reviewed records, exempt because they state the rule or quote the word lists. Paths are relative
 * to the repository, with forward slashes.
 */
const REVIEWED_CONTEXT: readonly (string | RegExp)[] = [
  /^docs\/spec\//,
  /^docs\/adr\//,
  /^docs\/stories\//,
  /^docs\/review\//,
  'docs/research/2026-11-06-legal-note.md',
  // FRW-058's own word list of over-claims (OVERCLAIM_PHRASES): it quotes the phrases to forbid them.
  'packages/authority/src/workflow/language.ts',
];

/** The forbidden forms. "qualified" counts only as a signature, seal or time-stamp level. */
const FORBIDDEN: readonly RegExp[] = [
  /\bqualified\s+(electronic\s+)?(signatures?|seals?|time-?stamps?)\b/i,
  /\beidas[- ]qualified\b/i,
  /\bQES\b/,
  /\badvanced\s+electronic\s+signatures?\b/i,
  /\blegally\s+binding\s+everywhere\b/i,
  /\blegally\s+binding\s+in\s+all\s+countries\b/i,
  /\bvalid\s+worldwide\b/i,
  /\bvalid\s+for\s+any\s+document\b/i,
  /\bcourt-proof\b/i,
  /\bguaranteed\s+admissible\b/i,
  /\balways\s+enforceable\b/i,
  /\bnotari[sz]ed\b/i,
  /\bcertified\s+signature\b/i,
  /\btamper-proof\b/i,
  /\bcannot\s+be\s+forged\b/i,
  /\beidas-compliant\b/i,
  /\besign-compliant\b/i,
  /\bueta-compliant\b/i,
  /\baccepted\s+in\s+every\s+country\b/i,
  /\blegally\s+equivalent\s+to\s+a\s+handwritten\s+signature\b/i,
];

/** A line that says the product does not provide the claim is a negation, not a claim. */
const NEGATION =
  /\b(never|not|no|nor|without|avoid|avoids|forbid|forbids|forbidden|must not|does not|do not|cannot|false|untrue|refuse|refused|reject|rejected|unless)\b|n't\b/i;

export interface Finding {
  file: string;
  line: number;
  phrase: string;
  text: string;
}

function isReviewed(file: string): boolean {
  return REVIEWED_CONTEXT.some((p) => (typeof p === 'string' ? p === file : p.test(file)));
}

/** The findings in one text. `file` decides whether a reviewed record is exempt. */
export function scanText(file: string, text: string): Finding[] {
  if (isReviewed(file)) return [];
  const out: Finding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (NEGATION.test(line)) return;
    for (const re of FORBIDDEN) {
      const m = re.exec(line);
      if (m) out.push({ file, line: i + 1, phrase: m[0], text: line.trim().slice(0, 160) });
    }
  });
  return out;
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Every product text file of the repository, as repository-relative paths with forward slashes. */
export function productTextFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const full = join(REPO, root);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    const candidates = st.isDirectory() ? walk(full) : [full];
    for (const f of candidates) {
      const rel = relative(REPO, f).split(sep).join('/');
      if (!TEXT_EXTENSIONS.has(extname(f))) continue;
      if (TEST_SOURCE.test(f)) continue;
      files.push(rel);
    }
  }
  return files.sort();
}

describe('SEC-043: product language does not over-claim', () => {
  it('flags the forbidden claims and lets negated or reviewed text through (control)', () => {
    expect(
      scanText('packages/x/src/sign.ts', 'Sign with a qualified electronic signature.'),
    ).toHaveLength(1);
    expect(
      scanText('packages/x/src/sign.ts', 'This signature is legally binding everywhere.'),
    ).toHaveLength(1);
    expect(scanText('packages/x/src/sign.ts', 'Notarised and tamper-proof.')).toHaveLength(2);
    expect(
      scanText('packages/x/src/sign.ts', 'Never say "qualified" or "legally binding everywhere".'),
    ).toEqual([]);
    expect(
      scanText(
        'packages/x/src/sign.ts',
        'It is a schema-qualified name and not a signature level.',
      ),
    ).toEqual([]);
    expect(scanText('packages/x/src/sign.ts', 'A qualified time-stamp.')).toHaveLength(1);
    expect(
      scanText(
        'docs/spec/12-fields-rules-workflow.md',
        'Advanced and qualified electronic signatures.',
      ),
    ).toEqual([]);
  });

  it('scans a real set of product text files, so an empty scan cannot pass', () => {
    const files = productTextFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('PRODUCT.md');
    expect(files.some((f) => f.startsWith('packages/'))).toBe(true);
    expect(files.some((f) => f.startsWith('services/'))).toBe(true);
  });

  it('finds no over-claim in the repository text outside the reviewed records', () => {
    const findings: Finding[] = [];
    for (const file of productTextFiles()) {
      const text = readFileSync(join(REPO, file), 'utf8');
      findings.push(...scanText(file, text));
    }
    const report = findings
      .map((f) => `${f.file}:${f.line} "${f.phrase}" in: ${f.text}`)
      .join('\n');
    expect(findings, report).toEqual([]);
  });
});
