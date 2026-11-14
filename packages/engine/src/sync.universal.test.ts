/**
 * What must agree in Node.js and in every browser engine (02 §14; FE-121): the sync client hosted in
 * the core converging with the real `Room` of backend-mock, the rebuild transaction reaching the
 * rebuilt document exactly, and the identifier source. Runs in Node.js and, with
 * `pnpm test:browsers`, in Chromium, Firefox and WebKit.
 */
import { MockService } from '@docedit/backend-mock';
import { contractDocument, IDS } from '@docedit/protocol/contract';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from './core.ts';
import { internals, rebuildStats } from './testing.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function posOf(core: DocumentCore, id: string): number {
  let found = -1;
  internals(core).state.doc.descendants((node, pos) => {
    if (found < 0 && node.attrs['id'] === id) found = pos;
    return found < 0;
  });
  return found;
}

async function join(service: MockService, docId: string, sub: string) {
  const backend = service.backend({ sub }, { [docId]: 'owner' });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: backend.sync,
    batchMs: 0,
  });
  return { core, backend };
}

describe('the sync client agrees across engines', () => {
  it('two cores typing into the same paragraph converge with the room', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(contractDocument());
    const a = await join(service, docId, 'ann');
    const b = await join(service, docId, 'bob');
    const before = { ...rebuildStats };
    for (let k = 0; k < 8; k++) {
      for (const [m, text] of [
        [a, `a${k}`],
        [b, `b${k}`],
      ] as const) {
        const i = internals(m.core);
        const at = posOf(m.core, IDS.intro) + 1 + (k % 3);
        i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at)).insertText(text));
      }
      await sleep(k % 2);
    }
    const end = Date.now() + 5000;
    while (a.core.saveState.get() !== 'saved' || b.core.saveState.get() !== 'saved') {
      if (Date.now() > end) throw new Error('not saved');
      await sleep(1);
    }
    const server = await a.backend.sync.loadContent(docId);
    while (internals(a.core).sync.seq < server.seq || internals(b.core).sync.seq < server.seq) {
      if (Date.now() > end) throw new Error('not at the head');
      await sleep(1);
    }
    expect(internals(a.core).state.doc.toJSON()).toEqual(server.doc);
    expect(internals(b.core).state.doc.toJSON()).toEqual(server.doc);
    // Remote work arrived as rebuilds, none of which needed a correction or a fallback.
    expect(rebuildStats.built).toBeGreaterThan(before.built);
    expect(rebuildStats.fallback).toBe(before.fallback);
    await service.dispose();
  });

  it('fills identifiers from WebCrypto: 16 URL-safe Base64 characters, unique', () => {
    const core = new DocumentCore({ doc: contractDocument() as never });
    const i = internals(core);
    const ids = new Set<string>();
    for (let k = 0; k < 50; k++) {
      i.dispatch(i.state.tr.insert(posOf(core, IDS.end), i.schema.nodes['paragraph']!.create()));
      const id = i.state.doc.nodeAt(posOf(core, IDS.end) - 2)!.attrs['id'];
      expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
      ids.add(String(id));
    }
    expect(ids.size).toBe(50);
  });
});
