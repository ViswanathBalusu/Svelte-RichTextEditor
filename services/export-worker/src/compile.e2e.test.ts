/**
 * End to end in the sandbox (spike S4, SPK-017): a generated bundle compiled with the
 * tagging-first class gives a PDF that veraPDF accepts as PDF/UA-2 and PDF/A-4f, and a valid
 * layout.json with block-level page starts. Needs Podman and the worker image; skips otherwise.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CdmEnvelope } from '@docedit/model';
import { describe, expect, it, vi } from 'vitest';
import { podman } from './container.ts';
import { runExport } from './pipeline.ts';
import { IMAGE } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';
import { validatePdf } from './verapdf.ts';
import type { FontManifest } from '@docedit/export-latex';

vi.setConfig({ testTimeout: 300_000 });

const ready = await sandboxReady();

async function imageFonts(): Promise<FontManifest> {
  const r = await podman(
    [
      'run',
      '--rm',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--entrypoint=cat',
      IMAGE,
      '/opt/docedit/fonts/fonts.json',
    ],
    {
      // 180 s: on a loaded Podman machine a `podman run` took 80 to 100 s (sandbox-ready.ts).
      timeoutMs: 180_000,
      maxStdoutBytes: 1024 * 1024,
    },
  );
  return JSON.parse(new TextDecoder().decode(r.stdout)) as FontManifest;
}

const load = (url: string): CdmEnvelope =>
  JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as CdmEnvelope;

describe.skipIf(!ready.ok)(`compile in the sandbox (${ready.reason})`, () => {
  it('turns the 03 §12 example into a tagged PDF that validates, with layout.json', async () => {
    const env = load(import.meta.resolve('@docedit/model/fixtures/example-03-12.json'));
    const fonts = await imageFonts();
    const r = await runExport(
      env,
      fonts,
      { tagging: 'on', pdfStandard: 'ua-2+a-4f', layout: 'line', title: 'Example' },
      { kind: 'sandbox' },
    );
    expect(r.compile.ok, r.compile.stderr).toBe(true);
    expect(r.compile.converged).toBe(true);
    expect(r.layoutErrors).toEqual([]);
    expect(r.layout?.pages).toHaveLength(1);
    expect(r.layout?.pages[0]?.starts?.blockId).toBe('p3Jq8sLw0aZx1VbN');
    // Every block, including the empty paragraph and the one inside the region, has a page start.
    expect(Object.keys(r.layout?.blocks ?? {}).sort()).toEqual(
      ['p3Jq8sLw0aZx1VbN', 'pA1b2C3d4E5f6G7h', 'pZ9y8X7w6V5u4T3s'].sort(),
    );
    for (const flavour of ['ua2', '4f'] as const) {
      const v = await validatePdf(r.compile.pdf!, flavour);
      expect(v.error).toBeUndefined();
      expect(v.compliant, JSON.stringify(v.failures.slice(0, 5))).toBe(true);
    }
  });

  it('compiles the one-page measurement document with tagging off and draft too', async () => {
    const env = load(new URL('../fixtures/s4-corpus/s4-01p.cdm.json', import.meta.url).href);
    const fonts = await imageFonts();
    for (const tagging of ['off', 'draft', 'none'] as const) {
      const r = await runExport(
        env,
        fonts,
        { tagging, pdfStandard: 'none', layout: 'block' },
        { kind: 'sandbox' },
      );
      expect(r.compile.ok, `${tagging}: ${r.compile.log.slice(-2000)}`).toBe(true);
      expect(r.layout?.granularity).toBe('block');
    }
  });

  it('tags headings at all nine outline levels (03 §4.1) and validates', async () => {
    // Levels 6 to 9 are the class's own sectioning commands; the tagging code needed structure
    // names for them, without which the compile failed.
    const styles = Array.from({ length: 9 }, (_, i) => ({
      type: 'style_def',
      attrs: {
        id: `Heading${i + 1}`,
        kind: 'paragraph',
        name: `Heading ${i + 1}`,
        builtIn: true,
        basedOn: 'Normal',
        outlineLevel: i + 1,
        bold: true,
      },
    }));
    const body = Array.from({ length: 9 }, (_, i) => [
      {
        type: 'paragraph',
        attrs: { id: `heading${i + 1}aaaaaaaaa`.slice(0, 16), style: `Heading${i + 1}` },
        content: [{ type: 'text', text: `Level ${i + 1}` }],
      },
      {
        type: 'paragraph',
        attrs: { id: `text${i + 1}aaaaaaaaaaaa`.slice(0, 16), style: 'Normal' },
        content: [{ type: 'text', text: `Text under level ${i + 1}.` }],
      },
    ]).flat();
    const env = {
      cdm: 1,
      requires: [],
      doc: {
        type: 'doc',
        content: [
          {
            type: 'defs',
            content: [
              { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
              {
                type: 'style_def',
                attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
              },
              ...styles,
              { type: 'page_setup', attrs: { id: 'ps1' } },
            ],
          },
          { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
        ],
      },
    } as unknown as CdmEnvelope;
    const r = await runExport(
      env,
      await imageFonts(),
      { tagging: 'on', pdfStandard: 'ua-2+a-4f', layout: 'block' },
      { kind: 'sandbox' },
    );
    expect(r.compile.ok, r.compile.log.slice(-2000)).toBe(true);
    expect(Object.keys(r.layout?.blocks ?? {})).toHaveLength(18);
    const v = await validatePdf(r.compile.pdf!, 'ua2');
    expect(v.compliant, JSON.stringify(v.failures.slice(0, 5))).toBe(true);
  });
});
