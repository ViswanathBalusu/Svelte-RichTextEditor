// Spike S12 (SPK-029; ADR 0019) and SYN-050 to SYN-053: read restrictions by per-reader
// projection. Random schedules with the faults of S3, snapshot restores, a confidential region and
// a sensitive value: every client converges to the projection of the head for its view, the steps
// each class received give exactly its projection of every version (the gateway's audit), no
// message ever carries hidden content to a client that may not read it, content is projected at
// the grants revision in storage, and the permission oracle holds on the full log.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { UserName } from './fixtures.ts';
import { ProjectionSim } from './harness/projection-sim.ts';
import type { Op } from './harness/sim.ts';

const text = fc.string({ minLength: 1, maxLength: 3, unit: fc.constantFrom('a', 'b', ' ', 'ü') });
const n = fc.noBias(fc.nat(1000));
const op: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 12,
    arbitrary: fc.record({ k: fc.constant('edit' as const), c: n, a: n, b: n, s: text }),
  },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('evil' as const), c: n, a: n, b: n }) },
  { weight: 10, arbitrary: fc.record({ k: fc.constant('send' as const), c: n }) },
  { weight: 12, arbitrary: fc.record({ k: fc.constant('toServer' as const), c: n }) },
  { weight: 12, arbitrary: fc.record({ k: fc.constant('toClient' as const), c: n }) },
  { weight: 7, arbitrary: fc.record({ k: fc.constant('write' as const), a: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('drop' as const), c: n }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant('reconnect' as const), c: n }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('grants' as const), a: n, b: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('crash' as const), a: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('tick' as const), a: n }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('snapshot' as const), a: n }) },
  // A refreshed token with another role, groups or workflow roles (05 §3.1; ADR 0050 item 11).
  { weight: 1, arbitrary: fc.record({ k: fc.constant('refresh' as const), c: n, a: n }) },
);
const CAST: UserName[] = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'mallory'];
const RUNS = Number(process.env['S12_RUNS'] ?? 200);

describe('S12: read restrictions by projection', () => {
  it('hides what it must, converges, sends exact steps per class, and keeps the permission oracle', () => {
    const totals = {
      stored: 0,
      reloads: 0,
      leakChecks: 0,
      secretsSent: 0,
      rejected: 0,
      recovered: 0,
      staleReads: 0,
      staleInCommits: 0,
      accessClosed: 0,
      resets: 0,
      empty: 0,
      refreshes: 0,
      permChanged: 0,
      declassified: 0,
      routes: { mapped: 0, noop: 0, inside: 0, value: 0, diff: 0 },
    };
    fc.assert(
      fc.property(
        fc.array(op, { minLength: 60, maxLength: 240 }),
        fc.subarray(CAST, { minLength: 2 }),
        (ops, users) => {
          const sim = new ProjectionSim(users, ['mallory']);
          for (const o of ops) sim.step(o);
          sim.quiesce();
          const failures = sim.check();
          totals.stored += sim.stats.stored;
          totals.reloads += sim.stats.reloads;
          totals.leakChecks += sim.stats.leakChecks;
          totals.secretsSent += sim.stats.secretsSent;
          totals.staleReads += sim.stats.staleReads;
          totals.staleInCommits += sim.stats.staleInCommits;
          totals.accessClosed += sim.stats.accessClosed;
          totals.resets += sim.stats.resets;
          totals.empty += sim.stats.empty;
          totals.refreshes += sim.stats.refreshes;
          totals.permChanged += sim.stats.permChanged;
          totals.declassified += sim.stats.declassified;
          for (const k of ['mapped', 'noop', 'inside', 'value', 'diff'] as const)
            totals.routes[k] += sim.stats.routes[k];
          for (const c of sim.clients) totals.recovered += c.recovered;
          for (const v of sim.stats.rejected.values()) totals.rejected += v;
          expect(failures, failures.join('\n')).toEqual([]);
        },
      ),
      {
        numRuns: RUNS,
        endOnFailure: true,
        // S12_SEED (and S12_PATH) replay a failing run that fast-check reported.
        ...(process.env['S12_SEED'] ? { seed: Number(process.env['S12_SEED']) } : {}),
        ...(process.env['S12_PATH'] ? { path: process.env['S12_PATH'] } : {}),
      },
    );
    console.log(`S12 totals over ${RUNS} runs: ${JSON.stringify(totals)}`);
    // Not vacuous: commits were stored, secrets were really sent to readers who may see them,
    // every message was checked, visibility changes closed readers and forced reloads, snapshot
    // resets reached readers, and commits went to classes as mapped steps and as local diffs.
    expect(totals.stored).toBeGreaterThan(RUNS);
    expect(totals.secretsSent).toBeGreaterThan(RUNS);
    expect(totals.reloads).toBeGreaterThan(RUNS / 4);
    expect(totals.accessClosed).toBeGreaterThan(0);
    expect(totals.resets).toBeGreaterThan(0);
    expect(totals.routes.mapped).toBeGreaterThan(totals.routes.diff);
    expect(totals.routes.inside + totals.routes.value + totals.routes.diff).toBeGreaterThan(0);
    // Content reads check the grants revision in storage (ADR 0019 change 3; SYN-053): no reader
    // whose access storage had already revoked was served hidden content.
    expect(totals.staleReads).toBe(0);
    // Unconfirmed work at a reload went to recovered edits.
    expect(totals.recovered).toBeGreaterThan(0);
    // Refreshed tokens changed roles in flight: the room sent `perm.changed` with the new access
    // instead of closing, and closed only readers whose class changed (counted above).
    expect(totals.refreshes).toBeGreaterThan(0);
    expect(totals.permChanged).toBeGreaterThan(0);
    // The region's marker stops being a secret in a run where a stored version holds it outside the
    // region (projection.schedules.test.ts has the two ways that happens). That must stay rare, or
    // the leak check would be blunt: it was 1 run of 6,000 when this was written (2026-11-20).
    expect(totals.declassified).toBeLessThanOrEqual(Math.ceil(RUNS / 50));
  });
});
