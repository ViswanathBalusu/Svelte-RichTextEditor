/** The shape of `out/manifest.json` (FND-006). */
import type { PAGE_ESTIMATE } from './analyse.ts';
import type { CORPUS_LICENCE, Source } from './sources.ts';
import type { CorpusVersion } from './version.ts';

export interface PageCount {
  target: number;
  /** The line-model estimate of `pageEstimate`. */
  estimated: number;
  /** Measured by a LaTeX compile; null until spike S4 reports it (src/generate/measured.ts). */
  measured: number | null;
  /** How and where the measured count was taken. */
  measuredBy?: string;
  status: 'estimated' | 'measured';
}

export interface ManifestDocument {
  name: string;
  /** Path relative to `out/`. */
  file: string;
  /** Kept in the repository; otherwise generated on demand and ignored by git. */
  inRepository: boolean;
  description: string;
  requires: string[];
  pages: PageCount;
  /** SHA-256 of the canonical form (03 §2), from `documentHash` in `@docedit/model`. */
  documentHash: string;
  /** SHA-256 of the file's bytes. */
  fileSha256: string;
  fileBytes: number;
  /** Bytes of the canonical form; invariant I7 allows at most 16 MiB. */
  canonicalBytes: number;
  nodes: number;
  nodesByType: Record<string, number>;
  /** Unicode code points in all text runs. */
  characters: number;
  /** Words separated by white space, CJK characters not included. */
  words: number;
  cjkCharacters: number;
  /** The longest paragraph in code points, without its footnotes. */
  longestParagraph: number;
  features: string[];
  /** Attached assets: pass them to `validate()` as `attachedAssets` (invariant I4). */
  assets: string[];
  /** Identifiers of the entries of `sources` this document draws on. */
  sources: string[];
}

export interface ManifestAsset {
  id: string;
  /** Path relative to `out/`. */
  file: string;
  mediaType: 'image/png';
  /** Pixels. */
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  description: string;
  licence: string;
  source: string;
}

export interface CorpusManifest {
  corpus: 'docedit-corpus';
  version: number;
  /** See src/generate/version.ts. */
  fingerprint: string;
  history: CorpusVersion[];
  generator: {
    command: string;
    random: string;
    note: string;
  };
  cdm: number;
  canonicalFormVersion: number;
  licence: typeof CORPUS_LICENCE;
  sources: Source[];
  pageEstimate: typeof PAGE_ESTIMATE;
  documents: ManifestDocument[];
  assets: ManifestAsset[];
}

/** What a test records about the corpus it ran against (FND-006). */
export interface CorpusStamp {
  corpus: 'docedit-corpus';
  version: number;
  fingerprint: string;
}
