/**
 * Work the journal kept from an earlier visit, put back on the next one (FE-009; 02 §2.2; 04 §8, §9).
 *
 * A commit that was sent and not confirmed is in the journal with the `base` it was made on. To send
 * it again under its own identifier, the client needs the document at that `base`: the host loads
 * the content pinned at `restoreBase(plan).seq` (`loadContent(docId, seq)`), opens the channel with a
 * resume at that `seq` naming the commit as in flight, and hands the plan to `attach`. The sync
 * client then does what it does after any reconnect (04 §9): the server's answer says `accepted`
 * (the stream carries the commit, which is its acknowledgement) or `unknown` (the commit is sent
 * again after `sync.caughtUp`), and the commits made meanwhile are rebased over. A log of another
 * incarnation answers `reload`, and the work goes to recovered edits (FE-010).
 *
 * The queue of unsent steps was made on the confirmed document plus the in-flight commit's steps. It
 * is put back only when no commit of anyone else was applied between (its `at.seq` is the commit's
 * `base`); otherwise its steps would land at positions that moved, so it goes to recovered edits.
 * A queue with no commit in front of it is put back on the document at its own `at.seq`. A queue
 * without `at` (written before FE-009) has no known document and goes to recovered edits.
 *
 * Only the oldest commit is restored. The client keeps one commit in flight (04 §8), so a second
 * entry can exist only when a removal after an acknowledgement failed; it stays in the journal.
 */
import type { StepJson } from '@docedit/authority';
import type { JournalEntry, JournalPort, QueueAt } from './journal.ts';

export interface RestorePlan {
  /** The oldest unconfirmed commit of the document, as it was sent; null when only a queue is left. */
  readonly entry: JournalEntry | null;
  /** The local steps that were not yet sent. */
  readonly queue: readonly StepJson[];
  /** The confirmed document the queue was made on, when the journal recorded it. */
  readonly queueAt: QueueAt | null;
  /** The commits behind the first that stay in the journal. */
  readonly others: number;
}

/**
 * What the journal holds for `docId` to put back, or null when it holds nothing unconfirmed or
 * cannot be read. A journal entry written for another document is never returned (criterion 6).
 */
export async function readRestorePlan(
  journal: JournalPort,
  docId: string,
): Promise<RestorePlan | null> {
  let held;
  try {
    held = await journal.read(docId);
  } catch {
    return null;
  }
  const mine = held.commits.filter((e) => e.docId === docId);
  if (mine.length === 0 && held.queue.length === 0) return null;
  return {
    entry: mine[0] ?? null,
    queue: held.queue,
    queueAt: held.queueAt ?? null,
    others: Math.max(0, mine.length - 1),
  };
}

/**
 * Removes the journal's unconfirmed work for `docId` when it was made by another signed-in user
 * (decision 47 of `docs/owner-decisions-2026-11-15.md`: unsent work is sent again only for the same
 * user, and otherwise discarded after a warning). The owner of the work is the user written with
 * its commit, or with its queue when no commit is left; work with no user written (a journal of
 * before this rule) is kept, since nothing says whose it is. Returns how many commits and whether
 * a queue were discarded; the caller gives the warning.
 */
export async function discardForeignWork(
  journal: JournalPort,
  docId: string,
  user: string,
): Promise<{ readonly commits: number; readonly queue: boolean }> {
  let held;
  try {
    held = await journal.read(docId);
  } catch {
    return { commits: 0, queue: false };
  }
  const foreign = (owner: string | undefined): boolean => owner !== undefined && owner !== user;
  const commits = held.commits.filter((e) => e.docId === docId && foreign(e.user));
  const queueForeign = held.queue.length > 0 && foreign(held.queueAt?.user);
  try {
    for (const entry of commits) await journal.remove(docId, entry.id);
    if (queueForeign) await journal.setQueue(docId, []);
  } catch {
    return { commits: 0, queue: false };
  }
  return { commits: commits.length, queue: queueForeign };
}

/**
 * The document the plan's work was made on: the `seq` to load the content at, and the incarnation to
 * resume with. Null when the journal does not say (a queue written before FE-009).
 */
export function restoreBase(
  plan: RestorePlan,
): { readonly seq: number; readonly incarnation: string | null } | null {
  if (plan.entry) return { seq: plan.entry.base, incarnation: plan.entry.incarnation ?? null };
  if (plan.queueAt) return { seq: plan.queueAt.seq, incarnation: plan.queueAt.incarnation };
  return null;
}
