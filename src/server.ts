import './bootstrap.js';
import { createApp } from './app.js';
import { dbTarget, env, syncMode } from './core/config/env.js';
import { checkConnection, closePool, pool, startDbHeartbeat, stopDbHeartbeat } from './core/db/pool.js';
import { syncSchema } from './core/db/schema/sync.js';
import { warnAboutOtherCopies } from './core/db/schema/copies.js';
import { buildStamp } from './core/util/version.js';
import { allTables } from './core/db/schema/registry.js';
import { logger } from './core/util/logger.js';

/**
 * Boot order matters:
 *   1. can we reach the database at all?
 *   2. bring its shape in line with the code
 *   3. only then start accepting requests
 *
 * Nothing serves traffic against a schema it does not understand.
 */
async function main(): Promise<void> {
  logger.info(
    { env: env.NODE_ENV, dbTarget: dbTarget ?? 'DATABASE_URL', tables: allTables().length, schemaSync: syncMode },
    'Starting Swarnay backend',
  );

  await checkConnection();
  await warnAboutOtherCopies(pool);
  await syncSchema(pool, syncMode, buildStamp());

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`Listening on http://localhost:${env.PORT}`);
  });
  startDbHeartbeat(env.DB_HEARTBEAT_SECONDS);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    stopDbHeartbeat();
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
    // Do not let a hung connection keep the process alive forever.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Could not start');
  process.exit(1);
});
