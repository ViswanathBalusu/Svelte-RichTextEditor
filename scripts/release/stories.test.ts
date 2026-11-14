// The changelog's source (FND-012 criterion 2): stories, their criteria and their evidence.
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compactSnapshot,
  coverageChanges,
  diffStories,
  evidencePackages,
  parseEpic,
  parseRequirements,
  renderChangelog,
  snapshotStories,
  type StorySnapshot,
} from './stories.ts';

const EPIC = `# XYZ Example

## Area

### XYZ-001 First story

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 10 §3.8 · **Requirements:** R2, R10 · **Depends on:** none

As a maintainer, I want things.

**Acceptance criteria**

- [x] Given A, then B.
- [ ] Given C, then D.

**Evidence:** \`packages/model/src/x.ts\` and \`scripts/release/y.ts\`.

**Notes:** a note.

- a bullet in the notes is not a criterion

### XYZ-002 Second story

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | S | should | Author |

**Spec:** 08 · **Requirements:** R1 to R3 · **Depends on:** XYZ-001

- [ ] Given E, then F.

## Coverage

| a | b |
`;

const snap = (version: string, text: string): StorySnapshot => ({
  format: 1,
  version,
  generated: '2026-11-06T00:00:00Z',
  stories: parseEpic(text, 'XYZ-example.md'),
});

describe('stories', () => {
  it('reads each story: phase, requirements, criteria and the packages its evidence names', () => {
    const s = parseEpic(EPIC, 'XYZ-example.md');
    expect(Object.keys(s)).toEqual(['XYZ-001', 'XYZ-002']);
    expect(s['XYZ-001']).toMatchObject({
      title: 'First story',
      phase: '1b',
      requirements: ['R2', 'R10'],
      packages: ['@docedit/model', 'workspace'],
    });
    expect(s['XYZ-001']!.criteria.map((c) => [c.met, c.text])).toEqual([
      [true, 'Given A, then B.'],
      [false, 'Given C, then D.'],
    ]);
    expect(s['XYZ-002']).toMatchObject({
      phase: '2',
      requirements: ['R1', 'R2', 'R3'],
      packages: [],
    });
  });

  it('expands requirement lists and finds packages in evidence', () => {
    expect(parseRequirements('R1 to R3, R7; R10')).toEqual(['R1', 'R2', 'R3', 'R7', 'R10']);
    expect(
      evidencePackages(
        '`services/export-worker/Containerfile`, apps/reference-host/x and .github/workflows/release.yml',
      ),
    ).toEqual(['@docedit/export-worker', '@docedit/reference-host', 'workspace']);
  });

  it('lists the criteria met since the previous snapshot, matched by their text', () => {
    const before = snap('0.1.0', EPIC);
    const after = snap(
      '0.2.0',
      EPIC.replace('- [ ] Given C, then D.', '- [x] Given C, then D.').replace(
        '- [x] Given A, then B.',
        '- [ ] Given A, then B.',
      ),
    );
    const changes = diffStories(compactSnapshot(before), after);
    expect(changes).toEqual([
      {
        id: 'XYZ-001',
        title: 'First story',
        packages: ['@docedit/model', 'workspace'],
        newlyMet: [{ index: 2, text: 'Given C, then D.' }],
        noLongerMet: [{ index: 1, text: 'Given A, then B.' }],
        met: 1,
        total: 2,
      },
    ]);
    // Inserting a criterion above a met one does not make the met one new.
    const inserted = snap(
      '0.2.0',
      EPIC.replace('- [x] Given A, then B.', '- [ ] Given Z, then Y.\n- [x] Given A, then B.'),
    );
    expect(diffStories(before, inserted)).toEqual([]);
    // Without an earlier release, everything met so far is listed.
    expect(diffStories(null, before).map((c) => c.newlyMet.length)).toEqual([1]);
  });

  it('writes the changelog per package, tooling last', () => {
    const text = renderChangelog('0.2.0', '0.1.0', diffStories(null, snap('0.2.0', EPIC)));
    expect(text).toContain('Acceptance criteria met since 0.1.0');
    expect(text.indexOf('## @docedit/model')).toBeLessThan(
      text.indexOf('## Workspace (tooling, CI, licences)'),
    );
    expect(text).toContain(
      '- **XYZ-001 First story** (1 of 2 criteria met)\n  - Met: (1) Given A, then B.',
    );
    expect(renderChangelog('0.2.0', null, [])).toContain('No criterion changed.');
  });

  it('lists the requirements whose coverage changed', () => {
    const after = snap('0.2.0', EPIC.replace('- [ ] Given E, then F.', '- [x] Given E, then F.'));
    expect(coverageChanges(snap('0.1.0', EPIC), after)).toEqual([
      { requirement: 'R1', before: [], after: ['XYZ-002'] },
      { requirement: 'R2', before: ['XYZ-001'], after: ['XYZ-001', 'XYZ-002'] },
      { requirement: 'R3', before: [], after: ['XYZ-002'] },
    ]);
  });

  it('reads every epic of this repository and keeps snapshots small', () => {
    const s = snapshotStories(
      resolve(import.meta.dirname, '../../docs/stories'),
      '0.0.0',
      '2026-11-06T00:00:00Z',
    );
    expect(Object.keys(s.stories).length).toBeGreaterThan(500);
    expect(s.stories['FND-012']?.title).toBe('Release pipeline');
    const compact = compactSnapshot(s);
    expect(
      compact.stories['FND-012']!.criteria.every(
        (c) => c.text === undefined && /^[0-9a-f]{16}$/.test(c.sha),
      ),
    ).toBe(true);
  });
});
