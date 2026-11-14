/**
 * The text of a `field` node, for the kinds the model can compute (03 §4.4, §7; CDM-035; FRW-006).
 * `cached` is never read: it serves only consumers that cannot compute a field.
 *
 * - `page` and `pageCount` are computed only when the typesetter gives the page's number and the
 *   document's page count (FE-137 criterion 4); without them they are not computed.
 * - `date` needs the instant and the time zone of the workflow or of the export job as explicit
 *   arguments; there is no default, and the client's time zone is never used (03 §7). The text
 *   comes from the shared date semantics (`dateFieldText`, CDM-005).
 * - `title` is control-plane metadata (03 §2), so the caller supplies it.
 * - `formValue` prints the value of the target form field, and nothing when it is empty.
 * - `ref` prints the label the target carries, from the shared numbering algorithm (CDM-042),
 *   which the caller supplies (`referenceText`); `seq` and `styleRef` depend on the field's place
 *   in the document and are left to that algorithm.
 */
import type { JsonValue } from '../definition/grammar.ts';
import { dateFieldText } from '../numbering/dates.ts';
import { type PageNumberFormat, pageNumberText } from '../numbering/page-numbers.ts';

export interface FormFieldValue {
  kind: string;
  value: JsonValue;
  options?: ReadonlyArray<{ id?: unknown; label?: unknown }> | null;
}

export interface FieldTextContext {
  /** The instant to show, an RFC 3339 UTC timestamp assigned by the server (01 §8). */
  instant?: string;
  /** IANA time zone of the workflow or of the export job; never the client's (03 §7). */
  timeZone?: string;
  /** The document's title, from the document resource (03 §2). */
  title?: string;
  /** Form fields by key, for `formValue` (12 §3.4). */
  fields?: ReadonlyMap<string, FormFieldValue>;
  /** The computed label of a reference target such as `node:…` or `eq:…` (CDM-042). */
  labelOf?: (target: string) => string | null;
  /**
   * The number of the page the field sits on, from the typesetter (see `pageNumberOf`). Without it
   * a `page` field is not computed.
   */
  pageNumber?: number;
  /** The page number format of the page's section (`page_setup.pageNumberFormat`). */
  pageNumberFormat?: PageNumberFormat;
  /**
   * The number of pages in the document, from the typesetter. A `pageCount` field prints it in
   * decimal, whatever the page number format (a proposed reading, see the lane's ADR).
   */
  pageCount?: number;
}

export type FieldText = { computed: true; text: string } | { computed: false; reason: string };

/** The attributes of a `field` node that its text depends on. */
export interface FieldAttrsForText {
  kind?: string | null;
  format?: string | null;
  target?: string | null;
  name?: string | null;
  cached?: string | null;
}

const not = (reason: string): FieldText => ({ computed: false, reason });
const text = (t: string): FieldText => ({ computed: true, text: t });

/** Computes the text of a field, or says why the model cannot. */
export function fieldText(field: FieldAttrsForText, ctx: FieldTextContext = {}): FieldText {
  const kind = field.kind ?? 'page';
  switch (kind) {
    case 'page':
      if (ctx.pageNumber === undefined)
        return not('only the typesetter and the layout know page numbers (03 §7)');
      return text(pageNumberText(ctx.pageNumber, ctx.pageNumberFormat ?? 'decimal'));
    case 'pageCount':
      if (ctx.pageCount === undefined)
        return not('only the typesetter and the layout know page numbers (03 §7)');
      return text(pageNumberText(ctx.pageCount, 'decimal'));
    case 'date':
      if (ctx.timeZone === undefined || ctx.instant === undefined)
        return not(
          'a date field needs the instant and the time zone of the workflow or the export job',
        );
      try {
        return text(
          dateFieldText({
            instant: ctx.instant,
            timeZone: ctx.timeZone,
            format: field.format ?? null,
          }),
        );
      } catch (e) {
        return not((e as Error).message);
      }
    case 'title':
      return ctx.title === undefined
        ? not('the title is control-plane metadata (03 §2)')
        : text(ctx.title);
    case 'formValue': {
      const key = field.target?.startsWith('field:') ? field.target.slice('field:'.length) : null;
      const f = key ? ctx.fields?.get(key) : undefined;
      if (!f) return not(`no form field ${JSON.stringify(key)} was given`);
      return valueText(f);
    }
    case 'ref': {
      const label = field.target && ctx.labelOf ? ctx.labelOf(field.target) : null;
      return label === null
        ? not('the label of the target comes from the numbering algorithm (CDM-042)')
        : text(label);
    }
    default:
      return not(`a ${kind} field depends on its place in the document (CDM-042)`);
  }
}

/**
 * The printed text of a form field value (FRW-006): empty when the value is empty; a checkbox as
 * a ballot box, checked or not; a choice as its option's label.
 */
export function valueText(f: FormFieldValue): FieldText {
  const v = f.value;
  if (v === null || v === '') return text('');
  switch (f.kind) {
    case 'checkbox':
      return text(v === true ? '☒' : '☐');
    case 'choice': {
      const o = (f.options ?? []).find((x) => x.id === v);
      return typeof o?.label === 'string' ? text(o.label) : text(String(v));
    }
    case 'signature':
    case 'initials':
      return not('a signature prints as a picture, not as text');
    default:
      return typeof v === 'string' ? text(v) : not('the value is not text');
  }
}
