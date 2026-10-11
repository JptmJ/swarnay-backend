/**
 * Where the application's tables live, and the one search_path every
 * transaction runs with.
 *
 * Every table is in ONE schema, `swarnay_schema` — on every database: a
 * laptop's, Supabase, the deployed server. It is not configurable. Two
 * developers once ran against the same database with different schemas
 * (`public` and `app`): every table existed twice, rows were split between the
 * copies, and the app only ever saw one of them.
 *
 * After the app's schema comes `extensions`, where Supabase keeps extensions
 * such as pg_trgm. On plain Postgres that schema does not exist (Postgres skips
 * it) and extensions live in swarnay_schema itself. Nothing else is ever on the
 * path, so a missing table fails loudly instead of being found in another copy.
 */
export const APP_SCHEMA = 'swarnay_schema';

export const SEARCH_PATH = `"${APP_SCHEMA}", extensions`;

/** `SET LOCAL` — undone at COMMIT/ROLLBACK, so it never leaks to the next user of a pooled connection. */
export const SET_SEARCH_PATH = `set local search_path to ${SEARCH_PATH}`;
