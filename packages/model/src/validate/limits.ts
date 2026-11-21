/**
 * The limits of a document (03 §8; I7, I15 and the invariants that count). A module of their own so
 * that code that only reads a limit (a command that refuses at it) does not take the validator with
 * it (FND-008).
 */
export const LIMITS = {
  canonicalBytes: 16 * 1024 * 1024,
  regions: 500,
  tableColumns: 63,
  depth: 12,
  basedOnDepth: 10,
  fields: 2000,
  rules: 500,
  fieldValueBytes: 4096,
  footnoteParagraphs: 1,
} as const;
