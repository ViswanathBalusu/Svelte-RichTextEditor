/**
 * UX-056 criterion 4: the first custom block adds `extensions` to the document's `requires`; a
 * connected client that did not announce the feature gets the commit refused, with `conflict` and
 * action `drop` (owner decision 260; ADR 0328 decision 2), and the author is told why. The service
 * is the mock, which runs the real room of @docedit/authority.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DocumentCore, type ExtBlockDraft } from '../src/headless.ts';
import { loadParts } from '../src/parts.ts';
import { internals } from '../src/testing.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { microtask, newService, posOf, until } from './support.ts';
import { countedPort } from './support.ts';
import type { MockService } from '@docedit/backend-mock';
import type { DocRole } from '@docedit/protocol';

beforeAll(() => loadParts(['extension']));

const DRAFT: ExtBlockDraft = {
  extension: 'com.example.chart',
  payload: { kind: 'chart', series: [1, 2, 3] },
  fallbackText: 'A chart of three values',
};

/** Joins with the features the editor announces on `ch.open` (03 §11.1). */
async function joinWith(
  service: MockService,
  docId: string,
  sub: string,
  role: DocRole,
  features: readonly string[],
) {
  const backend = service.backend({ sub }, { [docId]: role });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, schedule: microtask });
  const port = countedPort(backend.sync);
  const channel = await port.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
    features,
  });
  const limits = backend.auth.session?.limits;
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: port,
    ...(limits ? { limits } : {}),
    batchMs: 0,
    retry: { minMs: 2, maxMs: 20 },
  });
  await until(() => core.permissions.get() !== null, `access for ${sub}`);
  return { core, detach };
}

const insert = (core: DocumentCore) => {
  const api = core.extensionApi({ maxRanges: 4, later: () => undefined });
  const at = posOf(internals(core).state.doc, IDS.intro);
  return api.insertExtensionBlock(api.range(at, at), DRAFT);
};

const blocksOn = (service: MockService, docId: string): number => {
  let n = 0;
  const walk = (node: { type: string; content?: unknown[] }) => {
    if (node.type === 'extension_block') n++;
    for (const c of node.content ?? []) walk(c as never);
  };
  walk(service.document(docId)!.content().doc as never);
  return n;
};

describe('UX-056 criterion 4: the first block adds `extensions`; a client without it blocks it', () => {
  it('adds `extensions` to the stored requires when every connected client announced it', async () => {
    const service = newService();
    const content = contractDocument();
    expect(content.requires).not.toContain('extensions');
    const docId = service.createDocument(content);
    const all = [...content.requires, 'extensions'];
    const ann = await joinWith(service, docId, 'ann', 'editor', all);
    const bob = await joinWith(service, docId, 'bob', 'editor', all);
    expect(insert(ann.core).ok).toBe(true);
    await ann.core.flush();
    expect(service.document(docId)!.content().requires).toContain('extensions');
    expect(blocksOn(service, docId)).toBe(1);
    expect(ann.core.problem.get()).toBeNull();
    for (const m of [ann, bob]) {
      m.detach();
      m.core.destroy();
    }
  });

  it('refuses it with `conflict` while a connected client lacks the feature, tells the author why, and takes `extensions` back', async () => {
    const service = newService();
    const content = contractDocument();
    const docId = service.createDocument(content);
    const ann = await joinWith(service, docId, 'ann', 'editor', [
      ...content.requires,
      'extensions',
    ]);
    const old = await joinWith(service, docId, 'old', 'editor', [...content.requires]);
    expect(insert(ann.core).ok).toBe(true);
    await until(() => ann.core.problem.get() !== null, 'the refusal');
    const problem = ann.core.problem.get()!;
    expect(problem).toMatchObject({ code: 'conflict', fatal: false });
    expect(problem.message).toContain('extensions');
    expect(problem.message).toContain('lacks it');
    // Nothing reached the service, and the commit is kept as recovered work, with the reason.
    expect(service.document(docId)!.content().requires).not.toContain('extensions');
    expect(blocksOn(service, docId)).toBe(0);
    await until(() => ann.core.recovered.get().count === 1, 'the recovered item');
    expect(ann.core.recovered.get().items[0]).toMatchObject({
      reason: 'conflict',
      kind: 'rejected',
    });
    // This copy does not keep claiming the feature it was refused.
    expect(ann.core.requires).not.toContain('extensions');
    for (const m of [ann, old]) {
      m.detach();
      m.core.destroy();
    }
  });
});
