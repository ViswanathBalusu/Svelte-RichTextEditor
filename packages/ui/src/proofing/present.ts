/**
 * How the proofing state and a finding are put into words (UX-041 criteria 4, 5 and 6; 13 §6.1).
 *
 * - `proofingBarItem` is the quiet state in the status bar: nothing at all without a proofing port
 *   (criterion 5), "checking" while the port works, "not available" when it failed, and the count
 *   otherwise. It is text, never an error that blocks the interface (criterion 4).
 * - `findingSentence` is what a screen reader hears when the caret moves to a finding: its kind, the
 *   text it covers, the port's message and the suggestions, so a finding is not only a decoration
 *   (criterion 6).
 *
 * The functions take the translator, so the words come from the string tables (13 §8).
 */
import type { ProofingFindingView, ProofingStatus } from '../core-api.ts';
import type { StringKey } from '../i18n/en-GB.ts';
import type { MessageParams } from '../i18n/types.ts';

export type Translate = (key: StringKey, params?: MessageParams) => string;

export interface ProofingBarItem {
  readonly text: string;
  /** The state, for styling and tests: `checking`, `unavailable`, or `idle` with the count. */
  readonly state: ProofingStatus['state'];
  readonly count: number;
}

/** The status-bar item, or null when no proofing port is attached. */
export function proofingBarItem(
  status: ProofingStatus | null | undefined,
  t: Translate,
): ProofingBarItem | null {
  if (!status || !status.available) return null;
  if (status.state === 'checking')
    return { text: t('status.proofing.checking'), state: 'checking', count: status.count };
  if (status.state === 'unavailable')
    return { text: t('status.proofing.unavailable'), state: 'unavailable', count: status.count };
  return {
    text:
      status.count === 0
        ? t('status.proofing.none')
        : t('status.proofing.count', { count: status.count }),
    state: 'idle',
    count: status.count,
  };
}

function kindKey(kind: string): StringKey {
  if (kind === 'spelling') return 'proofing.kind.spelling';
  if (kind === 'grammar') return 'proofing.kind.grammar';
  return 'proofing.kind.other';
}

/** The sentence a screen reader gets for a finding: kind, text, message, suggestions. */
export function findingSentence(finding: ProofingFindingView, t: Translate): string {
  const head = t('proofing.finding', {
    kind: t(kindKey(finding.kind)),
    text: finding.text,
    message: finding.message,
  });
  const tail =
    finding.suggestions.length === 0
      ? t('proofing.finding.nosuggestions')
      : t('proofing.finding.suggestions', { suggestions: finding.suggestions.join(', ') });
  return `${head} ${tail}`.replace(/\s+/g, ' ').trim();
}
