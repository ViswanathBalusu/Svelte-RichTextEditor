// The kit's close-code check (PRO-037 criterion 4): whatever a scenario does, a connection that the
// server ends must end with a close code of 05 §5.7. The mock target closes on request with a code
// of the test's choice (closeOnUnknown), so the check runs against a real socket: a code outside
// the nine, or a drop without a close frame, fails the scenario that saw it and so the run; a
// defined code and a close the kit asked for do not.
import { DEP1 } from '@docedit/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ScenarioContext } from '../src/context.ts';
import type { KitReport, ScenarioResult } from '../src/report.ts';
import { runKit } from '../src/runner.ts';
import type { ProfileDef } from '../src/scenario.ts';
import { startMock } from './targets/mock-server.ts';
import type { StartedTarget } from './targets/reference.ts';

const skip = process.env['DOCEDIT_TCK_SKIP_TARGETS'] === '1';

/** Opens a session, sends one message of type `t` and waits for the server to end the connection. */
const provoke = (t: string) => async (ctx: ScenarioContext) => {
  const doc = await ctx.document();
  const s = await ctx.session('user', { [doc]: 'editor' });
  s.wire.send({ t, d: {} });
  await s.wire.closes(`the close after ${t}`, 5000);
};

const PROFILE: ProfileDef = {
  id: 'closes',
  title: 'close codes seen by the kit',
  spec: '05 §5.7',
  stories: ['PRO-037'],
  requires: { kind: 'always' },
  scenarios: [
    ...[
      ['going-away', 'x-test-close-1001'],
      ['internal-1011', 'x-test-close-1011'],
      ['private-4999', 'x-test-close-4999'],
      ['drop', 'x-test-drop'],
      ['defined-4503', 'x-test-close-4503'],
      ['defined-4500', 'x-test-close-4500'],
    ].map(([id, t]) => ({
      id: `closes.${id}`,
      title: `the server ends the connection after ${t}`,
      spec: '05 §5.7',
      covers: {},
      run: provoke(t!),
    })),
    {
      id: 'closes.by-the-kit',
      title: 'the kit closes with 1000 and with 4999, and drops a connection',
      spec: '05 §5.7',
      covers: {},
      async run(ctx) {
        const doc = await ctx.document();
        const a = await ctx.session('a', { [doc]: 'editor' });
        const b = await ctx.session('b', { [doc]: 'editor' });
        const c = await ctx.session('c', { [doc]: 'editor' });
        await a.wire.close();
        await b.wire.close(4999);
        c.wire.terminate();
        await c.wire.closes('the kit dropped it', 5000);
      },
    },
  ],
};

describe.skipIf(skip)('the kit holds every close by the server against 05 §5.7 (PRO-037)', () => {
  let target: StartedTarget;
  let report: KitReport;
  const result = (id: string): ScenarioResult | undefined =>
    report.profiles.flatMap((p) => p.scenarios).find((s) => s.id === `closes.${id}`);

  beforeAll(async () => {
    target = await startMock({
      closeOnUnknown: {
        'x-test-close-1001': 1001,
        'x-test-close-1011': 1011,
        'x-test-close-4999': 4999,
        'x-test-drop': 'drop',
        'x-test-close-4503': 4503,
        'x-test-close-4500': 4500,
      },
    });
    report = await runKit(
      {
        discovery: target.discovery,
        credential: target.credential,
        origin: target.origin,
        testMode: false,
      },
      [PROFILE],
    );
  }, 120_000);

  afterAll(async () => {
    await target?.stop();
  });

  it('bootstraps', () => {
    expect(report.bootstrap).toEqual({ ok: true });
  });

  it('fails a scenario in which the server closed with a code outside the nine', () => {
    for (const [id, code] of [
      ['going-away', 1001],
      ['internal-1011', 1011],
      ['private-4999', 4999],
    ] as const) {
      const r = result(id);
      expect(r?.outcome, id).toBe('failed');
      expect(r?.failure?.message, id).toMatch(/close code that 05 §5\.7 does not define/);
      expect(r?.failure?.received, id).toContain(`the server closed with ${code}`);
      expect(r?.failure?.expected, id).toBe(
        `one of ${DEP1.closeCodes.map((c) => c.code).join(', ')} (05 §5.7)`,
      );
    }
    expect(report.ok).toBe(false);
  });

  it('fails a scenario in which the server dropped the connection without a close frame', () => {
    const r = result('drop');
    expect(r?.outcome).toBe('failed');
    expect(r?.failure?.received).toContain('without a close frame (1006)');
  });

  it('passes a scenario in which the server closed with a code of 05 §5.7', () => {
    expect(result('defined-4503')?.outcome, JSON.stringify(result('defined-4503')?.failure)).toBe(
      'passed',
    );
    expect(result('defined-4500')?.outcome).toBe('passed');
  });

  it('does not count a close or a drop that the kit itself asked for', () => {
    expect(result('by-the-kit')?.outcome, JSON.stringify(result('by-the-kit')?.failure)).toBe(
      'passed',
    );
  });

  it('names exactly the nine codes of 05 §5.7', () => {
    expect(DEP1.closeCodes.map((c) => c.code)).toEqual([
      4400, 4401, 4403, 4406, 4408, 4413, 4429, 4500, 4503,
    ]);
  });
});
