/**
 * The published list of diagnostic codes (EXP-065 criterion 4).
 *
 * The list is built from the catalogue `CODES` in `diagnostics.ts` and written to
 * `spec/export/diagnostic-codes-1.json`, which carries the house class version it belongs to.
 * `scripts/write-diagnostic-codes.ts` writes the file; `exp-065-codes-artifact.test.ts` fails when
 * the file is not the one this builder gives, so the published list cannot drift from the code.
 */
import { CLASS_VERSION } from '@docedit/export-latex';
import { CODES } from './diagnostics.ts';

export interface DiagnosticCodeEntry {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
}

export interface DiagnosticCodesArtifact {
  readonly artifact: 'export-diagnostic-codes';
  readonly version: 1;
  readonly classVersion: string;
  readonly codes: readonly DiagnosticCodeEntry[];
}

/** The artifact for the current catalogue, codes sorted by name so that the file is stable. */
export function diagnosticCodesArtifact(): DiagnosticCodesArtifact {
  const codes = Object.keys(CODES)
    .sort()
    .map((code) => {
      const entry = CODES[code as keyof typeof CODES];
      return { code, severity: entry.severity, message: entry.message };
    });
  return {
    artifact: 'export-diagnostic-codes',
    version: 1,
    classVersion: CLASS_VERSION,
    codes,
  };
}

/** The file content as written to disk: two-space JSON with a final newline. */
export function diagnosticCodesFile(): string {
  return `${JSON.stringify(diagnosticCodesArtifact(), null, 2)}\n`;
}
