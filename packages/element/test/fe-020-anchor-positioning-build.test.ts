/**
 * FE-020 criterion 3, the CSS half: the build fails when the built CSS uses CSS anchor positioning
 * (`anchor-name`, `position-anchor`, `position-area`, `position-try`, `anchor()`, `anchor-size()`),
 * because overlays are positioned in script. `anchorPositioningViolations` (scripts/bundle-report.ts)
 * reads the bundler's output; `structureOf` adds its findings to the shape violations that fail
 * `node scripts/build.ts`. The chunks here are synthetic; the check also ran on the real build (see
 * the story's Evidence).
 */
import { describe, expect, it } from 'vitest';
import {
  anchorPositioningViolations,
  structureOf,
  type ChunkInfo,
} from '../scripts/bundle-report.ts';

const chunk = (fileName: string, code: string, ids: string[] = []): ChunkInfo => ({
  fileName,
  isEntry: false,
  isDynamicEntry: false,
  imports: [],
  dynamicImports: [],
  moduleIds: ids,
  code,
});

describe('the built CSS uses no CSS anchor positioning (FE-020 criterion 3)', () => {
  it('accepts CSS and script that position by coordinates', () => {
    const code =
      'export default ".de-context-menu{position:fixed;inset-inline-start:0;top:0}.x{position:absolute}"' +
      ';function anchor(a){return a}anchor(node);const o={anchor:1};';
    expect(anchorPositioningViolations([chunk('a.js', code)])).toEqual([]);
  });

  it('finds each property that anchors an element', () => {
    for (const css of [
      '.a{anchor-name:--menu}',
      '.a{position-anchor:--menu}',
      '.a{position-area:bottom span-right}',
      '.a{position-try-fallbacks:flip-block}',
      '.a{position-try:flip-block}',
      '.a{anchor-scope:all}',
      '@position-try --f{top:0}',
      '.a{top:anchor(bottom)}',
      '.a{left:anchor(--menu left)}',
      '.a{width:anchor-size(width)}',
      '.a{ top : anchor( --m , bottom ) }',
    ])
      expect(
        anchorPositioningViolations([
          chunk('chunks/styles-a.js', `export default ${JSON.stringify(css)};`),
        ]),
        css,
      ).toHaveLength(1);
  });

  it('names the file and what it uses', () => {
    const [v] = anchorPositioningViolations([
      chunk('doc-editor.js', ''),
      chunk('chunks/styles-a.js', 'x=".a{anchor-name:--m;top:anchor(bottom)}"'),
    ]);
    expect(v).toContain('chunks/styles-a.js');
    expect(v).toContain('anchor-name');
    expect(v).toContain('anchor()');
  });

  it('reads a stylesheet file of the build too', () => {
    expect(
      anchorPositioningViolations(
        [],
        [{ fileName: 'assets/a.css', source: '.a{position-anchor:--m}' }],
      ),
    ).toHaveLength(1);
    expect(
      anchorPositioningViolations(
        [],
        [{ fileName: 'assets/a.css', source: new TextEncoder().encode('.a{anchor-name:--m}') }],
      ),
    ).toHaveLength(1);
  });

  it('is one of the violations that fail the build', () => {
    const entry = { ...chunk('doc-editor.js', ''), isEntry: true };
    const styles = chunk('chunks/styles-a.js', 'x=".a{anchor-name:--m}"');
    const s = structureOf([entry, styles], new Set(['doc-editor.js']), []);
    expect(s.violations.some((v) => v.startsWith('overlays: chunks/styles-a.js'))).toBe(true);
  });
});
