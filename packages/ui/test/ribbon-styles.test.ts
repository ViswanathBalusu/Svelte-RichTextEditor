/**
 * Where the ribbon's rules are (ADR 0490; FE-002): in `shell.css`, which the first load carries,
 * because the component's CSS loads with the editor (02 section 2). Each rule of the toolbar is
 * scoped to `.de-ribbon`, and each rule of the title bar, the canvas and the status bar to the
 * layout's attribute, so the compact and the full layouts keep the look they had.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = resolve(import.meta.dirname, '../src/styles');
const shell = readFileSync(resolve(styles, 'shell.css'), 'utf8');
const marker = 'The toolbar of the ribbon layout';
const toolbarRules = shell.slice(shell.indexOf('*/', shell.indexOf(marker)) + 2);

describe('where the ribbon’s rules are', () => {
  it('has no sheet of its own: the toolbar’s rules are in the sheet the first load carries', () => {
    for (const selector of ['.de-ribbon-group', '.de-ribbon .de-tab', '.de-ribbon .de-tool'])
      expect(shell, selector).toContain(selector);
  });

  it('keeps the title bar, the canvas and the status bar in the sheet as well', () => {
    for (const selector of [
      "[data-toolbar='ribbon'] .de-header",
      "[data-toolbar='ribbon'] .de-workspace",
      "[data-toolbar='ribbon'] .de-status",
    ])
      expect(shell, selector).toContain(selector);
    expect(toolbarRules).not.toContain('data-toolbar');
  });

  it('scopes every rule of the toolbar to the ribbon, so no other layout changes', () => {
    const selectors = [...toolbarRules.matchAll(/^([^\s@/*}][^{]*)\{/gm)].map((m) => m[1]!.trim());
    expect(selectors.length).toBeGreaterThan(10);
    for (const selector of selectors)
      for (const part of selector.split(',')) expect(part.trim(), part).toMatch(/^\.de-ribbon/);
  });
});
