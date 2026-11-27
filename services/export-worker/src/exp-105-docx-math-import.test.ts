/**
 * EXP-105: Office math in a Word file becomes LaTeX through the converter of `@docedit/export-docx`
 * (EXP-054, decision 234) and the real math gate of `@docedit/export-latex` (09 §6.3), which this
 * service depends on and the importer does not. The files are the two real Word files of the
 * SPK-028 corpus that hold Office math (`equation-sample.docx`, `tracked-changes-equations.docx`).
 * Node.js, no Podman.
 */
import { readFileSync } from 'node:fs';
import { mathGateReason } from '@docedit/export-latex';
import {
  entryData,
  exportDocx,
  importDocx,
  latexToOmml,
  ommlToLatex,
  parseLatex,
  parseXml,
  readZip,
  toLatex,
} from '@docedit/export-docx';
import { describe, expect, it } from 'vitest';

const load = (name: string): Uint8Array =>
  new Uint8Array(
    readFileSync(new URL(`../../../packages/export-docx/corpus/${name}`, import.meta.url)),
  );
const SAMPLE = 'docx4j/equation-sample.docx';
const TRACKED = 'docx4j/tracked-changes-equations.docx';

interface Node {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
}
function* walk(n: Node): Generator<Node> {
  yield n;
  for (const c of n.content ?? []) yield* walk(c);
}
const equations = (doc: unknown): Node[] =>
  [...walk(doc as Node)].filter((n) => n.type === 'equation' || n.type === 'equation_block');

describe('EXP-105: Office math of real Word files becomes LaTeX that passes the gate', () => {
  it('converts the quadratic formula of a Word file and writes the file back unchanged (R0)', async () => {
    const bytes = load(SAMPLE);
    const r = await importDocx(bytes, { mathGate: mathGateReason });
    const eq = equations(r.envelope.doc);
    expect(eq.map((n) => [n.type, n.attrs?.['latex']])).toEqual([
      ['equation_block', String.raw`\frac{dy}{dx}\ \pm\frac{-b\pm\sqrt{b^2-4ac}}{2a}`],
    ]);
    expect(r.envelope.requires).toContain('preserve');
    // Nothing of the equation stays as preserved content, and the file comes back as it was.
    const out = await exportDocx(r.envelope, bytes, r.sourceMap, r.assets);
    expect(out.bytes).toEqual(bytes);
    expect(out.regenerated).toEqual([]);
  });

  it('converts inline and display equations, and keeps the one that cannot be converted', async () => {
    const bytes = load(TRACKED);
    const r = await importDocx(bytes, { mathGate: mathGateReason });
    const eq = equations(r.envelope.doc);
    // Ten equations in the file: nine become equations (seven display, two inline) and one has an
    // accent with no character, which the converter does not take.
    expect(eq.filter((n) => n.type === 'equation_block').length).toBe(7);
    expect(eq.filter((n) => n.type === 'equation').length).toBe(2);
    // Every stored value passes the gate, again here with its display flag.
    for (const n of eq)
      expect(
        mathGateReason(String(n.attrs?.['latex']), n.type === 'equation_block'),
        String(n.attrs?.['latex']),
      ).toBeNull();
    const warnings = r.warnings.filter((w) => w.includes('equation'));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/block \S+\) was not made editable/);
    expect(warnings[0]).toContain('an accent that is not on the list');
    const out = await exportDocx(r.envelope, bytes, r.sourceMap, r.assets);
    expect(out.bytes).toEqual(bytes);
  });

  it('writes the original Office math while an equation is unedited and the new math once it is edited', async () => {
    const bytes = load(SAMPLE);
    const r = await importDocx(bytes, { mathGate: mathGateReason });
    const env = structuredClone(r.envelope);
    const block = equations(env.doc)[0]!;
    block.attrs!['latex'] = String.raw`a^2 + b^2 = c^2`;
    const out = await exportDocx(env, bytes, r.sourceMap, r.assets);
    expect(out.bytes).not.toEqual(bytes);
    const zip = readZip(out.bytes);
    const xml = new TextDecoder().decode(entryData(zip, zip.byName.get('word/document.xml')!));
    const root = parseXml(new TextEncoder().encode(xml)).root;
    const para = (function find(e: typeof root): typeof root | null {
      if (e.local === 'oMathPara') return e;
      for (const c of e.children)
        if (c.kind === 'element') {
          const hit = find(c);
          if (hit) return hit;
        }
      return null;
    })(root)!;
    expect(ommlToLatex(para)).toBe(toLatex(parseLatex('a^2 + b^2 = c^2')));
    // The paragraph's own properties are still the original's.
    expect(xml).toContain('w:rsidR=');
    // Imported again, the edited LaTeX is what the file now says.
    const again = await importDocx(out.bytes, { mathGate: mathGateReason });
    expect(equations(again.envelope.doc).map((n) => n.attrs?.['latex'])).toEqual(['a^2+b^2=c^2']);
  });

  it('stores no LaTeX when no gate is given', async () => {
    const r = await importDocx(load(TRACKED));
    expect(equations(r.envelope.doc)).toEqual([]);
  });

  it('refuses to store LaTeX the gate refuses, and says which equation', async () => {
    const r = await importDocx(load(TRACKED), {
      mathGate: (latex) =>
        latex.includes('rho') ? 'a reason of the test' : mathGateReason(latex, false),
    });
    const stored = equations(r.envelope.doc).map((n) => String(n.attrs?.['latex']));
    expect(stored.some((l) => l.includes('rho'))).toBe(false);
    expect(
      r.warnings.some((w) =>
        w.includes('the converted LaTeX fails the math gate: a reason of the test'),
      ),
    ).toBe(true);
  });
});

describe('EXP-054 criterion 2, measured with the converter that was built', () => {
  it('converts every equation of the allow-list corpus and the Office math of the two real files', async () => {
    // The equations of packages/export-docx/test/math-corpus.ts, through our own writer and reader.
    const { ALLOWED } = await import('../../../packages/export-docx/test/math-corpus.ts');
    let correct = 0;
    let wrong = 0;
    const refused: string[] = [];
    const gateRefused: string[] = [];
    for (const latex of ALLOWED) {
      try {
        const canonical = toLatex(parseLatex(latex));
        const xml = latexToOmml(latex, false);
        const back = ommlToLatex(parseXml(new TextEncoder().encode(xml)).root);
        if (back !== canonical) wrong++;
        else if (mathGateReason(canonical, false) !== null) gateRefused.push(canonical);
        else correct++;
      } catch {
        refused.push(latex);
      }
    }
    expect({ total: ALLOWED.length, correct, wrong, refused, gateRefused }).toEqual({
      total: ALLOWED.length,
      correct: ALLOWED.length,
      wrong: 0,
      refused: [],
      gateRefused: [],
    });
  });
});
