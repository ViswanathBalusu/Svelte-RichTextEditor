// BE-070: the routing rules of storage/shards.ts, over stand-in stores (no database).
import { describe, expect, it } from 'vitest';
import { CrossShardError, ShardMap, UnknownTenantShard } from '../control-plane/jobs/sharding.ts';
import { foldAny, foldUnion, routeByTenant } from './shards.ts';

interface Probe {
  get(ref: { tenant: string; doc: string }): Promise<string>;
  put(tenant: string): Promise<string>;
  record(events: ReadonlyArray<{ tenant: string }>): Promise<string>;
  list(): Promise<string[]>;
  known(origin: string): Promise<boolean>;
  extra?(tenant: string): Promise<string>;
  readonly label: string;
}

const probe = (shard: string, withExtra: boolean): Probe => ({
  label: shard,
  get: async (ref) => `${shard}:${ref.tenant}:${ref.doc}`,
  put: async (tenant) => `${shard}:${tenant}`,
  record: async (events) => `${shard}:${events.length}`,
  list: async () => [shard, 'shared'],
  known: async (origin) => origin === shard,
  ...(withExtra ? { extra: async (t: string) => `${shard}:${t}` } : {}),
});

const map = new ShardMap(['a', 'b'], { t1: 'a', t2: 'b', t3: 'a' });
const route = (withExtra = true) =>
  routeByTenant<Probe>(
    map,
    { a: probe('a', withExtra), b: probe('b', withExtra) },
    { fanOut: { list: foldUnion, known: foldAny } },
  );

describe('routeByTenant (BE-070)', () => {
  it('sends a call to the shard of the tenant in its first argument', async () => {
    const r = route();
    expect(await r.put('t1')).toBe('a:t1');
    expect(await r.put('t2')).toBe('b:t2');
    expect(await r.get({ tenant: 't2', doc: 'd' })).toBe('b:t2:d');
    expect(await r.record([{ tenant: 't1' }, { tenant: 't3' }])).toBe('a:2');
  });

  it('refuses an unknown tenant, a list across shards and a call that names no tenant', async () => {
    const r = route();
    await expect(r.put('nobody')).rejects.toBeInstanceOf(UnknownTenantShard);
    await expect(r.record([{ tenant: 't1' }, { tenant: 't2' }])).rejects.toBeInstanceOf(
      CrossShardError,
    );
    await expect(r.record([{ tenant: 't1' }, {} as { tenant: string }])).rejects.toThrow(TypeError);
    await expect(r.put(7 as unknown as string)).rejects.toThrow(TypeError);
  });

  it('asks every shard for a fan-out method and joins the answers', async () => {
    const r = route();
    expect(await r.list()).toEqual(['a', 'shared', 'b']);
    expect(await r.known('b')).toBe(true);
    expect(await r.known('c')).toBe(false);
  });

  it('keeps an optional method absent when the stores lack it, and refuses mismatched shards', () => {
    expect(route(false).extra).toBeUndefined();
    expect(typeof route(true).extra).toBe('function');
    expect(() => routeByTenant(map, { a: probe('a', false) })).toThrow(RangeError);
    expect(() =>
      routeByTenant(map, { a: probe('a', false), b: probe('b', false), c: probe('c', false) }),
    ).toThrow(RangeError);
  });
});
