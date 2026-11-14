// The kit's README states what the kit needs, which profiles exist and the order in which to
// implement them (PRO-127 criterion 2). The test checks the document against the kit's own profile
// list: every profile is listed with the mode or features it maps to, and the implementation order
// starts with `core`. It does not replace a reader following the document for an empty server.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROFILES } from '../src/profiles/index.ts';
import type { ProfileRequirement } from '../src/scenario.ts';

const here = dirname(fileURLToPath(import.meta.url));
const readme = readFileSync(join(here, '..', 'README.md'), 'utf8');

/** The table row of a profile: its first cell is the identifier in backticks. */
function rowOf(id: string): string | undefined {
  return readme.split('\n').find((line) => line.startsWith(`| \`${id}\` |`));
}

/** The text of the implementation-order section, up to the next heading. */
function orderSection(): string {
  const start = readme.indexOf('## Implementation order');
  expect(start, 'the README has an implementation-order section').toBeGreaterThan(-1);
  const rest = readme.slice(start + 1);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

function requirementText(req: ProfileRequirement): readonly string[] {
  if (req.kind === 'always') return ['always'];
  if (req.kind === 'mode') return [req.mode];
  return req.features;
}

describe('the kit README (PRO-127 criterion 2)', () => {
  it('lists every profile of the kit once', () => {
    for (const p of PROFILES) {
      const rows = readme.split('\n').filter((line) => line.startsWith(`| \`${p.id}\` |`));
      expect(rows.length, `${p.id} has one row`).toBe(1);
    }
  });

  it('states the mode or features each profile maps to', () => {
    for (const p of PROFILES) {
      const row = rowOf(p.id);
      expect(row, `${p.id} has a row`).toBeDefined();
      if (p.requires.kind === 'features' && p.requires.features.some((f) => f.startsWith('$'))) {
        // perm-read: the feature name is not yet decided (ADR 0042 item 4; PRO-130).
        expect(row, 'perm-read states that its feature name is not yet named').toContain(
          'not yet named',
        );
        continue;
      }
      for (const word of requirementText(p.requires)) {
        expect(row, `${p.id} names ${word}`).toContain(word);
      }
    }
  });

  it('starts the implementation order with core', () => {
    const first = orderSection()
      .split('\n')
      .find((line) => /^1\. /.test(line));
    expect(first, 'the order has a step 1').toBeDefined();
    expect(first).toContain('`core`');
  });

  it('names in the implementation order only profiles of the kit', () => {
    const known = new Set(PROFILES.map((p) => p.id));
    const steps = orderSection()
      .split('\n')
      .filter((line) => /^\d+\. /.test(line));
    expect(steps.length).toBeGreaterThanOrEqual(5);
    for (const step of steps) {
      for (const match of step.matchAll(/`([a-z][a-z-]*)`/g)) {
        expect(known.has(match[1]!), `${match[1]} is a profile of the kit`).toBe(true);
      }
    }
  });
});
