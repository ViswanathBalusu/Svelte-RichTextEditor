/**
 * Runs the profiles against one target (05 §11; PRO-108). A profile runs only when the target
 * announces what it maps to; otherwise it is reported as skipped, with the reason. A failed scenario
 * in a profile that runs makes the run fail. Scenarios run one after another, each with its own
 * documents and users, and each with a time limit.
 */
import { KitFailure, isKitFailure, isKitSkip } from './assert.ts';
import { resolveConfig, type KitConfig, type ResolvedConfig } from './config.ts';
import { BootstrapError, ScenarioContext, bootstrap, type Target } from './context.ts';
import { PROFILES } from './profiles/index.ts';
import type { KitReport, Outcome, ProfileResult, ScenarioResult } from './report.ts';
import type { ProfileDef, ScenarioDef } from './scenario.ts';

export const KIT_VERSION = '0.1.0';

/** Why a profile does not apply to the target, or null when it does. */
export function notApplicable(
  p: ProfileDef,
  target: Pick<Target, 'discovery' | 'features'> & {
    config: Pick<ResolvedConfig, 'readRestrictionsFeature'>;
  },
): string | null {
  const r = p.requires;
  if (r.kind === 'always') return null;
  if (r.kind === 'mode')
    return target.discovery.mode === r.mode ? null : `the target is not in ${r.mode} mode (05 §2)`;
  // `$readRestrictions` stands for the feature name of read restrictions, which DEP has not fixed
  // yet (G101; ADR 0042): the configuration names it.
  const names = r.features.map((f) =>
    f === '$readRestrictions' ? target.config.readRestrictionsFeature : f,
  );
  const missing = names.filter((f) => !target.features.has(f));
  return missing.length
    ? `the target does not announce ${missing.map((f) => `\`${f}\``).join(', ')}`
    : null;
}

/** Why a scenario cannot run with this configuration, or null. */
export function unmetNeeds(s: ScenarioDef, target: Target): string | null {
  const n = s.needs;
  if (!n) return null;
  if (n.testMode && !target.config.testMode)
    return 'needs the server test-mode switch (05 §11; PRO-109)';
  if (n.origin && !target.config.origin)
    return 'needs an origin registered for the kit tenant (--origin)';
  const missing = (n.features ?? []).filter((f) => !target.features.has(f));
  if (missing.length) return `the target does not announce ${missing.join(', ')}`;
  return null;
}

function selected(s: ScenarioDef, config: ResolvedConfig): boolean {
  return (
    !config.scenarios ||
    config.scenarios.some((p) => s.id === p || s.id.startsWith(`${p}.`) || s.id.startsWith(p))
  );
}

async function withTimeout(p: Promise<void>, ms: number, what: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new KitFailure(
            `${what} did not finish within ${ms} ms`,
            `a result within ${ms} ms`,
            'no result',
          ),
        ),
      ms,
    );
  });
  try {
    await Promise.race([p, limit]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runScenario(
  target: Target,
  p: ProfileDef,
  s: ScenarioDef,
): Promise<ScenarioResult> {
  const base = { id: s.id, profile: p.id, title: s.title, spec: s.spec };
  const unmet = unmetNeeds(s, target);
  if (unmet) return { ...base, outcome: 'skipped', reason: unmet, durationMs: 0, notes: [] };
  const ctx = new ScenarioContext(target, s);
  const started = Date.now();
  let outcome: Outcome = 'passed';
  let reason: string | undefined;
  let failure: ScenarioResult['failure'];
  const run = s.run(ctx);
  // A scenario that times out keeps running until its connections are closed; its rejection is
  // reported through the timeout instead.
  run.catch(() => undefined);
  try {
    const limit =
      s.budget === 'fuzz'
        ? target.config.fuzz.budgetMs + 60_000
        : (s.timeoutMs ?? target.config.scenarioTimeoutMs);
    await withTimeout(run, limit, s.id);
    const problems = ctx.problems();
    if (problems.length) {
      outcome = 'failed';
      failure = {
        message: 'the server sent frames that are not valid DEP messages',
        expected: 'every frame one valid envelope with a valid payload (05 §4, §5)',
        received: problems.slice(0, 4).join(' | '),
      };
    }
  } catch (e) {
    if (isKitSkip(e)) {
      outcome = 'skipped';
      reason = e.message;
    } else if (isKitFailure(e)) {
      outcome = 'failed';
      failure = { message: e.message };
      if (e.expected !== undefined) failure.expected = e.expected;
      if (e.received !== undefined) failure.received = e.received;
    } else {
      outcome = 'failed';
      failure = {
        message: `the scenario raised ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`,
      };
    }
  } finally {
    await ctx.dispose();
  }
  const o = ctx.observed;
  const result: ScenarioResult = {
    ...base,
    outcome,
    durationMs: Date.now() - started,
    notes: ctx.notes,
    observed: {
      messages: [...o.messages].sort(),
      fields: [...o.fields].sort(),
      operations: [...o.operations].sort(),
      closeCodes: [...o.closeCodes].sort(),
      errors: [...o.errors].sort(),
      events: [...o.events].sort(),
    },
  };
  if (reason !== undefined) result.reason = reason;
  if (failure) result.failure = failure;
  return result;
}

function counts(scenarios: readonly ScenarioResult[]) {
  return {
    passed: scenarios.filter((s) => s.outcome === 'passed').length,
    failed: scenarios.filter((s) => s.outcome === 'failed').length,
    skipped: scenarios.filter((s) => s.outcome === 'skipped').length,
  };
}

function skippedProfile(p: ProfileDef, reason: string): ProfileResult {
  const scenarios: ScenarioResult[] = p.scenarios.map((s) => ({
    id: s.id,
    profile: p.id,
    title: s.title,
    spec: s.spec,
    outcome: 'skipped',
    reason,
    durationMs: 0,
    notes: [],
  }));
  return {
    id: p.id,
    title: p.title,
    spec: p.spec,
    stories: [...p.stories],
    outcome: 'skipped',
    reason,
    counts: counts(scenarios),
    scenarios,
  };
}

/** Runs every selected profile against the target named by `input` and returns the report. */
export async function runKit(
  input: KitConfig,
  profiles: readonly ProfileDef[] = PROFILES,
): Promise<KitReport> {
  const config = resolveConfig(input);
  const started = Date.now();
  const chosen = profiles.filter((p) => !config.profiles || config.profiles.includes(p.id));
  const report: KitReport = {
    kit: { name: '@docedit/tck', version: KIT_VERSION, protocol: '1.0' },
    target: { discovery: config.discovery, mode: null, versions: [], features: [] },
    testMode: config.testMode,
    seeds: { fuzz: config.fuzz.seed, property: config.property.seed },
    startedAt: new Date(started).toISOString(),
    finishedAt: '',
    durationMs: 0,
    ok: false,
    bootstrap: { ok: true },
    totals: { passed: 0, failed: 0, skipped: 0 },
    profiles: [],
  };
  let target: Target | null = null;
  try {
    target = await bootstrap(config);
    report.target = {
      discovery: target.discoveryUrl,
      mode: target.discovery.mode,
      versions: [...target.discovery.versions],
      features: [...target.discovery.features],
    };
  } catch (e) {
    const failure: NonNullable<KitReport['bootstrap']['failure']> = {
      message: e instanceof Error ? e.message : String(e),
    };
    if (e instanceof BootstrapError) {
      if (e.expected !== undefined) failure.expected = e.expected;
      if (e.received !== undefined) failure.received = e.received;
    }
    report.bootstrap = { ok: false, failure };
  }
  for (const p of chosen) {
    if (!target) {
      report.profiles.push(skippedProfile(p, 'the bootstrap failed'));
      continue;
    }
    const why = notApplicable(p, target);
    if (why) {
      report.profiles.push(skippedProfile(p, why));
      config.log(`skip ${p.id}: ${why}`);
      continue;
    }
    if (p.pending && !p.scenarios.length) {
      report.profiles.push(skippedProfile(p, p.pending));
      continue;
    }
    const scenarios: ScenarioResult[] = [];
    for (const s of p.scenarios) {
      if (!selected(s, config)) continue;
      const r = await runScenario(target, p, s);
      scenarios.push(r);
      config.log(
        `${r.outcome === 'passed' ? 'pass' : r.outcome === 'failed' ? 'FAIL' : 'skip'} ${r.id}${r.failure ? `: ${r.failure.message}` : r.reason ? ` (${r.reason})` : ''}`,
      );
    }
    const c = counts(scenarios);
    report.profiles.push({
      id: p.id,
      title: p.title,
      spec: p.spec,
      stories: [...p.stories],
      outcome: c.failed ? 'failed' : c.passed ? 'passed' : 'skipped',
      ...(p.pending ? { reason: p.pending } : {}),
      counts: c,
      scenarios,
    });
  }
  const all = report.profiles.flatMap((p) => p.scenarios);
  report.totals = counts(all);
  report.ok = report.bootstrap.ok && report.totals.failed === 0;
  const finished = Date.now();
  report.finishedAt = new Date(finished).toISOString();
  report.durationMs = finished - started;
  return report;
}
