/**
 * How many confirmed commits a receiver keeps the mapping of (SYN-036 criterion 4). The spec does not
 * state a number; this is a proposed default (ADR 0108), and the option `historyCommits` overrides it.
 *
 * It lives in its own module so that `presence.ts` and `thread-sync.ts` do not import each other
 * through `api.ts`.
 */
export const DEFAULT_MAPPING_HISTORY = 256;
