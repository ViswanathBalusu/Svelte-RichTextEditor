/**
 * The source string table as the shell reads it (UX-064; 13 §8): the core table, and the groups
 * that only code loaded on demand shows, added as that code loads (FND-008). A module of
 * `late/<group>.ts` calls `registerSource` when it is evaluated, and the files that show its strings
 * import it, so the strings are there before the first of them is drawn. The table is live: a
 * translator looks a key up when it is asked, not when it is made.
 */
import { EN_GB_CORE } from './en-GB-core.ts';
import type { Message, StringTable } from './types.ts';

const SOURCE: Record<string, Message> = { ...EN_GB_CORE };

/** The source table so far: the core and the groups that have loaded. */
export const SOURCE_TABLE: StringTable = SOURCE;

/** Adds a group of source strings. A key that is already there is replaced by the same text. */
export function registerSource(group: StringTable): void {
  for (const [key, message] of Object.entries(group)) SOURCE[key] = message;
}

/**
 * The first parts of the keys of the groups that load on demand (`late/*.ts`). A key that starts
 * with one of them is not reported as unknown while its group has not loaded; `late-groups.test.ts`
 * keeps this list and the folder in step.
 */
export const LATE_KEY_HEADS: readonly string[] = [
  'accessCode',
  'announce',
  'catchUp',
  'checker',
  'comment',
  'comments',
  'dialog',
  'export',
  'field',
  'fill',
  'history',
  'lease',
  'outline',
  'pages',
  'pdf',
  'permissions',
  'recovered',
  'review',
  'roles',
  'rule',
  'search',
  'send',
  'shortcuts',
  'signature',
  'sources',
  'styles',
];

/** Whether the source table has the key, or a group that has not loaded may have it. */
export function isSourceKey(key: string): boolean {
  return Object.hasOwn(SOURCE, key) || LATE_KEY_HEADS.includes(key.split('.')[0] ?? '');
}
