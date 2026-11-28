/**
 * The icons of the ribbon layout (	oolbar="ribbon", ADR 0490). They load with the ribbon, not with
 * the first interactive editor, so no other layout pays for them (13 section 9).
 */
import type { CommandView } from '../commands/types.ts';
import type { IconDrawing } from './icons.ts';

const find = ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M21 21l-4.3-4.3'] as const;
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
  underline: { paths: ['M7 4v7a5 5 0 0 0 10 0V4', 'M5 20h14'] },
  strike: {
    paths: [
      'M4 12h16',
      'M16.5 7c-.7-1.8-2.3-3-4.5-3-2.6 0-4.2 1.4-4.2 3.2 0 1.2.6 2 2 2.8',
      'M8 17c.8 1.7 2.4 3 4.4 3 2.6 0 4.2-1.4 4.2-3.2 0-.8-.3-1.4-.8-1.8',
    ],
  },
  'clear-format': { paths: ['M5 5h11', 'M10.5 5L8 19', 'M14 14l6 6', 'M20 14l-6 6'] },
  'text-colour': { paths: ['M7 16l5-12 5 12', 'M8.8 12h6.4', 'M5 20h14'] },
  highlight: { paths: ['M5 15l8-8 4 4-8 8H5z', 'M13 7l2-2 4 4-2 2', 'M4 21h16'] },
  'align-start': {
    paths: ['M4 6h16', 'M4 10h10', 'M4 14h16', 'M4 18h10'],
    mirrorInRtl: true,
  },
  'align-center': { paths: ['M4 6h16', 'M7 10h10', 'M4 14h16', 'M7 18h10'] },
  'align-end': { paths: ['M4 6h16', 'M10 10h10', 'M4 14h16', 'M10 18h10'], mirrorInRtl: true },
  'align-justify': { paths: ['M4 6h16', 'M4 10h16', 'M4 14h16', 'M4 18h16'] },
  'list-bullet': {
    paths: ['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4 6h.01', 'M4 12h.01', 'M4 18h.01'],
    mirrorInRtl: true,
  },
  'list-number': {
    paths: ['M10 6h10', 'M10 12h10', 'M10 18h10', 'M4 5l1.5-1v5', 'M3.5 13.5h2.5l-2.5 3.5h2.7'],
    mirrorInRtl: true,
  },
  'indent-less': {
    paths: ['M4 5h16', 'M11 10h9', 'M11 14h9', 'M4 19h16', 'M8 9l-4 3 4 3'],
    mirrorInRtl: true,
  },
  'indent-more': {
    paths: ['M4 5h16', 'M11 10h9', 'M11 14h9', 'M4 19h16', 'M4 9l4 3-4 3'],
    mirrorInRtl: true,
  },
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

/**
 * The icon for a command that names none, so that every button of the ribbon has a drawing. A name
 * the command's entry gives wins; these are the built-in commands that give none.
 */
const ICON_BY_ID: ReadonlyArray<readonly [RegExp, string]> = [
  [/^table\./, 'table'],
  [/^insert\.caption$/, 'caption'],
  [/^insert\.crossReference$/, 'cross-reference'],
  [/^insert\.citation$/, 'citation'],
  [/^format\.paragraph$/, 'paragraph'],
  [/^format\.underline$/, 'underline'],
  [/^format\.strike$/, 'strike'],
  [/^format\.clear$/, 'clear-format'],
  [/^format\.color$/, 'text-colour'],
  [/^format\.highlight$/, 'highlight'],
  [/^format\.align\.start$/, 'align-start'],
  [/^format\.align\.center$/, 'align-center'],
  [/^format\.align\.end$/, 'align-end'],
  [/^format\.align\.justify$/, 'align-justify'],
  [/^format\.bulletList$/, 'list-bullet'],
  [/^format\.numberList$/, 'list-number'],
  [/^format\.indentLess$/, 'indent-less'],
  [/^format\.indentMore$/, 'indent-more'],
  [/^workflow\.send$/, 'send'],
  [/^history\.nameVersion$/, 'version'],
  [/^proofing\.next$/, 'spell-next'],
  [/^proofing\.previous$/, 'spell-previous'],
  [/^document\.import$/, 'import'],
];

export function ribbonIconName(command: CommandView): string | undefined {
  if (command.entry.icon) return command.entry.icon;
  for (const [pattern, name] of ICON_BY_ID) if (pattern.test(command.id)) return name;
  return undefined;
}
