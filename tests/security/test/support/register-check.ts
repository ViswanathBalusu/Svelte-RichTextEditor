/**
 * The rules of the threat register (SEC-001), apart from the test that applies them, so that the
 * test can also show that each rule fails a register that breaks it.
 *
 * A row's status follows the backlog. The proving story's acceptance criteria are read from its
 * epic file, and a row says which of them prove it (`criteria`, 1-based; all of them when absent):
 *
 * - `proven`: every such criterion is ticked, and the row names the tests;
 * - `partly-proven`: tests exist, and at least one such criterion is not ticked. `open` lists each
 *   unticked criterion and what it still asks for;
 * - `control-not-built`: no tests yet, with the phase the control is due in. No such criterion may be
 *   ticked, since a ticked criterion has tests on record.
 *
 * So the register cannot say more than the backlog (a row called proven while a criterion is open),
 * and it cannot fall behind it (a row called not built while its story has tests and ticks).
 *
 * A test is named by its file: a name without a slash is a file of tests/security/test, a path with
 * a slash starts at the repository root. The file must exist and must name the proving story in its
 * own text, so that a row cannot point at a test that proves something else.
 */

export type Status = 'proven' | 'partly-proven' | 'control-not-built';

export interface OpenCriterion {
  /** The number of an unticked acceptance criterion of the proving story (1-based). */
  criterion: number;
  /** What that criterion still asks for, in a few words. */
  what: string;
}

export interface Threat {
  id: string;
  section: string;
  threat: string;
  control: string;
  builtBy: string[];
  provenBy: string;
  /** The acceptance criteria of the proving story that prove this row (1-based); absent: all. */
  criteria?: number[];
  phase: string;
  status: Status;
  tests: string[];
  /** The unticked criteria among those that prove this row. Present exactly when partly proven. */
  open?: OpenCriterion[];
  boundaries: string[];
  /** The wording of 10 §3 this row covers: a table row's threat, or a phrase of the prose. */
  specRows?: string[];
  /** Further SEC stories whose tests prove the same threat. */
  alsoProvenBy?: string[];
  /** The SEC story that was merged into the story named by provenBy, when that is not a SEC story. */
  mergedFrom?: string;
  provenByNote?: string;
}

export interface Register {
  boundaries: Array<{ id: string; from: string; to: string; via: string }>;
  actors: Array<{ id: string; trustedFor: string; hostile: string }>;
  threats: Threat[];
  review: { phase: string; secondMaintainerReview: string; note: string };
}

/** What the rules need to know about the repository. */
export interface CheckEnv {
  /** The tick state of each acceptance criterion of a story, in order; null: no such story. */
  criteriaOf(story: string): boolean[] | null;
  /** The text of a test file a row names, or null when the file does not exist. */
  testText(file: string): string | null;
}

export const STORY_ID = /^[A-Z]{2,4}-\d{3}$/;
export const PHASE = /^(1a|1b|2|3|4|cond)$/;
const TEST_FILE = /\.(test|spec)\.ts$/;

/**
 * The tick state of each acceptance criterion of a story, read from the text of its epic file:
 * the checkbox lines that follow `**Acceptance criteria**` under the story's heading.
 */
export function criteriaFromEpic(epic: string, story: string): boolean[] | null {
  const text = epic.replaceAll('\r\n', '\n');
  const start = text.indexOf(`\n### ${story} `);
  if (start < 0) return null;
  const lines = text.slice(start + 1).split('\n');
  const ticks: boolean[] = [];
  let inList = false;
  for (const line of lines.slice(1)) {
    if (line.startsWith('### ') || line.startsWith('## ')) break;
    if (line.startsWith('**Acceptance criteria**')) {
      inList = true;
      continue;
    }
    if (!inList || line === '') continue;
    const box = /^- \[( |x)\] /.exec(line);
    if (!box) break;
    ticks.push(box[1] === 'x');
  }
  return ticks;
}

/** The problems of one row; an empty list when the row follows every rule. */
export function rowProblems(t: Threat, env: CheckEnv): string[] {
  const problems: string[] = [];
  const say = (what: string): void => {
    problems.push(`${t.id}: ${what}`);
  };

  if (!PHASE.test(t.phase)) say(`phase "${t.phase}" is not a phase of the roadmap`);
  if (!['proven', 'partly-proven', 'control-not-built'].includes(t.status))
    say(`status "${String(t.status)}" is not one the register knows`);

  // The proving story and the criteria of it that prove this row.
  if (!STORY_ID.test(t.provenBy ?? '')) {
    say('no proving story');
    return problems;
  }
  const all = env.criteriaOf(t.provenBy);
  if (all === null) {
    say(`the proving story ${t.provenBy} is not in the backlog`);
    return problems;
  }
  if (all.length === 0) say(`the proving story ${t.provenBy} has no acceptance criteria`);
  const named = t.criteria ?? all.map((_, i) => i + 1);
  if (t.criteria !== undefined) {
    if (named.length === 0) say('`criteria` is empty: leave it out to mean every criterion');
    if (new Set(named).size !== named.length) say('`criteria` names a criterion twice');
    for (const n of named)
      if (!Number.isInteger(n) || n < 1 || n > all.length)
        say(`${t.provenBy} has no criterion ${n} (it has ${all.length})`);
  }
  const valid = named.filter((n) => Number.isInteger(n) && n >= 1 && n <= all.length);
  const unticked = valid.filter((n) => all[n - 1] !== true);
  const ticked = valid.filter((n) => all[n - 1] === true);

  // The tests: files that exist and name a story that proves this row.
  const stories = [t.provenBy, ...(t.alsoProvenBy ?? []), ...(t.mergedFrom ? [t.mergedFrom] : [])];
  const tests: string[] = Array.isArray(t.tests) ? t.tests : [];
  if (!Array.isArray(t.tests)) say('no `tests` list (an empty list means no tests yet)');
  if (new Set(tests).size !== tests.length) say('a test is named twice');
  for (const file of tests) {
    if (!TEST_FILE.test(file)) {
      say(`${file} is not a test file`);
      continue;
    }
    const text = env.testText(file);
    if (text === null) say(`the test ${file} does not exist`);
    else if (!stories.some((s) => text.includes(s)))
      say(`the test ${file} does not name ${stories.join(' or ')}`);
  }

  // The status against the tests and the backlog.
  const open = t.open ?? [];
  if (t.status === 'control-not-built') {
    if (tests.length > 0) say('marked control-not-built, yet it names tests');
    if (ticked.length > 0)
      say(
        `marked control-not-built, yet ${t.provenBy} has criterion ${ticked.join(', ')} ticked: name its tests`,
      );
    if (t.open !== undefined) say('`open` belongs to a partly proven row');
    return problems;
  }
  if (tests.length === 0)
    say('no tests: a row without tests is marked control-not-built with its phase');
  if (t.status === 'proven') {
    if (unticked.length > 0)
      say(`marked proven, yet ${t.provenBy} has criterion ${unticked.join(', ')} unticked`);
    if (t.open !== undefined) say('`open` belongs to a partly proven row');
  }
  if (t.status === 'partly-proven') {
    if (unticked.length === 0)
      say(`marked partly-proven, yet every criterion of ${t.provenBy} it names is ticked`);
    const listed = open.map((o) => o.criterion);
    if (new Set(listed).size !== listed.length) say('`open` lists a criterion twice');
    for (const n of unticked)
      if (!listed.includes(n)) say(`\`open\` does not list criterion ${n}, which is unticked`);
    for (const o of open) {
      if (!unticked.includes(o.criterion))
        say(`\`open\` lists criterion ${o.criterion}, which is ticked or not one of this row's`);
      if (typeof o.what !== 'string' || o.what.trim() === '')
        say(`\`open\` says nothing about criterion ${o.criterion}`);
    }
  }
  return problems;
}

/** The problems of every row, and identifiers used twice. */
export function registerProblems(register: Register, env: CheckEnv): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const t of register.threats) {
    if (seen.has(t.id)) problems.push(`${t.id}: the identifier is used twice`);
    seen.add(t.id);
    problems.push(...rowProblems(t, env));
  }
  return problems;
}
