/**
 * EXP-114: the stored reference PDFs under `test/references/`, how each is made, and how it is
 * compiled again. `scripts/exp-114-make-references.ts` writes the files from these definitions;
 * `src/exp-114-compare.compile.test.ts` compiles them again and compares the output with the
 * stored file. The compile is the converter's bundle in the export worker's sandbox (LuaLaTeX in
 * Podman) under a fixed instant and time zone, so a second compile of the same input is the same.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDocument } from '@docedit/corpus';
import type { CdmEnvelope } from '@docedit/model';
import { doc, para } from './docs.ts';
import { convertAndCompile } from './harness.ts';
import { delMark, insMark, markedPara, text } from './suggestions.ts';

export const INSTANT = '2026-11-06T10:00:00.000Z';
export const refDir = fileURLToPath(new URL('./references/', import.meta.url));

export interface Reference {
  file: string;
  source: string;
  title: string;
  options: Record<string, unknown>;
  flavours: string[];
  /** The shared corpus document (FND-006) the reference is made from, when it is one. */
  corpus?: string;
  /** Features of the corpus document that this reference leaves out, and why (see `fromCorpus`). */
  without?: string[];
  /** What is known to be wrong with the reference, for the reader of the manifest. */
  note?: string;
}

type Asset = { sha256: string; mediaType: string; bytes: Uint8Array };

/** What a reference is made from: the envelope and the assets it names. */
export interface Input {
  envelope: CdmEnvelope;
  assets: Record<string, Asset>;
}

/** The threads of the comments reference: one thread on the second paragraph, two messages. */
export const commentThreads = [
  {
    id: 'tAAAAAAAAAAAAAAA',
    block: 'pBBBBBBBBBBBBBBB',
    quote: 'Bravo',
    messages: [
      { author: 'Ada Lovelace', text: 'Marginnote checks this claim.' },
      { author: 'Grace Hopper', text: 'Replynote agrees.' },
    ],
  },
];

/** The comments reference: three paragraphs, the second with a thread, as in EXP-084. */
const comments = (): CdmEnvelope =>
  doc([
    para('Alpha paragraph opens the page.', { id: 'pAAAAAAAAAAAAAAA' }),
    para('Bravo paragraph carries the comment.', { id: 'pBBBBBBBBBBBBBBB' }),
    para('Charlie paragraph closes the page.', { id: 'pCCCCCCCCCCCCCCC' }),
  ]);

/** The suggestions reference: an insertion, a deletion and a paragraph with both, in `markup`. */
const suggestions = (): CdmEnvelope =>
  doc([
    para('Suggestions in markup', { style: 'Heading1' }),
    markedPara('An inserted paragraph.', [insMark(1)]),
    markedPara('A deleted paragraph.', [delMark(1)]),
    {
      ...para('A paragraph that keeps its words'),
      content: [
        text('Kept, '),
        text('inserted, ', [insMark(2)]),
        text('deleted, ', [delMark(2)]),
        text('and kept.'),
      ],
    },
  ]);

/**
 * A corpus document with its assets (as `exp-025-shared-corpus.compile.test.ts` loads it). The
 * Noto CJK face is in the worker image (owner decision 228), so `pages-20` is exported whole, with
 * its Chinese, Japanese and Korean text.
 */
const fromCorpus = (name: string) => async (): Promise<Input> => {
  const corpus = await loadDocument(name);
  const assets: Record<string, Asset> = {};
  for (const a of corpus.assets)
    assets[a.entry.id] = { sha256: a.entry.sha256, mediaType: a.entry.mediaType, bytes: a.bytes };
  return { envelope: corpus.envelope, assets };
};

const sample = (): CdmEnvelope =>
  doc([
    para('Accessible report', { style: 'Heading1' }),
    para('First body paragraph with some text.'),
    para('Second body paragraph.'),
  ]);

const s4Path = fileURLToPath(
  new URL('../../../services/export-worker/fixtures/s4-corpus/s4-01p.cdm.json', import.meta.url),
);

/**
 * The memory limit (MiB) of `pages-20` with the Noto CJK face: it is killed at the spec's 1536 and
 * compiles at 2048 (EXP-016 Notes, measured 2026-11-27). The references test the output, not the
 * capacity.
 */
const MEMORY_MIB = 2048;

/** What a reference is made from, and how: the manifest entry plus the code that is not in it. */
export type Definition = Reference & {
  input: () => Input | Promise<Input>;
  /** A memory limit above the spec's, for a document that needs one. */
  memoryMiB?: number;
};

export const references: Definition[] = [
  {
    file: 'exp-114-sample-ua2-a4f.pdf',
    source: 'inline sample (test/docs.ts, as EXP-111 criterion 1)',
    title: 'exp-114-sample',
    options: { tagging: 'on', pdfStandard: 'ua-2+a-4f' },
    flavours: ['ua2', '4f'],
    input: () => ({ envelope: sample(), assets: {} }),
  },
  {
    file: 'exp-114-s4-01p-ua2-a4f.pdf',
    source: 'services/export-worker/fixtures/s4-corpus/s4-01p.cdm.json',
    title: 'exp-114-s4-01p',
    options: { tagging: 'on', pdfStandard: 'ua-2+a-4f' },
    flavours: ['ua2', '4f'],
    input: () => ({
      envelope: JSON.parse(readFileSync(s4Path, 'utf8')) as CdmEnvelope,
      assets: {},
    }),
  },
  ...['pages-1', 'form-fields', 'pages-20'].map((name) => ({
    file: `exp-114-corpus-${name}-ua2-a4f.pdf`,
    source: `shared corpus document ${name} (FND-006)`,
    title: `exp-114-${name}`,
    options: { tagging: 'on', pdfStandard: 'ua-2+a-4f' },
    flavours: ['ua2', '4f'],
    corpus: name,
    ...(name === 'pages-20' ? { memoryMiB: MEMORY_MIB } : {}),
    input: fromCorpus(name),
  })),
  {
    file: 'exp-114-suggestions-markup.pdf',
    source: 'inline suggestions sample (suggestions option markup, EXP-083)',
    title: 'exp-114-suggestions',
    options: { tagging: 'on', pdfStandard: 'ua-2+a-4f', suggestions: 'markup' },
    flavours: ['ua2', '4f'],
    input: () => ({ envelope: suggestions(), assets: {} }),
  },
  {
    file: 'exp-114-comments-margin.pdf',
    source: 'inline comments sample (comments option margin, EXP-084)',
    title: 'exp-114-comments',
    options: {
      tagging: 'on',
      pdfStandard: 'ua-2+a-4f',
      comments: 'margin',
      commentThreads,
    },
    flavours: ['ua2', '4f'],
    input: () => ({ envelope: comments(), assets: {} }),
  },
];

/** Compiles a reference's input as its stored file was made. */
export async function compileReference(
  ref: Definition,
): Promise<Awaited<ReturnType<typeof convertAndCompile>>> {
  const input = await ref.input();
  return convertAndCompile(
    input.envelope,
    {
      profile: 'final',
      title: ref.title,
      instant: INSTANT,
      timeZone: 'Europe/London',
      suggestions: 'accept',
      layout: 'block',
      assets: input.assets,
      ...ref.options,
    } as never,
    ref.memoryMiB ? { limits: { memoryMiB: ref.memoryMiB } } : {},
  );
}
