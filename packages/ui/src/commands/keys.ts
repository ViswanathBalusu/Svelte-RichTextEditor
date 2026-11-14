/**
 * Shortcuts in the registry's notation, the one of prosemirror-keymap (`Mod-b`, `Shift-Mod-z`,
 * `Ctrl-F6`, `Shift-F10`): modifiers joined by `-`, then the key. `Mod` is the platform's primary
 * modifier: Meta on Apple platforms, Control elsewhere (UX-013 notes).
 *
 * - `ariaShortcut` writes a shortcut as `aria-keyshortcuts` wants it (WAI-ARIA 1.2);
 * - `canonicalKey` resolves `Mod` and orders the modifiers, so that two spellings of one shortcut
 *   compare equal (collisions, UX-013 criterion 5);
 * - `eventKey` names a key event in the same canonical form, so a binding is found by lookup.
 */

const MODIFIERS: Readonly<Record<string, string>> = {
  Shift: 'Shift',
  Alt: 'Alt',
  Ctrl: 'Control',
  Control: 'Control',
  Meta: 'Meta',
  Cmd: 'Meta',
};

/** True on Apple platforms, where `Mod` means Meta. */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  const platform = data?.platform ?? navigator.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** One shortcut in `aria-keyshortcuts` form, for example `Mod-b` to `Control+B`. */
export function ariaShortcut(key: string, apple: boolean): string {
  const parts = key.split('-').filter(Boolean);
  const last = parts.pop() ?? '';
  const mods = parts.map((p) => (p === 'Mod' ? (apple ? 'Meta' : 'Control') : (MODIFIERS[p] ?? p)));
  const order = ['Control', 'Alt', 'Shift', 'Meta'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const name = last.length === 1 ? last.toUpperCase() : last;
  return [...mods, name].join('+');
}

/** The `aria-keyshortcuts` attribute for an entry's keys, or undefined when it has none. */
export function ariaShortcuts(
  keys: readonly string[] | undefined,
  apple: boolean,
): string | undefined {
  if (!keys || keys.length === 0) return undefined;
  return keys.map((k) => ariaShortcut(k, apple)).join(' ');
}

const ORDER = ['Alt', 'Ctrl', 'Meta', 'Shift'] as const;

/**
 * A shortcut in canonical form for one platform: `Mod` resolved, modifiers in a fixed order, a
 * letter in lower case (`Shift-Mod-Z` and `Mod-Shift-z` are both `Ctrl-Shift-z` off Apple). Null
 * for something that is not a shortcut.
 */
export function canonicalKey(key: string, apple: boolean): string | null {
  if (typeof key !== 'string' || key.length === 0) return null;
  // A trailing "-" is the minus key itself ("Mod--").
  const minus = key.endsWith('--');
  const parts = (minus ? key.slice(0, -2) : key).split('-').filter(Boolean);
  const last = minus ? '-' : parts.pop();
  if (!last) return null;
  const mods = new Set<string>();
  for (const p of parts) {
    const m =
      p === 'Mod' ? (apple ? 'Meta' : 'Ctrl') : p === 'Control' ? 'Ctrl' : p === 'Cmd' ? 'Meta' : p;
    if (!(ORDER as readonly string[]).includes(m)) return null;
    mods.add(m);
  }
  const name = last.length === 1 ? last.toLowerCase() : last;
  return [...ORDER.filter((m) => mods.has(m)), name].join('-');
}

/**
 * The canonical name of a key event, or null for a lone modifier or a key in composition. A
 * non-Latin layout reports another `key` for a letter; then the physical key (`code`) names it, as
 * prosemirror-keymap does with `keyCode`.
 */
export function eventKey(event: KeyboardEvent): string | null {
  if (event.isComposing || event.keyCode === 229) return null;
  let key = event.key;
  if (!key || ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock'].includes(key))
    return null;
  if (key.length === 1) {
    key = key.toLowerCase();
    // With Alt (Option on Apple platforms) a letter key often produces another character.
    const m = /^Key([A-Z])$/.exec(event.code);
    if (m && (!/^[a-z]$/.test(key) || event.altKey)) key = m[1]!.toLowerCase();
    const d = /^Digit([0-9])$/.exec(event.code);
    if (d && event.shiftKey && !/^[0-9]$/.test(key)) key = d[1]!;
  }
  if (key === ' ') key = 'Space';
  const mods: string[] = [];
  if (event.altKey) mods.push('Alt');
  if (event.ctrlKey) mods.push('Ctrl');
  if (event.metaKey) mods.push('Meta');
  if (event.shiftKey) mods.push('Shift');
  return [...mods, key].join('-');
}
