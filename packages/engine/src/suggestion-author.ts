/**
 * The author of a suggestion (FE-045): the user making it and the source of fresh suggestion
 * identifiers. It lives apart from `suggestion-edit.ts`, which imports `suggestion-block.ts`, so
 * that the block module can name the type without a cycle.
 *
 * Universal logic over ProseMirror state only: no Node.js or browser API.
 */

/** The user making the suggestion and the source of fresh suggestion identifiers. */
export interface SuggestionAuthor {
  readonly user: string;
  readonly nextId: () => string;
}
