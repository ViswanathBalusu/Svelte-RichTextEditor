/**
 * The participants service, loaded when the roles pane first needs it (FRW-026; FE-002). The
 * service is about 200 lines of the first interactive chunk that most documents never use, so the
 * module is fetched on `prepare` or on the first subscription, and until then the views are empty.
 *
 * No DOM: this runs in Node.js tests against a stand-in port.
 */
import type { EditorCore } from '@docedit/engine';
import type { ParticipantItem } from '@docedit/ui';
import type { ParticipantsHandle, ParticipantsSource } from './participants.ts';

export function lazyParticipantsService(
  core: EditorCore,
  source: ParticipantsSource,
): ParticipantsHandle {
  let inner: ParticipantsHandle | null = null;
  let loading: Promise<ParticipantsHandle> | null = null;
  let disposed = false;

  const load = (): Promise<ParticipantsHandle> =>
    (loading ??= import('./participants.ts').then((m) => {
      const made = m.participantsService(core, source);
      if (disposed) made.dispose();
      inner = made;
      return made;
    }));

  type View<T> = { get(): T; subscribe(listener: () => void): () => void };
  const view = <T>(pick: (service: ParticipantsHandle) => View<T>, empty: T): View<T> => ({
    get: () => (inner ? pick(inner).get() : empty),
    subscribe(listener) {
      let off: (() => void) | undefined;
      let gone = false;
      void load().then((service) => {
        if (gone) return;
        off = pick(service).subscribe(listener);
        listener();
      });
      return () => {
        gone = true;
        off?.();
      };
    },
  });

  return {
    prepare: async () => {
      await (await load()).prepare?.();
    },
    participants: view((s) => s.participants, [] as readonly ParticipantItem[]),
    state: view((s) => s.state, null as string | null),
    canEdit: view((s) => s.canEdit, false),
    save: async (input) => (await load()).save(input),
    remove: async (id) => (await load()).remove(id),
    dispose() {
      disposed = true;
      inner?.dispose();
    },
  };
}
