/**
 * The shell's dialogs (language, region, comment, export, math editor, name a version), gathered so that they build as one
 * chunk. The shell loads it with a dynamic `import()` the first time a dialog opens; none of them
 * is needed for the first interaction (13 §9; FE-002).
 */
export { default as AltTextDialog } from './AltTextDialog.svelte';
export { default as CommentBox } from './CommentBox.svelte';
export { default as ExportDialog } from './ExportDialog.svelte';
export { default as LanguageDialog } from './LanguageDialog.svelte';
export { default as MathEditorDialog } from './MathEditorDialog.svelte';
export { default as RegionDialog } from './RegionDialog.svelte';
export { default as SendDialog } from './SendDialog.svelte';
export { default as VersionDialog } from './VersionDialog.svelte';
