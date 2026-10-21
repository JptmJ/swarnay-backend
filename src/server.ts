import './bootstrap.js';
import { createApp } from './app.js';
import { env } from './core/config/env.js';
import { checkConnection, closePool, pool, startDbHeartbeat, stopDbHeartbeat } from './core/db/pool.js';
import { syncSchema } from './core/db/schema/sync.js';
import { warnAboutOtherCopies } from './core/db/schema/copies.js';
import { buildStamp } from './core/util/version.js';
import { allTables } from './core/db/schema/registry.js';
import { logger } from './core/util/logger.js';
import { tick as reportsTick } from './modules/reports/reports.service.js';

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
  // Report alerts and schedules: delivered to the Reports inbox when due.
  const reportsTimer = env.REPORTS_TICK_SECONDS > 0 && env.NODE_ENV !== 'test'
    ? setInterval(() => { reportsTick().catch((err) => logger.warn({ err }, 'reports tick failed')); }, env.REPORTS_TICK_SECONDS * 1000)
    : null;
  reportsTimer?.unref();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down');
    stopDbHeartbeat();
    if (reportsTimer) clearInterval(reportsTimer);
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
