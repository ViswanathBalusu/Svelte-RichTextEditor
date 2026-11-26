/**
 * The recovery journal (FE-008; 02 §2.2; 04 §8): the unconfirmed commits and the queue of unsent
 * steps are written to a store before they are sent, so that a closed or crashed tab loses no typed
 * work. The journal holds commits and steps only, never tokens (10 §3.1).
 *
 * This module holds the port the sync session writes through and an in-memory store for Node.js and
 * tests. The IndexedDB store the element uses lives beside the element (packages/element).
 *
 * Commit identifiers are UUID version 7 (04 §3.1), so sorting them by identifier gives the order in
 * which this client made them: that is the order a resubmission uses (FE-009).
 */
import type { StepJson } from '@docedit/authority';
import type { Discarded, OutgoingCommit } from './state.ts';

/** A commit as the journal keeps it: the document it belongs to, and the commit as it was sent. */
export interface JournalEntry extends OutgoingCommit {
  readonly docId: string;
  /**
   * The log incarnation `base` belongs to (04 §1). The next visit opens its channel with it, so that
   * a log that was rewound since answers `reload` and the work is set aside, not applied to another
   * history (FE-009). Absent in entries written before FE-009.
   */
  readonly incarnation?: string;
  /**
   * The signed-in user the commit was made by (`welcome.user.id`). The next visit sends it again
   * only for the same user (decision 47 of `docs/owner-decisions-2026-11-15.md`); an entry without
   * one was written before this field and is sent for anyone.
   */
  readonly user?: string;
  /**
   * The view token of the `ch.opened` the commit was made under (ADR 0019; D28): the reader's
   * visibility class. `null` when the channel had none. The next visit puts the commit back only when
   * its own view token is the same; work made under another projection goes to recovered edits
   * (FE-141 criterion 4). Absent in entries written before this field: the commit is put back.
   */
  readonly view?: string | null;
}

/** The confirmed document the queue of unsent steps was made on. */
export interface QueueAt {
  readonly seq: number;
  readonly incarnation: string;
  /** The signed-in user the queue was made by (see `JournalEntry.user`). */
  readonly user?: string;
  /** The view token the queue was made under (see `JournalEntry.view`). */
  readonly view?: string | null;
}

/** What the journal holds for one document. */
export interface JournalContents {
  /** Unconfirmed commits, oldest first (by identifier). */
  readonly commits: readonly JournalEntry[];
  /** Local steps not yet sent. */
  readonly queue: readonly StepJson[];
  /**
   * The confirmed `seq` and incarnation the queue was made on, when it was written with them
   * (FE-009): the queue's steps apply to that document plus the in-flight commit's steps.
   */
  readonly queueAt?: QueueAt;
}

/** The store the sync session writes through. Every method resolves once its write is durable. */
export interface JournalPort {
  /** Stores a commit under its identifier, before the commit is sent. */
  put(entry: JournalEntry): Promise<void>;
  /**
   * Removes a commit once the server has acknowledged or refused it, or it was set aside. Removing
   * an unknown identifier is a no-op.
   */
  remove(docId: string, id: string): Promise<void>;
  /**
   * Replaces the queue of unsent steps for a document. `at` is the confirmed document the steps
   * were made on; a port keeps it with them and gives it back from `read` (FE-009).
   */
  setQueue(docId: string, steps: readonly StepJson[], at?: QueueAt): Promise<void>;
  /** Reads what the document has unconfirmed. */
  read(docId: string): Promise<JournalContents>;
  /**
   * Replaces the recovered edits kept for a document (FE-010): work refused, dropped or set aside,
   * kept until the person deals with it. Optional: a port without it keeps them in memory only.
   */
  setRecovered?(docId: string, items: readonly Discarded[]): Promise<void>;
  /** Reads the recovered edits kept for a document (FE-010), oldest first. */
  readRecovered?(docId: string): Promise<readonly Discarded[]>;
}

/** An in-memory journal. It lives as long as the object does: Node.js and tests only. */
export function memoryJournal(): JournalPort & { readonly size: number } {
  const commits = new Map<string, JournalEntry>();
  const queues = new Map<string, readonly StepJson[]>();
  const queueAts = new Map<string, QueueAt>();
  const recovered = new Map<string, readonly Discarded[]>();
  const key = (docId: string, id: string) => `${docId}\u0000${id}`;
  return {
    get size() {
      return commits.size;
    },
    async setRecovered(docId, items) {
      if (items.length === 0) recovered.delete(docId);
      else recovered.set(docId, JSON.parse(JSON.stringify(items)) as Discarded[]);
    },
    async readRecovered(docId) {
      return JSON.parse(JSON.stringify(recovered.get(docId) ?? [])) as Discarded[];
    },
    async put(entry) {
      commits.set(key(entry.docId, entry.id), structuredCloneEntry(entry));
    },
    async remove(docId, id) {
      commits.delete(key(docId, id));
    },
    async setQueue(docId, steps, at) {
      if (steps.length === 0) {
        queues.delete(docId);
        queueAts.delete(docId);
      } else {
        queues.set(docId, structuredCloneSteps(steps));
        if (at)
          queueAts.set(docId, {
            seq: at.seq,
            incarnation: at.incarnation,
            ...(at.user === undefined ? {} : { user: at.user }),
            ...(at.view === undefined ? {} : { view: at.view }),
          });
        else queueAts.delete(docId);
      }
    },
    async read(docId) {
      const mine = [...commits.values()]
        .filter((e) => e.docId === docId)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const at = queueAts.get(docId);
      return {
        commits: mine.map(structuredCloneEntry),
        queue: structuredCloneSteps(queues.get(docId) ?? []),
        ...(at ? { queueAt: { ...at } } : {}),
      };
    },
  };
}

function structuredCloneEntry(e: JournalEntry): JournalEntry {
  return JSON.parse(JSON.stringify(e)) as JournalEntry;
}

function structuredCloneSteps(steps: readonly StepJson[]): StepJson[] {
  return JSON.parse(JSON.stringify(steps)) as StepJson[];
}
