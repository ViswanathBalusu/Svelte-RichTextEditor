/**
 * The preservation share and overhead of one import, as a job would report them (EXP-116,
 * criterion 5). The job itself (EXP-098) is not built here; this module is the report it will
 * call, so the figures come from the same import the job runs.
 *
 * Definitions (proposed in docs/adr/0144-export-docx-2-backlog-batch.md, decision 1):
 * - `nodes`: every node the import created (`stats.nodes`, all kinds);
 * - `nodesWithPreserved`: nodes that carry preserved data, which is the residue of a property
 *   node, the `preserved` marks of text, and the preserved atoms and blocks;
 * - `bytes` and `baselineBytes`: the canonical text of the document with preservation and of the
 *   same file imported with `preserve: false`, both in UTF-8 bytes;
 * - `overheadBytes` is the difference, and `overhead` relates it to the baseline.
 *
 * Universal: it only reads the import result and calls `importDocx` again for the baseline.
 */
import { canonicalText, utf8 } from '@docedit/model';
import { importDocx, type ImportResult } from './import.ts';

export interface PreservationReport {
  /** Every node the import created. */
  nodes: number;
  /** Nodes that carry preserved data (see the module comment). */
  nodesWithPreserved: number;
  /** `nodesWithPreserved / nodes`, or null when the import created no nodes. */
  share: number | null;
  /** Canonical bytes of the document imported with preservation. */
  bytes: number;
  /** Canonical bytes of the same file imported with `preserve: false`. */
  baselineBytes: number;
  /** `bytes - baselineBytes`; negative values are reported as they are. */
  overheadBytes: number;
  /** `overheadBytes / baselineBytes`, or null when the baseline is empty. */
  overhead: number | null;
}

const sum = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((a, b) => a + b, 0);

/** The count of nodes that carry preserved data, from an import's statistics. */
export function nodesWithPreservedData(result: ImportResult): number {
  return (
    sum(result.stats.nodesWithPreserved) +
    sum(result.stats.preservedInline) +
    (result.stats.nodes['preserved_block'] ?? 0)
  );
}

/**
 * Builds the report from an import result and the same file imported without preservation. When
 * `result` is omitted, the file is imported here, once with preservation and once without.
 */
export async function preservationReport(
  bytes: Uint8Array,
  result?: ImportResult,
): Promise<PreservationReport> {
  const full = result ?? (await importDocx(bytes));
  const baseline = await importDocx(bytes, { preserve: false });
  const nodes = sum(full.stats.nodes);
  const nodesWithPreserved = nodesWithPreservedData(full);
  const bytesWith = utf8(canonicalText(full.envelope)).length;
  const baselineBytes = utf8(canonicalText(baseline.envelope)).length;
  const overheadBytes = bytesWith - baselineBytes;
  return {
    nodes,
    nodesWithPreserved,
    share: nodes === 0 ? null : nodesWithPreserved / nodes,
    bytes: bytesWith,
    baselineBytes,
    overheadBytes,
    overhead: baselineBytes === 0 ? null : overheadBytes / baselineBytes,
  };
}
