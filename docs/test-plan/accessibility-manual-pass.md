# Accessibility: manual screen-reader pass

Story: FE-126. Spec: 02 §10, §14. This is the scripted pass that a person runs with a screen reader before a release. The automated axe runs (`packages/element/e2e/fe-126-*.spec.ts`) do not replace it: axe cannot say what a screen reader announces.

The results go to the accessibility conformance report (UX-069). A result is recorded per row of the table below, with the build, the date and the person.

## 1. Combinations

The combinations are a proposal. The owner has not named the screen readers and browsers the release must pass; change this table when they do.

| Id | Screen reader | Browser | System |
|---|---|---|---|
| SR1 | NVDA | Firefox | Windows |
| SR2 | NVDA | Chrome | Windows |
| SR3 | JAWS | Edge | Windows |
| SR4 | Narrator | Edge | Windows |
| SR5 | VoiceOver | Safari | macOS |
| SR6 | VoiceOver | Safari | iOS |
| SR7 | TalkBack | Chrome | Android |

## 2. Result table

One row per combination and per release. No row has been run yet.

| Release | Id | Browser and version | Screen reader and version | Date | Person | Result | Failures (issue or workaround) |
|---|---|---|---|---|---|---|---|

## 3. Checklist

Run every item on every combination. An item passes when the screen reader announces what the item says and the focus goes where it says.

### 3.1 List semantics

- A numbered paragraph is announced as a list item with its label and its level, and the list has a count of items (the model has no list nodes; the semantics come from ARIA).
- Moving by list item (the screen reader's own key) goes from one numbered paragraph to the next.
- A change of level through Tab or Shift+Tab is announced.
- A bulleted list and a numbered list are told apart.

### 3.2 Live regions

- Saving is announced once, and not on every keystroke.
- The refusal of an edit (a read-only region, a locked document) is announced with its reason.
- A collaborator arriving or leaving is announced by name.
- A notice does not take the focus.

### 3.3 Escape and Ctrl+F6

- Escape leaves the editing surface, and the focus lands on a named control.
- Ctrl+F6 moves through the landmarks in order (header, toolbar, page, panes, status bar), and each landmark is announced by its name.
- Shift+Ctrl+F6 moves back.
- Tab inside the editing surface indents or moves to the next cell or field, and does not trap the person: Escape then Tab leaves.

### 3.4 Dialogs

- Opening a dialog announces its title, and the focus moves into it.
- The focus stays inside until the dialog closes, and Escape closes it.
- On closing, the focus returns to the control that opened it.
- Every control has a name, and an error is announced next to its field.
- The language dialog, the find and replace dialog and the share dialog are covered.

### 3.5 Guided flows

The spec does not define "guided flows". The pass takes them to be the flows that lead a person through steps with prompts:

- The accessibility checker: each finding is announced, and the control to fix it is reachable (an image without alternative text, for instance).
- The export dialog: progress and the end of the export are announced, and a diagnostic is readable.
- The share dialog and the request for access.
- Filling a form: next field and previous field, a required field left empty, and the end of filling.

### 3.6 Zoom and reflow

- At 400 % zoom in the web view the text reflows and nothing needs horizontal scrolling.
- Forced colours and the dark theme keep every control visible with its focus ring.
