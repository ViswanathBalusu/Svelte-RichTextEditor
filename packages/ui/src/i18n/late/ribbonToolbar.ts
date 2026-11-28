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
  'ribbon.group.styles': 'Styles',
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
  'ribbon.command.format.underline': 'Underline',
  'ribbon.command.format.strike': 'Strikethrough',
  'ribbon.command.format.clear': 'Clear formatting',
  'ribbon.command.format.fontSize': 'Font size',
  'ribbon.command.format.color': 'Text colour',
  'ribbon.command.format.highlight': 'Highlight',
  'ribbon.command.format.align.start': 'Align start',
  'ribbon.command.format.align.center': 'Centre',
  'ribbon.command.format.align.end': 'Align end',
  'ribbon.command.format.align.justify': 'Justify',
  'ribbon.command.format.bulletList': 'Bulleted list',
  'ribbon.command.format.numberList': 'Numbered list',
  'ribbon.command.format.indentLess': 'Decrease indent',
  'ribbon.command.format.indentMore': 'Increase indent',
  // The lists of the Home tab (`CommandEntry.picker`): what a closed list shows when nothing is chosen,
  // and the names of the colours it offers. The values are the model's (03 §4.8); only the names are words.
  'ribbon.picker.style': 'Style',
  'ribbon.picker.size': 'Size',
  'ribbon.size.default': 'Size of the style',
  'ribbon.colour.automatic': 'Automatic',
  'ribbon.colour.darkRed': 'Dark red',
  'ribbon.colour.darkGreen': 'Dark green',
  'ribbon.colour.darkBlue': 'Dark blue',
  'ribbon.colour.purple': 'Purple',
  'ribbon.colour.darkGrey': 'Dark grey',
  'ribbon.highlight.none': 'No highlight',
  'ribbon.highlight.yellow': 'Yellow',
  'ribbon.highlight.green': 'Green',
  'ribbon.highlight.cyan': 'Cyan',
  'ribbon.highlight.magenta': 'Magenta',
  'ribbon.highlight.lightGray': 'Light grey',
} as const satisfies StringTable;

registerSource(EN_GB_RIBBON_TOOLBAR);
