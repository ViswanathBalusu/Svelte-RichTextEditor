/**
 * `@docedit/export-worker`: the export worker (09 §9). It takes `export` jobs from the control
 * plane's queue, converts the content at the job's `seq`, compiles the bundle in a single-use
 * LuaLaTeX sandbox (Podman; DOCEDIT_CONTAINER_CLI overrides the binary) and stores the outputs.
 * The process entry is `src/main.ts` (`pnpm --filter @docedit/export-worker start`); ADR 0045.
 */
export {
  containerCli,
  containerExists,
  defaultMountsFile,
  imageId,
  killContainer,
  podman,
  podmanCommand,
  podmanInfo,
  podmanMachine,
  run,
} from './container.ts';
export type { PodmanInfo, RunOptions, RunResult } from './container.ts';
export {
  compileInSandbox,
  IMAGE,
  LIMITS,
  LOG_LINE_UNWRAPPED,
  runInSandbox,
  sandboxArgs,
} from './sandbox.ts';
export type { CompileResult, Limits, Pass, SandboxOptions } from './sandbox.ts';
export { sandboxReady } from './sandbox-ready.ts';
export type { Readiness } from './sandbox-ready.ts';
export { compileLocally } from './local.ts';
export type { LocalOptions } from './local.ts';
export {
  buildLayout,
  LAYOUT_SCHEMA,
  LayoutError,
  parseRawLayout,
  validateLayout,
} from './layout.ts';
export type { LayoutBlock, LayoutJson, LayoutPage, OpensWith } from './layout.ts';
export { validatePdf, VERAPDF_IMAGE } from './verapdf.ts';
export type { Flavour, RuleFailure, Validation } from './verapdf.ts';
export { buildBundle, classFiles, compileFiles, readFontManifest } from './bundle-io.ts';
export { runExport } from './pipeline.ts';
export type { ExportResult, Where } from './pipeline.ts';
export { readTar, writeTar } from './tar.ts';
export { blockOfLine, CODES, diagnostic, LOG_LIMITS, parseLog, plain } from './diagnostics.ts';
export type { Code, LogLimits, ParsedLog } from './diagnostics.ts';
export { limitDiagnostic, limitMessage, limitReached } from './outcome.ts';
export type { LimitName } from './outcome.ts';
export { BUNDLE_FILES, checkSeal, sealBundle, verifyBundle } from './verify.ts';
export type { Pinned } from './verify.ts';
export {
  DEFAULT_LOCALE,
  DEFAULT_TIME_ZONE,
  FINAL_PASSES,
  formatJobDate,
  planJob,
} from './profile.ts';
export type { JobPlan, PlanResult, Profile } from './profile.ts';
export { contentAt, documentLang } from './content.ts';
export type { Content, ContentStores } from './content.ts';
export { imageFontManifest } from './fonts.ts';
export { createExportHandler, OUTPUT_FILES } from './job.ts';
export type { ExportHandlerDeps, ExportMetrics, ExportOutputStore } from './job.ts';
export { createExportWorker, EXPORT_JOB_KINDS, exportJobHandlers } from './worker.ts';
export type { ExportWorker, ExportWorkerOptions } from './worker.ts';
