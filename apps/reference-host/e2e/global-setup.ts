/**
 * Starts the demo stack before the scenario (scripts/stack.ps1 up), or with DOCEDIT_DEMO_REUSE=1
 * only checks that it answers. The stack's own readiness checks run inside `up`.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { APP, hostUrl, serviceUrl } from './support.ts';

async function answers(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

export default async function globalSetup(): Promise<void> {
  if (process.env['DOCEDIT_DEMO_REUSE'] !== '1') {
    execFileSync('pwsh', ['-NoProfile', '-File', join(APP, 'scripts', 'stack.ps1'), 'up'], {
      stdio: 'inherit',
      timeout: 900_000,
    });
  }
  for (const url of [`${serviceUrl()}/readyz`, `${hostUrl()}/healthz`])
    if (!(await answers(url)))
      throw new Error(`${url} does not answer: start the stack (scripts/stack.ps1 up)`);
}
