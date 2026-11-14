/**
 * EXP-004 criterion 4 (lane U-EXP-001-016): a running job that is cancelled is stopped and its
 * sandbox is discarded. Needs Podman and the worker image; skips otherwise (sandbox-ready.ts).
 *
 * The job's signal is aborted while a sandbox runs; the sandbox is the real one (sandboxArgs with
 * `--rm`, no network), and the test then checks that no container of that name is left behind.
 */
import { describe, expect, it, vi } from 'vitest';
import { containerExists } from './container.ts';
import { runInSandbox } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

vi.setConfig({ testTimeout: 300_000 });

const ready = await sandboxReady();

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return check();
}

describe.skipIf(!ready.ok)(`EXP-004 cancel discards the sandbox (${ready.reason})`, () => {
  it('stops a running sandbox when its job is cancelled and leaves no container behind', async () => {
    const name = `docedit-test-u-exp-001-016-cancel-${Date.now().toString(36)}`;
    const controller = new AbortController();
    const running = runInSandbox('sleep 120\n', {
      name,
      signal: controller.signal,
      limits: { wallSeconds: 150 },
    });

    // The container must exist before the cancel, or the test proves nothing.
    const started = await waitFor(() => containerExists(name), 120_000);
    expect(started, 'the sandbox container started').toBe(true);

    controller.abort();
    const result = await running;
    expect(result.aborted).toBe(true);

    const gone = await waitFor(async () => !(await containerExists(name)), 60_000);
    expect(gone, 'the container is discarded after the cancel').toBe(true);
  });
});
