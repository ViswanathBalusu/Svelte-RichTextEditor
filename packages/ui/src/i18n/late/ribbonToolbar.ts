/**
 * The strings of the `ribbonToolbar` group of the source table (UX-064; 13 §8) that only code loaded
 * on demand shows: the tabs and the group captions of the ribbon layout (`toolbar="ribbon"`,
 * ADR 0490). The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core table
 * is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_RIBBON_TOOLBAR = {
  // The ribbon layout (`toolbar="ribbon"`, ADR 0490): its tabs, and the captions of its groups.
  'ribbon.tab.home': 'Home',
  'ribbon.tab.insert': 'Insert',
  'ribbon.tab.layout': 'Layout',
  'ribbon.tab.references': 'References',
  'ribbon.tab.review': 'Review',
  'ribbon.tab.view': 'View',
  'ribbon.group.edit': 'Edit',
  'ribbon.group.font': 'Font',
  'ribbon.group.paragraph': 'Paragraph',
  'ribbon.group.copyFormat': 'Copy format',
  'ribbon.group.insert': 'Insert',
  'ribbon.group.tables': 'Tables',
  'ribbon.group.fields': 'Fields',
  'ribbon.group.regions': 'Regions',
  'ribbon.group.headerFooter': 'Header and footer',
  'ribbon.group.document': 'Document',
  'ribbon.group.notes': 'Notes',
  'ribbon.group.captions': 'Captions',
  'ribbon.group.citations': 'Citations',
  'ribbon.group.comments': 'Comments',
  'ribbon.group.tracking': 'Tracking',
  'ribbon.group.proofing': 'Proofing',
  'ribbon.group.workflow': 'Workflow',
  'ribbon.group.protection': 'Protection',
  'ribbon.group.views': 'Views',
  'ribbon.group.zoom': 'Zoom',
  'ribbon.group.panes': 'Panes',
} as const satisfies StringTable;

registerSource(EN_GB_RIBBON_TOOLBAR);
