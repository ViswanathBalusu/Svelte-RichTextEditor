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
}

/** What the journal holds for one document. */
export interface JournalContents {
  /** Unconfirmed commits, oldest first (by identifier). */
  readonly commits: readonly JournalEntry[];
  /** Local steps not yet sent. */
  readonly queue: readonly StepJson[];
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
  /** Replaces the queue of unsent steps for a document. */
  setQueue(docId: string, steps: readonly StepJson[]): Promise<void>;
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
    async setQueue(docId, steps) {
      if (steps.length === 0) queues.delete(docId);
      else queues.set(docId, structuredCloneSteps(steps));
    },
    async read(docId) {
      const mine = [...commits.values()]
        .filter((e) => e.docId === docId)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return {
        commits: mine.map(structuredCloneEntry),
        queue: structuredCloneSteps(queues.get(docId) ?? []),
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
