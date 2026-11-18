// The backend-mock half of PRO-099 criterion 1 (no network request) and criterion 3 (an optional
// port that is absent is not offered). The element half of both criteria is not built here: it is
// PRO-099's element and shell work (packets B2 and U).
import { contractDocument } from '@docedit/protocol/contract';
import type { Step } from '@docedit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { MockService } from '../src/index.ts';

const insert = (pos: number, text: string): Step => ({
  stepType: 'replace',
  from: pos,
  to: pos,
  slice: { content: [{ type: 'text', text }] },
});

/** Network entry points a page can reach; each records the call and then refuses it. */
const NETWORK_NAMES = ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource'] as const;

type Net = Record<(typeof NETWORK_NAMES)[number], unknown>;
const globals = globalThis as unknown as Net;
const saved = new Map<string, unknown>();
const calls: string[] = [];

function trapNetwork(): void {
  for (const name of NETWORK_NAMES) {
    if (!saved.has(name)) saved.set(name, globals[name]);
    globals[name] = function trapped() {
      calls.push(name);
      throw new Error(`network request through ${name}`);
    } as unknown;
  }
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) Reflect.deleteProperty(globals, name);
    else globals[name as keyof Net] = value as never;
  }
  saved.clear();
  calls.length = 0;
});

describe('backend-mock runs with no network request (PRO-099, backend half of criterion 1)', () => {
  it('connects, loads, opens and accepts an edit without touching the network', async () => {
    trapNetwork();
    const service = new MockService();
    const docId = service.createDocument(contractDocument());
    const backend = service.backend({ sub: 'eddie' }, { [docId]: 'editor' });
    await backend.connect();
    const content = await backend.sync.loadContent(docId);
    const channel = await backend.sync.open(docId, {
      resume: { seq: content.seq, incarnation: content.incarnation },
    });
    const ack = await channel.submit({
      id: '0192f0c4-7b1e-7c3a-9a54-0000000000a1',
      base: content.seq,
      steps: [insert(7, 'offline')],
    });
    expect(ack.seq).toBe(content.seq + 1);
    await backend.close();
    await service.dispose();
    expect(calls).toEqual([]);
  });

  it('a second connection to the same service also makes no network request', async () => {
    trapNetwork();
    const service = new MockService();
    const docId = service.createDocument(contractDocument());
    const first = service.backend({ sub: 'olivia' }, { [docId]: 'owner' });
    const second = service.backend({ sub: 'sam' }, { [docId]: 'editor' });
    await first.connect();
    await second.connect();
    expect((await second.sync.loadContent(docId)).seq).toBe(0);
    await first.close();
    await second.close();
    await service.dispose();
    expect(calls).toEqual([]);
  });
});

describe('backend-mock without the presence port (PRO-099, backend half of criterion 3)', () => {
  it('omits the presence port and the feature when the service does not offer them', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(contractDocument());
    const backend = service.backend({ sub: 'eddie' }, { [docId]: 'editor' });
    await backend.connect();
    expect(backend.presence).toBeUndefined();
    expect(backend.features.has('presence')).toBe(false);
    await backend.close();
    await service.dispose();
  });

  it('offers the presence port and the feature when the service offers them', async () => {
    const service = new MockService();
    const docId = service.createDocument(contractDocument());
    const backend = service.backend({ sub: 'eddie' }, { [docId]: 'editor' });
    await backend.connect();
    expect(backend.presence).toBeDefined();
    expect(backend.features.has('presence')).toBe(true);
    await backend.close();
    await service.dispose();
  });

  it('negotiates features as the intersection of what the client asks for and what is offered', async () => {
    const service = new MockService();
    const docId = service.createDocument(contractDocument());
    const asksNothing = service.backend({ sub: 'eddie' }, { [docId]: 'editor' }, { features: [] });
    await asksNothing.connect();
    expect([...asksNothing.features]).toEqual([]);
    await asksNothing.close();
    const asksPresence = service.backend(
      { sub: 'eddie' },
      { [docId]: 'editor' },
      { features: ['presence', 'workflow'] },
    );
    await asksPresence.connect();
    // `workflow` is not offered by the mock, so it is never negotiated.
    expect([...asksPresence.features]).toEqual(['presence']);
    await asksPresence.close();
    await service.dispose();
  });
});
