/**
 * Page setups, page sections, headers and footers (03 §4.1, §4.2, §7; 09 §3.1; EXP-017, EXP-018).
 * Every page setup the document uses gets a number (`setups` of map.json, so that layout.json can
 * say which setup each page has) and one `\DEdefsetup` line; the class sets the page from it
 * directly at each section start, without `\newgeometry`, and measures the header and footer
 * stories to push the body away from them (ADR 0032 §6). Header and footer stories are macros
 * (`\DEdefstory`), typeset by the class's page styles on the pages that show them.
 */
import { pageGeometry } from '@docedit/model';
import {
  attr,
  diag,
  enumOf,
  idOf,
  num,
  register,
  str,
  within,
  line,
  type Ctx,
  type J,
} from './context.ts';
import { dimen, int, lit, tex, text, ULENGTH_RANGE, type Tex } from './emit.ts';
import { newFlow, type ContentWriter, type Flow } from './flow.ts';

const t = lit;

/** Page number formats of 03 §4.1 to the class's codes. */
const PAGE_NUMBER_FORMATS: Readonly<Record<string, Tex>> = {
  decimal: t('0'),
  lowerRoman: t('1'),
  upperRoman: t('2'),
  lowerLetter: t('3'),
  upperLetter: t('4'),
};

/** Where a section starts: 0 next page, 1 even page, 2 odd page, 3 continuous. */
const STARTS: Readonly<Record<string, Tex>> = {
  nextPage: t('0'),
  evenPage: t('1'),
  oddPage: t('2'),
  continuous: t('3'),
};

const GEOMETRY_KEYS = [
  'width',
  'height',
  'orientation',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'gutter',
  'headerDistance',
  'footerDistance',
] as const;

export function pageSetups(ctx: Ctx): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const defs = (ctx.doc.content ?? []).find((c) => c.type === 'defs');
  for (const d of defs?.content ?? [])
    if (d.type === 'page_setup' && typeof d.attrs?.['id'] === 'string')
      out.set(d.attrs['id'], d.attrs);
  return out;
}

/** The number of a page setup, registered on first use. */
export function setupIndex(ctx: Ctx, id: string): number {
  const k = ctx.setups.indexOf(id);
  if (k >= 0) return k;
  ctx.setups.push(id);
  return ctx.setups.length - 1;
}

const storyNumbers = new WeakMap<Ctx, Map<string, number>>();

function storyNumber(ctx: Ctx, id: unknown): number {
  if (typeof id !== 'string') return 0;
  let m = storyNumbers.get(ctx);
  if (!m) {
    m = new Map();
    storyNumbers.set(ctx, m);
  }
  const known = m.get(id);
  if (known !== undefined) return known;
  const s = m.size + 1;
  m.set(id, s);
  return s;
}

/** The lengths of a page setup, with the definition's defaults (CDM-002). */
function lengths(attrs: Record<string, unknown>): Record<string, number> {
  const g = pageGeometry(attrs);
  const n = (k: string, d: number): number => num(attrs[k]) ?? d;
  let width = g.width;
  let height = g.height;
  // `orientation` swaps the sides when the stored size is the other way round (03 §4.1).
  const landscape = str(attrs['orientation']) === 'landscape';
  if (landscape !== width > height) [width, height] = [height, width];
  return {
    width,
    height,
    marginTop: g.marginTop,
    marginBottom: g.marginBottom,
    marginLeft: n('marginLeft', 1440),
    marginRight: n('marginRight', 1440),
    gutter: n('gutter', 0),
    headerDistance: g.headerDistance,
    footerDistance: g.footerDistance,
    columns: Math.max(1, Math.min(16, n('columns', 1))),
    columnGap: n('columnGap', 720),
  };
}

/** `\DEdefsetup` for one page setup; every length through `dimen` (EXP-017 criterion 5). */
export function setupTex(ctx: Ctx, k: number, attrs: Record<string, unknown>): Tex {
  const l = lengths(attrs);
  const page = { min: 144, max: 31680 };
  const d = (v: number, r = ULENGTH_RANGE): Tex => dimen(v, r);
  const start = num(attrs['pageNumberStart']);
  const fmt = enumOf(
    ctx,
    PAGE_NUMBER_FORMATS,
    str(attrs['pageNumberFormat']) ?? 'decimal',
    t('0'),
    null,
    'a page number format',
  );
  const s = (name: string): Tex => int(storyNumber(ctx, attrs[name]));
  // Three macros, because a TeX macro takes at most nine arguments.
  return tex`\DEdefsetup{${int(k)}}{${d(l['width']!, page)}}{${d(l['height']!, page)}}{${d(l['marginTop']!)}}{${d(l['marginRight']!)}}{${d(l['marginBottom']!)}}{${d(l['marginLeft']!)}}{${d(l['gutter']!)}}{${d(l['headerDistance']!)}}
\DEdefsetupb{${int(k)}}{${d(l['footerDistance']!)}}{${int(l['columns']!)}}{${d(l['columnGap']!)}}{${attrs['differentFirstPage'] === true ? t('1') : t('0')}}{${attrs['differentOddEven'] === true ? t('1') : t('0')}}{${int(start === null ? -1 : Math.max(0, Math.min(32767, start)))}}{${fmt}}
\DEdefsetupc{${int(k)}}{${s('headerDefault')}}{${s('headerFirst')}}{${s('headerEven')}}{${s('footerDefault')}}{${s('footerFirst')}}{${s('footerEven')}}
\DEdefwatermark{${int(k)}}{${text(str(attrs['watermark']) ?? '')}}`;
}

/** The stories the used page setups name, as `\DEdefstory` macros. */
export function storiesTex(
  ctx: Ctx,
  stories: ReadonlyMap<string, J>,
  content: ContentWriter,
): void {
  const m = storyNumbers.get(ctx);
  if (!m) return;
  for (const [id, s] of m) {
    const story = stories.get(id);
    if (!story) {
      diag(
        ctx,
        'warning',
        'story_missing',
        null,
        'a page setup names a header or footer story the document lacks',
      );
      continue;
    }
    const n = register(ctx, id, 'story');
    within(ctx, n, () => {
      line(ctx, tex`\DEdefstory{${int(s)}}{%`);
      content(newFlow('story', null, id), story.content);
      line(ctx, t('}'));
    });
  }
}

/** The geometry of a page setup, for comparing two setups at a continuous break. */
function geometryKey(attrs: Record<string, unknown> | undefined): string {
  const l = lengths(attrs ?? {});
  return GEOMETRY_KEYS.map((k) => (k === 'orientation' ? '' : String(l[k] ?? ''))).join(',');
}

export function sectionBreak(ctx: Ctx, flow: Flow, node: J): void {
  const id = idOf(node);
  const setups = pageSetups(ctx);
  const target = str(attr(node, 'pageSetup'));
  if (!target || !setups.has(target)) {
    diag(
      ctx,
      'warning',
      'page_setup_missing',
      id,
      'a section break names a page setup the document lacks; the section keeps the current setup',
    );
    return;
  }
  const k = setupIndex(ctx, target);
  const attrs = setups.get(target)!;
  const start = str(attr(node, 'start')) ?? 'nextPage';
  const current = ctx.setups[ctx.state.setup]
    ? setups.get(ctx.setups[ctx.state.setup]!)
    : undefined;
  let code = enumOf(ctx, STARTS, start, t('0'), id, 'a section start');
  if (start === 'continuous' && geometryKey(current) !== geometryKey(attrs)) {
    diag(
      ctx,
      'warning',
      'continuous_break_geometry',
      id,
      'a continuous section break that changes the page size or margins cannot be honoured; size and margins stay until the next page section (09 §3.1)',
    );
    code = t('3');
  }
  ctx.state.setup = k;
  ctx.state.columns = lengths(attrs)['columns']!;
  line(ctx, tex`\DEsection{${int(k)}}{${code}}`);
  if (start !== 'continuous') {
    flow.prev = null;
    flow.pageTop = true;
  }
}
