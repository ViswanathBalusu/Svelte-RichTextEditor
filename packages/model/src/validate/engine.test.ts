// The invariant engine (CDM-013): every violation names its invariant, a stable code, the path and
// the node `id`; other packages register invariants; context-dependent checks run when the context
// is given and are listed as not checked when it is not.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  bodyOf,
  ctx,
  defsOf,
  exampleDoc,
  invariants,
  para,
  sinkCtx,
  sinkDoc,
  type Json,
} from '../../test/support.ts';
import { FIELD_INVARIANTS } from '../fields/invariants.ts';
import { BUILT_IN_CHECKS, MODEL_CODES } from './built-in.ts';
import { VIOLATION_CODES } from './codes.ts';
import { registerInvariant } from './registry.ts';
import type { InvariantCheck } from './types.ts';
import { validate } from './validate.ts';

const root = resolve(import.meta.dirname, '../../../..');

describe('violations (CDM-013)', () => {
  it('carry the invariant, a stable code, the JSON Pointer and the node id', () => {
    const d = exampleDoc();
    // The paragraph inside the region gets a style that does not exist.
    bodyOf(d)[1]!.content[0].attrs.style = 'Missing';
    expect(validate(d, ctx).violations).toEqual([
      {
        invariant: 'I4',
        code: 'unresolved_reference',
        path: '/doc/content/1/content/1/content/0/attrs/style',
        nodeId: 'pA1b2C3d4E5f6G7h',
        message: 'style "Missing" does not exist',
      },
    ]);
  });

  it('name the nearest node with an id for text and marks, and null where no node has one', () => {
    const d = exampleDoc();
    bodyOf(d)[1]!.content[0].content[1].marks = [{ type: 'color', attrs: { value: '#ff0000' } }];
    d['title'] = 'x';
    const v = validate(d, ctx).violations;
    expect(v.find((x) => x.code === 'attribute_invalid')?.nodeId).toBe('pA1b2C3d4E5f6G7h');
    expect(v.find((x) => x.code === 'envelope_member')?.nodeId).toBeNull();
  });

  it('use a code list where every code is unique and belongs to one invariant', () => {
    const all = Object.entries(MODEL_CODES);
    expect(all.length).toBeGreaterThan(60);
    for (const [code, c] of all) {
      expect(code, code).toMatch(/^[a-z][a-z0-9_]{1,63}$/);
      expect(c.invariant, code).toMatch(/^I([1-9]|1[0-5])$/);
      expect(c.doc.length, code).toBeGreaterThan(10);
    }
    // Every invariant I1 to I15 has at least one code.
    const covered = new Set(all.map(([, c]) => c.invariant));
    for (let i = 1; i <= 15; i++) expect(covered.has(`I${i}` as never), `I${i}`).toBe(true);
  });

  it('publish the code list as spec/cdm/cdm-1.violations.json', () => {
    const published = JSON.parse(
      readFileSync(resolve(root, 'spec/cdm/cdm-1.violations.json'), 'utf8'),
    ) as { codes: Array<{ code: string; invariant: string }> };
    expect(Object.fromEntries(published.codes.map((c) => [c.code, c.invariant]))).toEqual(
      Object.fromEntries(Object.entries(MODEL_CODES).map(([k, c]) => [k, c.invariant])),
    );
  });

  it('report each failure of a sample of invariants under its own code', () => {
    const cases: Array<[string, (d: Json) => void]> = [
      ['duplicate_id', (d) => (bodyOf(d)[2]!.attrs.id = 'p3Jq8sLw0aZx1VbN')],
      ['missing_id', (d) => delete bodyOf(d)[2]!.attrs.id],
      [
        'nested_region',
        (d) =>
          bodyOf(d)[1]!.content.push({
            type: 'region',
            attrs: { id: 'rNested000000001' },
            content: [para('pNested000000001')],
          }),
      ],
      ['style_chain_cycle', (d) => (defsOf(d)[1]!.attrs.basedOn = 'Heading1')],
      ['unknown_node_type', (d) => bodyOf(d).push({ type: 'comment' })],
      ['envelope_member', (d) => (d['owner'] = 'x')],
    ];
    for (const [code, change] of cases) {
      const d = exampleDoc();
      change(d);
      expect(
        validate(d, ctx).violations.map((v) => v.code),
        code,
      ).toContain(code);
    }
  });
});

describe('registered invariants (CDM-013; CDM-022)', () => {
  const noTitles: InvariantCheck = {
    name: 'no-titles',
    codes: { region_without_title: { invariant: 'I11', doc: 'A region must have a title.' } },
    check(view, report) {
      for (const r of view.ofType('region'))
        if (r.attrs['title'] === null)
          report({
            code: 'region_without_title',
            path: `${r.path}/attrs/title`,
            message: 'no title',
          });
    },
  };

  it('run on every call once registered, and stop when removed', () => {
    const d = exampleDoc();
    delete bodyOf(d)[1]!.attrs.title;
    expect(validate(d, ctx).valid).toBe(true);
    const unregister = registerInvariant(noTitles);
    try {
      const v = validate(d, ctx).violations;
      expect(v).toEqual([
        expect.objectContaining({
          invariant: 'I11',
          code: 'region_without_title',
          nodeId: 'rG7mK2pQ9xYt4HcD',
        }),
      ]);
      expect(() => registerInvariant(noTitles)).toThrow(/already registered/);
    } finally {
      unregister();
    }
    expect(validate(d, ctx).valid).toBe(true);
  });

  it('refuse a check that reuses a code of the model or another check', () => {
    expect(() =>
      registerInvariant({
        ...noTitles,
        name: 'clash',
        codes: { duplicate_id: VIOLATION_CODES.duplicate_id },
      }),
    ).toThrow(/already used/);
    expect(() => registerInvariant({ ...noTitles, name: 'fields' })).toThrow(/already registered/);
  });

  it('can be passed for one call in the context', () => {
    const d = exampleDoc();
    delete bodyOf(d)[1]!.attrs.title;
    expect(invariants(d, { ...ctx, invariants: [noTitles] })).toEqual(['I11']);
    expect(invariants(d, ctx)).toEqual([]);
  });

  it('make the document invalid when a check throws or reports a code it did not declare', () => {
    const throwing: InvariantCheck = {
      name: 'throwing',
      codes: {},
      check() {
        throw new Error('boom');
      },
    };
    const sloppy: InvariantCheck = {
      name: 'sloppy',
      codes: {},
      check: (_view, report) => report({ code: 'made_up', path: '/doc', message: 'x' }),
    };
    for (const check of [throwing, sloppy]) {
      const r = validate(exampleDoc(), { ...ctx, invariants: [check] });
      expect(r.valid, check.name).toBe(false);
      expect(r.violations.map((v) => v.code)).toEqual(['check_failed']);
    }
  });

  it("run FRW's field invariants I13 to I15 through the same interface", () => {
    expect(BUILT_IN_CHECKS).toContain(FIELD_INVARIANTS);
    const spy = vi.spyOn(FIELD_INVARIANTS, 'check');
    validate(sinkDoc(), sinkCtx);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
    expect(new Set(Object.values(FIELD_INVARIANTS.codes).map((c) => c.invariant))).toEqual(
      new Set(['I11', 'I13', 'I14', 'I15']),
    );
  });

  it('see every node except text, with its effective attributes, path, ancestors and id', () => {
    const seen: string[] = [];
    validate(exampleDoc(), {
      ...ctx,
      invariants: [
        {
          name: 'spy',
          codes: {},
          check(view) {
            for (const n of view.nodes) seen.push(`${n.type}@${n.path}:${n.nodeId ?? '-'}`);
            const region = view.ofType('region')[0]!;
            expect(region.attrs['policy']).toBe('restricted');
            expect(region.ancestors).toEqual(['doc', 'body']);
            // Defaults are filled in.
            expect(view.ofType('settings')[0]!.attrs['dir']).toBe('ltr');
          },
        },
      ],
    });
    expect(seen).toContain('region@/doc/content/1/content/1:rG7mK2pQ9xYt4HcD');
    expect(seen.some((s) => s.startsWith('text@'))).toBe(false);
  });
});

describe('context-dependent invariants (CDM-013)', () => {
  it('list what the context did not let it check', () => {
    const r = validate(exampleDoc());
    expect(r.valid).toBe(true);
    const text = r.notChecked.join('\n');
    for (const inv of ['I2', 'I3', 'I4', 'I8']) expect(text, inv).toContain(inv);
    expect(validate(exampleDoc(), ctx).notChecked).toEqual([]);
  });

  it('I2: reports a changed identifier when the identifier changes are given', () => {
    const d = exampleDoc();
    bodyOf(d)[2]!.attrs.id = 'pChangedId000001';
    const changes = [{ from: 'pZ9y8X7w6V5u4T3s', to: 'pChangedId000001' }];
    const v = validate(d, { ...ctx, identifierChanges: changes }).violations;
    expect(v).toEqual([
      expect.objectContaining({
        invariant: 'I2',
        code: 'id_changed',
        nodeId: 'pZ9y8X7w6V5u4T3s',
        path: '/doc/content/1/content/2/attrs/id',
      }),
    ]);
    // A copy (after a split or a paste) may get its own identifier; a null one may be filled.
    expect(
      validate(d, {
        ...ctx,
        identifierChanges: [
          { from: 'pZ9y8X7w6V5u4T3s', to: 'pChangedId000001', copy: true },
          { from: null, to: 'pChangedId000001' },
        ],
      }).valid,
    ).toBe(true);
  });

  it('I3, I4 and I8 run with their context', () => {
    const d = sinkDoc();
    expect(
      validate(d, { ...sinkCtx, attachedAssets: new Set() }).violations.map((v) => v.code),
    ).toContain('asset_not_attached');
    const gate = vi.fn(() => 'refused');
    const r = validate(d, { ...sinkCtx, mathGate: gate });
    expect(r.violations.filter((v) => v.invariant === 'I8')).toHaveLength(2);
    expect(gate).toHaveBeenCalledTimes(2);
  });
});
