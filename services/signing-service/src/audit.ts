/**
 * The audit log of the signing service (12 §8.2 step 3; FRW-052 criterion 3).
 *
 * Every request to seal is written before any key is used, and its outcome is written after. An
 * entry holds identifiers, hashes and codes. It has no member for the PDF, a credential, a key or a
 * signature value, so none of them can reach a log (FRW-052 criterion 2).
 *
 * `append` must not return before the entry is written. The service refuses to seal when it throws,
 * so that no seal exists without a record of the request.
 */
export type AuditEvent =
  | 'seal.requested'
  | 'seal.sealed'
  | 'seal.refused'
  | 'seal.failed'
  // The signed, time-stamped chain head (FRW-054 criterion 3): the same four steps.
  | 'anchor.requested'
  | 'anchor.anchored'
  | 'anchor.refused'
  | 'anchor.failed'
  // Long-term validation and time-stamp renewal of a sealed PDF (FRW-056).
  | 'extend.requested'
  | 'extend.extended'
  | 'extend.refused'
  | 'extend.failed';

export interface AuditEntry {
  /** ISO 8601, from the service's clock. */
  readonly at: string;
  readonly event: AuditEvent;
  /** The caller the credential names; null when there was no valid credential. */
  readonly caller: string | null;
  readonly tenant: string | null;
  readonly documentId: string | null;
  readonly seq: number | null;
  /** Lower-case hexadecimal SHA-256 of the PDF that was asked to be sealed. */
  readonly pdfSha256: string | null;
  /** The key the sealing used, by identifier. */
  readonly keyId: string | null;
  /** SHA-256 of the sealed bytes, for `seal.sealed`. */
  readonly sealedSha256: string | null;
  /** The refusal or failure code, for `seal.refused` and `seal.failed`. */
  readonly code: string | null;
  /** The chain head of an anchor request (`anchor.*`); absent for a seal. */
  readonly chainHead?: string | null;
}

export interface AuditSink {
  append(entry: AuditEntry): void | Promise<void>;
}

/** One JSON object per line, to a writer the deployment supplies (a file, a stream, a log agent). */
export class JsonLinesAudit implements AuditSink {
  readonly #write: (line: string) => void | Promise<void>;
  constructor(write: (line: string) => void | Promise<void>) {
    this.#write = write;
  }
  async append(entry: AuditEntry): Promise<void> {
    await this.#write(`${JSON.stringify(entry)}\n`);
  }
}

/** Keeps the entries in memory, for tests. */
export class MemoryAudit implements AuditSink {
  readonly entries: AuditEntry[] = [];
  append(entry: AuditEntry): void {
    this.entries.push(entry);
  }
}
