/**
 * FRW-001 criterion 4 — a user with `structure` adds a `role_def`; the commit is accepted and the
 * definition is in the next `GET /documents/{id}/content`. The case runs over the wire against the
 * real document service (memory storage; the PostgreSQL variant skips without the integration
 * environment): the commit goes through the data plane's room and the read through the control
 * plane's content route. A commenter, who has no `structure`, is the control.
 */
import { ReplaceStep } from 'prosemirror-transform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { Fragment, Slice, loadDoc, schema, stepsJson, type Node } from './support/cdm.ts';
import { WireClient } from './support/wire.ts';

const ROLE = { id: 'role_auditor', name: 'Auditor', color: '#2CA02C' };

/** Every `role_def` in the document, as its attributes. */
function roleDefs(doc: Node): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  doc.descendants((n) => {
    if (n.type.name === 'role_def') found.push({ ...n.attrs });
    return true;
  });
  return found;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`FRW-001 an added role_def is in the next content read (${storage})`, () => {
    let h: Harness;
    let doc: string;
    beforeAll(async () => {
      if (!skip) {
        h = await startHarness(storage);
        // A `role_def` belongs to the feature `fields`, which the envelope must list (03 §3).
        doc = await h.createDocument(h.a, { ...documentWithRegions(), requires: ['fields'] });
      }
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    /** The stored content, as the service serves it, with its current seq. */
    const current = async () => {
      const r = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey });
      expect(r.status).toBe(200);
      return { doc: loadDoc(r.json.doc as unknown), seq: Number(r.json.seq ?? 0) };
    };

    /** Submits one commit that appends the role definition to `defs`, as `token`. */
    const addRole = async (token: string) => {
      const cur = await current();
      const defs = cur.doc.child(0);
      expect(defs.type.name).toBe('defs');
      const end = 1 + defs.content.size;
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      try {
        await c.hello(token, { features: ['presence', 'regions', 'fields'] });
        const opened = await c.open(1, doc, { features: ['regions', 'presence', 'fields'] });
        expect(opened.t, JSON.stringify(opened.d)).toBe('ch.opened');
        return await c.submit(1, {
          id: uuid7(),
          base: cur.seq,
          steps: stepsJson([
            new ReplaceStep(
              end,
              end,
              new Slice(Fragment.from(schema.nodes['role_def']!.create(ROLE)), 0, 0),
            ),
          ]),
        });
      } finally {
        c.terminate();
      }
    };

    t()('a commenter, without structure, is refused and the content does not change', async () => {
      const commenter = await h.mintToken(h.a, 'commenter-frw001', { [doc]: 'commenter' });
      const before = await current();
      const r = await addRole(commenter);
      expect(r.t).toBe('sync.reject');
      expect(r.d?.['code']).toBe('permission_denied');
      const after = await current();
      expect(after.seq).toBe(before.seq);
      expect(roleDefs(after.doc)).toEqual(roleDefs(before.doc));
    });

    t()('an editor, with structure, is accepted and the next read has the role_def', async () => {
      const editor = await h.mintToken(h.a, 'editor-frw001', { [doc]: 'editor' });
      const before = await current();
      expect(roleDefs(before.doc).some((a) => a['id'] === ROLE.id)).toBe(false);
      const r = await addRole(editor);
      expect(r.t, JSON.stringify(r.d)).toBe('sync.ack');
      const after = await current();
      expect(after.seq).toBe(before.seq + 1);
      expect(roleDefs(after.doc)).toContainEqual(expect.objectContaining(ROLE));
    });
  });
}
