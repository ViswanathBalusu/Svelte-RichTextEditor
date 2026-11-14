/**
 * `node apps/reference-host/scripts/spawn.ts <pid-file> <log> <error-log> <script> [args...]`:
 * starts `node <script> [args...]` in the background, detached, with its output in the two log
 * files and nothing else of the caller's (so a caller whose output is a pipe, such as CI, is not
 * kept waiting), writes its process identifier, and exits. scripts/stack.ps1 starts the stack's
 * long-running processes this way.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [pidFile, log, errorLog, script, ...args] = process.argv.slice(2);
if (!pidFile || !log || !errorLog || !script) {
  console.error('usage: spawn.ts <pid-file> <log> <error-log> <script> [args...]');
  process.exit(2);
}
for (const f of [pidFile, log, errorLog]) mkdirSync(dirname(f), { recursive: true });
const child = spawn(process.execPath, [script, ...args], {
  detached: true,
  windowsHide: true,
  stdio: ['ignore', openSync(log, 'a'), openSync(errorLog, 'a')],
});
if (child.pid === undefined) {
  console.error(`could not start node ${script}`);
  process.exit(1);
}
writeFileSync(pidFile, String(child.pid));
child.unref();
