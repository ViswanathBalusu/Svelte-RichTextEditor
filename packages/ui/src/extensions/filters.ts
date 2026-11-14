/**
 * Client import and export filters contributed by extensions (UX-055; 13 §7.1, §6 output
 * restrictions).
 *
 * - An export filter receives the content it is given and returns bytes; the shell wraps them as a
 *   file (`toBlob`) for the browser to save. Refused under `no-export` (UX-040, 13 §6), in which
 *   case the filter does not run.
 * - An import filter turns a file into a CDM fragment (the type is the caller's, `unknown` here).
 *   The fragment goes to the caller's `insert`, which is where the guards of typing apply; a refusal
 *   is reported and nothing is inserted.
 * - A filter that throws is reported as `failed` with its error. The filter never receives the
 *   document to change it, so the document is unchanged in that case.
 * - Labels are the filter's own text: the host's string tables do not hold an extension's strings.
 *   ADR 0136 records this as a proposed decision.
 */

export type FilterKind = 'import' | 'export';

/** The output restriction that refuses export (13 §6; `AccessObject.restrictions`). */
export const NO_EXPORT = 'no-export';

interface FilterBase {
  /** Identifier, `area.name`, unique among the filters of the registry. */
  readonly id: string;
  /** The text shown in the import or export choices. */
  readonly label: string;
}

export interface ExportFilter<C = unknown> extends FilterBase {
  readonly kind: 'export';
  /** The file type the filter writes, as a MIME type. */
  readonly mimeType: string;
  /** The file name extension, without the dot (for example `md`). */
  readonly extension: string;
  /** Produces the bytes of the file from the content it was given. */
  readonly run: (content: C) => Uint8Array | Promise<Uint8Array>;
}

export interface ImportFilter<F = unknown> extends FilterBase {
  readonly kind: 'import';
  /** File name extensions the filter reads, without dots. */
  readonly extensions: readonly string[];
  /** Produces a CDM fragment from the file's bytes. */
  readonly run: (input: { readonly bytes: Uint8Array; readonly name: string }) => F | Promise<F>;
}

export type Filter = ExportFilter | ImportFilter;

export class FilterRegistrationError extends Error {
  readonly filterId: string;

  constructor(filterId: string, message: string) {
    super(`filter "${filterId}": ${message}`);
    this.name = 'FilterRegistrationError';
    this.filterId = filterId;
  }
}

export interface FilterChoice {
  readonly id: string;
  readonly kind: FilterKind;
  readonly label: string;
  /** False when the choice is shown but cannot run; `reason` says why. */
  readonly enabled: boolean;
  readonly reason: 'no-export' | null;
}

export type ExportOutcome =
  | {
      readonly ok: true;
      readonly name: string;
      readonly mimeType: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly reason: 'unknown' | 'no-export' | 'failed';
      readonly error?: unknown;
    };

export type ImportOutcome<F = unknown> =
  | { readonly ok: true; readonly fragment: F }
  | {
      readonly ok: false;
      readonly reason: 'unknown' | 'failed' | 'refused';
      readonly error?: unknown;
    };

const ID = /^[a-z][A-Za-z0-9-]*(\.[a-z][A-Za-z0-9-]*)+$/;

export class FilterRegistry {
  readonly #filters = new Map<string, Filter>();

  /** Adds a filter; returns the function that removes it. Throws naming the filter when invalid. */
  add(filter: Filter): () => void {
    const id = String(filter.id);
    if (!ID.test(id))
      throw new FilterRegistrationError(id, 'the identifier must have the form "area.name"');
    if (this.#filters.has(id))
      throw new FilterRegistrationError(id, 'a filter with this identifier is already registered');
    if (typeof filter.label !== 'string' || filter.label.trim() === '')
      throw new FilterRegistrationError(id, 'it needs a label');
    if (filter.kind === 'export') {
      if (typeof filter.mimeType !== 'string' || !filter.mimeType.includes('/'))
        throw new FilterRegistrationError(id, 'it names no MIME type');
      if (!/^[a-z0-9]+$/i.test(filter.extension ?? ''))
        throw new FilterRegistrationError(id, 'its extension must be letters and digits only');
    } else if (filter.kind === 'import') {
      if (!Array.isArray(filter.extensions) || filter.extensions.length === 0)
        throw new FilterRegistrationError(id, 'it names no file extension');
    } else {
      throw new FilterRegistrationError(id, 'its kind must be "import" or "export"');
    }
    if (typeof filter.run !== 'function')
      throw new FilterRegistrationError(id, 'it has no run function');
    this.#filters.set(id, filter);
    return () => this.remove(id);
  }

  remove(id: string): boolean {
    return this.#filters.delete(id);
  }

  /**
   * The choices of one kind, in registration order. Export choices are listed but disabled under
   * `no-export`, so a user sees why they cannot export (UX-055 criterion 4).
   */
  choices(kind: FilterKind, restrictions: readonly string[] = []): FilterChoice[] {
    const limited = kind === 'export' && restrictions.includes(NO_EXPORT);
    return [...this.#filters.values()]
      .filter((f) => f.kind === kind)
      .map((f) => ({
        id: f.id,
        kind,
        label: f.label,
        enabled: !limited,
        reason: limited ? ('no-export' as const) : null,
      }));
  }

  /** Runs an export filter on `content`; the content is only read. */
  async runExport<C>(
    id: string,
    content: C,
    restrictions: readonly string[] = [],
    fileBase = 'document',
  ): Promise<ExportOutcome> {
    const filter = this.#filters.get(id);
    if (!filter || filter.kind !== 'export') return { ok: false, reason: 'unknown' };
    if (restrictions.includes(NO_EXPORT)) return { ok: false, reason: 'no-export' };
    try {
      const bytes = await (filter as ExportFilter<C>).run(content);
      return {
        ok: true,
        name: `${fileBase}.${filter.extension}`,
        mimeType: filter.mimeType,
        bytes,
      };
    } catch (error) {
      return { ok: false, reason: 'failed', error };
    }
  }

  /**
   * Runs an import filter on a file and hands the fragment to `insert`, which applies the guards
   * of typing and returns false when it refuses. Nothing is inserted when the filter fails.
   */
  async runImport<F>(
    id: string,
    input: { readonly bytes: Uint8Array; readonly name: string },
    insert: (fragment: F) => boolean,
  ): Promise<ImportOutcome<F>> {
    const filter = this.#filters.get(id);
    if (!filter || filter.kind !== 'import') return { ok: false, reason: 'unknown' };
    let fragment: F;
    try {
      fragment = (await (filter as ImportFilter<F>).run(input)) as F;
    } catch (error) {
      return { ok: false, reason: 'failed', error };
    }
    return insert(fragment) ? { ok: true, fragment } : { ok: false, reason: 'refused' };
  }
}

/** Wraps an export outcome's bytes as a file for the browser to save. */
export function toBlob(outcome: Extract<ExportOutcome, { ok: true }>): Blob {
  return new Blob([outcome.bytes as BlobPart], { type: outcome.mimeType });
}
