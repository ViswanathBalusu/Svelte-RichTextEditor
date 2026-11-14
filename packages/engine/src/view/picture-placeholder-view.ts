/**
 * Draws the picture placeholders of the core (FE-053 criterion 3, the view's half). The core keeps the
 * pending placeholders and their positions (../picture-placeholder.ts); this plugin, registered only by
 * the web view, turns each one into a widget. Kept out of the core so that the headless entry reaches
 * no `prosemirror-view` and builds no DOM (FE-121).
 */
import { type EditorState, Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import {
  PLACEHOLDER_CLASS,
  PLACEHOLDER_TEXT,
  picturePlaceholderKey,
} from '../picture-placeholder.ts';

interface Drawn {
  /** The core's pending map these decorations were built from. */
  readonly from: ReadonlyMap<number, number> | null;
  readonly decorations: DecorationSet;
}

const drawnKey = new PluginKey<Drawn>('de-picture-placeholder-view');

function widgetFor(id: number, pos: number): Decoration {
  return Decoration.widget(
    pos,
    () => {
      const span = document.createElement('span');
      span.className = PLACEHOLDER_CLASS;
      span.setAttribute('data-placeholder-id', String(id));
      span.textContent = PLACEHOLDER_TEXT;
      return span;
    },
    { side: -1, key: `${PLACEHOLDER_CLASS}-${id}` },
  );
}

function draw(state: EditorState, previous: Drawn | null): Drawn {
  const pending = picturePlaceholderKey.getState(state)?.pending ?? null;
  // The core makes a new map on every change, so the same map means nothing to redraw.
  if (previous && previous.from === pending) return previous;
  if (!pending || pending.size === 0) return { from: pending, decorations: DecorationSet.empty };
  return {
    from: pending,
    decorations: DecorationSet.create(
      state.doc,
      [...pending].map(([id, pos]) => widgetFor(id, pos)),
    ),
  };
}

/** The plugin that draws the core's pending picture placeholders as widgets. */
export function picturePlaceholderView(): Plugin<Drawn> {
  return new Plugin<Drawn>({
    key: drawnKey,
    state: {
      init: (_config, state) => draw(state, null),
      apply: (_tr, value, _old, state) => draw(state, value),
    },
    props: {
      decorations(state) {
        return drawnKey.getState(state)?.decorations ?? DecorationSet.empty;
      },
    },
  });
}
