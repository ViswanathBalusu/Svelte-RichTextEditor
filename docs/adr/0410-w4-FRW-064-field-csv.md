# 0410. The spreadsheet output of field values

**Status:** decision 44 of `docs/owner-decisions-2026-11-15.md` is the owner's: field values can be exported as CSV, with formula neutralising. Everything else here is proposed, 2026-11-18, and written while closing FRW-064 (lane w4). The owner may change any item.

## Decided by the owner

Decision 44: "Spreadsheet export of field values: Yes, as CSV, with formula neutralising." 12 §9 names the four characters: a value whose first character is `=`, `+`, `-` or `@`.

## Proposed

1. **The route.** `GET /documents/{id}/field-values?format=csv`. It is the existing read, so it has the same credentials, the same projection (a reader sees what the JSON shows them), the same `?seq` pinning and the same history gate. `format` is `json` (the default) or `csv`; another value is `validation_failed`. No new route and no new capability. The JSON body is unchanged.
2. **The shape.** `text/csv; charset=utf-8`, RFC 4180, CRLF line ends, a header row `key,value`, then one row for each field in document order. `Content-Disposition: attachment; filename="field-values.csv"`. No byte order mark: a spreadsheet that needs one to read non-ASCII text can be given the file through an import dialog.
3. **The cell text.** No value is an empty cell. A string is itself (a `number` field holds a decimal string). A boolean is `true` or `false`. An object (the adopted image of a signature, or the redaction marker of a projection) is its JSON text.
4. **The rule.** One apostrophe in front of a cell whose first character is `=`, `+`, `-` or `@`; every other cell as it is. A negative number is therefore written `'-12.50` and a reader removes one apostrophe to read it back. The apostrophe shows in the cell: neither Excel nor Calc treats it as the quote prefix when it reads a file. The rule is the owner's four characters; a leading tab or carriage return, which OWASP also lists, is not handled.
5. **The ETag.** The CSV has its own ETag (the JSON's with `:csv` before the closing quote), so a cache cannot answer one representation with the other.
6. **The test matrix of FRW-064 criterion 1.** The story says "the spreadsheet applications in the test matrix" and no matrix is written down. Proposal: Microsoft Excel (desktop, Windows) and LibreOffice Calc, the two that can be run on a developer machine without an account; both were run (see the story's Evidence). Google Sheets is not in the proposed matrix: it needs a Google account and an upload of the file to a Google service, which a test does not do. If the owner adds it, a person has to check it, and FRW-064 criterion 1 is then open again until they do.
7. **Where it is tested.** `services/document-service/test/control-plane/frw-064.csv-route.test.ts` runs the route and, when LibreOffice is installed (`DOCEDIT_SOFFICE`, `soffice` on the path, or the default Windows folder), converts the output with `soffice --headless` and reads the cells; it also converts the same values without the apostrophes, to show that the check can fail. Excel was run once by hand through its automation interface and is not a test, because it needs a licensed desktop installation.
