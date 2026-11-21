/**
 * The `authoring` part (`./parts.ts`; FND-008): the changes the roles, sources and fields panes
 * make to the document's definitions and to a form field. They check each value against the
 * grammars of the CDM definition, which is why they are not in the first load. The panes load this
 * part with the pane (`loadParts(['authoring'])`).
 *
 * The module reads no clock and no store. It is universal: no Node.js or browser API.
 */
export { editField } from './field-edit.ts';
export { editRole } from './role-edit.ts';
export { deleteSource } from './source-delete.ts';
export { addSource, updateSource } from './source-edit.ts';
