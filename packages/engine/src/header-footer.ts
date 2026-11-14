/**
 * Header and footer variants, and the page-number field (FE-057 criteria 1 to 3; 03 §4.1, §4.4,
 * §8; 07 §5.3).
 *
 * - The variants a page setup uses are `default` always, `first` when `differentFirstPage` is on and
 *   `even` when `differentOddEven` is on. Each variant names one story through the page setup's
 *   `headerDefault`, `headerFirst`, `headerEven` (and the footer equivalents) attributes.
 * - A variant without a story is created by `createVariantStory`: a new story holding one empty
 *   paragraph, inserted before the body, and the page setup's attribute set to it, in one
 *   transaction. The caller passes the identifier (16 URL-safe characters, I2), so this module does
 *   not generate random values. The change goes through the region guard like any local change.
 * - `insertPageNumber` inserts a `field` node of kind `page` at the selection, and only inside a
 *   header or footer story (FE-057 criterion 3).
 *
 * The panel itself (the tabs of variants, focus, keyboard) is the view's, not this module's.
 */
import type { Node as PMNode, Schema } from 'prosemirror-model';
import type { Command, EditorState, Transaction } from 'prosemirror-state';

export type StoryPart = 'header' | 'footer';
export type StoryVariant = 'default' | 'first' | 'even';

const ATTRIBUTE: Record<StoryPart, Record<StoryVariant, string>> = {
  header: { default: 'headerDefault', first: 'headerFirst', even: 'headerEven' },
  footer: { default: 'footerDefault', first: 'footerFirst', even: 'footerEven' },
};

/** The page setup's attribute that names the story of a part and a variant (03 §4.1). */
export function variantAttribute(part: StoryPart, variant: StoryVariant): string {
  return ATTRIBUTE[part][variant];
}

/** The variants a page setup uses, in the order the panel offers them. */
export function variantsInUse(pageSetup: PMNode): StoryVariant[] {
  const out: StoryVariant[] = ['default'];
  if (pageSetup.attrs['differentFirstPage'] === true) out.push('first');
  if (pageSetup.attrs['differentOddEven'] === true) out.push('even');
  return out;
}

/** Position of the page setup definition with identifier `id`, or null. */
function pageSetupNode(doc: PMNode, id: string): { pos: number; node: PMNode } | null {
  let found: { pos: number; node: PMNode } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === 'page_setup' && node.attrs['id'] === id) found = { pos, node };
    return found === null;
  });
  return found;
}

/** The story a variant names, or null when the variant has no story yet (or no page setup). */
export function storyOfVariant(
  doc: PMNode,
  pageSetupId: string,
  part: StoryPart,
  variant: StoryVariant,
): string | null {
  const found = pageSetupNode(doc, pageSetupId);
  const id = found?.node.attrs[variantAttribute(part, variant)];
  return typeof id === 'string' ? id : null;
}

/**
 * Creates the story of a variant that has none (FE-057 criterion 2): a new header or footer story
 * with one empty paragraph, placed before the body, and the page setup's attribute set to its
 * identifier. Returns null when the page setup or the body is missing, or the variant already has a
 * story (the caller then edits that one). `storyId` must be a new 16-character identifier.
 */
export function createVariantStory(
  state: EditorState,
  pageSetupId: string,
  part: StoryPart,
  variant: StoryVariant,
  storyId: string,
): Transaction | null {
  const { schema, doc } = state;
  const setup = pageSetupNode(doc, pageSetupId);
  if (!setup || storyOfVariant(doc, pageSetupId, part, variant) !== null) return null;
  let bodyPos: number | null = null;
  doc.forEach((child, offset) => {
    if (bodyPos === null && child.type.name === 'body') bodyPos = offset;
  });
  if (bodyPos === null) return null;
  const story = schema.nodes['story']!.create(
    { id: storyId, kind: part },
    schema.nodes['paragraph']!.create(),
  );
  const tr = state.tr.insert(bodyPos, story);
  // The page setup sits before the body, so its position is unchanged by the insertion.
  tr.setNodeAttribute(setup.pos, variantAttribute(part, variant), storyId);
  return tr;
}

/**
 * Whether the selection lies inside a story (header or footer). A sub-editor's document is the
 * story itself, so the story can be the root (depth 0), as well as an ancestor in the main document.
 */
function insideStory(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 0; d--) if ($from.node(d).type.name === 'story') return true;
  return false;
}

/**
 * Inserts a page-number field at the selection (FE-057 criterion 3). It refuses outside a header
 * or footer story, where the page setup's panel is the only place the field is offered.
 */
export function insertPageNumber(schema: Schema): Command {
  return (state, dispatch) => {
    if (!insideStory(state) || !state.selection.$from.parent.inlineContent) return false;
    const field = schema.nodes['field']!.create({ kind: 'page' });
    if (!state.selection.$from.parent.type.contentMatch.matchType(field.type)) return false;
    if (dispatch) dispatch(state.tr.replaceSelectionWith(field).scrollIntoView());
    return true;
  };
}
