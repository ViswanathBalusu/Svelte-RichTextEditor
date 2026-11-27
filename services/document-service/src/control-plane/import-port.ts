// The importer port, kept apart from imports.ts so that kit.ts can name it without a cycle.

/** What an importer returns: the CDM envelope and the warnings to show the author. */
export interface ImportedDocument {
  envelope: unknown;
  warnings: ReadonlyArray<string | Record<string, unknown>>;
  /**
   * How much of the file the model keeps as preserved data and what that costs in bytes (EXP-116
   * criterion 5): the job's `preservation` member. Counts and bytes only, never content.
   */
  preservation?: Record<string, unknown>;
  /**
   * The assets the content names (pictures, preserved fragments, fallbacks), under the identifiers
   * the content uses. The job stores them and registers them for the document, so that I4 holds
   * (EXP-116 criterion 5). The original file and the source map are not listed: the original is
   * the uploaded asset.
   */
  assets?: ReadonlyArray<ImportedAsset>;
}

export interface ImportedAsset {
  id: string;
  bytes: Uint8Array;
  contentType: string;
  filename?: string;
}

/** Reads the bytes of a `.docx` file into CDM content. It throws when the file is refused. */
export type DocxImporter = (
  bytes: Uint8Array,
  opts: { signal: AbortSignal },
) => Promise<ImportedDocument>;

/** What the asset worker made of one picture of an import: its stored form, as the registry holds it. */
export interface ProcessedPicture {
  sha256: string;
  bytes: number;
  contentType: string;
  objectKey: string;
  width: number | null;
  height: number | null;
  frames: number | null;
  renditions: ReadonlyArray<{
    role: 'print';
    mime: string;
    sha256: string;
    bytes: number;
    objectKey: string;
  }>;
}

/**
 * Passes one picture of an import through the asset worker, which decodes it and stores the
 * re-encoded file (EXP-101 criterion 3; 06 §4.4). `null`: the type is not one the worker accepts, so
 * the caller keeps the bytes as before. `ok: false`: the worker refused the picture; the message
 * holds rules and numbers only.
 */
export type PictureProcessor = (
  tenant: string,
  asset: string,
  bytes: Uint8Array,
  mime: string,
) => Promise<({ ok: true } & ProcessedPicture) | { ok: false; message: string } | null>;
