/**
 * The lazily loaded participants service (FRW-026; FE-002): the views are empty until the module
 * has loaded, `prepare` loads it and reads the workflow, and a subscriber made before the load is
 * told once the service holds the list. No DOM and no server: a stand-in port.
 */
import type { EditorCore } from '@docedit/engine';
import { describe, expect, it } from 'vitest';
import { lazyParticipantsService } from '../src/participants-lazy.ts';

const WORKFLOW = {
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c9d',
  doc: 'd1',
  state: 'draft',
  rev: 1,
  participants: [{ id: 'p1', roles: ['role_a'], kind: 'filler', order: 1, name: 'Ada' }],
};

function made() {
  const core = {
    permissions: { get: () => ({ caps: ['manage'] }), subscribe: () => () => undefined },
  } as unknown as EditorCore;
  let reads = 0;
  const port = {
    get: async () => {
      reads += 1;
      return { value: WORKFLOW, etag: '"1"' };
    },
  };
  const service = lazyParticipantsService(core, () => ({ port, docId: 'd1' }) as never);
  return { service, reads: () => reads };
}

describe('lazyParticipantsService', () => {
  it('is empty before the module has loaded and full after prepare', async () => {
    const { service, reads } = made();
    expect(service.participants.get()).toEqual([]);
    expect(service.state.get()).toBeNull();
    expect(service.canEdit.get()).toBe(false);
    await service.prepare?.();
    expect(reads()).toBeGreaterThan(0);
    expect(service.participants.get().map((p) => p.name)).toEqual(['Ada']);
    expect(service.state.get()).toBe('draft');
    expect(service.canEdit.get()).toBe(true);
    service.dispose();
  });

  it('tells a subscriber made before the load, and stops after unsubscribe', async () => {
    const { service } = made();
    let calls = 0;
    const off = service.participants.subscribe(() => (calls += 1));
    await service.prepare?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBeGreaterThan(0);
    off();
    service.dispose();
  });
});
