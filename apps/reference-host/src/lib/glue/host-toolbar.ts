/**
 * An example toolbar that the host builds itself next to the built-in one (UX-005; UX-093
 * criterion 4; 05 §8.1; guide: "Your own toolbar"). It uses only the element's `queryCommand`,
 * `exec` and `de-command-state`, so every button follows the person's permissions exactly as the
 * built-in toolbar does. The element offers these with PRO-085; until then `attachHostToolbar`
 * reports that it is unsupported and builds nothing.
 */

/** Commands of the registry (UX-003) the example offers. */
export const HOST_TOOLBAR_COMMANDS = [
  { id: 'format.bold', label: 'Bold' },
  { id: 'format.italic', label: 'Italic' },
  { id: 'edit.undo', label: 'Undo' },
  { id: 'edit.redo', label: 'Redo' },
] as const;

export interface CommandState {
  enabled: boolean;
  active?: boolean;
}

/** One entry of `de-command-state` as the element raises it (05 §8.1). */
export interface CommandEntry {
  name: string;
  enabled?: boolean;
  active?: boolean;
}

/** The `de-command-state` detail: the changed commands, as entries or as identifiers. */
export interface StateDetail {
  commands?: ReadonlyArray<string | CommandEntry>;
}

export interface CommandHost extends HTMLElement {
  queryCommand?: (id: string) => CommandState | Promise<CommandState>;
  exec?: (id: string, args?: unknown) => unknown;
}

export function supportsHostToolbar(el: CommandHost): boolean {
  return typeof el.queryCommand === 'function' && typeof el.exec === 'function';
}

/**
 * Builds the buttons into `container` and keeps them current from `de-command-state`. Returns the
 * function that removes them, or null when the element does not offer the API yet.
 */
export function attachHostToolbar(el: CommandHost, container: HTMLElement): (() => void) | null {
  if (!supportsHostToolbar(el)) return null;
  const buttons = new Map<string, HTMLButtonElement>();
  for (const c of HOST_TOOLBAR_COMMANDS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = c.label;
    b.dataset['command'] = c.id;
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-disabled') === 'true') return;
      void el.exec!(c.id);
      el.focus();
    });
    container.append(b);
    buttons.set(c.id, b);
  }
  const refresh = async (ids: readonly string[]) => {
    for (const id of ids) {
      const b = buttons.get(id);
      if (!b) continue;
      const state = await el.queryCommand!(id);
      b.setAttribute('aria-disabled', state.enabled ? 'false' : 'true');
      if (state.active !== undefined) b.setAttribute('aria-pressed', String(state.active));
    }
  };
  // `de-command-state` lists the commands whose state changed (05 §8.1). The element sends
  // `{ commands: [{ name, enabled, active }] }` (packages/element/src/events.ts, CommandStateChange);
  // plain identifiers are accepted too.
  const onState = (e: Event) => {
    const detail = (e as CustomEvent<StateDetail | ReadonlyArray<string | CommandEntry>>).detail;
    const list = Array.isArray(detail) ? detail : (detail as StateDetail | undefined)?.commands;
    const ids = list
      ? list.map((c: string | CommandEntry) => (typeof c === 'string' ? c : c.name))
      : [...buttons.keys()];
    void refresh(ids);
  };
  // The element raises `de-command-state` for a change only, and the states it has when the document
  // is loaded are its baseline: nothing is raised for them. Before `de-ready` every command answers
  // disabled, so the buttons read all states again once the document is ready (UX-005 criterion 6).
  const onReady = () => void refresh([...buttons.keys()]);
  el.addEventListener('de-command-state', onState);
  el.addEventListener('de-ready', onReady);
  void refresh([...buttons.keys()]);
  return () => {
    el.removeEventListener('de-command-state', onState);
    el.removeEventListener('de-ready', onReady);
    for (const b of buttons.values()) b.remove();
  };
}
