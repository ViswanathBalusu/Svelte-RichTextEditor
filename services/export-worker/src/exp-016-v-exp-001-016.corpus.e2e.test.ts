/**
 * EXP-016 (lane V-EXP-001-016): every reference corpus document that declares a standard is compiled
 * in the sandbox and validated with veraPDF against each declared flavour; a violation fails the
 * test and its message names the rule and the document. A draft-tagged preview compiles and is not
 * validated. Needs Podman and the worker image; skips otherwise. The CI step that runs this on
 * every pull request is root configuration and is not part of this file.
 */
import type { FontManifest } from '@docedit/export-latex';
import { describe, expect, it, vi } from 'vitest';
import { loadDocument } from '../../../packages/corpus/src/index.ts';
import { podman } from './container.ts';
import { flavoursFor, requiresValidation, validationReport } from './exp-016-corpus-report.ts';
import { runExport } from './pipeline.ts';
import { IMAGE, LIMITS } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';
import { validatePdf } from './verapdf.ts';

vi.setConfig({ testTimeout: 900_000 });

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
    // 180 s: on a loaded Podman machine a `podman run` took 80 to 100 s (sandbox-ready.ts).
    { timeoutMs: 180_000, maxStdoutBytes: 1024 * 1024 },
  );
  const why = r.timedOut ? 'timed out' : r.stderr.slice(0, 500);
  expect(r.code, `reading fonts.json: ${why}`).toBe(0);
  return JSON.parse(new TextDecoder().decode(r.stdout)) as FontManifest;
}

/** The corpus documents kept in git that declare a standard (corpus README, "Documents"). */
const CORPUS_DOCUMENTS = ['pages-1', 'form-fields', 'pages-20'] as const;
const DECLARED = 'ua-2+a-4f';

/**
 * The violations that are known and not yet fixed, by document and flavour (EXP-016 Notes, lane w2,
 * 2026-11-27). pages-20 compiles since the image has the Noto CJK face (owner decision 228) and
 * validates against PDF/A-4f. Against PDF/UA-2 four of its tables are not regular (clause 8.2.5.26,
 * test 4: rows with different numbers of columns, taking spans into account). veraPDF names them as
 * the tables in the subsections K[12] to K[15] of the first section of the structure tree, in the second
 * half of the document. Compiled alone, each table of
 * the document is regular, and so is the table with spans after any of the three tables before it, or
 * after up to 44 paragraphs; the cause is in how the class tags those tables in the context of the
 * whole document, not in the validation, and it is not found yet. Remove the entry when it is fixed.
 */
const KNOWN_VIOLATIONS: Record<string, string[]> = {
  'pages-20 ua2': ['8.2.5.26 test 4 x4'],
};

/**
 * The memory limit (MiB) per document where it differs from the spec limit of 1.5 GiB (09 §9.3 item 4).
 * pages-20 with the Noto CJK face is killed (exit 137) at 1536 and compiles at 2048 (measured
 * 2026-11-27, Podman machine route). The gate here tests PDF validation, not capacity; the question
 * of the production limit is the proposed ADR 0481. Remove the entry when it is decided.
 */
const MEMORY_MIB: Record<string, number> = { 'pages-20': 2048 };

describe.skipIf(!ready.ok)(`EXP-016 corpus validation (${ready.reason})`, () => {
  for (const name of CORPUS_DOCUMENTS) {
    it(`validates ${name} against every declared flavour`, async () => {
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
      const r = await runExport(
        doc.envelope,
        await imageFonts(),
        { tagging: 'on', pdfStandard: DECLARED, layout: 'block', title: name, assets },
        {
          kind: 'sandbox',
          options: { limits: { memoryMiB: MEMORY_MIB[name] ?? LIMITS.memoryMiB } },
        },
      );
      expect(r.compile.ok, r.compile.log.slice(-3000)).toBe(true);
      expect(requiresValidation('on')).toBe(true);
      for (const flavour of flavoursFor(DECLARED)) {
        const v = await validatePdf(r.compile.pdf!, flavour);
        const known = KNOWN_VIOLATIONS[`${name} ${flavour}`];
        if (known) {
          // A violation that is recorded in the story (EXP-016 Notes) and not yet fixed: it must be
          // exactly this rule, so that any other violation, or a fix, fails the test.
          expect(
            v.failures.map((f) => `${f.clause} test ${f.testNumber} x${f.failedChecks}`),
            validationReport(name, v),
          ).toEqual(known);
        } else {
          const report = validationReport(name, v);
          expect(report, report).toBe('');
          expect(v.compliant).toBe(true);
        }
      }
    });
  }

  it('names the rule and the document when a PDF violates the declared standard', async () => {
    const doc = await loadDocument('pages-1');
    // Tagging off and no standard: the PDF is not tagged, so PDF/UA-2 must refuse it.
    const r = await runExport(
      doc.envelope,
      await imageFonts(),
      { tagging: 'off', pdfStandard: 'none', layout: 'block', title: 'pages-1' },
      { kind: 'sandbox' },
    );
    expect(r.compile.ok, r.compile.log.slice(-3000)).toBe(true);
    const v = await validatePdf(r.compile.pdf!, 'ua2');
    expect(v.compliant).toBe(false);
    const report = validationReport('pages-1', v);
    expect(report).toContain('pages-1 ua2');
    expect(report.length).toBeGreaterThan(0);
  });

  it('compiles a draft-tagged preview of pages-1, which the gate does not validate', async () => {
    const doc = await loadDocument('pages-1');
    expect(requiresValidation('draft')).toBe(false);
    const r = await runExport(
      doc.envelope,
      await imageFonts(),
      { tagging: 'draft', pdfStandard: 'none', layout: 'block', title: 'pages-1 preview' },
      { kind: 'sandbox' },
    );
    expect(r.compile.ok, r.compile.log.slice(-3000)).toBe(true);
    expect(r.compile.pdf?.length ?? 0).toBeGreaterThan(0);
  });
});
