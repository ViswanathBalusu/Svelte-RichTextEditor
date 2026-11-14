/**
 * The rules of the review tools over suggestions (UX-036 criteria 1 and 3, UX-037 criterion 2;
 * 07 §5.2 P4, 08 §14).
 *
 * Accept and reject change the text, so they need `edit` in the suggestion's scope; a user with
 * `suggest` alone may only make suggestions (07 §5.2). The transforms themselves are FE-047's and
 * the commit is the core's; this module decides what is offered and in which order the items come.
 */
import type { Capability } from '../core-api.ts';

/** The commit origins a review action records (08 §14; protocol `Origin`). */
export const ACCEPT_ORIGIN = 'suggestion.accept';
export const REJECT_ORIGIN = 'suggestion.reject';

/** Which review actions the user is offered on one suggestion. */
export interface ReviewOffers {
  readonly accept: boolean;
  readonly reject: boolean;
}

/**
 * Accept and reject are offered where the user holds `edit` in the suggestion's scope. A user with
 * `suggest` but not `edit` gets neither, for other people's suggestions and for their own (UX-036
 * criterion 3). The spec does not say whether an `edit` user may act on their own suggestion; this
 * function offers it, as for any other suggestion (open, see the story's Notes).
 */
export function reviewOffers(caps: readonly Capability[]): ReviewOffers {
  const may = caps.includes('edit');
  return { accept: may, reject: may };
}

/**
 * The next or previous suggestion, by index, wrapping at the ends (UX-036 criterion 1). With no
 * current item, next gives the first and previous gives the last. Returns null when there are none.
 */
export function stepSuggestion(
  count: number,
  current: number | null,
  direction: 'next' | 'previous',
): number | null {
  if (count <= 0) return null;
  if (current === null || current < 0 || current >= count) {
    return direction === 'next' ? 0 : count - 1;
  }
  if (direction === 'next') return current + 1 >= count ? 0 : current + 1;
  return current - 1 < 0 ? count - 1 : current - 1;
}

export type SuggestionKind = 'insertion' | 'deletion' | 'formatting' | 'block';

/** One suggestion as the review pane lists it. `position` is the document order the core gives. */
export interface SuggestionRow {
  readonly id: string;
  readonly kind: SuggestionKind;
  /** The author's identifier, a person or an assistant (UX-046); both are plain identifiers here. */
  readonly author: string;
  /** The server time of the commit that introduced the suggestion (08 §14). */
  readonly committedAt: string;
  readonly excerpt: string;
  readonly position: number;
}

/**
 * The suggestions the pane lists: only the chosen author's when an author is given, in document
 * order (UX-037 criterion 2). Assistant authors are filtered like any other author. Ties keep the
 * order given. The input is not changed.
 */
export function listSuggestions<T extends SuggestionRow>(
  rows: readonly T[],
  author: string | null = null,
): T[] {
  return rows
    .filter((r) => author === null || r.author === author)
    .map((r, index) => ({ r, index }))
    .sort((a, b) => a.r.position - b.r.position || a.index - b.index)
    .map(({ r }) => r);
}
