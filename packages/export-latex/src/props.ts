/**
 * Resolved formatting to class setters (09 §3.1, Paragraph styles; EXP-013, EXP-020). The values
 * come from the model's cascade (`resolveParagraph`, `resolveRun`; 03 §6, ADR 0032): this module
 * computes nothing of its own, it only writes what the model resolved.
 *
 * `styles.tex` holds one macro per paragraph style, generated from a counter (`\DESa`, `\DESb`,
 * ...): the resolved properties of a paragraph of that style with no table style and no direct
 * attributes, every property written, so the `basedOn` chain is flattened. A paragraph then writes
 * its style's macro and, after it, only the properties whose resolved value differs: those the
 * table style, the numbering level or its direct attributes changed. The class applies setters in
 * order, so the paragraph ends with exactly the model's values (`cascade-fixtures.test.ts`).
 */
import {
  resolveParagraph,
  resolveRun,
  type CascadeResult,
  type ParagraphProperties,
  type ResolvedParagraph,
  type RunProperties,
  type TabStop,
} from '@docedit/model';
import {
  colourOf,
  diag,
  enumOf,
  warnOnce,
  type Ctx,
  type FamilyInfo,
  type J,
  type Mark,
} from './context.ts';
import { dimen, int, join, letters, lit, tex, ULENGTH_RANGE, type Tex } from './emit.ts';

const t = lit;

/** Alignment codes of the class: 0 justify, 1 start, 2 centre, 3 end. */
const ALIGN: Readonly<Record<string, Tex>> = {
  justify: t('0'),
  distribute: t('0'),
  start: t('1'),
  center: t('2'),
  end: t('3'),
};

/** Tab alignment and leader letters of `\DEdeftabs` (docedit.lua). */
const TAB_ALIGN: Readonly<Record<string, Tex>> = {
  left: t('l'),
  center: t('c'),
  right: t('r'),
  decimal: t('d'),
};
const TAB_LEADER: Readonly<Record<string, Tex>> = {
  none: t('n'),
  dot: t('d'),
  hyphen: t('h'),
  underscore: t('u'),
  middleDot: t('m'),
  heavy: t('t'),
};

/** Descent share of the line height when the manifest does not give it: Noto, 293 of 1362. */
const DEFAULT_DESCENT = 215;

/**
 * The key of a substitute line in the family map (FE-062): the name without case and extra spaces,
 * as Word and the editor compare family names, behind a prefix no family name has.
 */
export const substituteKey = (family: string): string =>
  `\u0000${family.trim().replace(/\s+/g, ' ').toLowerCase()}`;

export function familyOf(ctx: Ctx, name: string | null, blockId: string | null): FamilyInfo {
  if (name === null) return ctx.defaultFamily;
  const f = ctx.families.get(name) ?? ctx.families.get(substituteKey(name));
  if (f) return f;
  // A family the job may not load is named once, by the converter (`font_server_use_not_permitted`).
  if (ctx.screenOnlyFamilies.has(name)) return ctx.defaultFamily;
  diag(
    ctx,
    'warning',
    'font_family_missing',
    blockId,
    `the font family "${name.slice(0, 64)}" is not in the font manifest; the default family and the fallback chain are used`,
  );
  return ctx.defaultFamily;
}

/** A run's natural single-spaced height and its descent part, in twips (ADR 0032 §4). */
export function naturalHeight(f: FamilyInfo, size: number): { height: number; descent: number } {
  const lh = f.family.lineHeight;
  const ds = f.family.descent ?? DEFAULT_DESCENT;
  return {
    height: Math.floor((size * lh + 500) / 1000),
    descent: Math.floor((size * ds + 500) / 1000),
  };
}

export function shapeOf(r: Pick<RunProperties, 'italic' | 'smallCaps'>): Tex {
  return r.smallCaps ? (r.italic ? t('scit') : t('sc')) : r.italic ? t('it') : t('n');
}

/** The id of a tab list in styles.tex (`\DEdeftabs`), 0 for none. */
export function tabList(ctx: Ctx, tabs: readonly TabStop[]): number {
  if (tabs.length === 0) return 0;
  const parts = tabs.map(
    (s) =>
      tex`${int(Math.max(0, Math.min(31680, s.position)))}:${enumOf(ctx, TAB_ALIGN, s.align, t('l'), null, 'a tab alignment')}:${enumOf(ctx, TAB_LEADER, s.leader, t('n'), null, 'a tab leader')}`,
  );
  const spec = join(parts, t(';'));
  const known = ctx.tabLists.get(spec);
  if (known !== undefined) return known;
  const k = ctx.tabLists.size + 1;
  ctx.tabLists.set(spec, k);
  ctx.styleLines.push(tex`\DEdeftabs{${int(k)}}{${spec}}`);
  return k;
}

const BORDER_SIDES = [
  ['top', 't'],
  ['bottom', 'b'],
  ['left', 'l'],
  ['right', 'r'],
] as const;
/** Border style codes of the class: single, double, dotted, dashed, thick. */
const BORDER_STYLE: Readonly<Record<string, Tex>> = {
  single: t('s'),
  double: t('d'),
  dotted: t('o'),
  dashed: t('a'),
  thick: t('k'),
};

/**
 * The id of a paragraph border list in styles.tex (`\DEdefborders`), 0 for none (EXP-020
 * criterion 2). Width and space are in twips, as table borders are; a border without a width is 8
 * twips wide and one without a colour is black. Each paragraph is drawn on its own: the `between`
 * border is not drawn, and two bordered paragraphs in a row are not joined into one box (a
 * diagnostic says so when `between` is set).
 */
export function borderList(
  ctx: Ctx,
  borders: ParagraphProperties['borders'],
  blockId: string | null,
): number {
  if (borders === null) return 0;
  const sides = borders as Readonly<
    Record<string, { style?: string; width?: number; color?: string | null; space?: number } | null>
  >;
  const between = sides['between'];
  if (between && between.style !== undefined && between.style !== 'none')
    warnOnce(
      ctx,
      'paragraph_border_between',
      'the between border of a paragraph is not drawn; each paragraph has its own top and bottom border',
      blockId,
    );
  const parts: Tex[] = [];
  for (const [side, code] of BORDER_SIDES) {
    const b = sides[side];
    if (!b || b.style === undefined || b.style === 'none') continue;
    const style = enumOf(ctx, BORDER_STYLE, b.style, t('s'), blockId, 'a border style');
    const width = Math.max(1, Math.min(240, Math.trunc(b.width ?? 8)));
    const space = Math.max(0, Math.min(620, Math.trunc(b.space ?? 0)));
    const colour =
      colourOf(ctx, typeof b.color === 'string' ? b.color : null, blockId) ?? t('000000');
    parts.push(tex`${t(code)}:${style}:${int(width)}:${int(space)}:${colour}`);
  }
  if (parts.length === 0) return 0;
  const spec = join(parts, t(';'));
  const known = ctx.borderLists.get(spec);
  if (known !== undefined) return known;
  const k = ctx.borderLists.size + 1;
  ctx.borderLists.set(spec, k);
  ctx.styleLines.push(tex`\DEdefborders{${int(k)}}{${spec}}`);
  return k;
}

type Props = ParagraphProperties & RunProperties;

function flat(p: ResolvedParagraph): Props {
  return { ...p.properties, ...p.run };
}

/** Setters for every property of `p` that differs from `base` (all of them when `base` is null). */
export function setters(
  ctx: Ctx,
  p: ResolvedParagraph,
  base: ResolvedParagraph | null,
  blockId: string | null,
): Tex {
  const v = flat(p);
  const b = base ? flat(base) : null;
  const differs = <K extends keyof Props>(k: K): boolean =>
    b === null || JSON.stringify(v[k]) !== JSON.stringify(b[k]);
  const parts: Tex[] = [];
  const fam = familyOf(ctx, v.fontFamily, blockId);
  if (differs('fontFamily')) parts.push(tex`\DEfam{${int(fam.n)}}`);
  if (differs('fontSize')) parts.push(tex`\DEsz{${dimen(v.fontSize, { min: 20, max: 32760 })}}`);
  if (differs('fontFamily') || differs('fontSize')) {
    const h = naturalHeight(fam, v.fontSize);
    parts.push(tex`\DElh{${int(h.height)}}{${int(h.descent)}}`);
  }
  if (differs('bold')) parts.push(v.bold ? t('\\DEbf{1}') : t('\\DEbf{0}'));
  if (differs('italic')) parts.push(v.italic ? t('\\DEit{1}') : t('\\DEit{0}'));
  if (differs('smallCaps')) parts.push(v.smallCaps ? t('\\DEsc{1}') : t('\\DEsc{0}'));
  if (differs('color')) {
    const c = colourOf(ctx, v.color, blockId);
    parts.push(c ? tex`\DEcol{${c}}` : t('\\DEnocol'));
  }
  if (differs('lineRule') || differs('lineSpacing')) {
    const value = Math.max(1, Math.min(31680, Math.trunc(v.lineSpacing)));
    if (v.lineRule === 'exact') parts.push(tex`\DElse{${int(value)}}`);
    else if (v.lineRule === 'atLeast') parts.push(tex`\DElsa{${int(value)}}`);
    else parts.push(tex`\DElsm{${int(value)}}`);
  }
  if (differs('align')) {
    const a = enumOf(ctx, ALIGN, v.align, t('1'), blockId, 'an alignment');
    if (v.align === 'distribute')
      warnOnce(ctx, 'align_distribute', 'distributed alignment is set as justified', blockId);
    parts.push(tex`\DEal{${a}}`);
  }
  if (differs('indentLeft')) parts.push(tex`\DEil{${dimen(v.indentLeft)}}`);
  if (differs('indentRight')) parts.push(tex`\DEir{${dimen(v.indentRight)}}`);
  if (differs('indentFirstLine')) parts.push(tex`\DEif{${dimen(v.indentFirstLine)}}`);
  if (differs('widowControl')) parts.push(v.widowControl ? t('\\DEwc{1}') : t('\\DEwc{0}'));
  if (differs('keepLines')) parts.push(v.keepLines ? t('\\DEkl{1}') : t('\\DEkl{0}'));
  if (
    (v.align === 'justify' || v.align === 'distribute') &&
    v.tabs.some((s) => s.align === 'right' || s.align === 'decimal')
  )
    warnOnce(
      ctx,
      'tab_approximate',
      'a right or decimal tab in justified text is set approximately (EXP-032)',
      blockId,
    );
  if (differs('tabs')) parts.push(tex`\DEtabs{${int(tabList(ctx, v.tabs))}}`);
  if (differs('shading')) {
    const c = colourOf(ctx, v.shading?.fill, blockId);
    parts.push(c ? tex`\DEshade{${c}}` : t('\\DEnoshade'));
  }
  if (differs('borders')) {
    const k = borderList(ctx, v.borders, blockId);
    parts.push(k > 0 ? tex`\DEbord{${int(k)}}` : t('\\DEnobord'));
  }
  // The direction (EXP-037). A right-to-left paragraph, or a left-to-right one under a right-to-left
  // style, sets \DEdir; the document then asks for the bidirectional algorithm (\DEbidi).
  if (v.dir !== (b?.dir ?? 'ltr')) {
    if (v.dir === 'rtl') ctx.bidi.used = true;
    parts.push(v.dir === 'rtl' ? t('\\DEdir{1}') : t('\\DEdir{0}'));
  }
  return join(parts);
}

/**
 * The macro of a paragraph style, generated once. The converter calls it on first use and, at the
 * end, for every style the document defines (EXP-013 criterion 1).
 */
export function styleMacro(
  ctx: Ctx,
  styleId: string,
): { macro: Tex; base: ResolvedParagraph } | null {
  const r = resolveParagraph(ctx.table, { style: styleId });
  if (!r.ok) return null;
  let macro = ctx.styleMacros.get(styleId);
  if (!macro) {
    macro = tex`\DES${letters(ctx.styleMacros.size)}`;
    ctx.styleMacros.set(styleId, macro);
    ctx.styleLines.push(tex`\def${macro}{${setters(ctx, r.value, null, null)}}`);
  }
  return { macro, base: r.value };
}

export interface ParagraphFormat {
  readonly resolved: ResolvedParagraph;
  /** The style macro followed by the differing properties. */
  readonly tex: Tex;
}

/**
 * Resolves a paragraph through the model's cascade and writes its setters. A broken style chain
 * (I4, I5 normally prevent it) is reported, and the paragraph falls back to the default style.
 */
export function paragraphFormat(
  ctx: Ctx,
  attrs: Record<string, unknown> | undefined,
  tableStyle: string | null,
  blockId: string | null,
): ParagraphFormat {
  let r: CascadeResult<ResolvedParagraph> = resolveParagraph(ctx.table, attrs, { tableStyle });
  if (!r.ok) {
    diag(ctx, 'warning', r.error.code, blockId, `${r.error.message}; the default style is used`);
    r = resolveParagraph(ctx.table, { ...attrs, style: null }, { tableStyle: null });
  }
  if (!r.ok) r = resolveParagraph(ctx.table, {}, {});
  if (!r.ok) throw new Error('the default paragraph style cannot be resolved');
  const resolved = r.value;
  const s = styleMacro(ctx, resolved.styleId);
  if (!s) return { resolved, tex: setters(ctx, resolved, null, blockId) };
  return { resolved, tex: join([s.macro, setters(ctx, resolved, s.base, blockId)]) };
}

/** The run properties of a text node or an atom with marks. */
export function runProps(
  ctx: Ctx,
  p: ResolvedParagraph,
  marks: readonly Mark[] | undefined,
  blockId: string | null,
): RunProperties {
  const r = resolveRun(ctx.table, p, marks as never);
  if (r.ok) return r.value;
  diag(ctx, 'warning', r.error.code, blockId, `${r.error.message}; the character style is ignored`);
  const without = (marks ?? []).filter((m) => m.type !== 'charStyle');
  const again = resolveRun(ctx.table, p, without as never);
  return again.ok ? again.value : p.run;
}

/** The marks of a node, typed loosely. */
export const marksOf = (n: J): readonly Mark[] => n.marks ?? [];

export { ULENGTH_RANGE };
