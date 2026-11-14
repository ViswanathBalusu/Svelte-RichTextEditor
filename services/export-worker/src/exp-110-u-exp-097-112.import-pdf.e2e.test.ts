/**
 * EXP-110, criterion 4 (lane U-EXP-097-112): an imported corpus document is exported to PDF.
 *
 * Each file of the S11 corpus is imported with `importDocx` (packages/export-docx), and the
 * imported envelope is compiled by the same pipeline as EXP-001: converted, then compiled with
 * LuaLaTeX in the export worker's sandbox (Podman, `--network=none`). The export succeeds when the
 * compile succeeds, the layout data validates, and the PDF starts with its header.
 *
 * The import is reached through a relative path into packages/export-docx, because this service
 * does not list `@docedit/export-docx` in its package.json (a root-level change for the owner, see
 * the story's Notes). Skips when the sandbox is not ready (sandbox-ready.ts), as EXP-001 does.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FontManifest } from '@docedit/export-latex';
import type { CdmEnvelope } from '@docedit/model';
import { describe, expect, it, vi } from 'vitest';
import { importDocx } from '../../../packages/export-docx/src/index.ts';
import { imageFontManifest } from './fonts.ts';
import { runExport } from './pipeline.ts';
import { IMAGE } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

vi.setConfig({ testTimeout: 600_000 });

const ready = await sandboxReady();

const CORPUS = fileURLToPath(new URL('../../../packages/export-docx/corpus/', import.meta.url));
/** Three files of the corpus with different structure: plain body, tables, and headers and footers. */
const FILES = ['docx4j/sample-docx.docx', 'docx4j/tables.docx', 'poi/headerFooter.docx'] as const;

/** The image's font manifest, read by the shared helper (it checks the exit code and the shape). */
function imageFonts(): Promise<FontManifest> {
  return imageFontManifest(IMAGE);
}

describe.skipIf(!ready.ok)(
  `EXP-110 import then PDF export in the sandbox (${ready.reason})`,
  () => {
    for (const name of FILES) {
      it(`exports the imported ${name} to PDF`, async () => {
        const bytes = new Uint8Array(readFileSync(`${CORPUS}${name}`));
        const imported = await importDocx(bytes);
        const r = await runExport(
          imported.envelope as unknown as CdmEnvelope,
          await imageFonts(),
          { tagging: 'off', pdfStandard: 'none', layout: 'block' },
          { kind: 'sandbox' },
        );
        expect(r.compile.ok, r.compile.log.slice(-2000)).toBe(true);
        expect(r.compile.pdf, 'a PDF is produced').toBeDefined();
        const head = new TextDecoder().decode(r.compile.pdf!.slice(0, 5));
        expect(head).toBe('%PDF-');
        expect(r.layoutErrors).toEqual([]);
      });
    }
  },
);
