/**
 * The writer interface (EXP-002 criterion 6): how an export target reads a document, without any
 * type of LaTeX in it, so that another writer (a Typst previewer, ADR 0007; the DOCX writer) reads
 * the CDM the same way. Two writers implement it here: the LaTeX bundle and the canonical JSON
 * (EXP-086).
 */
import {
  canonicalText,
  sha256HexBytes,
  utf8,
  type CdmEnvelope,
  type CounterEffect,
  type JsonEnvelope,
} from '@docedit/model';
import type { AssetInput, Bundle, ConvertOptions, FontManifest } from './bundle.ts';
import { convert } from './convert.ts';

/** What every writer reads: the requester's projection of the document and the job's context. */
export interface WriterInput {
  /** The document at `seq`, as the requester may read it (ADR 0019). */
  readonly document: CdmEnvelope;
  readonly seq: number | null;
  readonly chainHead: string | null;
  readonly fonts: FontManifest;
  readonly assets: Readonly<Record<string, AssetInput>>;
  /** Counter effects of hidden regions, so a projection shows the full document's numbers. */
  readonly counterEffects?: Readonly<Record<string, CounterEffect>>;
  /** The server's instant and the job's time zone, for date fields (03 §7). */
  readonly instant?: string;
  readonly timeZone?: string;
  /** Control-plane metadata (03 §2). */
  readonly title?: string;
}

export interface DocumentWriter<Options, Output> {
  /** The export target of 09 §9.1 and §11: `pdf`, `tex`, `cdm`, `docx`, … */
  readonly target: string;
  write(input: WriterInput, options: Options): Promise<Output>;
}

export type LatexWriterOptions = Omit<
  ConvertOptions,
  'fonts' | 'assets' | 'counterEffects' | 'seq' | 'chainHead' | 'instant' | 'timeZone' | 'title'
>;

/** The LaTeX bundle writer (09 §2): the `pdf` and `tex` targets compile or archive its output. */
export const latexWriter: DocumentWriter<LatexWriterOptions, Bundle> = {
  target: 'tex',
  write(input, options) {
    return convert(input.document, {
      ...options,
      fonts: input.fonts,
      assets: input.assets,
      seq: input.seq,
      chainHead: input.chainHead,
      ...(input.counterEffects ? { counterEffects: input.counterEffects } : {}),
      ...(input.instant !== undefined ? { instant: input.instant } : {}),
      ...(input.timeZone !== undefined ? { timeZone: input.timeZone } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
    });
  },
};

export interface CanonicalJson {
  /** The envelope in RFC 8785 form with the CDM's canonical-form rules (03 §2). */
  readonly text: string;
  readonly bytes: Uint8Array;
  /** SHA-256 of `bytes`, which equals `documentHash` of the model for the same document. */
  readonly sha256: string;
}

/**
 * The canonical JSON target (09 §11; EXP-086): the envelope, `cdm`, `requires` and `doc` only, so
 * no comments, grants or history, in the canonical form whose hash the conformance kit computes.
 */
export const cdmWriter: DocumentWriter<Record<string, never>, CanonicalJson> = {
  target: 'cdm',
  async write(input) {
    const text = canonicalText(input.document as unknown as JsonEnvelope);
    const bytes = utf8(text);
    return { text, bytes, sha256: await sha256HexBytes(bytes) };
  },
};
