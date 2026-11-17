# 0365. Sources pane: the mapping of imported BibTeX and CSL-JSON entries, and the pane's port

Status: proposed (lane w3, 2026-11-15, for UX-103). Not decided by the owner.

## Context

UX-103 asks for sources to be created from a BibTeX or CSL-JSON file "with their grammars checked".
CDM-052 (ADR 0031, section 6, proposed) stores a source as a `source_def` node with one attribute
per CSL variable. CSL-JSON maps onto it name by name. BibTeX does not: its entry types and fields
are a different vocabulary, and the spec names no mapping. An earlier lane left the criterion open
for that reason. The second review (SR-M20) asks that an imported file passes the grammars before
it can reach the `.bib` file of an export.

The pane also needs a way to reach the core. 02 §5.1 names no member for sources.

## Decisions proposed

1. **BibTeX entry types.** `article` is `article-journal`; `book` and `proceedings` are `book`;
   `booklet` is `pamphlet`; `inbook` and `incollection` are `chapter`; `inproceedings` and
   `conference` are `paper-conference`; `mastersthesis`, `phdthesis` and `thesis` are `thesis`;
   `techreport` and `report` are `report`; `unpublished` is `manuscript`; `online` is `webpage`;
   `manual`, `misc` and any type not listed are `document`.
2. **BibTeX fields.** `title`, `publisher`, `edition`, `volume`, `pages`, `doi`, `url`, `isbn`,
   `issn` and `note` go to the attribute of the same meaning; `address` to `publisherPlace`;
   `journal`, `journaltitle` and `booktitle` to `containerTitle`; `author` and `editor` to people
   (split on `and`; `Family, Given` or `Given Family`; a name wholly in braces is one literal
   name); `year` with `month` to `issued` as an EDTF level 0 date, or `date` as written; `number`
   to `issue` for an article and to `number` otherwise. Braces are removed and `--` in a page range
   becomes `-`. LaTeX commands in a value are not interpreted: they stay as text.
3. **Nothing is repaired.** A field that no attribute takes (`keywords`, `institution`, `abstract`
   and the like) is left out and is not put in `extra`. A key that the identifier grammar refuses,
   or a value its attribute's grammar refuses, makes the entry fail: it is reported with the
   attributes at fault and no source is created. A key is never renamed.
4. **Duplicates.** A key that occurs more than once in the file (compared without regard to case,
   ADR 0137) creates no source for any of its entries. A key the document already has creates no
   source and changes none: an import never overwrites.
5. **CSL-JSON.** `type` is `kind`; `author` and `editor` are people; `issued` and `accessed` take
   `date-parts` (one date or an interval) or `raw`; the variables `source_def` has are copied; the
   others are left out, as in decision 3.
6. **The core's members.** `DocumentApi.sources()` lists the sources with where each is cited, and
   `DocumentApi.editSource(edit, check?)` adds, changes or deletes one. Both are additions to 02
   §5.1. The change is a transaction on `defs`, so the region guard applies (`structure`, 07 §4)
   and the change is a commit. The shell reaches them through an optional `sources` port
   (`SourcesService` in `packages/ui/src/core-api.ts`).
7. **The form.** The pane's form edits the key (when adding), the type, the title, the authors,
   the date, the container, the DOI and the web address, which are the attributes the story
   names. The other CSL variables of a source are kept as they are and can be set by import. A
   key cannot be changed after the source is made, because citations name it.

## Left open

- Whether dropped fields should go to `extra` (decision 3) is the owner's call; `extra` takes CSL
  variable names only, so BibTeX names would need a mapping first.
- Whether a region-only editor may add a source in order to cite it (07 §17) is not decided here:
  the default of 07 §4 is applied, so they may not.
- The messages of the file parser (`source-import.ts`) are English text, not string keys.

## Consequences

An import of a large BibTeX library loses the fields listed in decision 3. Each created source is
one commit, so an import of n sources is n commits.
