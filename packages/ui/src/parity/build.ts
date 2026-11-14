/**
 * Builds the published parity profile (UX-001) from its source (`profile.ts`), the built-in
 * commands, the stories and section 2 of 13. Pure: the generator and the tests pass the texts in.
 * Every check of UX-001 is a problem here, and the generator refuses to write while there is one.
 */
import {
  NON_GOAL_DECISION,
  PROFILE_DATE,
  PROFILE_VERSION,
  type ProfileRow,
  type Tier,
} from './profile.ts';

export interface StoryInfo {
  readonly id: string;
  readonly phase: string;
}

export interface CommandInfo {
  readonly id: string;
  readonly capability: string;
}

export interface BuildInput {
  readonly profile: readonly ProfileRow[];
  readonly commands: readonly CommandInfo[];
  readonly stories: ReadonlyMap<string, StoryInfo>;
  /** The text of docs/spec/13-experience-extensibility.md. */
  readonly spec13: string;
}

export interface Artifact {
  readonly path: string;
  readonly text: string;
}

export interface BuildResult {
  readonly problems: readonly string[];
  readonly artifacts: readonly Artifact[];
}

export const JSON_PATH = 'spec/parity/parity-profile.json';
export const MARKDOWN_PATH = 'spec/parity/parity-profile.md';

const TIER_ROWS: Readonly<Record<string, Tier>> = {
  'Built in': 'built-in',
  'Through ports and extensions': 'ports-and-extensions',
  'Non-goals': 'non-goal',
};

const TIER_TITLES: Readonly<Record<Tier, string>> = {
  'built-in': 'Built in',
  'ports-and-extensions': 'Through ports and extensions',
  'non-goal': 'Non-goals',
};

export const PHASES = ['0', '1a', '1b', '2', '3', '4', 'cond'];

/** Names of another product's design or features, which a row must not prescribe (13 §1). */
const OTHER_PRODUCT =
  /\b(Microsoft|Office|Ribbon|Backstage|SmartArt|Copilot|Fluent|OneDrive|SharePoint|Teams)\b|\bWord\b(?! files?\b)/;
/** Words about look and arrangement, which are this product's own design (13 §1, §3). */
const LOOK =
  /\b(ribbon|tabbed|tabs?(?! stops?)|buttons?|icons?|colou?rs? scheme|look like|looks like)\b/i;

/** Splits a cell of the 13 §2 table at commas outside parentheses. */
export function splitItems(cell: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of cell) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** The tiers of 13 §2 as the specification lists them. */
export function parityTable(spec13: string): Record<Tier, string[]> {
  const section = /## 2\. Parity profile\n([\s\S]*?)\n## /.exec(spec13)?.[1] ?? '';
  const out: Record<Tier, string[]> = {
    'built-in': [],
    'ports-and-extensions': [],
    'non-goal': [],
  };
  for (const line of section.split('\n')) {
    const m = /^\| ([^|]+?) \| (.+) \|$/.exec(line.trim());
    if (!m) continue;
    const tier = TIER_ROWS[m[1]!];
    if (tier) out[tier] = splitItems(m[2]!);
  }
  return out;
}

/** Story identifiers and phases from the epic files (`### ID Title`, then the field table). */
export function parseStories(files: ReadonlyArray<{ text: string }>): Map<string, StoryInfo> {
  const stories = new Map<string, StoryInfo>();
  for (const { text } of files) {
    let current: string | null = null;
    for (const line of text.split('\n')) {
      const heading = /^###\s+([A-Z]+-\d{3})\s/.exec(line);
      if (heading) {
        current = heading[1]!;
        continue;
      }
      if (/^#{1,3}\s/.test(line)) current = null;
      const fields =
        current && /^\|\s*(story|enabler|spike|decision)\s*\|\s*([^|]+?)\s*\|/.exec(line);
      if (current && fields && !stories.has(current)) {
        stories.set(current, { id: current, phase: fields[2]! });
        current = null;
      }
    }
  }
  return stories;
}

/** The position of a phase in the order 0, 1a, 1b, 2, 3, 4, cond; unknown phases sort last. */
export function phaseRank(phase: string): number {
  const i = PHASES.indexOf(phase);
  return i < 0 ? PHASES.length : i;
}

export function buildProfile(input: BuildInput): BuildResult {
  const problems: string[] = [];
  const { profile, commands, stories } = input;
  const byId = new Map<string, ProfileRow>();
  for (const row of profile) {
    if (byId.has(row.id)) problems.push(`row "${row.id}" is listed twice`);
    byId.set(row.id, row);
  }

  // Criterion 1: every capability of 13 §2 in exactly one tier.
  const table = parityTable(input.spec13);
  const total = Object.values(table).reduce((n, items) => n + items.length, 0);
  if (total === 0) problems.push('13 §2: the parity table was not found');
  for (const [tier, items] of Object.entries(table) as Array<[Tier, string[]]>) {
    for (const item of items) {
      const rows = profile.filter((r) => r.items.includes(item));
      if (rows.length === 0) problems.push(`13 §2 lists "${item}" (${tier}), but no row covers it`);
      for (const r of rows)
        if (r.tier !== tier)
          problems.push(`row "${r.id}" puts "${item}" in ${r.tier}, but 13 §2 lists it as ${tier}`);
    }
  }
  for (const row of profile)
    for (const item of row.items)
      if (
        !table[row.tier].includes(item) &&
        !Object.values(table).some((items) => items.includes(item))
      )
        problems.push(`row "${row.id}" quotes "${item}", which 13 §2 does not list`);

  // Stories exist; capabilities without one are reported as gaps.
  for (const row of profile) {
    for (const id of row.stories)
      if (!stories.has(id))
        problems.push(`row "${row.id}" names story ${id}, which does not exist`);
    if (row.tier !== 'non-goal' && row.stories.length === 0 && !row.gap)
      problems.push(`row "${row.id}" has no delivering story and states no gap`);
  }

  // Criterion 2: a non-goal is delivered by nothing, and the set changes only by decision.
  const nonGoals = profile.filter((r) => r.tier === 'non-goal');
  for (const row of nonGoals)
    if (row.stories.length > 0)
      problems.push(
        `non-goal "${row.id}" names delivering stories (${row.stories.join(', ')}): refused`,
      );
  const decided = [...NON_GOAL_DECISION.ids].sort().join(',');
  const current = nonGoals
    .map((r) => r.id)
    .sort()
    .join(',');
  if (decided !== current)
    problems.push(
      `the non-goals changed (${current}) without an owner decision: record it in PRODUCT.md and 13 §2 and update NON_GOAL_DECISION`,
    );

  // Criterion 3: every built-in command names a capability that the profile offers.
  for (const command of commands) {
    const row = byId.get(command.capability);
    if (!row)
      problems.push(
        `command "${command.id}" names capability "${command.capability}", which no row lists`,
      );
    else if (row.tier === 'non-goal')
      problems.push(`command "${command.id}" delivers "${row.id}", which is a non-goal: refused`);
  }

  // Criterion 4: rows say what a user can do, in this product's own words.
  for (const row of profile) {
    if (!row.can.trim().endsWith('.')) problems.push(`row "${row.id}": "can" must be a sentence`);
    if (OTHER_PRODUCT.test(row.can))
      problems.push(`row "${row.id}" names another product's feature or design: "${row.can}"`);
    if (LOOK.test(row.can))
      problems.push(`row "${row.id}" prescribes a look or arrangement: "${row.can}"`);
  }

  const rows = profile.map((row) => {
    const delivered = row.stories
      .map((id) => stories.get(id))
      .filter((s): s is StoryInfo => s !== undefined)
      .sort((a, b) => phaseRank(a.phase) - phaseRank(b.phase) || a.id.localeCompare(b.id));
    const last = delivered.at(-1);
    return {
      id: row.id,
      tier: row.tier,
      can: row.can,
      items: row.items,
      spec: row.spec,
      // The phase in which the last delivering story is planned; the first one starts it.
      phase: last?.phase ?? null,
      firstPhase: delivered[0]?.phase ?? null,
      stories: delivered.map((s) => ({ id: s.id, phase: s.phase })),
      ...(row.gap ? { gap: row.gap } : {}),
    };
  });

  const json = {
    profile: 'parity',
    version: PROFILE_VERSION,
    date: PROFILE_DATE,
    source: 'docs/spec/13-experience-extensibility.md §2; packages/ui/src/parity/profile.ts',
    generator: 'pnpm --filter @docedit/ui generate (packages/ui/scripts/generate.ts)',
    nonGoalDecision: NON_GOAL_DECISION.decided,
    counts: {
      'built-in': rows.filter((r) => r.tier === 'built-in').length,
      'ports-and-extensions': rows.filter((r) => r.tier === 'ports-and-extensions').length,
      'non-goal': rows.filter((r) => r.tier === 'non-goal').length,
    },
    rows,
    commands: commands.map((c) => ({ id: c.id, capability: c.capability })),
    gaps: rows
      .filter((r) => 'gap' in r)
      .map((r) => ({ id: r.id, gap: (r as { gap: string }).gap })),
  };

  const md: string[] = [
    '# Parity profile',
    '',
    `Version ${PROFILE_VERSION}, ${PROFILE_DATE}. Generated from \`packages/ui/src/parity/profile.ts\` by \`pnpm --filter @docedit/ui generate\`; do not edit by hand. The source of the tiers is [13 §2](../../docs/spec/13-experience-extensibility.md); the machine-readable form is \`parity-profile.json\` next to this file.`,
    '',
    "Parity is judged by what a user can do, never by how a screen looks (13 §1). Each row states a capability in this product's words, the phase in which its last delivering story is planned, and those stories. A non-goal is delivered by nothing; changing the non-goals needs an owner decision recorded in PRODUCT.md and 13 §2 in the same change set.",
    '',
  ];
  for (const tier of ['built-in', 'ports-and-extensions', 'non-goal'] as const) {
    md.push(`## ${TIER_TITLES[tier]}`, '');
    if (tier === 'non-goal') {
      md.push('| Capability | What a user can do | Spec |', '|---|---|---|');
      for (const r of rows.filter((x) => x.tier === tier))
        md.push(`| ${r.id} | ${r.can} | ${r.spec} |`);
    } else {
      md.push(
        '| Capability | What a user can do | Phase | Stories | Spec |',
        '|---|---|---|---|---|',
      );
      for (const r of rows.filter((x) => x.tier === tier)) {
        const phase = r.phase
          ? r.firstPhase !== r.phase
            ? `${r.firstPhase} to ${r.phase}`
            : r.phase
          : 'none';
        const list = r.stories.length
          ? r.stories.map((s) => `${s.id} (${s.phase})`).join(', ')
          : 'none';
        md.push(`| ${r.id} | ${r.can} | ${phase} | ${list} | ${r.spec} |`);
      }
    }
    md.push('');
  }
  md.push(
    '## Built-in commands',
    '',
    'Every command of the built-in registry (UX-003) names the row it delivers; the build fails when the row is missing.',
    '',
    '| Command | Capability |',
    '|---|---|',
    ...commands.map((c) => `| \`${c.id}\` | ${c.capability} |`),
    '',
    '## Gaps',
    '',
    ...json.gaps.map((g) => `- **${g.id}**: ${g.gap}`),
    '',
  );

  return {
    problems,
    artifacts: [
      { path: JSON_PATH, text: `${JSON.stringify(json, null, 2)}\n` },
      { path: MARKDOWN_PATH, text: md.join('\n') },
    ],
  };
}
