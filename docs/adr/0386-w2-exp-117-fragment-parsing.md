# ADR 0386: What "not parsed beyond the package structure" means for a stored fragment

Status: proposed (lane w2, 2026-11-18). Story: EXP-117, criterion 4.

## Context

EXP-117 criterion 4 says that when a fragment is stored, nothing in it is parsed beyond the package
structure or executed. Earlier rounds left it open because the importer reads an atom's XML to find
its kind (`labelFor`) and its size (`atomSize`).

## Decision 1: the reading

The package structure is the ZIP directory, `[Content_Types].xml` and the relationship parts
(`.rels`). The criterion is read as follows.

- A part that a fragment relates to (a chart, an embedded object, a cached drawing, an image) is
  copied as bytes. No XML parser, OLE reader or script engine is given it.
- The fragment's own XML is a slice of the bytes of its host part (`pc.bytes.slice(el.start,
  el.end)`). Storing it does not parse it again. The importer's reads of the kind and the size walk
  the tree of the host part, which the importer has already parsed because the host part is the
  document it imports.
- Relationships to external targets are read as data from `.rels` and never followed.

This is the narrow reading of "when it is stored". Under a stricter reading (the importer must not
look inside an atom at all) no kind such as "chart" or "text box" could be named, and the report of
EXP-107 could not say what was preserved.

## Evidence

`packages/export-docx/test/exp-117-parse.test.ts` imports a chart whose parts are malformed XML, an
XML part with a DOCTYPE and entity expansion (which the importer's parser refuses if it is given
it), binary data and a part that holds script text. The import succeeds, each part is kept byte for
byte, and no network or script call is made.

## Open

The owner or the spec may confirm the reading. If a stricter reading is wanted, `labelFor` would
have to run on a token scan of the slice, not on the parsed tree.
