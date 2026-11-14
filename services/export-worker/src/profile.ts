/**
 * How a job's options become a compile (09 §8, §9.1; EXP-005, EXP-061, EXP-062; ADR 0045).
 *
 * - `final` (the default) compiles from a clean sandbox until page references stop changing: at
 *   least two passes, at most four, with full tagging and PDF/UA-2 plus PDF/A-4f.
 * - `preview` compiles once, with `tagging=off` unless the request names a tagging mode. Spike S4
 *   measured `off` at 36 to 65 % of a tagged pass with exactly the line and page breaks of a tagged
 *   compile, while draft tagging saved only 13 to 35 %; without `\DocumentMetadata` breaks move
 *   (S4 §4.4). A preview's page references may be stale, and its result says so.
 *
 * An option the worker cannot honour fails the job with a diagnostic instead of being dropped.
 */
import type { Diagnostic, PdfStandard, Tagging } from '@docedit/export-latex';
import { diagnostic } from './diagnostics.ts';

export type Profile = 'preview' | 'final';

export interface JobPlan {
  profile: Profile;
  tagging: Exclude<Tagging, 'none'>;
  pdfStandard: PdfStandard;
  minPasses: number;
  maxPasses: number;
  /** BCP 47 tag for dates and language-dependent text. */
  locale: string;
  /** IANA time zone of `date` fields (09 §3.1: the server's date at job creation in it). */
  timeZone: string;
  /** `fields` of 09 §9.1. */
  fields: 'flatten' | 'blank';
  /** How suggestions print (09 §10); absent: the document must have none. */
  suggestions: 'accept' | 'reject' | 'markup' | null;
  /** Warnings about choices made for the request. */
  diagnostics: Diagnostic[];
}

/** Passes of a final export: references converge in 2 or 3 passes in the S4 corpus. */
export const FINAL_PASSES = { min: 2, max: 4 } as const;

/** Defaults where 09 and EXP-005 name none (ADR 0045): the document's language, and UTC. */
export const DEFAULT_TIME_ZONE = 'UTC';
export const DEFAULT_LOCALE = 'en-GB';

const KNOWN = new Set([
  'profile',
  'suggestions',
  'comments',
  'fields',
  'tagging',
  'pdfStandard',
  'locale',
  'timeZone',
  'certificate',
]);

const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,4}$/;

function validTimeZone(tz: string): boolean {
  if (!/^[A-Za-z0-9_+\-/]{1,64}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function validLocale(tag: string): boolean {
  if (!LOCALE.test(tag)) return false;
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0;
  } catch {
    return false;
  }
}

export type PlanResult = { ok: true; plan: JobPlan } | { ok: false; diagnostics: Diagnostic[] };

/** The plan for `options` (as the control plane passed them, unchanged) and the document's language. */
export function planJob(options: unknown, documentLang: string | null): PlanResult {
  const o = (
    options && typeof options === 'object' && !Array.isArray(options) ? options : {}
  ) as Record<string, unknown>;
  const refusals: Diagnostic[] = [];
  const notes: Diagnostic[] = [];
  const invalid = (name: string) => refusals.push(diagnostic('option_invalid', null, name));
  const unsupported = (name: string, why: string) =>
    refusals.push(diagnostic('option_unsupported', null, `${name}: ${why}`));
  for (const k of Object.keys(o))
    if (!KNOWN.has(k))
      notes.push(diagnostic('option_ignored', null, k.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40)));

  const profile = o['profile'] ?? 'final';
  if (profile !== 'final' && profile !== 'preview') invalid('profile');
  const p: Profile = profile === 'preview' ? 'preview' : 'final';

  const tagging = o['tagging'] ?? (p === 'final' ? 'on' : 'off');
  if (tagging !== 'on' && tagging !== 'draft' && tagging !== 'off') invalid('tagging');
  const t = tagging === 'draft' || tagging === 'off' ? tagging : 'on';

  let pdfStandard: PdfStandard = t === 'on' ? 'ua-2+a-4f' : 'none';
  const std = o['pdfStandard'];
  if (std !== undefined) {
    if (std === 'ua-2' || std === 'ua-2+a-4f') {
      if (t !== 'on') unsupported('pdfStandard', 'PDF/UA-2 needs tagging on');
      pdfStandard = std;
    } else if (std === 'a-4f') pdfStandard = 'a-4f';
    else if (std === 'a-4') {
      // Tagged PDF embeds associated files (CSS, MathML), which PDF/A-4 forbids (S4 §2).
      pdfStandard = 'a-4f';
      notes.push(diagnostic('pdf_standard_substituted'));
    } else if (std === 'none') pdfStandard = 'none';
    else invalid('pdfStandard');
  }

  const fields = o['fields'] ?? 'flatten';
  if (fields !== 'flatten' && fields !== 'blank') invalid('fields');
  const comments = o['comments'] ?? 'none';
  if (comments === 'margin') unsupported('comments', 'comments in the margin come with EXP-084');
  else if (comments !== 'none') invalid('comments');
  const suggestions = o['suggestions'];
  // `markup` is the converter's markup mode (EXP-083; export-latex suggestions.ts).
  if (
    suggestions !== undefined &&
    suggestions !== 'accept' &&
    suggestions !== 'reject' &&
    suggestions !== 'markup'
  )
    invalid('suggestions');
  const certificate = o['certificate'];
  if (certificate === true)
    unsupported('certificate', 'the certificate of completion comes with FRW-050');
  else if (certificate !== undefined && certificate !== false) invalid('certificate');

  const locale =
    o['locale'] ?? (documentLang && validLocale(documentLang) ? documentLang : DEFAULT_LOCALE);
  if (typeof locale !== 'string' || !validLocale(locale)) invalid('locale');
  const timeZone = o['timeZone'] ?? DEFAULT_TIME_ZONE;
  if (typeof timeZone !== 'string' || !validTimeZone(timeZone)) invalid('timeZone');

  if (refusals.length) return { ok: false, diagnostics: [...refusals, ...notes] };
  return {
    ok: true,
    plan: {
      profile: p,
      tagging: t,
      pdfStandard,
      minPasses: p === 'final' ? FINAL_PASSES.min : 1,
      maxPasses: p === 'final' ? FINAL_PASSES.max : 1,
      locale: locale as string,
      timeZone: timeZone as string,
      fields: fields === 'blank' ? 'blank' : 'flatten',
      suggestions:
        suggestions === 'accept' || suggestions === 'reject' || suggestions === 'markup'
          ? suggestions
          : null,
      diagnostics: notes,
    },
  };
}

/** The `date` field's text: the job's creation date in its locale and time zone (09 §3.1). */
export function formatJobDate(
  createdAt: number,
  plan: Pick<JobPlan, 'locale' | 'timeZone'>,
): string {
  return new Intl.DateTimeFormat(plan.locale, {
    dateStyle: 'long',
    timeZone: plan.timeZone,
  }).format(new Date(createdAt));
}
