// Scratch smoke run (not a test): convert and compile one document with the new converter, keep
// the artefacts. Documents: corpus names, `s4-01p`, `toc` (the worker's tocDocument).
import { readFileSync } from 'node:fs';
import type { CdmEnvelope } from '@docedit/model';
import { loadDocument } from '@docedit/corpus';
import { tocDocument } from '../../../services/export-worker/test/documents.ts';
import { convertAndCompile, firstError, keep, pdfText, validatePdf } from './harness.ts';

const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const profile = process.argv.includes('--final') ? 'final' : 'preview';
for (const name of names.length ? names : ['pages-1']) {
  let envelope: CdmEnvelope;
  const assets: Record<string, { sha256: string; mediaType: string; bytes: Uint8Array }> = {};
  if (name === 's4-01p')
    envelope = JSON.parse(
      readFileSync(
        new URL(
          '../../../services/export-worker/fixtures/s4-corpus/s4-01p.cdm.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as CdmEnvelope;
  else if (name === 'toc') envelope = tocDocument(40);
  else {
    const doc = await loadDocument(name, { verify: false });
    envelope = doc.envelope;
    for (const a of doc.assets)
      assets[a.entry.id] = { sha256: a.entry.sha256, mediaType: a.entry.mediaType, bytes: a.bytes };
  }
  const t0 = performance.now();
  const c = await convertAndCompile(envelope, {
    profile,
    title: name,
    assets,
    instant: '2026-11-06T10:00:00.000Z',
    timeZone: 'Europe/London',
    suggestions: 'accept',
  });
  const dir = keep(name, c);
  console.log(
    `${name}: ok=${c.compile.ok} exit=${c.compile.exitCode} passes=${c.compile.passes.length} converged=${c.compile.converged} pages=${c.layout?.pages.length} ms=${Math.round(performance.now() - t0)} layoutErrors=${c.layoutErrors.join(';')} -> ${dir}`,
  );
  if (!c.compile.ok) console.log(firstError(c.compile.log));
  else if (process.argv.includes('--validate')) {
    for (const f of ['ua2', '4f'] as const) {
      const v = await validatePdf(c.compile.pdf!, f);
      console.log(
        `  veraPDF ${f}: compliant=${v.compliant} passed=${v.passedChecks} failed=${v.failedChecks} ${v.error ?? ''} ${JSON.stringify(v.failures.slice(0, 4))}`,
      );
    }
  }
  if (c.compile.pdf && process.argv.includes('--text'))
    console.log((pdfText(c.compile.pdf, '-layout') ?? '').slice(0, 2500));
}
