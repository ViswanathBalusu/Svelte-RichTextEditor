/**
 * Range mapping (SYN-001 `mapRanges`): comment ranges kept outside the document (07 §6; ADR 0015)
 * and presence selections (04 §11) are mapped through the step maps of every commit. A range whose
 * content is deleted collapses; the caller shows such a thread as detached.
 */
import type { Schema } from 'prosemirror-model';
import { Mapping, Step, type StepMap } from 'prosemirror-transform';

export interface Range {
  from: number;
  to: number;
}

export interface MappedRange extends Range {
  /** True when everything the range covered was deleted. */
  collapsed: boolean;
}

/**
 * Maps ranges through stored commits as the log holds them (their step JSON), with no document
 * (SYN-032 criterion 4): comment anchors and presence positions alike. A snapshot commit replaces
 * the document, so every range collapses at 0 across it.
 */
export function mapRangesThrough(
  ranges: readonly Range[],
  commits: ReadonlyArray<{ kind?: string; steps: readonly unknown[] }>,
  schema: Schema,
): MappedRange[] {
  let out: MappedRange[] = ranges.map((r) => ({ ...r, collapsed: r.to <= r.from }));
  for (const c of commits) {
    if (c.kind === 'snapshot') {
      out = out.map(() => ({ from: 0, to: 0, collapsed: true }));
      continue;
    }
    const maps = c.steps.map((s) => Step.fromJSON(schema, s).getMap());
    out = mapRanges(out, maps).map((m, i) => ({
      ...m,
      collapsed: m.collapsed || out[i]!.collapsed,
    }));
  }
  return out;
}

export function mapRanges(ranges: readonly Range[], maps: readonly StepMap[]): MappedRange[] {
  const mapping = new Mapping([...maps]);
  return ranges.map((r) => {
    if (r.to < r.from) return { from: r.from, to: r.from, collapsed: true };
    const from = mapping.mapResult(r.from, 1);
    const to = mapping.mapResult(r.to, -1);
    if (to.pos <= from.pos) return { from: from.pos, to: from.pos, collapsed: true };
    return { from: from.pos, to: to.pos, collapsed: false };
  });
}
