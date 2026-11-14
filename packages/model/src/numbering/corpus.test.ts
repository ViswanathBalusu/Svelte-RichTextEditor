// The layout semantics on the shared corpus (FND-006): correctness checks on real documents, and
// the time each function takes on the 100- and 300-page documents, so that the editor can call them
// on every keystroke (CDM-042 to CDM-044). The times are printed, not asserted: the spec gives the
// typing budget for the whole pipeline (13 §9), not for these functions, and the machine varies.
// The corpus is imported by path: `@docedit/corpus` depends on this package, so this package cannot
// depend on it.
import { describe, expect, it } from 'vitest';
import { corpusLabel, loadDocument } from '../../../corpus/src/index.ts';
import { paragraphNumbering, numberingLevel, resolveParagraph } from '../cascade/resolve.ts';
import { type TreeNode, attrsOf, eachChild, styleTable, typeOf } from '../cascade/styles.ts';
import { cdmSchema } from '../prosemirror/index.ts';
import { flowGaps } from '../spacing/gaps.ts';
import { computeLabels, referenceText } from './labels.ts';

type J = Record<string, unknown>;

function* walk(
  node: TreeNode,
  tableStyle: string | null = null,
): Generator<[TreeNode, string | null]> {
  yield [node, tableStyle];
  const attrs = attrsOf(node);
  const inner =
    typeOf(node) === 'table' && typeof attrs['style'] === 'string' ? attrs['style'] : tableStyle;
  const children: TreeNode[] = [];
  eachChild(node, (c) => children.push(c));
  for (const c of children) yield* walk(c, inner);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function time(runs: number, f: () => unknown): number {
  for (let i = 0; i < 3; i++) f(); // warm up the JIT
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    f();
    out.push(performance.now() - t);
  }
  return median(out);
}

describe('layout semantics on the corpus', () => {
  for (const name of ['pages-1', 'pages-20', 'pages-100', 'pages-300'])
    it(`${name}: labels every numbered paragraph, agrees with the corpus's caption numbers, resolves every reference`, async ({
      annotate,
    }) => {
      await annotate(corpusLabel(), 'corpus');
      const doc = (await loadDocument(name)).envelope.doc as unknown as TreeNode;
      const table = styleTable(doc);
      const labels = computeLabels(doc, { table });
      expect(labels.problems).toEqual([]);
      let numbered = 0;
      let captions = 0;
      let refs = 0;
      const seqSeen = new Map<string, number>();
      for (const [node, tableStyle] of walk(doc)) {
        const type = typeOf(node);
        const attrs = attrsOf(node);
        if (type === 'paragraph') {
          const n = paragraphNumbering(table, attrs, tableStyle);
          expect(n.ok).toBe(true);
          if (n.ok && numberingLevel(table, n.value)) {
            numbered++;
            expect(labels.lists.has(attrs['id'] as string), attrs['id'] as string).toBe(true);
          }
          const r = resolveParagraph(table, attrs, { tableStyle });
          expect(r.ok).toBe(true);
        }
        if (type === 'field' && attrs['kind'] === 'ref') {
          refs++;
          expect(
            referenceText(labels, attrs['target'] as string),
            attrs['target'] as string,
          ).not.toBeNull();
        }
        if (type === 'field' && attrs['kind'] === 'seq' && typeof attrs['cached'] === 'string') {
          captions++;
          const nameOf = attrs['name'] as string;
          seqSeen.set(nameOf, (seqSeen.get(nameOf) ?? 0) + 1);
          // The corpus generator numbered its captions with its own counters, in document order.
          expect(attrs['cached']).toBe(String(seqSeen.get(nameOf)));
        }
      }
      const sequenceTexts = [...labels.sequences.values()].flat().filter((s) => s.name !== null);
      expect(sequenceTexts.length).toBe(captions);
      expect(labels.lists.size).toBe(numbered);
      console.info(
        `${name}: ${numbered} numbered paragraphs, ${captions} captions, ${labels.footnotes.size} footnotes, ${refs} references`,
      );
    });

  it('times the functions on the 100- and 300-page documents', async ({ annotate }) => {
    await annotate(corpusLabel(), 'corpus');
    const schema = cdmSchema();
    const rows: string[] = [];
    for (const name of ['pages-100', 'pages-300']) {
      const doc = (await loadDocument(name)).envelope.doc as unknown as TreeNode;
      const pm = schema.nodeFromJSON(doc as unknown as J) as unknown as TreeNode;
      const nodes = [...walk(doc)];
      const paragraphs = nodes.filter(([n]) => typeOf(n) === 'paragraph');
      const containers = nodes.filter(([n]) =>
        ['body', 'table_cell', 'story', 'footnote'].includes(typeOf(n)),
      );
      const table = styleTable(doc);
      const t = {
        styleTable: time(20, () => styleTable(doc)),
        labelsJson: time(20, () => computeLabels(doc, { table })),
        labelsProseMirror: time(20, () => computeLabels(pm, { table })),
        labelsWithNewTable: time(20, () => computeLabels(doc)),
        resolveAllCold: time(10, () => {
          const fresh = styleTable(doc);
          for (const [n, ts] of paragraphs) resolveParagraph(fresh, attrsOf(n), { tableStyle: ts });
        }),
        resolveAllWarm: time(20, () => {
          for (const [n, ts] of paragraphs) resolveParagraph(table, attrsOf(n), { tableStyle: ts });
        }),
        gapsAll: time(10, () => {
          for (const [n, ts] of containers) flowGaps(table, n, { tableStyle: ts });
        }),
      };
      rows.push(
        `${name} (${paragraphs.length} paragraphs, ${containers.length} containers): ` +
          Object.entries(t)
            .map(([k, v]) => `${k} ${v.toFixed(2)} ms`)
            .join(', '),
      );
    }
    console.info(
      `Median times (Node.js ${process.version}, ${process.platform}):\n${rows.join('\n')}`,
    );
    await annotate(rows.join(' | '), 'timing');
  });
});
