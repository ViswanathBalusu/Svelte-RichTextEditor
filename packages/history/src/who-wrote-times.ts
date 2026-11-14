/**
 * The times for "who wrote this" (05 §6.2 `/attribution`; HIS-015 criterion 1, lane HIS-001-016).
 *
 * `attributionFor` answers with the runs that cover a passage, each carrying the `seq` of the commit
 * that wrote it. The spans do not carry server times: the service joins them from the commit list
 * (HIS-015 notes). This module does that join and summarises the authors with their first and last
 * times. It is pure: the caller passes the commit metadata it already holds.
 *
 * A run written by the document's creation (`seq` 0) has no commit; the caller passes the creation
 * time for it. A run whose `seq` has neither a commit nor a creation time is refused as `internal`,
 * never answered with a guessed time.
 */
import type { AttributionSpanOut } from './reader.ts';
import { type HistoryResult, refuse } from './types.ts';

export interface TimedRun extends AttributionSpanOut {
  /** Server time, Unix milliseconds, of the commit that wrote the run. */
  time: number;
}

export interface AuthorSummary {
  user: string;
  agent?: string;
  /** The `seq` values of the commits that wrote this author's runs, ascending and distinct. */
  seqs: number[];
  /** The earliest and latest server times of those commits. */
  firstTime: number;
  lastTime: number;
}

export interface TimedAttribution {
  seq: number;
  runs: TimedRun[];
  authors: AuthorSummary[];
}

export interface CommitTime {
  seq: number;
  time: number;
}

export interface TimeOptions {
  /** The creation time of the content (seq 0), when the caller has it. */
  createdAt?: number;
}

/**
 * Adds the server time to each run and summarises the authors. Authors are grouped by user and
 * agent (HIS-017: an assistant is a different author from the person it acted for).
 */
export function withRunTimes(
  answer: { seq: number; spans: readonly AttributionSpanOut[] },
  commits: readonly CommitTime[],
  options: TimeOptions = {},
): HistoryResult<TimedAttribution> {
  const times = new Map<number, number>();
  for (const c of commits) times.set(c.seq, c.time);
  if (options.createdAt !== undefined) times.set(0, options.createdAt);

  const runs: TimedRun[] = [];
  for (const s of answer.spans) {
    const time = times.get(s.seq);
    if (time === undefined)
      return refuse('internal', `no commit or creation time for seq ${s.seq} of a run`);
    runs.push({ ...s, time });
  }

  const byAuthor = new Map<string, AuthorSummary>();
  for (const r of runs) {
    const key = `${r.user}\u0000${r.agent ?? ''}`;
    let a = byAuthor.get(key);
    if (!a) {
      a = { user: r.user, seqs: [], firstTime: r.time, lastTime: r.time };
      if (r.agent !== undefined) a.agent = r.agent;
      byAuthor.set(key, a);
    }
    if (!a.seqs.includes(r.seq)) a.seqs.push(r.seq);
    a.firstTime = Math.min(a.firstTime, r.time);
    a.lastTime = Math.max(a.lastTime, r.time);
  }
  const authors = [...byAuthor.values()];
  for (const a of authors) a.seqs.sort((x, y) => x - y);
  authors.sort(
    (x, y) => x.firstTime - y.firstTime || (x.user < y.user ? -1 : x.user > y.user ? 1 : 0),
  );

  return { ok: true, seq: answer.seq, runs, authors };
}
