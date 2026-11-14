/**
 * The changelog's source (FND-012 criterion 2; ADR 0044 §2): the stories. A release keeps a
 * snapshot of every story's acceptance criteria; the changelog lists the criteria met since the
 * previous release's snapshot, under each package the story's Evidence line names. The same
 * snapshots give the requirements whose coverage changed (FND-014 criterion 2).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Criterion {
  met: boolean;
  /** The first 16 hexadecimal digits of the SHA-256 of the criterion's text. */
  sha: string;
  /** The text; snapshots keep only the hash. */
  text?: string;
}

export interface StoryState {
  title: string;
  epic: string;
  phase: string;
  requirements: string[];
  criteria: Criterion[];
  /** Packages the Evidence line names (`@docedit/<dir>`), or `workspace` for root tooling. */
  packages: string[];
}

export const criterionHash = (text: string) =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

export interface StorySnapshot {
  format: 1;
  version: string;
  generated: string;
  stories: Record<string, StoryState>;
}

/** `R1, R7` and `R1 to R15` as a list of requirement identifiers. */
export function parseRequirements(text: string): string[] {
  const out = new Set<string>();
  for (const part of text.split(/[,;]/)) {
    const range = /R(\d+)\s*(?:to|-|–)\s*R(\d+)/.exec(part);
    if (range) for (let i = Number(range[1]); i <= Number(range[2]); i++) out.add(`R${i}`);
    else for (const m of part.matchAll(/\bR(\d+)\b/g)) out.add(`R${m[1]}`);
  }
  return [...out].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/** Packages named by paths in an Evidence line. */
export function evidencePackages(evidence: string): string[] {
  const out = new Set<string>();
  for (const m of evidence.matchAll(/\b(?:packages|services|apps)\/([a-z0-9][a-z0-9-]*)\//g))
    out.add(`@docedit/${m[1]}`);
  if (/(?:^|[\s`(])(?:scripts|\.github|infra|licences|docs\/stories\/tools)\//.test(evidence))
    out.add('workspace');
  return [...out].sort();
}

/** Every story of one epic file. */
export function parseEpic(text: string, epic: string): Record<string, StoryState> {
  const out: Record<string, StoryState> = {};
  const blocks = text.split(/\n(?=### )/);
  for (const block of blocks) {
    const head = /^### ([A-Z]+-\d+) (.+)$/m.exec(block);
    if (!head || !block.startsWith('### ')) continue;
    const body = block.split(/\n## /)[0]!;
    const lines = body.split(/\r?\n/);
    const sep = lines.findIndex((l) => /^\|(?:\s*-+\s*\|)+\s*$/.test(l));
    const cells =
      sep >= 0
        ? (lines[sep + 1] ?? '')
            .split('|')
            .map((c) => c.trim())
            .filter(Boolean)
        : [];
    const req = /\*\*Requirements:\*\*\s*([^·\n]*)/.exec(body);
    const evidence = lines.filter((l) => l.startsWith('**Evidence:**')).join(' ');
    out[head[1]!] = {
      title: head[2]!.trim(),
      epic,
      phase: cells[1] ?? '',
      requirements: req ? parseRequirements(req[1]!) : [],
      criteria: lines
        .filter((l) => /^- \[[ x]\] /.test(l))
        .map((l) => {
          const text = l.slice(6).trim();
          return { met: l.startsWith('- [x] '), sha: criterionHash(text), text };
        }),
      packages: evidencePackages(evidence),
    };
  }
  return out;
}

/** The stories of every epic file in a stories directory (the files whose name has a prefix). */
export function snapshotStories(dir: string, version: string, generated: string): StorySnapshot {
  const stories: Record<string, StoryState> = {};
  for (const name of readdirSync(dir)
    .filter((n) => /^[A-Z]+-[a-z0-9-]+\.md$/.test(n))
    .sort())
    Object.assign(stories, parseEpic(readFileSync(join(dir, name), 'utf8'), name));
  return { format: 1, version, generated, stories };
}

/** The snapshot as a release keeps it: criteria by hash, without their text. */
export function compactSnapshot(s: StorySnapshot): StorySnapshot {
  const stories: Record<string, StoryState> = {};
  for (const [id, st] of Object.entries(s.stories))
    stories[id] = { ...st, criteria: st.criteria.map((c) => ({ met: c.met, sha: c.sha })) };
  return { ...s, stories };
}

export interface ChangeEntry {
  id: string;
  title: string;
  packages: string[];
  newlyMet: Array<{ index: number; text: string }>;
  noLongerMet: Array<{ index: number; text: string }>;
  met: number;
  total: number;
}

/**
 * Criteria met since the previous snapshot (all met ones when there is none), per story. Criteria
 * are matched by the hash of their text, so inserting or reordering criteria does not mislead; a
 * criterion whose text changed after it was met counts as met again.
 */
export function diffStories(previous: StorySnapshot | null, current: StorySnapshot): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  for (const [id, s] of Object.entries(current.stories)) {
    const before = previous?.stories[id];
    const metBefore = new Set((before?.criteria ?? []).filter((c) => c.met).map((c) => c.sha));
    const newlyMet: ChangeEntry['newlyMet'] = [];
    const noLongerMet: ChangeEntry['noLongerMet'] = [];
    s.criteria.forEach((c, i) => {
      const was = metBefore.has(c.sha);
      if (c.met && !was) newlyMet.push({ index: i + 1, text: c.text ?? '' });
      if (!c.met && was) noLongerMet.push({ index: i + 1, text: c.text ?? '' });
    });
    if (newlyMet.length || noLongerMet.length)
      out.push({
        id,
        title: s.title,
        packages: s.packages.length ? s.packages : ['workspace'],
        newlyMet,
        noLongerMet,
        met: s.criteria.filter((c) => c.met).length,
        total: s.criteria.length,
      });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

const short = (t: string) => (t.length > 200 ? `${t.slice(0, 199)}…` : t);

/** The changelog, one section per package. */
export function renderChangelog(
  version: string,
  previous: string | null,
  entries: readonly ChangeEntry[],
): string {
  const byPackage = new Map<string, ChangeEntry[]>();
  for (const e of entries)
    for (const p of e.packages) byPackage.set(p, [...(byPackage.get(p) ?? []), e]);
  const parts = [
    `# Changelog for ${version}`,
    '',
    previous
      ? `Acceptance criteria met since ${previous}, from the stories (docs/stories). A story appears under every package its Evidence line names.`
      : 'Acceptance criteria met so far (no earlier release), from the stories (docs/stories). A story appears under every package its Evidence line names.',
    '',
  ];
  if (!entries.length) parts.push('No criterion changed.', '');
  const order = [...byPackage.keys()].sort((a, b) =>
    a === 'workspace' ? 1 : b === 'workspace' ? -1 : a < b ? -1 : 1,
  );
  for (const p of order) {
    parts.push(`## ${p === 'workspace' ? 'Workspace (tooling, CI, licences)' : p}`, '');
    for (const e of byPackage.get(p)!) {
      parts.push(`- **${e.id} ${e.title}** (${e.met} of ${e.total} criteria met)`);
      for (const c of e.newlyMet) parts.push(`  - Met: (${c.index}) ${short(c.text)}`);
      for (const c of e.noLongerMet) parts.push(`  - No longer met: (${c.index}) ${short(c.text)}`);
    }
    parts.push('');
  }
  return `${parts.join('\n')}`;
}

export interface CoverageChange {
  requirement: string;
  before: string[];
  after: string[];
}

/** Stories with at least one met criterion, per requirement. */
export function coverage(snapshot: StorySnapshot | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, s] of Object.entries(snapshot?.stories ?? {}))
    if (s.criteria.some((c) => c.met))
      for (const r of s.requirements) out.set(r, [...(out.get(r) ?? []), id].sort());
  return out;
}

export function coverageChanges(
  previous: StorySnapshot | null,
  current: StorySnapshot,
): CoverageChange[] {
  const a = coverage(previous);
  const b = coverage(current);
  const reqs = [...new Set([...a.keys(), ...b.keys()])].sort(
    (x, y) => Number(x.slice(1)) - Number(y.slice(1)),
  );
  return reqs
    .map((requirement) => ({
      requirement,
      before: a.get(requirement) ?? [],
      after: b.get(requirement) ?? [],
    }))
    .filter((c) => c.before.join() !== c.after.join());
}
