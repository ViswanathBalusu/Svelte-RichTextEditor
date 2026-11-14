// Visible signature appearances (12 §12; FRW-057 criteria 3 and 6): the layout is checked before use,
// a rectangle outside its page is not used, and a missing rectangle gives a diagnostic while the
// other appearances are kept. Tested through the package entry, as a host would use it.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type AppearanceTarget,
  type PageBounds,
  planAppearances,
  validateLayout,
} from '../src/index.ts';

const pages: PageBounds[] = [
  { page: 1, width: 595, height: 842 },
  { page: 2, width: 595, height: 842 },
];

const sig: AppearanceTarget = { id: 'fSig1', key: 'sig_tenant', kind: 'signature' };
const ini: AppearanceTarget = { id: 'fIni1', key: 'ini_tenant', kind: 'initials' };
const text: AppearanceTarget = { id: 'fName', key: 'name', kind: 'text' };

describe('layout.json is validated before anything uses it (FRW-057 criterion 3)', () => {
  it('refuses a layout with no fields object as a whole', () => {
    expect(validateLayout(null).ok).toBe(false);
    expect(validateLayout({ seq: 1 }).ok).toBe(false);
    expect(validateLayout({ fields: [] }).ok).toBe(false);
  });

  it('drops a bad entry, reports it, and keeps the good ones', () => {
    const check = validateLayout({
      fields: {
        good: { page: 1, rect: [10, 10, 100, 40] },
        badPage: { page: 0, rect: [10, 10, 100, 40] },
        badRect: { page: 1, rect: [100, 10, 10, 40] },
        badType: { page: 1, rect: ['1', 2, 3, 4] },
        notObject: 7,
      },
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect([...check.fields.keys()]).toEqual(['good']);
    expect(check.problems.map((p) => p.id).sort()).toEqual([
      'badPage',
      'badRect',
      'badType',
      'notObject',
    ]);
  });

  it('refuses a rectangle with a non-finite number (property)', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: false, noDefaultInfinity: false }), (x) => {
        const finite = Number.isFinite(x);
        const check = validateLayout({ fields: { f: { page: 1, rect: [x, 0, 10, 10] } } });
        if (!check.ok) throw new Error('the fields object is present');
        expect(check.fields.has('f')).toBe(finite && x < 10);
      }),
      { numRuns: 300 },
    );
  });
});

describe('a rectangle outside its page is not used (FRW-057 criterion 3)', () => {
  it('draws a signature and initials field whose rectangle lies on the page', () => {
    const plan = planAppearances(
      {
        fields: {
          fSig1: { page: 1, rect: [50, 100, 250, 140] },
          fIni1: { page: 2, rect: [0, 0, 60, 30] },
        },
      },
      [sig, ini],
      pages,
    );
    expect(plan.appearances.map((a) => [a.id, a.page, a.kind])).toEqual([
      ['fSig1', 1, 'signature'],
      ['fIni1', 2, 'initials'],
    ]);
    expect(plan.diagnostics).toEqual([]);
  });

  it('does not use a rectangle that crosses the page edge (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -50, max: 700 }),
        fc.integer({ min: 0, max: 800 }),
        (x1, y1) => {
          const rect: [number, number, number, number] = [0, 0, x1, y1];
          const plan = planAppearances({ fields: { fSig1: { page: 1, rect } } }, [sig], pages);
          const inside = x1 > 0 && x1 <= 595 && y1 > 0 && y1 <= 842;
          expect(plan.appearances.length === 1).toBe(inside);
          if (inside) return;
          // A rectangle with x1 or y1 at or below zero is not a rectangle at all (x0 < x1 fails).
          const codes = plan.diagnostics.map((d) => d.code);
          expect(codes.length).toBeGreaterThan(0);
          if (x1 > 0 && y1 > 0) expect(codes).toEqual(['rect_outside_page']);
          else expect(codes).toContain('entry_invalid');
        },
      ),
      { numRuns: 300 },
    );
  });

  it('reports a field on a page that the compiled PDF does not have', () => {
    const plan = planAppearances(
      { fields: { fSig1: { page: 9, rect: [0, 0, 10, 10] } } },
      [sig],
      pages,
    );
    expect(plan.appearances).toEqual([]);
    expect(plan.diagnostics.map((d) => d.code)).toEqual(['unknown_page']);
  });

  it('refuses the whole layout when it is invalid, and draws nothing', () => {
    const plan = planAppearances({ nope: true }, [sig, ini], pages);
    expect(plan.appearances).toEqual([]);
    expect(plan.diagnostics.map((d) => d.code)).toEqual(['layout_invalid', 'layout_invalid']);
  });
});

// The seal itself is the signing service's (not built), so only the planner's half of FRW-057
// criterion 6 is tested here: a missing rectangle gives a diagnostic and the other appearances stay.
describe('a missing rectangle is reported and the other appearances are kept (FRW-057 criterion 6, planner half)', () => {
  it('reports a signature field with no rectangle and keeps the initials appearance', () => {
    const plan = planAppearances(
      { fields: { fIni1: { page: 1, rect: [0, 0, 60, 30] } } },
      [sig, ini],
      pages,
    );
    expect(plan.appearances.map((a) => a.id)).toEqual(['fIni1']);
    expect(plan.diagnostics).toEqual([
      expect.objectContaining({ id: 'fSig1', code: 'no_rectangle', key: 'sig_tenant' }),
    ]);
  });

  it('gives each field with a rectangle its appearance and each field without one a diagnostic (property)', () => {
    const targets: AppearanceTarget[] = Array.from({ length: 8 }, (_, i) => ({
      id: `f${i}`,
      key: `k${i}`,
      kind: i % 2 === 0 ? 'signature' : 'initials',
    }));
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 8, maxLength: 8 }), (has) => {
        const fields: Record<string, unknown> = {};
        targets.forEach((t, i) => {
          if (has[i]) fields[t.id] = { page: 1 + (i % 2), rect: [10, 10 + i, 100, 40 + i] };
        });
        const plan = planAppearances({ fields }, targets, pages);
        const withRect = targets.filter((_, i) => has[i]).map((t) => t.id);
        const without = targets.filter((_, i) => !has[i]).map((t) => t.id);
        expect(plan.appearances.map((a) => a.id)).toEqual(withRect);
        expect(plan.diagnostics.map((d) => [d.id, d.code])).toEqual(
          without.map((id) => [id, 'no_rectangle']),
        );
      }),
      { numRuns: 300 },
    );
  });

  it('never throws and draws only signature and initials fields, whatever the layout holds (property)', () => {
    fc.assert(
      fc.property(fc.anything(), (layout) => {
        const plan = planAppearances(layout, [sig, ini, text], pages);
        expect(plan.appearances.every((a) => a.kind === 'signature' || a.kind === 'initials')).toBe(
          true,
        );
        // Every wanted field is either drawn or reported; none is lost silently.
        for (const t of [sig, ini]) {
          const drawn = plan.appearances.some((a) => a.id === t.id);
          const reported = plan.diagnostics.some((d) => d.id === t.id);
          expect(drawn !== reported).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('gives no appearance and no diagnostic to a field that is neither signature nor initials', () => {
    const plan = planAppearances({ fields: {} }, [text], pages);
    expect(plan).toEqual({ appearances: [], diagnostics: [] });
  });
});
