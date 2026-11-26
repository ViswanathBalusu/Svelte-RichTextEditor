/**
 * EXP-065 criterion 4: the list of diagnostic codes is published in the machine-readable artifacts
 * and versioned with the class. Node only; reads spec/export/diagnostic-codes-1.json.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLASS_VERSION, DIAGNOSTIC_CODES } from '@docedit/export-latex';
import { CODES } from './diagnostics.ts';
import { type diagnosticCodesArtifact, diagnosticCodesFile } from './exp-065-codes-artifact.ts';

const published = new URL('../../../spec/export/diagnostic-codes-1.json', import.meta.url);

describe('EXP-065 criterion 4: published diagnostic codes', () => {
  it('the published file is the one the catalogue gives (regenerate with scripts/write-diagnostic-codes.ts)', () => {
    expect(readFileSync(published, 'utf8')).toBe(diagnosticCodesFile());
  });

  it('lists every code of the worker and of the converter, once, with its severity and message', () => {
    const artifact = JSON.parse(readFileSync(published, 'utf8')) as ReturnType<
      typeof diagnosticCodesArtifact
    >;
    const codes = artifact.codes.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual(
      [...Object.keys(CODES), ...Object.keys(DIAGNOSTIC_CODES)].sort(),
    );
    for (const entry of artifact.codes) {
      const source =
        entry.origin === 'worker'
          ? CODES[entry.code as keyof typeof CODES]
          : DIAGNOSTIC_CODES[entry.code as keyof typeof DIAGNOSTIC_CODES];
      expect(entry.severity).toBe(source.severity);
      expect(entry.message).toBe(source.message);
    }
  });

  it('does not give one code to both origins', () => {
    const worker = new Set(Object.keys(CODES));
    expect(Object.keys(DIAGNOSTIC_CODES).filter((c) => worker.has(c))).toEqual([]);
  });

  it('lists the families of codes that share a shape', () => {
    const artifact = JSON.parse(readFileSync(published, 'utf8')) as ReturnType<
      typeof diagnosticCodesArtifact
    >;
    expect(artifact.patterns.map((p) => p.pattern)).toEqual(['<mark>_plain']);
  });

  it('carries the house class version the codes belong to', () => {
    const artifact = JSON.parse(readFileSync(published, 'utf8')) as { classVersion: string };
    expect(artifact.classVersion).toBe(CLASS_VERSION);
  });
});
