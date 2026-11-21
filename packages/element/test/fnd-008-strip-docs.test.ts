/**
 * FND-008: the library build removes the prose of the protocol definition and of the CDM definition
 * from the chunks it ships (`scripts/strip-docs.ts`; ADR 0418 item 5). The prose stays in the
 * sources, so the generators and the documents still read it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst, transformWithOxc } from 'vite';
import { describe, expect, it } from 'vitest';
import {
  CDM_DOC_ARGUMENTS,
  PROTOCOL_DOC_ARGUMENTS,
  STRIPPED_MODULES,
  stripDocumentation,
} from '../scripts/strip-docs.ts';

/** Runs the stripped code, which ends in a `return`-less expression assigned to `out`. */
function run(code: string): unknown {
  return new Function(`${code}\nreturn out;`)();
}

describe('stripDocumentation', () => {
  it('removes prose members in any position and keeps the rest', () => {
    const code = `const out = [
      { a: 1, doc: 'x', b: 2 },
      { doc: 'x', spec: 'y', a: 1 },
      { a: 1, spec: 'y', doc: 'x' },
      { a: 1, doc: 'x' },
      { doc: 'x' },
      { a: 1, gaps: ['G1', 'G2'], decisions: ['D1'], summary: \`s\`, b: [3] },
    ];`;
    expect(run(stripDocumentation(code))).toEqual([
      { a: 1, b: 2 },
      { a: 1 },
      { a: 1 },
      { a: 1 },
      {},
      { a: 1, b: [3] },
    ]);
  });

  it('keeps a member of that name whose value is not prose', () => {
    const code = `const out = { props: { doc: make('shape'), spec: make('shape') }, doc: 'x', n: { doc: 3 } };
      function make(v) { return { v }; }`;
    expect(run(stripDocumentation(code))).toEqual({
      props: { doc: { v: 'shape' }, spec: { v: 'shape' } },
      n: { doc: 3 },
    });
  });

  it('keeps spread members and computed keys', () => {
    const code = `const k = 'doc'; const base = { z: 1 };
      const out = { ...base, [k]: 'kept', doc: 'x', spec: 'y' };`;
    expect(run(stripDocumentation(code))).toEqual({ z: 1, doc: 'kept' });
  });

  it('removes the documentation argument of the prop constructors only when asked', () => {
    const code = `const req = (shape, doc, o) => ({ shape, doc, o });
      const opt = (shape, doc, o) => ({ shape, doc, o });
      const reqIf = (shape, prop, equals, doc, o) => ({ shape, prop, equals, doc, o });
      const out = [
        req('s', 'last'),
        req('s', 'middle', { gaps: ['G1'], k: 2 }),
        opt('s', 'last'),
        opt('s'),
        reqIf('s', 'p', 'e', 'last'),
        reqIf('s', 'p', 'e', 'middle', { k: 1 }),
        req('s', someValue()),
      ];
      function someValue() { return 'kept'; }`;
    const stripped = run(stripDocumentation(code, PROTOCOL_DOC_ARGUMENTS)) as Array<
      Record<string, unknown>
    >;
    expect(stripped.map((p) => p['doc'])).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'kept',
    ]);
    expect(stripped[1]?.['o']).toEqual({ k: 2 });
    expect(stripped[5]?.['o']).toEqual({ k: 1 });
    expect(stripped[4]?.['equals']).toBe('e');
    const unchanged = run(stripDocumentation(code)) as Array<Record<string, unknown>>;
    expect(unchanged[0]?.['doc']).toBe('last');
  });

  it('removes the documentation argument of attr in the CDM definition', () => {
    const code = `const attr = (grammar, def, doc, extra) => ({ grammar, default: def, doc, ...extra });
      const out = [attr('g', null, 'prose'), attr('g', 1, 'prose', { feature: 'x' })];`;
    expect(run(stripDocumentation(code, CDM_DOC_ARGUMENTS))).toEqual([
      { grammar: 'g', default: null },
      { grammar: 'g', default: 1, feature: 'x' },
    ]);
  });

  it('returns code without prose as it is', () => {
    const code = 'const out = { a: 1 };';
    expect(stripDocumentation(code, PROTOCOL_DOC_ARGUMENTS)).toBe(code);
  });
});

describe('the real definition modules', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const modules = [
    'protocol/src/definition/common.ts',
    'protocol/src/definition/messages.ts',
    'protocol/src/definition/errors.ts',
    'protocol/src/definition/events.ts',
    'protocol/src/definition/notifications.ts',
    'protocol/src/definition/features.ts',
    'model/src/definition/cdm1.ts',
    'model/src/definition/citations.ts',
    'model/src/definition/fields.ts',
  ];

  it.each(modules)('%s is still valid and is smaller without its prose', async (path) => {
    const id = join(root, path);
    expect(STRIPPED_MODULES.test(id.replaceAll('\\', '/')), path).toBe(true);
    const js = (await transformWithOxc(readFileSync(id, 'utf8'), id)).code;
    const positional = path.startsWith('protocol') ? PROTOCOL_DOC_ARGUMENTS : CDM_DOC_ARGUMENTS;
    const stripped = stripDocumentation(js, positional);
    expect(() => parseAst(stripped)).not.toThrow();
    expect(stripped.length).toBeLessThan(js.length);
    // Stripping what is already stripped changes nothing.
    expect(stripDocumentation(stripped, positional)).toBe(stripped);
  });
});

describe('the modules it applies to', () => {
  it('are the definitions and no other module', () => {
    const yes = [
      '/p/packages/protocol/src/definition/common.ts',
      '/p/packages/protocol/src/definition/messages.ts',
      '/p/packages/model/src/definition/cdm1.ts',
      '/p/packages/model/src/definition/fields.ts',
    ];
    const no = [
      '/p/packages/protocol/src/definition/shapes.ts',
      '/p/packages/protocol/src/definition/gaps.ts',
      '/p/packages/protocol/src/definition/decisions.ts',
      '/p/packages/model/src/definition/grammar.ts',
      '/p/packages/engine/src/core.ts',
    ];
    for (const id of yes) expect(STRIPPED_MODULES.test(id), id).toBe(true);
    for (const id of no) expect(STRIPPED_MODULES.test(id), id).toBe(false);
  });
});
