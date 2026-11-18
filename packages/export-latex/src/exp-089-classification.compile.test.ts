/**
 * Classification marking (EXP-089; owner decision 51: header and footer of every page).
 *
 * - Criterion 1 (sandbox, Podman or local TeX): a label prints on every page, escaped through the
 *   `text` emitter. Read back with `pdftotext`, as EXP-036 does. Skips when sandboxed compiles
 *   cannot run here (EXP-070).
 * - Criterion 2 (sandbox): a document without a label prints no marking.
 * - Criterion 3 (no sandbox): a label change changes the bundle hash, and the label is in the
 *   manifest's options. A bundle without a label carries no `classification` option.
 * - Criterion 4 (other targets) is not tested here: the HTML, Markdown and DOCX writers do not
 *   take the label yet (see the story's Notes).
 */
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import {
  classFiles,
  convertAndCompile,
  imageFonts,
  keep,
  pdfText,
  sandboxReady,
  type Compiled,
} from '../test/harness.ts';
import { convert } from './convert.ts';
import type { CdmEnvelope } from '@docedit/model';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const A4: J = {
  width: 11906,
  height: 16838,
  marginTop: 1440,
  marginBottom: 1440,
  marginLeft: 1440,
  marginRight: 1440,
  gutter: 0,
  headerDistance: 720,
  footerDistance: 720,
};

const pageSetup = (id: string, attrs: J): J => ({
  type: 'page_setup',
  attrs: { id, ...A4, ...attrs },
});

const OPTIONS = {
  profile: 'preview',
  instant: INSTANT,
  timeZone: 'Europe/London',
  suggestions: 'accept',
  layout: 'block',
} as const;

function body(): J[] {
  return [
    para('One.'),
    para('Two.', { pageBreakBefore: true }),
    para('Three.', { pageBreakBefore: true }),
  ];
}

function envelope(): CdmEnvelope {
  return doc(body(), { pageSetups: [pageSetup('ps1', {})] }) as unknown as CdmEnvelope;
}

async function compiled(name: string, label: string | undefined): Promise<Compiled> {
  const c = await convertAndCompile(envelope(), {
    ...OPTIONS,
    title: name,
    ...(label !== undefined ? { classification: label } : {}),
  } as never);
  if (!c.compile.ok || !c.compile.pdf)
    throw new Error(`the compile failed (${keep(name, c)}):\n${c.compile.log.slice(-1500)}`);
  return c;
}

/** The text of each page, from `pdftotext`'s form feeds, without the empty trailing page. */
function pages(c: Compiled): string[] {
  const text = pdfText(c.compile.pdf!);
  if (text === null) throw new Error('pdftotext is not installed or failed');
  const parts = text.split('\f');
  if (parts.length > 0 && parts[parts.length - 1]!.trim() === '') parts.pop();
  return parts;
}

describe.skipIf(!ready)('EXP-089 criterion 1: a label prints on every page', () => {
  it('prints the label, escaped through the text emitter, in the header or footer of each page', async () => {
    const c = await compiled('exp-089-label-every-page', 'Internal & restricted 50%');
    const texts = pages(c);
    expect(texts).toHaveLength(3);
    for (const p of texts) expect(p).toContain('Internal & restricted 50%');
  }, 300_000);
});

describe.skipIf(!ready)('EXP-089 criterion 2: no label, no marking', () => {
  it('prints no marking on any page of a document without a label', async () => {
    const c = await compiled('exp-089-no-label', undefined);
    const texts = pages(c);
    expect(texts).toHaveLength(3);
    for (const p of texts) expect(p).not.toContain('Internal');
  }, 300_000);
});

describe('EXP-089 criterion 3: a label change changes the bundle hash', () => {
  it('records the label in the options and changes the bundle hash when it changes', async () => {
    const base = { fonts: await imageFonts(), classFiles: classFiles(), ...OPTIONS, title: 'x' };
    const none = await convert(envelope(), base as never);
    const a = await convert(envelope(), { ...base, classification: 'Internal' } as never);
    const b = await convert(envelope(), { ...base, classification: 'Public' } as never);
    expect(none.manifest.options).not.toHaveProperty('classification');
    expect(a.manifest.options['classification']).toBe('Internal');
    expect(a.manifest.bundleHash).not.toBe(none.manifest.bundleHash);
    expect(b.manifest.bundleHash).not.toBe(a.manifest.bundleHash);
  }, 300_000);

  it('writes the label through the text emitter as \\DEdefclassification, escaped', async () => {
    const bundle = await convert(envelope(), {
      fonts: await imageFonts(),
      classFiles: classFiles(),
      ...OPTIONS,
      title: 'x',
      classification: 'Internal & 50%',
    } as never);
    expect(bundle.files['main.tex']).toContain('\\DEdefclassification{Internal \\& 50\\%}');
  }, 300_000);
});
