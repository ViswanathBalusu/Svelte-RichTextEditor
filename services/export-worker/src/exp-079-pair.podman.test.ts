/**
 * EXP-079 (lane V-EXP-065-080), Podman: the same bundle compiled twice at once, each compile in its
 * own sandbox of the worker image, gives an equal pair that may be sealed (criteria 1, 3, 5); a pair
 * whose second compile uses another SOURCE_DATE_EPOCH differs and is refused (criterion 4). Skips
 * when the sandbox is not ready (see sandbox-ready.ts; DOCEDIT_REQUIRE_SANDBOX=1 makes it fail).
 * Run from services/export-worker with `pnpm exec vitest run src/exp-079-pair.podman.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { acceptForSealing, compileSealingPair, comparePair } from './exp-079-pair.ts';
import { compileInSandbox } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const ready = await sandboxReady();

const FILES = {
  'main.tex':
    '\\documentclass{article}\n\\begin{document}\nEXP079 sealing pair probe.\n\\end{document}\n',
};

describe.skipIf(!ready.ok)(`EXP-079 sealing pair (${ready.reason})`, () => {
  it('seals a PDF only from an equal pair of independent sandboxes', async () => {
    const out = await compileSealingPair(FILES, {
      minPasses: 1,
      maxPasses: 2,
      sourceDateEpoch: 1_700_000_000,
    });
    expect(out.ok ? '' : out.diagnostic).toBe('');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.containers[0]).not.toBe(out.containers[1]);
    expect(out.hashes.a).toBe(out.hashes.b);
    expect(out.hashes.a).toMatch(/^[0-9a-f]{64}$/);
    const pdf = acceptForSealing(out.sealable);
    expect(pdf.length).toBeGreaterThan(0);
    expect(out.compileMs[0]).toBeGreaterThan(0);
    expect(out.compileMs[1]).toBeGreaterThan(0);
  });

  it('refuses to seal a pair whose two compiles differ, with a diagnostic', async () => {
    const stamp = Date.now().toString(36);
    const a = await compileInSandbox(FILES, {
      minPasses: 1,
      maxPasses: 2,
      sourceDateEpoch: 1_700_000_000,
      name: `docedit-v-exp-065-080-seal-differ-a-${stamp}`,
    });
    const b = await compileInSandbox(FILES, {
      minPasses: 1,
      maxPasses: 2,
      sourceDateEpoch: 1_800_000_000,
      name: `docedit-v-exp-065-080-seal-differ-b-${stamp}`,
    });
    expect(a.ok, a.log.slice(0, 400)).toBe(true);
    expect(b.ok, b.log.slice(0, 400)).toBe(true);
    const out = comparePair(a, b);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.sealable).toBeNull();
    expect(out.diagnostic).toMatch(/differ/);
    expect(() => acceptForSealing(out.sealable ?? {})).toThrow(/equal pair/);
  });
});
