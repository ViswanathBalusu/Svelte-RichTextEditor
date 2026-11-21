/**
 * The whole source string table, in British English (UX-064; 13 §8): the core (`en-GB-core.ts`)
 * and every group that only code loaded on demand shows (`late/*.ts`; FND-008). The first load
 * takes the core only. Tests, the pseudo-locales and a host that builds a translation take this
 * whole table; components import the group they show and `StringKey` from here as a type.
 */
import { EN_GB_CATCH_UP_PANE } from './late/catchUpPane.ts';
import { EN_GB_CHECKER_PANE } from './late/checkerPane.ts';
import { EN_GB_COMMENTS_PANE } from './late/commentsPane.ts';
import { EN_GB_DIALOGS } from './late/dialogs.ts';
import { EN_GB_FIELDS_PANE } from './late/fieldsPane.ts';
import { EN_GB_FILL_BAR } from './late/fillBar.ts';
import { EN_GB_HISTORY_PANE } from './late/historyPane.ts';
import { EN_GB_OUTLINE_PANE } from './late/outlinePane.ts';
import { EN_GB_PDF_PANE } from './late/pdfPane.ts';
import { EN_GB_PERMISSIONS_PANE } from './late/permissionsPane.ts';
import { EN_GB_RECOVERED_PANE } from './late/recoveredPane.ts';
import { EN_GB_REVIEW_PANE } from './late/reviewPane.ts';
import { EN_GB_ROLES_PANE } from './late/rolesPane.ts';
import { EN_GB_RULES_PANE } from './late/rulesPane.ts';
import { EN_GB_SHORTCUTS_PANE } from './late/shortcutsPane.ts';
import { EN_GB_SOURCES_PANE } from './late/sourcesPane.ts';
import { EN_GB_STYLES_PANE } from './late/stylesPane.ts';
import { EN_GB_CORE } from './en-GB-core.ts';
import type { StringTable } from './types.ts';

export const EN_GB = {
  ...EN_GB_CORE,
  ...EN_GB_CATCH_UP_PANE,
  ...EN_GB_CHECKER_PANE,
  ...EN_GB_COMMENTS_PANE,
  ...EN_GB_DIALOGS,
  ...EN_GB_FIELDS_PANE,
  ...EN_GB_FILL_BAR,
  ...EN_GB_HISTORY_PANE,
  ...EN_GB_OUTLINE_PANE,
  ...EN_GB_PDF_PANE,
  ...EN_GB_PERMISSIONS_PANE,
  ...EN_GB_RECOVERED_PANE,
  ...EN_GB_REVIEW_PANE,
  ...EN_GB_ROLES_PANE,
  ...EN_GB_RULES_PANE,
  ...EN_GB_SHORTCUTS_PANE,
  ...EN_GB_SOURCES_PANE,
  ...EN_GB_STYLES_PANE,
} as const satisfies StringTable;

export type StringKey = keyof typeof EN_GB;
