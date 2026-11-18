# Manual accessibility logs

One JSON file per manual pass with assistive technology, named `YYYY-MM-DD-<technology>.json`. The conformance report (`packages/ui/scripts/a11y-report.ts`; UX-069) reads every `*.json` file here and names the technologies in the release's report. A pass is made before each release (UX-068, criterion 8).

```json
{
  "date": "2026-12-01",
  "release": "0.1.0",
  "at": { "name": "NVDA", "version": "2026.1" },
  "browser": "Firefox 140",
  "os": "Windows 11",
  "flows": [
    { "name": "Open the document and move through the toolbar", "result": "pass", "issues": [] },
    { "name": "Fix an issue from the checker", "result": "issues", "issues": ["KI-005"] }
  ]
}
```

Rules: `result` is `pass` or `issues`; an issue is an id from `packages/ui/src/a11y-report/known-issues.ts`, added there first with a tracking item. The report refuses to build on a log that names an unknown issue. No log exists yet: no manual pass has been made.
