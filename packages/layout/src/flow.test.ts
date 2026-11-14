/**
 * CDM to flow blocks (FE-077 shape, spike S7): formatting resolved once, in points, with CDM offsets.
 */
import { loadDocument } from '@docedit/corpus';
import example from '@docedit/model/fixtures/example-03-12.json' with { type: 'json' };
import kitchenSink from '@docedit/model/fixtures/kitchen-sink.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import {
  flowParagraphs,
  toFlow,
  type CdmEnvelopeLike,
  type CdmNode,
  type FlowParagraph,
  type FlowText,
} from './flow.ts';

const paragraphs = (env: CdmEnvelopeLike): FlowParagraph[] =>
  toFlow(env).sections.flatMap((s) => [...flowParagraphs(s.blocks)]);
const texts = (p: FlowParagraph): FlowText[] =>
  p.inlines.filter((i): i is FlowText => i.kind === 'text');

describe('toFlow on the example of 03 §12', () => {
  const flow = toFlow(example as CdmEnvelopeLike);

  it('reads the page setup in points, with schema defaults filled in', () => {
    expect(flow.sections).toHaveLength(1);
    const page = flow.sections[0]!.page;
    expect([page.width, page.height]).toEqual([595.3, 841.9]);
    expect([page.marginTop, page.marginRight, page.marginBottom, page.marginLeft]).toEqual([
      72, 72, 72, 72,
    ]);
    expect([page.headerDistance, page.footerDistance, page.columns]).toEqual([35.4, 35.4, 1]);
  });

  it('resolves the heading through its style chain', () => {
    const [heading] = paragraphs(example as CdmEnvelopeLike);
    expect(heading).toMatchObject({
      id: 'p3Jq8sLw0aZx1VbN',
      styleId: 'Heading1',
      outlineLevel: 1,
      keepNext: true,
      spaceAfter: 8,
    });
    expect(heading!.line).toEqual({ rule: 'multiple', factor: 1.15 });
    expect(texts(heading!)[0]!.font).toMatchObject({
      family: 'Noto Serif',
      sizePt: 16,
      bold: true,
    });
  });

  it('flattens the region and keeps the region identifier and CDM offsets', () => {
    const [, inRegion, empty] = paragraphs(example as CdmEnvelopeLike);
    expect(inRegion).toMatchObject({
      id: 'pA1b2C3d4E5f6G7h',
      regionId: 'rG7mK2pQ9xYt4HcD',
      start: 0,
      end: 39,
    });
    expect(texts(inRegion!).map((t) => [t.text, t.offset, t.size, t.font.bold])).toEqual([
      ['Liability is limited to ', 0, 24, false],
      ['direct', 24, 6, true],
      [' damages.', 30, 9, false],
    ]);
    expect(empty).toMatchObject({ id: 'pZ9y8X7w6V5u4T3s', start: 0, end: 0, inlines: [] });
  });
});

describe('toFlow on corpus and fixture documents', () => {
  it('prints numbering labels as literal text (03 §7) and numbers footnotes in order', async () => {
    const { envelope } = await loadDocument('pages-1');
    const all = paragraphs(envelope as unknown as CdmEnvelopeLike);
    const label = (id: string): string | undefined =>
      texts(all.find((p) => p.id === id)!).find((t) => t.role === 'label')?.text;
    // Identifiers of corpus version 2 (a footnote's paragraph has its own identifier since then).
    expect(label('1FQ4zkeIBDfydTf4')).toBe('1');
    expect(label('JTSU2csve8dg9_q7')).toBe('2');
    expect(label('7pUROiE0P2o7BoZW')).toBe('•');
    expect(label('N_quFWQyYZNFA7uh')).toBe('◦');
    const flow = toFlow(envelope as unknown as CdmEnvelopeLike);
    expect([...flow.notes.values()].map((n) => [n.number, n.label])).toEqual([[1, '1']]);
    const withNote = all.find((p) => p.id === 'nt_zOdo2Ga1-uI-m')!;
    const ref = texts(withNote).find((t) => t.role === 'noteRef')!;
    expect(ref.font.vertAlign).toBe('super');
    expect(withNote.end).toBe(
      ref.offset + ref.size + ' Its text was written for the corpus.'.length,
    );
  });

  it('splits sections at section breaks and replaces the contents placeholder by generated entries', () => {
    const flow = toFlow(kitchenSink as CdmEnvelopeLike);
    expect(flow.sections.length).toBe(2);
    expect(flow.sections[1]!.breakId).not.toBeNull();
    const generated = flow.sections
      .flatMap((s) => [...flowParagraphs(s.blocks)])
      .filter((p) => p.generated);
    expect(generated.length).toBeGreaterThan(0);
    expect(generated.every((p) => p.styleId.startsWith('TOC'))).toBe(true);
  });

  it('covers every body block of a 20-page document', async () => {
    const envelope = (await loadDocument('pages-20')).envelope as unknown as CdmEnvelopeLike;
    const flow = toFlow(envelope);
    expect(flow.sections.length).toBeGreaterThan(1);
    const ids = new Set(flow.sections.flatMap((s) => s.blocks.map((b) => b.id)));
    const body = envelope.doc.content?.find((n) => n.type === 'body');
    const cdmIds = new Set<string>();
    const walk = (nodes: readonly CdmNode[]): void => {
      for (const n of nodes) {
        const id = n.attrs?.['id'];
        if (n.type === 'region') walk(n.content ?? []);
        else if (n.type !== 'section_break' && typeof id === 'string') cdmIds.add(id);
      }
    };
    walk(body?.content ?? []);
    expect([...cdmIds].filter((id) => !ids.has(id))).toEqual([]);
  });
});
