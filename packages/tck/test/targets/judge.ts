/**
 * How the kit's own tests read a run against a target: every failed scenario must be a known
 * defect of that target (listed with what is wrong), a known defect that now passes is reported so
 * that the list shrinks, and every passing scenario must have exercised what it declares (the
 * declarations feed the check of PRO-117, so they must be true).
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEP1 } from '@docedit/protocol';
import { PROFILES } from '../../src/profiles/index.ts';
import { renderText, type KitReport } from '../../src/report.ts';

export interface Verdict {
  unexpected: Array<{ id: string; message: string; expected?: string; received?: string }>;
  fixed: string[];
  unproven: string[];
  counts: Record<string, string>;
}

export function judge(report: KitReport, known: Readonly<Record<string, string>>): Verdict {
  const scenarios = report.profiles.flatMap((p) => p.scenarios);
  const unexpected = scenarios
    .filter((s) => s.outcome === 'failed' && !(s.id in known))
    .map((s) => ({
      id: s.id,
      message: s.failure?.message ?? '',
      ...(s.failure?.expected ? { expected: s.failure.expected } : {}),
      ...(s.failure?.received ? { received: s.failure.received } : {}),
    }));
  const fixed = Object.keys(known).filter(
    (id) => scenarios.find((s) => s.id === id)?.outcome === 'passed',
  );
  const defs = new Map(PROFILES.flatMap((p) => p.scenarios.map((s) => [s.id, s] as const)));
  // An optional member the server sends is exercised where a server sends it; a server may omit
  // it, so only the members the kit itself sends must appear in every passing run.
  const fromServer = new Set(DEP1.messages.filter((m) => m.dir === 's2c').map((m) => m.t));
  const unproven: string[] = [];
  for (const s of scenarios) {
    if (s.outcome !== 'passed' || !s.observed) continue;
    const c = defs.get(s.id)?.covers ?? {};
    const o = s.observed;
    const gap = (
      kind: string,
      declared: readonly (string | number)[] | undefined,
      seen: readonly (string | number)[],
    ) => {
      for (const d of declared ?? [])
        if (!seen.includes(d))
          unproven.push(`${s.id}: declares ${kind} ${d} but its traffic has none`);
    };
    gap('message', c.messages, o.messages);
    gap(
      'field',
      c.fields?.filter((f) => !fromServer.has(f.slice(0, f.lastIndexOf('.')))),
      o.fields,
    );
    gap('operation', c.operations, o.operations);
    gap('close code', c.closeCodes, o.closeCodes);
    gap('error', c.errors, o.errors);
    gap('event', c.events, o.events);
  }
  const counts = Object.fromEntries(
    report.profiles.map((p) => [
      p.id,
      `${p.outcome} ${p.counts.passed}/${p.counts.failed}/${p.counts.skipped}`,
    ]),
  );
  return { unexpected, fixed, unproven, counts };
}

/** Writes the report next to the test run and prints the summary table. */
export function keep(name: string, report: KitReport): string {
  const file = join(tmpdir(), `docedit-tck-${name.replace(/\W+/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  writeFileSync(file.replace(/\.json$/, '.txt'), renderText(report));
  return file;
}
