/**
 * `@docedit/export-latex`: the CDM to LaTeX converter (09). Pure and universal: a CDM envelope (the
 * requester's projection), a font manifest, the job's assets and options in; the bundle files,
 * `map.json` and `manifest.json` out. The house class lives in `class/` and is read by the caller
 * (the worker), because this package has no file system access.
 *
 * The shared layout semantics (cascade, labels, gaps, spaces, dates, references) come from
 * `@docedit/model` (ADR 0032); this package keeps no copy of them (EXP-002).
 */
export { convert, CLASS_VERSION, SUPPORTED_FEATURES } from './convert.ts';
export { bundleHashInput, canonicalJson } from './bundle-hash.ts';
export { appendCertificate, certificateBlocks, readCertificateFacts } from './certificate.ts';
export type {
  CertificateEvent,
  CertificateEventKind,
  CertificateFacts,
  CertificateParticipant,
} from './certificate.ts';
export type {
  AssetInput,
  Bundle,
  BundleManifest,
  ConvertOptions,
  Diagnostic,
  FallbackFace,
  FontFace,
  FontFamily,
  FontManifest,
  LayoutLevel,
  PdfStandard,
  Redaction,
  Renderer,
  SourceMap,
  Suggestions,
  Tagging,
} from './bundle.ts';
export { mathGate, mathGateReason, scanMath, MATH_LIMITS, DIMENSION_BOUNDS } from './math/gate.ts';
export type { GateResult } from './math/gate.ts';
export { ALLOW_LIST } from './math/allow-list.ts';
export {
  clean,
  color,
  dimen,
  EMITTERS,
  enumLookup,
  kvValue,
  pdfHexString,
  pdfString,
  text,
  textChunks,
  url,
} from './emit.ts';
export type { EmitterName, Tex } from './emit.ts';
export { ATTRIBUTE_EMITTERS } from './attributes.ts';
export { fontCoverage, covers, mergeRanges, FontFormatError } from './fonts/coverage.ts';
export type { CodeRange } from './fonts/coverage.ts';
export { preflight } from './preflight.ts';
export type { PreflightWarning } from './preflight.ts';
export { texArchive, archiveReadme, tar, CLASS_LICENCE } from './archive.ts';
export { PACKAGE_LICENCES, CLASS_LICENCE_TEXT, archiveLicenceManifest } from './licences.ts';
export type { PackageLicence } from './licences.ts';
export { latexWriter, cdmWriter } from './writer.ts';
export {
  markdownWriter,
  markdownText,
  type MarkdownOptions,
  type MarkdownOutput,
} from './markdown-writer.ts';
export { htmlWriter, htmlText, type HtmlOptions, type HtmlOutput } from './html-writer.ts';
export type { CanonicalJson, DocumentWriter, LatexWriterOptions, WriterInput } from './writer.ts';
export { computeCitations } from './citations.ts';
export { altTextReport, bundleAltTextReport, IMAGE_WITHOUT_ALT } from './alt-report.ts';
export type { AltTextReport } from './alt-report.ts';

/** File names of the house class inside `class/`, in the order the bundle lists them. */
export const CLASS_FILES = ['docedit.cls', 'docedit.lua'] as const;
