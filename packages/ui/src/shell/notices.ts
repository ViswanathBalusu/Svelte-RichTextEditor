/**
 * Notices for changes that did not happen (11 §3 exit check; 07 §7, §9; FE-036; UX-017): a local
 * change the region guard refused, and work the server rejected or the client set aside. Each is
 * explained in plain words from the string tables, and none names a region, a value or any other
 * content, so nothing hidden from the reader leaks through a notice (ADR 0019).
 *
 * `NoticeTracker` compares successive values of the core's `refusal` and `recovered` views and
 * reports what is new: a refusal whose `n` changed, and items added to the recovered list.
 */
import type { RecoveredEdits, RefusalNotice, TrimNotice } from '../core-api.ts';
import type { StringKey } from '../i18n/en-GB.ts';

export interface Notice {
  readonly kind: 'refusal' | 'rejection' | 'trimmed';
  /** The message, in plain words. */
  readonly key: StringKey;
  /** For rejections: the number of items set aside in this change. */
  readonly count: number;
  /** Increases with every notice, so that the same message twice is shown and announced twice. */
  readonly serial: number;
  /** A named command of the core that the notice offers (a button next to the message), if any. */
  readonly action?: 'showReferences';
}

const REFUSALS: Readonly<Record<string, StringKey>> = {
  scope: 'notice.refused.scope',
  structure: 'notice.refused.structure',
  manage: 'notice.refused.manage',
  'read-only': 'notice.refused.readOnly',
  placeholder: 'notice.refused.placeholder',
  redacted: 'notice.refused.redacted',
  identifier: 'notice.refused.identifier',
  step: 'notice.refused.step',
  invariant: 'notice.refused.invariant',
  // A copy the output restriction refused (UX-040 criterion 2): the user is told why, and that
  // nothing was copied; a copy is not a change, so the general "change not made" words do not fit.
  'no-copy': 'notice.refused.noCopy',
  // A deletion a cross-reference still names (I4; FE-133 criterion 5): the notice offers to show them.
  referenced: 'notice.refused.referenced',
};

const REJECTIONS: Readonly<Record<string, StringKey>> = {
  permission_denied: 'notice.rejected.permission',
  forbidden: 'notice.rejected.permission',
  read_only: 'notice.rejected.readOnly',
  invalid_op: 'notice.rejected.invalid',
  conflict: 'notice.rejected.conflict',
  field_invalid: 'notice.rejected.field',
  too_large: 'notice.rejected.tooLarge',
  rebase: 'notice.rejected.rebase',
  rebase_failed: 'notice.rejected.rebase',
  stale: 'notice.rejected.rebase',
  stale_base: 'notice.rejected.rebase',
  reload: 'notice.rejected.reload',
  reset: 'notice.rejected.reload',
};

/** The message for a refusal code of the region guard; an unknown code gets the general one. */
export function refusalKey(reason: string): StringKey {
  return REFUSALS[reason] ?? 'notice.refused.other';
}

/** The message for a rejection or set-aside reason (05 §5.8; 04 §8). */
export function rejectionKey(reason: string): StringKey {
  return REJECTIONS[reason] ?? 'notice.rejected.other';
}

export class NoticeTracker {
  #refusal: number | null;
  #recovered: number;
  #trimmed: number | null;
  #serial = 0;

  constructor(
    refusal: RefusalNotice | null | undefined,
    recovered: RecoveredEdits | undefined,
    trimmed?: TrimNotice | null,
  ) {
    // What was there before the shell started is not news.
    this.#refusal = refusal?.n ?? null;
    this.#recovered = recovered?.count ?? 0;
    this.#trimmed = trimmed?.n ?? null;
  }

  /**
   * A notice for a deletion the core trimmed since the last call (FE-037 criterion 2), or null. The
   * count is the number of scopes kept; the notice names none of them (ADR 0019).
   */
  trimmed(next: TrimNotice | null | undefined): Notice | null {
    if (!next || typeof next.n !== 'number' || next.n === this.#trimmed) return null;
    this.#trimmed = next.n;
    return {
      kind: 'trimmed',
      key: 'notice.trimmed.kept',
      count: next.skipped.length,
      serial: ++this.#serial,
    };
  }

  /** A notice for a refusal the guard has not reported before, or null. */
  refusal(next: RefusalNotice | null | undefined): Notice | null {
    if (!next || typeof next.n !== 'number' || next.n === this.#refusal) return null;
    this.#refusal = next.n;
    // Suggestions a resolve command skipped are counted and named as such (FE-047 criterion 6).
    const skipped = next.count;
    const counted = next.reason === 'scope' && typeof skipped === 'number' && skipped > 0;
    // A deletion a reference still names: the count is the number of references, and the notice
    // offers to show them.
    if (next.reason === 'referenced') {
      return {
        kind: 'refusal',
        key: refusalKey('referenced'),
        count: typeof skipped === 'number' && skipped > 0 ? skipped : 1,
        serial: ++this.#serial,
        action: 'showReferences',
      };
    }
    return {
      kind: 'refusal',
      key: counted ? 'notice.suggestions.skipped' : refusalKey(String(next.reason)),
      count: counted && skipped !== undefined ? skipped : 1,
      serial: ++this.#serial,
    };
  }

  /** A notice for items added to the recovered list since the last call, or null. */
  recovered(next: RecoveredEdits | undefined): Notice | null {
    const count = next?.count ?? 0;
    const before = this.#recovered;
    this.#recovered = count;
    // Fewer items: the author discarded or inserted some, which is not news.
    if (!next || count <= before) return null;
    const added = next.items.slice(before);
    const first = added[0];
    const reason = first?.reason ?? '';
    // A fill that lost to another change of the same field is told in the field's own words
    // (FRW-010 criterion 5); the notice names no field and no value (ADR 0019).
    const fieldConflict = reason === 'conflict' && (first?.fields?.length ?? 0) > 0;
    return {
      kind: 'rejection',
      key: fieldConflict ? 'notice.rejected.fieldConflict' : rejectionKey(String(reason)),
      count: count - before,
      serial: ++this.#serial,
    };
  }
}
