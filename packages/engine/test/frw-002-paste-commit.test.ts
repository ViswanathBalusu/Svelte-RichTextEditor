/**
 * FRW-002 criterion 4 through the authority (lane w4): a field is copied and pasted in the editing
 * core, the paste commit is sent to backend-mock's real room, and the room accepts it. The stored
 * document holds two fields with two identifiers and two keys, and satisfies I13 (unique keys). The
 * key of the copy follows the rule proposed in ADR 0366.
 */
import { MockService } from '@docedit/backend-mock';
import { validate } from '@docedit/model/validate';
import { NodeSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, until } from './support.ts';

/** A node of a stored document, as far as this test reads it. */
interface StoredNode {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly content?: readonly StoredNode[];
}

/** The form fields of a stored document, in order. */
function fieldsOf(doc: StoredNode): Array<{ id: unknown; key: unknown }> {
  const out: Array<{ id: unknown; key: unknown }> = [];
  const walk = (n: StoredNode): void => {
    if (n.type === 'form_field') out.push({ id: n.attrs?.['id'], key: n.attrs?.['key'] });
    for (const child of n.content ?? []) walk(child);
  };
  walk(doc);
  return out;
}

describe('a pasted field through the authority (FRW-002 criterion 4)', () => {
  it('the paste commit is accepted, and the stored copy has its own identifier and key', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(
      { ...contractDocument(), requires: ['fields'] },
      { grants: [LEGAL_GRANT_FOR_TESTS] },
    );
    const backend = service.backend({ sub: 'grace' }, { [docId]: 'editor' });
    await backend.connect();
    const content = await backend.sync.loadContent(docId);
    const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });
    const channel = await backend.sync.open(docId, {
      resume: { seq: content.seq, incarnation: content.incarnation },
    });
    const detach = core.attach(channel, {
      seq: content.seq,
      incarnation: content.incarnation,
      sync: backend.sync,
      batchMs: 0,
    });
    try {
      caret(core, IDS.intro, 0);
      const inserted = core.insertContent({
        cdm: 1,
        requires: ['fields'],
        defs: [],
        openStart: 1,
        openEnd: 1,
        content: [
          {
            type: 'paragraph',
            attrs: { id: null, style: 'Normal' },
            content: [
              {
                type: 'form_field',
                attrs: {
                  id: null,
                  key: 'tenant.name',
                  kind: 'text',
                  label: 'Name',
                  assignee: null,
                  value: null,
                },
              },
            ],
          },
        ],
      } as unknown as Parameters<DocumentCore['insertContent']>[0]);
      expect(inserted).toEqual({ ok: true });
      await until(() => core.saveState.get() === 'saved', 'the field is stored');

      // Copy the field with the core's own copy path and paste it before the original.
      const i = internals(core);
      let pos = -1;
      i.state.doc.descendants((node, p) => {
        if (pos < 0 && node.type.name === 'form_field') pos = p;
        return pos < 0;
      });
      i.dispatch(i.state.tr.setSelection(NodeSelection.create(i.state.doc, pos)));
      const copied = core.getSelectionContent();
      caret(core, IDS.intro, 0);
      const before = (await backend.sync.loadContent(docId)).seq;
      expect(core.insertContent(copied)).toEqual({ ok: true });
      await until(() => core.saveState.get() === 'saved', 'the paste commit is acknowledged');
      expect(core.refusal.get()).toBeNull();

      const stored = await backend.sync.loadContent(docId);
      // One commit: the paste, the identifier and the key travel together.
      expect(stored.seq).toBe(before + 1);
      const fields = fieldsOf(stored.doc as unknown as StoredNode);
      expect(fields.map((f) => f.key)).toEqual(['tenant.name_2', 'tenant.name']);
      expect(new Set(fields.map((f) => f.id)).size).toBe(2);
      for (const f of fields) expect(f.id).toMatch(/^[A-Za-z0-9_-]{16}$/);
      expect(
        validate({ cdm: stored.cdm, requires: [...stored.requires], doc: stored.doc }).violations,
      ).toEqual([]);
    } finally {
      detach();
    }
  });
});
