# Documentation site (FND-013)

A VitePress site with one version for each release. Owner decision 245 (2026-11-26) added VitePress and TypeDoc as development dependencies of this package. Nothing here ships to users.

## What the site holds

| Section | Source |
|---|---|
| Specification | `docs/spec/*.md` |
| Decision records | `docs/adr/*.md`, with a contents page that gives each record's status |
| Stories | `docs/stories/*.md` |
| Integration guide | `apps/reference-host/docs/integration-guide.md` (content owned by UX) |
| API reference | TypeDoc output for every package that has `src/index.ts`, the embedding API of `@docedit/element` included |
| Protocol artifacts | the files of `spec/`, each one linked from `artifacts.md` |

The sources are copied unchanged. VitePress is told to show HTML tags and `{{ }}` in running text as text, because the sources write names such as `<doc-editor>` in prose. Links from a source to a file that is not part of the site do not work on the site; the build does not fail on them.

## Build

```
pnpm --filter @docedit/docs-site site --version 1.2.0
```

The script is called `site`, not `build`, so that `pnpm build` of the whole workspace does not build the site.

| Option | Meaning |
|---|---|
| `--version` | The release. Defaults to the version of the root `package.json`. A leading `v` is removed. |
| `--site` | The site folder (default `dist/site`). Put the folder of the earlier releases here first. |
| `--site-root` | The URL path the site folder is served at (default `/`). |
| `--repo` | The repository to read (default: this one). |
| `--no-api` | Skip the API documentation (it takes about two minutes). |
| `--stage-only` | Write the staged content and stop. |

The site folder after two releases:

```
dist/site/
  index.html       redirects to the latest release
  versions.json    { "versions": ["1.2.0", "1.1.0"], "latest": "1.2.0" }
  1.2.0/           the site of that release (base path <site-root>1.2.0/)
  1.1.0/
```

The latest release is the highest Semantic Versioning version that is not a pre-release. While only pre-releases exist, it is the highest of them. A release's own menu lists the releases that existed when it was built; the front page and `versions.json` list all of them.

Hosting is not decided here. The release workflow builds the site and keeps it as a workflow artifact (`docs-site`); it publishes nothing.

## Tests

`test/fnd-013-layout.test.ts` covers the version list and the front page. `test/fnd-013-site.test.ts` builds two releases from a small repository of the same shape as this one, with VitePress and TypeDoc, and reads the result (about a minute).
