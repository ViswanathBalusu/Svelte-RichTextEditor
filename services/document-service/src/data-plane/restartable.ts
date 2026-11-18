/**
 * A data plane that a test hook can restart in place (PRO-024 criterion 6; PRO-126; BE-022). The
 * hook drains the node as a rolling restart does, so every connection gets `goaway` and 4503 and
 * ownership is released, and then a new data plane takes its place in the same process. Clients that
 * follow the hint reconnect to the new one. It is used only in test mode (`config.testMode`); a
 * production service has one data plane for its whole life.
 *
 * The wrapper forwards every member to the data plane that is current at the time of the call, so
 * what the service captured at start (the notifier, the upgrade handler, the metrics) keeps working
 * after a restart.
 */
import type { DataPlane, DataPlaneDeps, DataPlaneTestHooks } from '../seams.ts';

/** How long the old node waits is its own `drainTimeoutMs`; this is only the reason it logs. */
export const RESTART_REASON = 'the node is restarting (test hook)';

/** The data plane of a service: restartable in test mode, plain otherwise. */
export function planeOf(
  testMode: boolean,
  create: (deps: DataPlaneDeps) => DataPlane,
  deps: DataPlaneDeps,
): DataPlane {
  return testMode ? restartable(() => create(deps)) : create(deps);
}

export function restartable(create: () => DataPlane): DataPlane {
  let current = create();
  let restarting: Promise<void> | null = null;
  const members = new Map<PropertyKey, (...args: unknown[]) => unknown>();

  const restart = (): Promise<void> => {
    restarting ??= (async () => {
      try {
        const old = current;
        if (old.drain) await old.drain(RESTART_REASON);
        else await old.close();
        current = create();
      } finally {
        restarting = null;
      }
    })();
    return restarting;
  };

  const hooks = new Proxy({} as DataPlaneTestHooks, {
    get(_target, key) {
      if (key === 'restartNode') return restart;
      const value = (current.hooks as unknown as Record<PropertyKey, unknown> | undefined)?.[key];
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        (current.hooks as unknown as Record<PropertyKey, (...a: unknown[]) => unknown>)[key]!(
          ...args,
        );
    },
  });

  return new Proxy({} as DataPlane, {
    get(_target, key) {
      if (key === 'hooks') return current.hooks ? hooks : undefined;
      const value = (current as unknown as Record<PropertyKey, unknown>)[key];
      if (typeof value !== 'function') return value;
      let forward = members.get(key);
      if (!forward) {
        forward = (...args: unknown[]) =>
          (current as unknown as Record<PropertyKey, (...a: unknown[]) => unknown>)[key]!(...args);
        members.set(key, forward);
      }
      return forward;
    },
    has: (_target, key) => key in current,
  });
}
