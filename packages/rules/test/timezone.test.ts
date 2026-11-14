// `{ "now": "date" }` does not depend on the host's time zone (FRW-016; ADR 0030 §4): the same
// instants evaluated in Node.js processes whose TZ differ give the same dates, while the local
// Date of those processes does differ. Browsers run the fixed expectations of
// src/semantics.universal.test.ts and the dates fixtures in whatever zone the machine has.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const entry = pathToFileURL(resolve(import.meta.dirname, '../src/index.ts')).href;
const script = `
import { calendarDateIn, evaluateExpression } from ${JSON.stringify(entry)};
const cases = [
  ['2026-03-28T23:30:00.000Z', 'Europe/Berlin'],
  ['2026-03-28T23:30:00.000Z', 'America/New_York'],
  ['2026-10-25T01:30:00.000Z', 'Europe/Berlin'],
  ['2018-11-04T03:00:00.000Z', 'America/Sao_Paulo'],
  ['2011-12-30T10:00:00.000Z', 'Pacific/Apia'],
  ['2026-11-06T23:59:59.999Z', 'UTC'],
];
const out = cases.map(([instant, timeZone]) => [
  calendarDateIn(instant, timeZone),
  evaluateExpression({ now: 'date' }, { fields: [], context: { roles: [], now: { instant, timeZone } } }),
]);
console.log(JSON.stringify({ local: new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset(), out }));
`;

describe('the date of now', () => {
  it('is the same whatever time zone the host is in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rules-tz-'));
    const file = join(dir, 'now.mjs');
    writeFileSync(file, script);
    const run = (tz: string) =>
      JSON.parse(
        execFileSync(process.execPath, [file], {
          env: { ...process.env, TZ: tz },
          encoding: 'utf8',
        }),
      ) as {
        local: number;
        out: unknown;
      };
    const zones = ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Kolkata'];
    const results = zones.map(run);
    // The hosts really are in different zones...
    expect(new Set(results.map((r) => r.local)).size).toBe(zones.length);
    // ...and the dates do not move.
    for (const r of results.slice(1)) expect(r.out).toEqual(results[0]!.out);
    expect((results[0]!.out as Array<[string]>).map((x) => x[0])).toEqual([
      '2026-03-29',
      '2026-03-28',
      '2026-10-25',
      '2018-11-04',
      '2011-12-31',
      '2026-11-06',
    ]);
  });
});
