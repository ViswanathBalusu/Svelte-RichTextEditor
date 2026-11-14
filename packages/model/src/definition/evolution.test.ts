// The attribute-shape check of CDM-048 criterion 5 (03 §11.2): within one major version a node or
// mark gains or loses no top-level attribute. The CI job that calls it is not built.
import { describe, expect, it } from 'vitest';
import { CDM1 } from './cdm1.ts';
import { attributeShapeChanges } from './evolution.ts';

describe('attribute shape within one cdm major version (CDM-048)', () => {
  it('reports nothing when a definition is compared with itself', () => {
    expect(attributeShapeChanges(CDM1, CDM1)).toEqual([]);
  });

  it('reports a top-level attribute a node gained, and one it lost, and ignores ext', () => {
    const para = CDM1.nodes.find((n) => n.name === 'paragraph')!;
    const gained = {
      ...CDM1,
      nodes: CDM1.nodes.map((n) =>
        n.name === 'paragraph'
          ? { ...n, attrs: { ...n.attrs, extraTop: n.attrs['spaceAfter']! } }
          : n,
      ),
    };
    expect(attributeShapeChanges(CDM1, gained)).toEqual([
      { kind: 'node', name: 'paragraph', attribute: 'extraTop', change: 'gained' },
    ]);
    expect(attributeShapeChanges(gained, CDM1)).toEqual([
      { kind: 'node', name: 'paragraph', attribute: 'extraTop', change: 'lost' },
    ]);
    const { spaceAfter: _removed, ...rest } = para.attrs;
    const lost = {
      ...CDM1,
      nodes: CDM1.nodes.map((n) => (n.name === 'paragraph' ? { ...n, attrs: rest } : n)),
    };
    expect(attributeShapeChanges(CDM1, lost)).toEqual([
      { kind: 'node', name: 'paragraph', attribute: 'spaceAfter', change: 'lost' },
    ]);
  });

  it('applies the same rule to marks', () => {
    const mark = CDM1.marks[0]!;
    const changed = {
      ...CDM1,
      marks: CDM1.marks.map((m) =>
        m.name === mark.name
          ? { ...m, attrs: { ...m.attrs, extraTop: { ...Object.values(m.attrs)[0]! } } }
          : m,
      ),
    };
    expect(attributeShapeChanges(CDM1, changed)).toEqual([
      { kind: 'mark', name: mark.name, attribute: 'extraTop', change: 'gained' },
    ]);
  });
});
