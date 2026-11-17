/**
 * EXP-068 criterion 2 (lane w2, Podman): a build of the worker image on a LuaTeX older than 1.17
 * stops. The test takes the real `Containerfile`, replaces only its `FROM` line, and runs
 * `podman build` on it for two stand-in base images made here from `alpine:3`:
 *
 * - a base whose `luatex --version` prints the banner of LuaTeX 1.16.0: the build must fail at the
 *   gate (the `luatex --version | head -1 | grep -E ...` line), before any later step;
 * - a base that prints the banner of LuaTeX 1.24.0: the build must pass the gate and stop at the
 *   next command of the same step (`groupadd`, which alpine does not have: exit status 127, where
 *   the gate's `grep` gives 1).
 *
 * The second build is the control: it shows the first one stops at the gate and not for another
 * reason. The stand-ins print a banner and are not TeX engines. A real TeX Live image with an
 * engine older than 1.17 is not in the local Podman store and is about 6 GB to pull, so the
 * criterion is shown on the gate as the build runs it, not on a real old engine. The images made
 * here are named `-w2` and are removed at the end. Skipped when Podman or `alpine:3` is missing.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { podman } from './container.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const ALPINE = 'docker.io/library/alpine:3';
const opts = {
  timeoutMs: 240_000,
  maxStdoutBytes: 4 * 1024 * 1024,
  maxStderrBytes: 4 * 1024 * 1024,
};

async function available(): Promise<boolean> {
  try {
    const r = await podman(
      ['image', 'exists', ALPINE],
      { timeoutMs: 120_000, maxStdoutBytes: 1024 },
      true,
    );
    return r.code === 0;
  } catch {
    return false;
  }
}

const ready = await available();
const work = mkdtempSync(join(tmpdir(), 'docedit-exp068-w2-'));
const tags = [
  'localhost/docedit-gate-stub-w2:1.16',
  'localhost/docedit-gate-stub-w2:1.24',
] as const;
const gated = ['localhost/docedit-gate-build-w2:1.16', 'localhost/docedit-gate-build-w2:1.24'];

async function build(args: string[]) {
  return podman(['build', '--pull=never', '--no-cache', ...args], opts, true);
}

/** An image of alpine whose `luatex --version` prints the banner of the given version. */
async function stub(tag: string, version: string): Promise<void> {
  const dir = join(work, `stub-${version}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'Containerfile'),
    [
      `FROM ${ALPINE}`,
      `RUN printf '#!/bin/sh\\necho "This is LuaTeX, Version ${version} (stand-in banner)"\\n' > /usr/local/bin/luatex && chmod +x /usr/local/bin/luatex`,
      '',
    ].join('\n'),
  );
  const r = await build(['-f', join(dir, 'Containerfile'), '-t', tag, dir]);
  expect(r.code, r.stderr.slice(-800)).toBe(0);
}

/** `podman build` of the real Containerfile with its FROM line replaced. */
async function buildWorker(base: string, tag: string) {
  const real = readFileSync(new URL('../Containerfile', import.meta.url), 'utf8');
  const from = real.split('\n').filter((l) => l.startsWith('FROM '));
  expect(from).toHaveLength(1);
  const file = join(work, `Containerfile.${tag.split(':')[1]}`);
  writeFileSync(file, real.replace(from[0]!, `FROM ${base}`));
  const context = join(work, 'context');
  mkdirSync(context, { recursive: true });
  return build(['-f', file, '-t', tag, context]);
}

afterAll(async () => {
  if (ready)
    await podman(
      ['rmi', '--force', ...gated, ...tags],
      { timeoutMs: 120_000, maxStdoutBytes: 1 << 20 },
      true,
    );
  rmSync(work, { recursive: true, force: true });
});

describe.skipIf(!ready)('EXP-068 criterion 2: a build on LuaTeX older than 1.17 fails', () => {
  it('stops the build at the version gate on 1.16.0', async () => {
    await stub(tags[0], '1.16.0');
    const r = await buildWorker(tags[0], gated[0]!);
    expect(r.code, 'the build fails').not.toBe(0);
    // The step that failed is the one that holds the gate, and nothing after the gate ran.
    expect(r.stderr).toContain('luatex --version');
    // grep found no 1.17 or later banner: exit status 1 (127 would be a missing command).
    expect(r.stderr).toMatch(/exit status 1\b/);
  });

  it('passes the gate on 1.24.0 and stops later, at the next command of the step', async () => {
    await stub(tags[1], '1.24.0');
    const r = await buildWorker(tags[1], gated[1]!);
    expect(r.code, 'alpine has no groupadd').not.toBe(0);
    // The gate let it through; `groupadd` is the first command that is missing (exit status 127).
    expect(r.stderr).toMatch(/exit status 127/);
  });
});
