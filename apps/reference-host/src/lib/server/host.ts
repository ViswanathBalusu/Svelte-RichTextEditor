/**
 * The host's server, composed once per process from its settings: the directory, the catalogue,
 * the demo sessions, the service client and the token issuer. The SvelteKit routes use `host()`;
 * tests compose their own with `composeHost()`.
 */
import { join } from 'node:path';
import { Catalogue } from './catalogue.ts';
import { configFromEnv, type HostConfig } from './config.ts';
import { Directory } from './directory.ts';
import { loadDocumentsSeed, type DocumentsSeed, type HostDocuments } from './documents.ts';
import { ServiceClient } from './service.ts';
import { Sessions } from './sessions.ts';
import { hostSigned, serviceMinted, type TokenIssuer } from './tokens.ts';

export interface Host extends HostDocuments {
  config: HostConfig;
  directory: Directory;
  sessions: Sessions;
  tokens: TokenIssuer;
  seed: DocumentsSeed;
}

export async function composeHost(
  config: HostConfig,
  opts: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<Host> {
  const service = new ServiceClient({
    rest: config.rest,
    apiKey: config.apiKey,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const now = opts.now ?? Date.now;
  const tokens =
    config.tokenMode === 'host-signed'
      ? hostSigned({
          signing: config.signing!,
          tenant: config.tenant,
          serviceId: config.serviceId,
          seconds: config.tokenSeconds,
          now,
        })
      : serviceMinted(service, config.tokenSeconds);
  return {
    config,
    directory: await Directory.load(config.seedDir),
    catalogue: await Catalogue.open(join(config.dataDir, 'catalogue.json')),
    sessions: new Sessions(now),
    service,
    tokens,
    seed: await loadDocumentsSeed(config.seedDir),
    seedDir: config.seedDir,
    now: () => new Date(now()),
  };
}

let composed: Promise<Host> | null = null;

/** The host of this process, from the environment. */
export function host(): Promise<Host> {
  composed ??= composeHost(configFromEnv());
  return composed;
}
