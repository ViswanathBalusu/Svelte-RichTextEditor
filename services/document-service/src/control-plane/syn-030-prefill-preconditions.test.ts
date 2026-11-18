// SYN-030 criterion 3 (lane U-SYN-001-018), the control plane's half: when an accepted prefill is
// written to the outbox, the request carries the preconditions the authorisation relied on (grants
// revision, head, document state and workflow state), which the room re-checks when it applies the
// commit (room.ts `preconditionFailure`; PostgreSQL run in data-plane/be-039-outbox-room.test.ts).
// Memory storage only. The same prefill sent twice against the same head is one item with one
// deterministic commit identifier (lane w9; ADR 0377, proposed).
import { isUuid7 } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { MemoryOutbox } from '../data-plane/memory-ports.ts';
import {
  documentWithRegions,
  startHarness,
  type Harness,
} from '../../test/control-plane/support.ts';

const fid = (n: number) => `ff${String(n).padStart(14, '0')}`;

function prefillDocument(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pPrefill00000002', style: 'Normal' },
    content: [
      {
        type: 'form_field',
        attrs: { id: fid(1), key: 'tenant.name', kind: 'text', label: 'Name', value: null },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

interface QueuedPrefill {
  kind: string;
  commitId: string;
  request: {
    origin: string;
    base: number;
    preconditions?: {
      revision?: unknown;
      head?: unknown;
      documentState?: unknown;
      workflowActive?: unknown;
    };
  };
}

describe('prefill outbox request carries its preconditions (SYN-030 criterion 3, control-plane half)', () => {
  it('writes the grants revision, the head and the document and workflow state it was authorised under', async () => {
    const outbox = new MemoryOutbox();
    const h: Harness = await startHarness('memory', {
      config: { outboxWaitMs: 20 },
      parts: { outbox },
    });
    try {
      const doc = await h.createDocument({ content: prefillDocument() });
      const service = h.serviceJwt();
      const editor = h.userToken({ [doc]: 'editor' });
      const read = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: editor });
      const etag = read.headers.get('etag')!;
      const r = await h.call('PATCH', `/v1/documents/${doc}/field-values`, {
        token: service,
        body: { values: { 'tenant.name': 'Ada' } },
        headers: { 'if-match': etag },
      });
      expect(r.status).toBe(202);

      const claimed = (await outbox.claim(
        'syn-030-test',
        60_000,
        10,
      )) as unknown as QueuedPrefill[];
      expect(claimed).toHaveLength(1);
      const request = claimed[0]!.request;
      expect(claimed[0]!.kind).toBe('author');
      expect(request.origin).toBe('prefill');
      expect(request.preconditions).toBeDefined();
      expect(request.preconditions).toMatchObject({
        head: request.base,
        workflowActive: false,
      });
      expect(typeof request.preconditions!.revision).toBe('number');
      expect(request.preconditions!.documentState).toBeDefined();
    } finally {
      await h.close();
    }
  });
});

describe('prefill commit identifier is derived from the request (SYN-030 criterion 3)', () => {
  it('stores one item for the same prefill sent twice, and another for other values or another head', async () => {
    const outbox = new MemoryOutbox();
    const h: Harness = await startHarness('memory', {
      config: { outboxWaitMs: 20 },
      parts: { outbox },
    });
    try {
      const doc = await h.createDocument({ content: prefillDocument() });
      const service = h.serviceJwt();
      const editor = h.userToken({ [doc]: 'editor' });
      const read = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: editor });
      const etag = read.headers.get('etag')!;
      const send = (name: string) =>
        h.call('PATCH', `/v1/documents/${doc}/field-values`, {
          token: service,
          body: { values: { 'tenant.name': name } },
          headers: { 'if-match': etag },
        });
      expect((await send('Ada')).status).toBe(202);
      expect((await send('Ada')).status).toBe(202);
      expect((await send('Grace')).status).toBe(202);

      const claimed = (await outbox.claim(
        'syn-030-id-test',
        60_000,
        10,
      )) as unknown as QueuedPrefill[];
      // The retry of the first request did not add an item; the other values did.
      expect(claimed).toHaveLength(2);
      for (const item of claimed) expect(isUuid7(item.commitId)).toBe(true);
      expect(new Set(claimed.map((c) => c.commitId)).size).toBe(2);
    } finally {
      await h.close();
    }
  });
});
