/**
 * SEC-034 criterion 1 at commit time, through the production path (lane U-SEC-033-048).
 *
 * The earlier room test (math-commit-gate.test.ts) injects the gate into a room it builds itself.
 * This one runs the real document service (its data plane, room host and WebSocket) and submits
 * equations as a client would. An ordinary equation is accepted first, so the refusals are not
 * vacuous; a definition or a primitive in `latex` is then refused with invalid_op and nothing is
 * stored (I8). Node.js only, memory storage; the real gate of packages/export-latex is used by the
 * room host (services/document-service/src/data-plane/room-host.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { documentWithRegions, posOf, startHarness, type Harness } from './support/harness.ts';
import { WireClient } from './support/wire.ts';

type J = Record<string, unknown>;

/** A commit step that inserts one block equation with the given `latex` before paragraph `pos`. */
function equationStep(pos: number, id: string, latex: string): J {
  return {
    stepType: 'replace',
    from: pos,
    to: pos,
    slice: {
      content: [
        {
          type: 'equation_block',
          attrs: { id, latex, numbered: false, label: null, preserved: null, ext: {} },
        },
      ],
    },
  };
}

// Each refused input is a definition or a primitive that I8 forbids in a `latex` attribute.
const REFUSED = [
  '\\def\\x{y}',
  '\\let\\x=y',
  '\\csname x\\endcsname',
  '\\catcode`\\%=12',
  '\\input{/etc/passwd}',
  '\\include{x}',
  '\\openin1=x',
  '\\write18{id}',
  '\\directlua{os.exit()}',
  '\\special{x}',
  '\\immediate\\write18{id}',
  '\\newcommand{\\z}{w}',
  '^^5cdef\\x{y}',
];

describe('SEC-034 criterion 1 (production commit path): definitions and primitives are refused', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('memory', { node: 'node-A' });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('accepts an ordinary equation, refuses each definition or primitive, and stores none of them', async () => {
    const doc = await h.createDocument(h.a, documentWithRegions());
    const ref = { tenant: h.a.id, doc };
    const token = await h.mintToken(h.a, 'ann', { [doc]: 'editor' });
    const ws = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    try {
      await ws.hello(token);
      await ws.open(1, doc);
      const content = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey }))
        .json;
      // The block boundary before the first paragraph: a block may be inserted there.
      const pos = posOf(content.doc, 'pIntro0000000001');

      const control = await ws.submit(1, {
        id: uuid7(),
        base: 0,
        steps: [equationStep(pos, 'eqProdOk00000001', 'a+b')],
      });
      expect(control.t, 'an ordinary equation is accepted').toBe('sync.ack');
      const headAfterControl = (await h.parts.logs.head(ref)).seq;

      let n = 2;
      for (const latex of REFUSED) {
        const r = await ws.submit(1, {
          id: uuid7(),
          base: headAfterControl,
          steps: [equationStep(pos, `eqProdBad${String(n).padStart(8, '0')}`, latex)],
        });
        n++;
        expect(r.t, `refused: ${latex}`).toBe('sync.reject');
        expect(r.d?.['code'], `invalid_op for ${latex}`).toBe('invalid_op');
      }

      // Nothing of the refused commits was stored: the head is where the control left it.
      expect((await h.parts.logs.head(ref)).seq).toBe(headAfterControl);
      const stored = JSON.stringify(await h.parts.logs.read(ref, 1));
      for (const latex of REFUSED) expect(stored).not.toContain(JSON.stringify(latex).slice(1, -1));
    } finally {
      ws.close();
    }
  });
});
