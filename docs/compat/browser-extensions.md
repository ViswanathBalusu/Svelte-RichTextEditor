# Browser extensions: compatibility list (FE-117)

Status: **proposed list, no results yet.** Nothing in this file was observed. Owner decision 253 (docs/owner-decisions-2026-11-26.md) says agents propose the few most widely used grammar-checking and password-manager extensions and the owner approves the list. This is the proposal. The "Behaviour" column stays "not tested" until a person has run the extension in the browser.

Last checked: never.

## Proposed extensions

Grammar and style checkers (they read and rewrite text in editable areas):

- Grammarly
- LanguageTool
- Microsoft Editor

Password managers (they look for form fields and fill them; the editor has form fields, FRW-004):

- Bitwarden
- 1Password
- the password manager built into each browser

The versions are those installed on the day of the test. The owner may add or remove entries.

## Browsers

Chromium-based (Chrome, Edge), Firefox and Safari, as in 02 section 12. An extension that does not exist for a browser has no row for it.

## What a person tests

For each extension and browser, with the editor in the `web` view, in the `print` view where it is offered, and in `fill` mode for the password managers:

1. Type a paragraph with a deliberate mistake. Does the checker underline it, and does accepting its suggestion change the document (the confirmed content, not only the screen)?
2. Does the checker's button or overlay sit over the text, and does it change typing, the caret or the selection?
3. For a password manager, open a document with a text field and an e-mail field. Does the extension offer to fill, and does the filled value reach the document as a field entry?
4. Does anything break: lost input, a doubled character, a caret that jumps, a console error from the editor?

Record the behaviour as **works**, **partly works** or **breaks**, with a workaround where one exists (for example a host attribute that turns a checker off for the editor).

## Results

| Extension | Version | Browser | Behaviour | Workaround |
|---|---|---|---|---|
| Grammarly | | Chrome | not tested | |
| Grammarly | | Edge | not tested | |
| Grammarly | | Firefox | not tested | |
| Grammarly | | Safari | not tested | |
| LanguageTool | | Chrome | not tested | |
| LanguageTool | | Edge | not tested | |
| LanguageTool | | Firefox | not tested | |
| LanguageTool | | Safari | not tested | |
| Microsoft Editor | | Chrome | not tested | |
| Microsoft Editor | | Edge | not tested | |
| Bitwarden | | Chrome | not tested | |
| Bitwarden | | Edge | not tested | |
| Bitwarden | | Firefox | not tested | |
| Bitwarden | | Safari | not tested | |
| 1Password | | Chrome | not tested | |
| 1Password | | Edge | not tested | |
| 1Password | | Firefox | not tested | |
| 1Password | | Safari | not tested | |
| Built-in password manager | | Chrome | not tested | |
| Built-in password manager | | Edge | not tested | |
| Built-in password manager | | Firefox | not tested | |
| Built-in password manager | | Safari | not tested | |

## At each release

The list is reviewed when a release is cut: the person cutting it re-runs the rows whose extension or browser has a new major version, updates the table and sets the date of the last check above.
