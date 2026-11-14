// Prefill by key, accepted path (FRW-061 criteria 1 and 4, in part). An accepted
// `PATCH /documents/{id}/field-values` hands one server-authored commit to the outbox with origin
// `prefill`, one `value` attribute step per key, and the base it was checked against. Nothing
// here applies the commit: no room or transient authority runs in this harness, so the stored
// commit, the attribution in the log and the rendering through the PDF emitters are not tested
// (see the Notes of FRW-061). Memory storage only; no PostgreSQL run.
import { describe, expect, it } from 'vitest';
import { MemoryOutbox } from '../data-plane/memory-ports.ts';
import {
  documentWithRegions,
  startHarness,
  type Harness,
} from '../../test/control-plane/support.ts';

const fid = (n: number) => `ff${String(n).padStart(14, '0')}`;

/** Two fields a prefill may set: a text field and a decimal number field. */
function prefillDocument(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pPrefill00000001', style: 'Normal' },
    content: [
      {
        type: 'form_field',
        attrs: { id: fid(1), key: 'tenant.name', kind: 'text', label: 'Name', value: null },
      },
      { type: 'text', text: ' ' },
      {
        type: 'form_field',
        attrs: { id: fid(2), key: 'fee.amount', kind: 'number', label: 'Fee', value: null },
      },
    ],
  });
  return d as unknown as Record<string, unknown>;
}

interface QueuedPrefill {
  kind: string;
  request: {
    origin: string;
    actor: unknown;
    base: number;
    steps: Array<{ stepType: string; attr: string; value: unknown; pos: number }>;
  };
}

describe('prefill accepted path, outbox request (FRW-061 criteria 1, 4 in part)', () => {
  it('queues one prefill commit with one value step per key, typed values unchanged', async () => {
    const outbox = new MemoryOutbox();
    const h: Harness = await startHarness('memory', {
      config: { outboxWaitMs: 20 },
      parts: { outbox },
    });
    try {
      const doc = await h.createDocument({ content: prefillDocument() });
      const editor = h.userToken({ [doc]: 'editor' });
      const service = h.serviceJwt();
      const read = await h.call('GET', `/v1/documents/${doc}/field-values`, { token: editor });
      const etag = read.headers.get('etag')!;

      // Typed text that a naive writer might treat as markup, TeX or a spreadsheet formula.
      const typed = {
        'tenant.name': '\\input{/etc/passwd} <b>Ada</b> =HYPERLINK("x")',
        'fee.amount': '12.50',
      };
      const r = await h.call('PATCH', `/v1/documents/${doc}/field-values`, {
        token: service,
        body: { values: typed },
        headers: { 'if-match': etag },
      });
      // No room applies the commit in this harness, so the outbox wait ends with 202 (pending).
      expect(r.status).toBe(202);

      const claimed = (await outbox.claim(
        'frw-061-test',
        60_000,
        10,
      )) as unknown as QueuedPrefill[];
      expect(claimed).toHaveLength(1);
      const item = claimed[0]!;
      expect(item.kind).toBe('author');
      expect(item.request.origin).toBe('prefill');
      expect(item.request.actor).toBeTruthy();
      expect(item.request.base).toBe(0);
      expect(item.request.steps).toHaveLength(2);
      for (const s of item.request.steps) {
        expect(s.stepType).toBe('attr');
        expect(s.attr).toBe('value');
      }
      const byPos = Object.fromEntries(item.request.steps.map((s) => [s.pos, s.value]));
      expect(Object.values(byPos).sort()).toEqual(
        [typed['fee.amount'], typed['tenant.name']].sort(),
      );
    } finally {
      await h.close();
    }
  });
});
