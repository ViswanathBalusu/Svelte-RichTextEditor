/**
 * Versions the element carries (05 §8; FE-001; ADR 0039).
 *
 * - The embedding API version (`DocEditorElement.version`) names the contract with the host page:
 *   attributes, properties, methods and events. It is separate from the protocol version (DEP 1.0)
 *   and changes only when that contract changes. Major 0: not frozen.
 * - The release (`DocEditorElement.release`) is this package's version. Two classes on one page
 *   are the same element only when both values match; otherwise the module warns (FE-001).
 */
export const EMBEDDING_VERSION = '0.1';

/** Kept equal to `version` in package.json (test/version.test.ts). */
export const RELEASE = '0.0.0';
