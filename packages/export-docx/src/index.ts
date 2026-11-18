/**
 * `@docedit/export-docx`: DOCX import with the preservation layer and the package-patching DOCX
 * writer (ADR 0017). Universal: bytes in, bytes out, no file system and no network.
 *
 * Built on spike S11 (SPK-028, docs/spikes/2026-11-06-s11-lossless-docx.md); the decisions of the
 * phase 2 work are in docs/adr/0047-docx-import-and-writer-choices.md (proposed).
 */
export { importDocx, ImportError, labelFor, inexpressibleRevision } from './import.ts';
export type {
  ImportOptions,
  ImportResult,
  ImportStats,
  ImportReportItem,
  TreeStat,
} from './import.ts';
export { exportDocx, ExportError, relativeTarget } from './export.ts';
export type { AssetSource, ExportResult, ExportOptions, PartOutcome } from './export.ts';
export {
  AssetStore,
  readFragment,
  FRAGMENT_CONTENT_TYPE,
  SOURCE_MAP_CONTENT_TYPE,
  SERVER_ONLY_ROLES,
} from './assets.ts';
export type { Asset, AssetRole, Fragment, FragmentMeta } from './assets.ts';
export type {
  SourceMap,
  NodeSource,
  DefSource,
  ContainerSource,
  SuggestionSource,
} from './source-map.ts';
export {
  readZip,
  writeZip,
  entryData,
  rawData,
  crc32,
  ZipError,
  DEFAULT_ZIP_LIMITS,
} from './zip.ts';
export type { ZipArchive, ZipEntry, ZipLimits, ZipWriteEntry } from './zip.ts';
export { parseXml, canonical, nameOf, XmlError } from './xml.ts';
export type { XmlDocument, XmlElement, XmlNode } from './xml.ts';
export { pname, splitPname, registeredPrefix } from './names.ts';
export { decodeUtf8, Utf8Error } from './utf8.ts';
export { checkPreserved, PRESERVED_GRAMMAR, treeDepth, canonicalTree } from './tree.ts';
export type { TreeBody, TreeElement, TreeNode, TreeRef } from './tree.ts';
export { shareTrees, sharedTrees, worthSharing } from './share.ts';
export { payloadDigests, payloads, untrustedPayloads } from './integrity.ts';
export type { Payload, PayloadKind, Untrusted } from './integrity.ts';
export { modelledHash, modelledAttributes } from './origin.ts';
export type { Origin } from './origin.ts';
export {
  NS,
  REGENERATED,
  MARKERS,
  IDENTITY_ATTRS,
  IDENTITY_ELEMENTS,
  RUN_CONTENT,
  SMALL_ATOMS,
  INEXPRESSIBLE_REVISIONS,
} from './ooxml.ts';
export { checkR0, checkR1, diffParts, danglingTargets } from './conformance.ts';
export type { PartDiff, R1Edit, R1Result } from './conformance.ts';
export {
  scriptedEdits,
  typeText,
  split,
  deleteBlock,
  restyle,
  moveAtom,
  everyParagraph,
  atomCanonical,
} from './edits.ts';
export type { ScriptedEdit, SkippedEdit } from './edits.ts';
export { NodeHasher } from './hash.ts';
export { jobWarnings } from './job-warnings.ts';
export type { JobWarning } from './job-warnings.ts';
