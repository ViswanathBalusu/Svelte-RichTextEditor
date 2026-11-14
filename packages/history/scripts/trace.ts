/**
 * Synthetic editing traces on corpus documents for the history spikes (HIS-043, HIS-044): a
 * deterministic sequence of commits by several people and an assistant, typing and deleting
 * words, splitting and joining paragraphs, pasting text and changing formatting at random places.
 * Node.js only (scripts).
 */
import { ENGINE, type StoredCommit, stepsToJson } from '@docedit/authority';
import { cdmSchema } from '@docedit/model/prosemirror';
import type { Node } from 'prosemirror-model';
import { type Mappable, Mapping, type Step, Transform } from 'prosemirror-transform';

export const schema = cdmSchema();

/** mulberry32: a small deterministic generator, so that runs are repeatable. */
export function generator(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'lease',
  'term',
  'party',
  'notice',
  'deposit',
  'rent',
  'clause',
  'shall',
  'month',
  'agreed',
];
export const USERS = ['u_alice', 'u_bob', 'u_carol', 'u_dave', 'u_erin', 'u_frank'];

export interface TraceCommit {
  commit: StoredCommit;
  steps: Step[];
  /** The document after the commit. */
  doc: Node;
}

let ids = 0;

/**
 * Makes commits one at a time on the document it is given. Textblocks are found once and their
 * positions mapped through every commit (and through changes made elsewhere, `external`), so that
 * a trace costs in proportion to the edits, not to the document.
 */
export class TraceMaker {
  private readonly rand: () => number;
  private readonly blocks: number[] = [];
  private readonly mapping = new Mapping();

  constructor(doc: Node, seed: number) {
    this.rand = generator(seed);
    doc.descendants((node, pos) => {
      if (node.isTextblock) this.blocks.push(pos);
      return !node.isTextblock;
    });
  }

  /** A change made by someone else (a restore): positions are mapped through it. */
  external(mapping: Mappable & { maps?: unknown }): void {
    if (mapping instanceof Mapping) this.mapping.appendMapping(mapping);
  }

  /** One commit on `current`, or null when no edit fitted in a few tries. */
  next(current: Node, seq: number): TraceCommit | null {
    const rand = this.rand;
    for (let tries = 0; tries < 20; tries++) {
      const start = this.mapping.map(this.blocks[Math.floor(rand() * this.blocks.length)]!, 1);
      let block: Node | null;
      try {
        block = current.nodeAt(start);
      } catch {
        continue;
      }
      if (!block?.isTextblock) continue;
      const size = block.content.size;
      const at = start + 1 + Math.floor(rand() * (size + 1));
      const r = rand();
      const tr = new Transform(current);
      try {
        if (r < 0.6) tr.insert(at, schema.text(`${WORDS[Math.floor(rand() * WORDS.length)]} `));
        else if (r < 0.75) {
          if (!size) continue;
          const from = start + 1 + Math.floor(rand() * size);
          tr.delete(from, Math.min(start + 1 + size, from + 1 + Math.floor(rand() * 6)));
        } else if (r < 0.83) {
          if (!size) continue;
          const from = start + 1 + Math.floor(rand() * size);
          tr.addMark(from, Math.min(start + 1 + size, from + 5), schema.marks['bold']!.create());
        } else if (r < 0.88) {
          if (block.type.name !== 'paragraph' || current.resolve(at).parent !== block) continue;
          tr.split(at, 1, [
            {
              type: schema.nodes['paragraph']!,
              attrs: { ...block.attrs, id: `pT${(++ids).toString(36).padStart(14, '0')}` },
            },
          ]);
        } else if (r < 0.92) {
          const end = start + block.nodeSize;
          const next = current.nodeAt(end);
          if (!next || next.type.name !== 'paragraph' || block.type.name !== 'paragraph') continue;
          if (current.resolve(end).parent !== current.resolve(start).parent) continue;
          tr.join(end);
        } else if (r < 0.96) {
          const text = block.textContent.slice(0, 24);
          if (!text) continue;
          tr.insert(at, schema.text(text));
        } else tr.setNodeAttribute(start, 'align', rand() < 0.5 ? 'center' : null);
      } catch {
        continue;
      }
      if (!tr.steps.length) continue;
      const user = USERS[Math.floor(rand() * USERS.length)]!;
      const commit: StoredCommit = {
        seq,
        id: `0192f0c4-7b1e-7000-8000-${seq.toString(16).padStart(12, '0')}`,
        kind: 'steps',
        steps: stepsToJson(tr.steps),
        user,
        session: `s-${user}`,
        time: 1_790_000_000_000 + seq * 1500,
        origin: 'input',
        scopes: ['body'],
        revision: 1,
        cdm: 1,
        engine: ENGINE,
        retired: [],
        claimed: [],
        ...(rand() < 0.05 ? { agent: 'agent-7' } : {}),
      };
      this.mapping.appendMapping(tr.mapping);
      return { commit, steps: tr.steps, doc: tr.doc };
    }
    return null;
  }
}

/** `n` commits on `doc`. */
export function trace(doc: Node, n: number, seed: number): TraceCommit[] {
  const maker = new TraceMaker(doc, seed);
  const out: TraceCommit[] = [];
  let current = doc;
  for (let guard = 0; out.length < n && guard < n * 4; guard++) {
    const c = maker.next(current, out.length + 1);
    if (!c) continue;
    out.push(c);
    current = c.doc;
  }
  return out;
}

export function machine(
  cpus: () => Array<{ model: string }>,
  total: number,
  os: string,
  release: string,
): string {
  const c = cpus();
  return `${c[0]?.model ?? 'unknown'}, ${c.length} logical cores, ${(total / 2 ** 30).toFixed(0)} GiB, ${os} ${release}, Node.js ${process.version}`;
}

/** Median and 95th percentile (nearest rank). */
export function stats(xs: readonly number[], digits = 2): string {
  if (!xs.length) return 'n/a';
  const s = [...xs].sort((a, b) => a - b);
  const q = (f: number) => s[Math.min(s.length - 1, Math.ceil(f * s.length) - 1)]!;
  return `${q(0.5).toFixed(digits)} / ${q(0.95).toFixed(digits)}`;
}
