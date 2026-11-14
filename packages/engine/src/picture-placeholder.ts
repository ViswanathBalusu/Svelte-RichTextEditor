/**
 * The placeholder that shows where a pasted picture will go while its upload runs (FE-053 criterion 3).
 *
 * A placeholder is a position, not a document node: it changes no content and creates no commit. The
 * core adds one for each picture when the paste starts, maps it through later changes, and removes it
 * when that picture's upload has finished, whether it succeeded or failed. The shell says why an upload
 * failed; the engine returns the reason and the message (see image-paste.ts).
 *
 * This module holds only the state, so that the headless core reaches no view module (FE-121). The web
 * view draws each pending placeholder as a widget (view/picture-placeholder-view.ts).
 */
import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';

/** The class of the placeholder element, which the shell may style. */
export const PLACEHOLDER_CLASS = 'de-picture-placeholder';

/** The text the placeholder shows. */
export const PLACEHOLDER_TEXT = 'Uploading picture';

export const picturePlaceholderKey = new PluginKey<PlaceholderState>('de-picture-placeholder');

/** A change to the placeholders, sent as transaction metadata. */
export type PlaceholderMeta =
  | { readonly kind: 'add'; readonly id: number; readonly pos: number }
  | { readonly kind: 'remove'; readonly id: number };

export interface PlaceholderState {
  /** The positions of the placeholders still shown, by their id. A new map after every change. */
  readonly pending: ReadonlyMap<number, number>;
}

let nextId = 1;

/** A new placeholder identifier, unique within this process. */
export function newPlaceholderId(): number {
  return nextId++;
}

/** The transaction metadata that shows a placeholder at a position. */
export function addPlaceholder(tr: Transaction, id: number, pos: number): Transaction {
  return tr.setMeta(picturePlaceholderKey, { kind: 'add', id, pos } satisfies PlaceholderMeta);
}

/** The transaction metadata that removes a placeholder. */
export function removePlaceholder(tr: Transaction, id: number): Transaction {
  return tr.setMeta(picturePlaceholderKey, { kind: 'remove', id } satisfies PlaceholderMeta);
}

/** The plugin that keeps the placeholders and maps them through changes. It draws nothing. */
export function picturePlaceholderPlugin(): Plugin<PlaceholderState> {
  return new Plugin<PlaceholderState>({
    key: picturePlaceholderKey,
    state: {
      init: () => ({ pending: new Map() }),
      apply(tr, value) {
        const meta = tr.getMeta(picturePlaceholderKey) as PlaceholderMeta | undefined;
        if (!tr.docChanged && meta === undefined) return value;
        const pending = new Map<number, number>();
        for (const [id, pos] of value.pending) pending.set(id, tr.mapping.map(pos));
        if (meta?.kind === 'add') pending.set(meta.id, meta.pos);
        if (meta?.kind === 'remove') pending.delete(meta.id);
        return { pending };
      },
    },
  });
}
