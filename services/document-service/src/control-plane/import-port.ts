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
