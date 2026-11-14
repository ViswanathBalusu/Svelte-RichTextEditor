/**
 * Static parts of FE-020 (02 §3, §10): overlays stay in the shadow root, use the Popover API where
 * the browser has it, and no CSS anchor positioning is used. These are source scans in Node.js.
 * They do not inspect the DOM of a running page, and they do not show that the overlay is in view
 * near a viewport edge: that needs a browser run, and Floating UI is not used by the shell yet.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCANNED = ['packages/ui/src', 'packages/element/src'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', 'test-results']);

/**
 * CSS anchor positioning, which FE-020 forbids in the built CSS. Applied only to CSS text: `.css`
 * files and the `<style>` blocks and `style="..."` attributes of `.svelte` files. A bare `anchor(`
 * would also match a TypeScript method such as `anchor(): CommentAnchor | null;`.
 */
const ANCHOR_CSS = /\banchor-name\s*:|\bposition-anchor\s*:|\bposition-area\s*:|\banchor\(/;

/**
 * Anchor positioning set from script (`style.anchorName`, `setProperty('anchor-name', ...)`) or
 * written into a CSS string. Applied to every source file. The CSS `anchor()` function is only
 * matched with a dashed-ident first argument here, so a method named `anchor()` does not match.
 */
const ANCHOR_SCRIPT =
  /\b(?:anchorName|positionAnchor|positionArea)\b|['"`](?:anchor-name|position-anchor|position-area)['"`]|\banchor-name\s*:|\bposition-anchor\s*:|\bposition-area\s*:|\banchor\(\s*--/;

/** The CSS text of a source file: all of a `.css` file, the style blocks and attributes of a `.svelte` file. */
function cssOf(file: string, text: string): string {
  if (file.endsWith('.css')) return text;
  if (!file.endsWith('.svelte')) return '';
  const blocks = [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? '');
  const attrs = [...text.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(
    (m) => m[1] ?? m[2] ?? '',
  );
  return [...blocks, ...attrs].join('\n');
}

/** True when a source file uses CSS anchor positioning in its CSS or from script. */
function usesAnchorPositioning(file: string, text: string): boolean {
  return ANCHOR_CSS.test(cssOf(file, text)) || ANCHOR_SCRIPT.test(text);
}

/** Code that appends a node to the host page's document rather than to the shadow root. */
const HOST_APPEND =
  /\bdocument\s*\.\s*(?:body|head|documentElement)\s*\??\.\s*(?:append|appendChild|insertBefore|prepend)\b|\bdocument\s*\??\.\s*(?:append|appendChild)\s*\(/;

function* files(dir: string, ext: RegExp): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path, ext);
    else if (ext.test(name)) yield path;
  }
}

/** Shipped sources only: test files measure or inspect the page on purpose and are not overlays. */
function sourcesUnder(rel: string): string[] {
  return [...files(join(ROOT, rel), /\.(ts|svelte|css)$/)].filter((f) => !/\.test\.ts$/.test(f));
}

describe('FE-020 static parts: overlays', () => {
  it('uses no CSS anchor positioning in the shell or the element', () => {
    const hits: string[] = [];
    for (const rel of SCANNED) {
      for (const file of sourcesUnder(rel)) {
        if (usesAnchorPositioning(file, readFileSync(file, 'utf8')))
          hits.push(relative(ROOT, file));
      }
    }
    expect(hits).toEqual([]);
  });

  it('appends no overlay to the host document', () => {
    const hits: string[] = [];
    for (const rel of SCANNED) {
      for (const file of sourcesUnder(rel)) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((text, i) => {
            if (HOST_APPEND.test(text)) hits.push(`${relative(ROOT, file)}:${i + 1}`);
          });
      }
    }
    expect(hits).toEqual([]);
  });

  it('the context menu opens with the Popover API when the browser has it and keeps a fallback', () => {
    const menu = readFileSync(join(ROOT, 'packages/ui/src/components/ContextMenu.svelte'), 'utf8');
    expect(menu).toContain('popover="manual"');
    expect(menu).toContain("typeof popover.showPopover === 'function'");
    const css = readFileSync(join(ROOT, 'packages/ui/src/styles/shell.css'), 'utf8');
    expect(css).toContain('.de-context-menu:not([popover])');
  });

  it('the context menu closes on Escape and gives focus back to the editing surface', () => {
    const menu = readFileSync(join(ROOT, 'packages/ui/src/components/ContextMenu.svelte'), 'utf8');
    expect(menu).toMatch(/event\.key === 'Escape'\) onClose\(true\)/);
  });

  it('the source scans are not vacuous: they read the overlay sources', () => {
    expect(sourcesUnder('packages/ui/src').length).toBeGreaterThan(20);
    expect(HOST_APPEND.test('document.body.appendChild(node);')).toBe(true);
    expect(ANCHOR_CSS.test('.x { anchor-name: --a; }')).toBe(true);
  });

  it('the anchor positioning probe matches CSS anchor use and not a method named anchor()', () => {
    // Caught: CSS in a stylesheet, in a Svelte style block or attribute, and set from script.
    expect(usesAnchorPositioning('a.css', '.x { top: anchor(--a top); }')).toBe(true);
    expect(usesAnchorPositioning('a.css', '.x { top: anchor(top); }')).toBe(true);
    expect(usesAnchorPositioning('A.svelte', '<style>.m { position-area: top; }</style>')).toBe(
      true,
    );
    expect(usesAnchorPositioning('A.svelte', '<div style="top: anchor(bottom)"></div>')).toBe(true);
    expect(usesAnchorPositioning('a.ts', 'el.style.anchorName = "--menu";')).toBe(true);
    expect(usesAnchorPositioning('a.ts', "el.style.setProperty('position-anchor', '--a');")).toBe(
      true,
    );
    expect(usesAnchorPositioning('a.ts', 'const css = `top: anchor(--a top);`;')).toBe(true);
    // Not caught: TypeScript that only names a method or a type after anchors.
    expect(usesAnchorPositioning('a.ts', 'anchor(): CommentAnchor | null;')).toBe(false);
    expect(usesAnchorPositioning('a.ts', 'const a = thread.anchor();')).toBe(false);
    expect(usesAnchorPositioning('A.svelte', '<script>const a = c.anchor();</script>')).toBe(false);
  });
});
