// A stand-in for a host on the outside network in the BE-056 network-policy test (lane
// V-BE-043-056). The dispatcher's network has no route here; the proxy's network does.
import { createServer } from 'node:http';

createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' }).end('outside');
}).listen(8080, '0.0.0.0', () => console.log('outside listening on 8080'));
