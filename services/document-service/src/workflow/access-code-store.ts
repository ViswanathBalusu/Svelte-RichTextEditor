/**
 * The registered access codes of workflow participants, and their wrong-attempt counters (12 §6.1,
 * §7; FRW-039). Only the salt and the hash of a code are stored (`AccessCodeRecord`); the code
 * itself never reaches a store. `MemoryAccessCodeStore` serves tests and the memory build;
 * `PgAccessCodeStore` (access-code-pg.ts, migration 0077) the real one.
 *
 * The limit on wrong attempts counts each attempt before the code is compared (`reserve`): the
 * count of the window moves by one, and an attempt over the limit is refused with the time left in
 * the window. A correct code (`clear`) and a new registration start the count again. The numbers
 * are the caller's policy (docs/adr/0393-w4-FRW-039-access-code.md, proposed).
 */
import type { AccessCodeRecord } from '@docedit/authority';

export interface AttemptPolicy {
  /** Attempts allowed in one window, the correct one included. */
  readonly maxAttempts: number;
  /** The length of a window in milliseconds, from its first attempt. */
  readonly windowMs: number;
}

/** What `reserve` found for one attempt. */
export type Reservation =
  | { readonly state: 'none' }
  | { readonly state: 'limited'; readonly retryAfterMs: number }
  | { readonly state: 'open'; readonly record: AccessCodeRecord };

export interface AccessCodeStore {
  /** Stores the hash of a participant's code, replacing an earlier one, and clears the counter. */
  register(
    tenant: string,
    doc: string,
    participant: string,
    record: AccessCodeRecord,
    atMs: number,
  ): Promise<void>;
  /** Counts one attempt and gives the record to compare with, unless the limit is reached. */
  reserve(
    tenant: string,
    doc: string,
    participant: string,
    atMs: number,
    policy: AttemptPolicy,
  ): Promise<Reservation>;
  /** Clears the counter after a correct code. */
  clear(tenant: string, doc: string, participant: string): Promise<void>;
}

/** The decision of `reserve` from the stored counter: shared by both stores' tests. */
export function judgeAttempt(
  failures: number,
  windowStartMs: number | null,
  atMs: number,
  policy: AttemptPolicy,
): { readonly failures: number; readonly windowStartMs: number; readonly limited: boolean } {
  const fresh = windowStartMs === null || atMs >= windowStartMs + policy.windowMs;
  const count = fresh ? 1 : failures + 1;
  const start = fresh ? atMs : windowStartMs;
  return { failures: count, windowStartMs: start, limited: count > policy.maxAttempts };
}

export class MemoryAccessCodeStore implements AccessCodeStore {
  readonly #rows = new Map<
    string,
    { record: AccessCodeRecord; failures: number; windowStartMs: number | null }
  >();

  register(
    tenant: string,
    doc: string,
    participant: string,
    record: AccessCodeRecord,
  ): Promise<void> {
    this.#rows.set(`${tenant}/${doc}/${participant}`, {
      record: { ...record },
      failures: 0,
      windowStartMs: null,
    });
    return Promise.resolve();
  }

  reserve(
    tenant: string,
    doc: string,
    participant: string,
    atMs: number,
    policy: AttemptPolicy,
  ): Promise<Reservation> {
    const row = this.#rows.get(`${tenant}/${doc}/${participant}`);
    if (row === undefined) return Promise.resolve({ state: 'none' });
    const j = judgeAttempt(row.failures, row.windowStartMs, atMs, policy);
    row.failures = j.failures;
    row.windowStartMs = j.windowStartMs;
    if (j.limited)
      return Promise.resolve({
        state: 'limited',
        retryAfterMs: Math.max(1, j.windowStartMs + policy.windowMs - atMs),
      });
    return Promise.resolve({ state: 'open', record: { ...row.record } });
  }

  clear(tenant: string, doc: string, participant: string): Promise<void> {
    const row = this.#rows.get(`${tenant}/${doc}/${participant}`);
    if (row !== undefined) {
      row.failures = 0;
      row.windowStartMs = null;
    }
    return Promise.resolve();
  }

  /** The stored rows as text, for the tests that look for the code in storage. */
  dump(): string {
    return JSON.stringify([...this.#rows.entries()]);
  }
}
