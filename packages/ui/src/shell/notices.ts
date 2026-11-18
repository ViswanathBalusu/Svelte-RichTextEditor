/**
 * Notices for changes that did not happen (11 §3 exit check; 07 §7, §9; FE-036; UX-017): a local
 * change the region guard refused, and work the server rejected or the client set aside. Each is
 * explained in plain words from the string tables, and none names a region, a value or any other
 * content, so nothing hidden from the reader leaks through a notice (ADR 0019).
 *
 * `NoticeTracker` compares successive values of the core's `refusal` and `recovered` views and
 * reports what is new: a refusal whose `n` changed, and items added to the recovered list.
 */
import type { RecoveredEdits, RefusalNotice, ReplaceNotice, TrimNotice } from '../core-api.ts';
import type { StringKey } from '../i18n/en-GB.ts';

export interface Notice {
  readonly kind: 'refusal' | 'rejection' | 'trimmed' | 'replaced';
  /** The message, in plain words. */
  readonly key: StringKey;
  /** For rejections: the number of items set aside in this change. */
  readonly count: number;
  /** Further numbers the message names (for a replace report, `skipped`). */
  readonly params?: Readonly<Record<string, number | string>>;
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
  // A change that suggestion mode cannot record as a suggestion (FE-045 criterion 5).
  suggestion: 'notice.refused.suggestion',
  // A deletion a cross-reference still names (I4; FE-133 criterion 5): the notice offers to show them.
  referenced: 'notice.refused.referenced',
  // A pasted picture that was not added (FE-053 criterion 3): the upload failed or was refused.
  'upload-failed': 'notice.refused.uploadFailed',
  'invalid-size': 'notice.refused.pictureSize',
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
  #replaced: number | null;
  #serial = 0;

  constructor(
    refusal: RefusalNotice | null | undefined,
    recovered: RecoveredEdits | undefined,
    trimmed?: TrimNotice | null,
    replaced?: ReplaceNotice | null,
  ) {
    // What was there before the shell started is not news.
    this.#refusal = refusal?.n ?? null;
    this.#recovered = recovered?.count ?? 0;
    this.#trimmed = trimmed?.n ?? null;
    this.#replaced = replaced?.n ?? null;
  }

  /**
   * The report of a Replace or Replace all since the last call (FE-060 criterion 3), or null. The
   * numbers are the core's, unchanged; the message about skipped matches is used only when at least
   * one was skipped, so a complete replace says nothing about skipping.
   */
  replaced(next: ReplaceNotice | null | undefined): Notice | null {
    if (!next || typeof next.n !== 'number' || next.n === this.#replaced) return null;
    this.#replaced = next.n;
    const skipped = next.skipped > 0;
    return {
      kind: 'replaced',
      key: skipped ? 'notice.replaced.skipped' : 'notice.replaced.done',
      count: next.replaced,
      params: { skipped: next.skipped },
      serial: ++this.#serial,
    };
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

  /**
   * A notice for a refusal the guard has not reported before, or null. `workflowLocked` is true while
   * a workflow locks the document: a read-only refusal then says why, in the workflow's words
   * (FRW-029 criterion 6).
   */
  refusal(next: RefusalNotice | null | undefined, workflowLocked = false): Notice | null {
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
    const key: StringKey =
      workflowLocked && next.reason === 'read-only'
        ? 'notice.refused.workflow'
        : counted
          ? 'notice.suggestions.skipped'
          : refusalKey(String(next.reason));
    return {
      kind: 'refusal',
      key,
      count: counted && skipped !== undefined ? skipped : 1,
      serial: ++this.#serial,
    };
  }

  /** A notice for items added to the recovered list since the last call, or null. */
  recovered(next: RecoveredEdits | undefined, workflowLocked = false): Notice | null {
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
    // A fill a rule of the document stopped is told in the rule's own words, or by its identifier
    // when it has none (FRW-023 criterion 5); a document's rule text is its author's, not a value.
    const rule = reason === 'permission_denied' ? first?.rule : undefined;
    const words = rule === undefined ? undefined : (rule.message ?? rule.id);
    return {
      kind: 'rejection',
      key: fieldConflict
        ? 'notice.rejected.fieldConflict'
        : rule !== undefined
          ? 'notice.rejected.rule'
          : workflowLocked && reason === 'read_only'
            ? 'notice.rejected.workflow'
            : rejectionKey(String(reason)),
      count: count - before,
      ...(words === undefined ? {} : { params: { rule: words } }),
      serial: ++this.#serial,
    };
  }
}
