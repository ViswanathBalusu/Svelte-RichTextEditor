/**
 * EXP-120, criterion 3: how the corpus tests report a failure of the lossless contract. Each line
 * names the file, the part and the first differing element, so that a failure in CI can be read
 * without a rerun. The corpus tests compare these lines with an empty list.
 */
import type { PartDiff } from '../src/index.ts';

/** The lines of an R0 failure: one per changed part (with its first differing element), missing part and added part. */
export function r0Failures(
  file: string,
  r0: { diff: PartDiff; differences: readonly string[] },
): string[] {
  return [
    // `differences` is "<part>: <path of the first differing element>".
    ...r0.differences.map((d) => `${file}: R0, part ${d}`),
    ...r0.diff.missing.map((p) => `${file}: R0, part ${p} is missing from the export`),
    ...r0.diff.added.map((p) => `${file}: R0, part ${p} was added by the export`),
  ];
}

/** The lines of an R1 failure, each led by the file and the edit. */
export function r1Failures(file: string, edit: string, violations: readonly string[]): string[] {
  return violations.map((v) => `${file}: R1 after "${edit}", ${v}`);
}
