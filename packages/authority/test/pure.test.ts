// The authority as pure functions (SYN-001; 04 §5, §6): rebase, apply, checkInvariants and
// mapRanges take plain values, return a result instead of throwing, and are deterministic.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Fragment, Slice } from 'prosemirror-model';
import { AddMarkStep, AttrStep, ReplaceStep, type Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import * as authority from '../src/index.ts';
import { checkInvariants } from '../src/invariants.ts';
import { mapRanges } from '../src/ranges.ts';
import { applySteps, mapsOf, rebaseOver } from '../src/rebase.ts';
import { REQUIRES, baseDoc, posInside, posOf, schema } from './fixtures.ts';

const insert = (at: string, text: string, doc = baseDoc()) => {
  const pos = posInside(doc, at);
  return new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0));
};

describe('the authority package as pure functions (SYN-001)', () => {
  it('exports rebase, apply, checkInvariants and mapRanges', () => {
    for (const name of ['rebaseOver', 'applySteps', 'checkInvariants', 'mapRanges'])
      expect(typeof (authority as Record<string, unknown>)[name], name).toBe('function');
  });

  it('returns invalid_op or rebase_failed for a commit that must be rejected, and never throws', () => {
    const doc = baseDoc();
    const size = doc.content.size;
    // A mark step past the end throws inside prosemirror-transform; the result says invalid_op.
    const past = new AddMarkStep(size - 2, size + 30, schema.marks['bold']!.create());
    expect(applySteps(doc, [past])).toMatchObject({ ok: false, code: 'invalid_op' });
    // Content that does not fit fails to apply.
    const region = schema.nodeFromJSON({
      type: 'region',
      attrs: { id: 'rInner0000000001' },
      content: [{ type: 'paragraph', attrs: { id: 'pInner0000000001' } }],
    });
    const at = posInside(doc, 'pTerms000000001A');
    const nested = new ReplaceStep(at, at, new Slice(Fragment.from(region), 0, 0));
    expect(applySteps(doc, [nested])).toMatchObject({ ok: false, code: 'invalid_op' });
    // Rebasing the same crafted step over a concurrent insertion: rebase_failed.
    const over = [insert('pIntro0000000001', 'concurrent ')];
    const head = applySteps(doc, over);
    if (!head.ok) throw new Error(head.reason);
    expect(rebaseOver([past], mapsOf(over), head.value.doc, 'reject')).toMatchObject({
      ok: false,
      code: 'rebase_failed',
    });
    // An invariant violation, and steps that do not belong to the documents given.
    const rename = new AttrStep(posOf(doc, 'pIntro0000000001'), 'id', 'pRenamed00000001');
    const renamed = applySteps(doc, [rename]);
    if (!renamed.ok) throw new Error(renamed.reason);
    const ctx = { requires: REQUIRES, retiredRegionIds: new Set<string>() };
    expect(
      checkInvariants(doc, renamed.value.doc, [rename], renamed.value.docs, ctx),
    ).toMatchObject({
      ok: false,
      code: 'invalid_op',
    });
    const stray = new AttrStep(size + 50, 'id', 'pRenamed00000001');
    expect(() => checkInvariants(doc, doc, [stray], [doc], ctx)).not.toThrow();
    expect(checkInvariants(doc, doc, [stray], [doc], ctx)).toMatchObject({
      ok: false,
      code: 'invalid_op',
    });
  });

  it('gives identical outputs for identical inputs', () => {
    const run = () => {
      const doc = baseDoc();
      const steps: Step[] = [
        insert('pIntro0000000001', 'one '),
        insert('pTerms000000001A', 'two '),
      ];
      const applied = applySteps(doc, steps);
      if (!applied.ok) throw new Error(applied.reason);
      const over = [insert('pMiddle000000001', 'three ')];
      const head = applySteps(doc, over);
      if (!head.ok) throw new Error(head.reason);
      const rebased = rebaseOver(steps, mapsOf(over), head.value.doc, 'reject');
      if (!rebased.ok) throw new Error(rebased.reason);
      const inv = checkInvariants(doc, applied.value.doc, steps, applied.value.docs, {
        requires: REQUIRES,
        retiredRegionIds: new Set(),
      });
      const ranges = mapRanges(
        [
          { from: 5, to: 40 },
          { from: 60, to: 61 },
        ],
        mapsOf(steps),
      );
      return JSON.stringify({
        applied: applied.value.doc.toJSON(),
        rebased: rebased.value.steps.map((s) => s.toJSON()),
        doc: rebased.value.doc.toJSON(),
        inv,
        ranges,
      });
    };
    expect(run()).toBe(run());
  });

  it('reads no clock, random source or global state of its own', () => {
    const src = resolve(import.meta.dirname, '../src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(src);
    expect(files.length).toBeGreaterThan(10);
    // `new Date(ms)` formats an instant the caller passed and reads no clock; `Date()` and
    // `new Date()` with no argument read it, and are refused.
    const impure =
      /Date\.now|\bDate\(\s*\)|Math\.random|performance\.now|getRandomValues|randomUUID|setTimeout|setInterval/;
    expect('const t = new Date();').toMatch(impure);
    expect('const t = Date( );').toMatch(impure);
    expect('const t = new Date(e.now);').not.toMatch(impure);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(impure);
  });
});
