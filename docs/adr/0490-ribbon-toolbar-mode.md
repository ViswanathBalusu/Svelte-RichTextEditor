# 0490. A ribbon layout for the toolbar (`toolbar="ribbon"`)

Status: proposed (lane ci-b, 2026-11-27). The owner asked for the demo to look like an office word processor and approved a design mock; the attribute value and the grouping below are not in the spec yet.

## Context

05 §8.1 lists three values for the `toolbar` attribute: `full`, `compact` and `none`. 13 §3 says the toolbar groups commands by task (formatting, inserting, page layout, references, review, view), with contextual groups, and that the grouping and the look are this product's own. The full layout groups by the registry's `group` and shows one group at a time as plain rows. The owner wants the demo to look like a familiar office word processor: a title bar, tabs of labelled groups, the page centred on a grey canvas, side panes and a status bar.

## Decision

1. A fourth value, `ribbon`, for the `toolbar` attribute and the shell setting. Unknown values still read as `compact`. The attribute and `ToolbarMode` carry it; nothing else in the protocol changes. 05 §8.1 names it as proposed.
2. The ribbon reads the same registry entries as the compact and full layouts. It adds no command and no registry field. A command is placed by its id (a table in `shell/ribbon-groups.ts`), else by its `group`: edit and format go to Home, insert to Insert, page to Layout, review to Review and view to View; footnotes, captions, cross-references and citations go to References. Each command is in one group of one tab, and none is dropped. A contextual group (table, picture, header and footer, field) and any group an extension adds get a tab of their own, as in the full layout.
3. Behaviour is the full layout's: the WAI-ARIA tabs pattern (arrow keys, Home, End, Escape), one tab stop for the commands of the open tab, roving focus, Alt+F10 to the floating format bar (decision 168), disabled commands that stay focusable and say why. Nothing goes into a "More" menu; groups wrap onto another row.
4. The ribbon always shows an icon over each label, from the host's set, then the built-in set, then a set of the ribbon's own drawings (`RIBBON_ICONS`) for the commands that name none. Other layouts do not use them.
5. The look is scoped to `.de-shell[data-toolbar='ribbon']` and `.de-ribbon`, so the other layouts keep theirs. It adds four tokens with defaults in each theme: `--de-chrome` (the strip behind the tabs and the status bar), `--de-canvas` (the grey the page lies on), `--de-accent` and `--de-accent-text` (the main action).
6. Group captions and tab names are strings of the core table (`ribbon.tab.*`, `ribbon.group.*`).

## Consequences

- A host chooses the look with one attribute. The reference host uses it.
- The tab names and the group captions are provisional with the rest of 13 §3.
- The visual baselines of UX-064 cover the compact layout and are unchanged. The ribbon has its own.
- No vendor's name, icon, font file or layout is used; the icon drawings and the arrangement are this product's own.
