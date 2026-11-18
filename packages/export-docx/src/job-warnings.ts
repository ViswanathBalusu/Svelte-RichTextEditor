/**
 * The warnings of an import as the import job returns them to the host (EXP-106 criterion 3,
 * EXP-107 criterion 4).
 *
 * `ImportResult` keeps three lists: `warnings` (plain strings), `report` (what the import dropped,
 * approximated or preserved, EXP-107) and `fonts` (substitutions, EXP-106). The job's result has one
 * list, `warnings`, whose shape the protocol leaves open (gap G74, a placeholder). This function
 * joins the three into records a host can show. The record shape is a proposal; see
 * docs/adr/0385-w2-exp-106-job-warnings.md.
 *
 * Universal: no file system, no network.
 */
import type { ImportResult } from './import.ts';

/** One warning of the job result. `message` is the line to show; the other keys say what it is. */
export type JobWarning =
  | { message: string }
  | {
      kind: string;
      action: 'dropped' | 'approximated' | 'preserved';
      message: string;
      count: number;
      blocks: string[];
    }
  | {
      kind: 'font substitution';
      action: 'approximated';
      message: string;
      count: 1;
      from: string;
      to: string;
      source: 'builtin' | 'tenant' | 'default';
      reflow: boolean;
    };

/**
 * Report lines first (what changed in the content), then each substituted font family once, then
 * the importer's plain messages.
 */
export function jobWarnings(
  result: Pick<ImportResult, 'report' | 'fonts' | 'warnings'>,
): JobWarning[] {
  const out: JobWarning[] = [];
  for (const r of result.report)
    out.push({
      kind: r.kind,
      action: r.action,
      message: r.message,
      count: r.count,
      blocks: [...r.blocks],
    });
  for (const f of result.fonts)
    out.push({
      kind: 'font substitution',
      action: 'approximated',
      message: f.message,
      count: 1,
      from: f.from,
      to: f.to,
      source: f.source,
      reflow: f.reflow,
    });
  for (const m of result.warnings) out.push({ message: m });
  return out;
}
