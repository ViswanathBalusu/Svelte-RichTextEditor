/**
 * SEC-005 criterion 1 (part) — a corpus of script-injection payloads submitted as commits through
 * the adversarial client, over the wire, on the memory service (10 §3.1; 03 §8, I11). Each payload
 * is tried at a text position and at attribute positions. A payload must either be refused with an
 * answer from the registry (`invalid_op` or `permission_denied`), or be stored as inert text: the
 * stored value is exactly the payload string, and the stored document holds no node type the
 * schema did not hold before. After every payload a benign commit from a second client is
 * acknowledged, so the room keeps serving other clients.
 *
 * What this does not prove (criterion 1 stays unticked, see the story Notes): the corpus does not
 * cover every attribute and text position of the CDM (links, images, alt text, field labels and
 * values, display names, comment bodies and document titles are not written here), and the
 * PostgreSQL run is skipped when PostgreSQL is not up. Criteria 2 to 4 need browsers and the paste
 * and import paths, which are not in this directory.
 */
import { AttrStep } from 'prosemirror-transform';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { documentWithRegions, insertText, startHarness, type Harness } from './support/harness.ts';
import { at, inside, loadDoc, node, stepsJson, type Node } from './support/cdm.ts';
import { PAYLOADS } from './support/payloads.ts';
import { WireClient } from './support/wire.ts';

export { PAYLOADS };

/** Text positions: an open paragraph and the body paragraph (both editable by an editor). */
const TEXT_POSITIONS = ['pIntro0000000001', 'pOpen00000000001'] as const;

/** Attribute positions: a region title, a paragraph style reference and a paragraph identifier. */
const ATTR_POSITIONS: ReadonlyArray<readonly [string, string]> = [
  ['rOpen00000000001', 'title'],
  ['pIntro0000000001', 'style'],
  ['pIntro0000000001', 'id'],
];

const REFUSALS: ReadonlySet<string> = new Set(['invalid_op', 'permission_denied']);

function typesOf(d: Node): Set<string> {
  const s = new Set<string>();
  d.descendants((n) => {
    s.add(n.type.name);
    return true;
  });
  return s;
}

describe('SEC-005 criterion 1 (part): injection payloads over the wire, memory', () => {
  let h: Harness;
  let baseTypes: Set<string>;
  beforeAll(async () => {
    h = await startHarness('memory');
    const doc = await h.createDocument(h.a, documentWithRegions());
    const r = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey });
    baseTypes = typesOf(loadDoc((r.json as { doc: unknown }).doc));
  });
  afterAll(async () => {
    await h?.close();
  });

  /** A new document with the fixture content, and a client that has opened it as an editor. */
  const fresh = async () => {
    const doc = await h.createDocument(h.a, documentWithRegions());
    const token = await h.mintToken(h.a, 'u-editor', { [doc]: 'editor' });
    const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    await c.hello(token);
    await c.open(1, doc);
    const content = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey }))
      .json as { doc: unknown };
    return { doc, client: c, d: loadDoc(content.doc) };
  };

  /** A benign commit from a second client on the same document; the room must still ack it. */
  const benignAfter = async (doc: string, d: Node) => {
    const token = await h.mintToken(h.a, 'u-other', { [doc]: 'editor' });
    const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
    try {
      await c.hello(token);
      await c.open(1, doc);
      const r = await c.submit(1, {
        id: uuid7(),
        base: 0,
        steps: [insertText(inside(d, 'pEnd000000000001'), 'ok')],
      });
      expect(r.t, 'the room keeps serving another client').toBe('sync.ack');
    } finally {
      c.terminate();
    }
  };

  /** Checks one answer: refused by a registry code, or stored as inert text with no new node type. */
  const expectRefusedOrInert = async (
    doc: string,
    r: { t: string; d?: Record<string, unknown> | undefined },
    check: (d: Node) => void,
  ) => {
    if (r.t === 'sync.ack') {
      const content = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey }))
        .json as { doc: unknown };
      const d = loadDoc(content.doc);
      for (const t of typesOf(d))
        expect(baseTypes.has(t), `node type ${t} was not in the schema before`).toBe(true);
      check(d);
    } else {
      expect(r.t).toBe('sync.reject');
      expect(REFUSALS.has(String(r.d?.['code']))).toBe(true);
    }
  };

  for (const payload of PAYLOADS) {
    for (const pos of TEXT_POSITIONS) {
      it(`text at ${pos} is refused or stored as inert text: ${JSON.stringify(payload)}`, async () => {
        const f = await fresh();
        try {
          const r = await f.client.submit(1, {
            id: uuid7(),
            base: 0,
            steps: [insertText(inside(f.d, pos), payload)],
          });
          await expectRefusedOrInert(f.doc, r, (d) => {
            // Inert: the payload is text, found in the paragraph as text and nowhere as markup.
            expect(node(d, pos).textContent).toContain(payload);
          });
          await benignAfter(f.doc, f.d);
        } finally {
          f.client.terminate();
        }
      });
    }
  }

  for (const payload of PAYLOADS) {
    for (const [id, attr] of ATTR_POSITIONS) {
      it(`attr ${attr} on ${id} is refused or stored as inert text: ${JSON.stringify(payload)}`, async () => {
        const f = await fresh();
        try {
          const steps = stepsJson([new AttrStep(at(f.d, id), attr, payload)]);
          const r = await f.client.submit(1, { id: uuid7(), base: 0, steps });
          await expectRefusedOrInert(f.doc, r, (d) => {
            // Inert: the attribute holds the exact payload string, and the node is still there.
            expect(node(d, id).attrs[attr]).toBe(payload);
          });
          await benignAfter(f.doc, f.d);
        } finally {
          f.client.terminate();
        }
      });
    }
  }
});
