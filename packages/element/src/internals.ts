/**
 * A view of an element's internals for the test and demo hooks (`src/testing.ts`). The published
 * module never reads it; it exists so that the element's public surface stays the embedding API
 * of 05 §8.1 while the spike and end-to-end suites can still inspect the lifecycle.
 */
import type { Announcer } from './announcer.ts';
import type { MountedEditor } from './editor.ts';
import type { Session } from './session.ts';

export interface InternalsView {
  readonly root: ShadowRoot;
  readonly session: Session | null;
  /** The mounted editor of the current session, if any. */
  readonly editor: MountedEditor | null;
  readonly suspended: boolean;
  /** Pending grace-period timer (a disconnected element without `keep-alive`). */
  readonly graceScheduled: boolean;
  /** The live region of the announcements (FE-107). */
  readonly liveRegion: HTMLElement;
  /** The current session's announcer, if a session started (FE-107). */
  readonly announcer: Announcer | null;
  /**
   * The shell's settings store, for the tests that set what has no attribute yet (UX-061: the
   * `pageTheme` option of ADR 0052, which a dark theme uses to darken the page canvas too).
   */
  readonly settings: { set(patch: Record<string, unknown>): void } | null;
}

export const INTERNALS = new WeakMap<object, () => InternalsView>();
