/**
 * EXP-114 (lane U-EXP-113-123): writes the stored reference PDFs under `test/references/` and their
 * manifest. Each reference is the output of the converter's bundle compiled in the export worker's
 * sandbox (LuaLaTeX in Podman), with the options recorded in the manifest. The test
 * `src/exp-114-references.compile.test.ts` checks every file against its SHA-256 and validates it
 * with veraPDF.
 *
 * Run with: node packages/export-latex/scripts/exp-114-make-references.ts
 * A change to a reference is a change to the converter's output: it must be reviewed with the
 * differences shown (EXP-114 criterion 4), which this script does not do.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CdmEnvelope } from '@docedit/model';
import { doc, para } from '../test/docs.ts';
import { convertAndCompile, sandboxReady } from '../test/harness.ts';

const INSTANT = '2026-11-06T10:00:00.000Z';
const refDir = fileURLToPath(new URL('../test/references/', import.meta.url));

interface Reference {
  file: string;
  source: string;
  title: string;
  options: Record<string, unknown>;
  flavours: string[];
}

const sample = (): CdmEnvelope =>
  doc([
    para('Accessible report', { style: 'Heading1' }),
    para('First body paragraph with some text.'),
    para('Second body paragraph.'),
  ]);

const s4Path = fileURLToPath(
  new URL('../../../services/export-worker/fixtures/s4-corpus/s4-01p.cdm.json', import.meta.url),
);

const references: Array<Reference & { envelope: () => CdmEnvelope }> = [
  {
    file: 'exp-114-sample-ua2-a4f.pdf',
    source: 'inline sample (test/docs.ts, as EXP-111 criterion 1)',
    title: 'exp-114-sample',
    options: { tagging: 'on', pdfStandard: 'ua-2+a-4f' },
    flavours: ['ua2', '4f'],
    envelope: sample,
  },
  {
    file: 'exp-114-s4-01p-ua2-a4f.pdf',
    source: 'services/export-worker/fixtures/s4-corpus/s4-01p.cdm.json',
    title: 'exp-114-s4-01p',
    options: { tagging: 'on', pdfStandard: 'ua-2+a-4f' },
    flavours: ['ua2', '4f'],
    envelope: () => JSON.parse(readFileSync(s4Path, 'utf8')) as CdmEnvelope,
  },
];

async function main(): Promise<void> {
  const r = await sandboxReady();
  if (!r.ok) throw new Error(`sandboxed compiles cannot run here: ${r.reason}`);
  mkdirSync(refDir, { recursive: true });
  const manifest: Array<Omit<Reference, 'envelope'> & { sha256: string }> = [];
  for (const ref of references) {
    const c = await convertAndCompile(ref.envelope(), {
      profile: 'final',
      title: ref.title,
      instant: INSTANT,
      timeZone: 'Europe/London',
      suggestions: 'accept',
      layout: 'block',
      ...ref.options,
    } as never);
    if (!c.compile.ok || !c.compile.pdf)
      throw new Error(`the compile of ${ref.file} failed:\n${c.compile.log.slice(-1500)}`);
    writeFileSync(refDir + ref.file, c.compile.pdf);
    const sha256 = createHash('sha256').update(c.compile.pdf).digest('hex');
    manifest.push({
      file: ref.file,
      source: ref.source,
      title: ref.title,
      options: ref.options,
      flavours: ref.flavours,
      sha256,
    });
    console.log(`${ref.file} ${c.compile.pdf.length} bytes ${sha256}`);
  }
  writeFileSync(
    refDir + 'manifest.json',
    JSON.stringify({ instant: INSTANT, references: manifest }, null, 2) + '\n',
  );
}

await main();
