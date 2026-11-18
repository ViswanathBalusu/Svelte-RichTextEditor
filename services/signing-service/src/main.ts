/**
 * Starts the signing service (FRW-052): `node src/main.ts`.
 *
 * The deployment supplies the parts that this repository does not choose (owner decisions 221 to
 * 223): the key service adapter, the certificate source, the time-stamp client and the validation
 * data. They come from a module named by DOCEDIT_SIGNING_CONFIG whose default export is a function
 * that returns `{ service, http, listen }`. Nothing here reads a key, and no default module exists,
 * so a service started without one stops with a message instead of sealing with a stand-in.
 */
import { pathToFileURL } from 'node:url';
import { createSigningServer, type HttpOptions } from './http.ts';
import { SigningService, type SigningServiceConfig } from './service.ts';

export interface DeploymentConfig {
  readonly service: SigningServiceConfig;
  readonly http: HttpOptions;
  readonly listen: { readonly host: string; readonly port: number };
}

async function main(): Promise<void> {
  const file = process.env['DOCEDIT_SIGNING_CONFIG'];
  if (file === undefined || file.length === 0) {
    process.stderr.write(
      'signing-service: DOCEDIT_SIGNING_CONFIG is not set; nothing is sealed.\n',
    );
    process.exitCode = 2;
    return;
  }
  const mod = (await import(pathToFileURL(file).href)) as {
    default: () => Promise<DeploymentConfig> | DeploymentConfig;
  };
  const cfg = await mod.default();
  const server = createSigningServer(new SigningService(cfg.service), cfg.http);
  server.listen(cfg.listen.port, cfg.listen.host, () => {
    const addr = server.address();
    const port = addr !== null && typeof addr === 'object' ? addr.port : cfg.listen.port;
    process.stdout.write(
      `${JSON.stringify({ event: 'signing-service.listening', host: cfg.listen.host, port })}\n`,
    );
  });
}

await main();
