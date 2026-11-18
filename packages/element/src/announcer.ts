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
 * Typing does change the save state, though: each commit makes it `saving` and then `saved` again.
 * With `settleMs` above zero a save-state change is announced only when the state has held for that
 * long and differs from the one last announced, so a run of keystrokes that ends where it began
 * says nothing, while a save that takes long, or a lost connection, is said once. The period is a
 * provisional default pending the accessibility specialist (ADR 0376). With zero, every change is
 * announced at once, in the order accepted.
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

/**
 * The English source text of each announcement. It is the fallback only: the sentences come from
 * the shell's catalogue (`announce.*` keys in ui `i18n/en-GB.ts`, through `AnnouncerOptions.translate`),
 * so that a locale and a host's replacement strings (UX-063, UX-064) apply to them. This table is
 * used when no catalogue is there yet (the shell has not mounted) and in tests without a shell.
 */
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

/** The catalogue key of each sentence (ui `i18n/en-GB.ts`). */
export const ANNOUNCE_KEYS: Readonly<Record<keyof AnnounceStrings, string>> = {
  saving: 'announce.sync.saving',
  saved: 'announce.sync.saved',
  unsaved: 'announce.sync.unsaved',
  readonly: 'announce.sync.readonly',
  rejected: 'announce.edit.rejected',
  arrived: 'announce.presence.arrived',
  left: 'announce.presence.left',
  unknownPerson: 'announce.presence.unknown',
  recovered: 'announce.recovered.count',
};

/** Looks a catalogue key up in the current locale; null when there is no catalogue. */
export type AnnounceTranslate = (
  key: string,
  params: Readonly<Record<string, string | number>>,
) => string | null;

/**
 * How long the element lets a save state hold before it is announced (milliseconds). A provisional
 * default, not a measured or specified figure: ADR 0376 asks the accessibility specialist to set it.
 */
export const DEFAULT_SETTLE_MS = 1000;

/** A timer pair, so that tests need no real time. */
export interface AnnounceTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const PAGE_TIMERS: AnnounceTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
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
  /**
   * How long a save state must hold before it is announced, in milliseconds. Zero (the default)
   * announces each change when it is accepted.
   */
  settleMs?: number;
  /** Timers for `settleMs`; the page's own by default. */
  timers?: AnnounceTimers;
  /** Fallback table; `ANNOUNCE_EN` when not given. */
  strings?: AnnounceStrings;
  /** The shell's catalogue, read each time a sentence is made, so a locale change applies at once. */
  translate?: AnnounceTranslate;
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
  readonly #translate: AnnounceTranslate | null;
  readonly #settleMs: number;
  readonly #timers: AnnounceTimers;
  #settling: unknown = null;
  readonly #queue: Slot[] = [];
  #lastSync: SyncState;
  #pumping = false;
  #closed = false;

  constructor(options: AnnouncerOptions) {
    this.#sink = options.sink;
    this.#schedule = options.schedule;
    this.#resolve = options.resolveUsers;
    this.#strings = options.strings ?? ANNOUNCE_EN;
    this.#translate = options.translate ?? null;
    const settle = options.settleMs ?? 0;
    this.#settleMs = Number.isFinite(settle) && settle > 0 ? settle : 0;
    this.#timers = options.timers ?? PAGE_TIMERS;
    this.#lastSync = options.initialSync;
  }

  /** Accepts one notice. Returns false when it was not queued (a repeat of the last save state, or nothing to say). */
  notify(notice: Notice): boolean {
    if (this.#closed) return false;
    switch (notice.kind) {
      case 'sync': {
        if (this.#settleMs > 0) return this.#settleSync(notice.sync);
        if (notice.sync === this.#lastSync) return false;
        this.#lastSync = notice.sync;
        this.#push(this.#say(notice.sync));
        return true;
      }
      case 'rejected':
        this.#push(this.#say('rejected', { where: notice.where, reason: notice.reason }));
        return true;
      case 'recovered': {
        if (!Number.isInteger(notice.count) || notice.count <= 0) return false;
        this.#push(this.#say('recovered', { count: notice.count }));
        return true;
      }
      case 'presence': {
        const slot = this.#enqueue();
        const field = notice.change;
        void this.#nameOf(notice.userId).then((name) => {
          if (this.#closed) return;
          slot.text = this.#say(field, { name });
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
    this.#stopSettling();
    this.#queue.length = 0;
  }

  /**
   * A save state waits `settleMs`, and each change of state starts the wait again. When it ends,
   * the state is announced unless it is the one last announced. True when a sentence may follow.
   */
  #settleSync(state: SyncState): boolean {
    this.#stopSettling();
    if (state === this.#lastSync) return false;
    this.#settling = this.#timers.set(() => {
      this.#settling = null;
      if (this.#closed || state === this.#lastSync) return;
      this.#lastSync = state;
      this.#push(this.#say(state));
    }, this.#settleMs);
    return true;
  }

  #stopSettling(): void {
    if (this.#settling === null) return;
    this.#timers.clear(this.#settling);
    this.#settling = null;
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

  /** One sentence, from the catalogue when there is one, else from the fallback table. */
  #say(
    field: keyof AnnounceStrings,
    params: Readonly<Record<string, string | number>> = {},
  ): string {
    const translated = this.#translate?.(ANNOUNCE_KEYS[field], params) ?? null;
    return translated ?? format(this.#strings[field], params);
  }

  async #nameOf(userId: string): Promise<string> {
    if (this.#resolve === null) return this.#say('unknownPerson');
    try {
      const [user] = await this.#resolve([userId]);
      return user?.name ?? this.#say('unknownPerson');
    } catch {
      return this.#say('unknownPerson');
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
