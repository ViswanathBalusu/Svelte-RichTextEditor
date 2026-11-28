/**
 * The ribbon's own style sheet (ADR 0490): its toolbar rules are not in `shell.css`, which the first
 * load carries whole, so the ribbon adopts them into its root when it loads. The adoption is a
 * constructable sheet shared by every root, a `<style>` with the nonce of the element's own where the
 * browser or the policy refuses that, and nothing without a nonce. Run in Node.js with stand-ins for
 * the browser's classes; the browser run is `e2e/ribbon.spec.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeSheet {
  text = '';
  replaceSync(text: string): void {
    this.text = text;
  }
}

interface FakeRoot {
  adoptedStyleSheets: unknown[];
  children: Array<{ nonce: string; textContent: string }>;
  marker: { nonce: string } | null;
  querySelector: (selector: string) => { nonce: string } | null;
  appendChild: (child: { nonce: string; textContent: string }) => void;
}

function root(marker: { nonce: string } | null = null): FakeRoot {
  const children: FakeRoot['children'] = [];
  return {
    adoptedStyleSheets: [],
    children,
    marker,
    querySelector: () => marker,
    appendChild: (child) => void children.push(child),
  };
}

/** A `CSSStyleSheet` that cannot be constructed, as in a browser or under a policy that refuses it. */
function refusing(): never {
  throw new TypeError('not constructable');
}

async function load() {
  vi.resetModules();
  return import('../src/shell/ribbon-styles.ts');
}

describe('adopting the ribbon’s rules', () => {
  beforeEach(() => {
    vi.stubGlobal('CSSStyleSheet', FakeSheet);
    vi.stubGlobal('document', {
      createElement: () => ({ nonce: '', textContent: '' }),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('adds one constructable sheet to a root, once, and shares it between roots', async () => {
    const { adoptRibbonStyles } = await load();
    const a = root();
    const b = root();
    expect(adoptRibbonStyles(a as never, '.de-ribbon{}')).toBe(true);
    expect(adoptRibbonStyles(a as never, '.de-ribbon{}')).toBe(true);
    expect(a.adoptedStyleSheets).toHaveLength(1);
    expect((a.adoptedStyleSheets[0] as FakeSheet).text).toBe('.de-ribbon{}');
    adoptRibbonStyles(b as never, '.de-ribbon{}');
    expect(b.adoptedStyleSheets[0]).toBe(a.adoptedStyleSheets[0]);
  });

  it('keeps the sheets the root already has', async () => {
    const { adoptRibbonStyles } = await load();
    const own = new FakeSheet();
    const a = root();
    a.adoptedStyleSheets = [own];
    adoptRibbonStyles(a as never, 'x{}');
    expect(a.adoptedStyleSheets[0]).toBe(own);
    expect(a.adoptedStyleSheets).toHaveLength(2);
  });

  it('falls back to a style element with the element’s nonce when sheets cannot be constructed', async () => {
    vi.stubGlobal('CSSStyleSheet', refusing);
    const { adoptRibbonStyles } = await load();
    const a = root({ nonce: 'abc' });
    expect(adoptRibbonStyles(a as never, 'x{}')).toBe(true);
    expect(a.children).toEqual([{ nonce: 'abc', textContent: 'x{}' }]);
  });

  it('adds nothing, and says so, where sheets cannot be constructed and there is no nonce', async () => {
    vi.stubGlobal('CSSStyleSheet', refusing);
    const { adoptRibbonStyles } = await load();
    const a = root();
    expect(adoptRibbonStyles(a as never, 'x{}')).toBe(false);
    expect(a.children).toEqual([]);
  });
});

describe('where the ribbon’s rules are (FND-008)', () => {
  const styles = resolve(import.meta.dirname, '../src/styles');
  const shell = readFileSync(resolve(styles, 'shell.css'), 'utf8');
  const ribbon = readFileSync(resolve(styles, 'ribbon.css'), 'utf8');

  it('keeps the toolbar’s rules out of the sheet the first load carries', () => {
    for (const selector of ['.de-ribbon-group', '.de-ribbon .de-tab', '.de-ribbon .de-tool'])
      expect(shell, selector).not.toContain(selector);
    for (const selector of ['.de-ribbon-group', '.de-ribbon .de-tab', '.de-ribbon .de-tool'])
      expect(ribbon, selector).toContain(selector);
  });

  it('keeps the title bar, the canvas and the status bar in the first sheet, which are drawn at once', () => {
    for (const selector of [
      "[data-toolbar='ribbon'] .de-header",
      "[data-toolbar='ribbon'] .de-workspace",
      "[data-toolbar='ribbon'] .de-status",
    ])
      expect(shell, selector).toContain(selector);
    expect(ribbon).not.toContain('data-toolbar');
  });

  it('scopes every rule of the ribbon sheet to the ribbon, so no other layout changes', () => {
    const selectors = [...ribbon.matchAll(/^([^\s@/*}][^{]*)\{/gm)].map((m) => m[1]!.trim());
    expect(selectors.length).toBeGreaterThan(10);
    for (const selector of selectors)
      for (const part of selector.split(',')) expect(part.trim(), part).toMatch(/^\.de-ribbon/);
  });
});
