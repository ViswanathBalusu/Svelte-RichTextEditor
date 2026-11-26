/**
 * The document's classification label as a view the status bar can watch (UX-085 criterion 2;
 * PRO-048 criterion 2). The label is read from the metadata of `GET /documents/{id}` when the bar
 * first asks, and again at every `document.updated` of the document (owner decision 216). A
 * notice for another resource is ignored, and so is a field the answer carries that this build does
 * not know (PRO-005).
 *
 * A failed read keeps the last label; the bar shows what it had. An answer that arrives after a
 * newer one was asked for is dropped.
 */
import type { Notification, SyncPort, Unsubscribe } from '@docedit/protocol';
import type { ReadView } from './session.ts';

/** The shape of the shell's `ClassificationLabel` (`@docedit/ui` core API): the name, as written. */
interface ClassificationLabel {
  readonly name: string;
}

/** Where `document.updated` notices come from: the session's dispatcher offers this shape. */
export interface NoticeSource {
  on(type: string, handler: (notification: Notification) => void): Unsubscribe;
}

export function classificationView(
  document: NonNullable<SyncPort['document']>,
  docId: string,
  notices: NoticeSource,
): ReadView<ClassificationLabel | null> {
  let value: ClassificationLabel | null = null;
  let asked = 0;
  const listeners = new Set<() => void>();
  let stop: Unsubscribe | null = null;

  const read = (): void => {
    const mine = ++asked;
    document(docId).then(
      ({ value: resource }) => {
        if (mine !== asked) return;
        const name = typeof resource.classification === 'string' ? resource.classification : null;
        const next = name === null ? null : { name };
        if (next?.name === value?.name) return;
        value = next;
        for (const listener of [...listeners]) listener();
      },
      () => {},
    );
  };

  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        stop = notices.on('document.updated', (n) => {
          if (n.resource === `/documents/${docId}`) read();
        });
        read();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stop?.();
        stop = null;
      };
    },
  };
}
