// The workspace lint rules for the editor's own source (eslint.config.js and
// packages/element/eslint.config.js), each shown to fail on a planted violation and to pass where
// the exception is:
// - FE-022 criterion 3: `dispatchEvent` only in the one helper of each package, Svelte files too;
// - FE-108 criterion 2: no id or selector lookup on the document in the shell, the element or the
//   editing core, except in tests and in the PDF viewer (its own page).
import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '..');

/** The rule messages for `code` as if it were the file `file` (a path from the repository root). */
async function lint(file: string, code: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: repo });
  const [result] = await eslint.lintText(code, { filePath: resolve(repo, file) });
  return (result?.messages ?? []).map((m) => `${m.ruleId}: ${m.message}`);
}

const restricted = (messages: string[], story: string): string[] =>
  messages.filter((m) => m.startsWith('no-restricted-syntax') && m.includes(story));

const DISPATCH =
  "export function f(t: EventTarget): void {\n  t.dispatchEvent(new Event('x'));\n}\n";
const OPTIONAL_DISPATCH =
  "export function f(t?: EventTarget): void {\n  t?.dispatchEvent(new Event('x'));\n}\n";
const LOOKUPS = [
  'export function f(): unknown[] {',
  '  return [',
  "    document.getElementById('a'),",
  "    document.getElementsByClassName('a'),",
  "    document.getElementsByName('a'),",
  "    document.getElementsByTagName('a'),",
  "    document.querySelector('.a'),",
  "    document.querySelectorAll('.a'),",
  "    globalThis.document.querySelector('.a'),",
  "    window.document.getElementById('a'),",
  '  ];',
  '}',
  '',
].join('\n');
const ROOT_LOOKUP =
  "export function f(root: ShadowRoot, el: Element): unknown[] {\n  return [root.getElementById('a'), root.querySelector('.a'), el.querySelectorAll('.a'), document.body, document.activeElement];\n}\n";
const SVELTE = [
  '<script lang="ts">',
  '  let el: HTMLElement | undefined = $state();',
  '  function go(): void {',
  "    el?.dispatchEvent(new Event('x'));",
  "    document.getElementById('a');",
  '  }',
  '</script>',
  '',
  '<button bind:this={el} onclick={go}>x</button>',
  '',
].join('\n');

describe('FE-022 criterion 3: a lint rule fails any dispatchEvent outside the one helper', () => {
  it('fails in the shell, in TypeScript and in a Svelte component', async () => {
    expect(restricted(await lint('packages/ui/src/sample.ts', DISPATCH), 'FE-022')).toHaveLength(1);
    expect(
      restricted(await lint('packages/ui/src/sample.ts', OPTIONAL_DISPATCH), 'FE-022'),
    ).toHaveLength(1);
    expect(
      restricted(await lint('packages/ui/src/panes/Sample.svelte', SVELTE), 'FE-022'),
    ).toHaveLength(1);
  });

  it('fails in the element, in TypeScript, in a Svelte component and in the PDF viewer', async () => {
    expect(
      restricted(await lint('packages/element/src/sample.ts', DISPATCH), 'FE-022'),
    ).toHaveLength(1);
    expect(
      restricted(await lint('packages/element/src/Sample.svelte', SVELTE), 'FE-022'),
    ).toHaveLength(1);
    expect(
      restricted(await lint('packages/element/src/pdf/viewer/sample.ts', DISPATCH), 'FE-022'),
    ).toHaveLength(1);
  });

  it('passes in the one helper of each package', async () => {
    expect(restricted(await lint('packages/ui/src/de-event.ts', DISPATCH), 'FE-022')).toEqual([]);
    expect(restricted(await lint('packages/element/src/events.ts', DISPATCH), 'FE-022')).toEqual(
      [],
    );
  });
});

describe('FE-108 criterion 2: a lint rule fails an id or selector lookup on the document', () => {
  it.each([
    'packages/ui/src/sample.ts',
    'packages/ui/src/de-event.ts',
    'packages/element/src/sample.ts',
    'packages/element/src/events.ts',
    'packages/engine/src/view/sample.ts',
  ])('fails every form of the lookup in %s', async (file) => {
    expect(restricted(await lint(file, LOOKUPS), 'FE-108')).toHaveLength(8);
  });

  it('fails in a Svelte component of the shell and of the element', async () => {
    expect(
      restricted(await lint('packages/ui/src/panes/Sample.svelte', SVELTE), 'FE-108'),
    ).toHaveLength(1);
    expect(
      restricted(await lint('packages/element/src/Sample.svelte', SVELTE), 'FE-108'),
    ).toHaveLength(1);
  });

  it('passes a lookup from the root or an element, and reads of body and activeElement', async () => {
    for (const file of [
      'packages/ui/src/sample.ts',
      'packages/element/src/sample.ts',
      'packages/engine/src/sample.ts',
    ])
      expect(restricted(await lint(file, ROOT_LOOKUP), 'FE-108')).toEqual([]);
  });

  it('passes in tests and in the PDF viewer, which is its own page', async () => {
    for (const file of [
      'packages/ui/src/sample.test.ts',
      'packages/element/src/sample.universal.test.ts',
      'packages/engine/src/view/sample.universal.test.ts',
      'packages/element/src/pdf/viewer/main.ts',
    ])
      expect(restricted(await lint(file, LOOKUPS), 'FE-108')).toEqual([]);
  });
});
