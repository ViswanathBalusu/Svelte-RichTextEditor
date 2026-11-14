// Reflow of the web view (FE-106). These tests read the shipped stylesheet and check the rules that
// let text wrap at 320 CSS pixels without a sideways scroll. They are a regression guard on the CSS
// text, not a layout measurement: FE-106 criteria 1 to 4 need a browser at 320 CSS pixels, which
// this lane did not run, so none of them is ticked from these tests.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const reflow = readFileSync(join(import.meta.dirname, '..', 'src', 'styles', 'reflow.css'), 'utf8');

/** The declaration block of the first rule whose selector list contains `selector`. */
function blockOf(source: string, selector: string): string {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const pattern = new RegExp(`([^{}]*)\\{([^{}]*)\\}`, 'g');
  for (const match of css.matchAll(pattern)) {
    const selectors = (match[1] ?? '').split(',').map((s) => s.trim());
    if (selectors.includes(selector)) return match[2] ?? '';
  }
  throw new Error(`no rule for ${selector}`);
}

describe('reflow of paragraphs (FE-106 criterion 1, rules)', () => {
  it('lets the editing surface shrink to its container and breaks long words', () => {
    const block = blockOf(reflow, '.de-editing-surface');
    expect(block).toContain('max-inline-size: 100%');
    expect(block).toContain('min-inline-size: 0');
    expect(block).toContain('overflow-wrap: anywhere');
  });

  it('sets no fixed inline size or block size on the editing surface', () => {
    const block = blockOf(reflow, '.de-editing-surface');
    expect(block).not.toMatch(/(^|;|\s)(inline-size|block-size|width|height):/);
  });

  it('reaches the sub-editors as well', () => {
    expect(blockOf(reflow, '.de-sub-editor')).toContain('max-inline-size: 100%');
  });
});

describe('only tables and images scroll sideways (FE-106 criterion 2, rules)', () => {
  it('makes a table a block that scrolls in its own box', () => {
    const block = blockOf(reflow, '.de-editing-surface table');
    expect(block).toContain('display: block');
    expect(block).toContain('overflow-x: auto');
    expect(block).toContain('max-inline-size: 100%');
  });

  it('keeps an image inside the surface width', () => {
    const block = blockOf(reflow, '.de-editing-surface img');
    expect(block).toContain('max-inline-size: 100%');
    expect(block).toContain('block-size: auto');
  });

  it('does not let the surface itself scroll sideways', () => {
    expect(blockOf(reflow, '.de-editing-surface')).not.toContain('overflow-x');
  });
});

describe('the shipped sheet carries the reflow rules (FE-106, wiring)', () => {
  // The stylesheet is an inline import, which Node.js does not evaluate here, so this reads the
  // source of the module that concatenates the sheets.
  it('concatenates the reflow sheet after the element sheet and before the shell sheet', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'styles.ts'), 'utf8');
    expect(source).toContain("import reflowCss from './styles/reflow.css?inline';");
    const element = source.indexOf('${elementCss}');
    const reflowAt = source.indexOf('${reflowCss}');
    const shell = source.indexOf('${shellCss}');
    expect(element).toBeGreaterThan(-1);
    expect(reflowAt).toBeGreaterThan(element);
    expect(shell).toBeGreaterThan(reflowAt);
  });
});
