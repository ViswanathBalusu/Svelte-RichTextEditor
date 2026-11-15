/**
 * SEC-001 — the threat register ties every threat of 10 §3 to its control and its proof, and this
 * check runs in CI so a mitigation cannot exist without a test and no threat is forgotten when the
 * design changes (10 §2, §3, §5). The register is threat-register.json; a "proven" row must name
 * tests that exist, and a row with no proof must be marked "control-not-built" with its phase.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Threat {
  id: string;
  section: string;
  threat: string;
  control: string;
  builtBy: string[];
  provenBy: string;
  phase: string;
  status: 'proven' | 'control-not-built';
  tests: string[];
  boundaries: string[];
  /** The wording of 10 §3 this row covers: a table row's threat, or a phrase of the prose. */
  specRows?: string[];
  /** Further SEC stories whose tests prove the same threat. */
  alsoProvenBy?: string[];
  /** The SEC story that was merged into the story named by provenBy, when that is not a SEC story. */
  mergedFrom?: string;
  provenByNote?: string;
}
interface Register {
  boundaries: Array<{ id: string; from: string; to: string; via: string }>;
  actors: Array<{ id: string; trustedFor: string; hostile: string }>;
  threats: Threat[];
  review: { phase: string; secondMaintainerReview: string; note: string };
}

const HERE = fileURLToPath(new URL('..', import.meta.url)); // tests/security/
const register = JSON.parse(readFileSync(HERE + 'threat-register.json', 'utf8')) as Register;
const testDir = HERE + 'test/';
const DOCS = fileURLToPath(new URL('../../../docs/', import.meta.url));
const spec = readFileSync(DOCS + 'spec/10-security.md', 'utf8').replaceAll('\r\n', '\n');
const epic = readFileSync(DOCS + 'stories/SEC-security.md', 'utf8').replaceAll('\r\n', '\n');

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

  it('a proven row names tests that exist; an unproven row is marked control-not-built with a phase', () => {
    for (const t of register.threats) {
      if (t.status === 'proven') {
        expect(t.tests.length, `${t.id} proven has tests`).toBeGreaterThan(0);
        for (const file of t.tests)
          expect(existsSync(testDir + file), `${t.id} test ${file} exists`).toBe(true);
      } else {
        expect(t.status, `${t.id} status`).toBe('control-not-built');
        expect(t.phase, `${t.id} phase`).toMatch(/^(1a|1b|2|3|4|cond)$/);
        expect(t.tests.length, `${t.id} not-built has no tests`).toBe(0);
      }
    }
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

  it('every phase-1a packet-F story has a proven row that points at it', () => {
    // The stories this packet proves in phase 1a must each appear as a proven threat.
    const proven = new Set(
      register.threats.filter((t) => t.status === 'proven').map((t) => t.provenBy),
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
      expect(proven, `${story} is proven in the register`).toContain(story);
  });

  it('records the phase-1a review input and notes the second-maintainer sign-off (SEC-003)', () => {
    expect(register.review.phase).toBe('1a');
    expect(register.review.note).toMatch(/SEC-003/);
  });
});
