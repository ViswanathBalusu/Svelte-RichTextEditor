/**
 * A catch-up port for the shell's browser tests of the catch-up (HIS-028). It answers from a fixed
 * activity (three changes in two regions by two people, one comment, a mention of the user and a
 * task assigned to them) and keeps a marker that only moves forward, as the service does: after
 * the marker is at the head the port answers with nothing. `empty` has no activity from the start;
 * `failing` rejects every load; `not-viewed` says the user has not viewed the head, so the marker
 * must not move. Every call to `markSeen` is recorded on `window.__catchUpLog`.
 */
import type {
  CatchUpActivity,
  CatchUpPort,
  CatchUpResult,
  ResolveUsers,
} from '../../src/core-api.ts';

export type CatchUpHarnessMode = 'full' | 'empty' | 'failing' | 'not-viewed';

const HEAD = 9;

const FULL: CatchUpActivity = {
  marker: 2,
  head: HEAD,
  changes: [
    { kind: 'modified', blockId: 'b1', region: 'Summary', user: 'u1' },
    { kind: 'added', blockId: 'b2', region: 'Summary', user: 'u1' },
    { kind: 'formatted', blockId: 'b3', user: 'u2' },
  ],
  comments: 1,
  // The task comes first on purpose: the pane lists the mention first.
  forYou: [
    { kind: 'task', thread: 'thread-2', author: null, excerpt: null },
    { kind: 'mention', thread: 'thread-1', author: 'u2', excerpt: 'Can you check <b>this</b>?' },
  ],
};

export interface CatchUpLog {
  marked: number[];
  loads: number;
}

function log(): CatchUpLog {
  const g = globalThis as { __catchUpLog?: CatchUpLog };
  g.__catchUpLog ??= { marked: [], loads: 0 };
  return g.__catchUpLog;
}

export function catchUpPort(mode: CatchUpHarnessMode, resolve: ResolveUsers): CatchUpPort {
  let marker = mode === 'empty' ? HEAD : FULL.marker;
  const listeners = new Set<() => void>();
  return {
    async load(): Promise<CatchUpResult> {
      log().loads++;
      if (mode === 'failing') throw new Error('the activity is down');
      const seen = marker >= HEAD;
      const activity: CatchUpActivity = seen
        ? { ...FULL, marker, changes: [], comments: 0, forYou: [] }
        : { ...FULL, marker };
      return { ok: true, activity };
    },
    async markSeen(seq) {
      log().marked.push(seq);
      marker = Math.max(marker, seq);
      for (const l of [...listeners]) l();
      return { ok: true };
    },
    ...(mode === 'not-viewed' ? { viewedHead: () => false } : {}),
    resolveUsers: resolve,
  };
}
