/**
 * `pnpm --filter @docedit/authority-service start`: runs the authority service as one process
 * (BE-007) with the settings of config.ts. It logs one JSON line per event, with no document text.
 */
import { configFromEnv } from './config.ts';
import { listen } from './http.ts';
import { AuthorityService } from './service.ts';
import { httpStateLoader } from './storage.ts';

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));

try {
  const config = configFromEnv(process.env);
  const service = new AuthorityService({
    capacity: config.capacity,
    allowMigrations: config.allowMigrations,
    ...(config.storageUrl
      ? {
          loader: httpStateLoader({
            baseUrl: config.storageUrl,
            ...(config.storageToken ? { token: config.storageToken } : {}),
          }),
        }
      : {}),
  });
  const running = await listen({
    service,
    host: config.host,
    port: config.port,
    ...(config.token ? { token: config.token } : {}),
  });
  log('service.started', { url: running.url, calls: service.calls });
  const stop = () => {
    log('service.stopping');
    void running.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} catch (e) {
  log('service.failed', { message: e instanceof Error ? e.message : String(e) });
  process.exit(1);
}
