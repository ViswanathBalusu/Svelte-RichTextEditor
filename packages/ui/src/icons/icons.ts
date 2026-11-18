/**
 * The icon set (UX-063; 13 §8). A command names its icon (`CommandEntry.icon`); the set maps that
 * name to a drawing. The host may replace any of them through the element's `icons` property; a
 * name the host leaves out, or gives an unusable drawing for, falls back to the built-in drawing,
 * and a name with no drawing at all shows no glyph (the label still names the control).
 *
 * Icons are shown when the host gives a set (any object, even an empty one, which asks for the
 * built-in drawings alone). Without a set the toolbars and menus show labels only, as the phase 1a
 * shell does, so a host that has not chosen icons keeps the compact look.
 *
 * A drawing is data, never markup. It is one or more SVG path strings and an optional view box, and
 * the shell draws them itself in an `<svg>` it makes. A host cannot put an element, a script or a
 * style into the shell through an icon. Icons are drawn as outlines (`stroke: currentColor`, no
 * fill) on a 24 by 24 grid, unless the host says `fill: true`, so they follow the text colour and
 * `forced-colors` (13 §8).
 */
import type { ReadView } from '../core-api.ts';

/** One drawing: path data and the grid it is drawn on. */
export interface IconDrawing {
  readonly paths: readonly string[];
  /** Four numbers, `min-x min-y width height`; `0 0 24 24` when absent. */
  readonly viewBox?: string;
  /** True for a drawing made of filled shapes; false or absent for outlines. */
  readonly fill?: boolean;
}

/** What a host may give for one name: path data, or a drawing. */
export type IconValue = string | IconDrawing;

/** Host replacements by icon name. */
export type IconOverrides = Readonly<Record<string, unknown>>;

export const DEFAULT_VIEW_BOX = '0 0 24 24';

/** The most characters of path data accepted for one icon, so a value cannot grow without bound. */
export const MAX_ICON_PATH_LENGTH = 4096;
/** The most paths one icon may have. */
export const MAX_ICON_PATHS = 16;

/** SVG path data uses only these characters (SVG 2, path grammar). */
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/;
const VIEW_BOX = /^-?\d+(\.\d+)?(\s+-?\d+(\.\d+)?){1}\s+\d+(\.\d+)?\s+\d+(\.\d+)?$/;

/**
 * The drawing a host value stands for, or null when it cannot be one: not path data, too long, or a
 * view box that is not four numbers with a positive size.
 */
export function parseIcon(value: unknown): IconDrawing | null {
  if (typeof value === 'string') return validPaths([value]) ? { paths: [value] } : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const paths = record['paths'];
  if (!Array.isArray(paths) || !validPaths(paths)) return null;
  const viewBox = record['viewBox'];
  if (viewBox !== undefined) {
    if (typeof viewBox !== 'string' || !VIEW_BOX.test(viewBox.trim())) return null;
    const size = viewBox.trim().split(/\s+/).map(Number);
    if (!((size[2] ?? 0) > 0 && (size[3] ?? 0) > 0)) return null;
  }
  const fill = record['fill'];
  if (fill !== undefined && typeof fill !== 'boolean') return null;
  return {
    paths: [...(paths as string[])],
    ...(viewBox !== undefined ? { viewBox: (viewBox as string).trim() } : {}),
    ...(fill === true ? { fill: true } : {}),
  };
}

function validPaths(paths: readonly unknown[]): boolean {
  if (paths.length === 0 || paths.length > MAX_ICON_PATHS) return false;
  return paths.every(
    (d) =>
      typeof d === 'string' &&
      d.trim().length > 0 &&
      d.length <= MAX_ICON_PATH_LENGTH &&
      PATH_DATA.test(d),
  );
}

const find = ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M21 21l-4.3-4.3'] as const;
const bubble = 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z';

/** The built-in drawings, by the names the built-in commands use. */
export const BUILT_IN_ICONS: Readonly<Record<string, IconDrawing>> = {
  undo: { paths: ['M9 14L4 9l5-5', 'M4 9h10a6 6 0 0 1 0 12h-3'] },
  redo: { paths: ['M15 14l5-5-5-5', 'M20 9H10a6 6 0 0 0 0 12h3'] },
  'select-all': { paths: ['M4 4h16v16H4z', 'M8 12l3 3 5-6'] },
  bold: { paths: ['M7 5h6a3.5 3.5 0 0 1 0 7H7z', 'M7 12h7a3.5 3.5 0 0 1 0 7H7z'] },
  italic: { paths: ['M19 4h-9', 'M14 20H5', 'M15 4L9 20'] },
  find: { paths: find },
  'zoom-in': { paths: [...find, 'M8 11h6', 'M11 8v6'] },
  'zoom-out': { paths: [...find, 'M8 11h6'] },
  close: { paths: ['M6 6l12 12', 'M18 6L6 18'] },
  comment: { paths: [bubble] },
  comments: { paths: [bubble, 'M8 9h8', 'M8 13h5'] },
  print: {
    paths: [
      'M6 9V3h12v6',
      'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2',
      'M6 14h12v7H6z',
    ],
  },
  share: { paths: ['M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7', 'M16 6l-4-4-4 4', 'M12 2v13'] },
  export: { paths: ['M12 3v12', 'M8 11l4 4 4-4', 'M5 21h14'] },
  checklist: { paths: ['M4 6l2 2 3-3', 'M4 15l2 2 3-3', 'M13 7h8', 'M13 16h8'] },
  insert: { paths: ['M12 5v14', 'M5 12h14'] },
  discard: { paths: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'] },
  outline: { paths: ['M4 6h16', 'M8 12h12', 'M12 18h8'] },
  // A four-pointed star: text an assistant wrote (HIS-017). Always beside words, never alone.
  assistant: { paths: ['M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z'] },
};

export interface IconsOptions {
  /** Host replacements by icon name. Absent or null: no icons are shown. */
  overrides?: IconOverrides | null;
  /** Names whose value is not a usable drawing; they fall back to the built-in one. */
  onInvalid?: (names: readonly string[]) => void;
}

/** The set in use: the host's drawings over the built-in ones. */
export interface IconSet {
  /** The drawing for a name, or null when icons are off or neither the host nor the built-in set has one. */
  resolve(name: string | undefined): IconDrawing | null;
}

class IconSetImpl implements IconSet {
  readonly #host: ReadonlyMap<string, IconDrawing> | null;

  /** host is null when icons are off. */
  constructor(host: ReadonlyMap<string, IconDrawing> | null) {
    this.#host = host;
  }

  resolve(name: string | undefined): IconDrawing | null {
    if (!name || !this.#host) return null;
    return (
      this.#host.get(name) ?? (Object.hasOwn(BUILT_IN_ICONS, name) ? BUILT_IN_ICONS[name]! : null)
    );
  }
}

/** The catalogue of icons, with a reactive view like the string catalogue's (UX-064). */
export class Icons {
  readonly #listeners = new Set<() => void>();
  readonly #options: IconsOptions;
  #current: IconSet;

  readonly view: ReadView<IconSet>;

  constructor(options: IconsOptions = {}) {
    this.#options = options;
    this.#current = this.#build(options.overrides);
    this.view = {
      get: () => this.#current,
      subscribe: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
    };
  }

  get current(): IconSet {
    return this.#current;
  }

  /** Replaces the host's drawings while the shell is mounted. */
  setOverrides(overrides: IconOverrides | null): void {
    this.#current = this.#build(overrides);
    for (const listener of [...this.#listeners]) listener();
  }

  #build(overrides: IconOverrides | null | undefined): IconSet {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      return new IconSetImpl(null);
    }
    const host = new Map<string, IconDrawing>();
    const invalid: string[] = [];
    for (const [name, value] of Object.entries(overrides)) {
      const drawing = parseIcon(value);
      if (drawing) host.set(name, drawing);
      else invalid.push(name);
    }
    if (invalid.length) this.#options.onInvalid?.(invalid);
    return new IconSetImpl(host);
  }
}

/** The built-in set alone, for code that runs before a catalogue exists. */
export function builtInIcons(): IconSet {
  return new IconSetImpl(new Map());
}

/** The set when the host gave none: no icons are shown. */
export function noIcons(): IconSet {
  return new IconSetImpl(null);
}
