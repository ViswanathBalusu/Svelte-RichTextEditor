// The kit's CORS scenarios (PRO-041 criterion 5): the `core` profile asserts each allowed header,
// each exposed header and the refusal of a disallowed origin. Here they run against the mock
// target over real HTTP, once as 05 §6.1 says (all three pass) and once per defect: a server that
// leaves one header out, or that grants an origin no tenant allows, fails the scenario that names
// it. The same scenarios pass against the reference service (reference.test.ts).
import { describe, expect, it } from 'vitest';
import type { ScenarioResult } from '../src/report.ts';
import { runKit } from '../src/runner.ts';
import { startMock, type MockTargetOptions } from './targets/mock-server.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

const SCENARIOS = ['core.cors.preflight', 'core.cors.expose', 'core.cors.refused'] as const;
const ALLOWED = [
  'Authorization',
  'Content-Type',
  'If-Match',
  'Idempotency-Key',
  'DEP-Actor',
  'traceparent',
];
const EXPOSED = ['ETag', 'Retry-After', 'Deprecation', 'Sunset'];

/** Runs the three CORS scenarios against a mock target with this CORS behaviour. */
async function cors(options: MockTargetOptions['cors']): Promise<Record<string, ScenarioResult>> {
  const target = await startMock(options ? { cors: options } : {});
  try {
    const report = await runKit({
      discovery: target.discovery,
      credential: target.credential,
      origin: target.origin,
      testMode: false,
      profiles: ['core'],
      scenarios: [...SCENARIOS],
    });
    expect(report.bootstrap).toEqual({ ok: true });
    const ran = report.profiles.flatMap((p) => p.scenarios);
    expect(ran.map((s) => s.id).sort()).toEqual([...SCENARIOS].sort());
    return Object.fromEntries(ran.map((s) => [s.id, s]));
  } finally {
    await target.stop();
  }
}

const outcomes = (r: Record<string, ScenarioResult>) => SCENARIOS.map((id) => r[id]?.outcome);

describe.skipIf(skip)('the core profile asserts the CORS rules of 05 §6.1 (PRO-041)', () => {
  it('passes a server that allows and exposes every header and refuses an unknown origin', async () => {
    const r = await cors(undefined);
    expect(outcomes(r), JSON.stringify(SCENARIOS.map((id) => r[id]?.failure))).toEqual([
      'passed',
      'passed',
      'passed',
    ]);
  });

  it.each(ALLOWED)('fails a preflight that does not allow %s', async (header) => {
    const r = await cors({ withoutAllowed: header });
    expect(outcomes(r)).toEqual(['failed', 'passed', 'passed']);
    expect(r['core.cors.preflight']?.failure?.message).toContain(
      `the allowed headers include ${header.toLowerCase()}`,
    );
  });

  it.each(EXPOSED)('fails a response that does not expose %s', async (header) => {
    const r = await cors({ withoutExposed: header });
    expect(outcomes(r)).toEqual(['passed', 'failed', 'passed']);
    expect(r['core.cors.expose']?.failure?.message).toContain(
      `the exposed headers include ${header.toLowerCase()}`,
    );
  });

  it.each(['echo', 'star'] as const)(
    'fails a server that grants an origin no tenant allows (%s)',
    async (anyOrigin) => {
      const r = await cors({ anyOrigin });
      expect(r['core.cors.refused']?.outcome).toBe('failed');
      expect(r['core.cors.refused']?.failure?.message).toContain(
        'a refused origin gets no Access-Control-Allow-Origin',
      );
    },
  );
});
