// The secret store port and the subscription store that keeps references in place of secrets
// (BE-057 criterion 6; owner decision 70).
import { describe, expect, it } from 'vitest';
import { MemorySecretStore, SecretBackedSubscriptionStore } from './secret-store.ts';
import { MemorySubscriptionStore, type SubscriptionRecord } from './webhook-subscriptions.ts';

const record = (secrets: string[], version = 1): SubscriptionRecord => ({
  id: 'sub-1',
  tenant: 't1',
  url: 'https://hooks.example.test/x',
  events: ['dep.document.changed.v1'],
  secrets,
  version,
  createdAt: 1,
  updatedAt: 1,
});

function make() {
  const inner = new MemorySubscriptionStore();
  const secrets = new MemorySecretStore();
  let n = 0;
  const store = new SecretBackedSubscriptionStore(inner, secrets, () => `r${++n}`);
  return { inner, secrets, store };
}

describe('SecretBackedSubscriptionStore', () => {
  it('keeps references in the subscription store and values in the secret store', async () => {
    const { inner, secrets, store } = make();
    await store.insert(record(['whsec_one']));
    const raw = await inner.get('t1', 'sub-1');
    expect(raw?.secrets).toEqual(['webhook-secret/sub-1/r1']);
    expect(JSON.stringify(raw)).not.toContain('whsec_one');
    expect(await secrets.get('t1', 'webhook-secret/sub-1/r1')).toBe('whsec_one');
    expect((await store.get('t1', 'sub-1'))?.secrets).toEqual(['whsec_one']);
    expect((await store.list('t1'))[0]?.secrets).toEqual(['whsec_one']);
    expect(await store.get('t2', 'sub-1')).toBeNull();
  });

  it('adds a second secret on rotation, keeps the first under its reference, and drops the retired one', async () => {
    const { inner, secrets, store } = make();
    await store.insert(record(['whsec_one']));
    expect(await store.replace(record(['whsec_one', 'whsec_two'], 2), 1)).toBe(true);
    expect((await inner.get('t1', 'sub-1'))?.secrets).toEqual([
      'webhook-secret/sub-1/r1',
      'webhook-secret/sub-1/r2',
    ]);
    expect(await store.replace(record(['whsec_two'], 3), 2)).toBe(true);
    expect(await secrets.get('t1', 'webhook-secret/sub-1/r1')).toBeNull();
    expect(await secrets.get('t1', 'webhook-secret/sub-1/r2')).toBe('whsec_two');
  });

  it('puts nothing in the store for a write that lost the race', async () => {
    const { secrets, store } = make();
    await store.insert(record(['whsec_one']));
    expect(await store.replace(record(['whsec_one', 'whsec_two'], 2), 9)).toBe(false);
    expect(await secrets.get('t1', 'webhook-secret/sub-1/r2')).toBeNull();
    expect((await store.get('t1', 'sub-1'))?.secrets).toEqual(['whsec_one']);
  });

  it('removes the secrets with the subscription', async () => {
    const { secrets, store } = make();
    await store.insert(record(['whsec_one']));
    expect(await store.remove('t1', 'sub-1')).toBe(true);
    expect(await secrets.get('t1', 'webhook-secret/sub-1/r1')).toBeNull();
  });

  it('fails loudly when a referenced secret is missing', async () => {
    const { secrets, store } = make();
    await store.insert(record(['whsec_one']));
    await secrets.remove('t1', 'webhook-secret/sub-1/r1');
    await expect(store.get('t1', 'sub-1')).rejects.toThrow(/not in the store/);
  });
});
