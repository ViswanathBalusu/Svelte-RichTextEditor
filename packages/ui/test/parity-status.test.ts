/**
 * The parity report (UX-002 criterion 1): every row shows one of shipped, partial, planned (with its
 * phase) or not planned, derived only from the state of its stories; criterion 4: judged by the
 * stories and their criteria, never by appearance.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PHASES } from '../src/parity/build.ts';
import { PROFILE, type ProfileRow } from '../src/parity/profile.ts';
import {
  parseCriteria,
  parityReport,
  rowStatus,
  stateRank,
  type StoryProgress,
} from '../src/parity/status.ts';

const row = (over: Partial<ProfileRow> & Pick<ProfileRow, 'stories'>): ProfileRow => ({
  id: 'r',
  tier: 'built-in',
  can: 'Do a thing.',
  items: [],
  spec: '13 §2',
  ...over,
});

function progressOf(stories: readonly StoryProgress[]): Map<string, StoryProgress> {
  return new Map(stories.map((s) => [s.id, s]));
}

const story = (id: string, ticked: number, total: number, phase = '1b'): StoryProgress => ({
  id,
  phase,
  ticked,
  total,
});

describe('the four states (UX-002, criterion 1)', () => {
  it('shows shipped when every delivering story has every criterion ticked and the row has no gap', () => {
    const r = row({ stories: ['A-001', 'A-002'] });
    const p = progressOf([story('A-001', 3, 3), story('A-002', 2, 2)]);
    expect(rowStatus(r, p)).toEqual({ state: 'shipped' });
  });

  it('shows partial when some criterion is ticked but not every one', () => {
    const r = row({ stories: ['A-001', 'A-002'] });
    expect(rowStatus(r, progressOf([story('A-001', 3, 3), story('A-002', 1, 2)]))).toEqual({
      state: 'partial',
    });
  });

  it('shows planned with the earliest phase of its stories when nothing is ticked', () => {
    const r = row({ stories: ['A-001', 'A-002'] });
    const p = progressOf([story('A-001', 0, 3, '2'), story('A-002', 0, 2, '1a')]);
    expect(rowStatus(r, p)).toEqual({ state: 'planned', phase: '1a' });
  });

  it('shows not planned for a non-goal, whatever its stories say', () => {
    const r = row({ tier: 'non-goal', stories: ['A-001'] });
    expect(rowStatus(r, progressOf([story('A-001', 2, 2)]))).toEqual({ state: 'not-planned' });
  });

  it('shows not planned for a row with no delivering story, or none of its stories known', () => {
    expect(rowStatus(row({ stories: [], gap: 'nothing yet' }), new Map())).toEqual({
      state: 'not-planned',
    });
    expect(rowStatus(row({ stories: ['A-009'] }), new Map())).toEqual({ state: 'not-planned' });
  });

  it('never shows shipped while the row states a gap (criterion 4: capability, not appearance)', () => {
    const r = row({ stories: ['A-001'], gap: 'the part without a story' });
    expect(rowStatus(r, progressOf([story('A-001', 4, 4)]))).toEqual({ state: 'partial' });
  });

  it('never shows shipped for a story with no criteria yet', () => {
    expect(rowStatus(row({ stories: ['A-001'] }), progressOf([story('A-001', 0, 0)]))).toEqual({
      state: 'planned',
      phase: '1b',
    });
  });
});

describe('the report (UX-002, criterion 1)', () => {
  it('gives every row exactly one state, and a planned row a phase of the specification (property)', () => {
    const ids = PROFILE.flatMap((r) => r.stories);
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 0, max: 4 })), {
          minLength: ids.length,
          maxLength: ids.length,
        }),
        fc.constantFrom(...PHASES),
        (counts, phase) => {
          const uniq = [...new Set(ids)];
          const p = progressOf(
            uniq.map((id, i) => {
              const [a, b] = counts[i % counts.length]!;
              return story(id, Math.min(a, b), Math.max(a, b), phase);
            }),
          );
          const report = parityReport(PROFILE, p);
          expect(report.rows.length).toBe(PROFILE.length);
          for (const r of report.rows) {
            expect(['shipped', 'partial', 'planned', 'not-planned']).toContain(r.status.state);
            if (r.status.state === 'planned') expect(PHASES).toContain(r.status.phase);
          }
        },
      ),
    );
  });

  it('never moves a row down when a criterion is ticked (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        (ticked, total, extra, other) => {
          const cap = Math.max(total, 1);
          const before = Math.min(ticked, cap);
          const after = Math.min(before + 1, cap);
          const r = row({
            stories: ['A-001', 'A-002'],
            ...(other % 2 === 0 ? { gap: 'the part without a story' } : {}),
          });
          const second = story('A-002', Math.min(extra, cap), cap);
          const low = rowStatus(r, progressOf([story('A-001', before, cap), second]));
          const high = rowStatus(r, progressOf([story('A-001', after, cap), second]));
          expect(stateRank(high)).toBeGreaterThanOrEqual(stateRank(low));
        },
      ),
    );
  });

  it('reports the stories it cannot find without changing the state of the others', () => {
    const r = row({ id: 'x', stories: ['A-001', 'A-404'] });
    const report = parityReport([r], progressOf([story('A-001', 1, 2, '1a')]));
    expect(report.rows[0]!.status).toEqual({ state: 'partial' });
    expect(report.problems).toEqual(['row "x" names A-404, which the progress does not know']);
  });

  it('shows only planned or not planned when every story is at zero', () => {
    const ids = [...new Set(PROFILE.flatMap((r) => r.stories))];
    const report = parityReport(PROFILE, progressOf(ids.map((id) => story(id, 0, 1, '1b'))));
    expect(report.problems).toEqual([]);
    for (const r of report.rows) expect(['planned', 'not-planned']).toContain(r.status.state);
  });
});

describe('reading criteria from the epic files', () => {
  const text = [
    '## Epic',
    '',
    '### UX-900 First story',
    '',
    '| Type | Phase | Size | Priority | Persona |',
    '|---|---|---|---|---|',
    '| story | 1b | M | must | Author |',
    '',
    '**Acceptance criteria**',
    '',
    '- [x] Given a, then b.',
    '- [ ] Given c, then d.',
    '- [x] Given e, then f.',
    '',
    '**Notes:** not a criterion - [x] inside prose is not read.',
    '',
    '### UX-901 Second story',
    '',
    '| story | 2 | S | must | Author |',
    '',
    '- [ ] Given g, then h.',
    '',
    '## Next section',
    '- [x] outside any story',
  ].join('\n');

  it('counts ticked and total criteria per story, with the story phase', () => {
    const progress = parseCriteria([{ text }]);
    expect(progress.get('UX-900')).toEqual({ id: 'UX-900', phase: '1b', ticked: 2, total: 3 });
    expect(progress.get('UX-901')).toEqual({ id: 'UX-901', phase: '2', ticked: 0, total: 1 });
    expect(progress.size).toBe(2);
  });
});
