// The history functions give the same results in Node.js and in every browser engine (FND-003,
// FND-005; ADR 0051): comparisons on projections, the attribution map, groups, restore plans and
// the hash chain, with WebCrypto as the only platform API.
import { NOTHING_HIDDEN, type HiddenSet } from '@docedit/authority';
import { cdmSchema } from '@docedit/model/prosemirror';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { AttributionMap } from './attribution.ts';
import { type ChainMetadata, chainHash, payloadDigest } from './chain.ts';
import { compareStates } from './compare.ts';
import { dayOf, groupCommits } from './groups.ts';

const schema = cdmSchema();
const CANARY = 'CANARYsecretTEXT';

const p = (id: string, text: string) => ({
  type: 'paragraph',
  attrs: { id },
  content: [{ type: 'text', text }],
});
const doc = schema.nodeFromJSON({
  type: 'doc',
  content: [
    {
      type: 'defs',
      content: [
        { type: 'settings', attrs: {} },
        {
          type: 'style_def',
          attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
        },
        { type: 'page_setup', attrs: { id: 'ps1' } },
      ],
    },
    {
      type: 'body',
      attrs: { pageSetup: 'ps1' },
      content: [
        p('pOne000000000001', 'Ten 漢字 words here.'),
        {
          type: 'region',
          attrs: { id: 'rSecret00000000B', policy: 'confidential' },
          content: [p('pSecret00000001B', CANARY)],
        },
        p('pTwo000000000002', 'The end.'),
      ],
    },
  ],
});
const HIDDEN: HiddenSet = {
  regions: new Set(['rSecret00000000B']),
  values: new Set(),
  titles: false,
};

function posInside(d: typeof doc, id: string, offset = 0): number {
  let found = -1;
  d.descendants((n, pos) => {
    if (found < 0 && n.attrs['id'] === id) found = pos + 1 + offset;
    return found < 0;
  });
  return found;
}

describe('history functions in every engine (universal)', () => {
  it('compares two versions on the reader’s projection, with authorship from the map', () => {
    const tr = new Transform(doc).insert(
      posInside(doc, 'pOne000000000001', 4),
      schema.text('new '),
    );
    tr.insert(posInside(tr.doc, 'pSecret00000001B', 0), schema.text(`${CANARY} `));
    const map = AttributionMap.create(doc.content.size, { user: 'owner', seq: 0 });
    for (const s of tr.steps) map.applyStep(s, { user: 'bob', seq: 1 });
    const r = compareStates({
      from: { seq: 0, doc },
      to: { seq: 1, doc: tr.doc, attribution: map },
      hidden: HIDDEN,
    });
    expect(r.ok && r.comparison.changes).toEqual([
      {
        kind: 'modified',
        blockId: 'pOne000000000001',
        type: 'paragraph',
        spans: [{ op: 'insert', at: 4, text: 'new ', user: 'bob', seq: 1 }],
      },
    ]);
    expect(JSON.stringify(r)).not.toContain(CANARY);
    const full = compareStates({
      from: { seq: 0, doc },
      to: { seq: 1, doc: tr.doc },
      hidden: NOTHING_HIDDEN,
      granularity: 'char',
    });
    expect(JSON.stringify(full)).toContain(CANARY);
  });

  it('keeps the attribution map exact and serialisable', () => {
    const tr = new Transform(doc).insert(
      posInside(doc, 'pTwo000000000002', 0),
      schema.text('Truly '),
    );
    const map = AttributionMap.create(doc.content.size, { user: 'owner', seq: 0 });
    map.applyStep(tr.steps[0]!, { user: 'bob', seq: 1, agent: 'agent-7' });
    expect(map.size).toBe(tr.doc.content.size);
    expect(AttributionMap.fromJSON(JSON.parse(JSON.stringify(map.toJSON()))).equals(map)).toBe(
      true,
    );
    expect(map.at(posInside(tr.doc, 'pTwo000000000002', 0))).toEqual({
      user: 'bob',
      seq: 1,
      agent: 'agent-7',
    });
  });

  it('groups by day in a time zone, the same in every engine', () => {
    const t = Date.UTC(2026, 10, 6, 22, 58);
    expect(dayOf(t, 'Europe/Berlin')).toBe('2026-11-06');
    expect(dayOf(t + 3 * 60_000, 'Europe/Berlin')).toBe('2026-11-07');
    const groups = groupCommits(
      [
        { seq: 1, kind: 'steps', user: 'a', session: 's', time: t, origin: 'input', scopes: [] },
        {
          seq: 2,
          kind: 'steps',
          user: 'a',
          session: 's',
          time: t + 60_000,
          origin: 'paste',
          scopes: [],
        },
        {
          seq: 3,
          kind: 'steps',
          user: 'a',
          session: 's',
          time: t + 2 * 60_000,
          origin: 'import',
          scopes: [],
        },
      ],
      [],
    );
    expect(groups.map((g) => [g.fromSeq, g.toSeq])).toEqual([
      [1, 2],
      [3, 3],
    ]);
  });

  it('computes the hash chain of ADR 0020 with the vectors Node.js computes', async () => {
    const payload = { steps: [], retired: [], claimed: [] };
    const d = await payloadDigest(payload);
    expect(d).toEqual({
      hash: '7932c97e6fe8d5fc0b0e75ef29d54f4c609af97d551543061277bf4fd942b0cf',
      size: 38,
    });
    const meta: ChainMetadata = {
      doc: '0192f0c4-7b1e-7000-8000-00000000d0c1',
      seq: 1,
      kind: 'steps',
      id: '0192f0c4-7b1e-7000-8000-000000000001',
      user: 'u_481',
      session: 's1',
      agent: null,
      time: '2026-11-06T09:00:00.000Z',
      origin: 'input',
      scopes: ['body'],
      base: 0,
      rebased: false,
      revision: 1,
      jti: null,
      cdm: 1,
      engine: 'pm-steps/1',
      size: 38,
    };
    const h1 = await chainHash(null, meta, d.hash);
    expect(h1).toBe('8d317f796edcf89a93c131f0576ba2614aeb030356dc9b3f8e9fd5ddd5eb9a7c');
    const h2 = await chainHash(
      h1,
      { ...meta, seq: 2, id: '0192f0c4-7b1e-7000-8000-000000000002', user: 'u_112' },
      d.hash,
    );
    expect(h2).toBe('2cd7a9d34b0e0bbb9cbc5d0be1a882084bae967874567e1bcd4878bf765c536a');
  });
});
