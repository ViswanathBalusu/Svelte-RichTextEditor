/**
 * Sandbox escape tests (09 §9.3, §14; 10 §3.4, §5; spike S4, SPK-017; groundwork for EXP-075).
 *
 * The bundles here bypass the converter on purpose: 09 §9.3 item 2 says any TeX injection must be
 * assumed to mean arbitrary Lua, so the tests run arbitrary Lua and TeX inside the real image and
 * check that every attempt fails and the job ends within its limits. They need Podman and the
 * worker image, and skip otherwise (`sandboxReady`). Findings are written to
 * services/export-worker/out/escape-results.json for the spike report.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { demoDocument } from '../test/documents.ts';
import { containerExists } from './container.ts';
import { parseLog } from './diagnostics.ts';
import { imageFontManifest } from './fonts.ts';
import { limitReached } from './outcome.ts';
import { runExport } from './pipeline.ts';
import {
  compileInSandbox,
  IMAGE,
  LIMITS,
  runInSandbox,
  sandboxArgs,
  type SandboxOptions,
} from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

// Each case starts a container, and some wait for a limit to trip.
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const ready = await sandboxReady();
const findings: Record<string, unknown> = {
  readiness: { ok: ready.ok, reason: ready.reason, machine: ready.machine, podman: ready.info },
};

afterAll(() => {
  if (!ready.ok) return;
  const dir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'out');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'escape-results.json'), JSON.stringify(findings, null, 2));
});

const TEX_HEAD = '\\documentclass{article}\n\\begin{document}\n';
const TEX_TAIL = '\n\\typeout{S4RESULT end=reached}\nx\n\\end{document}\n';

/** A bundle of main.tex (and optionally attack.lua), compiled once without the class. */
async function attack(name: string, body: string, lua: string | null, opts: SandboxOptions = {}) {
  const files: Record<string, string> = { 'main.tex': TEX_HEAD + body + TEX_TAIL };
  if (lua) files['attack.lua'] = lua;
  const r = await compileInSandbox(files, { minPasses: 1, maxPasses: 1, ...opts });
  const results: Record<string, string> = {};
  for (const m of r.log.matchAll(/S4RESULT ([A-Za-z0-9_]+)=([^\r\n]*)/g))
    results[m[1]!] = m[2]!.trim();
  findings[name] = {
    exitCode: r.exitCode,
    timedOut: r.timedOut,
    outputOverflow: r.outputOverflow,
    wallMs: Math.round(r.wallMs),
    passes: r.passes,
    results,
  };
  return { r, results };
}

const LUA_TRY = `
local function report(name, value) texio.write_nl("S4RESULT " .. name .. "=" .. tostring(value)) end
local function try(name, f)
  local ok, res = pcall(f)
  if ok then report(name, res) else report(name, "error " .. tostring(res):gsub("%s+", " "):sub(1, 60)) end
end
local function exists(path) local f = io.open(path, "r") if f then f:close() return true end return false end
`;

describe.skipIf(!ready.ok)(`sandbox escape tests (${ready.reason})`, () => {
  it('runs a current LuaTeX with shell escape off and paranoid file access', async () => {
    const r = await runInSandbox(
      'luatex --version | head -1; for v in shell_escape openin_any openout_any; do echo "$v=$(kpsewhich -var-value $v)"; done; id -u; grep -E "^(CapEff|NoNewPrivs)" /proc/self/status\n',
    );
    const out = new TextDecoder().decode(r.stdout);
    findings['engine'] = out.trim().split('\n');
    const version = /Version 1\.(\d+)/.exec(out);
    expect(Number(version?.[1])).toBeGreaterThanOrEqual(17);
    expect(out).toContain('shell_escape=f');
    expect(out).toContain('openin_any=p');
    expect(out).toContain('openout_any=p');
    expect(out).toMatch(/^10001$/m);
    expect(out).toMatch(/CapEff:\s+0000000000000000/);
    expect(out).toMatch(/NoNewPrivs:\s+1/);
  });

  it('cannot run commands: \\write18, os.execute, io.popen (CVE-2023-32700)', async () => {
    const { results } = await attack(
      'shell',
      '\\immediate\\write18{touch /work/job/pwned-write18}\n\\directlua{dofile("attack.lua")}\n',
      LUA_TRY +
        `
try("os_execute", function() return os.execute("touch /work/job/pwned-os") end)
try("io_popen", function() local p = io.popen("id") return p and p:read("*a") or "nil" end)
try("os_spawn", function() return os.spawn and os.spawn("touch /work/job/pwned-spawn") or "absent" end)
try("os_exec", function() return os.exec and "present" or "absent" end)
report("pwned_write18", exists("/work/job/pwned-write18"))
report("pwned_os", exists("/work/job/pwned-os"))
report("pwned_spawn", exists("/work/job/pwned-spawn"))
`,
    );
    expect(results['end']).toBe('reached');
    expect(results['pwned_write18']).toBe('false');
    expect(results['pwned_os']).toBe('false');
    expect(results['pwned_spawn']).toBe('false');
    expect(results['io_popen']).not.toMatch(/uid=/);
  });

  it('cannot replace the engine with os.exec', async () => {
    // If os.exec worked, `touch` would replace LuaTeX and create main.layout, an allow-listed
    // output; the compile would also end before "end" is reached.
    const { r, results } = await attack(
      'os_exec',
      '\\directlua{dofile("attack.lua")}',
      LUA_TRY + 'try("os_exec_call", function() return os.exec("touch main.layout") end)\n',
    );
    expect(r.layoutRaw).toBeNull();
    expect(results['end']).toBe('reached');
  });

  it('reads only the image: no host path, no credentials (TeX reads are not restricted)', async () => {
    const { results } = await attack(
      'read',
      [
        '\\newread\\r',
        '\\openin\\r=/etc/passwd \\ifeof\\r\\typeout{S4RESULT tex_abs=blocked}\\else\\typeout{S4RESULT tex_abs=READ}\\fi',
        '\\openin\\r=../../etc/passwd \\ifeof\\r\\typeout{S4RESULT tex_dotdot=blocked}\\else\\typeout{S4RESULT tex_dotdot=READ}\\fi',
        '\\openin\\r=/opt/docedit/compile.sh \\ifeof\\r\\typeout{S4RESULT tex_image=blocked}\\else\\typeout{S4RESULT tex_image=READ}\\fi',
        '\\directlua{dofile("attack.lua")}',
      ].join('\n'),
      LUA_TRY +
        `
local pw = io.open("/etc/passwd")
local passwd = pw and pw:read("*a") or ""
if pw then pw:close() end
report("lua_passwd_is_image", passwd:find("tex:x:10001", 1, true) ~= nil)
for _, p in ipairs({ "/mnt/c", "/mnt/wsl", "/run/podman/podman.sock", "/var/run/docker.sock", "/run/user/0" }) do
  report("host_" .. p:gsub("[^%w]", "_"), lfs.attributes(p) ~= nil)
end
report("root_readable", exists("/root/.bashrc"))
-- Podman's default mounts.conf adds /run/secrets (subscription data of the host) to every container.
local keys = 0
local function walk(dir)
  for name in lfs.dir(dir) do
    if name ~= "." and name ~= ".." then
      local p = dir .. "/" .. name
      local a = lfs.attributes(p)
      if a and a.mode == "directory" then walk(p) elseif name:find("key") then keys = keys + 1 end
    end
  end
end
if lfs.attributes("/run/secrets") then pcall(walk, "/run/secrets") report("run_secrets", "present") else report("run_secrets", "absent") end
report("secret_key_files", keys)
local f = io.open("/proc/self/environ", "rb")
if f then
  for kv in f:read("*a"):gmatch("([^\\0]+)") do report("env_" .. kv:match("^([^=]+)"), "set") end
  f:close()
end
`,
    );
    // Paranoid reading (openin_any=p) is set, but LuaTeX 1.24 still opens absolute and parent
    // paths for \\openin; recorded here, not relied on. The image therefore holds no secrets.
    findings['tex_reads'] = {
      abs: results['tex_abs'],
      dotdot: results['tex_dotdot'],
      image: results['tex_image'],
    };
    expect(results['lua_passwd_is_image']).toBe('true');
    for (const k of Object.keys(results).filter((k) => k.startsWith('host_')))
      expect(results[k], k).toBe('false');
    expect(results['root_readable']).toBe('false');
    expect(results['secret_key_files']).toBe('0');
    const env = Object.keys(results)
      .filter((k) => k.startsWith('env_'))
      .map((k) => k.slice(4));
    findings['environment'] = env;
    expect(env.length).toBeGreaterThan(0);
    for (const name of env)
      expect(name).not.toMatch(/TOKEN|SECRET|PASSWORD|CREDENTIAL|AWS|AZURE|GOOGLE/i);
  });

  it('fails the job on \\input of an absolute path, without the file in the log', async () => {
    const { r } = await attack('input', '\\input{/etc/passwd}', null);
    expect(r.exitCode).not.toBe(0);
    expect(r.log).not.toContain('root:x:0:0');
  });

  it('cannot write outside the work directory', async () => {
    // Lua first, because a refused \openout may stop the compile; then TeX; then a check.
    const { r, results } = await attack(
      'write',
      [
        '\\directlua{dofile("attack.lua")}',
        '\\newwrite\\w',
        '\\immediate\\openout\\w=/tmp/pwned-tex.tex \\immediate\\write\\w{x}\\immediate\\closeout\\w',
        '\\immediate\\openout\\w=../pwned-dotdot.tex \\immediate\\write\\w{x}\\immediate\\closeout\\w',
        '\\typeout{S4RESULT tex_openout=returned}',
        '\\directlua{dofile("check.lua")}',
      ].join('\n'),
      LUA_TRY +
        `
for _, p in ipairs({ "/tmp/x", "/var/tmp/x", "/run/x", "/opt/docedit/x", "/usr/local/texlive/2026/texmf-var/x", "/etc/x" }) do
  local f = io.open(p, "w")
  report("lua_" .. p:gsub("[^%w]", "_"), f ~= nil)
  if f then f:close() end
end
-- io.open honours openout_any=p (absolute paths refused, even inside the job), lfs does not.
local f = io.open("allowed", "w")
report("lua_job_dir", f ~= nil)
if f then f:close() end
report("lua_abs_in_job", io.open("/work/job/allowed2", "w") ~= nil)
report("lfs_mkdir_tmp", lfs.mkdir("/tmp/s4dir") == true)
report("lfs_mkdir_work", lfs.mkdir("/work/s4dir") == true)
report("lfs_mkdir_rel", lfs.mkdir("s4rel") == true)
report("lfs_mkdir_up", lfs.mkdir("../s4up") == true)
local c = io.open("check.lua", "w")
c:write([[
local function exists(path) local f = io.open(path, "r") if f then f:close() return true end return false end
texio.write_nl("S4RESULT tex_tmp=" .. tostring(exists("/tmp/pwned-tex.tex")))
texio.write_nl("S4RESULT tex_dotdot=" .. tostring(exists("/work/pwned-dotdot.tex")))
]])
c:close()
`,
    );
    for (const k of Object.keys(results).filter((k) => k.startsWith('lua__')))
      expect(results[k], k).toBe('false');
    expect(results['lua_job_dir']).toBe('true');
    expect(results['lfs_mkdir_tmp']).toBe('false');
    // Either TeX refused the file and went on, or the refusal stopped the job: both are safe.
    if (results['tex_openout'] === 'returned') {
      expect(results['tex_tmp']).toBe('false');
      expect(results['tex_dotdot']).toBe('false');
    } else expect(r.exitCode).not.toBe(0);
  });

  it('has no network: no socket library (CVE-2023-32668) and no interface but loopback', async () => {
    const { results } = await attack(
      'network',
      '\\directlua{dofile("attack.lua")}',
      LUA_TRY +
        `
try("require_socket", function() local s = require("socket") return s and "loaded" or "nil" end)
local ifs = {}
for name in lfs.dir("/sys/class/net") do if name ~= "." and name ~= ".." then ifs[#ifs + 1] = name end end
table.sort(ifs)
report("interfaces", table.concat(ifs, ","))
`,
    );
    expect(results['require_socket']).toMatch(/^error/);
    expect(results['interfaces']).toBe('lo');
    const r = await runInSandbox(
      "bash -c 'exec 3<>/dev/tcp/1.1.1.1/53 && echo CONNECTED || echo refused' 2>&1; getent hosts example.org || echo noresolve\n",
    );
    const out = new TextDecoder().decode(r.stdout);
    findings['network_shell'] = out.trim().split('\n');
    expect(out).not.toContain('CONNECTED');
    expect(out).toContain('noresolve');
  });

  it('stops a runaway TeX loop at the pass time limit', async () => {
    const { r } = await attack('tex_loop', '\\def\\x{\\x}\\x', null, {
      passTimeoutSeconds: 5,
      limits: { wallSeconds: 40 },
    });
    expect(r.ok).toBe(false);
    expect(r.passes[0]?.rc).toBe(137);
    expect(r.wallMs).toBeLessThan(40_000);
  });

  it('stops a runaway Lua loop at the pass time limit', async () => {
    const { r } = await attack(
      'lua_loop',
      '\\directlua{dofile("attack.lua")}',
      'while true do end\n',
      {
        passTimeoutSeconds: 5,
        limits: { wallSeconds: 40 },
      },
    );
    expect(r.ok).toBe(false);
    expect(r.passes[0]?.rc).toBe(137);
    expect(r.wallMs).toBeLessThan(40_000);
  });

  it('stops the whole job at the wall-clock limit even when the entry point ignores it', async () => {
    const started = performance.now();
    const r = await runInSandbox('sleep 300\n', { limits: { wallSeconds: 10 } });
    const ms = performance.now() - started;
    findings['wall_clock'] = {
      code: r.code,
      signal: r.signal,
      timedOut: r.timedOut,
      ms: Math.round(ms),
    };
    expect(r.code).not.toBe(0);
    expect(ms).toBeLessThan(30_000);
  });

  it('caps the number of processes (fork bomb)', async () => {
    // dash stops at the first fork that fails; `echo` and `read` are built-ins and need no fork.
    const r = await runInSandbox(
      'exec 2>&1\nread max < /sys/fs/cgroup/pids.max; echo "pids.max=$max"\n' +
        'i=0; while [ $i -lt 300 ]; do sleep 20 & i=$((i+1)); echo "started=$i"; done\necho "loop finished"\n',
      { limits: { wallSeconds: 60 } },
    );
    const out = new TextDecoder().decode(r.stdout);
    const started = Math.max(0, ...[...out.matchAll(/started=(\d+)/g)].map((m) => Number(m[1])));
    findings['fork_bomb'] = {
      started,
      limit: LIMITS.pids,
      code: r.code,
      tail: out.trim().split('\n').slice(-3),
    };
    expect(out).toContain(`pids.max=${LIMITS.pids}`);
    expect(out).not.toContain('loop finished');
    expect(started).toBeLessThan(LIMITS.pids);
  });

  it('kills a memory bomb at the memory limit', async () => {
    const { r } = await attack(
      'memory',
      '\\directlua{dofile("attack.lua")}',
      'local t = {}\nlocal i = 0\nwhile true do i = i + 1 t[i] = string.rep("x", 1048576) .. i end\n',
      { limits: { wallSeconds: 90 } },
    );
    expect(r.ok).toBe(false);
    expect(r.wallMs).toBeLessThan(90_000);
  });

  it('bounds the output: a file larger than the limit cannot be written or returned', async () => {
    const { r, results } = await attack(
      'output',
      '\\directlua{dofile("attack.lua")}',
      LUA_TRY +
        `
local chunk = string.rep("y", 1048576)
local f = io.open("main.log", "a")
local written = 0
local ok, err = pcall(function() for i = 1, 300 do assert(f:write(chunk)) written = i end end)
report("mib_written", written)
`,
      { limits: { wallSeconds: 90 } },
    );
    findings['output_bytes_returned'] = r.log.length;
    expect(r.log.length).toBeLessThanOrEqual(LIMITS.outputBytes + 1024 * 1024);
    expect(Number(results['mib_written'] ?? '0')).toBeLessThan(300);
  });

  it('keeps nothing between jobs', async () => {
    // The writer tries to leave the job directory first (lfs.chdir is refused under openout_any=p,
    // so the marker lands in the job directory); either way the next job must not see it.
    const w = await attack(
      'cross_job_writer',
      '\\directlua{dofile("attack.lua")}',
      LUA_TRY +
        'report("chdir", lfs.chdir("/work"))\nlocal f = io.open("s4-marker", "w")\nreport("marker_made", f ~= nil)\nif f then f:write("secret") f:close() end\nlfs.chdir("/work/job")\n',
    );
    expect(w.results['marker_made']).toBe('true');
    const { results } = await attack(
      'cross_job_reader',
      '\\directlua{dofile("attack.lua")}',
      LUA_TRY +
        'report("marker", lfs.attributes("/work/s4-marker") ~= nil or lfs.attributes("/work/job/s4-marker") ~= nil)\n',
    );
    expect(results['marker']).toBe('false');
  });

  // Added for the compile service (phase 1b, packet X3): EXP-070 to EXP-072, EXP-075; SEC-035.

  it('mounts nothing from the host: no /run/secrets and no host path (EXP-072 criterion 1)', async () => {
    const r = await runInSandbox(
      'exec 2>&1\nif [ -e /run/secrets ]; then echo secrets=present; else echo secrets=absent; fi\ncat /proc/self/mountinfo\n',
    );
    const out = new TextDecoder().decode(r.stdout);
    findings['mounts'] = out.trim().split('\n');
    expect(out).toContain('secrets=absent');
    expect(out).not.toMatch(/\/run\/secrets|\/mnt\/|\.sock/);
    // Every mount is the image's overlay, a tmpfs, or a kernel file system of the container. The
    // only other sources are the runtime's own: the standard device nodes (a rootless runtime binds
    // them from the host: /null, /zero, /full, /tty, /random, /urandom), an empty directory over the
    // masked paths of /proc and /sys, and the container's hostname and .containerenv files. The
    // storage directory sits under /containers/storage on a rootful runtime and under
    // /containers on a rootless one.
    //
    // No mount point or root may name a host path. The super options of the overlay are the
    // runtime's own storage (a rootless runtime keeps it under the user's home, as the hosted
    // runner does), so the home directory is checked on mount points and roots only.
    for (const line of out.split('\n').filter((l) => /^\d+ \d+ /.test(l))) {
      const [left, right] = line.split(' - ');
      const fields = left!.split(' ');
      const root = fields[3]!;
      const mountPoint = fields[4]!;
      const fsType = right?.split(' ')[0] ?? '';
      expect(`${root} ${mountPoint}`, line).not.toMatch(/\/home\//);
      if (fsType === 'devtmpfs')
        expect(root, line).toMatch(/^\/(null|zero|full|tty|random|urandom)$/);
      else
        expect(
          ['overlay', 'tmpfs', 'proc', 'sysfs', 'devpts', 'mqueue', 'cgroup2', 'shm'],
          line,
        ).toContain(fsType);
      if (fsType === 'tmpfs' && root !== '/')
        expect(root, line).toMatch(
          /^(\/crun\/\.empty-directory|\/containers\/(storage\/)?overlay-containers\/[0-9a-f]{64}\/userdata\/(hostname|\.containerenv))$/,
        );
    }
  });

  it('cannot reach the database, the object store or any other service (EXP-072 criterion 2)', async () => {
    const r = await runInSandbox(
      [
        'exec 2>&1',
        'for target in 127.0.0.1/55432 127.0.0.1/57070 10.0.2.2/5432 172.17.0.1/5432 192.168.127.254/80; do',
        '  if bash -c "exec 3<>/dev/tcp/$target" 2>/dev/null; then echo "reached $target"; else echo "refused $target"; fi',
        'done',
        'getent hosts host.containers.internal || echo noresolve',
        '',
      ].join('\n'),
      { limits: { wallSeconds: 60 } },
    );
    const out = new TextDecoder().decode(r.stdout);
    findings['services'] = out.trim().split('\n');
    expect(out).not.toContain('reached');
    expect(out.match(/refused/g)).toHaveLength(5);
    expect(out).toContain('noresolve');
  });

  it('holds no private key or signing key that the job can read (EXP-072 criterion 3)', async () => {
    const r = await runInSandbox(
      'exec 2>&1\ngrep -rIl -e "PRIVATE KEY" /opt /etc /run /work /home /root /var /tmp 2>/dev/null | head -20\necho scan-done\n',
      { limits: { wallSeconds: 100 } },
    );
    const out = new TextDecoder().decode(r.stdout);
    findings['private_keys'] = out.trim().split('\n');
    expect(out).toContain('scan-done');
    expect(out.trim()).toBe('scan-done');
  });

  it('applies the limits of 09 §9.3 item 4 to every job (EXP-071 criterion 1)', async () => {
    const r = await runInSandbox(
      [
        'exec 2>&1',
        'echo "memory=$(cat /sys/fs/cgroup/memory.max)"',
        'echo "cpu=$(cat /sys/fs/cgroup/cpu.max)"',
        'echo "pids=$(cat /sys/fs/cgroup/pids.max)"',
        'echo "work=$(df -k /work | tail -1 | tr -s " " | cut -d" " -f2)"',
        'echo "fsize=$(ulimit -f)"',
        'echo "cputime=$(ulimit -t)"',
        'echo "pages=$DOCEDIT_MAX_PAGES"',
        'echo "pass=$DOCEDIT_PASS_TIMEOUT"',
        '',
      ].join('\n'),
    );
    const out = new TextDecoder().decode(r.stdout);
    findings['limits'] = out.trim().split('\n');
    expect(out).toContain(`memory=${LIMITS.memoryMiB * 1024 * 1024}`);
    expect(out).toContain('cpu=100000 100000');
    expect(out).toContain(`pids=${LIMITS.pids}`);
    expect(out).toContain(`work=${LIMITS.workMiB * 1024}`);
    expect(out).toContain(`fsize=${LIMITS.outputBytes / 512}`);
    expect(out).toContain(`cputime=${LIMITS.wallSeconds}`);
    expect(out).toContain(`pages=${LIMITS.pages}`);
    expect(out).toContain(`pass=${LIMITS.wallSeconds - 10}`);
    // The wall clock is enforced by Podman for the whole job, all passes included.
    expect(sandboxArgs('x')).toContain(`--timeout=${LIMITS.wallSeconds}`);
  });

  it('stops a disk filler at the working directory limit, and the next job is unaffected (EXP-071 criterion 3)', async () => {
    // A shell filler reports on standard output, which is a pipe: the disk is full, the pipe not.
    const shell = await runInSandbox(
      'i=0; while head -c 10485760 /dev/zero > /work/fill-$i 2>/dev/null; do i=$((i+1)); done\n' +
        'echo "files=$i"; echo "used=$(du -sk /work | cut -f1)"; df -k /work | tail -1\n',
      { limits: { wallSeconds: 60 } },
    );
    const out = new TextDecoder().decode(shell.stdout);
    findings['disk_filler_shell'] = out.trim().split('\n');
    const used = Number(/used=(\d+)/.exec(out)?.[1] ?? 'NaN');
    expect(used).toBeLessThanOrEqual(LIMITS.workMiB * 1024);
    expect(used).toBeGreaterThan(LIMITS.workMiB * 1024 * 0.9);
    // The same from Lua inside a compile: the job fails at the limit, and says which.
    const { r, results } = await attack(
      'disk_filler',
      '\\directlua{dofile("attack.lua")}',
      LUA_TRY +
        `
local chunk = string.rep("z", 1048576)
local total = 0
for i = 1, 400 do
  local f = io.open("fill-" .. i, "wb")
  if not f then break end
  local ok = true
  for j = 1, 10 do
    local w, err = f:write(chunk)
    if not w then ok = false break end
    total = total + 1
  end
  f:close()
  if not ok then break end
end
report("mib_written", total)
`,
      { limits: { wallSeconds: 90 } },
    );
    findings['disk_filler'] = { exitCode: r.exitCode, results, wallMs: Math.round(r.wallMs) };
    expect(r.ok).toBe(false);
    expect(limitReached(r, parseLog(r.log, null))).toBe('workdir');
    expect(r.wallMs).toBeLessThan(90_000);
    expect(await containerExists(r.name)).toBe(false);
    const next = await compileInSandbox(
      { 'main.tex': TEX_HEAD + 'after the filler' + TEX_TAIL },
      { minPasses: 1, maxPasses: 1 },
    );
    expect(next.ok, next.log.slice(-500)).toBe(true);
  });

  it('stops a document of 2,001 pages at the page limit (EXP-071 criterion 3; SEC-035 criterion 2)', async () => {
    const body = Array.from({ length: LIMITS.pages + 1 }, (_, i) => ({
      type: 'paragraph',
      attrs: { id: `pPage${String(i).padStart(11, '0')}`, style: 'Normal', pageBreakBefore: i > 0 },
      content: [{ type: 'text', text: `Page ${i + 1}` }],
    }));
    const envelope = {
      ...demoDocument().envelope,
    } as unknown as { doc: { content: Array<{ type: string; content: unknown[] }> } };
    const doc = structuredClone(envelope);
    doc.doc.content[1]!.content = body;
    const fonts = await imageFontManifest(IMAGE);
    const r = await runExport(
      doc as never,
      fonts,
      { tagging: 'none', pdfStandard: 'none', layout: 'off', profile: 'preview' },
      { kind: 'sandbox', options: { minPasses: 1, maxPasses: 1 } },
    );
    findings['page_limit'] = {
      ok: r.compile.ok,
      exitCode: r.compile.exitCode,
      passes: r.compile.passes,
      wallMs: Math.round(r.compile.wallMs),
    };
    expect(r.compile.ok).toBe(false);
    const log = parseLog(r.compile.log, r.bundle.map);
    expect(limitReached(r.compile, log)).toBe('pages');
    expect(r.compile.wallMs).toBeLessThan(LIMITS.wallSeconds * 1000 + 15_000);
  });

  it('kills a memory bomb without disturbing a job that runs at the same time (EXP-071 criterion 3)', async () => {
    const [bomb, neighbour] = await Promise.all([
      attack(
        'memory_neighbour',
        '\\directlua{dofile("attack.lua")}',
        'local t = {}\nlocal i = 0\nwhile true do i = i + 1 t[i] = string.rep("x", 1048576) .. i end\n',
        { limits: { wallSeconds: 90 } },
      ),
      compileInSandbox(
        { 'main.tex': TEX_HEAD + 'a neighbour of the memory bomb' + TEX_TAIL },
        { minPasses: 1, maxPasses: 1 },
      ),
    ]);
    expect(bomb.r.ok).toBe(false);
    expect(limitReached(bomb.r, parseLog(bomb.r.log, null))).toBe('memory');
    expect(neighbour.ok, neighbour.log.slice(-500)).toBe(true);
  });

  it('removes the sandbox of every job, whether it finished, failed or timed out (EXP-070 criterion 3)', async () => {
    const done = await compileInSandbox(
      { 'main.tex': TEX_HEAD + 'fine' + TEX_TAIL },
      { minPasses: 1, maxPasses: 1 },
    );
    const failed = await compileInSandbox(
      { 'main.tex': TEX_HEAD + '\\undefinedcommand' + TEX_TAIL },
      { minPasses: 1, maxPasses: 1 },
    );
    const timedOut = await runInSandbox('sleep 300\n', { limits: { wallSeconds: 8 } });
    expect(done.ok).toBe(true);
    expect(failed.ok).toBe(false);
    expect(timedOut.code).not.toBe(0);
    for (const name of [done.name, failed.name, timedOut.name])
      expect(await containerExists(name), name).toBe(false);
  });

  it('builds only on LuaTeX 1.17 or later, never with --safer, and keeps file and line errors (EXP-068 criteria 2 and 3)', async () => {
    const containerfile = readFileSync(join(here, '..', 'Containerfile'), 'utf8');
    const pattern = /grep -E '([^']+)'/.exec(containerfile)?.[1];
    expect(pattern).toBeDefined();
    const versions = ['1.16.0', '1.17.0', '1.18.2', '1.24.0', '1.9.0', '1.10.0', '2.0.0', '0.95.0'];
    const r = await runInSandbox(
      versions
        .map(
          (v) =>
            `printf 'This is LuaHBTeX, Version ${v}\\n' | grep -qE '${pattern}' && echo "${v} accepted" || echo "${v} refused"`,
        )
        .join('\n') + '\n',
    );
    const out = new TextDecoder().decode(r.stdout);
    findings['engine_check'] = out.trim().split('\n');
    for (const v of ['1.17.0', '1.18.2', '1.24.0']) expect(out).toContain(`${v} accepted`);
    for (const v of ['1.16.0', '1.9.0', '1.10.0', '2.0.0', '0.95.0'])
      expect(out).toContain(`${v} refused`);
    const compile = readFileSync(join(here, '..', 'image', 'compile.sh'), 'utf8');
    expect(compile).not.toContain('--safer');
    expect(compile).toContain('--no-shell-escape');
    expect(compile).toContain('--file-line-error');
  });
});
