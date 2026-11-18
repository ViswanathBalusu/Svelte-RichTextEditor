// FRW-087 criterion 4: while no counsel review of the signing claims is recorded, the sealing and
// certificate features are not announced as available for production use. The record is
// docs/legal/signing-claims-review.md; its status line says whether a review has taken place. While it
// says none has, no README, guide or product record may say that signing, sealing or certificates
// are ready or available for production. A line that denies it ("not", "never", "until", "no") is fine.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const RECORD = join(ROOT, 'docs', 'legal', 'signing-claims-review.md');

const read = (path: string): string => readFileSync(path, 'utf8');
const shown = (path: string): string => relative(ROOT, path).split(sep).join('/');

/** Markdown files that announce or describe the product to a reader: not the spec, ADRs or stories. */
function announcingFiles(): string[] {
  const out: string[] = [join(ROOT, 'README.md'), join(ROOT, 'PRODUCT.md')];
  const skip = new Set(['node_modules', 'dist', '.git', '.worktrees', 'docs', 'spec', 'out']);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/^README\.md$/i.test(name) || /integration-guide\.md$/.test(name)) out.push(path);
    }
  };
  for (const top of ['apps', 'packages', 'services']) walk(join(ROOT, top));
  return out;
}

const SIGNING = /\b(sign(ing|ature|atures)?|seal(ed|ing|s)?|certificates?)\b/i;
const PRODUCTION =
  /\b(production[- ]ready|ready for production|available for production|production use|generally available|fully supported|legally binding)\b/i;
const DENIAL = /\b(not|never|no|until|without|unless|cannot|neither|nor)\b/i;

/** The lines of `text` that claim signing is available for production, with their numbers. */
function productionClaims(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => SIGNING.test(line) && PRODUCTION.test(line) && !DENIAL.test(line))
    .map(({ line, n }) => `${n}: ${line.trim()}`);
}

describe('no production claim without a recorded legal review (FRW-087 criterion 4)', () => {
  it('has a record that says whether a review has taken place', () => {
    expect(read(RECORD)).toMatch(
      /^\*\*Outcome status: (no review has taken place|recorded \(.+\))/m,
    );
  });

  it('finds a claim in a line that makes one, and none in a line that denies it', () => {
    expect(productionClaims('Signing and sealing are ready for production.')).toHaveLength(1);
    expect(productionClaims('The seal is generally available to every tenant.')).toHaveLength(1);
    expect(productionClaims('Sealing is not available for production use.')).toEqual([]);
    expect(productionClaims('The editor is production ready.')).toEqual([]);
  });

  it('reads the files that announce the product', () => {
    const files = announcingFiles().map(shown);
    expect(files).toEqual(expect.arrayContaining(['README.md', 'PRODUCT.md']));
    expect(files.length).toBeGreaterThan(5);
  });

  it('announces no signing, sealing or certificate feature for production while no review is recorded', () => {
    if (!/^\*\*Outcome status: no review has taken place/m.test(read(RECORD))) return;
    const found: string[] = [];
    for (const path of announcingFiles())
      for (const claim of productionClaims(read(path))) found.push(`${shown(path)}:${claim}`);
    expect(found).toEqual([]);
  });
});
