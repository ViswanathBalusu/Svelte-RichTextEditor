// Every file in fixtures/semantics is run by semantics-fixtures.universal.test.ts (CDM-005), so a
// new fixture file cannot be left out by mistake. Browsers cannot list a directory, so this check
// runs in Node.js only.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '../../fixtures/semantics');
const runner = readFileSync(
  join(import.meta.dirname, 'semantics-fixtures.universal.test.ts'),
  'utf8',
);

describe('semantics fixtures', () => {
  it('are all imported and registered by the runner', () => {
    const names = readdirSync(dir).filter((n) => n.endsWith('.json'));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(runner, name).toContain(`'../../fixtures/semantics/${name}'`);
      expect(runner, name).toContain(`'${name}':`);
    }
  });

  it('are only JSON files, so that any language can read them', () => {
    expect(readdirSync(dir).filter((n) => !n.endsWith('.json'))).toEqual([]);
  });
});
