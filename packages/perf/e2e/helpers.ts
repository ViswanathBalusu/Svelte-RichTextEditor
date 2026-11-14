/**
 * Node.js side of the harness specs: CPU throttling through the DevTools protocol, the machine
 * description every result carries, and result files.
 */
import type { Browser, CDPSession, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, hostname, release, totalmem, type } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MachineInfo, Profile } from '../src/results.ts';
import { profileFor } from '../src/reference.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const packageDir = resolve(here, '..');
export const resultsDir = join(packageDir, 'test-results');

/** The profile of this run: the reference profile, or DOCEDIT_CPU_THROTTLE. */
export function runProfile(): Profile {
  const env = process.env['DOCEDIT_CPU_THROTTLE'];
  return profileFor(env ? Number(env) : undefined);
}

/** Sets the CPU throttling rate of a Chromium page (1 is none) and returns the session. */
export async function throttle(page: Page, rate: number): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  return cdp;
}

export function machineInfo(): MachineInfo {
  const list = cpus();
  return {
    cpu: list[0]?.model.trim() ?? 'unknown',
    logicalProcessors: list.length,
    memoryBytes: totalmem(),
    os: `${type()} ${release()}`,
    hostname: hostname(),
  };
}

export function browserInfo(browser: Browser, name: string): { name: string; version: string } {
  return { name, version: browser.version() };
}

export function writeJson(path: string, data: unknown): string {
  const full = join(resultsDir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(data, null, 2)}\n`);
  return full;
}

/**
 * Measures how busy the whole machine was between `start()` and `stop()`: the share of non-idle
 * time over all logical processors, from the operating system's per-processor counters. The
 * harness cannot stop other work on the machine; it records it with every result.
 */
export function cpuLoad(): { stop(): { busyShare: number; seconds: number } } {
  const sample = (): { busy: number; total: number } => {
    let busy = 0;
    let total = 0;
    for (const c of cpus()) {
      const t = c.times;
      busy += t.user + t.nice + t.sys + t.irq;
      total += t.user + t.nice + t.sys + t.irq + t.idle;
    }
    return { busy, total };
  };
  const a = sample();
  const started = Date.now();
  return {
    stop() {
      const b = sample();
      const total = b.total - a.total;
      return {
        busyShare: total > 0 ? (b.busy - a.busy) / total : 0,
        seconds: (Date.now() - started) / 1000,
      };
    },
  };
}

/** A run identifier from the clock: 2026-11-06T12-34-56Z. */
export function runId(): string {
  return new Date()
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replace(/:/g, '-');
}
