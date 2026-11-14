/**
 * Screen-reader announcements for the editing surface (02 §10; FE-107).
 *
 * The announcer turns four kinds of notice into sentences and queues them for a live region:
 *
 * - a save state, announced once per change (`saving`, `saved`, `unsaved`, `readonly`); a repeat of
 *   the state last announced is not announced again;
 * - an edit that was not applied, with where it happened and the reason the protocol gives;
 * - a collaborator arriving or leaving, named through `resolveUsers` (UX-025);
 * - recovered edits, with their count (`de-recovered-edits`).
 *
 * Keystrokes are not a notice kind, so typing has no path into the announcer (FE-107 criterion 7).
 * Whether a save-state change that follows every few keystrokes is worth a sentence is an
 * accessibility decision (FE-107 Notes); this module only guarantees that it announces what it is
 * given, once and in order.
 *
 * Nothing is dropped: the queue holds every accepted announcement until the sink has taken it, and
 * one announcement is handed to the sink per scheduled turn, so a burst is spread out instead of
 * overwriting the live region's text. The module has no DOM. The live region, the scheduler and
 * the sink are injected, so the logic runs in Node.js tests.
 */
import type { ResolveUsers } from '@docedit/protocol';
import type { SyncState } from './events.ts';
import { format } from './strings.ts';
import type { Scheduler } from './status.ts';

/** Interface strings for announcements, one table per locale (13 §8; UX-064 will feed it). */
export interface AnnounceStrings {
  saving: string;
  saved: string;
  unsaved: string;
  readonly: string;
  /** `{where}` is where the edit was refused; `{reason}` is the protocol's reason. */
  rejected: string;
  /** `{name}` is the resolved name. */
  arrived: string;
  left: string;
  /** Used when `resolveUsers` does not know the identifier, or is not set. */
  unknownPerson: string;
  /** `{count}` is the number of recovered pieces. */
  recovered: string;
}

export const ANNOUNCE_EN: AnnounceStrings = {
  saving: 'Saving changes.',
  saved: 'All changes saved.',
  unsaved: 'Changes are not saved yet.',
  readonly: 'This document is read-only.',
  rejected: 'An edit was not applied at {where}. {reason}',
  arrived: '{name} joined the document.',
  left: '{name} left the document.',
  unknownPerson: 'A collaborator',
  recovered: 'Edits set aside for recovery: {count}.',
};

export type Notice =
  | { kind: 'sync'; sync: SyncState }
  | { kind: 'rejected'; where: string; reason: string }
  | { kind: 'presence'; change: 'arrived' | 'left'; userId: string }
  | { kind: 'recovered'; count: number };

export interface AnnouncerOptions {
  /** Receives each sentence once, in the order it was accepted. */
  sink: (text: string) => void;
  /** Runs the next delivery; the default in the page is the animation frame (see status.ts). */
  schedule: Scheduler;
  /** Resolves presence identifiers to names (UX-025). Null means the names are unknown. */
  resolveUsers: ResolveUsers | null;
  /** The save state the document is in when it opens; it is not announced. */
  initialSync: SyncState;
  strings?: AnnounceStrings;
}

interface Slot {
  /** Null until the sentence is ready (a presence name may still be on its way). */
  text: string | null;
}

export class Announcer {
  readonly #sink: (text: string) => void;
  readonly #schedule: Scheduler;
  readonly #resolve: ResolveUsers | null;
  readonly #strings: AnnounceStrings;
  readonly #queue: Slot[] = [];
  #lastSync: SyncState;
  #pumping = false;
  #closed = false;

  constructor(options: AnnouncerOptions) {
    this.#sink = options.sink;
    this.#schedule = options.schedule;
    this.#resolve = options.resolveUsers;
    this.#strings = options.strings ?? ANNOUNCE_EN;
    this.#lastSync = options.initialSync;
  }

  /** Accepts one notice. Returns false when it was not queued (a repeat of the last save state, or nothing to say). */
  notify(notice: Notice): boolean {
    if (this.#closed) return false;
    switch (notice.kind) {
      case 'sync': {
        if (notice.sync === this.#lastSync) return false;
        this.#lastSync = notice.sync;
        this.#push(this.#strings[notice.sync]);
        return true;
      }
      case 'rejected':
        this.#push(format(this.#strings.rejected, { where: notice.where, reason: notice.reason }));
        return true;
      case 'recovered': {
        if (!Number.isInteger(notice.count) || notice.count <= 0) return false;
        this.#push(format(this.#strings.recovered, { count: notice.count }));
        return true;
      }
      case 'presence': {
        const slot = this.#enqueue();
        const template = notice.change === 'arrived' ? this.#strings.arrived : this.#strings.left;
        void this.#nameOf(notice.userId).then((name) => {
          if (this.#closed) return;
          slot.text = format(template, { name });
          this.#kick();
        });
        return true;
      }
    }
  }

  /** The sentences accepted and not yet handed to the sink. */
  get pending(): number {
    return this.#queue.length;
  }

  /** Stops the announcer. Sentences still queued are not delivered. */
  close(): void {
    this.#closed = true;
    this.#queue.length = 0;
  }

  #push(text: string): void {
    this.#enqueue().text = text;
    this.#kick();
  }

  #enqueue(): Slot {
    const slot: Slot = { text: null };
    this.#queue.push(slot);
    return slot;
  }

  async #nameOf(userId: string): Promise<string> {
    if (this.#resolve === null) return this.#strings.unknownPerson;
    try {
      const [user] = await this.#resolve([userId]);
      return user?.name ?? this.#strings.unknownPerson;
    } catch {
      return this.#strings.unknownPerson;
    }
  }

  #kick(): void {
    if (this.#pumping || this.#closed) return;
    this.#pumping = true;
    this.#schedule(this.#pump);
  }

  #pump = (): void => {
    this.#pumping = false;
    if (this.#closed) return;
    const head = this.#queue[0];
    if (head === undefined) return;
    // A presence name still on its way holds back what follows it, so the order is kept.
    if (head.text === null) return;
    this.#queue.shift();
    this.#sink(head.text);
    if (this.#queue.length > 0) this.#kick();
  };
}
