/**
 * The PDF validation gate of the reference corpus (EXP-016, lane V-EXP-001-016): which PDFs must be
 * validated, with which veraPDF flavours, and how a failure is written to the log so that it names
 * the rule and the corpus document. Pure functions: no container, no file system.
 */
import type { Flavour, Validation } from './verapdf.ts';

/** The standards a `pdfStandard` option declares (09 §3.1), as veraPDF flavours. */
export function flavoursFor(pdfStandard: string): Flavour[] {
  switch (pdfStandard) {
    case 'ua-2+a-4f':
      return ['ua2', '4f'];
    case 'ua-2':
      return ['ua2'];
    case 'a-4f':
      return ['4f'];
    default:
      return [];
  }
}

/**
 * A PDF made with draft tagging is a preview and is not required to validate (09 §3.1: "Preview
 * compiles may use draft tagging to save time"). Every other tagging value is validated.
 */
export function requiresValidation(tagging: string): boolean {
  return tagging !== 'draft';
}

/**
 * One log line per failed rule, prefixed with the corpus document, so that a CI log names the rule
 * and the document. Returns the empty string when the PDF is compliant.
 */
export function validationReport(document: string, v: Validation): string {
  if (v.error !== undefined)
    return `${document} ${v.flavour}: veraPDF gave no result: ${v.error.slice(0, 500)}`;
  if (v.compliant) return '';
  const lines = v.failures.map(
    (f) =>
      `${document} ${v.flavour} (${v.profile || 'profile unknown'}): ${f.specification} clause ${f.clause} test ${f.testNumber}: ${f.description} (${f.failedChecks} failed checks)`,
  );
  if (lines.length === 0)
    lines.push(
      `${document} ${v.flavour}: not compliant, ${v.failedChecks} failed checks, no rule named`,
    );
  return lines.join('\n');
}
