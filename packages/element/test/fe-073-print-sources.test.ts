// FE-073 criterion 2: the component never sends painted pages or its shadow DOM to the printer.
// This is a check of the sources, which is what "when the component is inspected" allows in Node.js:
// every call of `print(` in the code of the element, the engine, the shell and the painter is
// listed, and only three are allowed. The browser run of the failure path
// (e2e/fe-073-print-failure.spec.ts) adds that `window.print` of the host page is never called and
// that no `@media print` or `@page` rule is in the element's sheets.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = fileURLToPath(new URL('../../', import.meta.url));
const ROOTS = ['element', 'engine', 'ui', 'painter'].map((p) => join(PACKAGES, p, 'src'));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

/** The lines of code (not comments) that call a function named `print`, with their file. */
function printCalls(): string[] {
  const out: string[] = [];
  for (const root of ROOTS)
    for (const file of sources(root)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line) => {
        const code = line.trim();
        if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
        if (/(^|[^A-Za-z0-9_$])print\s*\(/.test(code))
          out.push(`${relative(PACKAGES, file).replaceAll('\\', '/')}: ${code}`);
      });
    }
  return out;
}

describe('what can reach the printer (FE-073 criterion 2)', () => {
  it('lists only the method that prints the typeset PDF, the command that calls it, and the PDF frame', () => {
    expect(printCalls().sort()).toEqual(
      [
        'element/src/doc-editor.ts: this.print().catch((error: unknown) =>',
        'element/src/doc-editor.ts: async print(): Promise<PrintOutcome> {',
        'element/src/print-frame.ts: win.print();',
        'element/src/print-frame.ts: win.print();',
        'ui/src/commands/builtin.ts: run: () => (host.print ? host.print() : false),',
      ].sort(),
    );
  });

  it('prints from the window of the frame that holds the PDF, never from the page or a shadow root', () => {
    const frame = readFileSync(join(PACKAGES, 'element/src/print-frame.ts'), 'utf8');
    expect(frame).toMatch(/const win = frame\.contentWindow;/);
    // The print-only frame is an empty document of the page's origin, filled with canvases.
    expect(frame).toMatch(/frame\.src = blobUrl;/);
    expect(frame).not.toMatch(/window\.print|globalThis\.print|document\.defaultView/);
    // The frame holds the PDF's URL and nothing of the editor's DOM.
    expect(frame).toMatch(/frame\.src = url|frame\.setAttribute\('src', url\)/);
    expect(frame).not.toMatch(/srcdoc|innerHTML|cloneNode|importNode/);
  });
});
