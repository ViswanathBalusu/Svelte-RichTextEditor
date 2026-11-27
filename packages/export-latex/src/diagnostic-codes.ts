/**
 * The codes the converter and the direct writers (HTML, Markdown) put into a result (09 §9.2;
 * EXP-065 criterion 4). Every code a job can carry is in this table or in the export worker's own
 * catalogue (`services/export-worker/src/diagnostics.ts`); the worker publishes both in
 * `spec/export/diagnostic-codes-1.json`, versioned with the class.
 *
 * The type of a code in `diag`, `warnOnce` and `note` is `DiagnosticCode`, so a code that is not in
 * this table does not compile: a new diagnostic needs a line here, with its severity and a
 * sentence, before it can be written. Codes never change once published; a message may.
 *
 * `severity` is the usual one. A code whose severity depends on the profile says so in `note`.
 * Universal: no Node.js or browser API.
 */

export interface DiagnosticCodeInfo {
  readonly severity: 'error' | 'warning' | 'info';
  /** What the code means, in one sentence, without the parts that change from case to case. */
  readonly message: string;
  /** Where it appears or when its severity differs. */
  readonly note?: string;
}

const write = 'The HTML and Markdown writers';

export const DIAGNOSTIC_CODES = {
  align_distribute: {
    severity: 'warning',
    message: 'Distributed alignment is set as justified.',
  },
  alignment_omitted: {
    severity: 'warning',
    message: 'An alignment HTML or Markdown cannot express is written as the start alignment.',
    note: `${write}.`,
  },
  asset_not_attached: {
    severity: 'warning',
    message: 'A picture refers to an asset the job does not list; a placeholder is printed.',
  },
  asset_not_ready: {
    severity: 'warning',
    message: 'A picture refers to an asset that is not ready; a placeholder is printed.',
  },
  asset_type_unsupported: {
    severity: 'warning',
    message: 'A picture has a media type the typesetter does not place; a placeholder is printed.',
  },
  bibliography_empty: { severity: 'info', message: 'The bibliography has no entries.' },
  bibliography_omitted: {
    severity: 'warning',
    message: 'The generated bibliography is not written in HTML or Markdown.',
    note: `${write}.`,
  },
  block_suggestion_plain: {
    severity: 'info',
    message: 'A suggested paragraph is written without a mark.',
    note: 'The Markdown writer.',
  },
  block_taller_than_page: {
    severity: 'warning',
    message: 'A block in a table row is taller than a page and cannot be split.',
  },
  block_unsupported: { severity: 'warning', message: 'A block of this type prints a placeholder.' },
  bullet_replaced: {
    severity: 'info',
    message: 'Bullet characters are written as a hyphen.',
    note: 'The Markdown writer.',
  },
  caps_plain: {
    severity: 'warning',
    message: 'Small capitals and all capitals are written as typed.',
    note: 'The HTML writer.',
  },
  cell_content_omitted: {
    severity: 'warning',
    message: 'A kind of content in a table cell is not written in HTML or Markdown.',
    note: `${write}.`,
  },
  citation_not_generated: {
    severity: 'warning',
    message: 'A citation without a generated text is not written in HTML or Markdown.',
    note: `${write}.`,
  },
  citation_source_missing: {
    severity: 'warning',
    message: 'A citation names a source the document does not define; it prints [?].',
  },
  citation_style_unknown: {
    severity: 'warning',
    message: 'The requested citation style is not known; the style of the document is used.',
  },
  colour_invalid: {
    severity: 'warning',
    message: 'A colour is not six hexadecimal digits; none is written.',
  },
  colour_not_written: {
    severity: 'warning',
    message: 'A colour that is not a six-digit hexadecimal value is not written.',
    note: 'The HTML writer.',
  },
  comment_detached: {
    severity: 'warning',
    message: 'The range of a comment thread has no text left; it is listed at the end.',
  },
  comment_not_in_margin: {
    severity: 'warning',
    message:
      'A comment thread stands where a margin note cannot be placed; it is listed at the end.',
  },
  comments_truncated: {
    severity: 'warning',
    message: 'Only the first comment threads, or the first messages of a thread, are printed.',
  },
  continuous_break_geometry: {
    severity: 'warning',
    message:
      'A continuous section break that changes the page size or margins cannot be honoured; they stay until the next page section.',
  },
  date_field_invalid: { severity: 'error', message: 'A date field cannot be printed.' },
  date_without_job_time: {
    severity: 'error',
    message: 'A date field needs the job instant and time zone; it prints nothing.',
  },
  enum_unknown: {
    severity: 'warning',
    message: 'A value has no entry in the table of its kind; the default is used.',
  },
  equation_as_code: {
    severity: 'warning',
    message: 'Equations are written as LaTeX source in code, not rendered.',
    note: 'The Markdown writer.',
  },
  equation_as_source: {
    severity: 'warning',
    message: 'Equations are written as LaTeX source in code, not rendered.',
    note: 'The HTML writer.',
  },
  extension_omitted: {
    severity: 'warning',
    message: 'Host extension content is written as its fallback text, or not at all.',
    note: 'The HTML and Markdown writers.',
  },
  fallback_asset_missing: {
    severity: 'warning',
    message:
      'An extension or preserved block names a fallback asset the job does not list; its fallback text is printed.',
  },
  field_not_computed: {
    severity: 'warning',
    message: 'A field is written from its cached result, or not at all.',
  },
  font_family_missing: {
    severity: 'warning',
    message:
      'A font family is not in the font manifest; the default family and the fallback chain are used.',
  },
  font_family_not_written: {
    severity: 'warning',
    message: 'A font family name outside the pattern of the model is not written.',
    note: 'The HTML writer.',
  },
  font_server_use_not_permitted: {
    severity: 'warning',
    message:
      'A font family is not permitted for server-side use; it is used on screen only, and the PDF takes the default family and the fallback chain.',
  },
  font_size_not_written: {
    severity: 'warning',
    message: 'A font size outside 20 to 32760 twips is not written.',
    note: 'The HTML writer.',
  },
  footnote_in_story: {
    severity: 'warning',
    message: 'A footnote in a header or footer is not set.',
  },
  footnote_paragraphs: {
    severity: 'warning',
    message: 'Only the first paragraph of a footnote is set.',
  },
  form_field_omitted: {
    severity: 'warning',
    message: 'Form fields are not written in HTML or Markdown.',
    note: `${write}.`,
  },
  form_value_not_printed: {
    severity: 'warning',
    message: 'The value of a form field is not printed.',
  },
  formatting_suggestion_plain: {
    severity: 'info',
    message: 'Formatting suggestions are written with their current formatting.',
    note: 'The Markdown writer.',
  },
  glyph_missing: {
    severity: 'warning',
    message: 'No font of the manifest has a character of the text.',
    note: 'An error in a final export (EXP-026), a warning in a preview.',
  },
  headers_footers_omitted: {
    severity: 'warning',
    message: 'Headers, footers and other stories are not written in HTML.',
    note: 'The HTML writer.',
  },
  heading_level_clamped: {
    severity: 'warning',
    message: 'Headings below level 6 are written as level 6.',
    note: `${write}.`,
  },
  hidden_region_omitted: {
    severity: 'info',
    message: 'A region the reader may not see is not written.',
    note: `${write}.`,
  },
  hidden_text: { severity: 'warning', message: 'Hidden text is left out of the PDF.' },
  highlight_not_written: {
    severity: 'warning',
    message: 'A highlight colour outside the model list is not written.',
    note: 'The HTML writer.',
  },
  image_asset_missing: {
    severity: 'warning',
    message: 'A picture is not in the document assets; its alternative text is written instead.',
    note: `${write}.`,
  },
  image_without_alt: {
    severity: 'warning',
    message: 'A picture has no alternative text.',
  },
  inline_unsupported: {
    severity: 'warning',
    message: 'An inline node of this type prints a placeholder.',
  },
  language_unknown: {
    severity: 'warning',
    message: 'A language has no entry; the document language, or English, is used.',
  },
  line_break_in_text: {
    severity: 'info',
    message: 'A line break inside a text is written as a space.',
    note: 'The Markdown writer.',
  },
  link_refused: { severity: 'warning', message: 'A link was printed as plain text.' },
  link_scheme_dropped: {
    severity: 'warning',
    message:
      'A link to a scheme other than http, https, mailto or an in-document target is written as plain text.',
    note: `${write}.`,
  },
  link_target_missing: {
    severity: 'warning',
    message: 'An in-document link has no anchor; it is printed as text.',
  },
  markup_pagination: {
    severity: 'info',
    message:
      'Suggestions are shown as markup, so the pagination differs from that of the accepted or rejected text.',
  },
  math_refused: {
    severity: 'warning',
    message: 'An equation did not pass the gate and was replaced by a placeholder.',
  },
  merged_cells_flattened: {
    severity: 'warning',
    message: 'Merged cells are written as separate cells.',
    note: 'The Markdown writer.',
  },
  page_break_omitted: {
    severity: 'warning',
    message: 'Page and column breaks are not written in HTML or Markdown.',
    note: `${write}.`,
  },
  page_setup_missing: {
    severity: 'warning',
    message: 'A page setup is missing; A4 with 1-inch margins, or the current setup, is used.',
  },
  page_setup_omitted: {
    severity: 'warning',
    message: 'Page setups are not written in HTML or Markdown.',
    note: `${write}.`,
  },
  paragraph_border_between: {
    severity: 'warning',
    message: 'The between border of a paragraph is not drawn.',
  },
  paragraph_layout_omitted: {
    severity: 'warning',
    message:
      'Spacing, indents, borders, shading, tab stops and page breaks of paragraphs are not written in HTML or Markdown.',
    note: `${write}.`,
  },
  pending_suggestions: {
    severity: 'error',
    message: 'The document has unresolved suggestions and the job sets no suggestions option.',
  },
  preserved_formatting_omitted: {
    severity: 'warning',
    message: 'Word formatting the model does not represent is not written in Markdown.',
    note: 'The Markdown writer.',
  },
  preserved_omitted: {
    severity: 'warning',
    message: 'Word content the model does not represent is not written in HTML.',
    note: 'The HTML writer.',
  },
  ref_unresolved: {
    severity: 'warning',
    message: 'A reference field has a target without a label; it prints nothing.',
  },
  row_split: {
    severity: 'warning',
    message: 'A table row taller than a page is set as continuation rows, cut between blocks.',
  },
  row_taller_than_page: {
    severity: 'warning',
    message: 'A table row is taller than a page.',
  },
  span_taller_than_rows: {
    severity: 'warning',
    message:
      'A cell spans rows and holds content; heights are not measured, so the content may be taller than the rows.',
  },
  standard_needs_tagging: {
    severity: 'warning',
    message: 'PDF/UA-2 needs full tagging; only PDF/A-4f is declared.',
  },
  stories_omitted: {
    severity: 'info',
    message: 'Headers, footers and other stories are not written in Markdown.',
    note: 'The Markdown writer.',
  },
  story_missing: {
    severity: 'warning',
    message: 'A page setup names a header or footer story the document lacks.',
  },
  style_chain_too_long: {
    severity: 'warning',
    message: 'The chain of a style is too long to resolve.',
  },
  style_cycle: { severity: 'warning', message: 'The chain of a style loops.' },
  style_missing: {
    severity: 'warning',
    message: 'A style names a parent or a style the document lacks.',
  },
  suggestion_not_permitted: {
    severity: 'warning',
    message:
      'A suggested deletion of a whole block does not pass the permission rules, so the block is kept.',
  },
  suggestion_unverified: {
    severity: 'warning',
    message: 'A suggestion mark names no suggestion or no author; its content is kept as it is.',
  },
  tab_approximate: {
    severity: 'warning',
    message: 'A right or decimal tab in justified text is set approximately.',
  },
  tab_stop_plain: {
    severity: 'warning',
    message: 'Tab stops are written as a space.',
    note: 'The HTML writer.',
  },
  table_cannot_span_pages: {
    severity: 'warning',
    message:
      'A table in a multi-column section, a header, a footer or a footnote is set as a box and cannot span pages.',
  },
  table_style_plain: {
    severity: 'info',
    message: 'Table styles are not written in HTML; the cells keep their own formatting.',
    note: 'The HTML writer.',
  },
  title_unknown: {
    severity: 'warning',
    message: 'A title field has no document title from the job; it prints nothing.',
  },
  toc_omitted: {
    severity: 'warning',
    message:
      'Tables of contents and lists of figures are generated; they are not written in HTML or Markdown.',
    note: `${write}.`,
  },
  underline_plain: {
    severity: 'warning',
    message: 'Underline is not written in Markdown; the text is written without it.',
    note: 'The Markdown writer.',
  },
  unknown_block_omitted: {
    severity: 'warning',
    message: 'A block of an unknown type is not written in HTML or Markdown.',
    note: `${write}.`,
  },
  unknown_inline_omitted: {
    severity: 'warning',
    message: 'An inline node of an unknown type is not written in HTML or Markdown.',
    note: `${write}.`,
  },
  unsupported_feature: {
    severity: 'error',
    message: 'The document requires a feature this converter cannot read.',
  },
} as const satisfies Record<string, DiagnosticCodeInfo>;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES;

/**
 * A code written as `<type>_plain`: the HTML and Markdown writers name a text mark they do not
 * write after its type (`underline_plain`, `caps_plain`, and for a type they do not know, its own
 * name). An open family, so it is listed as a pattern.
 */
export type PlainCode = `${string}_plain`;

export const DIAGNOSTIC_CODE_PATTERNS = [
  {
    pattern: '<mark>_plain',
    severity: 'warning',
    message: 'A text mark the writer does not write is left out; the text is written without it.',
    note: 'The HTML and Markdown writers. Fixed members: caps_plain, underline_plain, tab_stop_plain and table_style_plain are listed above.',
  },
] as const satisfies readonly (DiagnosticCodeInfo & { pattern: string })[];
