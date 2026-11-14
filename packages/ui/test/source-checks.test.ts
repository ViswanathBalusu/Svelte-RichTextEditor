/**
 * CI checks on the shell's sources (UX-064, criteria 1 and 6): every user-visible string is a
 * string key, and the styles use logical properties only. Each check is also run on a sample that
 * must fail, so a check that finds nothing cannot pass by accident.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { filesUnder, literalStrings, physicalDeclarations, read } from './support/source-checks.ts';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(pkg, 'src');

/** Exceptions to the logical-property rule, each with its reason. None so far. */
const CSS_EXCEPTIONS: readonly string[] = [];

describe('no literal user-visible strings in components (UX-064, criterion 1)', () => {
  const components = filesUnder(src, ['.svelte'], pkg);

  it('finds the components', () => {
    expect(components).toEqual(
      expect.arrayContaining(
        ['src/App.svelte', 'src/components/Toolbar.svelte'].map((p) => join(p)),
      ),
    );
  });

  it.each(components)('%s shows only string keys', (file) => {
    expect(literalStrings(file, read(join(pkg, file)))).toEqual([]);
  });

  it('fails on a literal text node and on literal accessible names', () => {
    const sample = [
      '<script lang="ts">let { t } = $props();</script>',
      '<button aria-label="Close panel">{t("panel.close")}</button>',
      '<p>No headings</p>',
      '<img alt="Avatar" src="x.png" />',
      '<input placeholder={t("x")} title="Search" />',
      '<span>{t("ok")} · </span>',
    ].join('\n');
    const findings = literalStrings('Sample.svelte', sample);
    expect(findings.map((f) => [f.where, f.text])).toEqual([
      ['aria-label attribute', 'Close panel'],
      ['text node', 'No headings'],
      ['alt attribute', 'Avatar'],
      ['title attribute', 'Search'],
    ]);
  });
});

describe('logical properties only (UX-064, criterion 6)', () => {
  const sheets = filesUnder(src, ['.css'], pkg);

  it('finds the stylesheets', () => {
    expect(sheets.length).toBeGreaterThan(0);
  });

  it.each(sheets)('%s uses no physical-direction property', (file) => {
    expect(physicalDeclarations(file, read(join(pkg, file)), CSS_EXCEPTIONS)).toEqual([]);
  });

  it('has no style block in any component (styles live in the adopted sheet, 02 §3)', () => {
    for (const file of filesUnder(src, ['.svelte'], pkg))
      expect(read(join(pkg, file)), file).not.toMatch(/<style[\s>]/);
  });

  it('fails on physical properties and values', () => {
    const css = [
      '.a { margin-left: 1px; }',
      '.b { padding-inline-start: 1px; }',
      '.c { text-align: right; }',
      '.d { left: 0; }',
      '/* right: comments are ignored */',
      '.e { border-top-left-radius: 2px; }',
      '.f { inset-inline-end: 0; }',
      '.g { float: left; }',
    ].join('\n');
    expect(physicalDeclarations('sample.css', css).map((f) => f.line)).toEqual([1, 3, 4, 6, 8]);
  });
});
