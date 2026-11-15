/**
 * EXP-001 criterion 3 (lane w2): a bundle that tries to open a network connection while the worker
 * compiles it. Needs Podman and the worker image; skips otherwise (sandbox-ready.ts).
 *
 * The bundle is hand-written, because the converter never writes Lua into a document. Its
 * `main.tex` runs a Lua file of the bundle inside the LuaTeX process of the compile (`compileInSandbox`, the call the
 * export job makes, with the job's own flags) and tries three ways out, writing each outcome to
 * the log, which is the only text that leaves the sandbox:
 *
 *   1. LuaTeX's own socket library: a TCP connection to a public address and a name lookup;
 *   2. a child process (`os.execute`, `io.popen`) that would open the connection for it;
 *   3. the network interfaces the process can see (`/sys/class/net`).
 *
 * Two separate things stop it, and the test reports which: the compile runs with
 * `--no-shell-escape`, under which LuaTeX gives no working socket library and starts no child
 * process; and the container has `--network=none`, so only the loopback interface exists. The
 * second is shown from inside the LuaTeX process by the interface list, and for a process that does
 * have sockets by the probe of exp-001-u-exp-001-016.e2e.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { compileInSandbox, runInSandbox, sandboxArgs } from './sandbox.ts';
import { sandboxReady } from './sandbox-ready.ts';

vi.setConfig({ testTimeout: 300_000 });

const ready = await sandboxReady();

const PROBE_LUA = String.raw`  local function say(k, v) texio.write_nl('log', 'DOCEDIT-NET ' .. k .. '=' .. tostring(v) .. ';') end
  local function connect()
    local ok, socket = pcall(require, 'socket')
    if not ok or type(socket) ~= 'table' or type(socket.tcp) ~= 'function' then
      return 'nosocket'
    end
    local made, c = pcall(socket.tcp)
    if not made or not c then return 'nosocket' end
    c:settimeout(5)
    local done, err = c:connect('1.1.1.1', 443)
    c:close()
    if done then return 'connected' end
    return 'failed:' .. tostring(err)
  end
  local function resolve()
    local ok, socket = pcall(require, 'socket')
    if not ok or type(socket) ~= 'table' or type(socket.dns) ~= 'table' then return 'nosocket' end
    local found, ip = pcall(socket.dns.toip, 'example.org')
    if found and ip then return 'resolved' end
    return 'noresolve'
  end
  local function child()
    local ok, rc = pcall(os.execute, 'true')
    if ok and (rc == true or rc == 0) then return 'ran' end
    local opened, p = pcall(io.popen, 'echo ran')
    if opened and p then
      local out = p:read('*a')
      p:close()
      if out and out:find('ran') then return 'ran' end
    end
    return 'refused'
  end
  local function interfaces()
    local names = {}
    local ok = pcall(function()
      for n in lfs.dir('/sys/class/net') do
        if n ~= '.' and n ~= '..' then names[#names + 1] = n end
      end
    end)
    if not ok then return 'unreadable' end
    if #names == 0 then return 'none' end
    table.sort(names)
    return table.concat(names, ',')
  end
  for k, f in pairs({ connect = connect, resolve = resolve, child = child, interfaces = interfaces }) do
    local ok, v = pcall(f)
    say(k, ok and v or 'error')
  end
`;

const MAIN_TEX = String.raw`\documentclass{article}
\begin{document}
\directlua{dofile('probe.lua')}
Network probe.
\end{document}
`;

describe.skipIf(!ready.ok)(`EXP-001 criterion 3: a bundle has no network (${ready.reason})`, () => {
  it('compiles a bundle that tries to connect: every attempt fails, and only loopback exists', async () => {
    const name = `docedit-job-w2-exp-001-${Date.now().toString(36)}`;
    // The flags of a compile job: no network (the criterion's reason), set by sandboxArgs.
    expect(sandboxArgs(name)).toContain('--network=none');
    const r = await compileInSandbox(
      { 'main.tex': MAIN_TEX, 'probe.lua': PROBE_LUA },
      { name, maxPasses: 1, minPasses: 1 },
    );
    expect(r.ok, r.log.slice(-2000) + r.stderr).toBe(true);
    expect(r.log).toContain('This is LuaHBTeX');
    const value = (key: string) =>
      new RegExp(`^DOCEDIT-NET ${key}=([^;]*);`, 'm').exec(r.log)?.[1] ?? null;
    const outcome = {
      connect: value('connect'),
      resolve: value('resolve'),
      child: value('child'),
      interfaces: value('interfaces'),
    };
    // The probe ran: all four lines are in the log.
    for (const [k, v] of Object.entries(outcome)) expect(v, k).not.toBeNull();
    // No connection and no name lookup, whichever layer refused.
    expect(outcome.connect, JSON.stringify(outcome)).toMatch(/^(nosocket|failed:.+)$/);
    expect(outcome.resolve, JSON.stringify(outcome)).toMatch(/^(nosocket|noresolve)$/);
    // No child process to do it instead (`--no-shell-escape`).
    expect(outcome.child, JSON.stringify(outcome)).toBe('refused');
    // The container has no network: the LuaTeX process sees the loopback interface only.
    expect(outcome.interfaces, JSON.stringify(outcome)).toBe('lo');
    console.info(`EXP-001 criterion 3, outcome inside LuaTeX: ${JSON.stringify(outcome)}`);
  });

  it('with LuaTeX given its socket library, the same bundle still cannot connect: there is no network', async () => {
    // Not how a job runs: `--shell-escape` here only hands the bundle a working socket library and
    // child processes, so that the attempt reaches the kernel and the container's network is what
    // refuses it. Same image, same container flags (sandboxArgs), another entry point.
    const script = [
      'set -eu',
      'mkdir -p /work/job /work/.texmf-var/luatex-cache/generic',
      'cp -r /opt/docedit/luaotfload-names /work/.texmf-var/luatex-cache/generic/names',
      'cd /work/job',
      "cat > probe.lua <<'DOCEDIT_EOF'",
      PROBE_LUA,
      'DOCEDIT_EOF',
      "cat > main.tex <<'DOCEDIT_EOF'",
      MAIN_TEX,
      'DOCEDIT_EOF',
      'lualatex --interaction=nonstopmode --halt-on-error --shell-escape main.tex >/dev/null 2>&1 || echo "lualatex-failed=$?;"',
      'grep "^DOCEDIT-NET " main.log',
      '',
    ].join('\n');
    const r = await runInSandbox(script, {
      name: `docedit-test-w2-exp-001-${Date.now().toString(36)}`,
    });
    const out = new TextDecoder().decode(r.stdout);
    expect(r.code, out + r.stderr).toBe(0);
    const value = (key: string) =>
      new RegExp(`^DOCEDIT-NET ${key}=([^;]*);`, 'm').exec(out)?.[1] ?? null;
    const outcome = {
      connect: value('connect'),
      resolve: value('resolve'),
      child: value('child'),
      interfaces: value('interfaces'),
    };
    // This time the bundle has sockets and child processes, so the refusal is the network's.
    expect(outcome.child, out).toBe('ran');
    expect(outcome.connect, out).toMatch(/^failed:.+/);
    expect(outcome.resolve, out).toBe('noresolve');
    expect(outcome.interfaces, out).toBe('lo');
    console.info(`EXP-001 criterion 3, with sockets enabled: ${JSON.stringify(outcome)}`);
  });
});
