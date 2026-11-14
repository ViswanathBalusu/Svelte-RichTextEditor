/**
 * EXP-078 (lane V-EXP-065-080): a corpus compile is compared with its stored reference PDF by text
 * position, and a change to the house style reports the lines and page breaks that moved.
 *
 * The reference PDFs are in fixtures/reference-pdfs. They are written only when
 * DOCEDIT_UPDATE_REFERENCES=1 is set, which is the reviewed step of criterion 3: a new reference
 * is a change to review, not a side effect of a test run. Needs Podman and the worker image; skips
 * otherwise (DOCEDIT_REQUIRE_SANDBOX=1 makes it fail instead).
 */
import type { FontManifest } from '@docedit/export-latex';
import type { CdmEnvelope } from '@docedit/model';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { loadDocument } from '../../../packages/corpus/src/index.ts';
import { podman } from './container.ts';
import { diffText, formatReport, type CorpusEntry } from './exp-078-reference-diff.ts';
import { pdfTextPositions } from './exp-078-pdftotext.ts';
import { runExport } from './pipeline.ts';
import { IMAGE } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

vi.setConfig({ testTimeout: 900_000 });

const ready = await sandboxReady();
const UPDATE = process.env['DOCEDIT_UPDATE_REFERENCES'] === '1';
const REFERENCES = fileURLToPath(new URL('../fixtures/reference-pdfs/', import.meta.url));
// Only documents with a reviewed reference PDF are listed. pages-20 is left out: in the current
// worker image it does not compile (its Chinese paragraph, block 29, has no font that covers it,
// and a missing glyph stops the compile), so it has no reference yet. Add it back with its
// reference once the image carries a CJK font.
const DOCUMENTS = ['pages-1'] as const;

/** Read once per run: the image's font manifest (a Podman call that can be slow under load). */
let fontsOnce: Promise<FontManifest> | undefined;
function imageFonts(): Promise<FontManifest> {
  fontsOnce ??= (async () => {
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
      { timeoutMs: 300_000, maxStdoutBytes: 1024 * 1024 },
    );
    return JSON.parse(new TextDecoder().decode(r.stdout)) as FontManifest;
  })();
  return fontsOnce;
}

async function assetsOf(name: (typeof DOCUMENTS)[number]) {
  const doc = await loadDocument(name);
  const assets = Object.fromEntries(
    doc.assets.map((a) => [
      a.entry.id,
      {
        sha256: a.entry.sha256,
        mediaType: a.entry.mediaType,
        status: 'ready' as const,
        bytes: a.bytes,
      },
    ]),
  );
  return { envelope: doc.envelope, assets };
}

/** The same envelope with the Normal style at another size: the house style moves the breaks. */
function growNormalStyle(envelope: CdmEnvelope, fontSize: number): CdmEnvelope {
  const copy = structuredClone(envelope) as unknown as {
    doc: { content: Array<{ content?: Array<{ type: string; attrs?: Record<string, unknown> }> }> };
  };
  let changed = 0;
  for (const block of copy.doc.content)
    for (const node of block.content ?? [])
      if (node.type === 'style_def' && node.attrs?.['id'] === 'Normal') {
        node.attrs['fontSize'] = fontSize;
        changed++;
      }
  if (changed !== 1) throw new Error(`expected one Normal style, found ${changed}`);
  return copy as unknown as CdmEnvelope;
}

async function compile(
  name: (typeof DOCUMENTS)[number],
  envelope: CdmEnvelope,
  assets: Awaited<ReturnType<typeof assetsOf>>['assets'],
) {
  const r = await runExport(
    envelope,
    await imageFonts(),
    { tagging: 'on', pdfStandard: 'ua-2+a-4f', layout: 'block', title: name, assets },
    { kind: 'sandbox' },
  );
  expect(r.compile.ok, r.compile.log.slice(-3000)).toBe(true);
  return r.compile.pdf!;
}

describe.skipIf(!ready.ok)(`EXP-078 reference comparison (${ready.reason})`, () => {
  for (const name of DOCUMENTS) {
    const referencePath = `${REFERENCES}${name}.pdf`;

    it(`${name}: a fresh compile has no moved line and no moved break against its reference`, async () => {
      const { envelope, assets } = await assetsOf(name);
      const pdf = await compile(name, envelope, assets);
      if (UPDATE) {
        // Writing the reference is the only thing this run does; the comparison is the next run's.
        await mkdir(REFERENCES, { recursive: true });
        await writeFile(referencePath, pdf);
        return;
      }
      expect(
        existsSync(referencePath),
        `no reference PDF at ${referencePath}; review and run with DOCEDIT_UPDATE_REFERENCES=1`,
      ).toBe(true);
      const ref = new Uint8Array(await readFile(referencePath));
      const diff = diffText(await pdfTextPositions(ref), await pdfTextPositions(pdf));
      const report = formatReport([{ document: name, diff }]);
      expect(report, report).toBe('');
    });

    it(`${name}: a grown Normal style is listed with its moved lines or page breaks`, async () => {
      // Checked before the compile, so a missing reference fails at once and says what to do.
      expect(
        existsSync(referencePath),
        `no reference PDF at ${referencePath}; review and run with DOCEDIT_UPDATE_REFERENCES=1`,
      ).toBe(true);
      const { envelope, assets } = await assetsOf(name);
      const grown = growNormalStyle(envelope, 240);
      const pdf = await compile(name, grown, assets);
      const ref = new Uint8Array(await readFile(referencePath));
      const entries: CorpusEntry[] = [
        {
          document: name,
          diff: diffText(await pdfTextPositions(ref), await pdfTextPositions(pdf)),
        },
      ];
      const report = formatReport(entries);
      expect(entries[0]!.diff.differs).toBe(true);
      expect(report).toContain(`${name}: `);
      expect(
        report
          .split('\n')
          .some(
            (l) =>
              l.includes('moved from y') ||
              l.includes('page break moved') ||
              l.includes('page count'),
          ),
      ).toBe(true);
    });
  }
});
