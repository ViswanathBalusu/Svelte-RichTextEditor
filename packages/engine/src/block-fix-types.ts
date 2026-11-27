/**
 * The type of a fix for an accessibility issue (UX-067 criterion 2), apart from the command that makes
 * it so that the API can name it without a cycle. See block-fix.ts.
 */

/** What the author gives to repair one issue. */
export type BlockFix =
  | { readonly fix: 'alt-text'; readonly text: string }
  | { readonly fix: 'table-header' }
  | { readonly fix: 'link-text'; readonly text: string; readonly index: number }
  | { readonly fix: 'heading-level'; readonly level: number }
  | { readonly fix: 'text-colour'; readonly colour: string };
