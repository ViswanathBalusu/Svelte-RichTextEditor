/**
 * The published list of diagnostic codes (EXP-065 criterion 4).
 *
 * The list is built from the worker's catalogue `CODES` in `diagnostics.ts` and the converter's
 * `DIAGNOSTIC_CODES` (`packages/export-latex/src/diagnostic-codes.ts`: the converter and the HTML and
 * Markdown writers) and written to
 * `spec/export/diagnostic-codes-1.json`, which carries the house class version it belongs to.
 * `scripts/write-diagnostic-codes.ts` writes the file; `exp-065-codes-artifact.test.ts` fails when
 * the file is not the one this builder gives, so the published list cannot drift from the code.
 */
import {
  CLASS_VERSION,
  DIAGNOSTIC_CODE_PATTERNS,
  DIAGNOSTIC_CODES,
  type DiagnosticCodeInfo,
} from '@docedit/export-latex';
import { CODES } from './diagnostics.ts';

export interface DiagnosticCodeEntry {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  /** Which part writes the code: the export worker, or the converter and its direct writers. */
  readonly origin: 'worker' | 'converter';
  /** Where it appears, or when its severity differs. */
  readonly note?: string;
}

/** A family of codes that share a shape, such as `<mark>_plain`. */
export interface DiagnosticCodePattern {
  readonly pattern: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
  readonly origin: 'converter';
  readonly note?: string;
}

export interface DiagnosticCodesArtifact {
  readonly artifact: 'export-diagnostic-codes';
  readonly version: 1;
  readonly classVersion: string;
  readonly codes: readonly DiagnosticCodeEntry[];
  readonly patterns: readonly DiagnosticCodePattern[];
}

/**
 * The artifact for the current catalogues, codes sorted by name so that the file is stable. A code
 * must belong to one origin only: the two catalogues share no name.
 */
export function diagnosticCodesArtifact(): DiagnosticCodesArtifact {
  const worker: DiagnosticCodeEntry[] = Object.keys(CODES).map((code) => {
    const entry = CODES[code as keyof typeof CODES];
    return { code, severity: entry.severity, message: entry.message, origin: 'worker' };
  });
  const converter: DiagnosticCodeEntry[] = Object.entries(DIAGNOSTIC_CODES).map(([code, e]) => {
    const info = e as DiagnosticCodeInfo;
    return {
      code,
      severity: info.severity,
      message: info.message,
      origin: 'converter',
      ...(info.note ? { note: info.note } : {}),
    };
  });
  const codes = [...worker, ...converter].sort((a, b) =>
    a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
  const patterns: DiagnosticCodePattern[] = DIAGNOSTIC_CODE_PATTERNS.map((p) => ({
    pattern: p.pattern,
    severity: p.severity,
    message: p.message,
    origin: 'converter',
    ...(p.note ? { note: p.note } : {}),
  }));
  return {
    artifact: 'export-diagnostic-codes',
    version: 1,
    classVersion: CLASS_VERSION,
    codes,
    patterns,
  };
}

/** The file content as written to disk: two-space JSON with a final newline. */
export function diagnosticCodesFile(): string {
  return `${JSON.stringify(diagnosticCodesArtifact(), null, 2)}\n`;
}
