/**
 * Data import, from the super admin console.
 *
 * A shop coming over from other software hands its data to the operator in
 * whatever form the old system gives — Excel, CSV, Tally XML, a DBF dump. The
 * console reads the file in the browser and sends its rows here; from then on
 * the import is a batch that is matched, checked, imported and, if need be,
 * undone, with every row's fate kept.
 *
 * Order of work for one file:
 *   1. POST   …/imports                 the kind, the file's headings and options → a batch with suggested matching
 *   2. POST   …/imports/:batchId/rows   the rows, up to 1,000 a call
 *   3. PATCH  …/imports/:batchId        correct the matching, match odd values, change options
 *   4. POST   …/imports/:batchId/validate   check every row (a job; poll the batch)
 *   5. GET    …/imports/:batchId/rows?status=invalid   see what is wrong; PATCH a row to fix or leave it out
 *   6. POST   …/imports/:batchId/import     bring the good rows in (a job)
 *   7. POST   …/imports/:batchId/undo       take them back out, if it went wrong
 */
import { z } from 'zod';
import { defineRoute, queryOf } from '../core/http/route-registry.js';
import { asPlatform } from '../core/db/client.js';
import { param, platformUserId } from '../core/http/middleware.js';
import type { Request } from 'express';
import {
  appendRows, batchDetail, choices, createBatch, deleteBatch, editRow, importKinds, listBatches, listRows,
  MAX_ROWS_PER_CALL, startImport, startUndo, startValidation, stopJob, updateBatch,
} from '../modules/migration/migration.service.js';
import { ENTITY_KEYS } from '../modules/migration/entities/index.js';
import { DATE_FORMATS, WEIGHT_UNITS } from '../modules/migration/normalize.js';
import { errorEnvelope, listOf, record, uuid } from './schemas.js';

const M = 'platform';
const DAY = '2026-10-11';
const added = (note: string) => [{ date: DAY, kind: 'added' as const, note }];
const T = '/api/platform/tenants/:id/imports';
const batchParams = z.object({ id: uuid, batchId: uuid });

/** The operator, with their name for the batch's record. */
async function operator(req: Request) {
  const id = platformUserId(req);
  const row = await asPlatform((tx) => tx.maybeOne<{ full_name: string }>(`select full_name from platform_user where id = $1`, [id]));
  return { id, name: row?.full_name ?? null, ip: req.ip };
}

const mappingEntry = z.object({
  column: z.string().nullish().describe('The file heading this field is read from.'),
  constant: z.string().nullish().describe('Or one value for every row, e.g. "22K" when the whole file is one purity.'),
  unit: z.enum(WEIGHT_UNITS).optional().describe('For weights: the unit the column is in. A unit written in a cell wins.'),
  format: z.enum(DATE_FORMATS).optional().describe('For dates: how 03/04/2026 is read. Default DMY.'),
  negate: z.boolean().optional().describe('For balances: minus means Dr, as in Tally XML exports.'),
});

const batchSchema = record.describe('The batch: kind, status, file details, matching, options, counts, progress, the check’s findings (`validation`) and the outcome (`result`). `running` is true while a job works on it; `interrupted` when a job was cut short by a restart — start it again to carry on.');

defineRoute({
  method: 'get', path: '/api/platform/import-kinds', module: M,
  summary: 'What can be imported, with every field',
  description:
    'Each kind lists its fields (key, label, type, required, the closed options of a list, what a lookup field names), the options a batch can take with their defaults, and whether importing it posts to the books. '
    + 'The console builds its picker, matching screen and "Download sample" files from this. Kinds are in the order a shop is best brought over in: masters, stock, balances, running accounts.',
  permission: 'platform.tenants.view',
  responses: [{ status: 200, description: 'The kinds.', schema: z.object({ kinds: z.array(record) }) }],
  changelog: added('The catalogue of importable records.'),
  handler: async () => ({ kinds: importKinds() }),
});

defineRoute({
  method: 'get', path: T, module: M,
  summary: 'A business’s imports',
  description: 'Newest first, with counts. `progress` says, kind by kind, how many records have been brought over (undone imports not counted) — the console’s checklist.',
  permission: 'platform.tenants.view', params: z.object({ id: uuid }),
  query: z.object({ entity: z.enum(ENTITY_KEYS).optional(), limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).default(0) }),
  responses: [
    { status: 200, description: 'Imports.', schema: z.object({ rows: z.array(record), progress: z.record(z.string(), z.object({ imported: z.number(), batches: z.number() })) }) },
    { status: 404, description: 'No such business.', schema: errorEnvelope },
  ],
  changelog: added('Lists imports per business.'),
  handler: async (req) => listBatches(param(req, 'id'), queryOf(req)),
});

defineRoute({
  method: 'post', path: T, module: M,
  summary: 'Start an import: the kind of record and the file’s headings',
  description:
    'Returns the batch with `mapping` already suggested from the headings (Customer Name, Mob No., Gr Wt, Tunch… are recognised), ready for the rows. '
    + 'Headings must be present and different from each other.',
  permission: 'platform.tenants.update', params: z.object({ id: uuid }),
  body: z.object({
    entity: z.enum(ENTITY_KEYS).describe('From GET /api/platform/import-kinds.'),
    title: z.string().max(200).optional().describe('Defaults to the kind and the file name.'),
    sourceName: z.string().max(300).optional().describe('The file name.'),
    sourceFormat: z.string().max(20).optional().describe('xlsx, csv, xml, json, dbf…'),
    sourceSystem: z.string().max(120).optional().describe('The software the data came from, for the record.'),
    sheetName: z.string().max(200).optional(),
    columns: z.array(z.string()).min(1).max(300).describe('The headings, in order.'),
    options: z.record(z.string(), z.unknown()).optional().describe('See the kind’s `options`. Defaults apply to anything left out.'),
  }),
  responses: [
    { status: 201, description: 'Created, with suggested matching.', schema: batchSchema },
    { status: 400, description: 'Unknown kind, missing or repeated headings, or a bad option.', schema: errorEnvelope },
    { status: 404, description: 'No such business.', schema: errorEnvelope },
  ],
  changelog: added('Starts an import batch.'),
  handler: async (req, res) => {
    res.status(201).json(await createBatch(param(req, 'id'), await operator(req), req.body));
  },
});

defineRoute({
  method: 'get', path: `${T}/:batchId`, module: M,
  summary: 'One import, with progress and findings',
  description: 'Poll this while a job runs (`running`). `statusCounts` counts rows by status; `sample` is the first five rows as they arrived, for the matching screen.',
  permission: 'platform.tenants.view', params: batchParams,
  responses: [
    { status: 200, description: 'The batch.', schema: batchSchema },
    { status: 404, description: 'No such business or import.', schema: errorEnvelope },
  ],
  changelog: added('Reads one import.'),
  handler: async (req) => batchDetail(param(req, 'id'), param(req, 'batchId')),
});

defineRoute({
  method: 'patch', path: `${T}/:batchId`, module: M,
  summary: 'Change the matching, matched values, options or title',
  description:
    '`mapping` replaces the whole matching: field → { column } or { constant }, with `unit` for weights and `format` for dates. '
    + '`valueMap` is field → { value as written in the file → what it means here } — a record id from GET …/import-choices for a lookup field, or the option’s value for a list. '
    + 'Changing any of these sends the batch back to draft: check it again before importing. Once rows are imported they are fixed (422 `import_locked`).',
  permission: 'platform.tenants.update', params: batchParams,
  body: z.object({
    title: z.string().max(200).optional(), sourceSystem: z.string().max(120).nullish(),
    mapping: z.record(z.string(), mappingEntry).optional(),
    valueMap: z.record(z.string(), z.record(z.string(), z.string())).optional(),
    options: z.record(z.string(), z.unknown()).optional().describe('Merged into the current options.'),
  }),
  responses: [
    { status: 200, description: 'Updated.', schema: batchSchema },
    { status: 400, description: 'A field, column, unit or option that does not exist.', schema: errorEnvelope },
    { status: 422, description: '`import_locked` once rows are imported; `import_busy` while a job runs.', schema: errorEnvelope },
  ],
  changelog: added('Matching, value matching and options of an import.'),
  handler: async (req) => updateBatch(param(req, 'id'), param(req, 'batchId'), req.body),
});

defineRoute({
  method: 'delete', path: `${T}/:batchId`, module: M,
  summary: 'Throw away an import that was never run',
  description: 'For a file staged by mistake. An import with rows brought in is undone instead, which keeps its record.',
  permission: 'platform.tenants.update', params: batchParams,
  responses: [
    { status: 204, description: 'Deleted.' },
    { status: 422, description: '`import_locked`: rows were imported — undo it instead.', schema: errorEnvelope },
  ],
  changelog: added('Deletes a staged import.'),
  handler: async (req, res) => {
    await deleteBatch(param(req, 'id'), param(req, 'batchId'), await operator(req));
    res.status(204).end();
  },
});

defineRoute({
  method: 'post', path: `${T}/:batchId/rows`, module: M,
  summary: 'Send the file’s rows',
  description:
    `Up to ${MAX_ROWS_PER_CALL} rows a call, each an object keyed by the file’s headings. \`firstRow\` is the file row of rows[0], so every message points at a row the shop can find. `
    + 'Sending a range again replaces it, so a retried call never doubles rows. Only before the import starts.',
  permission: 'platform.tenants.update', params: batchParams,
  body: z.object({
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_ROWS_PER_CALL),
    firstRow: z.number().int().min(1).describe('File row of rows[0] — 2 when row 1 holds the headings.'),
  }),
  responses: [
    { status: 200, description: 'Stored.', schema: z.object({ received: z.number(), rowCount: z.number() }) },
    { status: 422, description: '`import_locked` once the import has started; `import_too_large` past 200,000 rows.', schema: errorEnvelope },
  ],
  changelog: added('Stages an import’s rows.'),
  handler: async (req) => appendRows(param(req, 'id'), param(req, 'batchId'), req.body.rows, req.body.firstRow),
});

defineRoute({
  method: 'get', path: `${T}/:batchId/rows`, module: M,
  summary: 'The rows, with what the check or the import said about each',
  description: '`status`: one or more of pending, valid, invalid, skipped, imported, failed, undone, comma-separated. `level=warning` keeps rows with a warning. `search` looks in the cells, the label and the messages.',
  permission: 'platform.tenants.view', params: batchParams,
  query: z.object({
    status: z.string().optional(), level: z.enum(['warning']).optional(), search: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50), offset: z.coerce.number().int().min(0).default(0),
  }),
  responses: [{ status: 200, description: 'Rows in file order.', schema: listOf(record) }],
  changelog: added('Lists an import’s rows.'),
  handler: async (req) => listRows(param(req, 'id'), param(req, 'batchId'), queryOf(req)),
});

defineRoute({
  method: 'patch', path: `${T}/:batchId/rows/:rowNumber`, module: M,
  summary: 'Fix a row’s cells, or leave the row out',
  description: '`data` holds only the cells to change, by heading. `skip: true` leaves the row out of the import. The file needs checking again afterwards.',
  permission: 'platform.tenants.update',
  params: z.object({ id: uuid, batchId: uuid, rowNumber: z.string().regex(/^[1-9]d*$/, 'A row number.') }),
  body: z.object({ data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(), skip: z.boolean().optional() }),
  responses: [
    { status: 200, description: 'The row, waiting to be checked.', schema: record },
    { status: 422, description: '`row_imported`: the row is in already.', schema: errorEnvelope },
  ],
  changelog: added('Fixes or skips one row.'),
  handler: async (req) => editRow(param(req, 'id'), param(req, 'batchId'), Number(param(req, 'rowNumber')), req.body),
});

defineRoute({
  method: 'post', path: `${T}/:batchId/validate`, module: M,
  summary: 'Check every row (nothing is saved)',
  description:
    'Reads every row through the matching against the shop as it is now: what each would do (add, update, leave), what is wrong, which values could not be placed (`validation.unknown`), what would be created on the way (`validation.willCreate`) and totals to compare with the old software (`validation.totals`). '
    + 'Runs in the background: answers 202, poll the batch.',
  permission: 'platform.tenants.update', params: batchParams,
  responses: [
    { status: 202, description: 'Checking.', schema: batchSchema },
    { status: 422, description: '`import_busy`, `import_empty` or `import_locked`.', schema: errorEnvelope },
  ],
  changelog: added('Dry-run check of an import.'),
  handler: async (req, res) => {
    res.status(202).json(await startValidation(param(req, 'id'), param(req, 'batchId'), await operator(req)));
  },
});

defineRoute({
  method: 'post', path: `${T}/:batchId/import`, module: M,
  summary: 'Bring the good rows in',
  description:
    'Imports every row the check passed, in chunks; each row is checked once more as it goes in. Masters are added or updated, stock is tagged, balances and running accounts are posted to the books dated the cut-over day. '
    + 'Rows with errors are only left out when `leaveOutInvalid` says so. Runs in the background: answers 202, poll the batch. Calling it again on an import that stopped or was cut short carries on from where it got to.',
  permission: 'platform.tenants.update', params: batchParams,
  body: z.object({ leaveOutInvalid: z.boolean().default(false).describe('Import the good rows even though some have errors.') }),
  responses: [
    { status: 202, description: 'Importing.', schema: batchSchema },
    { status: 422, description: '`import_not_ready` (check first), `import_has_errors` (fix or leave out), `import_empty`, `import_busy`.', schema: errorEnvelope },
  ],
  changelog: added('Runs an import.'),
  handler: async (req, res) => {
    res.status(202).json(await startImport(param(req, 'id'), param(req, 'batchId'), await operator(req), req.body));
  },
});

defineRoute({
  method: 'post', path: `${T}/:batchId/stop`, module: M,
  summary: 'Stop a running import after the chunk in hand',
  description: 'What has gone in stays. The rest stays waiting: import again to carry on, or undo what went in.',
  permission: 'platform.tenants.update', params: batchParams,
  responses: [
    { status: 200, description: 'Stopping.', schema: batchSchema },
    { status: 422, description: '`import_not_running`.', schema: errorEnvelope },
  ],
  changelog: added('Stops an import part-way.'),
  handler: async (req) => { stopJob(param(req, 'batchId')); return batchDetail(param(req, 'id'), param(req, 'batchId')); },
});

defineRoute({
  method: 'post', path: `${T}/:batchId/undo`, module: M,
  summary: 'Take an import back out',
  description:
    'Masters the import added are removed unless something has used them since (they stay, with the reason); masters it changed get their old values back, except fields changed again since. '
    + 'Stock, balances, scheme members and loans come out together or not at all: every opening voucher is reversed on its own date, pieces are written off with their tag numbers freed, scheme accounts and loans are cancelled with their numbers freed. '
    + 'Refused with 422 `import_in_use` when that would undo something that happened since (a piece sold, a collection taken, a loan repaid).',
  permission: 'platform.tenants.update', params: batchParams,
  body: z.object({ reason: z.string().trim().min(3).max(300).describe('Why, for the record.') }),
  responses: [
    { status: 202, description: 'Undoing.', schema: batchSchema },
    { status: 422, description: '`import_not_imported`, `import_in_use`, `import_busy`.', schema: errorEnvelope },
  ],
  changelog: added('Undoes an import.'),
  handler: async (req, res) => {
    res.status(202).json(await startUndo(param(req, 'id'), param(req, 'batchId'), await operator(req), req.body.reason));
  },
});

defineRoute({
  method: 'get', path: '/api/platform/tenants/:id/import-choices', module: M,
  summary: 'The shop’s own records, for matching values by hand',
  description: 'For the value panel: which purity "22CT" is, which ledger "Cash A/c" is, which customer a name means. Short lists come whole; customers, items and karigars are searched (`search`) and capped at 200.',
  permission: 'platform.tenants.view', params: z.object({ id: uuid }),
  query: z.object({
    kind: z.enum(['metal', 'purity', 'category', 'item', 'branch', 'location', 'party', 'karigar', 'plan', 'account']),
    search: z.string().max(100).optional(),
  }),
  responses: [{ status: 200, description: 'Choices.', schema: z.object({ rows: z.array(z.object({ id: uuid, label: z.string(), hint: z.string().nullable() })) }) }],
  changelog: added('Choices for matching values by hand.'),
  handler: async (req) => {
    const q = queryOf<{ kind: Parameters<typeof choices>[1]; search?: string }>(req);
    return { rows: await choices(param(req, 'id'), q.kind, q.search) };
  },
});
