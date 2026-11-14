/**
 * The reference machine and its throttling profile (FND-007 criterion 1; 00 §9; 13 §9), as
 * proposed in ADR 0037. Every harness result records the profile it ran with; results are only
 * compared under the same profile.
 */
import type { Profile } from './results.ts';

/** The machine the profile was calibrated on. */
export const REFERENCE_MACHINE = {
  name: 'docedit reference machine 1',
  model: 'Alienware Aurora R11 (desktop)',
  cpu: 'Intel Core i9-10900KF, 10 cores, 20 threads, 3.7 GHz base',
  memory: '128 GiB DDR4-2667 (4 × 32 GiB)',
  gpu: 'NVIDIA GeForce RTX 3080',
  os: 'Windows 11 Pro 10.0.26300',
  power: 'Windows power plan "High performance"',
} as const;

/**
 * The reference profile: Playwright 1.65's Chromium in headless mode, one page of 1280 × 800 CSS
 * pixels at device scale factor 1, with CPU throttling at `cpuThrottlingRate` through the Chrome
 * DevTools Protocol. The rate comes from the calibration in ADR 0037.
 */
export const REFERENCE_PROFILE: Profile = {
  name: 'reference-1',
  cpuThrottlingRate: 1,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  headless: true,
};

/** The profile of a run: the reference one, or a custom rate from DOCEDIT_CPU_THROTTLE. */
export function profileFor(rate: number | undefined): Profile {
  if (rate === undefined || rate === REFERENCE_PROFILE.cpuThrottlingRate) return REFERENCE_PROFILE;
  return { ...REFERENCE_PROFILE, name: `custom-${rate}x`, cpuThrottlingRate: rate };
}
