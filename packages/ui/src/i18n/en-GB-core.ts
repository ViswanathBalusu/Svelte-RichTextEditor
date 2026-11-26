/**
 * The core of the source string table, in British English (UX-064; 13 §8): the strings the first
 * load shows. It is the only table in the initial bundle that every other locale falls back to;
 * every other locale loads on demand. The strings that only code loaded on demand shows are in
 * `late/<group>.ts` (FND-008); `en-GB.ts` is the whole table. Components never contain a user-visible literal:
 * they show `t(key)` (test/strings-lint.test.ts fails otherwise).
 *
 * A message is a string, or plural forms selected with `Intl.PluralRules`. `{name}` is replaced by
 * a parameter; a number parameter is formatted with `Intl.NumberFormat` for the locale.
 */
import type { StringTable } from './types.ts';

export const EN_GB_CORE = {
  // Shell regions (13 §3).
  'header.label': 'Document header',
  'header.title.fallback': 'Document',
  'header.actions': 'Document actions',
  'toolbar.label': 'Editing',
  'toolbar.more': 'More',
  'toolbar.more.label': {
    one: '{count} more command',
    other: '{count} more commands',
  },
  'toolbar.menu.label': 'More commands',
  'status.label': 'Status',
  'status.scope.body': 'Body',
  'status.scope.region': 'Region: {title}',

  // Commands of phase 1a (13 §4; UX-003). Labels only: the registry holds keys, never text.
  'command.edit.undo': 'Undo',
  'command.edit.redo': 'Redo',
  'command.edit.selectAll': 'Select all',
  'command.format.bold': 'Bold',
  'command.format.italic': 'Italic',
  'command.insert.footnote': 'Footnote',
  'command.page.header': 'Edit header',
  'command.view.outline': 'Navigation',
  'command.view.comments': 'Comments',
  'command.view.catchUp': 'Catch up',
  'command.document.share': 'Share',

  // Commands of phase 1b (ADR 0052).
  'command.format.applyStyle': 'Apply style',
  'command.edit.insertRecovered': 'Insert recovered text',
  'command.edit.discardRecovered': 'Discard recovered text',
  'command.format.painter': 'Format painter',
  'command.format.applyFormat': 'Apply copied formatting',
  'command.format.language': 'Language',
  'command.format.paragraph': 'Paragraph',
  'command.navigate.nextEditableRegion': 'Next part I can edit',
  'command.insert.region': 'Region',
  'command.insert.caption': 'Caption',
  'command.insert.crossReference': 'Cross-reference',
  'command.review.comment': 'New comment',
  'command.insert.field.text': 'Text field',
  'command.insert.field.number': 'Number field',
  'command.insert.field.date': 'Date field',
  'command.insert.field.checkbox': 'Checkbox',
  'command.insert.field.choice': 'Choice field',
  'command.insert.field.signature': 'Signature field',
  'command.insert.field.initials': 'Initials field',
  'command.insert.field.dateSigned': 'Date signed field',
  'command.insert.field.formula': 'Formula field',
  'command.view.find': 'Find',
  'command.view.styles': 'Styles',
  'command.view.recovered': 'Recovered edits',
  'command.view.shortcuts': 'Keyboard shortcuts',
  'command.view.commandSearch': 'Search commands',
  'toolbar.mini.label': 'Formatting near the selection',

  // Command search (UX-011).
  'command.search.label': 'Search commands',
  'command.search.field': 'Command name',
  'command.search.help':
    'Type part of a command name. Use the arrow keys to choose, Enter to run, Escape to close.',
  'access.tip': 'Access key {key}',
  'access.mode': 'Access keys are shown. Press a key to run its command, or Escape to leave.',
  'command.view.permissions': 'Permissions',
  'command.view.fillSummary': 'Fields to fill',
  'command.view.checker': 'Accessibility checker',
  'command.view.zoomIn': 'Zoom in',
  'command.view.zoomOut': 'Zoom out',
  'command.view.zoomReset': 'Reset zoom',
  'command.view.layout.web': 'Web layout',
  'command.view.layout.read': 'Reading',
  'command.view.layout.print': 'Print layout',
  'command.document.export': 'Export',
  'command.document.import': 'Import a file',
  'command.document.print': 'Print',
  'command.page.closeStory': 'Close header and footer',
  'command.mode.edit': 'Editing',
  'command.mode.review': 'Reviewing',
  'command.mode.view': 'Viewing',

  // How suggestions are shown (UX-035). The first four name the views of 13 §5.
  'command.review.next': 'Next suggestion',
  'command.review.previous': 'Previous suggestion',
  'command.review.accept': 'Accept suggestion',
  'command.review.reject': 'Reject suggestion',
  'command.review.acceptAll': 'Accept all suggestions',
  'command.review.rejectAll': 'Reject all suggestions',
  'command.review.markup.all': 'Show all markup',
  'command.review.markup.simple': 'Show simple markup',
  'command.review.markup.none': 'Show no markup',
  'command.review.markup.original': 'Show the original',

  // What a screen reader hears before a suggestion in the text (UX-035 criterion 4).
  'review.suggestion.ins': 'Inserted by {name}',
  'review.suggestion.del': 'Deleted by {name}',
  'review.suggestion.fmt': 'Formatting changed by {name}',
  'review.suggestion.card': '{name}',
  'review.suggestion.cardAt': '{name}, {time}',
  'command.mode.fill': 'Filling in',

  // Task groups of the full toolbar (UX-007). The grouping is this product's own (13 §3).
  'group.edit': 'Edit',
  'group.format': 'Format',
  'group.insert': 'Insert',
  'group.page': 'Page',
  'group.review': 'Review',
  'group.view': 'View',
  'group.table': 'Table',
  'group.picture': 'Picture',
  'group.story': 'Header and footer',
  'group.field': 'Field',
  'group.other': 'More',
  'toolbar.tabs.label': 'Command groups',
  'toolbar.group.label': '{group} commands',
  'toolbar.styles': 'Styles',
  'toolbar.styles.menu': 'Styles of this document',
  'menu.context.label': 'Commands for the selection',

  // Modes (UX-015).
  'mode.label': 'Mode',
  'mode.button': 'Mode: {mode}',
  'mode.menu': 'Modes',
  'reason.mode.trackedForEveryone':
    'Tracked changes are on for everyone, so your edits are recorded as suggestions.',
  'announce.mode': 'Mode: {mode}.',

  // Counts on header buttons, as text (UX-014).
  'count.comments': {
    one: 'Comments, {count} open thread',
    other: 'Comments, {count} open threads',
  },
  'count.catchUp': {
    one: 'Catch up, {count} change since your last visit',
    other: 'Catch up, {count} changes since your last visit',
  },

  // Why a command is unavailable (UX-004; 07 §4, §7).
  'reason.access.view': 'You can view this part of the document but not change it.',
  'reason.access.comment': 'You can comment on this part of the document but not change it.',
  'reason.access.region': 'You have no permission to change this part of the document.',
  'reason.access.approved': 'This part is approved, so nobody can change it.',
  'reason.access.lease': 'Someone else is editing this part at the moment.',
  'reason.access.locked': 'The document is locked.',
  'reason.access.archived': 'The document is archived.',
  'reason.access.workflow': 'The document is out for completion and cannot be changed now.',
  'reason.access.unlisted': 'Your permissions for this new part have not arrived yet.',
  'reason.access.hidden': 'You do not have access to this part of the document.',
  'reason.notApplicable': 'Not available here.',
  'reason.unannounced': 'Not offered by this service.',
  'reason.mode.view': 'The document is open for viewing. Switch to editing to change it.',
  'reason.mode.fill': 'The document is open for filling in: only your fields can be changed.',
  'reason.query.nested': 'A region cannot be placed inside another region.',
  'reason.query.blocks': 'Select whole paragraphs or blocks of the body to make a region.',
  'reason.query.regionLimit': 'The document already has the largest number of regions it may have.',
  'reason.query.fieldLimit': 'The document already has the largest number of fields it may have.',
  'reason.query.subeditor': 'Fields cannot be inserted in headers, footers or footnotes.',
  'reason.query.structure': 'Changing the structure of the document needs permission to do so.',
  'reason.query.none': 'There is no further part you can edit.',
  'reason.query.noFormat': 'Select the text whose formatting you want to copy.',
  'reason.query.noEdit': 'You do not have permission to edit this document.',
  'reason.query.no-export':
    'Your access does not allow export. Restrictions deter casual copying and are not a security boundary.',
  'reason.query.no-print':
    'Your access does not allow printing. Restrictions deter casual copying and are not a security boundary.',
  'reason.query.noSuggest': 'You do not have permission to suggest changes in this document.',
  'reason.query.noFill': 'You have no fields to fill in this document.',
  'reason.query.suggestOnly':
    'You may only suggest changes here, so the editor stays in reviewing.',
  'reason.query.locked': 'The document is locked.',
  'reason.query.archived': 'The document is archived.',
  'reason.query.workflow': 'The document is out for completion and cannot be changed now.',
  'reason.query.noComment': 'You do not have permission to comment on this part of the document.',
  'reason.query.noSuggestions': 'There are no suggestions in this document.',
  'reason.query.noCommentTarget':
    'Select some text, or a figure, table or equation, to comment on it.',
  'reason.query.suggestion':
    'Suggestion mode records changes as suggestions, and this change cannot be recorded as one, so it is not made.',

  // Announcements (UX-004; FE-107).
  'announce.access.lost': 'You can no longer change this part of the document.',
  'announce.access.gained': 'You can now change this part of the document.',

  // The element's live region (FE-107; 02 §10): the save state, collaborators and the two notices
  // the element can be given. Names are resolved by the host (UX-025); no sentence quotes content.
  'announce.sync.saving': 'Saving changes.',
  'announce.sync.saved': 'All changes saved.',
  'announce.sync.unsaved': 'Changes are not saved yet.',
  'announce.sync.readonly': 'This document is read-only.',
  'announce.edit.rejected': 'An edit was not applied at {where}. {reason}',
  'announce.presence.arrived': '{name} joined the document.',
  'announce.presence.left': '{name} left the document.',
  'announce.presence.unknown': 'A collaborator',
  'announce.recovered.count': 'Edits set aside for recovery: {count}.',

  // Changes that did not happen (11 §3; 07 §7, §9; FE-036). Plain words; never the content (ADR 0019).
  'notice.label': 'Change not made',
  'notice.dismiss': 'Dismiss',
  'notice.openRecovered': 'Open recovered edits',
  'notice.refused.scope': 'That change was not made: you cannot change this part of the document.',
  'notice.refused.structure':
    'That change was not made: adding, removing or moving a region needs permission to change the structure of the document.',
  'notice.refused.manage':
    'That change was not made: changing who may edit a region needs permission to manage the document.',
  'notice.refused.readOnly': 'That change was not made: the document is read-only here.',
  'notice.refused.placeholder':
    'That change was not made: parts of the document hidden from you cannot be changed, moved or copied.',
  'notice.refused.redacted': 'That change was not made: a value hidden from you cannot be changed.',
  'notice.refused.identifier':
    'That change was not made: it would change the identity of a part of the document.',
  'notice.refused.step': 'That change was not made: this kind of change cannot be saved.',
  'notice.refused.invariant':
    'That change was not made: it would break the structure of the document.',

  // A change suggestion mode cannot record, such as a column, a merge or a split in a table
  // (FE-045 criterion 5): block suggestions for cells and columns are not defined in version 1.
  'notice.refused.suggestion':
    'That change was not made: suggestion mode cannot record it as a suggestion. Turn suggestion mode off to make it.',
  'notice.refused.noCopy':
    'Nothing was copied: your access does not allow copying from this document. Restrictions deter casual copying and are not a security boundary.',
  'notice.refused.uploadFailed':
    'The picture was not added: it could not be uploaded, or the asset service did not accept the file.',
  'notice.refused.pictureSize':
    'The picture was not added: its size could not be used in the document.',
  'notice.refused.other': 'That change was not made.',

  // What the review commands announce (UX-036). Counts are the suggestions handled and left pending.
  'review.step': '{kind} by {name}: {text}',
  'review.step.noText': '{kind} by {name}.',
  'review.kind.ins': 'Insertion',
  'review.kind.del': 'Deletion',
  'review.kind.fmt': 'Formatting change',
  'review.none': 'There are no suggestions.',

  // The review pane (UX-037).
  'review.nothingHere': 'No suggestion at the cursor or in the selection.',
  'review.accepted': {
    one: '{count} suggestion accepted.',
    other: '{count} suggestions accepted.',
  },
  'review.rejected': {
    one: '{count} suggestion rejected.',
    other: '{count} suggestions rejected.',
  },
  'review.left': {
    one: '{count} suggestion left pending, because you cannot edit that part.',
    other: '{count} suggestions left pending, because you cannot edit those parts.',
  },
  'notice.suggestions.skipped':
    'Not handled: {count} suggestion(s) in parts of the document you cannot change were left as they are.',

  // A deletion refused because a cross-reference still names its target (I4; FE-133). The count is
  // the number of references; the sentence names neither the target nor the references.
  'notice.refused.referenced': {
    one: 'That change was not made: a cross-reference still points to what you tried to delete.',
    other:
      'That change was not made: {count} cross-references still point to what you tried to delete.',
  },
  'notice.action.showReferences': 'Show references',

  // The report of Replace and Replace all (FE-060 criterion 3). `count` is the number replaced;
  // `skipped` is the number left alone. The second message is shown only when something was skipped.
  'notice.replaced.done': {
    one: 'Replaced {count} match.',
    other: 'Replaced {count} matches.',
  },
  'notice.replaced.skipped': {
    one: 'Replaced {count} match. Skipped {skipped}: you cannot change those parts of the document.',
    other:
      'Replaced {count} matches. Skipped {skipped}: you cannot change those parts of the document.',
  },
  'notice.refused.otherUser':
    'Unsent work from an earlier visit belonged to another person and was discarded. It was not sent.',
  'notice.glyph.missing':
    'The font {family} has no glyph for {char}. The PDF takes it from a fallback font if one has it; otherwise the export stops.',
  'notice.glyph.missingDefault':
    'The default font has no glyph for {char}. The PDF takes it from a fallback font if one has it; otherwise the export stops.',
  'notice.trimmed.kept':
    'Part of that deletion was kept: you cannot change some of the text it covered.',
  'notice.rejected.permission': {
    one: 'A change could not be saved because your permissions changed. It is kept in recovered edits.',
    other:
      '{count} changes could not be saved because your permissions changed. They are kept in recovered edits.',
  },
  'notice.rejected.readOnly': {
    one: 'A change could not be saved because the document became read-only. It is kept in recovered edits.',
    other:
      '{count} changes could not be saved because the document became read-only. They are kept in recovered edits.',
  },
  'notice.rejected.invalid': {
    one: 'A change could not be saved because the service did not accept it. It is kept in recovered edits.',
    other:
      '{count} changes could not be saved because the service did not accept them. They are kept in recovered edits.',
  },
  'notice.rejected.conflict': {
    one: 'A change could not be saved because it conflicted with another change. It is kept in recovered edits.',
    other:
      '{count} changes could not be saved because they conflicted with other changes. They are kept in recovered edits.',
  },

  // A fill that lost to another change of the same field (12 §4.2, P9; FRW-010): the field shows the
  // current value and the entry is not merged into it.
  'notice.rejected.fieldConflict': {
    one: 'This field was changed by someone else, so your entry was not saved. The field now shows the current value. Your entry is kept in recovered edits.',
    other:
      '{count} fields were changed by someone else, so your entries were not saved. The fields now show the current values. Your entries are kept in recovered edits.',
  },

  // A fill the service refused because a rule of the document stopped it (12 §5.3; FRW-023): {rule}
  // is the rule's own message, or its identifier when it has none. The field shows the confirmed
  // document again, and the entry is kept in recovered edits.
  'notice.rejected.rule': {
    one: 'Your entry was not saved because a rule of this document stopped it: {rule} The field follows the document as it stands. Your entry is kept in recovered edits.',
    other:
      '{count} entries were not saved because a rule of this document stopped them, the first one: {rule} The fields follow the document as it stands. Your entries are kept in recovered edits.',
  },
  'notice.rejected.field': {
    one: 'A field value could not be saved because it is not valid. It is kept in recovered edits.',
    other:
      '{count} field values could not be saved because they are not valid. They are kept in recovered edits.',
  },
  'notice.rejected.tooLarge': {
    one: 'A change could not be saved because it is too large. It is kept in recovered edits.',
    other:
      '{count} changes could not be saved because they are too large. They are kept in recovered edits.',
  },
  'notice.rejected.rebase': {
    one: 'A change could not be combined with other people’s changes. It is kept in recovered edits.',
    other:
      '{count} changes could not be combined with other people’s changes. They are kept in recovered edits.',
  },
  'notice.rejected.reload': {
    one: 'The document was reloaded. A change that was not yet saved is kept in recovered edits.',
    other:
      'The document was reloaded. {count} changes that were not yet saved are kept in recovered edits.',
  },
  'notice.rejected.other': {
    one: 'A change could not be saved. It is kept in recovered edits.',
    other: '{count} changes could not be saved. They are kept in recovered edits.',
  },

  // Save and connection state (UX-016; 02 §2.2). Shown as text, never by colour alone.
  'save.label': 'Save state',
  'save.saved': 'Saved',
  'save.saving': 'Saving',
  'save.unsaved': 'Not yet saved',
  'save.readonly': 'Read-only',
  'connection.online': 'Online',
  'connection.reconnecting': 'Reconnecting',
  'connection.offline': 'Offline',

  // Presence (UX-026; 13 §5).
  'presence.label': 'People in this document',
  'presence.person.active': '{name}',
  'presence.person.idle': '{name}, idle',
  'presence.idle': 'Idle',
  'presence.more': '+{count}',
  'presence.more.label': {
    one: '{count} more person in this document',
    other: '{count} more people in this document',
  },
  'presence.all.label': 'Everyone in this document',
  'people.fallback': 'Collaborator',

  // Panels and panes (13 §3; UX-019).
  'panel.footnote': 'Footnote',
  'panel.story': 'Header',
  'panel.footer': 'Footer',

  // The variants of a header or footer (FE-057): the pages each is used on.
  'panel.variants': 'Header and footer variants',
  'panel.variant.default': 'Every page',
  'panel.variant.first': 'First page',
  'panel.variant.even': 'Even pages',
  'panel.close': 'Close',
  'pane.outline': 'Navigation',
  'pane.comments': 'Comments',
  'pane.catch-up': 'Catch up',
  'pane.styles': 'Styles',
  'pane.recovered': 'Recovered edits',
  'pane.shortcuts': 'Keyboard shortcuts',
  'pane.permissions': 'Permissions',
  'pane.fill': 'Fields to fill',
  'pane.review': 'Review',
  'pane.history': 'History',
  'pane.fields': 'Fields',
  'pane.checker': 'Accessibility checker',

  // The accessibility checker pane (UX-066, UX-067): kinds grouped, each issue with its block.
  'pane.assistant': 'Assistant',

  // The assistant pane (UX-045). The answer and the prompt are content; the rest is interface.
  'command.view.assistant': 'Assistant',
  'synonyms.view.assistant': 'ai; draft; rewrite; summarise; ask a question',
  'assistant.label': 'Assistant',
  'assistant.prompt': 'What should the assistant do?',
  'assistant.prompt.hint':
    'Nothing in the document changes until you approve it. The answer is shown here first.',
  'assistant.draft': 'Draft',
  'assistant.rewrite': 'Rewrite selection',
  'assistant.summary': 'Summarise',
  'assistant.question': 'Ask a question',
  'assistant.cancel': 'Cancel',
  'assistant.retry': 'Try again',
  'assistant.dismiss': 'Clear',
  'assistant.insert': 'Insert as suggestion',
  'assistant.notices': 'What the editor changed in the answer',
  'assistant.notice.link-blocked':
    'A link the assistant added is shown as text and is not a link: {target}',
  'assistant.notice.image-blocked': 'A picture the assistant added was left out: {target}',
  'assistant.notice.image-not-inserted':
    'An attached picture named in the answer is not inserted by this pane: {target}',
  'assistant.insert.refused':
    'The result was not inserted: you cannot suggest changes here. Nothing was applied.',
  'assistant.inserted':
    'The result was inserted as suggestions. Review them in the review pane before they take effect.',
  'assistant.response': 'Response',
  'assistant.progress': 'The assistant is working.',
  'assistant.done':
    'The assistant has answered. The answer is in the pane and the document is unchanged.',
  'assistant.cancelled': 'The request was cancelled. Nothing was applied.',
  'assistant.error.rate_limited':
    'The assistant is busy: too many requests. Nothing was applied. You can try again.',
  'assistant.error.quota_exceeded':
    'The assistant quota has been used up. Nothing was applied. You can try again later.',
  'assistant.error.port_failure':
    'The assistant did not answer. Nothing was applied. You can try again.',
  'assistant.refused.no-view': 'You cannot view this part of the document.',
  'assistant.refused.no-change':
    'A draft or a rewrite would put text into the document, and your access here does not allow that.',
  'pane.pdf': 'PDF preview',
  'pane.failed': 'This pane could not be opened.',
  'pane.close': 'Close {pane}',
  'pane.loading': 'Loading {pane}',
  'landmark.page': 'Document page',

  // Navigation pane (UX-020). Headings and matches are content.
  'search.results': {
    one: '{count} result',
    other: '{count} results',
  },
  'search.none': 'No results',

  // Other words for a command, for the command search (UX-011 criterion 2; proposed in
  // docs/adr/0383-w3-UX-011-command-synonyms.md). One key per command, `synonyms.<command id>`,
  // and the words are separated by semicolons. A locale lists the words people use in that locale.
  'synonyms.edit.undo': 'revert; step back; go back',
  'synonyms.edit.redo': 'repeat; step forward',
  'synonyms.edit.selectAll': 'highlight everything; mark all',
  'synonyms.format.bold': 'strong; heavy; thick',
  'synonyms.format.italic': 'slant; emphasis; oblique',
  'synonyms.insert.footnote': 'note at the foot; reference note',
  'synonyms.page.header': 'running head; page top',
  'synonyms.view.outline': 'headings; contents; table of contents',
  'synonyms.view.comments': 'notes; remarks; feedback; discussion',
  'synonyms.view.catchUp': 'what changed; missed changes; since last visit',
  'synonyms.document.share': 'invite; give access; collaborate',
  'synonyms.format.painter': 'copy format; copy style; brush',
  'synonyms.format.language': 'proofing language; spelling language',
  'synonyms.view.find': 'search; replace; look for',
  'synonyms.view.styles': 'formatting presets; paragraph styles',
  'synonyms.view.shortcuts': 'hotkeys; keys; key bindings',
  'synonyms.view.permissions': 'access; who can edit; rights; locks',
  'synonyms.view.checker': 'accessibility; alt text; contrast',
  'synonyms.view.history': 'versions; earlier; changes over time; restore',
  'synonyms.history.nameVersion': 'save version; milestone; label version',
  'synonyms.review.comment': 'add comment; annotate; leave a note',
  'synonyms.document.export': 'save as; download; pdf; convert; latex',
  'synonyms.document.print': 'paper; hard copy',
  'synonyms.view.zoomIn': 'bigger; magnify; enlarge',
  'synonyms.view.zoomOut': 'smaller; shrink',
  'synonyms.view.zoomReset': 'actual size; hundred per cent',
  'synonyms.mode.edit': 'write; change',
  'synonyms.mode.review': 'track changes; suggest',
  'synonyms.mode.view': 'read only; read',
  'synonyms.view.review': 'suggestions; track changes; changes; list of changes; review',
  'synonyms.review.next': 'track changes; review; go to change; find suggestion',
  'synonyms.review.previous': 'track changes; review; go back; earlier suggestion',
  'synonyms.review.accept': 'track changes; approve; keep change; take change',
  'synonyms.review.reject': 'track changes; decline; undo change; discard change',
  'synonyms.review.acceptAll': 'track changes; approve all; keep all changes',
  'synonyms.review.rejectAll': 'track changes; decline all; discard all changes',
  'synonyms.review.markup.all': 'markup; track changes; suggestions; show changes',
  'synonyms.review.markup.simple': 'markup; track changes; suggestions; bars',
  'synonyms.review.markup.none': 'markup; final; accepted; clean',
  'synonyms.review.markup.original': 'markup; before changes; rejected; unchanged text',
  'search.list': 'Results',

  // Styles (UX-022). Style names are content.
  'styles.why.read-only': 'The document is locked, so its styles cannot be changed.',
  'styles.why.suggestion':
    'You are suggesting changes, and a change to a style cannot be a suggestion.',
  'styles.why.no-access':
    'Creating, changing and deleting styles needs permission to change the structure of the document, which you do not have. You can still apply a style.',
  'styles.why.region': {
    one: 'This style is used in the region {regions}, which you cannot edit, so you cannot change it.',
    other:
      'This style is used in the regions {regions}, which you cannot edit, so you cannot change it.',
  },
  'styles.why.approved': {
    one: 'This style is used in the region {regions}, which is approved, so it cannot be changed.',
    other:
      'This style is used in the regions {regions}, which are approved, so it cannot be changed.',
  },
  'styles.why.built-in': 'A built-in style cannot be renamed or deleted.',
  'styles.why.in-use': 'This style is in use, so it cannot be deleted.',
  'styles.why.duplicate-name': 'Another style of this kind has that name.',
  'styles.why.bad-name': 'Give the style a name.',
  'styles.why.bad-based-on':
    'A style can be based only on another style of its kind, and not on itself or on a style based on it.',
  'styles.why.unknown-style': 'That style is no longer in the document.',

  // Sources (UX-103). Titles, names, identifiers and excerpts are content.
  'command.view.sources': 'Sources',
  'command.view.review': 'Review pane',
  'pane.sources': 'Sources',

  // The roles manager and the legend (FRW-074). Role names and field labels are the document's.
  'command.view.roles': 'Roles',
  'pane.roles': 'Roles',
  'roles.icon.circle': 'circle',
  'roles.icon.square': 'square',
  'roles.icon.triangle': 'triangle',
  'roles.icon.diamond': 'diamond',
  'roles.icon.pentagon': 'pentagon',
  'roles.icon.hexagon': 'hexagon',
  'roles.icon.star': 'star',
  'roles.icon.cross': 'cross',
  'roles.legend': 'Roles',

  // Keyboard shortcuts (UX-013): the reference, built from the registry and the shortcut table.
  'key.Control': 'Ctrl',
  'key.Shift': 'Shift',
  'key.Alt': 'Alt',
  'key.Meta': 'Command',
  'key.Enter': 'Enter',
  'key.Escape': 'Esc',
  'key.ContextMenu': 'Menu key',
  'shortcuts.when.surface': 'In the document',
  'shortcuts.when.painter': 'While the format painter is on',
  'shortcuts.shell.nextLandmark': 'Move to the next part of the editor',
  'shortcuts.shell.previousLandmark': 'Move to the previous part of the editor',
  'shortcuts.shell.contextMenu': 'Open the context menu',
  'shortcuts.shell.miniToolbar': 'Move focus to the mini toolbar',
  'shortcuts.shell.applyFormat': 'Apply the copied formatting to the selection',
  'shortcuts.shell.cancel': 'Turn the format painter off',

  // The format painter (UX-009).
  'announce.painter.armed':
    'Format painter on. Select the text to format, then press Enter, or press Escape to stop.',
  'announce.painter.applied': 'Formatting applied.',
  'announce.painter.off': 'Format painter off.',

  // Status bar (UX-018).
  'status.words': {
    one: '{count} word',
    other: '{count} words',
  },
  'status.pages': {
    one: '{count} page in the PDF',
    other: '{count} pages in the PDF',
  },
  'status.pages.stale': {
    one: '{count} page in the last PDF, made before the latest changes',
    other: '{count} pages in the last PDF, made before the latest changes',
  },
  'status.language': 'Language: {language}',
  'status.language.default': '{language}, the document’s language',
  'status.language.none': 'No language set',
  'status.classification': 'Classification: {label}',
  'status.zoom': 'Zoom',
  'status.zoom.level': 'Zoom level {level}',

  // Dialogs (UX-068: focus moves in and back, Escape closes, the dialog part).
  'dialog.close': 'Close',
  'dialog.crossRef.kind.all': 'Everything',
  'dialog.crossRef.kind.heading': 'Headings',
  'dialog.crossRef.kind.numbered': 'Numbered paragraphs',
  'dialog.crossRef.kind.caption': 'Captions',
  'dialog.crossRef.kind.equation': 'Equations',
  'dialog.crossRef.kind.bookmark': 'Bookmarks',

  // The send dialog (FRW-028; 12 §6.2): the pre-send checklist and the send control.
  'command.workflow.send': 'Send for completion',
  'synonyms.workflow.send': 'send; request signatures; start workflow; send for signing',
  'send.check.required_fields': 'Every required field has someone to fill it',
  'send.check.roles': 'Every role has a participant',
  'send.check.rules': 'The rules are valid',
  'send.check.suggestions': 'No suggestion is unresolved',
  'send.check.passed': 'Passed',
  'send.check.failed': 'Failed',
  'send.check.count': {
    one: '{count} problem',
    other: '{count} problems',
  },
  'send.check.announce': {
    one: '{count} check failed.',
    other: '{count} checks failed.',
  },
  'send.check.announce.none': 'All checks passed.',
  'send.control.forbidden': 'You need the right to manage this document to send it.',
  'send.control.not_draft': 'This workflow has already been sent.',
  'send.control.checks_failed': 'Fix the failed checks to send.',
  'send.state.draft': 'draft',
  'send.state.sent': 'sent',
  'send.state.in_progress': 'in progress',
  'send.state.correcting': 'being corrected',
  'send.state.completed': 'completed',
  'send.state.finalised': 'finalised',
  'send.state.voided': 'voided',
  'send.state.declined': 'declined',
  'send.state.expired': 'expired',

  // The lock a workflow puts on the document (FRW-029 criterion 6).
  'workflow.banner.label': 'Workflow status',
  'workflow.banner.running':
    'Out for completion. The document is locked: people can only fill the fields assigned to them.',
  'workflow.banner.declined': 'The workflow was declined. The document stays locked.',
  'workflow.banner.voided': 'The workflow was voided. The document stays locked.',
  'workflow.banner.actors': 'May act now: {names}.',
  'workflow.banner.nobody': 'No one has to act now.',

  // The adoption and signing step (FRW-045, FRW-046). Names and labels are the document's text.
  'dialog.sign.title.signature': 'Adopt and use your signature',
  'dialog.sign.title.initials': 'Adopt and use your initials',
  'signature.mode.label': 'How to make it',
  'signature.mode.typed': 'Type it',
  'signature.mode.drawn': 'Draw it',
  'signature.mode.uploaded': 'Upload an image',
  'signature.typed.signature': 'Your name as it will appear',
  'signature.typed.initials': 'Your initials',
  'signature.adopted.signature': 'Your signature is adopted: {mode}.',
  'signature.adopted.initials': 'Your initials are adopted: {mode}.',
  'signature.switch.signature': 'Adopt my signature instead',
  'signature.switch.initials': 'Adopt my initials instead',
  'signature.sign.consent': 'Accept the consent text before signing.',
  'signature.sign.forbidden': 'You may not sign this field.',
  'signature.sign.not_active': 'It is not your turn to sign.',
  'signature.sign.failed': 'The field could not be signed. Try again.',
  'workflow.banner.reuse': 'Copy to a new document',
  'workflow.banner.reuseRequested':
    'Asked to copy the document as it was sent into a new document.',
  'notice.refused.workflow':
    'That change was not made: the document is out for completion and is locked.',
  'notice.rejected.workflow': {
    one: 'A change could not be saved because the document is out for completion and locked. It is kept in recovered edits.',
    other:
      '{count} changes could not be saved because the document is out for completion and locked. They are kept in recovered edits.',
  },
  'announce.version.named': 'Version named.',
  'announce.region.created': 'Region made.',
  'announce.region.failed': 'The region could not be made.',
  'announce.language.set': 'Language set.',
  'announce.language.failed': 'The language could not be set here.',
  'announce.crossRef.inserted': 'Cross-reference inserted.',
  'announce.crossRef.failed': 'The cross-reference could not be inserted here.',
  'announce.altText.set': 'Alternative text set.',
  'announce.altText.failed': 'The alternative text could not be set here.',

  // The math editor (FE-070). The equation's LaTeX is content; the words around it are not.
  'announce.equation.set': 'Equation changed.',
  'announce.equation.rejected': 'The equation was not accepted.',

  // Comments (UX-028, UX-031). The comment and the names are content.
  'dialog.comment.mentionNone': 'Nobody found.',
  'comment.mention.results': {
    one: '{count} person or group found.',
    other: '{count} people or groups found.',
  },
  'announce.comment.created': 'Comment added.',

  // Export (UX-101). Diagnostics' messages come from the service.
  'export.standard.default': 'The service default',
  'export.standard.ua-2': 'PDF/UA-2 (accessible)',
  'export.standard.a-4': 'PDF/A-4 (archival)',
  'dialog.export.cancel': 'Cancel the export',
  'export.profile.preview': 'Quick preview',
  'export.profile.final': 'Final',
  'export.tagging.on': 'Tagged',
  'export.tagging.draft': 'Tagged in draft form',
  'export.tagging.off': 'Not tagged',
  'export.fields.flatten': 'As fixed text',
  'export.fields.blank': 'Left blank',
  'export.state.queued': 'Waiting to start',
  'export.state.converting': 'Converting',
  'export.state.compiling': 'Typesetting',
  'export.state.completed': 'Finished',
  'export.state.failed': 'Failed',
  'export.state.cancelled': 'Cancelled',
  'export.progress': 'Export progress',
  'export.pages': {
    one: '{count} page',
    other: '{count} pages',
  },
  'export.notConverged': 'Page references may still change: export again for final numbers.',

  // Client export filters of extensions (UX-055). The format's label is the extension's own text.
  'announce.export.completed': 'The export has finished.',
  'announce.import.completed': 'The file has been imported.',
  'announce.import.failed': 'The file could not be imported. The document is unchanged.',
  'announce.export.failed': 'The export failed.',
  'announce.export.cancelled': 'The export was cancelled.',

  // Regions and permissions (PRM-026, PRM-033, PRM-035, PRM-036). Titles and names are content.
  'region.indicator': 'Read-only',
  'region.indicator.suggest': 'Suggestions only',
  'region.editors.none': 'Nobody can edit it at the moment.',
  'region.editors.names': 'It can be edited by {names}.',
  'region.editors.namesAndRoles': 'It can be edited by {names}, and by document {roles}.',
  'region.editors.roles': 'It can be edited by document {roles}.',
  'region.editors.lease': '{name} is editing it at the moment.',
  'region.editors.leaseUntil': '{name} is editing it at the moment. The lease expires {when}.',
  'region.editors.approved': 'It is approved, so nobody can edit it.',
  'region.lock.approved': 'It is approved. An owner must change its state before it can be edited.',
  'region.role.owner': 'owners',
  'region.role.editor': 'editors',
  'announce.region.readOnly': 'You cannot edit this part. {who}',
  'announce.region.readOnlyTitled': '{title}: you cannot edit this part. {who}',
  'permissions.hiddenRegion': 'A part hidden from you',
  'permissions.state.draft': 'Draft',
  'permissions.state.in_review': 'In review',
  'permissions.state.approved': 'Approved',
  'permissions.policy.label': 'Who may edit',
  'permissions.policy.inherit': 'Document editors and the people named here',
  'permissions.policy.restricted': 'Only the people named here',
  'permissions.policy.confidential': 'Only the people named here, and only they may read it',
  'permissions.policy.inherit.help':
    'Document editors and owners can edit this region, and so can the people given a role on it here.',
  'permissions.policy.restricted.help':
    'Only the people given a role here, and document owners, can edit this region. Other document editors can view and comment. A role cannot be given to everyone on a region like this.',
  'permissions.policy.set': 'Who may edit changed.',
  'permissions.policy.failed': 'Who may edit could not be changed.',
  'permissions.region': 'Region',
  'permissions.unknownPrincipal': 'Unknown person or group',
  'role.viewer': 'Viewer',
  'role.commenter': 'Commenter',
  'role.suggester': 'Suggester',
  'role.editor': 'Editor',
  'principal.group': 'Group',
  'principal.user': 'Person',
  'principal.everyone': 'Everyone',
  'principal.role': 'Workflow role',

  // Fill mode (FRW-076, FRW-078). Field labels are content.
  'fill.progress': {
    one: '{done} of {count} required field filled',
    other: '{done} of {count} required fields filled',
  },

  // The access code of a participant (FRW-039). The code is never shown back or kept.
  'fill.summary.empty': 'Nothing is left to fill.',
  'fill.why.required': 'Required, not filled',
  'fill.why.format': 'Not in the expected form',
  'fill.why.range': 'Out of the allowed range',
  'fill.why.other': 'Not valid',
  'fill.finished': 'You have finished.',

  // Preview as a role (FRW-075). Role names are content.
  'rolePreview.label': 'Preview as a role',
  'rolePreview.active': 'Previewing as {role}. What you enter here is not saved.',
  'rolePreview.leave': 'Leave preview',
  'announce.rolePreview.on': 'Preview as {role} started. What you enter here is not saved.',
  'announce.rolePreview.off': 'Preview ended. The document is as it was.',
  'fill.finishFailed': 'Finishing did not work.',

  // Role markers of fields (FRW-074, FRW-077). The palette's names are `command.insert.field.*`.
  // Field labels and role names are content.
  'fill.fields': 'Fields in this document',
  'field.mine': 'Yours',
  'field.readOnly': 'Read-only',
  'field.role.none': 'No role',
  'field.role.hidden': 'A role you do not hold',
  'field.name.mine': '{label}, {role}, yours to fill in',
  'field.name.mineUnnamed': '{label}, yours to fill in',
  'field.name.other': '{label}, {role}, not yours to fill in',
  'field.name.none': '{label}, not assigned to a role, not yours to fill in',

  // The field properties panel (FRW-073). Property names, reasons and the panel's own messages.
  'command.view.fieldProperties': 'Field properties',
  'command.view.rules': 'Rules',
  'pane.rules': 'Rules',

  // The rule builder (FRW-024; 12 §5, §11). Every fragment of a rule's sentence is a string here.
  'rule.effect.show': 'show {fields}',
  'rule.effect.hide': 'hide {fields}',
  'rule.effect.require': 'require {fields}',
  'rule.effect.enable': 'enable {fields}',
  'rule.effect.disable': 'disable {fields}',
  'rule.form.new': 'New rule',
  'rule.form.change': 'Change rule',
  'rule.form.id': 'Rule name',
  'rule.form.condition': 'Condition',
  'rule.form.left': 'Left side',
  'rule.form.right': 'Right side',
  'rule.form.operator': 'Comparison',
  'rule.form.kind': 'Kind of value',
  'rule.form.kind.field': 'A field',
  'rule.form.kind.literal': 'A value',
  'rule.form.field': 'Field',
  'rule.form.value': 'Value',
  'rule.form.then': 'Then',
  'rule.form.otherwise': 'Otherwise',
  'rule.form.hasOtherwise': 'Add an otherwise',
  'rule.form.effect': 'Effect',
  'rule.form.effectField': 'Field of the effect',
  'rule.form.addEffect': 'Add an effect',
  'rule.form.removeEffect': 'Remove this effect',
  'rule.form.choose': 'Choose a field',
  'rule.form.save': 'Save the rule',
  'rule.form.cancel': 'Cancel',
  'rule.form.preview': 'Sentence',
  'rule.problem.id': 'Give the rule a name.',
  'rule.problem.left': 'Choose the left side of the comparison.',
  'rule.problem.right': 'Give the right side of the comparison.',
  'rule.problem.effect': 'Give each effect a field.',
  'rule.problem.otherwiseEffect': 'Give each otherwise effect a field.',
  'rule.refused.read-only': 'You cannot change the rules of this document.',
  'rule.refused.no-feature': 'This document does not support rules.',
  'rule.refused.duplicate': 'Another rule already has this name.',
  'rule.refused.not-defined': 'This rule is no longer in the document.',
  'rule.refused.no-change': 'Nothing has changed.',
  'rule.refused.rule_limit': 'A document has at most {limit} rules.',
  'rule.refused.invalid_rules': 'The document would not be valid with this rule:',
  'field.prop.key': 'Key',
  'field.prop.kind': 'Kind',
  'field.prop.label': 'Label',
  'field.prop.assignee': 'Assignee (role)',
  'field.prop.required': 'Required',
  'field.prop.readOnly': 'Read-only',
  'field.prop.default': 'Default value',
  'field.prop.placeholder': 'Placeholder',
  'field.prop.options': 'Options',
  'field.prop.format': 'Format (JSON object)',
  'field.prop.validation': 'Validation (JSON object)',
  'field.prop.width': 'Width (points)',
  'field.problem.emptyKey': 'The key is empty.',
  'field.problem.duplicateKey': 'Another field already uses this key.',
  'field.problem.unknownKind': 'This kind is not offered.',
  'field.problem.assigneeNotRole': 'The assignee is not a role of this document.',
  'field.problem.optionsNeeded': 'A choice field needs at least one option.',
  'field.problem.emptyOptionId': 'An option has an empty identifier.',
  'field.problem.duplicateOption': 'Two options share an identifier.',
  'field.problem.badLimit': 'A validation limit is not valid.',
  'field.problem.badWidth': 'The width must be a positive number.',
  'field.problem.badJson': 'This is not a JSON object.',

  // Hidden content (UX-104; ADR 0019): plain words, never who has access.
  'hidden.request': 'Ask for access',
  'hidden.requested': 'Your request for access was passed on.',

  // The history pane (HIS-009; 08 §4).
  'command.view.history': 'History',
  'command.history.nameVersion': 'Name this version',
  'history.unknown-person': 'Unknown person',

  // Comparing two versions (HIS-013; 08 §6).
  'history.compare.kind.modified': 'text changed',
  'history.compare.kind.added': 'added',
  'history.compare.kind.removed': 'removed',
  'history.compare.kind.moved': 'moved',
  'history.compare.kind.formatted': 'formatting changed',
  'history.compare.kind.field': 'field value changed',
  'history.compare.kind.definition': 'style or setting changed',
  'history.compare.region.none': 'Outside regions',
  'history.compare.region.row': {
    one: '{region}: {count} change',
    other: '{region}: {count} changes',
  },

  // Names of the core's own surfaces (CoreApi.setLabels).
  'surface.body': 'Document',
  'surface.footnote': 'Footnote text',
  'surface.story': 'Header',
  'surface.footer': 'Footer',

  // Spelling and grammar findings (UX-041, UX-042; 13 §6.1). Shown only with a proofing port.
  'command.proofing.next': 'Next spelling or grammar issue',
  'command.proofing.previous': 'Previous spelling or grammar issue',
  'status.proofing.label': 'Spelling and grammar',
  'status.proofing.checking': 'Checking spelling and grammar',
  'status.proofing.unavailable': 'Spelling and grammar check is not available',
  'status.proofing.none': 'No spelling or grammar issues',
  'status.proofing.count': {
    one: '{count} spelling or grammar issue',
    other: '{count} spelling or grammar issues',
  },
  'proofing.kind.spelling': 'Spelling',
  'proofing.kind.grammar': 'Grammar',
  'proofing.kind.other': 'Issue',
  'proofing.finding': '{kind}: {text}. {message}',
  'proofing.finding.suggestions': 'Suggestions: {suggestions}.',
  'proofing.finding.nosuggestions': 'No suggestions.',
  'proofing.none': 'No spelling or grammar issues to move to',
  'menu.proofing.label': 'Spelling and grammar',
  'menu.proofing.apply': 'Change to {suggestion}',
  'menu.proofing.ignoreOnce': 'Ignore once',
  'menu.proofing.ignoreAll': 'Ignore all',
  'menu.proofing.addWord': 'Add to dictionary',
  'proofing.applied': 'Changed to {suggestion}',
  'proofing.ignored': 'Ignored',
  'proofing.wordAdded': 'Added to the dictionary',
} as const satisfies StringTable;
