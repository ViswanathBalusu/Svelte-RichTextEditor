/**
 * EXP-116, criterion 5 (the report part): the preservation report of every corpus file gives the
 * share of nodes that carry preserved data and the overhead against an import without
 * preservation. The job that calls it (EXP-098) is not built, so the criterion stays open.
 */
import { describe, expect, it } from 'vitest';
import { importDocx } from '../src/index.ts';
import { preservationReport } from '../src/preservation-report.ts';
import { corpusFiles, readFile } from './corpus.ts';

describe.each(corpusFiles())('$name', (file) => {
  it('reports a share between 0 and 1 and an overhead against the baseline without preservation', async () => {
    const bytes = readFile(file);
    const result = await importDocx(bytes);
    const report = await preservationReport(bytes, result);
    expect(report.nodes).toBeGreaterThan(0);
    expect(report.nodesWithPreserved).toBeGreaterThanOrEqual(0);
    expect(report.nodesWithPreserved).toBeLessThanOrEqual(report.nodes);
    expect(report.share).toBeGreaterThanOrEqual(0);
    expect(report.share).toBeLessThanOrEqual(1);
    expect(report.bytes).toBeGreaterThan(0);
    expect(report.baselineBytes).toBeGreaterThan(0);
    expect(report.overheadBytes).toBe(report.bytes - report.baselineBytes);
    expect(report.overhead).toBeCloseTo(report.overheadBytes / report.baselineBytes, 12);
  });
});

describe('preservation report on a file with preserved content', () => {
  it('reports a positive share and overhead for docx4j/chart.docx', async () => {
    const file = corpusFiles().find((f) => f.name === 'docx4j/chart.docx');
    expect(file).toBeDefined();
    const bytes = readFile(file!);
    const report = await preservationReport(bytes);
    expect(report.nodesWithPreserved).toBeGreaterThan(0);
    expect(report.share).toBeGreaterThan(0);
    expect(report.overheadBytes).toBeGreaterThan(0);
  });
});
