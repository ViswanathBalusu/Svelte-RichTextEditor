// EXP-081 criterion 3: an export with `accept` carries what the worker needs to honour a
// whole-block deletion only if it passes the permission rules (09 §10; owner decision 111): the
// owner of each suggestion identifier and the scopes where the requester may edit. The test reads
// the queued job's payload; the worker's use of it is tested in the export worker.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { suggestionOwners } from '../../src/control-plane/content.ts';
import { FULL_VIEWS } from '../../src/control-plane/visibility.ts';
import { documentWithRegions, startHarness, type Harness } from './support.ts';

const SID = 'sDel081w20000001';

/** A document whose first body paragraph carries a suggested deletion of the whole block. */
function withBlockDeletion(): Record<string, unknown> {
  const c = documentWithRegions() as {
    doc: { content: Array<{ content: Array<{ attrs?: Record<string, unknown> }> }> };
  };
  const p = c.doc.content[1]!.content[0]!;
  p.attrs = { ...p.attrs, suggest: [{ type: 'del', attrs: { id: SID, user: 'alice' } }] };
  return c;
}

describe('suggestionOwners', () => {
  it('reads the owner from marks and from block suggestions, and drops a shared identifier', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { suggest: [{ type: 'del', attrs: { id: 'a', user: 'u1' } }] },
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'x', marks: [{ type: 'ins', attrs: { id: 'b', user: 'u2' } }] },
            { type: 'text', text: 'y', marks: [{ type: 'ins', attrs: { id: 'c', user: 'u2' } }] },
            { type: 'text', text: 'z', marks: [{ type: 'del', attrs: { id: 'c', user: 'u3' } }] },
            { type: 'text', text: 'w', marks: [{ type: 'bold' }] },
          ],
        },
      ],
    };
    expect({ ...suggestionOwners(doc) }).toEqual({ a: 'u1', b: 'u2' });
  });
});

describe('EXP-081 criterion 3: the export payload carries the owners and the grants (memory)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('memory', {
      views: FULL_VIEWS,
      config: { exportTargets: ['pdf', 'md'] },
    });
  });
  afterAll(async () => {
    await h?.close();
  });

  async function payloadOf(
    token: string,
    doc: string,
    options: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const r = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token,
      body: { target: 'md', options },
    });
    expect(r.status).toBe(202);
    const job = await h.parts.queue.get(h.tenant, r.json.id as string);
    return job!.payload;
  }

  it('names the owner and the scopes the requester may edit for a requester who may edit', async () => {
    const doc = await h.createDocument({ content: withBlockDeletion() });
    const editor = await payloadOf(h.userToken({ [doc]: 'editor' }), doc, {
      suggestions: 'accept',
    });
    expect(editor['suggestionAccess']).toEqual({
      owners: { [SID]: 'alice' },
      edit: ['body', 'region:rOpen00000000001'],
    });
    const viewer = await payloadOf(h.userToken({ [doc]: 'viewer' }), doc, {
      suggestions: 'accept',
    });
    expect(viewer['suggestionAccess']).toEqual({ owners: { [SID]: 'alice' }, edit: [] });
  });

  it('is absent under reject and markup, and a different grant is a different job', async () => {
    const doc = await h.createDocument({ content: withBlockDeletion() });
    const editor = h.userToken({ [doc]: 'editor' });
    expect((await payloadOf(editor, doc, { suggestions: 'reject' }))['suggestionAccess']).toBe(
      undefined,
    );
    const a = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: editor,
      body: { target: 'md', options: { suggestions: 'accept' } },
    });
    const b = await h.call('POST', `/v1/documents/${doc}/exports`, {
      token: h.userToken({ [doc]: 'viewer' }),
      body: { target: 'md', options: { suggestions: 'accept' } },
    });
    expect(a.json.id).not.toBe(b.json.id);
  });
});
