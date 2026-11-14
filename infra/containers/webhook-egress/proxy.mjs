// The webhook egress proxy of the BE-056 network-policy test (lane V-BE-043-056). It serves
// POST /deliver with the real EgressProxy of services/document-service/src/control-plane/
// webhook-egress.ts (mounted read-only at /srv/cp), so the refusals the test checks are the
// refusals the product code makes. Runs on Node.js 24 (type stripping runs the .ts sources).
// Not a product file: the test container only.
import { createServer } from 'node:http';

const { EgressProxy, nodeConnector, systemResolver } = await import('/srv/cp/webhook-egress.ts');

const proxy = new EgressProxy({
  resolver: systemResolver,
  connector: nodeConnector(5_000),
  // A test value: the spec gives no number for redirects (webhook-egress.ts, EgressOptions).
  maxRedirects: 3,
});

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (req.method === 'POST' && req.url === '/deliver') {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 65_536) req.destroy();
    });
    req.on('end', async () => {
      let input;
      try {
        input = JSON.parse(raw);
      } catch {
        res.writeHead(400).end('{"ok":false,"reason":"malformed_request"}');
        return;
      }
      const result = await proxy.deliver({
        url: String(input.url),
        headers: {},
        body: '{}',
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(3128, '0.0.0.0', () => console.log('egress proxy listening on 3128'));
