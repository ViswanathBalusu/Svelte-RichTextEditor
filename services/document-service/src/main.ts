/**
 * `pnpm --filter @docedit/document-service start`: runs the document service as one process
 * (BE-001) with the settings of config.ts. Migrations are not run here: they run as the schema
 * owner (`migrate`), and the service reports not ready until the schema matches (BE-011).
 */
import { configFromEnv } from './config.ts';
import { createLogger, errorFields } from './log.ts';
import { startService } from './server.ts';

const logger = createLogger();
try {
  const config = configFromEnv();
  const service = await startService({ config, logger });
  logger.info({ event: 'service.started', message: `listening on ${service.url}` });
  const stop = () => {
    logger.info({ event: 'service.stopping' });
    void service.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} catch (e) {
  logger.error({ event: 'service.failed', ...errorFields(e) });
  process.exit(1);
}
