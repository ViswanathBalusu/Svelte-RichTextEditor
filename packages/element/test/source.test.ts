// Checks of the build configuration and the source that the stories ask for as CI checks:
// Svelte with `fragments: "tree"` and 5.33 or later (FE-016), no HTML-string sinks (FE-016), no
// Svelte custom-element wrapper (FE-001; ADR 0002), and no delegated handler for the events whose
// order matters around the editing surface (FE-025).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPONENT_COMPILER_OPTIONS, demoConfig, libraryConfig } from '../scripts/vite-configs.ts';
import { ORDER_SENSITIVE_EVENTS } from '../src/shortcuts.ts';

const packages = resolve(import.meta.dirname, '../..');

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === 'node_modules' || name === 'dist' || name === 'generated') return [];
    return statSync(full).isDirectory() ? files(full, ext) : ext.test(name) ? [full] : [];
  });
}

/**
 * The code of the bundle: the element, the shell and the editing core. Test instrumentation
 * (`testing.ts`, the spike harness, which drives ProseMirror's paste parser on purpose) is not
 * part of the published module and is left out.
 */
const BUNDLE = ['element/src', 'ui/src', 'engine/src'].flatMap((d) =>
  files(join(packages, d), /\.(ts|svelte)$/).filter(
    (f) => !/\.test\.ts$/.test(f) && !/[\\/]testing\.ts$/.test(f),
  ),
);

function svelteOptions(config: ReturnType<typeof libraryConfig>): unknown[] {
  return (
    config.plugins as Array<{ name?: string; api?: { options?: { compilerOptions?: unknown } } }>
  )
    .flat()
    .filter((p) => p?.name === 'vite-plugin-svelte' || p?.name?.startsWith('vite-plugin-svelte'))
    .map((p) => p.api?.options?.compilerOptions)
    .filter(Boolean);
}

describe('FE-016: Svelte builds DOM without HTML strings', () => {
  it('compiles every component build with fragments: "tree", Svelte 5.33 or later', () => {
    expect(COMPONENT_COMPILER_OPTIONS).toEqual({ fragments: 'tree', css: 'external' });
    for (const config of [libraryConfig(), demoConfig('tree', true)])
      for (const options of svelteOptions(config))
        expect(options).toMatchObject({ fragments: 'tree', css: 'external' });
    const installed = JSON.parse(
      readFileSync(join(packages, 'element/node_modules/svelte/package.json'), 'utf8'),
    ) as { version: string };
    const [major, minor] = installed.version.split('.').map(Number);
    expect(major === 5 && minor! >= 33).toBe(true);
  });

  it('has no {@html}, innerHTML, outerHTML or insertAdjacentHTML in the element, the shell or the core', () => {
    const sinks =
      /\{@html|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|\.srcdoc\b|createContextualFragment/;
    const hits = BUNDLE.filter((f) => sinks.test(readFileSync(f, 'utf8'))).map((f) =>
      relative(packages, f),
    );
    expect(hits).toEqual([]);
  });

  it("never calls ProseMirror's own HTML paste, and takes paste and drop on both views", () => {
    // ProseMirror reads an HTML string under its own policy name. The bundle reads HTML only in
    // paste-policy.ts, under the project's policy (criterion 5; e2e/fe-016-paste-policy.spec.ts).
    const callers = BUNDLE.filter((f) => /\.pasteHTML\s*\(/.test(readFileSync(f, 'utf8'))).map(
      (f) => relative(packages, f),
    );
    expect(callers).toEqual([]);
    const parsers = BUNDLE.filter((f) => /parseFromString\s*\(/.test(readFileSync(f, 'utf8'))).map(
      (f) => relative(packages, f).replaceAll('\\', '/'),
    );
    // clipboard-html.ts keeps `fragmentFromHtmlString`, a plain parse for the tests of the whitelist.
    // Nothing in the bundle may call it.
    expect(parsers).toEqual(['engine/src/clipboard-html.ts', 'engine/src/view/paste-policy.ts']);
    const plain = BUNDLE.filter(
      (f) =>
        !f.endsWith('clipboard-html.ts') &&
        /\bfragmentFromHtmlString\b/.test(readFileSync(f, 'utf8')),
    ).map((f) => relative(packages, f));
    expect(plain).toEqual([]);
    const web = readFileSync(join(packages, 'engine/src/view/web.ts'), 'utf8');
    expect(web.match(/^\s+paste: \(view, event\) => \{/gm)).toHaveLength(2);
    expect(web.match(/^\s+drop: \(view, event\) =>/gm)).toHaveLength(2);
  });
});

describe('FE-001: one hand-written element', () => {
  it('no component is compiled as a Svelte custom element', () => {
    const svelte = BUNDLE.filter((f) => f.endsWith('.svelte'));
    expect(svelte.length).toBeGreaterThan(0);
    for (const f of svelte)
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/<svelte:options[^>]*customElement/);
    for (const config of [libraryConfig(), demoConfig('tree', true)])
      for (const options of svelteOptions(config))
        expect((options as { customElement?: boolean }).customElement).toBeUndefined();
    const source = readFileSync(join(packages, 'element/src/doc-editor.ts'), 'utf8');
    expect(source).toMatch(/class DocEditorElement extends Base/);
    expect(source).toMatch(/'HTMLElement' in globalThis\s*\?\s*globalThis\.HTMLElement/);
  });
});

describe('FE-025: order-sensitive handlers', () => {
  it('the shell puts no delegated handler for them on the editing surface or its ancestors', () => {
    // App.svelte renders the shell root, the workspace, the page and the body host: every ancestor
    // of the editing surface inside the shadow root. Only that opening-tag span is checked. The side
    // pane, the panel and the dialogs are siblings of the editing surface, not ancestors, so their
    // handlers (for example the pane's Escape handler) are outside this rule.
    const app = readFileSync(join(packages, 'ui/src/App.svelte'), 'utf8');
    const start = app.indexOf('<div\n  bind:this={shellEl}');
    const bodyHost = app.indexOf('class="de-body-host"');
    const closing = app.indexOf('></div>', bodyHost);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(bodyHost).toBeGreaterThan(start);
    expect(closing).toBeGreaterThan(bodyHost);
    const ancestry = app.slice(start, closing + '></div>'.length);
    expect(ancestry).toMatch(/class="de-page"/);
    for (const event of ORDER_SENSITIVE_EVENTS)
      expect(ancestry, event).not.toMatch(new RegExp(`\\bon${event}=`));
  });

  it('the element attaches its own with `on` from svelte/events, never addEventListener', () => {
    const element = files(join(packages, 'element/src'), /\.ts$/).filter(
      (f) => !f.includes(`${join('src', 'pdf', 'viewer')}`) && !/\.test\.ts$/.test(f),
    );
    const listen = new RegExp(
      `addEventListener\\(\\s*['"](${ORDER_SENSITIVE_EVENTS.join('|')})['"]`,
    );
    expect(
      element.filter((f) => listen.test(readFileSync(f, 'utf8'))).map((f) => relative(packages, f)),
    ).toEqual([]);
    expect(readFileSync(join(packages, 'element/src/shortcuts.ts'), 'utf8')).toMatch(
      /import \{ on \} from 'svelte\/events'/,
    );
  });
});
