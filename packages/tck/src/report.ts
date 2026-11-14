/**
 * The run report (PRO-108 criterion 5): every profile and scenario with its identifier and result,
 * as JSON for machines and as text for people. A failure carries what the specification requires
 * and what the target did; a skip carries its reason.
 */

export type Outcome = 'passed' | 'failed' | 'skipped';

export interface ScenarioResult {
  id: string;
  profile: string;
  title: string;
  spec: string;
  outcome: Outcome;
  durationMs: number;
  /** Why the scenario was skipped. */
  reason?: string;
  failure?: { message: string; expected?: string; received?: string };
  notes: string[];
  /** What the traffic of the scenario exercised (PRO-117). */
  observed?: {
    messages: string[];
    fields: string[];
    operations: string[];
    closeCodes: number[];
    errors: string[];
    events: string[];
  };
}

export interface ProfileResult {
  id: string;
  title: string;
  spec: string;
  stories: string[];
  /** `skipped` when the target does not announce what the profile maps to. */
  outcome: Outcome;
  /** Why the profile was skipped, or a note for a profile without scenarios yet. */
  reason?: string;
  counts: { passed: number; failed: number; skipped: number };
  scenarios: ScenarioResult[];
}

export interface KitReport {
  kit: { name: string; version: string; protocol: string };
  target: {
    discovery: string;
    mode: string | null;
    versions: string[];
    features: string[];
  };
  testMode: boolean;
  seeds: { fuzz: number; property: number };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** False when a profile the target is held to has a failed scenario, or the bootstrap failed. */
  ok: boolean;
  bootstrap: { ok: boolean; failure?: { message: string; expected?: string; received?: string } };
  totals: { passed: number; failed: number; skipped: number };
  profiles: ProfileResult[];
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

/** The report as text for people. */
export function renderText(r: KitReport): string {
  const out: string[] = [];
  out.push(`DEP conformance kit ${r.kit.version} (protocol ${r.kit.protocol})`);
  out.push(`Target: ${r.target.discovery}`);
  out.push(
    `Mode: ${r.target.mode ?? 'unknown'}; features: ${r.target.features.join(', ') || 'none'}`,
  );
  out.push(
    `Test mode: ${r.testMode ? 'on' : 'off'}; seeds: fuzz ${r.seeds.fuzz}, property ${r.seeds.property}`,
  );
  out.push(`Run: ${r.startedAt} to ${r.finishedAt} (${Math.round(r.durationMs / 1000)} s)`);
  if (!r.bootstrap.ok && r.bootstrap.failure) {
    out.push('');
    out.push(`BOOTSTRAP FAILED: ${r.bootstrap.failure.message}`);
    if (r.bootstrap.failure.expected) out.push(`  expected: ${r.bootstrap.failure.expected}`);
    if (r.bootstrap.failure.received) out.push(`  received: ${r.bootstrap.failure.received}`);
  }
  out.push('');
  out.push(`${pad('Profile', 16)} ${pad('Result', 8)} passed failed skipped`);
  for (const p of r.profiles)
    out.push(
      `${pad(p.id, 16)} ${pad(p.outcome, 8)} ${pad(String(p.counts.passed), 6)} ${pad(String(p.counts.failed), 6)} ${p.counts.skipped}${p.reason ? `  (${p.reason})` : ''}`,
    );
  out.push(
    `${pad('total', 16)} ${pad(r.ok ? 'PASS' : 'FAIL', 8)} ${pad(String(r.totals.passed), 6)} ${pad(String(r.totals.failed), 6)} ${r.totals.skipped}`,
  );
  for (const p of r.profiles) {
    if (!p.scenarios.length) continue;
    out.push('');
    out.push(`## ${p.id}: ${p.title} (${p.spec})`);
    for (const s of p.scenarios) {
      const mark = s.outcome === 'passed' ? 'pass' : s.outcome === 'failed' ? 'FAIL' : 'skip';
      out.push(
        `  [${mark}] ${s.id}: ${s.title}${s.outcome === 'skipped' && s.reason ? ` (${s.reason})` : ''}`,
      );
      if (s.failure) {
        out.push(`         ${s.failure.message}`);
        if (s.failure.expected) out.push(`         expected: ${s.failure.expected}`);
        if (s.failure.received) out.push(`         received: ${s.failure.received}`);
      }
      for (const n of s.notes) out.push(`         note: ${n}`);
    }
  }
  return `${out.join('\n')}\n`;
}
