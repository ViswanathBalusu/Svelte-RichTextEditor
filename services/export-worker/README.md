# Export worker

The export worker takes `export` jobs from the control plane's queue, converts the document to a
bundle, compiles it in a single-use Podman sandbox and stores the outputs (09 §9). The image is
built from `Containerfile` with `scripts/build-image.ts`.

## Previews

Two rules of 06 §10 bound what previews cost (EXP-008; proposed in
`docs/adr/0421-w2-EXP-008-preview-start-gap-and-reuse.md`).

- **One compile of a document per preview window.** The queue takes no preview of a document
  within the window (ten seconds, `DOCEDIT_PREVIEW_WINDOW_MS` of the document service) after the
  compile of another preview of that document started, nor while one is on its way to its compile.
  The start is the moment the worker reports the stage `compiling`, just before the sandbox.
- **No compile for an unchanged bundle.** After conversion the worker computes the preview key of
  the bundle (`src/preview-reuse.ts`). When an earlier preview of the document has the same key,
  the job ends `completed` with that preview's files and no sandbox runs. The log line of such a
  job says "no compile, an earlier preview of the same bundle is shown". Final exports always
  compile here; the control plane answers an identical request from its first result (EXP-006).

## Limits of every job

Sizing worker nodes from these limits: [CAPACITY.md](CAPACITY.md).

Each job runs under these limits (09 §9.3 item 4; `src/sandbox.ts`, `LIMITS`). A job that reaches
one ends `failed` with a diagnostic that names the limit (`limit_time`, `limit_memory`,
`limit_output`, `limit_pages`, `limit_workdir`, `limit_processes`), and its sandbox is removed.

| Limit | Value |
|---|---|
| Wall clock for the whole job, all passes included | 120 seconds |
| Wall clock for one pass | 110 seconds |
| CPU | 1 core |
| Memory, with no swap | 1.5 GiB (1536 MiB) |
| Processes | 64 processes |
| Pages of the document | 2,000 pages |
| Output of the job | 200 MiB of output |
| Working directory | 256 MiB of working directory |

## Security notes

These notes describe the engine and the sandbox as configured (09 §9.3 items 2 and 7; EXP-068
criterion 5). The configuration checks are in `src/engine-config.test.ts`.

- The engine runs with shell escape off (`shell_escape=f`, `--no-shell-escape`), with
  `openin_any=p` and `openout_any=p` (paranoid), and with the `--safer` flag not used, because
  `--safer` disables loading OpenType fonts from file. LuaTeX must be 1.17 or later: earlier
  versions allowed shell execution with shell escape off (CVE-2023-32700) and had sockets enabled
  by default (CVE-2023-32668).
- Lua's `debug` and file libraries remain reachable inside LuaTeX. Any TeX injection must be
  treated as arbitrary Lua. The engine settings above are a first line of defence only.
- The container is the boundary. Paranoid input does not stop the engine or Lua from reading
  absolute paths, so no host path is mounted into a job, and the image holds no secret
  (`src/image-secrets.test.ts`).
- A job's outputs (PDF, log, layout report and pass timings) are read as hostile input.
