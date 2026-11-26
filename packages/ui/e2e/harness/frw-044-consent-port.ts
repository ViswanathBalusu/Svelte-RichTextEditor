/**
 * A consent service for the shell's browser tests of the consent step (FRW-044, FRW-033). The server
 * is a stand-in: it holds one text, records what the step asked of it on the returned `log`, and
 * answers from the mode.
 *
 * Modes: `required` (the text is shown, nothing is accepted yet), `accepted` (the participant
 * accepted it earlier), `none` (the workflow names no text), `unreadable` (the text cannot be read:
 * the first load fails, a retry succeeds), `refused` (the acceptance is refused as forbidden).
 */
import type { ConsentService, ConsentView } from '../../src/core-api.ts';

export type ConsentHarnessMode = 'required' | 'accepted' | 'none' | 'unreadable' | 'refused';

export interface ConsentHarnessLog {
  loads: number;
  accepts: number;
  declines: string[];
}

export const CONSENT_TEXT = [
  'I agree to sign this document electronically and to be bound by it.',
  'I confirm that I have read the document and that the signature I adopt is mine.',
  'I understand that the time, the connection and the device I use are recorded as evidence.',
].join('\n\n');

export function consentService(mode: ConsentHarnessMode, log: ConsentHarnessLog): ConsentService {
  const view = (acceptedAt: string | null): ConsentView => ({
    textId: 'esign-consent',
    version: 3,
    text: CONSENT_TEXT,
    acceptedAt,
  });
  let accepted = mode === 'accepted';
  return {
    async load() {
      log.loads++;
      if (mode === 'none') return { ok: false, reason: 'none' };
      if (mode === 'unreadable' && log.loads === 1) return { ok: false, reason: 'failed' };
      return { ok: true, consent: view(accepted ? '2026-11-26T10:00:00.000Z' : null) };
    },
    async accept() {
      log.accepts++;
      if (mode === 'refused') return { ok: false, reason: 'forbidden' };
      accepted = true;
      return { ok: true };
    },
    async decline(reason) {
      log.declines.push(reason);
      return { ok: true };
    },
  };
}
