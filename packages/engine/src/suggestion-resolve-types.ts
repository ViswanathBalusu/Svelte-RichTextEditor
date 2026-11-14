/**
 * The types of accepting and rejecting suggestions (FE-047). They live apart from
 * `suggestion-resolve.ts` and `suggestion-resolve-block.ts`, which import each other, so that the
 * two modules form no cycle.
 *
 * Universal logic over ProseMirror state only: no Node.js or browser API.
 */

export type ResolveAction = 'accept' | 'reject';

export interface ResolveScope {
  readonly from: number;
  readonly to: number;
  /** Only the suggestions whose `user` is this name; absent means every author (FE-047 criterion 5). */
  readonly author?: string;
  /** Whether the text in `[from, to)` may change for this user. Absent means it may. */
  readonly editable?: (from: number, to: number) => boolean;
}
