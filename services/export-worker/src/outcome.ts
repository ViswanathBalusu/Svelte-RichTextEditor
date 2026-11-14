/**
 * What a compile that did not end with a PDF ran into (09 §9.3 item 4; EXP-071 criterion 2).
 *
 * Inside the container every pass runs under `timeout -s KILL` (compile.sh), so a pass killed by
 * SIGKILL (exit 137) either reached the pass time limit or was ended by the kernel's out-of-memory
 * killer at the cgroup memory limit: no other process in the sandbox can send it a signal. The
 * length of the pass tells them apart. A write past RLIMIT_FSIZE ends the engine with SIGXFSZ
 * (exit 153). Podman's own `--timeout` ends the container with 255, and the worker's timer and the
 * output bound are reported by the run itself. The page limit and a full working directory show
 * in the log.
 */
import type { Diagnostic } from '@docedit/export-latex';
import { diagnostic, type ParsedLog } from './diagnostics.ts';
import type { CompileResult } from './sandbox.ts';

export type LimitName = 'time' | 'memory' | 'output' | 'pages' | 'workdir' | 'processes';

/** How long before its timeout a SIGKILLed pass still counts as having reached it, ms. */
const TIMEOUT_SLACK_MS = 1500;

/** The limit a failed compile reached, or null when it failed for another reason. */
export function limitReached(r: CompileResult, log: ParsedLog | null): LimitName | null {
  const passLimitMs = r.passTimeoutSeconds * 1000;
  if (r.timedOut || r.exitCode === 255) return 'time';
  const killed = r.passes.find((p) => p.rc === 137);
  if (killed) return killed.ms >= passLimitMs - TIMEOUT_SLACK_MS ? 'time' : 'memory';
  if (r.outputOverflow || r.passes.some((p) => p.rc === 153) || r.exitCode === 153) return 'output';
  const codes = new Set(log?.entries.map((e) => e.code) ?? []);
  if (codes.has('limit_pages')) return 'pages';
  if (codes.has('limit_workdir')) return 'workdir';
  // A full working directory also stops compile.sh's own writes there (its standard error, which
  // is a pipe, says so), and the log itself may end early: the log cannot be written either.
  if (/No space left on device|compile\.sh: \d+: echo: echo: I\/O error/.test(r.stderr))
    return 'workdir';
  if (/Cannot fork|fork: Resource temporarily unavailable/.test(r.stderr)) return 'processes';
  return null;
}

/** The diagnostic that names a limit and its value (EXP-071 criterion 2). */
export function limitDiagnostic(limit: LimitName, r: CompileResult): Diagnostic {
  const l = r.limits;
  switch (limit) {
    case 'time':
      return diagnostic(
        'limit_time',
        null,
        `The limit is ${l.wallSeconds} s for the job and ${r.passTimeoutSeconds} s for one pass.`,
      );
    case 'memory':
      return diagnostic('limit_memory', null, `The limit is ${l.memoryMiB} MiB.`);
    case 'output':
      return diagnostic(
        'limit_output',
        null,
        `The limit is ${Math.round(l.outputBytes / 1024 / 1024)} MiB.`,
      );
    case 'pages':
      return diagnostic('limit_pages', null, `The limit is ${l.pages} pages.`);
    case 'workdir':
      return diagnostic('limit_workdir', null, `The limit is ${l.workMiB} MiB.`);
    case 'processes':
      return diagnostic('limit_processes', null, `The limit is ${l.pids} processes.`);
  }
}

/** The message of a failed job that reached a limit: it names the limit (EXP-071). */
export function limitMessage(limit: LimitName, r: CompileResult): string {
  const l = r.limits;
  const value = {
    time: `${l.wallSeconds} s`,
    memory: `${l.memoryMiB} MiB of memory`,
    output: `${Math.round(l.outputBytes / 1024 / 1024)} MiB of output`,
    pages: `${l.pages} pages`,
    workdir: `${l.workMiB} MiB of working directory`,
    processes: `${l.pids} processes`,
  }[limit];
  return `the compile reached its limit of ${value} (limit_${limit})`;
}
