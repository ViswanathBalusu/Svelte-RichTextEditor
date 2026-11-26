/**
 * The strings of the `dialogs` group of the source table (UX-064; 13 §8) that only code loaded on
 * demand shows. The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core
 * table is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_DIALOGS = {
  // Dialogs (UX-068: focus moves in and back, Escape closes, the dialog part).
  'dialog.cancel': 'Cancel',
  'dialog.apply': 'Apply',
  'dialog.language.title': 'Language of the selected text',
  'dialog.language.field': 'Language tag',
  'dialog.language.hint': 'A language tag such as en-GB, de-CH or fr.',
  'dialog.language.preview': 'Language: {name}',
  'dialog.language.invalid': 'This is not a valid language tag.',
  'dialog.language.default': 'Use the language of the document',
  'dialog.altText.title': 'Alternative text for the picture',
  // The paragraph dialog and the ruler (UX-102).
  'dialog.paragraph.title': 'Paragraph',
  'dialog.paragraph.left': 'Left indent (cm)',
  'dialog.paragraph.right': 'Right indent (cm)',
  'dialog.paragraph.firstLine': 'First-line indent (cm; negative for a hanging indent)',
  'dialog.paragraph.mixed': 'The selected paragraphs differ. A blank field keeps each as it is.',
  'dialog.paragraph.invalid':
    'Check the fields marked invalid: a length is a number within the page, a colour is #RRGGBB.',
  // The other options of the paragraph dialog (FE-129 criterion 6).
  'dialog.paragraph.alignment': 'Alignment',
  'dialog.paragraph.differs': '(differs)',
  'dialog.paragraph.spaceBefore': 'Space before (pt)',
  'dialog.paragraph.spaceAfter': 'Space after (pt)',
  'dialog.paragraph.lineRule': 'Line spacing rule',
  'dialog.paragraph.lineSpacing.lines': 'Line spacing (lines)',
  'dialog.paragraph.lineSpacing.points': 'Line spacing (pt)',
  'dialog.paragraph.rules': 'Keep and page rules',
  'dialog.paragraph.rules.hint':
    'These rules take effect in the PDF and the read view, not in the web view.',
  'dialog.paragraph.borders': 'Borders',
  'dialog.paragraph.borderField.style': '{side} border: style',
  'dialog.paragraph.borderField.width': '{side} border: width (pt)',
  'dialog.paragraph.borderField.color': '{side} border: colour (#RRGGBB, blank for automatic)',
  'dialog.paragraph.borderField.space': '{side} border: distance from the text (pt)',
  'dialog.paragraph.shading': 'Shading colour (#RRGGBB, blank for none)',
  'dialog.paragraph.tabs': 'Tab stops',
  'dialog.paragraph.tabs.none': 'No tab stops.',
  'dialog.paragraph.tabs.add': 'Add a tab stop',
  'dialog.paragraph.tabs.position': 'Tab stop {n}: position (cm)',
  'dialog.paragraph.tabs.align': 'Tab stop {n}: alignment',
  'dialog.paragraph.tabs.leader': 'Tab stop {n}: leader',
  'dialog.paragraph.tabs.remove': 'Remove tab stop {n}',
  // The table size dialog (FE-104).
  'dialog.tableSize.title': 'Table column widths and row height',
  'dialog.tableSize.columns': 'Column widths',
  'dialog.tableSize.column': 'Column {n} width (cm)',
  'dialog.tableSize.row': 'Height of row {n} (cm)',
  'dialog.tableSize.hint':
    'Leave the row height blank for the height its text needs. A height you enter is the least the row has.',
  'dialog.tableSize.invalid': 'Enter each length in centimetres, within the page.',
  'ruler.label': 'Ruler',
  'ruler.tab': 'Tab stop, {align}',
  'ruler.value': '{name}: {value} cm',
  'ruler.margins':
    'The PDF has margins of {left} cm on the left and {right} cm on the right. The ruler measures from the left edge of the text.',
  'ruler.hint':
    'Click the ruler to add a tab stop. Arrow keys move a marker, Delete removes a tab stop. The Paragraph dialog sets the same values.',
  'ruler.dialog': 'Paragraph…',
  'dialog.altText.field': 'Describe the picture',
  'dialog.altText.hint':
    'Say what the picture shows, for people who cannot see it. If you leave it for later, the accessibility checker lists the picture.',
  'dialog.altText.later': 'Later',
  'dialog.crossRef.title': 'Insert a cross-reference',
  'dialog.crossRef.kind': 'Refer to',
  'dialog.crossRef.list': 'Targets',
  'dialog.crossRef.item': '{text}, prints {label}',
  'dialog.crossRef.empty':
    'There is nothing to refer to yet. A heading, paragraph or equation needs a number, and a caption or a bookmark needs a numbered block.',
  'dialog.crossRef.format': 'Insert as',
  'dialog.crossRef.format.number': 'The number',
  'dialog.crossRef.format.page': 'The page number',
  'dialog.crossRef.hint':
    'The reference prints the number of its target and follows it when content moves. The page number shows in the PDF; the web view has no pages and shows the number.',
  'dialog.crossRef.insert': 'Insert',
  'dialog.region.title': 'Make a region',
  'dialog.region.field': 'Title of the region',
  'dialog.region.hint':
    'The selected blocks become a region. You can then choose who may edit it in the permissions pane.',
  'dialog.region.empty': 'Enter a title.',
  'dialog.region.create': 'Make region',
  'dialog.version.title': 'Name this version',
  'dialog.version.name': 'Name',
  'dialog.version.note': 'Note (optional)',
  'dialog.version.hint':
    'The name and the note are kept with the document as it is now. You can find the version again in the history.',
  'dialog.version.empty': 'Enter a name.',
  'dialog.version.save': 'Name version',
  'dialog.version.forbidden': 'You cannot name a version of this document.',
  'dialog.version.failed': 'The version could not be named. Try again.',

  // The send dialog (FRW-028; 12 §6.2): the pre-send checklist and the send control.
  'dialog.send.title': 'Send for completion',
  'dialog.send.intro':
    'Sending locks the document and asks the first participants to act. These four checks must pass.',
  'send.checks.label': 'Checks before sending',
  'send.link.field': 'Go to the field {name}',
  'send.link.participants': 'Open the roles to give {name} a participant',
  'send.link.rules': 'Open the rules',
  'send.link.suggestion': 'Go to the suggestion {name}',
  'send.link.suggestionUnnamed': 'Go to a suggestion',
  'send.control.send': 'Send',
  'send.control.confirm': 'Confirm and send',
  'send.control.back': 'Go back',
  'send.control.confirmText': 'The document will be locked. This cannot be undone from here.',
  'send.control.unknown': 'The workflow is being read.',
  'send.result.sent':
    'Sent. The document is locked and the first participants have been asked to act.',
  'send.result.state': 'Workflow status: {state}',
  'send.result.refused': 'The server found problems that the editor did not. The list is updated.',
  'send.result.forbidden': 'The server refused the send: you may not manage this document.',
  'send.result.not_draft': 'The server says this workflow is no longer a draft.',
  'send.result.failed': 'The send did not go through. Try again.',
  'announce.workflow.sent': 'Sent for completion. The document is locked.',

  // The adoption and signing step (FRW-045, FRW-046). Names and labels are the document's text.
  'signature.intro': 'Choose how it is made. Typing is the default and needs no pointer.',
  'signature.field': 'Field: {label}',
  'signature.preview.label': 'Preview, as text',
  'signature.preview.empty': 'Nothing typed yet.',
  'signature.drawn.canvas': 'Drawing area',
  'signature.drawn.hint': 'Draw with a pointer. If you cannot draw, choose Type it.',
  'signature.drawn.clear': 'Clear the drawing',
  'signature.uploaded.label': 'Image file (PNG or JPEG)',
  'signature.problem.typed': 'Type your name first.',
  'signature.problem.drawn': 'Draw something first.',
  'signature.problem.file': 'Choose a PNG or JPEG image first.',
  'signature.adopt': 'Adopt it',
  'signature.adopting': 'Saving the image.',
  'signature.change': 'Change it',
  'signature.sign': 'Sign this field',
  'signature.result.rejected': 'The image was refused. Choose another, or type your name instead.',
  'signature.result.failed': 'The image could not be saved. Try again.',
  'announce.signature.adopted': 'Signature adopted.',
  'announce.initials.adopted': 'Initials adopted.',
  'announce.signature.signed': 'Signed: {label}.',

  // The math editor (FE-070). The equation's LaTeX is content; the words around it are not.
  'dialog.math.title': 'Edit equation',
  'dialog.math.visual': 'Equation editor',
  'dialog.math.source': 'LaTeX source',
  'dialog.math.hint':
    'Edit the equation above, or type its LaTeX here. Escape closes without changing it.',
  'dialog.math.loading': 'Loading the equation editor.',
  'dialog.math.unavailable':
    'The equation editor could not be loaded. You can still edit the LaTeX source.',
  'dialog.math.readOnly': 'You cannot change this equation.',
  'dialog.math.suggestion': 'An equation cannot be changed in suggestion mode.',
  'dialog.math.refused': 'This equation cannot be changed now.',
  'dialog.math.tooLong': 'The equation is longer than {max} characters.',
  'dialog.math.tooDeep': 'The equation is nested more than {max} levels deep.',
  'dialog.math.rejected': 'The document service did not accept this equation. Your input is kept.',
  'dialog.math.rejectedWhy': 'Reason: {reason}',
  'dialog.math.apply': 'Apply equation',
  'dialog.math.applying': 'Checking the equation.',

  // Comments (UX-028, UX-031). The comment and the names are content.
  'dialog.comment.title': 'New comment',
  'dialog.comment.field': 'Comment',
  'dialog.comment.mentionHint': 'Type @ and a name to mention someone.',
  'dialog.comment.mentions': 'People and groups to mention',
  'dialog.comment.post': 'Post',
  'comment.mention.added': 'Mentioned {name}.',
  'comment.refused.noComment':
    'You do not have permission to comment on this part. Your text is kept.',
  'comment.refused.target': 'This selection cannot take a comment. Your text is kept.',
  'comment.refused.emptyBody': 'Write a comment first.',
  'comment.refused.threadLimit':
    'This document already has the largest number of comment threads it may have. Nothing was added; your text is kept.',
  'comment.refused.permissionsChanged':
    'Your permissions changed, so the comment was not added. Your text is kept.',
  'comment.refused.baseSeqOutOfWindow':
    'The document changed too much since you made the selection. Select the text again; your text is kept.',
  'comment.refused.mentionHidden':
    'A person you mentioned cannot see the part of the document this comment is on, so it was not added. Remove the mention to post it. Your text is kept.',
  'comment.refused.failed': 'The comment could not be added. Your text is kept.',

  // Export (UX-101). Diagnostics' messages come from the service.
  'dialog.export.title': 'Export',
  'dialog.export.target': 'Format',
  'dialog.export.profile': 'Quality',
  'dialog.export.tagging': 'Accessibility tagging',
  'dialog.export.fields': 'Form fields',
  'dialog.export.standard': 'PDF standard',
  'dialog.export.locale': 'Language for dates and text (for example en-GB)',
  'dialog.export.timeZone': 'Time zone (for example Europe/London)',
  'dialog.export.hidden': 'Parts of the document hidden from you are left out of the export.',
  'dialog.export.start': 'Export',
  'dialog.export.again': 'Export again',
  'export.target.pdf': 'PDF',
  'export.target.tex': 'LaTeX bundle',
  'export.target.docx': 'Word file',
  'export.target.cdm': 'Document data',
  'export.target.html': 'Web page',
  'export.target.md': 'Markdown',
  'export.open': 'Open the result',
  'export.converged': 'Page references are final.',
  'export.diagnostics': 'Problems found',
  'export.diagnostics.none': 'No problems found.',
  'export.severity.error': 'Error',
  'export.severity.warning': 'Warning',
  'export.severity.info': 'Note',
  'export.diagnostic.gone': 'That part is no longer in the document.',
  'export.diagnostic.changed': 'Changed since this export',
  'export.diagnostic.moved':
    'The editor has moved to that part. It has changed since this export, so the problem may no longer be there.',
  'export.preflight.title': 'Check before you export',
  'export.preflight.hint':
    'These parts may not typeset well. Nothing has been exported yet: you can continue, or stop and fix them first.',
  'export.preflight.continue': 'Continue',
  'export.preflight.cancel': 'Do not export',
  'export.failed.start': 'The export could not be started.',

  // The PDF preview pane (EXP-001). The job's state and page count use the export strings above.
  'export.showInPane': 'Show in the PDF preview',

  // Client export filters of extensions (UX-055). The format's label is the extension's own text.
  'export.filter.noExport': 'Your access does not allow export.',
  'export.filter.save': 'Save {name}',
  'export.filter.failed': 'This format could not write the file. The document is unchanged.',
} as const satisfies StringTable;

registerSource(EN_GB_DIALOGS);
