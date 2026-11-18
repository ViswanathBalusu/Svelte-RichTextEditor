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

/** Han, Kana, Hangul and CJK punctuation: no font of the worker image covers them (EXP-026). */
const CJK = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/gu;

/** The envelope with every CJK character of its text replaced by an `x`; nothing else changes. */
function withoutCjk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCjk);
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(o).map(([k, v]) => [
        k,
        k === 'text' && typeof v === 'string' ? v.replace(CJK, 'x') : withoutCjk(v),
      ]),
    );
  }
  return value;
}

/**
 * A corpus document with its assets (as `exp-025-shared-corpus.compile.test.ts` loads it). The
 * CJK fallback fonts are not in the worker image yet (the owner's open question 7 of ADR 0045), so
 * a final export of a CJK character fails; `cjkAsX` makes the reference from the document with
 * those characters replaced, and the reference's manifest entry says so.
 */
const fromCorpus =
  (name: string, cjkAsX = false) =>
  async (): Promise<Input> => {
    const corpus = await loadDocument(name);
    const assets: Record<string, Asset> = {};
    for (const a of corpus.assets)
      assets[a.entry.id] = { sha256: a.entry.sha256, mediaType: a.entry.mediaType, bytes: a.bytes };
    const envelope = cjkAsX ? (withoutCjk(corpus.envelope) as CdmEnvelope) : corpus.envelope;
    return { envelope, assets };
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

export const references: Array<Reference & { input: () => Input | Promise<Input> }> = [
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
    flavours: name === 'pages-20' ? ['4f'] : ['ua2', '4f'],
    corpus: name,
    ...(name === 'pages-20'
      ? {
          without: ['cjk.*'],
          note: 'fails PDF/UA-2 (veraPDF 8.2.5.26, tables shall be regular, 4 checks) on the tables with row and column spans; only PDF/A-4f is checked',
        }
      : {}),
    input: fromCorpus(name, name === 'pages-20'),
  })),
  {
    file: 'exp-114-suggestions-markup.pdf',
    source: 'inline suggestions sample (suggestions option markup, EXP-083)',
    title: 'exp-114-suggestions',
    options: { tagging: 'on', pdfStandard: 'ua-2+a-4f', suggestions: 'markup' },
    flavours: ['ua2', '4f'],
    input: () => ({ envelope: suggestions(), assets: {} }),
  },
];

/** Compiles a reference's input as its stored file was made. */
export async function compileReference(
  ref: Reference & { input: () => Input | Promise<Input> },
): Promise<Awaited<ReturnType<typeof convertAndCompile>>> {
  const input = await ref.input();
  return convertAndCompile(input.envelope, {
    profile: 'final',
    title: ref.title,
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
    layout: 'block',
    assets: input.assets,
    ...ref.options,
  } as never);
}
