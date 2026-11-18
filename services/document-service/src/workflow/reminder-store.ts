/**
 * The count of scheduled reminders raised for each participant (FRW-034 criteria 2 and 5). The
 * workflow resource keeps no such count, because it changes on its own clock and a write to the
 * resource would race with a transition; this store holds it apart. `MemoryReminderStore` serves
 * tests and the memory build; `PgReminderStore` (reminder-store-pg.ts, migration 0076) the real one.
 *
 * A count belongs to one activation: the key includes the `anchorMs` the participant became active
 * at. A participant activated again has a later anchor and starts from zero.
 */

export interface ReminderStore {
  /** The number of the last reminder raised for this activation; 0 when none (or another anchor). */
  raised(tenant: string, doc: string, participant: string, anchorMs: number): Promise<number>;
  /**
   * Moves the count from `expected` to `next` (greater) for the activation at `anchorMs`, as one
   * atomic step. Of any number of callers that pass the same `expected`, at most one gets true: that
   * one raises the reminders `expected + 1` to `next`.
   */
  claim(
    tenant: string,
    doc: string,
    participant: string,
    anchorMs: number,
    expected: number,
    next: number,
  ): Promise<boolean>;
}

export class MemoryReminderStore implements ReminderStore {
  readonly #rows = new Map<string, { anchorMs: number; raised: number }>();

  raised(tenant: string, doc: string, participant: string, anchorMs: number): Promise<number> {
    const row = this.#rows.get(`${tenant}/${doc}/${participant}`);
    return Promise.resolve(row !== undefined && row.anchorMs === anchorMs ? row.raised : 0);
  }

  claim(
    tenant: string,
    doc: string,
    participant: string,
    anchorMs: number,
    expected: number,
    next: number,
  ): Promise<boolean> {
    if (!(next > expected)) return Promise.resolve(false);
    const key = `${tenant}/${doc}/${participant}`;
    const row = this.#rows.get(key);
    const current = row !== undefined && row.anchorMs === anchorMs ? row.raised : 0;
    // A later anchor starts again from zero; an earlier one belongs to an activation that is over.
    if (row !== undefined && row.anchorMs > anchorMs) return Promise.resolve(false);
    if (current !== expected) return Promise.resolve(false);
    this.#rows.set(key, { anchorMs, raised: next });
    return Promise.resolve(true);
  }
}
