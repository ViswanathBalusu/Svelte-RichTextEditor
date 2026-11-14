/**
 * EXP-013 (Node.js only): `styles.tex` holds one macro per style that the document uses, with the
 * `basedOn` chain flattened, and its macro names come from a counter, never from a style's
 * identifier or name. The documents come from `test/docs.ts`; nothing here compiles.
 */
import { describe, expect, it } from 'vitest';
import {
  resolveParagraph,
  resolveRun,
  styleTable,
  type CdmEnvelope,
  type TreeNode,
} from '@docedit/model';
import { doc, para, run, type J } from '../test/docs.ts';
import type { Bundle } from './index.ts';

const MACRO_DEF = /^\\def(\\DES[a-z]*)\{(.*)\}$/;

/** The style macros of styles.tex: name and body, one per line that defines a macro. */
function macros(b: Bundle): Array<{ name: string; body: string }> {
  return b.files['styles.tex']!.split('\n')
    .map((l) => MACRO_DEF.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[1]!, body: m[2]! }));
}

function style(id: string, extra: J = {}): J {
  return {
    type: 'style_def',
    attrs: { id, kind: 'paragraph', name: id, builtIn: false, ...extra },
  };
}

/** A chain of `depth` styles, S0 (the root, fontSize 240) to S(depth-1); each is based on the one before. */
function chain(depth: number): J[] {
  return Array.from({ length: depth }, (_, i) =>
    style(`S${i}`, i === 0 ? { fontSize: 240 } : { basedOn: `S${i - 1}` }),
  );
}

describe('EXP-013 style macros flatten the basedOn chain (criterion 1)', () => {
  it('gives the leaf of a ten-deep chain the root value, in the macro of the leaf', async () => {
    const env = doc([para('Leaf.', { style: 'S9' })], { styles: chain(10) });
    const b = await run(env);
    // Only the leaf is used, but every style the document defines gets a macro (criterion 1 of
    // EXP-013, the default is one macro per style). That is the ten chain styles and the Normal
    // style the test helper adds. Each one carries the flattened size from S0.
    expect(macros(b).length).toBe(11);
    // The ten chain styles all inherit the root's size; the Normal style has its own default.
    expect(macros(b).filter((m) => m.body.includes('12bp')).length).toBe(10);
  });

  it('writes the same values as the model cascade for a leaf with its own override', async () => {
    const styles = [...chain(4), style('Leaf', { basedOn: 'S3', fontSize: 300, bold: true })];
    const env: CdmEnvelope = doc([para('Leaf.', { style: 'Leaf' })], { styles });
    const b = await run(env);
    const table = styleTable(env.doc as unknown as TreeNode);
    const resolved = resolveParagraph(table, { style: 'Leaf' });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const size = resolveRun(table, resolved.value, []).value?.fontSize;
    // The model's cascade gives the leaf its own size, 15pt, from its override.
    expect(size).toBe(300);
    // The leaf's own macro is the one that carries its override (the other styles do not).
    const m = macros(b).find((x) => x.body.includes('15bp'));
    expect(m).toBeDefined();
    expect(macros(b).filter((x) => x.body.includes('15bp')).length).toBe(1);
  });
});

describe('EXP-013 macro names come from a counter (criterion 2)', () => {
  it('never puts an identifier or a name with control sequences, spaces or non-ASCII into a macro name', async () => {
    const hostile = 'Evil\\input{x} é name';
    const env = doc([para('Text.', { style: 'Evil' })], {
      styles: [style('Evil', { name: hostile })],
    });
    const b = await run(env);
    const names = macros(b).map((m) => m.name);
    // Evil, and the Normal style the test helper adds (EXP-013 criterion 1).
    expect(names.length).toBe(2);
    expect(names.every((n) => /^\\DES[a-z]+$/.test(n))).toBe(true);
    expect(b.files['styles.tex']).not.toContain('Evil');
    expect(b.files['styles.tex']).not.toContain('input{x}');
    expect(b.files['styles.tex']).not.toContain('é');
  });
});

describe('EXP-013 macro names do not collide (criterion 3)', () => {
  it('gives distinct macros to styles whose names differ only in case or punctuation', async () => {
    const styles = [
      style('BodyText', { name: 'Body Text' }),
      style('Bodytext', { name: 'body-text' }),
      style('body_text', { name: 'BODY TEXT' }),
    ];
    const body = [
      para('One.', { style: 'BodyText' }),
      para('Two.', { style: 'Bodytext' }),
      para('Three.', { style: 'body_text' }),
    ];
    const b = await run(doc(body, { styles }));
    const names = macros(b).map((m) => m.name);
    // The three styles and the Normal style the test helper adds.
    expect(names.length).toBe(4);
    expect(new Set(names).size).toBe(4);
  });
});

describe('EXP-013 built-in styles get macros when a document uses them (criterion 4)', () => {
  it('writes a macro for Normal, Heading1 and Caption when the body uses them', async () => {
    const styles = [
      style('Heading1', { name: 'Heading 1', builtIn: true, outlineLevel: 0 }),
      style('Caption', { name: 'Caption', builtIn: true }),
    ];
    const body = [
      para('Plain.'),
      para('Heading.', { style: 'Heading1' }),
      para('Caption.', { style: 'Caption' }),
    ];
    const b = await run(doc(body, { styles }));
    const names = macros(b).map((m) => m.name);
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('EXP-013 a flattened style equals the cascade (criterion 5)', () => {
  it('has the model cascade value for the inherited size of a style two levels down', async () => {
    const styles = [
      style('Root', { fontSize: 200 }),
      style('Mid', { basedOn: 'Root', bold: true }),
      style('Leaf', { basedOn: 'Mid' }),
    ];
    const env: CdmEnvelope = doc([para('Leaf.', { style: 'Leaf' })], { styles });
    const b = await run(env);
    const table = styleTable(env.doc as unknown as TreeNode);
    const resolved = resolveParagraph(table, { style: 'Leaf' });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolveRun(table, resolved.value, []).value?.fontSize).toBe(200);
    const [m] = macros(b);
    expect(m!.body).toContain('10bp');
  });
});
