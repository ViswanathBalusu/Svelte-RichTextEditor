/**
 * SEC-001 — the threat register ties every threat of 10 §3 to its control and its proof, and this
 * check runs in CI so a mitigation cannot exist without a test and no threat is forgotten when the
 * design changes (10 §2, §3, §5). The register is threat-register.json. Its rules are in
 * support/register-check.ts: a row names tests that exist and that name its proving story, or it
 * is marked "control-not-built" with its phase; and its status follows the acceptance criteria of
 * the proving story as the backlog has them, so the register can neither say more than the backlog
 * nor fall behind it. The last tests plant a defect of each kind and show the check reports it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  criteriaFromEpic,
  registerProblems,
  rowProblems,
  type CheckEnv,
  type Register,
  type Threat,
} from './support/register-check.ts';

const HERE = fileURLToPath(new URL('..', import.meta.url)); // tests/security/
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const register = JSON.parse(readFileSync(HERE + 'threat-register.json', 'utf8')) as Register;
const testDir = HERE + 'test/';
const DOCS = ROOT + 'docs/';
const spec = readFileSync(DOCS + 'spec/10-security.md', 'utf8').replaceAll('\r\n', '\n');
const epic = readFileSync(DOCS + 'stories/SEC-security.md', 'utf8').replaceAll('\r\n', '\n');

/** The epic file of a story, by the prefix of its identifier (docs/stories/README.md §1). */
const epicTexts = new Map<string, string>();
function epicOf(story: string): string | null {
  const prefix = story.split('-')[0] ?? '';
  if (!epicTexts.has(prefix)) {
    const file = readdirSync(DOCS + 'stories').find((name) => name.startsWith(`${prefix}-`));
    epicTexts.set(prefix, file ? readFileSync(DOCS + 'stories/' + file, 'utf8') : '');
  }
  return epicTexts.get(prefix) || null;
}

/** The repository as the rules see it: the backlog's ticks and the test files on disk. */
const repository: CheckEnv = {
  criteriaOf(story) {
    const text = epicOf(story);
    return text === null ? null : criteriaFromEpic(text, story);
  },
  testText(file) {
    const path = file.includes('/') ? ROOT + file : testDir + file;
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  },
};

/** The text of one subsection of 10 §3, from its heading to the next heading. */
function specSection(section: string): string {
  const start = spec.indexOf(`\n### ${section} `);
  expect(start, `10 §${section} exists`).toBeGreaterThanOrEqual(0);
  const end = spec.indexOf('\n##', start + 1);
  return spec.slice(start, end === -1 ? undefined : end);
}

/** The first cell of every body row of the tables in a piece of Markdown. */
function firstCells(markdown: string, header: string): string[] {
  const cells: string[] = [];
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cell = (line.split('|')[1] ?? '').trim();
    if (cell === header || /^-+$/.test(cell)) continue;
    cells.push(cell);
  }
  return cells;
}

/** Story identifiers in a piece of text, with "SEC-012 to SEC-020" expanded. */
function storyIds(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/SEC-(\d{3}) to SEC-(\d{3})/g))
    for (let n = Number(m[1]); n <= Number(m[2]); n++) ids.add(`SEC-${String(n).padStart(3, '0')}`);
  for (const m of text.matchAll(/\b[A-Z]{2,4}-\d{3}\b/g)) ids.add(m[0]);
  return [...ids];
}

const SECTIONS = ['3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8'];
const TABLE_SECTIONS = ['3.1', '3.2', '3.3', '3.5', '3.6'];
const covered = (section: string): string[] =>
  register.threats.filter((t) => t.section === section).flatMap((t) => t.specRows ?? []);

describe('SEC-001 threat register', () => {
  it('gives every threat an identifier, a control, the building epic/story and the proving story', () => {
    expect(register.threats.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const t of register.threats) {
      expect(t.id, 'id').toBeTruthy();
      expect(seen.has(t.id), `${t.id} is unique`).toBe(false);
      seen.add(t.id);
      expect(t.control, `${t.id} control`).toBeTruthy();
      expect(t.builtBy.length, `${t.id} builtBy`).toBeGreaterThan(0);
      for (const story of t.builtBy) expect(story, `${t.id} builtBy`).toMatch(/^[A-Z]{2,4}-\d{3}$/);
      expect(t.provenBy, `${t.id} provenBy`).toMatch(/^[A-Z]{2,4}-\d{3}$/);
    }
  });

  it('names a SEC story of this epic as the proof, or records the SEC story merged into another', () => {
    for (const t of register.threats) {
      for (const story of [t.provenBy, ...(t.alsoProvenBy ?? [])]) {
        if (story.startsWith('SEC-')) {
          expect(epic, `${t.id}: ${story} is a story of the SEC epic`).toContain(`\n### ${story} `);
          continue;
        }
        // Not a SEC story: allowed only where the epic records that its SEC story was merged away.
        expect(t.mergedFrom, `${t.id} mergedFrom`).toMatch(/^SEC-\d{3}$/);
        expect(t.provenByNote, `${t.id} provenByNote`).toBeTruthy();
        expect(epic, `${t.id}: ${t.mergedFrom} is no longer a story`).not.toContain(
          `\n### ${t.mergedFrom} `,
        );
        expect(epic, `${t.id}: the epic records the merge`).toMatch(
          new RegExp(`${t.mergedFrom} \\([^)]*\\) was merged into ${story}\\b`),
        );
      }
    }
  });

  it('quotes 10 §3 in every row, and each quote is in the section the row names', () => {
    for (const t of register.threats) {
      if (!SECTIONS.includes(t.section)) continue;
      expect(t.specRows?.length ?? 0, `${t.id} specRows`).toBeGreaterThan(0);
      const text = specSection(t.section);
      for (const row of t.specRows ?? [])
        expect(text, `${t.id}: "${row}" is in 10 §${t.section}`).toContain(row);
    }
    // No wording is claimed by two rows.
    const all = register.threats.flatMap((t) => t.specRows ?? []);
    expect(new Set(all).size).toBe(all.length);
  });

  it('covers every threat row of the tables of 10 §3.1, §3.2, §3.3, §3.5 and §3.6', () => {
    for (const section of TABLE_SECTIONS) {
      const rows = firstCells(specSection(section), 'Threat');
      expect(rows.length, `10 §${section} has a table`).toBeGreaterThan(0);
      const have = covered(section);
      for (const row of rows) expect(have, `10 §${section} row "${row}"`).toContain(row);
      // And the register quotes no table row the spec no longer has.
      for (const row of have) expect(rows, `register row "${row}" of §${section}`).toContain(row);
    }
  });

  it('covers every item of 10 §3.7 and every sentence of 10 §3.8', () => {
    const items = specSection('3.7')
      .split('\n')
      .filter((line) => line.startsWith('- '));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items)
      expect(
        covered('3.7').some((phrase) => item.includes(phrase)),
        `10 §3.7 item "${item}"`,
      ).toBe(true);

    const prose = specSection('3.8').split('\n').slice(2).join(' ').trim();
    const sentences = prose.split(/(?<=\.)\s+(?=[A-Z])/).filter((s) => s.length > 0);
    expect(sentences.length).toBeGreaterThan(0);
    for (const sentence of sentences)
      expect(
        covered('3.8').some((phrase) => sentence.includes(phrase)),
        `10 §3.8 sentence "${sentence}"`,
      ).toBe(true);
  });

  it("agrees with the epic's own coverage tables", () => {
    // "Section of 10 | Covered by": every story named for a §3.x row proves a threat of that section.
    for (const section of SECTIONS) {
      const line = epic.split('\n').find((l) => l.startsWith(`| §${section} `));
      expect(line, `coverage row for §${section}`).toBeTruthy();
      const proving = new Set(
        register.threats
          .filter((t) => t.section === section)
          .flatMap((t) => [t.provenBy, ...(t.alsoProvenBy ?? [])]),
      );
      for (const story of storyIds((line ?? '').split('|')[2] ?? ''))
        expect(proving, `§${section}: ${story} proves a register row`).toContain(story);
    }
    // "Threat | Proved by" (10 §3.1 to §3.3): the stories of each line prove the rows it names.
    const start = epic.indexOf('| Threat | Proved by |');
    expect(start).toBeGreaterThanOrEqual(0);
    const table = epic.slice(start, epic.indexOf('\n\n', start));
    const lines = table.split('\n').slice(2);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const stories = storyIds(line.split('|')[2] ?? '');
      const rows = register.threats.filter(
        (t) =>
          ['3.1', '3.2', '3.3'].includes(t.section) &&
          stories.includes(t.provenBy) &&
          stories.every((s) => s === t.provenBy || (t.alsoProvenBy ?? []).includes(s)),
      );
      expect(rows.length, `epic line "${line}"`).toBeGreaterThan(0);
    }
  });

  it('every row of 10 §3.1 to §3.8 is present', () => {
    const sections = new Set(register.threats.map((t) => t.section));
    for (const s of SECTIONS) expect(sections, `section ${s} has threats`).toContain(s);
  });

  it('a row names tests that exist and name its proving story, or is marked control-not-built with a phase', () => {
    for (const t of register.threats) {
      if (t.status === 'control-not-built') {
        expect(t.phase, `${t.id} phase`).toMatch(/^(1a|1b|2|3|4|cond)$/);
        expect(t.tests.length, `${t.id} not-built has no tests`).toBe(0);
        continue;
      }
      expect(['proven', 'partly-proven'], `${t.id} status`).toContain(t.status);
      expect(t.tests.length, `${t.id} has tests`).toBeGreaterThan(0);
      for (const file of t.tests)
        expect(repository.testText(file), `${t.id} test ${file} exists`).not.toBeNull();
    }
  });

  it('the status of every row follows the acceptance criteria of its proving story', () => {
    // The whole rule set of support/register-check.ts, against the epic files and the tests on disk.
    expect(registerProblems(register, repository)).toEqual([]);
    // Non-vacuity: the backlog was read, and the three states are all in use or allowed for.
    expect(repository.criteriaOf('SEC-001')?.length).toBe(5);
    expect(repository.criteriaOf('SEC-999')).toBeNull();
    const states = new Set(register.threats.map((t) => t.status));
    expect(states.has('proven')).toBe(true);
    for (const t of register.threats.filter((r) => r.status === 'partly-proven'))
      expect(t.open?.length ?? 0, `${t.id} says what is open`).toBeGreaterThan(0);
  });

  it('each trust boundary of 10 §2 lists the threats that cross it, and every reference resolves', () => {
    const ids = new Set(register.boundaries.map((b) => b.id));
    expect(ids.size).toBe(6); // 10 §2: six trust boundaries
    for (const t of register.threats)
      for (const b of t.boundaries) expect(ids, `${t.id} boundary ${b}`).toContain(b);
    // Every boundary is crossed by at least one threat.
    for (const b of register.boundaries)
      expect(
        register.threats.some((t) => t.boundaries.includes(b.id)),
        `boundary ${b.id} is used`,
      ).toBe(true);
  });

  it('each actor records what it is trusted for and what is assumed hostile, with the two key assumptions', () => {
    for (const a of register.actors) {
      expect(a.trustedFor, `${a.id} trustedFor`).toBeTruthy();
      expect(a.hostile, `${a.id} hostile`).toBeTruthy();
    }
    const user = register.actors.find((a) => a.id === 'end-user');
    const worker = register.actors.find((a) => a.id === 'workers');
    expect(user?.hostile).toMatch(/hand-crafted/);
    expect(worker?.hostile).toMatch(/fully compromised/);
  });

  it('every phase-1a packet-F story has a row with tests that points at it', () => {
    // The stories this packet proves in phase 1a must each appear as a threat with tests on record.
    const withTests = new Set(
      register.threats.filter((t) => t.status !== 'control-not-built').map((t) => t.provenBy),
    );
    for (const story of [
      'SEC-012',
      'SEC-013',
      'SEC-017',
      'SEC-019',
      'SEC-021',
      'SEC-025',
      'SEC-026',
      'SEC-027',
      'SEC-031',
      'SEC-045',
      'SEC-047',
      'SEC-050',
      'SEC-059',
    ])
      expect(withTests, `${story} has tests in the register`).toContain(story);
  });

  it('records the phase-1a review input and notes the second-maintainer sign-off (SEC-003)', () => {
    expect(register.review.phase).toBe('1a');
    expect(register.review.note).toMatch(/SEC-003/);
  });
});

describe('SEC-001 the register check fails a register that breaks a rule', () => {
  // A backlog of one story with three criteria, the second unticked, and two test files.
  const EPIC = [
    '# SEC',
    '',
    '### SEC-900 A story',
    '',
    '**Acceptance criteria**',
    '',
    '- [x] Given one.',
    '- [ ] Given two.',
    '- [x] Given three.',
    '',
    '**Notes:** a note that mentions `- [ ]` in passing.',
    '- [ ] a list line in the Notes is not a criterion',
    '',
    '### SEC-901 All ticked',
    '',
    '**Acceptance criteria**',
    '',
    '- [x] Given one.',
    '',
    '### SEC-902 None ticked',
    '',
    '**Acceptance criteria**',
    '',
    '- [ ] Given one.',
    '',
  ].join('\n');
  const FILES: Record<string, string> = {
    'a.test.ts': '/** SEC-900 criterion 1. */',
    'packages/x/e2e/b.spec.ts': '/** SEC-901: a browser run. */',
    'other.test.ts': '/** SEC-555: another story. */',
  };
  const env: CheckEnv = {
    criteriaOf: (story) => criteriaFromEpic(EPIC, story),
    testText: (file) => FILES[file] ?? null,
  };
  /** Changes to the row below; a member given as `undefined` is left out of the row. */
  type Changes = { [K in keyof Threat]?: Threat[K] | undefined };
  const row = (over: Changes): Threat => {
    const made: Record<string, unknown> = {
      id: 'T-x',
      section: '3.1',
      threat: 'a threat',
      control: 'a control',
      builtBy: ['FE-001'],
      provenBy: 'SEC-900',
      phase: '1b',
      status: 'partly-proven',
      tests: ['a.test.ts'],
      open: [{ criterion: 2, what: 'the second case' }],
      boundaries: [],
      ...over,
    };
    const kept = Object.entries(made).filter(([, value]) => value !== undefined);
    return Object.fromEntries(kept) as unknown as Threat;
  };
  const problems = (over: Changes): string => rowProblems(row(over), env).join(' | ');

  it('reads the ticks of a story from its criteria list only', () => {
    expect(criteriaFromEpic(EPIC, 'SEC-900')).toEqual([true, false, true]);
    expect(criteriaFromEpic(EPIC, 'SEC-901')).toEqual([true]);
    expect(criteriaFromEpic(EPIC, 'SEC-902')).toEqual([false]);
    expect(criteriaFromEpic(EPIC, 'SEC-903')).toBeNull();
    // Windows line ends give the same answer.
    expect(criteriaFromEpic(EPIC.replaceAll('\n', '\r\n'), 'SEC-900')).toEqual([true, false, true]);
  });

  it('accepts the three states when they match the backlog', () => {
    expect(problems({})).toBe('');
    expect(problems({ criteria: [1, 3], status: 'proven', open: undefined })).toBe('');
    expect(
      problems({
        provenBy: 'SEC-901',
        status: 'proven',
        tests: ['packages/x/e2e/b.spec.ts'],
        open: undefined,
      }),
    ).toBe('');
    expect(
      problems({ provenBy: 'SEC-902', status: 'control-not-built', tests: [], open: undefined }),
    ).toBe('');
    // Tests exist for a criterion that is not ticked yet: partly proven, with the criterion open.
    expect(problems({ criteria: [2] })).toBe('');
  });

  it('fails a row with no proving story, and a row with no tests that is not marked not-built (criterion 2)', () => {
    expect(problems({ provenBy: '' })).toMatch(/no proving story/);
    expect(problems({ provenBy: 'SEC-903' })).toMatch(/SEC-903 is not in the backlog/);
    expect(problems({ tests: [] })).toMatch(/no tests: a row without tests is marked/);
    expect(problems({ status: 'proven', criteria: [1], open: undefined, tests: [] })).toMatch(
      /no tests/,
    );
    // Marked not built, it passes only with a phase of the roadmap and nothing ticked.
    expect(
      problems({
        provenBy: 'SEC-902',
        status: 'control-not-built',
        tests: [],
        open: undefined,
        phase: 'later',
      }),
    ).toMatch(/phase "later" is not a phase/);
  });

  it('fails a test that does not exist, is not a test file, or names another story', () => {
    expect(problems({ tests: ['gone.test.ts'] })).toMatch(/gone\.test\.ts does not exist/);
    expect(problems({ tests: ['a.test.ts', 'notes.md'] })).toMatch(/notes\.md is not a test file/);
    expect(problems({ tests: ['other.test.ts'] })).toMatch(/does not name SEC-900/);
    expect(problems({ tests: ['a.test.ts', 'a.test.ts'] })).toMatch(/named twice/);
    // A further proving story, or the story merged into the proving one, may be the one named.
    expect(problems({ tests: ['other.test.ts'], alsoProvenBy: ['SEC-555'] })).toBe('');
    expect(problems({ tests: ['other.test.ts'], mergedFrom: 'SEC-555' })).toBe('');
  });

  it('fails a row that says more than the backlog', () => {
    expect(problems({ status: 'proven', open: undefined })).toMatch(
      /marked proven, yet SEC-900 has criterion 2 unticked/,
    );
    expect(problems({ open: [] })).toMatch(/does not list criterion 2/);
    expect(problems({ open: [{ criterion: 2, what: '  ' }] })).toMatch(/says nothing/);
  });

  it('fails a row that has fallen behind the backlog', () => {
    expect(problems({ status: 'control-not-built', tests: [], open: undefined })).toMatch(
      /marked control-not-built, yet SEC-900 has criterion 1, 3 ticked/,
    );
    expect(problems({ criteria: [1, 3] })).toMatch(/marked partly-proven, yet every criterion/);
    expect(
      problems({
        open: [
          { criterion: 2, what: 'the second case' },
          { criterion: 3, what: 'ticked since' },
        ],
      }),
    ).toMatch(/lists criterion 3, which is ticked/);
    expect(problems({ status: 'control-not-built', open: undefined })).toMatch(
      /yet it names tests/,
    );
  });

  it('fails a criteria list that does not fit the story, and an identifier used twice', () => {
    expect(problems({ criteria: [4] })).toMatch(/SEC-900 has no criterion 4/);
    expect(problems({ criteria: [] })).toMatch(/`criteria` is empty/);
    expect(problems({ criteria: [2, 2] })).toMatch(/names a criterion twice/);
    const twice: Register = {
      boundaries: [],
      actors: [],
      review: { phase: '1a', secondMaintainerReview: 'pending', note: '' },
      threats: [row({}), row({})],
    };
    expect(registerProblems(twice, env)).toContain('T-x: the identifier is used twice');
  });
});
