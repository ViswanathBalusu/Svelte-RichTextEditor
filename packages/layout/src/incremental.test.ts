/**
 * Incremental layout (FE-088, criteria 1 and 4), in Node.js. The random edits use fast-check; each
 * case draws a seed and generates its edits with mulberry32, so every run is repeatable.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { layoutFlow } from './engine.ts';
import { toFlow, type CdmEnvelopeLike, type CdmNode, type FlowDocument } from './flow.ts';
import { coalescedLayout, incrementalLayout } from './incremental.ts';
import { firstFitBreaker, type BreakOpportunities, type ItemProviders } from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';
import { checkCoverage, serialiseTree } from './tree.ts';

const afterSpace: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i++)
      if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
    return out;
  },
};

const providers: ItemProviders = {
  measurer: fixedWidthMeasurer(),
  breaks: afterSpace,
  lineBreaker: firstFitBreaker,
};

const text = (t: string): CdmNode => ({ type: 'text', text: t });
const paragraph = (id: string, content: CdmNode[]): CdmNode => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal' },
  content,
});

/** The body paragraphs as (identifier, text) pairs; the first one carries a footnote. */
interface Para {
  readonly id: string;
  readonly words: string;
}

function envelopeOf(paras: readonly Para[]): CdmEnvelopeLike {
  const body: CdmNode[] = paras.map((p, i) => {
    if (i === 0)
      return paragraph(p.id, [
        text(`${p.words} with a mark `),
        {
          type: 'footnote',
          attrs: { id: 'n1' },
          content: [paragraph('fn-1', [text('The note text is here.')])],
        },
        text(' and more.'),
      ]);
    return paragraph(p.id, [text(p.words)]);
  });
  return {
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            {
              type: 'settings',
              attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'Normal',
                kind: 'paragraph',
                name: 'Normal',
                builtIn: true,
                fontFamily: 'Noto Serif',
                fontSize: 220,
              },
            },
            {
              type: 'page_setup',
              attrs: {
                id: 'ps1',
                width: 11906,
                height: 16838,
                marginTop: 1440,
                marginRight: 1440,
                marginBottom: 1440,
                marginLeft: 1440,
              },
            },
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
      ],
    },
  };
}

/** Sixty paragraphs over several pages. */
function corpus(): Para[] {
  return Array.from({ length: 60 }, (_, i) => ({
    id: `p${i}`,
    words: Array.from({ length: 4 + (i % 7) }, (_, w) => `word${i}x${w}`).join(' '),
  }));
}

function flowOf(paras: readonly Para[]): FlowDocument {
  return toFlow(envelopeOf(paras));
}

/** mulberry32: `random(n)` is a whole number in [0, n). */
function mulberry32(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(u * n);
  };
}

const withWords = (p: Para, words: string): Para => ({ id: p.id, words });

describe('incremental layout (FE-088, criterion 1: only dirty blocks are re-measured)', () => {
  it('re-measures only the edited block, and keeps the lines of every block after it', () => {
    const inc = incrementalLayout(providers);
    const paras = corpus();
    inc.update(flowOf(paras));
    expect(inc.lastStats.measured.length).toBeGreaterThan(60);

    // Editing p5 changes the CDM offsets of every block after it, but not their breaker input.
    const edited = paras.map((p) =>
      p.id === 'p5' ? withWords(p, `${p.words} extra words here`) : p,
    );
    const result = inc.update(flowOf(edited), new Set(['p5']));
    expect(inc.lastStats.measured).toEqual(['p5']);
    expect(inc.lastStats.reused).toBeGreaterThan(55);
    expect(serialiseTree(result.tree)).toBe(
      serialiseTree(layoutFlow(flowOf(edited), providers).tree),
    );
  });

  it('measures each dirty block once, however many edits share the pass', () => {
    const inc = incrementalLayout(providers);
    const paras = corpus();
    inc.update(flowOf(paras));
    const edited = paras.map((p) =>
      p.id === 'p10' || p.id === 'p20' ? withWords(p, `${p.words} more`) : p,
    );
    inc.update(flowOf(edited), new Set(['p20', 'p10']));
    expect([...inc.lastStats.measured].sort()).toEqual(['p10', 'p20']);
  });

  it('re-measures a block whose input changed even when no edit marked it dirty', () => {
    const inc = incrementalLayout(providers);
    const paras = corpus();
    inc.update(flowOf(paras));
    const edited = paras.map((p) => (p.id === 'p7' ? withWords(p, 'changed without a mark') : p));
    const result = inc.update(flowOf(edited));
    expect(inc.lastStats.measured).toEqual(['p7']);
    expect(serialiseTree(result.tree)).toBe(
      serialiseTree(layoutFlow(flowOf(edited), providers).tree),
    );
  });

  it('measures nothing when nothing is dirty and nothing changed', () => {
    const inc = incrementalLayout(providers);
    const paras = corpus();
    const first = inc.update(flowOf(paras));
    const second = inc.update(flowOf(paras));
    expect(inc.lastStats.measured).toEqual([]);
    expect(serialiseTree(second.tree)).toBe(serialiseTree(first.tree));
  });

  it('returns frozen results, like the engine', () => {
    const result = incrementalLayout(providers).update(flowOf(corpus()));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.tree)).toBe(true);
  });
});

describe('incremental layout (FE-088, criterion 4: the tree equals a tree laid out from scratch)', () => {
  it('equals the from-scratch tree after random edits (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 0x7fffffff }), (seed) => {
        const random = mulberry32(seed);
        const inc = incrementalLayout(providers);
        let paras = corpus().slice(0, 12);
        let inserted = 0;
        const words = (): string =>
          Array.from({ length: 1 + random(9) }, (_, w) => `w${random(50)}x${w}`).join(' ');
        inc.update(flowOf(paras));
        for (let step = 0; step < 12; step++) {
          const dirty = new Set<string>();
          const op = random(4);
          if (op === 0 && paras.length > 1) {
            // Retext one paragraph and mark it, as an edit does.
            const k = random(paras.length);
            const target = paras[k]!;
            paras = paras.map((p, i) => (i === k ? withWords(target, words()) : p));
            dirty.add(target.id);
          } else if (op === 1) {
            // Insert a paragraph and mark it.
            const id = `q${inserted++}`;
            const at = random(paras.length + 1);
            paras = [...paras.slice(0, at), { id, words: words() }, ...paras.slice(at)];
            dirty.add(id);
          } else if (op === 2 && paras.length > 2) {
            // Delete a paragraph other than the one holding the footnote.
            const k = 1 + random(paras.length - 1);
            paras = paras.filter((_, i) => i !== k);
          } else {
            // A change that is not marked: the engine must still agree with the scratch layout.
            const k = random(paras.length);
            const target = paras[k]!;
            paras = paras.map((p, i) => (i === k ? withWords(target, words()) : p));
          }
          const flow = flowOf(paras);
          const incremental = inc.update(flow, dirty);
          const scratch = layoutFlow(flow, providers);
          if (serialiseTree(incremental.tree) !== serialiseTree(scratch.tree)) return false;
          if (checkCoverage(flow, incremental.tree).length > 0) return false;
        }
        return true;
      }),
      { numRuns: 40 },
    );
  });
});

describe('coalesced frames (FE-088, criterion 3: several edits in one frame make one pass)', () => {
  /** A host's frame queue: the test runs the queued frames when it says the frame has come. */
  function frameQueue(): {
    request: (run: () => void) => void;
    runFrames: () => void;
    queued: () => number;
  } {
    let queue: Array<() => void> = [];
    return {
      request: (run) => {
        queue.push(run);
      },
      runFrames: () => {
        const due = queue;
        queue = [];
        for (const run of due) run();
      },
      queued: () => queue.length,
    };
  }

  it('asks the host for one frame for several edits, and runs one pass when it comes', () => {
    const frames = frameQueue();
    const inc = incrementalLayout(providers);
    const coalesced = coalescedLayout(inc, frames.request);
    const paras = corpus();
    coalesced.edit(flowOf(paras));
    frames.runFrames();
    expect(coalesced.passes).toBe(1);

    let edited = paras;
    for (const id of ['p3', 'p9', 'p14', 'p30', 'p31']) {
      edited = edited.map((p) => (p.id === id ? withWords(p, `${p.words} typed`) : p));
      coalesced.edit(flowOf(edited), [id]);
    }
    // Five edits before the frame: one frame was requested and nothing has been laid out yet.
    expect(frames.queued()).toBe(1);
    expect(coalesced.passes).toBe(1);

    frames.runFrames();
    expect(coalesced.passes).toBe(2);
    expect([...inc.lastStats.measured].sort()).toEqual(['p14', 'p3', 'p30', 'p31', 'p9']);
    expect(serialiseTree(coalesced.result!.tree)).toBe(
      serialiseTree(layoutFlow(flowOf(edited), providers).tree),
    );
  });

  it('asks for a new frame after the previous one has run', () => {
    const frames = frameQueue();
    const coalesced = coalescedLayout(incrementalLayout(providers), frames.request);
    const paras = corpus();
    coalesced.edit(flowOf(paras));
    frames.runFrames();
    coalesced.edit(flowOf(paras), ['p1']);
    expect(frames.queued()).toBe(1);
    frames.runFrames();
    expect(coalesced.passes).toBe(2);
  });

  it('runs nothing when no frame comes, and no frame when nothing was edited', () => {
    const frames = frameQueue();
    const coalesced = coalescedLayout(incrementalLayout(providers), frames.request);
    expect(coalesced.result).toBeUndefined();
    frames.runFrames();
    expect(coalesced.passes).toBe(0);
    expect(frames.queued()).toBe(0);
  });

  it('equals the from-scratch tree after batches of edits per frame (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 0x7fffffff }), (seed) => {
        const random = mulberry32(seed);
        const frames = frameQueue();
        const coalesced = coalescedLayout(incrementalLayout(providers), frames.request);
        let paras = corpus().slice(0, 15);
        coalesced.edit(flowOf(paras));
        frames.runFrames();
        for (let frame = 0; frame < 6; frame++) {
          const edits = 1 + random(6);
          for (let e = 0; e < edits; e++) {
            const k = random(paras.length);
            const target = paras[k]!;
            const words = `frame${frame}x${random(40)} more`;
            paras = paras.map((p, i) =>
              i === k ? withWords(target, `${target.words} ${words}`) : p,
            );
            coalesced.edit(flowOf(paras), [target.id]);
          }
          if (frames.queued() !== 1) return false;
          frames.runFrames();
          const scratch = layoutFlow(flowOf(paras), providers);
          if (serialiseTree(coalesced.result!.tree) !== serialiseTree(scratch.tree)) return false;
          if (coalesced.passes !== frame + 2) return false;
        }
        return true;
      }),
      { numRuns: 25 },
    );
  });
});
