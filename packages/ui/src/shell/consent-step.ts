/**
 * The consent step of the signing ceremony (FRW-044; 12 §8.1 step 1), as plain functions without the
 * DOM. The step comes before any signing action. It shows the text the service holds, in full, and
 * offers two explicit acts that are never pre-selected: accept, or decline instead (FRW-033, which
 * needs a reason). Until the acceptance is on record the adoption and the signing are not offered.
 *
 * `stageOf` maps what the service answered to what the step shows; the step shows the signing
 * controls only at `proceed`.
 */
import type { ConsentLoadOutcome, ConsentView } from '../core-api.ts';
import '../i18n/late/dialogs.ts';

/** What the dialog shows. */
export type ConsentStage =
  /** The text is being read; nothing else is offered. */
  | { readonly kind: 'loading' }
  /** The text is shown with its accept and decline controls; signing is not offered. */
  | { readonly kind: 'required'; readonly consent: ConsentView }
  /** The text could not be read; signing is not offered, and the participant may try again. */
  | { readonly kind: 'unavailable' }
  /** The adoption and signing controls are offered: accepted already, or no text to accept. */
  | { readonly kind: 'proceed' };

export const LOADING: ConsentStage = { kind: 'loading' };

/** The stage for the service's answer to `load`. */
export function stageOf(outcome: ConsentLoadOutcome): ConsentStage {
  if (outcome.ok)
    return outcome.consent.acceptedAt === null
      ? { kind: 'required', consent: outcome.consent }
      : { kind: 'proceed' };
  // A participant with nothing to accept goes on; the service still refuses a signing that needs
  // an acceptance, so this never lets a signing through.
  return outcome.reason === 'none' ? { kind: 'proceed' } : { kind: 'unavailable' };
}

/** Whether the adoption and signing controls are offered at this stage. */
export function signingOffered(stage: ConsentStage): boolean {
  return stage.kind === 'proceed';
}

/**
 * The text as paragraphs: split at blank lines, line breaks inside a paragraph kept for the screen
 * (`white-space: pre-line`). Nothing is cut or reworded, so the text is readable in full.
 */
export function paragraphsOf(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/** Why a decline cannot be sent yet, as a key of the shell's string table; null when it can. */
export function declineProblem(reason: string): 'consent.decline.problem' | null {
  return reason.trim() === '' ? 'consent.decline.problem' : null;
}
