// FE-073, criterion 3: the component adds no print rule. A host's print job is its own; any
// `@media print` or `@page` rule the element shipped would change it. The check reads every source
// file under src/ (stylesheets and the TypeScript that builds styles) and fails on either rule.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(css|ts|html)$/.test(name) ? [path] : [];
  });
}

describe('print rules (FE-073, criterion 3)', () => {
  const files = sourceFiles(SRC);

  it('reads the element sources', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith('element.css'))).toBe(true);
  });

  it('contains no @media print rule and no @page rule', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (/@media\s+[^{]*\bprint\b/i.test(text) || /@page\b/.test(text))
        offenders.push(relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });
});
