// FE-017: the integration guide's policy and side-effect section (docs/policies-and-side-effects.md)
// must name what the code creates and what the S2 browser run required. These are presence checks
// that catch drift in names: they cannot check behaviour, which the browser matrix of FE-125 does.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POLICY_NAMES } from '../src/trusted-types.ts';
import { FONT_ALIAS_PREFIX } from '../src/font-registration.ts';

const ELEMENT = resolve(import.meta.dirname, '..');
const GUIDE_PATH = resolve(ELEMENT, 'docs/policies-and-side-effects.md');
const S2_FEATURES = resolve(ELEMENT, 'e2e/s2-features.spec.ts');
const MATH = resolve(ELEMENT, 'src/features/math.ts');

const guide = readFileSync(GUIDE_PATH, 'utf8');
const s2 = readFileSync(S2_FEATURES, 'utf8');
const mathSource = readFileSync(MATH, 'utf8');
const sessionSource = readFileSync(resolve(ELEMENT, 'src/session.ts'), 'utf8');
// The editing library is a dependency of @docedit/engine, which pins its version.
const PROSEMIRROR_VIEW = resolve(ELEMENT, '../engine/node_modules/prosemirror-view');
const prosemirrorView = JSON.parse(
  readFileSync(resolve(PROSEMIRROR_VIEW, 'package.json'), 'utf8'),
) as { version: string };
const prosemirrorSource = readFileSync(resolve(PROSEMIRROR_VIEW, 'dist/index.js'), 'utf8');

/** The directives the S2 run required per feature (the GUIDE table of s2-features.spec.ts). */
function requiredByFeature(spec: string): { trustedTypes: string[]; styleSrcAttr: string[] } {
  return {
    trustedTypes: [...spec.matchAll(/'trusted-types':\s*'([^']+)'/g)].map((m) => m[1] ?? ''),
    styleSrcAttr: [...spec.matchAll(/'style-src-attr':\s*"([^"]+)"/g)].map((m) => m[1] ?? ''),
  };
}

/** The text of one `## ` section of the guide, from its heading up to the next `## `. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l === `## ${heading}`);
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((l) => l.startsWith('## '));
  return (next < 0 ? rest : rest.slice(0, next)).join('\n');
}

describe('the integration guide policy section (FE-017)', () => {
  it('has a section for each feature a host may look up', () => {
    for (const heading of [
      'Core (every host)',
      'Paste',
      'Panes (outline, footnote and header panels)',
      'PDF viewer',
      'Math display (KaTeX)',
      'Math editor (MathLive)',
      'Fonts',
      'Global side effects visible to the host page',
    ]) {
      expect(guide, `missing section "${heading}"`).toContain(`## ${heading}`);
    }
  });

  it('names every Trusted Types policy the component creates and the paste policy', () => {
    for (const name of [POLICY_NAMES.worker, POLICY_NAMES.mathEditor, 'ProseMirrorClipboard']) {
      expect(guide).toContain(`\`${name}\``);
    }
  });

  it('states every trusted-types name and style-src-attr value the S2 run required', () => {
    const required = requiredByFeature(s2);
    expect(required.trustedTypes.length).toBeGreaterThan(0);
    for (const name of required.trustedTypes) expect(guide).toContain(name);
    for (const value of required.styleSrcAttr) expect(guide).toContain(`style-src-attr ${value}`);
  });

  it('lists the global custom element names the math feature registers and the editor defines', () => {
    for (const tag of ['doc-editor', 'math-field', 'math-span', 'math-div']) {
      expect(guide).toContain(`\`${tag}\``);
    }
    // The math feature's own check of the tags must match the guide's list.
    for (const tag of ['math-field', 'math-span', 'math-div']) {
      expect(mathSource).toContain(`'${tag}'`);
    }
  });

  it('lists the KaTeX font families added to the document and the Firefox selection patch', () => {
    expect(guide).toContain('`KaTeX_*`');
    expect(guide).toContain('ShadowRoot.prototype.getSelection');
    expect(guide).toContain("selectionShim: 'library'");
  });

  it('names the font aliases the session adds to document.fonts, with the prefix the code uses', () => {
    const fonts = section(guide, 'Fonts');
    const effects = section(guide, 'Global side effects visible to the host page');
    expect(fonts).toContain(`\`${FONT_ALIAS_PREFIX}\``);
    expect(effects).toContain(FONT_ALIAS_PREFIX);
    expect(fonts).toContain('registerManifestFonts');
    expect(fonts).not.toMatch(/no caller/i);
    // The guide's claim that the session registers the fonts must match the session's source.
    expect(sessionSource).toMatch(/registerFonts \?\? registerManifestFonts/);
  });

  it("names ProseMirror's selectionchange listener on the page document", () => {
    const effects = section(guide, 'Global side effects visible to the host page');
    expect(effects).toContain('`selectionchange`');
    expect(effects).not.toMatch(/adds no rule to the host's\s+stylesheets and no listener/);
    // The listener the guide names must be the one the pinned prosemirror-view adds.
    expect(effects).toContain(`prosemirror-view ${prosemirrorView.version}`);
    expect(prosemirrorSource).toMatch(/ownerDocument\.addEventListener\("selectionchange"/);
  });

  it('names the element own document listeners and the journal database (FE-017 criterion 5)', () => {
    // Each listener and database the element's source adds must be named in the guide, so that
    // the host sees every global change; the check reads the source, not a copy of it.
    const effects = section(guide, 'Global side effects visible to the host page');
    const docEditorSource = readFileSync(resolve(ELEMENT, 'src/doc-editor.ts'), 'utf8');
    const journalSource = readFileSync(resolve(ELEMENT, 'src/journal-idb.ts'), 'utf8');
    expect(docEditorSource).toMatch(/document\.addEventListener\('pointerdown'/);
    expect(sessionSource).toMatch(/document\.addEventListener\('visibilitychange'/);
    expect(journalSource).toMatch(/JOURNAL_DB_NAME = 'docedit-journal'/);
    expect(effects).toContain('`pointerdown`');
    expect(effects).toContain('`visibilitychange`');
    expect(effects).toContain('`docedit-journal`');
    expect(effects).not.toMatch(/adds no listener to `document` or `window`/);
  });

  it('names the listeners on the window, the visual viewport and the font set, and what a suspension keeps (FE-005)', () => {
    const effects = section(guide, 'Global side effects visible to the host page');
    const read = (path: string) => readFileSync(resolve(ELEMENT, path), 'utf8');
    // Each listener the guide names is one the source adds; the check reads the source.
    expect(read('../engine/src/view/web.ts')).toMatch(
      /win\?\.addEventListener\('resize', redraw\)/,
    );
    expect(read('src/keyboard-inset.ts')).toMatch(/visual\.addEventListener\('resize', update\)/);
    expect(read('src/page-view/page-view.ts')).toMatch(
      /fonts\?\.addEventListener\?\.\('loadingdone', onFonts\)/,
    );
    expect(effects).toContain("A `resize` listener on the page's `window`");
    expect(effects).toContain('`window.visualViewport`');
    expect(effects).toContain("A `loadingdone` listener on the page's font set (`document.fonts`)");
    // What stays on `document` while the element is suspended is said, with the decision.
    expect(effects).toMatch(/Kept until the editor is destroyed:/);
    expect(effects).toMatch(/delegated-event handlers of the UI framework/);
    expect(effects).toContain('owner decision 181');
    // The editor code keeps no other listener on `document` or `window` than the ones named: every
    // `addEventListener` on them in the element, the shell and the core is one of these.
    const sources = [
      ['src/doc-editor.ts', read('src/doc-editor.ts')],
      ['src/session.ts', sessionSource],
      ['../engine/src/view/web.ts', read('../engine/src/view/web.ts')],
    ] as const;
    const onPage = /\b(document|window|win\??)\.addEventListener\(\s*'([a-z]+)'/g;
    const found = sources.flatMap(([, text]) => [...text.matchAll(onPage)].map((m) => m[2]));
    expect(found.sort()).toEqual(['pointerdown', 'resize', 'visibilitychange']);
  });

  it('lets a host see which directives it may omit, per feature', () => {
    expect(section(guide, 'Paste')).toMatch(/Omit:/);
    expect(section(guide, 'Math editor (MathLive)')).toMatch(/Omit:/);
    expect(section(guide, 'Math display (KaTeX)')).toMatch(/Omit:/);
    expect(section(guide, 'Core (every host)')).toMatch(/Omit:/);
  });

  it('states that the math editor needs inline style attributes and what happens without them', () => {
    const math = section(guide, 'Math editor (MathLive)');
    expect(math).toContain("style-src-attr 'unsafe-inline'");
    expect(math).toMatch(/cannot use the math editor/);
  });
});
