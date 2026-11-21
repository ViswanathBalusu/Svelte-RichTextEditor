/**
 * Whether one reference, one field target or one numbering level resolves (I4; 03 §8). The full
 * validator (validate.ts) asks for every use it collected. The incremental one (incremental.ts)
 * asks for the uses of the nodes a commit added, and for the uses a commit left alone whose target
 * it removed or changed. Both run this code, so the two cannot differ in what resolves.
 */
import type { BuiltInCode } from './codes.ts';
import {
  LIMITS,
  type NumberingUse,
  type ParagraphInfo,
  type RefUse,
  type StyleInfo,
} from './node-checks.ts';

interface Has {
  has(key: string): boolean;
}
interface Lookup<V> extends Has {
  get(key: string): V | undefined;
}

/** The definitions of a document, by identifier. */
export interface Definitions {
  styles: Lookup<StyleInfo>;
  /** `settings.defaultParagraphStyle`: the style of a paragraph whose `style` is null. */
  defaultStyle: string | null;
  /** The number of levels of each numbering definition. */
  numberingLevels: Lookup<number>;
  pageSetups: Has;
  /** The kind of each story, `header` or `footer`. */
  stories: Lookup<string>;
  sources: Has;
  preservedDefs: Has;
}

/** What a `field.target` can name in the body and the stories. */
export interface Targets {
  anchors: Has;
  eqLabels: Has;
  paragraphs: Lookup<ParagraphInfo>;
}

/** Whether a paragraph style, through its `basedOn` chain, has a property. */
export function chainHas(
  styles: Lookup<StyleInfo>,
  style: string | null,
  pick: (s: StyleInfo) => boolean,
): boolean {
  let cur = style;
  for (let i = 0; cur && i <= LIMITS.basedOnDepth; i++) {
    const s = styles.get(cur);
    if (!s) return false;
    if (pick(s)) return true;
    cur = s.basedOn;
  }
  return false;
}

/** Why a reference does not resolve, with the code it is reported under; null when it does. */
export function refProblem(
  d: Definitions,
  r: RefUse,
  attachedAssets: ReadonlySet<string> | undefined,
): { code: BuiltInCode; why: string } | null {
  const fail = (code: BuiltInCode, why: string) => ({ code, why });
  switch (r.to) {
    case 'paragraphStyle':
    case 'characterStyle':
    case 'tableStyle': {
      const s = d.styles.get(r.value);
      const want =
        r.to === 'paragraphStyle' ? 'paragraph' : r.to === 'characterStyle' ? 'character' : 'table';
      if (!s) return fail('unresolved_reference', `style "${r.value}" does not exist`);
      if (s.kind !== want)
        return fail(
          'wrong_reference_kind',
          `style "${r.value}" is a ${s.kind} style, not a ${want} style`,
        );
      return null;
    }
    case 'anyStyle': {
      const s = d.styles.get(r.value);
      if (!s) return fail('unresolved_reference', `style "${r.value}" does not exist`);
      if (r.fromStyleKind && s.kind !== r.fromStyleKind)
        return fail(
          'wrong_reference_kind',
          `basedOn "${r.value}" is a ${s.kind} style; a ${r.fromStyleKind} style must be based on one of its own kind`,
        );
      return null;
    }
    case 'numbering':
      return d.numberingLevels.has(r.value)
        ? null
        : fail('unresolved_reference', `numbering definition "${r.value}" does not exist`);
    case 'pageSetup':
      return d.pageSetups.has(r.value)
        ? null
        : fail('unresolved_reference', `page setup "${r.value}" does not exist`);
    case 'headerStory':
    case 'footerStory': {
      const kind = d.stories.get(r.value);
      const want = r.to === 'headerStory' ? 'header' : 'footer';
      if (!kind) return fail('unresolved_reference', `story "${r.value}" does not exist`);
      if (kind !== want)
        return fail('wrong_reference_kind', `story "${r.value}" is a ${kind}, not a ${want}`);
      return null;
    }
    case 'source':
      return d.sources.has(r.value)
        ? null
        : fail('unresolved_reference', `source "${r.value}" does not exist`);
    case 'preservedDef':
      return d.preservedDefs.has(r.value)
        ? null
        : fail(
            'unresolved_reference',
            'preserved tree ' + JSON.stringify(r.value) + ' does not exist',
          );
    case 'role':
      // Roles are I13, checked by the field invariants (src/fields/invariants.ts).
      return null;
    case 'asset':
      return attachedAssets && !attachedAssets.has(r.value)
        ? fail('asset_not_attached', `asset "${r.value}" is not attached to this document`)
        : null;
  }
}

/**
 * Why a `field.target` names nothing, as the words that follow the target in the message; null when
 * it resolves. `field:` targets are I14, checked by the field invariants.
 */
export function targetProblem(d: Definitions & Targets, value: string): string | null {
  const colon = value.indexOf(':');
  const scheme = value.slice(0, colon);
  const target = value.slice(colon + 1);
  switch (scheme) {
    case 'bookmark':
      return d.anchors.has(target) ? null : 'names no bookmark';
    case 'node': {
      const p = d.paragraphs.get(target);
      if (!p) return 'names no paragraph';
      const style = p.style ?? d.defaultStyle;
      const heading = chainHas(d.styles, style, (s) => s.outlineLevel);
      const numbered = p.numbered || chainHas(d.styles, style, (s) => s.numbered);
      return heading || numbered || p.caption
        ? null
        : 'names a paragraph that is not a heading, a numbered paragraph or a caption';
    }
    case 'eq':
      return d.eqLabels.has(target) ? null : 'names no equation label';
    case 'style':
      return d.styles.has(target) ? null : 'names no style';
    default:
      return null;
  }
}

/** Why a numbering level does not exist in its definition; null when it does (CDM-019, CDM-026). */
export function levelProblem(d: Definitions, u: NumberingUse): string | null {
  const levels = d.numberingLevels.get(u.numberingId);
  // A definition that does not exist is an unresolved reference already.
  return levels !== undefined && u.level >= levels
    ? `level ${u.level} is not defined: "${u.numberingId}" has ${levels} level${levels === 1 ? '' : 's'}`
    : null;
}
