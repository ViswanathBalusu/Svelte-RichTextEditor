// FRW-065 criteria 1 and 2: the features of the fields, rules and workflow epic are announced only
// when this composition implements them (12 section 10; 05 section 2). Discovery says what the
// service announces; a service built without the workflow store, without the signing ceremony's
// stores or without the signing service does not announce `workflow`, `sign` or `seal`.
// `fields` is the CDM feature of the data plane (the fill outcome check, the prefill and the
// field resources) and `rules` the data plane's own; the service has both whatever it is built of.
// In-memory storage, no containers.
import { afterAll, describe, expect, it } from 'vitest';
import type { ServiceParts } from '../../src/server.ts';
import { MemoryConsentTextStore } from '../../src/workflow/consent-service.ts';
import type { SigningClient } from '../../src/workflow/signing-client.ts';
import { startHarness, type Harness } from './support.ts';

/** A signing client that is never called: sealing is configured, not exercised. */
const idle: SigningClient = {
  seal: () => Promise.reject(new Error('not called')),
  anchor: () => Promise.reject(new Error('not called')),
  extend: () => Promise.reject(new Error('not called')),
};
const sealing = { signing: idle, retry: { attempts: 1, delaysMs: [0] }, retainMs: 1000 };

/** The consent texts of the signing ceremony: a host supplies the store; the default has none. */
const consent = () => ({ consentTexts: new MemoryConsentTextStore() });

/** The parts with the consent texts, and without key (a part that is absent is not offered). */
const without = (key: keyof ServiceParts): Partial<ServiceParts> =>
  ({ ...consent(), [key]: undefined }) as unknown as Partial<ServiceParts>;

const harnesses: Harness[] = [];
afterAll(async () => {
  for (const h of harnesses) await h.close();
});

async function announced(h: Harness): Promise<string[]> {
  harnesses.push(h);
  const res = await fetch(`${h.base}/.well-known/dep`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { features: string[] }).features;
}

const FRW = ['fields', 'rules', 'workflow', 'sign', 'seal'];
const only = (features: string[]) => features.filter((f) => FRW.includes(f)).sort();

describe('the features of the fields, rules and workflow epic are announced as built (FRW-065)', () => {
  it('announces fields, rules and workflow by default: the signing ceremony needs the consent texts of a host', async () => {
    const h = await startHarness('memory', { realDataPlane: true });
    expect(only(await announced(h))).toEqual(['fields', 'rules', 'workflow']);
  }, 120_000);

  it('announces sign with the consent texts, and seal as well when the signing service is configured', async () => {
    const signing = await startHarness('memory', { realDataPlane: true, parts: consent() });
    expect(only(await announced(signing))).toEqual(['fields', 'rules', 'sign', 'workflow']);
    const sealed = await startHarness('memory', {
      realDataPlane: true,
      parts: consent(),
      finalSealing: sealing,
    });
    expect(only(await announced(sealed))).toEqual(['fields', 'rules', 'seal', 'sign', 'workflow']);
  }, 240_000);

  it('does not announce workflow, sign or seal without the workflow resource', async () => {
    const h = await startHarness('memory', {
      realDataPlane: true,
      parts: without('workflows'),
    });
    expect(only(await announced(h))).toEqual(['fields', 'rules']);
  }, 120_000);

  it('does not announce sign without the evidence ledger, the consent texts or the outbox', async () => {
    for (const missing of ['evidence', 'consentTexts', 'outbox'] as const) {
      const h = await startHarness('memory', {
        realDataPlane: true,
        parts: without(missing),
      });
      const features = only(await announced(h));
      expect(features, missing).toContain('workflow');
      expect(features, missing).not.toContain('sign');
      expect(features, missing).not.toContain('seal');
    }
  }, 240_000);

  it('announces the same features in the welcome of a session as in discovery', async () => {
    const h = await startHarness('memory', {
      realDataPlane: true,
      parts: consent(),
      finalSealing: sealing,
    });
    const features = await announced(h);
    const { DepClient } = await import('../data-plane/client.ts');
    const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
    try {
      const doc = await h.createDocument({});
      const welcome = await c.hello(h.userToken({ [doc]: 'editor' }));
      expect(welcome.t).toBe('welcome');
      expect(
        only(((welcome as { d?: { features?: string[] } }).d?.features ?? []) as string[]),
      ).toEqual(only(features));
    } finally {
      c.terminate();
    }
  }, 120_000);
});
