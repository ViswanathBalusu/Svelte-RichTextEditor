/**
 * The reference host's sample extension (UX-050 criterion 6; UX-052; 13 section 7). It shows what a
 * tier 1 extension can add with the public API of `<doc-editor>`, and nothing else:
 *
 * - a command, `sample.insert-note`, that inserts a custom block (an `extension_block` with a JSON
 *   payload and a text fallback) in place of the selection, through the document API;
 * - a side panel, `sample-notes`, that lists the notes the extension has inserted in this session
 *   and is opened by a second command, `sample.open-notes`;
 * - a status-bar item with a text alternative.
 *
 * A tier 1 extension runs in the page with the host's trust (13 section 7.2): it is not sandboxed
 * and can read whatever the host page can read. This one reads nothing but the editor's API. The
 * command labels are string keys, so the host passes `SAMPLE_STRINGS` in the element's `strings`
 * property. The panel is plain DOM, held to the accessibility rules of the built-in panels: a
 * labelled landmark, a real list, a button with an accessible name, and colours from the public
 * `--de-` properties.
 *
 * The file imports nothing at run time, so the host page and the end-to-end suites use it as it is.
 */
import type { HostExtension, HostExtensionApi } from '@docedit/element';

/** The extension identifier, also the `extension` of the blocks it inserts. */
export const SAMPLE_EXTENSION_ID = 'sample.notes';

/** The panel identifier (lower case, letters, digits and hyphens). */
export const SAMPLE_PANEL_ID = 'sample-notes';

/** The strings of the sample's commands, panel and status item, for the `strings` property. */
export const SAMPLE_STRINGS: Readonly<Record<string, string>> = {
  'sample.insert-note': 'Insert sample note',
  'sample.open-notes': 'Open sample notes',
};

const STATUS_TEXT = 'Sample extension';
const STATUS_LABEL = 'The sample extension is active';

/** The text the block carries for readers without the extension (03 section 4.3: a fallback). */
export function noteFallback(n: number): string {
  return `Sample note ${n}`;
}

export const sampleExtension: HostExtension = {
  manifest: { id: SAMPLE_EXTENSION_ID, name: 'Sample notes', apiVersion: '1' },
  activate(api: HostExtensionApi): void {
    const notes: string[] = [];
    let list: HTMLUListElement | null = null;

    const draw = (): void => {
      if (!list) return;
      list.replaceChildren(
        ...notes.map((text) => {
          const item = document.createElement('li');
          item.textContent = text;
          return item;
        }),
      );
    };

    /** Inserts the next note in place of the selection; false when the document API refuses. */
    const insertNote = (): boolean => {
      const doc = api.document;
      if (!doc) return false;
      const at = doc.selection();
      try {
        const text = noteFallback(notes.length + 1);
        const result = doc.insertExtensionBlock(at, {
          extension: SAMPLE_EXTENSION_ID,
          payload: { note: text },
          fallbackText: text,
        });
        if (!result.ok) return false;
        notes.push(text);
        draw();
        return true;
      } finally {
        doc.release(at);
      }
    };

    api.registerCommand({
      id: 'sample.insert-note',
      label: 'sample.insert-note',
      group: 'insert',
      changesContent: true,
      capability: 'host-panels-and-commands',
      toolbar: false,
      run: insertNote,
    });
    api.registerCommand({
      id: 'sample.open-notes',
      label: 'sample.open-notes',
      group: 'view',
      changesContent: false,
      capability: 'host-panels-and-commands',
      toolbar: false,
      run: () => {
        void api.openPanel(SAMPLE_PANEL_ID);
        return true;
      },
    });

    api.registerPanel({
      id: SAMPLE_PANEL_ID,
      label: 'Sample notes',
      mount(container) {
        const region = document.createElement('section');
        region.setAttribute('aria-labelledby', 'sample-notes-heading');
        const heading = document.createElement('h3');
        heading.id = 'sample-notes-heading';
        heading.textContent = 'Notes inserted by the sample extension';
        const ul = document.createElement('ul');
        ul.setAttribute('aria-label', 'Inserted notes');
        const add = document.createElement('button');
        add.type = 'button';
        add.textContent = 'Insert a note';
        add.addEventListener('click', () => void insertNote());
        for (const part of [heading, ul, add]) region.append(part);
        container.append(region);
        list = ul;
        draw();
        return () => {
          list = null;
          region.remove();
        };
      },
    });

    api.addStatusItem({
      id: 'sample.status',
      position: 'end',
      text: STATUS_TEXT,
      label: STATUS_LABEL,
    });
  },
};
