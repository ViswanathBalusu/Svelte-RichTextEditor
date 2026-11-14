/**
 * The legal stance of the signing language (12 §8.3; ADR 0013; FRW-058), as a pure check over text.
 *
 * `findOverclaims` reports each phrase of `OVERCLAIM_PHRASES` that a text contains, ignoring case and
 * the difference between runs of white space. The list is a maintained floor, not a complete list of
 * over-claims: counsel's review (FRW-087) may add to it. The check runs over the strings this package
 * ships, and over other text when a caller passes it. The repository-wide CI run is not built here
 * (it needs the root configuration, which is the main session's).
 */

/** Phrases that claim more than a simple electronic signature with an audit trail and a seal. */
export const OVERCLAIM_PHRASES: readonly string[] = [
  'qualified electronic signature',
  'advanced electronic signature',
  'qualified signature',
  'advanced signature',
  'eidas qualified',
  'legally binding everywhere',
  'legally binding in all',
  'verified identity',
  'identity verified',
  'verified signer',
  'notarised',
  'notarized',
  'tamper-proof',
  'guaranteed to be valid',
];

/** What the product provides natively (FRW-058 criterion 2). */
export const NATIVE_SIGNING_DESCRIPTION =
  "A simple electronic signature with an audit trail and a tamper-evident seal applied by the operator or by the tenant's own key.";

/** How the platform describes an authentication it does not verify (FRW-058 criterion 5). */
export const AUTHENTICATION_PHRASE = 'as asserted by the host';

/** Collapses white space and lower-cases, so that the phrase match ignores layout. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

/** The phrases of `OVERCLAIM_PHRASES` that `text` contains, in list order, each at most once. */
export function findOverclaims(text: string): string[] {
  const haystack = normalise(text);
  return OVERCLAIM_PHRASES.filter((phrase) => haystack.includes(phrase));
}

/** Whether `text` is free of every phrase of the list. */
export function isWithinLegalStance(text: string): boolean {
  return findOverclaims(text).length === 0;
}
