/**
 * FRW-080 criterion 5 (lane U-FRW-073-089, round 2): a PDF export of a document whose form field is
 * empty, filled with a short value and filled with a value longer than its box has the same
 * block-level page starts and the same block pages. Needs Podman and the worker image; skips
 * otherwise (sandbox-ready.ts).
 *
 * What this file shows, and how: the same CDM document is compiled in the sandbox three times, and
 * only the value of one `form_field` (fixed `width`, 2880 twips) differs. The comparison reads the
 * layout the class writes (`layout.json`, block granularity: `pages[].starts` and `blocks[].page`),
 * which is the block-level page starts of the PDF, not a text reading of the PDF.
 */
import type { CdmEnvelope } from '@docedit/model';
import type { FontManifest } from '@docedit/export-latex';
import { describe, expect, it, vi } from 'vitest';
import { podman } from './container.ts';
import { runExport } from './pipeline.ts';
import { IMAGE } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

vi.setConfig({ testTimeout: 600_000 });

const ready = await sandboxReady();

const FIELD_ID = 'fFRW080fieldaaaa';
const FIELD_PARA = 40;
const PARAGRAPHS = 90;

const SHORT = 'Ada Lovelace';
const LONG =
  'A value far longer than the fixed box of this field, so that it would push the text after it on a fill that grew the box instead of keeping it';

function paragraph(index: number, value: string | null): Record<string, unknown> {
  const id = `pFRW080${String(index).padStart(3, '0')}aaaaaa`;
  const body = `Paragraph ${index} of the filled document, with enough words to take a line or two of the page.`;
  if (index !== FIELD_PARA) {
    return {
      type: 'paragraph',
      attrs: { id, style: 'Normal' },
      content: [{ type: 'text', text: body }],
    };
  }
  return {
    type: 'paragraph',
    attrs: { id, style: 'Normal' },
    content: [
      { type: 'text', text: 'Name of the tenant: ' },
      {
        type: 'form_field',
        attrs: {
          id: FIELD_ID,
          key: 'tenant',
          kind: 'text',
          label: 'Tenant',
          width: 2880,
          value,
          assignee: null,
        },
      },
      { type: 'text', text: `. ${body}` },
    ],
  };
}

/** A document of plain paragraphs with one form field in the middle, on A4 with 1 inch margins. */
function document(value: string | null): CdmEnvelope {
  const content = Array.from({ length: PARAGRAPHS }, (_, i) => paragraph(i + 1, value));
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
        { type: 'body', attrs: { pageSetup: 'ps1' }, content },
      ],
    },
  } as unknown as CdmEnvelope;
}

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
    // 180 s: on a loaded Podman machine a `podman run` took 80 to 100 s (sandbox-ready.ts).
    { timeoutMs: 180_000, maxStdoutBytes: 1024 * 1024 },
  );
  return JSON.parse(new TextDecoder().decode(r.stdout)) as FontManifest;
}

/** The block-level page starts and block pages of one compile, from its layout. */
async function breaks(value: string | null, fonts: FontManifest) {
  const r = await runExport(
    document(value),
    fonts,
    { tagging: 'off', pdfStandard: 'none', layout: 'block' },
    { kind: 'sandbox' },
  );
  expect(r.compile.ok, r.compile.log.slice(-2000)).toBe(true);
  expect(r.layout, r.layoutErrors.join('; ')).not.toBeNull();
  const layout = r.layout!;
  return {
    pages: layout.pages.length,
    starts: layout.pages.map((p) => (p.starts ? p.starts.blockId : null)),
    blockPages: Object.fromEntries(
      Object.entries(layout.blocks).map(([id, b]) => [id, b.page] as const),
    ),
  };
}

describe.skipIf(!ready.ok)(
  `FRW-080 criterion 5: page starts with an empty and a filled field (${ready.reason})`,
  () => {
    it('keeps the block page starts and the block pages the same for an empty, a short and a long value', async () => {
      const fonts = await imageFonts();
      const empty = await breaks(null, fonts);
      const short = await breaks(SHORT, fonts);
      const long = await breaks(LONG, fonts);
      // The document must span more than one page, or the comparison proves little.
      expect(empty.pages).toBeGreaterThan(1);
      expect(short.starts).toEqual(empty.starts);
      expect(long.starts).toEqual(empty.starts);
      expect(short.blockPages).toEqual(empty.blockPages);
      expect(long.blockPages).toEqual(empty.blockPages);
    });
  },
);
