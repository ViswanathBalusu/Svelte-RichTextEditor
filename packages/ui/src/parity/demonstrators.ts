/**
 * What demonstrates a capability of the tier "through ports and extensions" (UX-002 criterion 3;
 * 13 §2, §6, §7). The report names the port or the reference extension that demonstrates the row,
 * or states that none exists. Every such row has an entry here, so a new row cannot reach a report
 * without someone saying what demonstrates it (`problems` in `parityReport` names a missing entry).
 *
 * Each `none` reason was checked against the tree at 2026-11-13: no proofing port, reference
 * assistant or reference extension is shipped under `packages/` or `apps/`. The assistant folder
 * (`packages/ui/src/assistant`) holds the context and prompt rules only (UX-047, UX-048).
 */
export type Demonstrator =
  | { readonly state: 'port'; readonly name: string }
  | { readonly state: 'reference-extension'; readonly name: string }
  | { readonly state: 'none'; readonly reason: string };

const DEMONSTRATOR_ENTRIES: ReadonlyArray<readonly [string, Demonstrator]> = [
  [
    'spelling-and-grammar',
    {
      state: 'none',
      reason:
        'the proofing port is wired (UX-041, UX-042) but no reference proofing service ships; UX-043 is a spike',
    },
  ],
  [
    'text-prediction',
    { state: 'none', reason: 'no port and no story (13 section 6 defines none)' },
  ],
  [
    'assistant',
    {
      state: 'none',
      reason:
        'no assistant port or reference assistant ships; the assistant folder holds the context and prompt rules only (UX-047, UX-048)',
    },
  ],
  ['translate', { state: 'none', reason: 'no port and no story' }],
  ['read-aloud', { state: 'none', reason: 'no port and no story' }],
  [
    'dictation',
    {
      state: 'none',
      reason:
        'no port: the operating system dictates into the editing surface, and no story tests it',
    },
  ],
  [
    'custom-blocks',
    { state: 'none', reason: 'no reference extension ships; the extension tests use fake hosts' },
  ],
  [
    'host-panels-and-commands',
    { state: 'none', reason: 'no reference extension ships; the extension tests use fake hosts' },
  ],
];

/** The demonstrator of each row of the tier, by row identifier. */
export const DEMONSTRATORS: ReadonlyMap<string, Demonstrator> = new Map(DEMONSTRATOR_ENTRIES);
