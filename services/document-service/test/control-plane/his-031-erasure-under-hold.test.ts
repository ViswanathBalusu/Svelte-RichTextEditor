// HIS-031 criterion 5 (owner decision 38): erasing a person who appears in a document under hold
// is deferred until the hold is released, and the request and the delay are audited. Memory
// stores; test values only. The route and the durable pending store do not exist yet.
import { describe, expect, it } from 'vitest';
import { ErasureRequests } from '../../src/control-plane/erasure-requests.ts';
import { MemoryUserDirectory } from '../../src/control-plane/users.ts';
import { MemoryAudit } from '../../src/data-plane/memory-ports.ts';

const T = '11111111-1111-4111-8111-111111111111';

function setup() {
  const users = new MemoryUserDirectory();
  const audit = new MemoryAudit();
  const held = new Set<string>();
  const wrote = new Map<string, string[]>();
  let clock = 1_000;
  const svc = new ErasureRequests({
    users,
    audit,
    heldDocuments: async () => held,
    documentsOf: async (_t, s) => wrote.get(s) ?? [],
    now: () => clock,
  });
  return { users, audit, held, wrote, svc, tick: (ms: number) => (clock += ms) };
}

describe('erasing a person under a legal hold (HIS-031 criterion 5)', () => {
  it('erases at once when none of the person documents is held', async () => {
    const s = setup();
    const p = await s.users.resolve(T, 'sub-a');
    s.wrote.set(p.surrogate, ['d1']);
    s.held.add('d2');
    expect(await s.svc.erase(T, 'sub-a', 'admin')).toBe('erased');
    expect((await s.users.subsOf(T, [p.surrogate])).size).toBe(0);
    const run = await s.audit.query(T, { kind: 'erasure.run', limit: 10 });
    expect(run).toHaveLength(1);
    expect(run[0]!.data).toMatchObject({ delayMs: 0 });
  });

  it('keeps the mapping while a document of the person is held, and audits the request', async () => {
    const s = setup();
    const p = await s.users.resolve(T, 'sub-b');
    s.wrote.set(p.surrogate, ['d1', 'd2']);
    s.held.add('d2');
    expect(await s.svc.erase(T, 'sub-b', 'admin')).toBe('deferred');
    expect((await s.users.subsOf(T, [p.surrogate])).get(p.surrogate)).toBe('sub-b');
    const deferred = await s.audit.query(T, { kind: 'erasure.deferred', limit: 10 });
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.actor).toBe('admin');
    expect(deferred[0]!.data).toMatchObject({ person: p.surrogate, blockedBy: ['d2'] });
    expect(JSON.stringify(s.audit.events)).not.toContain('sub-b');
    expect(s.svc.pending(T)).toHaveLength(1);
  });

  it('runs the request when the hold is released and audits the delay', async () => {
    const s = setup();
    const p = await s.users.resolve(T, 'sub-c');
    s.wrote.set(p.surrogate, ['d1']);
    s.held.add('d1');
    await s.svc.erase(T, 'sub-c', 'admin');
    s.tick(60_000);
    expect(await s.svc.afterRelease(T)).toBe(0);
    s.held.delete('d1');
    s.tick(60_000);
    expect(await s.svc.afterRelease(T)).toBe(1);
    expect((await s.users.subsOf(T, [p.surrogate])).size).toBe(0);
    expect(s.svc.pending(T)).toHaveLength(0);
    const run = await s.audit.query(T, { kind: 'erasure.run', limit: 10 });
    expect(run).toHaveLength(1);
    expect(run[0]!.data).toMatchObject({
      person: p.surrogate,
      requestedAt: 1_000,
      delayMs: 120_000,
    });
    expect(JSON.stringify(s.audit.events)).not.toContain('sub-c');
  });
});
