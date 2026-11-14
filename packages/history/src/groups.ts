/**
 * The history list (08 §1, §4; 05 §6.2 `/history`; HIS-008): commits grouped when the list is read,
 * so that the rules can change without touching data.
 *
 * A new group starts (ADR 0051 records the readings the spec leaves open):
 *
 * - after an idle gap longer than `idleGapMs` (default five minutes);
 * - when the set of authors changes: the authors at a commit are those who committed within the
 *   idle gap before it, so two people writing together form one group, and a group ends when one
 *   joins or leaves. An assistant acting for a person is an author of its own;
 * - at a change of origin: ordinary editing (`input`, `paste`, `format`, `undo`, `redo`) is one
 *   origin, and every other origin (an import, a restore, a fill, a suggestion decision, ...) is
 *   one of its own;
 * - after a stored version: a group never runs past a version, which ends it;
 * - at a new day in the caller's time zone (default UTC).
 *
 * Control commits carry no content and are left out unless asked for (ADR 0051). The list obeys the
 * caller's gate (07 §8; ADR 0034): commits after `minVisibleSeq` and the versions the gate shows
 * as single states, so that a reader who sees named versions only gets the named versions. Region
 * and field filters on scopes the reader may not see are refused as if the scope did not exist.
 */
import { type HiddenSet, NOTHING_HIDDEN, stateVisible } from '@docedit/authority';
import {
  type CommitMeta,
  type HistoryGate,
  type HistoryResult,
  type StoredVersion,
  VERSION_KINDS,
  refuse,
} from './types.ts';

/** The commit metadata type, re-exported for the list's callers and tests (`types.ts` owns it). */
export type { CommitMeta } from './types.ts';

/** Five minutes (08 §4). */
export const DEFAULT_IDLE_GAP_MS = 5 * 60 * 1000;

/** The most items one page may hold (05 §6.1). */
export const MAX_LIMIT = 200;
export const DEFAULT_LIMIT = 50;

/** Origins of ordinary editing, which do not split a group between them. */
export const EDITING_ORIGINS: readonly string[] = ['input', 'paste', 'format', 'undo', 'redo'];

export interface AuthorRef {
  user: string;
  agent?: string;
}

export interface HistoryGroup {
  type: 'group';
  /** The calendar day of the group's first commit, `YYYY-MM-DD` in the caller's time zone. */
  day: string;
  fromSeq: number;
  toSeq: number;
  fromTime: number;
  toTime: number;
  /** The number of commits. */
  changes: number;
  /** Distinct authors in order of first appearance; an assistant is named with the person. */
  authors: AuthorRef[];
  /** Distinct sessions of the commits (server-authored commits have none). */
  sessions: string[];
  /** Distinct origins, in order of first appearance. */
  origins: string[];
  /** The stored versions that end the group. */
  versions: StoredVersion[];
}

export interface VersionItem {
  type: 'version';
  version: StoredVersion;
}

export type HistoryItem = HistoryGroup | VersionItem;

export interface HistoryFilter {
  namedOnly?: boolean;
  region?: string;
  field?: string;
  user?: string;
  fromSeq?: number;
  toSeq?: number;
}

export interface GroupOptions {
  idleGapMs?: number;
  /** An IANA time zone for day boundaries; default `UTC`. */
  timeZone?: string;
  /** Whether control commits are listed (default false). */
  includeControl?: boolean;
}

export interface HistoryListInput {
  /**
   * Commit metadata in `seq` order. For a `region` or `field` filter the service may pass only the
   * commits the per-scope table finds (06 §4.1); the filter is applied again here.
   */
  commits: readonly CommitMeta[];
  versions: readonly StoredVersion[];
  gate: HistoryGate;
  hidden?: HiddenSet;
  filter?: HistoryFilter;
  options?: GroupOptions;
  limit?: number;
  cursor?: string | null;
  /** Whether a scope (`region:<id>`, `field:<id>`) ever existed in the document. */
  scopeExists?: (scope: string) => boolean;
}

export interface HistoryPage {
  items: HistoryItem[];
  nextCursor: string | null;
}

const isServerSession = (s: string) => s === '' || s === 'system';

/** The origin class that splits groups (ordinary editing is one class). */
export function originClass(origin: string): string {
  return EDITING_ORIGINS.includes(origin) ? 'edit' : origin;
}

const authorKey = (c: { user: string; agent?: string }) => `${c.user}\u0000${c.agent ?? ''}`;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar day of a time in a time zone, as `YYYY-MM-DD`. */
export function dayOf(time: number, timeZone = 'UTC'): string {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  const parts = f.formatToParts(new Date(time));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Groups commits by the rules of the module comment. `commits` are in `seq` order; `versions` are
 * the stored versions that end groups.
 */
export function groupCommits(
  commits: readonly CommitMeta[],
  versions: readonly StoredVersion[],
  options: GroupOptions = {},
): HistoryGroup[] {
  const gap = options.idleGapMs ?? DEFAULT_IDLE_GAP_MS;
  const zone = options.timeZone ?? 'UTC';
  const versionSeqs = [...new Set(versions.map((v) => v.seq))].sort((a, b) => a - b);
  /** Whether a stored version lies in [a, b): it ends the group of the commit at `a`. */
  const versionBetween = (a: number, b: number): boolean => {
    let lo = 0;
    let hi = versionSeqs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (versionSeqs[mid]! < a) lo = mid + 1;
      else hi = mid;
    }
    return lo < versionSeqs.length && versionSeqs[lo]! < b;
  };

  const groups: HistoryGroup[] = [];
  // The authors active in the idle window before the current commit.
  const window: Array<{ time: number; key: string }> = [];
  const counts = new Map<string, number>();
  let lastSet = '';
  let current: HistoryGroup | null = null;
  let prev: CommitMeta | null = null;
  const authorsOf = new Map<HistoryGroup, Set<string>>();

  for (const c of commits) {
    if (c.kind === 'control' && !options.includeControl) continue;
    const key = authorKey(c);
    window.push({ time: c.time, key });
    counts.set(key, (counts.get(key) ?? 0) + 1);
    while (window.length && c.time - window[0]!.time > gap) {
      const old = window.shift()!;
      const n = counts.get(old.key)! - 1;
      if (n) counts.set(old.key, n);
      else counts.delete(old.key);
    }
    const set = [...counts.keys()].sort().join('\u0001');
    const day = dayOf(c.time, zone);
    const split =
      !current ||
      !prev ||
      c.time - prev.time > gap ||
      set !== lastSet ||
      originClass(c.origin) !== originClass(prev.origin) ||
      versionBetween(prev.seq, c.seq) ||
      day !== current.day;
    if (split) {
      current = {
        type: 'group',
        day,
        fromSeq: c.seq,
        toSeq: c.seq,
        fromTime: c.time,
        toTime: c.time,
        changes: 0,
        authors: [],
        sessions: [],
        origins: [],
        versions: [],
      };
      authorsOf.set(current, new Set());
      groups.push(current);
    }
    const g = current!;
    g.toSeq = c.seq;
    g.toTime = c.time;
    g.changes++;
    const seen = authorsOf.get(g)!;
    if (!seen.has(key)) {
      seen.add(key);
      g.authors.push(c.agent !== undefined ? { user: c.user, agent: c.agent } : { user: c.user });
    }
    if (!isServerSession(c.session) && !g.sessions.includes(c.session)) g.sessions.push(c.session);
    if (!g.origins.includes(c.origin)) g.origins.push(c.origin);
    lastSet = set;
    prev = c;
  }
  // A group's versions: those from its last commit up to the next group's first commit.
  const sorted = [...versions].sort(byVersion);
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const nextFrom = groups[i + 1]?.fromSeq ?? Infinity;
    g.versions = sorted.filter((v) => v.seq >= g.toSeq && v.seq < nextFrom);
  }
  return groups;
}

function byVersion(a: StoredVersion, b: StoredVersion): number {
  return a.seq - b.seq || VERSION_KINDS.indexOf(a.kind) - VERSION_KINDS.indexOf(b.kind);
}

function matches(c: CommitMeta, f: HistoryFilter): boolean {
  if (f.user !== undefined && c.user !== f.user) return false;
  if (f.fromSeq !== undefined && c.seq < f.fromSeq) return false;
  if (f.toSeq !== undefined && c.seq > f.toSeq) return false;
  if (f.region !== undefined && !c.scopes.includes(`region:${f.region}`)) return false;
  if (f.field !== undefined && !c.scopes.includes(`field:${f.field}`)) return false;
  return true;
}

// The cursor: the order key of the last item returned, so that the next page starts after it.
const CURSOR = /^h1\.([0-9a-z]+)\.([0-9])$/;

function cursorOf(item: HistoryItem): string {
  const seq = item.type === 'group' ? item.toSeq : item.version.seq;
  const tie = item.type === 'group' ? 9 : VERSION_KINDS.indexOf(item.version.kind);
  return `h1.${seq.toString(36)}.${tie}`;
}

function orderKey(item: HistoryItem): [number, number] {
  return item.type === 'group'
    ? [item.toSeq, 9]
    : [item.version.seq, VERSION_KINDS.indexOf(item.version.kind)];
}

/**
 * One page of the history list, newest first: `{ items, nextCursor }` with an opaque cursor and a
 * limit of at most 200 (05 §6.1).
 */
export function listHistory(input: HistoryListInput): HistoryResult<HistoryPage> {
  const f = input.filter ?? {};
  const hidden = input.hidden ?? NOTHING_HIDDEN;
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    return refuse('validation_failed', `limit must be from 1 to ${MAX_LIMIT}`);
  let after: [number, number] | null = null;
  if (input.cursor !== undefined && input.cursor !== null) {
    const m = CURSOR.exec(input.cursor);
    if (!m) return refuse('validation_failed', 'the cursor is not one this list gave');
    after = [parseInt(m[1]!, 36), Number(m[2])];
  }
  if (input.options?.timeZone !== undefined) {
    try {
      dayOf(0, input.options.timeZone);
    } catch {
      return refuse('validation_failed', `unknown time zone ${input.options.timeZone}`);
    }
  }
  // Filters on scopes the reader may not see are refused as if the scope did not exist.
  for (const [kind, id, isHidden] of [
    ['region', f.region, f.region !== undefined && hidden.regions.has(f.region)],
    ['field', f.field, f.field !== undefined && hidden.values.has(f.field)],
  ] as const) {
    if (id === undefined) continue;
    if (isHidden || (input.scopeExists && !input.scopeExists(`${kind}:${id}`)))
      return refuse('not_found', `no ${kind} ${id}`);
  }
  const { gate } = input;
  // Commits after the gate: a run of commits is visible only from a seq at or above it.
  const commits = input.commits.filter((c) => c.seq > gate.min && c.seq <= gate.head);
  const versions = input.versions.filter((v) =>
    stateVisible(gate.min, v.seq, gate.head, gate.named),
  );
  let items: HistoryItem[];
  const onlyVersions = f.namedOnly === true || gate.min >= gate.head;
  if (onlyVersions) {
    const named = versions
      .filter((v) => (f.namedOnly ? v.kind === 'named' : true))
      .filter((v) => (f.user === undefined ? true : v.createdBy === f.user))
      .filter((v) => (f.fromSeq === undefined ? true : v.seq >= f.fromSeq))
      .filter((v) => (f.toSeq === undefined ? true : v.seq <= f.toSeq))
      .sort(byVersion);
    let kept = named;
    if (f.region !== undefined || f.field !== undefined) {
      // Named versions after which a matching commit lies since the previous named version.
      const scopeFilter: HistoryFilter = {};
      if (f.region !== undefined) scopeFilter.region = f.region;
      if (f.field !== undefined) scopeFilter.field = f.field;
      const touching = commits.filter((c) => matches(c, scopeFilter));
      kept = named.filter((v, i) => {
        const prev = i > 0 ? named[i - 1]!.seq : -1;
        return touching.some((c) => c.seq > prev && c.seq <= v.seq);
      });
    }
    items = kept.map((version) => ({ type: 'version', version }));
  } else {
    const filtered = commits.map((c) => scoped(c, hidden)).filter((c) => matches(c, f));
    const groups = groupCommits(filtered, versions, input.options);
    // Versions no group ends (before the first listed commit, as below a `since_access` gate)
    // are listed on their own; filters on commits leave them out.
    const inGroups = new Set(groups.flatMap((g) => g.versions));
    const unfiltered = f.region === undefined && f.field === undefined && f.user === undefined;
    const alone: VersionItem[] = unfiltered
      ? versions
          .filter((v) => !inGroups.has(v))
          .filter((v) => (f.fromSeq === undefined ? true : v.seq >= f.fromSeq))
          .filter((v) => (f.toSeq === undefined ? true : v.seq <= f.toSeq))
          .map((version) => ({ type: 'version', version }))
      : [];
    items = [...groups, ...alone];
  }
  items.sort((x, y) => {
    const a = orderKey(x);
    const b = orderKey(y);
    return b[0] - a[0] || b[1] - a[1];
  });
  if (after) {
    const [s, t] = after;
    items = items.filter((it) => {
      const [a, b] = orderKey(it);
      return a < s || (a === s && b < t);
    });
  }
  const page = items.slice(0, limit);
  const nextCursor = items.length > limit ? cursorOf(page[page.length - 1]!) : null;
  return { ok: true, items: page, nextCursor };
}

/** A commit as the reader's class sees it: scopes of hidden regions and values left out. */
export function scoped(c: CommitMeta, hidden: HiddenSet): CommitMeta {
  if (hidden.regions.size === 0 && hidden.values.size === 0) return c;
  return {
    ...c,
    scopes: c.scopes.filter(
      (s) =>
        !(s.startsWith('region:') && hidden.regions.has(s.slice(7))) &&
        !(s.startsWith('field:') && hidden.values.has(s.slice(6))),
    ),
  };
}

/** Groups nested by day, newest day first as the items are. */
export function byDay(
  items: readonly HistoryItem[],
  timeZone = 'UTC',
): Array<{ day: string; items: HistoryItem[] }> {
  const out: Array<{ day: string; items: HistoryItem[] }> = [];
  for (const it of items) {
    const day = it.type === 'group' ? it.day : dayOf(it.version.createdAt, timeZone);
    const last = out[out.length - 1];
    if (last && last.day === day) last.items.push(it);
    else out.push({ day, items: [it] });
  }
  return out;
}
