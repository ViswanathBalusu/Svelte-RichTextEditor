/**
 * Fixtures for calendar dates and `{ "now": "date" }` (FRW-016; ADR 0030 §4): the date of the
 * server's instant in the workflow's time zone, around midnight, at daylight-saving changes
 * (Europe/Berlin), where a change skipped midnight (America/Sao_Paulo, 4 November 2018) and where
 * a whole day was skipped (Pacific/Apia, 30 December 2011). The instants are historical, so every
 * release of the IANA database since then agrees on them.
 */
import type { FixtureCase, FixtureGiven } from '../conformance.ts';
import { bool, date, day, err, expressionsOf, f, p, problems } from './build.ts';

const x = expressionsOf('dates');
const at = (instant: string, timeZone: string, more: FixtureGiven = {}): FixtureGiven => ({
  now: { instant, timeZone },
  ...more,
});
const NOW = { now: 'date' };
const DST = ['dst'];

export const dateCases: FixtureCase[] = [
  x('now.utc', ['now'], NOW, day('2026-11-06'), at('2026-11-06T09:00:00.000Z', 'UTC')),
  x(
    'now.ahead-of-utc',
    ['now'],
    NOW,
    day('2026-11-07'),
    at('2026-11-06T10:00:00.000Z', 'Pacific/Kiritimati'),
  ),
  x(
    'now.behind-utc',
    ['now'],
    NOW,
    day('2026-11-05'),
    at('2026-11-06T09:00:00.000Z', 'Pacific/Honolulu'),
  ),
  x(
    'now.berlin.last-millisecond-of-the-day',
    ['now'],
    NOW,
    day('2026-03-28'),
    at('2026-03-28T22:59:59.999Z', 'Europe/Berlin'),
  ),
  x(
    'now.berlin.midnight',
    ['now'],
    NOW,
    day('2026-03-29'),
    at('2026-03-28T23:00:00.000Z', 'Europe/Berlin'),
  ),
  x(
    'now.berlin.spring-forward',
    ['now'],
    NOW,
    day('2026-03-29'),
    at('2026-03-29T01:30:00.000Z', 'Europe/Berlin'),
    DST,
  ),
  x(
    'now.berlin.repeated-hour.first',
    ['now'],
    NOW,
    day('2026-10-25'),
    at('2026-10-25T00:30:00.000Z', 'Europe/Berlin'),
    DST,
  ),
  x(
    'now.berlin.repeated-hour.second',
    ['now'],
    NOW,
    day('2026-10-25'),
    at('2026-10-25T01:30:00.000Z', 'Europe/Berlin'),
    DST,
  ),
  x(
    'now.berlin.after-summer-time',
    ['now'],
    NOW,
    day('2026-10-26'),
    at('2026-10-25T23:00:00.000Z', 'Europe/Berlin'),
    DST,
  ),
  x(
    'now.sao-paulo.before-skipped-midnight',
    ['now'],
    NOW,
    day('2018-11-03'),
    at('2018-11-04T02:59:59.999Z', 'America/Sao_Paulo'),
    DST,
  ),
  x(
    'now.sao-paulo.after-skipped-midnight',
    ['now'],
    NOW,
    day('2018-11-04'),
    at('2018-11-04T03:00:00.000Z', 'America/Sao_Paulo'),
    DST,
  ),
  x(
    'now.apia.before-skipped-day',
    ['now'],
    NOW,
    day('2011-12-29'),
    at('2011-12-30T09:59:59.999Z', 'Pacific/Apia'),
  ),
  x(
    'now.apia.after-skipped-day',
    ['now'],
    NOW,
    day('2011-12-31'),
    at('2011-12-30T10:00:00.000Z', 'Pacific/Apia'),
  ),
  x('now.no-clock', ['now'], NOW, err('date', 'no_clock'), { now: null }),
  x(
    'now.unknown-time-zone',
    ['now'],
    NOW,
    err('date', 'no_clock'),
    at('2026-11-06T09:00:00.000Z', 'Mars/Olympus_Mons'),
  ),
  x(
    'now.not-a-timestamp',
    ['now'],
    NOW,
    err('date', 'no_clock'),
    at('2026-11-06T09:00:00Z', 'UTC'),
  ),
  x(
    'now.before-1970',
    ['now'],
    NOW,
    err('date', 'no_clock'),
    at('1969-12-31T23:59:59.999Z', 'UTC'),
  ),
  x(
    'now.compared',
    ['now', '>'],
    { '>': [NOW, '2026-12-31'] },
    bool(false),
    at('2026-11-06T09:00:00.000Z', 'Europe/Berlin'),
  ),
  x(
    'now.compared-with-a-field',
    ['now', '>=', 'field'],
    { '>=': [NOW, f('due')] },
    bool(true),
    at('2026-11-06T09:00:00.000Z', 'Europe/Berlin', {
      fields: [date('due')],
      values: { due: '2026-11-06' },
    }),
  ),
  x('now.shape', ['now'], { now: 'time' }, problems(p('bad_shape', '/now'))),
  x('date.leap-day', ['=='], { '==': [f('d'), '2024-02-29'] }, bool(true), {
    fields: [date('d')],
    values: { d: '2024-02-29' },
  }),
  x(
    'date.not-a-leap-day',
    ['=='],
    { '==': [f('d'), '2026-02-29'] },
    problems(p('invalid_literal', '/==/1')),
    { fields: [date('d')] },
    ['type'],
  ),
  x(
    'date.century-not-leap',
    ['<'],
    { '<': ['1900-02-28', '1900-02-29'] },
    problems(p('invalid_literal', '/</1')),
    {},
    ['type'],
  ),
  x('date.four-hundred-leap', ['<'], { '<': ['2000-02-29', '2000-03-01'] }, bool(true)),
  x('date.year-zero', ['<'], { '<': ['0000-01-01', '0001-01-01'] }, bool(true)),
  x('date.across-years', ['>'], { '>': [f('d'), '2025-12-31'] }, bool(true), {
    fields: [date('d')],
    values: { d: '2026-01-01' },
  }),
  x(
    'date.time-is-not-a-date',
    ['=='],
    { '==': [f('d'), '2026-11-06T10:00:00Z'] },
    problems(p('invalid_literal', '/==/1')),
    { fields: [date('d')] },
    ['type'],
  ),
  x('date.signed', ['<'], { '<': [f('signed'), '2026-12-01'] }, bool(true), {
    fields: [{ key: 'signed', kind: 'dateSigned' }],
    values: { signed: '2026-11-06' },
  }),
];
