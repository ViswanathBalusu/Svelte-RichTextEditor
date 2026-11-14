/**
 * The calibration workload of ADR 0037: main-thread work of the kinds the editor does, in a fixed
 * amount, so that its time on one machine and throttling rate can be compared with another's.
 * One iteration:
 *
 * 1. builds the corpus document `pages-100` with the corpus generator (JavaScript objects);
 * 2. serialises it to JSON and parses it again;
 * 3. renders its paragraphs as DOM in a sheet 624 px wide, forces a layout, then changes the text
 *    of 300 paragraphs one at a time with a forced layout after each (style, layout and text
 *    shaping, as typing does), and removes the sheet's content.
 *
 * The page exposes `__calibrate.run(iterations)`; the Playwright spec sets the CPU throttling rate.
 */
import { loadDocument } from '@docedit/corpus';

interface Node {
  type: string;
  text?: string;
  content?: Node[];
}

function paragraphsOf(node: Node, out: string[]): void {
  if (node.type === 'paragraph') {
    let text = '';
    const walk = (n: Node): void => {
      if (n.text) text += n.text;
      for (const c of n.content ?? []) walk(c);
    };
    walk(node);
    out.push(text);
    return;
  }
  for (const c of node.content ?? []) paragraphsOf(c, out);
}

interface Iteration {
  totalMs: number;
  buildMs: number;
  jsonMs: number;
  domMs: number;
  paragraphs: number;
}

async function iteration(): Promise<Iteration> {
  const sheet = document.getElementById('sheet')!;
  const t0 = performance.now();
  const doc = await loadDocument('pages-100', { verify: false });
  const t1 = performance.now();
  const parsed = JSON.parse(JSON.stringify(doc.envelope)) as { doc: Node };
  const t2 = performance.now();
  const texts: string[] = [];
  paragraphsOf(parsed.doc, texts);
  const frag = document.createDocumentFragment();
  const nodes: HTMLParagraphElement[] = [];
  for (const t of texts) {
    const p = document.createElement('p');
    p.textContent = t;
    nodes.push(p);
    frag.append(p);
  }
  sheet.append(frag);
  void sheet.offsetHeight;
  const step = Math.max(1, Math.floor(nodes.length / 300));
  for (let i = 0, k = 0; i < nodes.length && k < 300; i += step, k++) {
    const p = nodes[i]!;
    p.textContent = `${p.textContent ?? ''} typed`;
    void p.offsetHeight;
  }
  sheet.replaceChildren();
  const t3 = performance.now();
  return {
    totalMs: t3 - t0,
    buildMs: t1 - t0,
    jsonMs: t2 - t1,
    domMs: t3 - t2,
    paragraphs: texts.length,
  };
}

async function run(iterations: number): Promise<Iteration[]> {
  await document.fonts.load('14.667px "Calibration Serif"');
  await iteration(); // warm-up: JIT and caches
  const out: Iteration[] = [];
  for (let i = 0; i < iterations; i++) out.push(await iteration());
  return out;
}

Object.assign(globalThis, { __calibrate: { run, ready: true } });
