// A data plane that a test hook restarts in place (PRO-024 criterion 6; PRO-126).
import { describe, expect, it } from 'vitest';
import type { DataPlane, DataPlaneDeps, DataPlaneTestHooks } from '../seams.ts';
import { RESTART_REASON, planeOf, restartable } from './restartable.ts';

/** A stub plane: it records its life and what was asked of it. */
function stubPlane(n: number, log: string[]): DataPlane {
  const hooks = {
    killRoom: async () => {
      log.push(`plane ${n}: killRoom`);
      return true;
    },
  } as unknown as DataPlaneTestHooks;
  return {
    n,
    hooks,
    features: [`plane-${n}`],
    handleUpgrade: () => {
      log.push(`plane ${n}: upgrade`);
    },
    drain: async (reason?: string) => {
      log.push(`plane ${n}: drain (${reason})`);
      await Promise.resolve();
    },
    close: async () => {
      log.push(`plane ${n}: close`);
    },
  } as unknown as DataPlane;
}

describe('restartable data plane', () => {
  it('forwards members and hooks to the plane that is current at the time of the call', async () => {
    const log: string[] = [];
    let made = 0;
    const plane = restartable(() => stubPlane(++made, log));
    // Captured before the restart, as the service captures them at start.
    const upgrade = plane.handleUpgrade.bind(plane);
    const kill = plane.hooks!.killRoom;
    expect(plane.features).toEqual(['plane-1']);
    upgrade(null as never, null as never, null as never);
    await kill({ tenant: 't', doc: 'd' });

    await plane.hooks!.restartNode!();

    expect(plane.features).toEqual(['plane-2']);
    upgrade(null as never, null as never, null as never);
    await kill({ tenant: 't', doc: 'd' });
    expect(log).toEqual([
      'plane 1: upgrade',
      'plane 1: killRoom',
      `plane 1: drain (${RESTART_REASON})`,
      'plane 2: upgrade',
      'plane 2: killRoom',
    ]);
  });

  it('drains the old plane before the new one is made, and answers once per restart', async () => {
    const log: string[] = [];
    let made = 0;
    const plane = restartable(() => {
      const n = ++made;
      log.push(`made ${n}`);
      return stubPlane(n, log);
    });
    const both = await Promise.all([plane.hooks!.restartNode!(), plane.hooks!.restartNode!()]);
    expect(both).toEqual([undefined, undefined]);
    expect(log).toEqual(['made 1', `plane 1: drain (${RESTART_REASON})`, 'made 2']);
    await plane.close();
    expect(log.at(-1)).toBe('plane 2: close');
  });

  it('is the plain data plane outside test mode, made once with the deps it was given', () => {
    const log: string[] = [];
    const deps = { marker: 1 } as unknown as DataPlaneDeps;
    let made = 0;
    const create = (d: DataPlaneDeps) => {
      expect(d).toBe(deps);
      return stubPlane(++made, log);
    };
    const plain = planeOf(false, create, deps);
    expect(made).toBe(1);
    expect(plain.hooks!.restartNode).toBeUndefined();
    const test = planeOf(true, create, deps);
    expect(made).toBe(2);
    expect(typeof test.hooks!.restartNode).toBe('function');
  });

  it('has no hooks where the plane has none', () => {
    const plane = restartable(() => ({ close: async () => {} }) as unknown as DataPlane);
    expect(plane.hooks).toBeUndefined();
  });
});
