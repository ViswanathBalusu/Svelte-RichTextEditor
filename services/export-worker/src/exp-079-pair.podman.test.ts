/**
 * EXP-079 (lane V-EXP-065-080), Podman: the same bundle compiled twice, one after the other, each in its
 * own sandbox of the worker image, gives an equal pair that may be sealed (criteria 1, 3, 5); a pair
 * whose second compile uses another SOURCE_DATE_EPOCH differs and is refused (criterion 4). Skips
 * when the sandbox is not ready (see sandbox-ready.ts; DOCEDIT_REQUIRE_SANDBOX=1 makes it fail).
 * Run from services/export-worker with `pnpm exec vitest run src/exp-079-pair.podman.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { acceptForSealing, compileBoth, compileSealingPair, comparePair } from './exp-079-pair.ts';
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

  it('holds no credential in either sandbox of the pair (EXP-079 criterion 6; ADR 0045)', async () => {
    const lua = [
      'local names = {}',
      'local f = io.open("/proc/self/environ", "rb")',
      'local data = f and f:read("*a") or ""',
      'if f then f:close() end',
      'for entry in data:gmatch("([^%z]+)") do names[#names + 1] = entry:match("^([^=]*)") end',
      'texio.write_nl("S4RESULT env=" .. table.concat(names, ","))',
      'local n = 0',
      'local ok, iter, st = pcall(lfs.dir, "/run/secrets")',
      'if ok and iter then for e in iter, st do if e ~= "." and e ~= ".." then n = n + 1 end end end',
      'texio.write_nl("S4RESULT secrets=" .. n)',
    ].join('\n');
    const files = {
      'main.tex':
        '\\documentclass{article}\n\\directlua{dofile("probe.lua")}\n\\begin{document}\nx\n\\end{document}\n',
      'probe.lua': lua,
    };
    const [a, b] = await compileBoth(files, { minPasses: 1, maxPasses: 1 });
    for (const r of [a, b]) {
      expect(r.ok, r.log.slice(0, 400)).toBe(true);
      const env = /S4RESULT env=([^\r\n]*)/.exec(r.log)?.[1]?.split(',') ?? [];
      // The control: the probe did read the environment of the job.
      expect(env.length).toBeGreaterThan(0);
      expect(
        env.filter((n) =>
          /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|SIGNING|PRIVATE|API_KEY|ACCESS_KEY|AWS_|DATABASE|DSN)/i.test(
            n,
          ),
        ),
      ).toEqual([]);
      expect(/S4RESULT secrets=(\d+)/.exec(r.log)?.[1]).toBe('0');
    }
    expect(a.name).not.toBe(b.name);
  });
});
