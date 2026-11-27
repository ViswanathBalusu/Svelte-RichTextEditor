/**
 * UX-107: the first form field turns `fields` on in a document that does not use forms yet
 * (03 §11.1; CDM-047). The service is the mock, which runs the real room of @docedit/authority with
 * `requiresGrowth` (the document service sets it too, `room-host.ts`). Criteria 1, 2, 3 (room and
 * refusal of a later client without the feature) and 5 here; the storage of the grown list by the
 * document service is `services/document-service/test/ux-107-requires-growth.test.ts`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { loadParts } from '../src/parts.ts';
import { internals } from '../src/testing.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { caret, countedPort, microtask, newService, until } from './support.ts';
import type { MockService } from '@docedit/backend-mock';
import type { DocRole } from '@docedit/protocol';

beforeAll(() => loadParts(['authoring', 'rules']));

/** Joins with the features the editor announces on `ch.open` (03 §11.1) and as the shell passes them. */
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
    features: features as never,
    ...(limits ? { limits } : {}),
    batchMs: 0,
    retry: { minMs: 2, maxMs: 20 },
  });
  await until(() => core.permissions.get() !== null, `access for ${sub}`);
  return { core, detach, backend, channel };
}

const insertText = (core: DocumentCore) => {
  caret(core, IDS.intro, 0);
  return core.run('insertField', { field: { kind: 'text' } });
};

const fieldsOn = (service: MockService, docId: string): number => {
  let n = 0;
  const walk = (node: { type: string; content?: unknown[] }) => {
    if (node.type === 'form_field') n++;
    for (const c of node.content ?? []) walk(c as never);
  };
  walk(service.document(docId)!.content().doc as never);
  return n;
};

function leave(...members: Array<{ detach: () => void; core: DocumentCore }>): void {
  for (const m of members) {
    m.detach();
    m.core.destroy();
  }
}

describe('UX-107 criterion 1: the first field adds `fields` to `requires`', () => {
  it('stores the field and a sorted `requires` with `fields`, and every client sees both', async () => {
    const service = newService();
    const content = contractDocument();
    expect(content.requires).not.toContain('fields');
    const docId = service.createDocument(content);
    const all = [...content.requires, 'fields'];
    const ann = await joinWith(service, docId, 'ann', 'editor', all);
    const bob = await joinWith(service, docId, 'bob', 'editor', all);
    expect(ann.core.requires).not.toContain('fields');
    expect(insertText(ann.core)).toBe(true);
    // The copy says it uses forms at once, as the room's list will.
    expect(ann.core.requires).toContain('fields');
    await ann.core.flush();
    const stored = service.document(docId)!.content().requires;
    expect(stored).toContain('fields');
    expect([...stored]).toEqual([...stored].sort());
    expect(fieldsOn(service, docId)).toBe(1);
    expect(ann.core.problem.get()).toBeNull();
    // Bob's copy takes the field from the relay and says so too.
    await until(() => bob.core.requires.includes('fields'), 'the relay to bob');
    // A read after the commit sees it: a reload gives the grown list.
    const read = await ann.backend.sync.loadContent(docId);
    expect(read.requires).toContain('fields');
    leave(ann, bob);
  });

  it('allows roles and rules too, and the first of them adds `fields` the same way', async () => {
    const service = newService();
    const content = contractDocument();
    const docId = service.createDocument(content);
    const ann = await joinWith(service, docId, 'ann', 'editor', [...content.requires, 'fields']);
    const id = ann.core.nextRoleId();
    const role = { op: 'add', id, values: { name: 'Tenant', color: '#2CA02C' } } as const;
    // A check only: the document does not use forms yet, and the author may turn them on.
    expect(ann.core.editRole(role, true)).toEqual({ ok: true });
    expect(ann.core.requires).not.toContain('fields');
    expect(ann.core.editRole(role)).toEqual({ ok: true });
    expect(ann.core.requires).toContain('fields');
    await ann.core.flush();
    expect(service.document(docId)!.content().requires).toContain('fields');
    leave(ann);
  });
});

describe('UX-107 criterion 2: a client without the feature blocks it, with a notice', () => {
  it('refuses the commit, reverts the field, says why, and the same insert works after the client left', async () => {
    const service = newService();
    const content = contractDocument();
    const docId = service.createDocument(content);
    const ann = await joinWith(service, docId, 'ann', 'editor', [...content.requires, 'fields']);
    const old = await joinWith(service, docId, 'old', 'editor', [...content.requires]);
    expect(insertText(ann.core)).toBe(true);
    await until(() => ann.core.problem.get() !== null, 'the refusal');
    const problem = ann.core.problem.get()!;
    expect(problem).toMatchObject({ code: 'conflict', fatal: false });
    expect(problem.message).toMatch(/cannot yet work with forms/);
    // `requires` is unchanged, in the service and in this copy; the field is gone from both.
    expect(service.document(docId)!.content().requires).not.toContain('fields');
    expect(fieldsOn(service, docId)).toBe(0);
    expect(ann.core.requires).not.toContain('fields');
    await until(() => ann.core.recovered.get().count === 1, 'the recovered item');
    expect(ann.core.recovered.get().items[0]).toMatchObject({ reason: 'conflict' });
    const fieldsInCopy = (): number => {
      let n = 0;
      internals(ann.core).state.doc.descendants((node) => {
        if (node.type.name === 'form_field') n++;
        return true;
      });
      return n;
    };
    expect(fieldsInCopy()).toBe(0);
    // The client leaves; the same insert now succeeds.
    leave(old);
    // The client's channel is closed, as a tab that was shut closes it.
    old.channel.close();
    // The room notices the closed channel on its own turn, so the insert is tried until it is stored.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 25));
      if (!insertText(ann.core)) throw new Error('the insert was not offered');
      await ann.core.flush();
      await new Promise((r) => setTimeout(r, 25));
      if (service.document(docId)!.content().requires.includes('fields')) break;
    }
    expect(service.document(docId)!.content().requires).toContain('fields');
    expect(fieldsOn(service, docId)).toBe(1);
    leave(ann);
  });
});

// Criterion 3 (a client that connects later without `fields` is refused with `unsupported_feature`)
// is the document service's: services/document-service/test/data-plane/ux-107-requires-growth.test.ts.
// The mock backend does not refuse a late client.

describe('UX-107 criterion 5: a document that already requires `fields` is as before', () => {
  it('inserts, and `requires` does not change', async () => {
    const service = newService();
    const content = contractDocument();
    content.requires = [
      ...new Set([...content.requires, 'fields']),
    ].sort() as typeof content.requires;
    const docId = service.createDocument(content);
    const ann = await joinWith(service, docId, 'ann', 'editor', content.requires);
    const before = [...service.document(docId)!.content().requires];
    expect(insertText(ann.core)).toBe(true);
    await ann.core.flush();
    expect(service.document(docId)!.content().requires).toEqual(before);
    expect(ann.core.requires).toEqual(before);
    leave(ann);
  });
});

describe('UX-107 criterion 4: when the feature cannot be turned on, the insert is refused', () => {
  it('is refused when the backend did not announce `fields`, and when the reader has no edit', async () => {
    const service = newService();
    const content = contractDocument();
    const docId = service.createDocument(content);
    const plain = await joinWith(service, docId, 'ann', 'editor', [...content.requires]);
    expect(insertText(plain.core)).toBe(false);
    expect(plain.core.requires).not.toContain('fields');
    // The core says which: the shell states it as `reason.query.noForms`, and roles and rules say
    // `no-feature`, which the panes state in their own words.
    expect(plain.core.queryReason('canInsertField')).toBe('noForms');
    expect(
      plain.core.editRole({ op: 'add', id: plain.core.nextRoleId(), values: { name: 'A' } }, true),
    ).toEqual({ ok: false, reason: 'no-feature' });
    // With the feature announced the same checks pass and give no reason.
    const forms = await joinWith(service, docId, 'ann2', 'editor', [...content.requires, 'fields']);
    caret(forms.core, IDS.intro, 0);
    expect(forms.core.queryReason('canInsertField')).toBeNull();
    leave(forms);
    const viewer = await joinWith(service, docId, 'vic', 'viewer', [...content.requires, 'fields']);
    expect(insertText(viewer.core)).toBe(false);
    expect(fieldsOn(service, docId)).toBe(0);
    leave(plain, viewer);
  });
});
