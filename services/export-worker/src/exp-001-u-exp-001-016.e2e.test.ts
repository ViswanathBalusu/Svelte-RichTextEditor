/**
 * EXP-001 (lane U-EXP-001-016): a document of regions and three paragraph styles compiled in the
 * sandbox with LuaLaTeX. Needs Podman and the worker image; skips otherwise (sandbox-ready.ts).
 *
 * What this file shows, and how: the PDF text is read with Ghostscript's txtwrite device, which the
 * worker image ships; the network check runs a probe in the same sandbox flags as a compile
 * (`--network=none`), not inside the LuaTeX process, so it proves the container has no network and
 * not a LuaTeX-side refusal.
 */
import type { CdmEnvelope } from '@docedit/model';
import type { FontManifest } from '@docedit/export-latex';
import { describe, expect, it, vi } from 'vitest';
import { podman } from './container.ts';
import { imageFontManifest } from './fonts.ts';
import { runExport } from './pipeline.ts';
import { IMAGE, sandboxArgs } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

vi.setConfig({ testTimeout: 300_000 });

const ready = await sandboxReady();

const PARAGRAPHS = [
  'Scope',
  'Liability is limited to direct damages.',
  'A quoted sentence in the third style.',
  'Appendix text in the second region.',
  'Specials: \\ { } $ & # _ % ^ ~ end.',
];

/** Three paragraph styles (Normal, Heading1, Quote) and two regions, one of them with a title. */
function document(): CdmEnvelope {
  const para = (id: string, style: string, text: string) => ({
    type: 'paragraph',
    attrs: { id, style },
    content: [{ type: 'text', text }],
  });
  return {
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
              attrs: {
                id: 'Normal',
                kind: 'paragraph',
                name: 'Normal',
                builtIn: true,
                fontFamily: 'Noto Serif',
                fontSize: 220,
              },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'Heading1',
                kind: 'paragraph',
                name: 'Heading 1',
                builtIn: true,
                basedOn: 'Normal',
                outlineLevel: 1,
                fontSize: 320,
                bold: true,
              },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'Quote',
                kind: 'paragraph',
                name: 'Quote',
                basedOn: 'Normal',
                italic: true,
              },
            },
            {
              type: 'page_setup',
              attrs: {
                id: 'ps1',
                width: 11906,
                height: 16838,
                marginTop: 1440,
                marginRight: 1440,
                marginBottom: 1440,
                marginLeft: 1440,
              },
            },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            para('h1EXP001aaaaaaa', 'Heading1', PARAGRAPHS[0]!),
            {
              type: 'region',
              attrs: { id: 'rEXP001legalaaaa', title: 'Legal review', policy: 'restricted' },
              content: [para('pEXP001liabaaaaa', 'Normal', PARAGRAPHS[1]!)],
            },
            para('qEXP001quoteaaaaa', 'Quote', PARAGRAPHS[2]!),
            {
              type: 'region',
              attrs: { id: 'rEXP001annexaaaaa', title: 'Annex', policy: 'restricted' },
              content: [para('pEXP001annexaaaaa', 'Normal', PARAGRAPHS[3]!)],
            },
            para('pEXP001specialsaaa', 'Normal', PARAGRAPHS[4]!),
          ],
        },
      ],
    },
  } as unknown as CdmEnvelope;
}

/** The image's font manifest, read by the shared helper (it checks the exit code and the shape). */
function imageFonts(): Promise<FontManifest> {
  return imageFontManifest(IMAGE);
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
const noSpaces = (s: string): string => s.replace(/\s+/g, '');

/** The text of a PDF, read by Ghostscript inside a sandbox with the same flags as a compile. */
async function pdfText(pdf: Uint8Array): Promise<string> {
  const name = `docedit-test-u-exp-001-016-txt-${Date.now().toString(36)}`;
  // The PDF arrives on standard input and Ghostscript reads it from there. Arguments carry no
  // spaces, because the machine route passes them through ssh (container.ts, SSH_SAFE).
  // The root filesystem is read-only and /tmp is not mounted, so Ghostscript's temporary files go
  // to the work directory.
  const args = sandboxArgs(name, {
    env: { TMPDIR: '/work' },
    entrypoint: 'gs',
    command: ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=txtwrite', '-sOutputFile=-', '-'],
  });
  const r = await podman(args, {
    stdin: pdf,
    timeoutMs: 120_000,
    maxStdoutBytes: 4 * 1024 * 1024,
  });
  expect(r.code, r.stderr).toBe(0);
  return new TextDecoder().decode(r.stdout);
}

describe.skipIf(!ready.ok)(`EXP-001 PDF export in the sandbox (${ready.reason})`, () => {
  it('compiles the three styles and two regions, and the PDF text is the document text in order', async () => {
    const r = await runExport(
      document(),
      await imageFonts(),
      { tagging: 'off', pdfStandard: 'none', layout: 'block' },
      { kind: 'sandbox' },
    );
    expect(r.compile.ok, r.compile.log.slice(-2000)).toBe(true);
    // Ghostscript drops the spaces inside the italic paragraph (a kerning artifact of txtwrite), so
    // the comparison ignores spaces on both sides. Every other character must match, in order.
    const text = noSpaces(await pdfText(r.compile.pdf!));
    let at = -1;
    for (const p of PARAGRAPHS) {
      const i = text.indexOf(noSpaces(p), at + 1);
      expect(i, `"${p}" in order, PDF text: ${text}`).toBeGreaterThan(at);
      at = i;
    }
    // Regions leave no visible trace: neither their titles nor their policy names are printed.
    expect(text).not.toContain(noSpaces('Legal review'));
    expect(text).not.toContain(noSpaces('Annex'));
    expect(text).not.toContain(noSpaces('restricted'));
  });

  it('prints the TeX special characters as typed (every string goes through the text emitter)', async () => {
    const r = await runExport(
      document(),
      await imageFonts(),
      { tagging: 'off', pdfStandard: 'none', layout: 'off' },
      { kind: 'sandbox' },
    );
    expect(r.compile.ok, r.compile.log.slice(-2000)).toBe(true);
    const text = squash(await pdfText(r.compile.pdf!));
    expect(text).toContain('Specials: \\ { } $ & # _ % ^ ~ end.');
  });

  it('gives the compile container no network: a connection from inside it fails', async () => {
    // The probe is the standard input of python3 (`-`), so no argument carries a space.
    const probe = [
      'import socket',
      's = socket.socket()',
      's.settimeout(5)',
      'try:',
      "    s.connect(('1.1.1.1', 443))",
      "    print('CONNECTED')",
      'except OSError as e:',
      "    print('BLOCKED', type(e).__name__)",
      '',
    ].join('\n');
    const name = `docedit-test-u-exp-001-016-net-${Date.now().toString(36)}`;
    const r = await podman(sandboxArgs(name, { entrypoint: 'python3', command: ['-'] }), {
      stdin: new TextEncoder().encode(probe),
      timeoutMs: 120_000,
      maxStdoutBytes: 64 * 1024,
    });
    const out = new TextDecoder().decode(r.stdout).trim();
    expect(out).toMatch(/^BLOCKED /);
  });
});
