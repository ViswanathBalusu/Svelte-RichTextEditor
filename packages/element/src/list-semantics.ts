/**
 * ARIA list semantics for numbered and bulleted paragraphs (02 §10; 03 §4.3; FE-105).
 *
 * The rules live in the engine (`@docedit/engine/headless`, list-semantics.ts), because the web
 * view that applies them to the paragraphs is the engine's (view/list-view.ts). This module keeps
 * the element's name for them.
 */
export {
  listSemantics,
  type ListItemSemantics,
  type ListParagraph,
} from '@docedit/engine/headless';
