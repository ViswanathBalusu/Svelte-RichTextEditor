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
}

/** Reads the bytes of a `.docx` file into CDM content. It throws when the file is refused. */
export type DocxImporter = (
  bytes: Uint8Array,
  opts: { signal: AbortSignal },
) => Promise<ImportedDocument>;
