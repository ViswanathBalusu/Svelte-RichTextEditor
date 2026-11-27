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
  /**
   * True when the drawing carries a direction (an arrow, a speech bubble's tail, indented lines) and
   * is flipped in a right-to-left interface (UX-065; 13 section 8). Absent or false: never flipped.
   */
  readonly mirrorInRtl?: boolean;
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
  const mirror = record['mirrorInRtl'];
  if (mirror !== undefined && typeof mirror !== 'boolean') return null;
  return {
    paths: [...(paths as string[])],
    ...(viewBox !== undefined ? { viewBox: (viewBox as string).trim() } : {}),
    ...(fill === true ? { fill: true } : {}),
    ...(mirror === true ? { mirrorInRtl: true } : {}),
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
  undo: { paths: ['M9 14L4 9l5-5', 'M4 9h10a6 6 0 0 1 0 12h-3'], mirrorInRtl: true },
  redo: { paths: ['M15 14l5-5-5-5', 'M20 9H10a6 6 0 0 0 0 12h3'], mirrorInRtl: true },
  'select-all': { paths: ['M4 4h16v16H4z', 'M8 12l3 3 5-6'] },
  bold: { paths: ['M7 5h6a3.5 3.5 0 0 1 0 7H7z', 'M7 12h7a3.5 3.5 0 0 1 0 7H7z'] },
  italic: { paths: ['M19 4h-9', 'M14 20H5', 'M15 4L9 20'] },
  find: { paths: find, mirrorInRtl: true },
  'zoom-in': { paths: [...find, 'M8 11h6', 'M11 8v6'], mirrorInRtl: true },
  'zoom-out': { paths: [...find, 'M8 11h6'], mirrorInRtl: true },
  close: { paths: ['M6 6l12 12', 'M18 6L6 18'] },
  comment: { paths: [bubble], mirrorInRtl: true },
  comments: { paths: [bubble, 'M8 9h8', 'M8 13h5'], mirrorInRtl: true },
  print: {
    paths: [
      'M6 9V3h12v6',
      'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2',
      'M6 14h12v7H6z',
    ],
  },
  share: { paths: ['M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7', 'M16 6l-4-4-4 4', 'M12 2v13'] },
  export: { paths: ['M12 3v12', 'M8 11l4 4 4-4', 'M5 21h14'] },
  checklist: { paths: ['M4 6l2 2 3-3', 'M4 15l2 2 3-3', 'M13 7h8', 'M13 16h8'], mirrorInRtl: true },
  insert: { paths: ['M12 5v14', 'M5 12h14'] },
  discard: { paths: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'] },
  outline: { paths: ['M4 6h16', 'M8 12h12', 'M12 18h8'], mirrorInRtl: true },
  // A four-pointed star: text an assistant wrote (HIS-017). Always beside words, never alone.
  assistant: { paths: ['M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z'] },
};

const circle = 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0';
const frame = 'M4 6h16v12H4z';
const calendar = ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v4', 'M16 3v4'] as const;

/**
 * Drawings for the ribbon layout (`toolbar="ribbon"`, ADR 0490), which shows an icon over every
 * label, whether or not the host gave an icon set. They are used only there, and only for a name the
 * host's set and `BUILT_IN_ICONS` lack, so no other layout changes. Drawn on the same 24 by 24 grid
 * as the built-in set, as outlines. They are this product's own and imitate no vendor's drawings.
 */
export const RIBBON_ICONS: Readonly<Record<string, IconDrawing>> = {
  footnote: {
    paths: ['M4 7h7', 'M4 12h12', 'M4 20h10', 'M18 3v6', 'M15.5 4.5l5 3', 'M20.5 4.5l-5 3'],
  },
  header: { paths: ['M4 4h16v16H4z', 'M4 9h16'] },
  footer: { paths: ['M4 4h16v16H4z', 'M4 15h16'] },
  style: { paths: ['M5 19l7-14 7 14', 'M8 14h8'] },
  styles: { paths: ['M5 18l7-13 7 13', 'M8 13h8', 'M3 21h18'] },
  'next-region': { paths: ['M4 6h9v12H4z', 'M16 12h5', 'M18 9l3 3-3 3'], mirrorInRtl: true },
  painter: { paths: ['M4 4h12v5H4z', 'M10 9v4', 'M7 13h6v8H7z'] },
  language: { paths: [circle, 'M3 12h18', 'M12 3c3 3 3 15 0 18', 'M12 3c-3 3-3 15 0 18'] },
  region: { paths: ['M6 11h12v9H6z', 'M8 11V8a4 4 0 0 1 8 0v3'] },
  permissions: { paths: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'] },
  'zoom-reset': { paths: [...find, 'M9 9h4v4H9z'], mirrorInRtl: true },
  recovered: { paths: ['M4 12a8 8 0 1 0 3-6.2', 'M4 4v4h4', 'M12 8v5l3 2'] },
  keyboard: { paths: ['M3 7h18v10H3z', 'M7 11h.01', 'M11 11h.01', 'M15 11h.01', 'M7 14h10'] },
  'catch-up': { paths: ['M18 9a6 6 0 0 0-12 0c0 6-3 8-3 8h18s-3-2-3-8', 'M10 21h4'] },
  review: { paths: ['M4 4h16v13H9l-5 4z', 'M8 9l2 2 4-4'], mirrorInRtl: true },
  table: { paths: ['M3 5h18v14H3z', 'M3 10h18', 'M3 15h18', 'M9 5v14', 'M15 5v14'] },
  caption: { paths: ['M4 4h16v11H4z', 'M8 12l3-4 3 4', 'M5 19h14'] },
  'cross-reference': {
    paths: ['M10 14l4-4', 'M8 12l-2 2a3.5 3.5 0 0 0 5 5l2-2', 'M16 12l2-2a3.5 3.5 0 0 0-5-5l-2 2'],
  },
  citation: { paths: ['M5 8h5v5H5z', 'M5 13c0 3 1 4 3 5', 'M14 8h5v5h-5z', 'M14 13c0 3 1 4 3 5'] },
  paragraph: { paths: ['M10 4h8', 'M15 4v16', 'M11 4v16', 'M11 4a4.5 4.5 0 0 0 0 9'] },
  send: { paths: ['M21 3L10 14', 'M21 3l-7 18-4-7-7-4z'], mirrorInRtl: true },
  version: { paths: [circle, 'M12 7v5l3 2'] },
  'spell-next': {
    paths: ['M3 17l4-10 4 10', 'M4.5 14h5', 'M14 12h7', 'M18 9l3 3-3 3'],
    mirrorInRtl: true,
  },
  'spell-previous': {
    paths: ['M3 17l4-10 4 10', 'M4.5 14h5', 'M21 12h-7', 'M17 9l-3 3 3 3'],
    mirrorInRtl: true,
  },
  import: { paths: ['M12 3v12', 'M8 11l4 4 4-4', 'M5 21h14'] },
  'view-web': { paths: ['M3 5h18v14H3z', 'M3 9h18', 'M6 7h.01'] },
  'view-read': {
    paths: ['M12 6c-2-2-5-2-8-1v13c3-1 6-1 8 1', 'M12 6c2-2 5-2 8-1v13c-3-1-6-1-8 1'],
  },
  'view-print': { paths: ['M6 3h9l4 4v14H6z', 'M15 3v4h4'] },
  'field-text': { paths: [frame, 'M7 12h6'] },
  'field-number': { paths: [frame, 'M10 9l-1 6', 'M14 9l-1 6', 'M8 11h7', 'M8 13.5h7'] },
  'field-date': { paths: [...calendar] },
  'field-checkbox': { paths: ['M4 4h16v16H4z', 'M8 12l3 3 5-6'] },
  'field-choice': { paths: [frame, 'M14 11l2 2 2-2'] },
  'field-signature': { paths: ['M3 17c3 0 4-9 6-9s-3 9 0 9 3-5 5-5 1 5 3 5', 'M3 21h18'] },
  'field-initials': { paths: ['M4 4h16v16H4z', 'M8 15l2-6 2 6', 'M15 9v6'] },
  'field-dateSigned': { paths: [...calendar, 'M9 15l2 2 4-4'] },
  'field-formula': { paths: ['M17 5H7l6 7-6 7h10'] },
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
