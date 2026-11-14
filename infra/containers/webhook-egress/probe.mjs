// The dispatcher-side checks of the BE-056 network-policy test (lane V-BE-043-056). This container
// is attached to an internal Podman network only: no route leaves it. The checks show that the
// only thing it reaches outside itself is the egress proxy, and that the proxy refuses private
// targets. Exits 0 when every check holds, 1 otherwise; one line per check.
import { connect } from 'node:net';

const PROXY_HOST = process.env.PROXY_HOST;
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 3128);
const OUTSIDE_IP = process.env.OUTSIDE_IP;
const OUTSIDE_PORT = Number(process.env.OUTSIDE_PORT ?? 8080);
if (!PROXY_HOST || !OUTSIDE_IP) {
  console.log('FAIL setup: PROXY_HOST and OUTSIDE_IP are required');
  process.exit(1);
}

/** Tries a TCP connection; resolves true when it connects, false on refusal, error or timeout. */
function canConnect(host, port, timeoutMs = 3_000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function deliver(url) {
  const r = await fetch(`http://${PROXY_HOST}:${PROXY_PORT}/deliver`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return { status: r.status, body: await r.json() };
}

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

// Retry the proxy's health check while it starts.
let healthy = false;
for (let i = 0; i < 40 && !healthy; i++) {
  try {
    const r = await fetch(`http://${PROXY_HOST}:${PROXY_PORT}/health`);
    healthy = r.status === 200;
  } catch {
    await new Promise((res) => setTimeout(res, 250));
  }
}
check('the proxy answers on the internal network', healthy, `${PROXY_HOST}:${PROXY_PORT}`);

// 1. No direct route to a host on the outside network, by its address.
const direct = await canConnect(OUTSIDE_IP, OUTSIDE_PORT);
check('no direct connection to the outside host', !direct, `${OUTSIDE_IP}:${OUTSIDE_PORT}`);

// 2. No direct route to a public address either.
const publicDirect = await canConnect('1.1.1.1', 443);
check('no direct connection to a public address', !publicDirect, '1.1.1.1:443');

// 3. Through the proxy, a private target is refused with its reason and not connected to.
const priv = await deliver(`http://${OUTSIDE_IP}:${OUTSIDE_PORT}/hook`);
check(
  'the proxy refuses a private target with a reason',
  priv.body.ok === false && priv.body.reason === 'private',
  `reason ${priv.body.reason}`,
);

// 4. Through the proxy, the cloud metadata address and loopback are refused.
const meta = await deliver('http://169.254.169.254/latest/meta-data/');
check(
  'the proxy refuses the metadata address',
  meta.body.ok === false,
  `reason ${meta.body.reason}`,
);
const loop = await deliver('http://localhost:8080/');
check(
  'the proxy refuses loopback',
  loop.body.ok === false && loop.body.reason === 'loopback',
  `reason ${loop.body.reason}`,
);

const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed} of ${results.length} checks hold`);
process.exit(failed === 0 ? 0 : 1);
