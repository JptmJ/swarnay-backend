import './bootstrap.js';
import { createApp } from './app.js';
import { env } from './core/config/env.js';
import { checkConnection, closePool, pool, startDbHeartbeat, stopDbHeartbeat } from './core/db/pool.js';
import { syncSchema } from './core/db/schema/sync.js';
import { warnAboutOtherCopies } from './core/db/schema/copies.js';
import { buildStamp } from './core/util/version.js';
import { allTables } from './core/db/schema/registry.js';
import { logger } from './core/util/logger.js';

/**
 * Boot order matters:
 *   1. can we reach the database at all?
 *   2. bring its shape in line with the code — the same on a laptop and on the
 *      server, with no setting: everything that only ADDS (tables, columns,
 *      indexes, keys) is applied; anything that would delete data is listed
 *      and left for `npm run db:migrate -- --force`
 *   3. only then start accepting requests
 *
 * Nothing serves traffic against a schema it does not understand.
 */
async function main(): Promise<void> {
  logger.info(
    { env: env.NODE_ENV, tables: allTables().length },
    'Starting Swarnay backend',
  );

  await checkConnection();
  await warnAboutOtherCopies(pool);
  await syncSchema(pool, 'safe', buildStamp());

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
