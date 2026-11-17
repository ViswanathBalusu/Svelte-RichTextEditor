/**
 * SEC-033 criterion 5 (10 §3.4 "the sandbox assumes the escaping will fail one day"; 09 §9.3): a
 * build in which the escaping is disabled, compiled in the real sandbox, is still contained.
 *
 * The bundle is the converter's own (the class, the setup lines, the body macros). The body holds
 * one paragraph for each injected string, converted with a placeholder of letters and digits; the
 * placeholder is then replaced in `main.tex` by the string itself, unescaped, which is what the
 * `text` emitter would write if its escaping were switched off. The strings are live TeX and Lua:
 * they run inside the class's own paragraph macros, and a positive control shows that they do.
 *
 * What they try is what the sandbox suite of SEC-035 tries from a hand-written bundle
 * (sandbox.escape.test.ts), with the same expectations: run commands (`\write18`, `os.execute`,
 * `io.popen`), read host files, other jobs' directories and credentials in the environment, write
 * outside the work directory, load the socket library, and `\input` an absolute path.
 *
 * Needs Podman and the worker image, and skips otherwise (`sandboxReady`).
 */
import type { CdmEnvelope } from '@docedit/model';
import { describe, expect, it, vi } from 'vitest';
import { buildBundle } from './bundle-io.ts';
import { imageFontManifest } from './fonts.ts';
import { compileInSandbox, IMAGE } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

const ready = await sandboxReady();

const report = (name: string, lua: string) =>
  `texio.write_nl("S4RESULT ${name}=" .. tostring(${lua}))`;
/** Lua without `%`, `#`, `~` or a backslash, so that it survives being read as paragraph text. */
const EXISTS =
  'local function ex(p) local f = io.open(p, "r") if f then f:close() return true end return false end';

/** The injected strings, in the order of their paragraphs. */
const INJECTED: readonly string[] = [
  // The positive control: the injected string runs as Lua.
  `\\directlua{${report('injected', '"yes"')}}`,
  // Commands.
  '\\immediate\\write18{touch /work/job/pwned18}',
  `\\directlua{local ok, r = pcall(os.execute, "touch /work/job/pwnedos") ${report('osexecute', 'r')}}`,
  `\\directlua{local ok, p = pcall(io.popen, "id") local out = "none" if ok and p then out = p:read("a") end ${report('popen', 'out')}}`,
  `\\directlua{${EXISTS} ${report('pwned18', 'ex("/work/job/pwned18")')} ${report('pwnedos', 'ex("/work/job/pwnedos")')}}`,
  // Host files, the engine's socket and other jobs' directories.
  `\\directlua{for i, p in ipairs({"/mnt/c", "/mnt/wsl", "/run/podman/podman.sock", "/var/run/docker.sock", "/run/user/0", "/root/.bashrc"}) do ${report('host" .. i .. "', 'not (lfs.attributes(p) == nil)')} end}`,
  `\\directlua{local names = {} for name in lfs.dir("/work") do if not (name == "." or name == "..") then names[1 + rawlen(names)] = name end end table.sort(names) ${report('work', 'table.concat(names, ",")')}}`,
  // Credentials in the environment: every variable name is reported.
  `\\directlua{local f = io.open("/proc/self/environ", "rb") if f then local zero = string.char(0) for kv in f:read("a"):gmatch("([^" .. zero .. "]+)") do ${report('env" .. kv:match("^([^=]+)") .. "', '"set"')} end f:close() end}`,
  // Writes outside the work directory.
  `\\directlua{for i, p in ipairs({"/tmp/x", "/var/tmp/x", "/run/x", "/opt/docedit/x", "/etc/x"}) do local f = io.open(p, "w") ${report('write" .. i .. "', 'not (f == nil)')} if f then f:close() end end}`,
  // The network.
  `\\directlua{local ok = pcall(require, "socket") ${report('socket', 'ok')} local ifs = {} for name in lfs.dir("/sys/class/net") do if not (name == "." or name == "..") then ifs[1 + rawlen(ifs)] = name end end table.sort(ifs) ${report('interfaces', 'table.concat(ifs, ",")')}}`,
  `\\directlua{${report('end', '"reached"')}}`,
  // Last, because the refusal may stop the job.
  '\\input{/etc/passwd}',
];

const placeholder = (i: number) => `SECINJ${String(i).padStart(2, '0')}PLACEHOLDER`;

function envelope(): CdmEnvelope {
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            { type: 'page_setup', attrs: { id: 'ps1' } },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: INJECTED.map((_, i) => ({
            type: 'paragraph',
            attrs: { id: `pInj${String(i).padStart(12, '0')}` },
            content: [{ type: 'text', text: placeholder(i) }],
          })),
        },
      ],
    },
  } as unknown as CdmEnvelope;
}

describe.skipIf(!ready.ok)(
  `SEC-033 criterion 5: unescaped strings in the sandbox (${ready.reason})`,
  () => {
    it('runs the injected strings and every attempt to leave the sandbox fails', async () => {
      const bundle = await buildBundle(envelope(), {
        fonts: await imageFontManifest(IMAGE),
        tagging: 'off',
        pdfStandard: 'none',
        layout: 'off',
      });
      // The escaping, disabled: each placeholder is replaced by its string as it is.
      let main = String(bundle.files['main.tex']);
      INJECTED.forEach((s, i) => {
        expect(main.split(placeholder(i))).toHaveLength(2);
        main = main.replace(placeholder(i), () => s);
      });
      for (const s of INJECTED) expect(main).toContain(s);

      const r = await compileInSandbox(
        { ...bundle.files, ...(bundle.assets ?? {}), 'main.tex': main },
        { minPasses: 1, maxPasses: 1 },
      );
      const results: Record<string, string> = {};
      for (const m of r.log.matchAll(/S4RESULT ([A-Za-z0-9_]+)=([^\r\n]*)/g))
        results[m[1]!] = m[2]!.trim();
      const tail = r.log.slice(-1500);

      // The strings ran: the escaping really was off.
      expect(results['injected'], tail).toBe('yes');
      // The log line goes on with the file the next string opens.
      expect(results['end'], tail).toMatch(/^reached\b/);

      // Commands.
      expect(results['pwned18']).toBe('false');
      expect(results['pwnedos']).toBe('false');
      expect(results['popen']).not.toMatch(/uid=/);

      // Host files and other jobs.
      const hosts = Object.keys(results).filter((k) => /^host\d$/.test(k));
      expect(hosts).toHaveLength(6);
      for (const k of hosts) expect(results[k], k).toBe('false');
      // The work directory holds this job and its own TeX cache, and no other job's directory.
      expect(results['work']).toBe('.texmf-var,job');

      // The environment holds no credential.
      const env = Object.keys(results)
        .filter((k) => k.startsWith('env'))
        .map((k) => k.slice(3));
      expect(env.length).toBeGreaterThan(0);
      for (const name of env)
        expect(name).not.toMatch(/TOKEN|SECRET|PASSWORD|CREDENTIAL|AWS|AZURE|GOOGLE|DATABASE|S3/i);

      // Writes outside the work directory.
      const writes = Object.keys(results).filter((k) => /^write\d$/.test(k));
      expect(writes).toHaveLength(5);
      for (const k of writes) expect(results[k], k).toBe('false');

      // The network.
      expect(results['socket']).toBe('false');
      expect(results['interfaces']).toBe('lo');

      // `\input` of an absolute path: the job fails and the file is not in the log.
      expect(r.exitCode).not.toBe(0);
      expect(r.log).not.toContain('root:x:0:0');
      expect(r.pdf ?? null).toBeNull();
    });
  },
);
