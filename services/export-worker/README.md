# Export worker

The export worker takes `export` jobs from the control plane's queue, converts the document to a
bundle, compiles it in a single-use Podman sandbox and stores the outputs (09 §9). The image is
built from `Containerfile` with `scripts/build-image.ts`.

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
