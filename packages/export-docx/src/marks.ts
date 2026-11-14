/**
 * Run properties as CDM marks (03 §5) and back. The lenses in props.ts work on values keyed like
 * the style_def attributes; text carries the same properties as marks.
 */
import type { JsonMark } from '@docedit/model';
import type { JsonValue } from '@docedit/model/definition';
import type { Values } from './props.ts';
import type { TreeBody } from './tree.ts';

const TOGGLES = ['bold', 'italic', 'allCaps', 'smallCaps', 'strike', 'hidden'] as const;
const VALUED = ['fontFamily', 'fontSize', 'color', 'highlight', 'lang', 'vertAlign'] as const;
export const SUGGESTION_MARKS: ReadonlySet<string> = new Set(['ins', 'del', 'fmt']);

export function valuesToMarks(v: Values): JsonMark[] {
  const marks: JsonMark[] = [];
  const style = v['charStyle'];
  if (typeof style === 'string') marks.push({ type: 'charStyle', attrs: { style } });
  for (const t of TOGGLES) {
    const val = v[t];
    if (typeof val === 'boolean') marks.push({ type: t, attrs: { value: val } });
  }
  const u = v['underline'];
  if (typeof u === 'string') marks.push({ type: 'underline', attrs: { style: u } });
  for (const k of VALUED) {
    const val = v[k];
    if (val !== null && val !== undefined) marks.push({ type: k, attrs: { value: val } });
  }
  return marks;
}

export interface RunMarks {
  values: Values;
  /** The `props` of the `preserved` mark, if any. */
  props: TreeBody | null;
  ins: JsonMark | null;
  del: JsonMark | null;
}

export function marksToValues(marks: readonly JsonMark[] | undefined): RunMarks {
  const values: Values = {
    charStyle: null,
    fontFamily: null,
    bold: null,
    italic: null,
    allCaps: null,
    smallCaps: null,
    strike: null,
    hidden: null,
    color: null,
    fontSize: null,
    highlight: null,
    underline: null,
    vertAlign: null,
    lang: null,
  };
  let props: TreeBody | null = null;
  let ins: JsonMark | null = null;
  let del: JsonMark | null = null;
  for (const m of marks ?? []) {
    const a = m.attrs ?? {};
    switch (m.type) {
      case 'charStyle':
        values['charStyle'] = (a['style'] as JsonValue) ?? null;
        break;
      case 'underline':
        values['underline'] = (a['style'] as JsonValue) ?? 'single';
        break;
      case 'preserved':
        props = (a['props'] as unknown as TreeBody) ?? null;
        break;
      case 'ins':
        ins = m;
        break;
      case 'del':
        del = m;
        break;
      default:
        if ((TOGGLES as readonly string[]).includes(m.type))
          values[m.type] = a['value'] === undefined ? true : (a['value'] as JsonValue);
        else if ((VALUED as readonly string[]).includes(m.type))
          values[m.type] = (a['value'] as JsonValue) ?? null;
    }
  }
  return { values, props, ins, del };
}

/** A stable key of the marks that go into `w:rPr`, for grouping text into runs. */
export function formattingKey(marks: readonly JsonMark[] | undefined): string {
  return JSON.stringify(
    (marks ?? [])
      .filter((m) => !SUGGESTION_MARKS.has(m.type))
      .map((m) => [m.type, m.attrs ?? {}])
      .sort((x, y) => (x[0]! < y[0]! ? -1 : x[0]! > y[0]! ? 1 : 0)),
  );
}
