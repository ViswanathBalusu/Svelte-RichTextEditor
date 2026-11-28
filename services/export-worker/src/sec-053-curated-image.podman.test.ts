/**
 * SEC-053 criterion 1 and EXP-073 criterion 1 (export worker, Podman): the image holds a curated
 * TeX Live, not the full scheme. The image is started with its entry point replaced, read-only,
 * with no network and no capabilities, as the sandbox starts it. Skipped when Podman or the worker
 * image is not available here (see sandbox-ready.ts).
 *
 * What is checked: the packages of the class's fixed list are in the kept list the build wrote and
 * their files are found by kpathsea; a package that is not in the list (TikZ, Beamer, Minted) is
 * not in the image, and neither are the documentation and sources of the packages that are; the
 * package database lists exactly the kept packages; and the engine is LuaTeX 1.17 or later.
 *
 * Each command is one `podman run` with plain arguments, because the Windows and macOS route
 * (a Podman machine over ssh) refuses arguments with shell characters (container.ts).
 */
import { describe, expect, it } from 'vitest';
import { podman } from './container.ts';
import { IMAGE } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';
import { CLASS_PACKAGES, FIXED_LIST_FILES } from './sec-053-curated-roots.ts';

const ready = await sandboxReady();
const TL = '/usr/local/texlive/2026';

async function run(entrypoint: string, args: string[]): Promise<{ code: number; out: string }> {
  const r = await podman(
    [
      'run',
      '--rm',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--user=10001:10001',
      `--entrypoint=${entrypoint}`,
      IMAGE,
      ...args,
    ],
    { timeoutMs: 120_000, maxStdoutBytes: 8 * 1024 * 1024 },
  );
  return { code: r.code ?? -1, out: new TextDecoder().decode(r.stdout) };
}

const lines = (s: string) => s.split('\n').filter(Boolean);

describe.skipIf(!ready.ok)(`SEC-053 criterion 1: the image is curated (${ready.reason})`, () => {
  it('keeps the packages of the class and finds their files', async () => {
    const kept = await run('cat', ['/opt/docedit/licences/tex/tex-packages-kept.txt']);
    expect(kept.code).toBe(0);
    const names = new Set(lines(kept.out));
    for (const p of CLASS_PACKAGES) expect(names.has(p), `${p} is kept`).toBe(true);
    const found = await run('kpsewhich', [...FIXED_LIST_FILES]);
    expect(found.code).toBe(0);
    const paths = lines(found.out);
    for (const f of FIXED_LIST_FILES)
      expect(
        paths.some((p) => p.startsWith(`${TL}/`) && p.endsWith(`/${f}`)),
        `kpsewhich finds ${f}`,
      ).toBe(true);
  }, 180_000);

  it('holds no package outside the list, and no documentation or sources', async () => {
    const gone = await run('kpsewhich', ['tikz.sty', 'pgf.sty', 'beamer.cls', 'minted.sty']);
    expect(lines(gone.out), 'none of TikZ, PGF, Beamer and Minted is found').toEqual([]);
    for (const dir of ['doc', 'source']) {
      const r = await run('find', [`${TL}/texmf-dist`, '-maxdepth', '1', '-name', dir]);
      expect(lines(r.out), `texmf-dist/${dir} is gone`).toEqual([]);
    }
    const formats = await run('ls', [`${TL}/texmf-var/web2c`]);
    expect(lines(formats.out), 'only the LuaTeX formats are left').toEqual(['luahbtex']);
  }, 180_000);

  it('lists in its package database the packages it keeps, and no others', async () => {
    const kept = await run('cat', ['/opt/docedit/licences/tex/tex-packages-kept.txt']);
    const db = await run('tlmgr', ['info', '--only-installed', '--data', 'name']);
    expect(db.code).toBe(0);
    expect(lines(db.out).sort()).toEqual(lines(kept.out).sort());
  }, 180_000);

  it('runs LuaTeX 1.17 or later', async () => {
    const r = await run('luatex', ['--version']);
    expect(r.code).toBe(0);
    const m = /Version (\d+)\.(\d+)/.exec(r.out);
    expect(m, r.out.slice(0, 200)).not.toBeNull();
    expect(Number(m![1]) > 1 || Number(m![2]) >= 17).toBe(true);
  }, 180_000);
});
