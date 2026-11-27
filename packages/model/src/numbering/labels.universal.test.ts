// Labels (CDM-042; 03 §7; ADR 0032): what the shared fixtures cannot show on their own. The editor
// can pass its ProseMirror document directly; effects survive JSON; invalid documents never throw.
import { describe, expect, it } from 'vitest';
import kitchenSink from '../../fixtures/kitchen-sink.json' with { type: 'json' };
import listsFile from '../../fixtures/semantics/numbering-lists.json' with { type: 'json' };
import type { TreeNode } from '../cascade/styles.ts';
import { cdmSchema } from '../prosemirror/index.ts';
import { footnoteMark, formatNumber, letters, roman } from './format.ts';
import { type DocumentLabels, computeLabels, counterEffects, referenceText } from './labels.ts';

type J = Record<string, unknown>;

/** A small document: settings, Normal, one numbering definition, a page setup and the body. */
function doc(body: J[], levels: J[] = [{ format: 'decimal', text: '%1.', start: 1 }]): TreeNode {
  return {
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
          { type: 'numbering_def', attrs: { id: 'n', levels } },
          { type: 'page_setup', attrs: { id: 'ps1' } },
        ],
      },
      { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
    ],
  } as unknown as TreeNode;
}

const item = (id: string, level = 0, extra: J = {}): J => ({
  type: 'paragraph',
  attrs: { id, numbering: { numberingId: 'n', level, listId: 'listAxxxxxxxxxxx' }, ...extra },
});

function plain(labels: DocumentLabels): J {
  const m = <T>(map: ReadonlyMap<string, T>): J => Object.fromEntries(map);
  return {
    lists: m(labels.lists),
    sequences: m(labels.sequences),
    equations: m(labels.equations),
    footnotes: m(labels.footnotes),
    bookmarks: m(labels.bookmarks),
    equationLabels: m(labels.equationLabels),
  };
}

/** The documents of numbering-lists.json, assembled as the file's `format` says. */
function listDocuments(): J[] {
  const f = listsFile as unknown as {
    settings: J;
    styles: J[];
    numberings: J[];
    cases: { styles?: J[]; numberings?: J[]; stories?: J[]; body: J[] }[];
  };
  const merge = (a: J[], b: J[] = []): J[] => {
    const out = [...a];
    for (const n of b) {
      const id = (n['attrs'] as J)['id'];
      const i = out.findIndex((m) => (m['attrs'] as J)['id'] === id);
      if (i >= 0) out[i] = n;
      else out.push(n);
    }
    return out;
  };
  return f.cases.map((c) => ({
    type: 'doc',
    content: [
      {
        type: 'defs',
        content: [
          { type: 'settings', attrs: f.settings },
          ...merge(f.styles, c.styles),
          ...merge(f.numberings, c.numberings),
          { type: 'page_setup', attrs: { id: 'ps1' } },
        ],
      },
      ...(c.stories ?? []),
      { type: 'body', attrs: { pageSetup: 'ps1' }, content: c.body },
    ],
  }));
}

describe('labels (CDM-042)', () => {
  it('gives the same labels for a ProseMirror document as for its JSON', () => {
    const schema = cdmSchema();
    const docs = [(kitchenSink as unknown as { doc: J }).doc, ...listDocuments()];
    let numbered = 0;
    for (const json of docs) {
      const pm = schema.nodeFromJSON(json) as unknown as TreeNode;
      const fromJson = computeLabels(json as unknown as TreeNode);
      expect(plain(computeLabels(pm))).toEqual(plain(fromJson));
      numbered += fromJson.lists.size;
    }
    expect(numbered).toBeGreaterThan(50);
  });

  it('never throws on an invalid document, and leaves out what it cannot number', () => {
    const labels = computeLabels(
      doc([
        item('p1xxxxxxxxxxxxxx'),
        item('p2xxxxxxxxxxxxxx', 7), // a level the definition does not have
        {
          type: 'paragraph',
          attrs: {
            id: 'p3xxxxxxxxxxxxxx',
            numbering: { numberingId: 'missing', level: 0, listId: 'x' },
          },
        },
        { type: 'paragraph', attrs: { id: 'p4xxxxxxxxxxxxxx', style: 'NoSuchStyle' } },
        { type: 'paragraph', attrs: { id: 'p5xxxxxxxxxxxxxx', numbering: 'not an object' } },
        { type: 'unknown_block', attrs: { id: 'b1xxxxxxxxxxxxxx' } },
        item('p6xxxxxxxxxxxxxx'),
      ]),
    );
    expect(Object.fromEntries([...labels.lists].map(([k, v]) => [k, v.text]))).toEqual({
      p1xxxxxxxxxxxxxx: '1.',
      p6xxxxxxxxxxxxxx: '2.',
    });
    expect(labels.problems.map((p) => p.code)).toEqual(['style_missing']);
  });

  it('applies effects given as a Map, as a record, or after a JSON round trip alike', () => {
    const full = doc([
      item('p1xxxxxxxxxxxxxx'),
      {
        type: 'region',
        attrs: { id: 'regionAxxxxxxxxx' },
        content: [item('p2xxxxxxxxxxxxxx'), item('p3xxxxxxxxxxxxxx')],
      },
      item('p4xxxxxxxxxxxxxx'),
    ]);
    const projection = doc([
      item('p1xxxxxxxxxxxxxx'),
      { type: 'hidden_region', attrs: { id: 'regionAxxxxxxxxx' } },
      item('p4xxxxxxxxxxxxxx'),
    ]);
    const effects = counterEffects(full, ['regionAxxxxxxxxx', 'notInTheDocument']);
    expect([...effects.keys()]).toEqual(['regionAxxxxxxxxx']);
    const asRecord = JSON.parse(JSON.stringify(Object.fromEntries(effects))) as never;
    for (const e of [effects, asRecord])
      expect(computeLabels(projection, { effects: e }).lists.get('p4xxxxxxxxxxxxxx')?.text).toBe(
        '4.',
      );
    expect(computeLabels(projection).lists.get('p4xxxxxxxxxxxxxx')?.text).toBe('2.');
  });

  it('formats numbers by the rules of ADR 0032', () => {
    expect([1, 26, 27, 52, 53, 702].map(letters)).toEqual([
      'a',
      'z',
      'aa',
      'zz',
      'aaa',
      'z'.repeat(27),
    ]);
    expect([1, 4, 9, 14, 40, 90, 400, 1994, 3999, 4000, 32767].map(roman)).toEqual([
      'i',
      'iv',
      'ix',
      'xiv',
      'xl',
      'xc',
      'cd',
      'mcmxciv',
      'mmmcmxcix',
      'mmmm',
      `${'m'.repeat(32)}dcclxvii`,
    ]);
    expect(formatNumber(-1, 'decimal')).toBe('0');
    expect(formatNumber(0, 'upperRoman')).toBe('');
    expect(formatNumber(0, 'lowerLetter')).toBe('');
    expect(formatNumber(0, 'decimal')).toBe('0');
    expect(formatNumber(5, 'bullet', '◦')).toBe('◦');
    expect(formatNumber(5, 'bullet', null)).toBe('•');
    expect(formatNumber(5, 'none')).toBe('');
    expect(formatNumber(5, 'unknownFormat')).toBe('5');
    expect([1, 4, 5, 8, 9, 13].map((n) => footnoteMark(n, 'symbol'))).toEqual([
      '*',
      '§',
      '**',
      '§§',
      '***',
      '****',
    ]);
    expect(footnoteMark(3, 'upperLetter')).toBe('C');
  });

  it('gives no text for a reference it cannot resolve', () => {
    const labels = computeLabels(doc([item('p1xxxxxxxxxxxxxx')]));
    expect(referenceText(labels, 'node:p1xxxxxxxxxxxxxx')).toBe('1');
    for (const t of [
      'node:nope',
      'bookmark:nope',
      'eq:nope',
      'field:client.name',
      'style:Normal',
      'nonsense',
    ])
      expect(referenceText(labels, t), t).toBeNull();
  });
});
