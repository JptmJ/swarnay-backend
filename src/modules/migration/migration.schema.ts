/**
 * Data import — bringing a shop's records over from the software it used before.
 *
 * A shop will not move to us if it has to type its customers, its stock and its
 * running scheme accounts in again, so the super admin takes whatever file the
 * old software gives (Excel, CSV, Tally XML, a DBF dump) and loads it into the
 * shop's account. Two tables carry that work:
 *
 * - `import_batch` is one file being brought in as one kind of record: its
 *   columns, how they were matched to our fields, the options chosen, where the
 *   check and the import got to, and what was made.
 * - `import_row` is every row of that file exactly as it arrived, with what the
 *   check said about it and, once imported, the record it became. The row's
 *   status changes in the same transaction as the record it creates, so a row
 *   marked imported always has its record and a crash never imports one twice.
 *
 * Both are tenant tables: the rows are the shop's own data and RLS keeps them
 * in the shop. Who ran the import is the platform operator, kept by id.
 */
import { defineTable } from '../../core/db/schema/registry.js';
import { col } from '../../core/db/schema/columns.js';

export const IMPORT_BATCH_STATUSES = [
  'draft',        // rows arriving, columns being matched; not checked yet (or changed since)
  'validating',   // the check is running
  'validated',    // checked; ready to import
  'importing',    // the import is running
  'imported',     // every importable row went in
  'partial',      // the import finished, some rows were refused
  'undoing',      // the undo is running
  'undone',       // taken back out again
] as const;

export const IMPORT_ROW_STATUSES = ['pending', 'valid', 'invalid', 'skipped', 'imported', 'failed', 'undone'] as const;

export const importBatchTable = defineTable({
  name: 'import_batch',
  module: 'platform',
  comment: 'One file brought in from a previous system as one kind of record.',
  columns: {
    entity: col.text({ notNull: true, comment: 'What the rows become: customers, opening_pieces, party_balances…' }),
    title: col.text({ notNull: true }),
    status: col.enum(IMPORT_BATCH_STATUSES, { notNull: true, default: "'draft'" }),
    source_name: col.text({ comment: 'The file name as uploaded.' }),
    source_format: col.text({ comment: 'xlsx, csv, xml, json, dbf…' }),
    source_system: col.text({ comment: 'The software it came from, as the operator named it.' }),
    sheet_name: col.text(),
    /** The file's column headings, in their order. */
    columns: col.jsonb({ notNull: true, default: "'[]'::jsonb" }),
    /** Our field → { column } | { constant }, plus unit and date format where they apply. */
    mapping: col.jsonb({ notNull: true, default: "'{}'::jsonb" }),
    /** Our field → { value in the file → what it means here }, for values the check could not place. */
    value_map: col.jsonb({ notNull: true, default: "'{}'::jsonb" }),
    options: col.jsonb({ notNull: true, default: "'{}'::jsonb" }),

    row_count: col.int({ notNull: true, default: '0' }),
    valid_count: col.int({ notNull: true, default: '0' }),
    invalid_count: col.int({ notNull: true, default: '0' }),
    warning_count: col.int({ notNull: true, default: '0' }),
    skipped_count: col.int({ notNull: true, default: '0' }),
    imported_count: col.int({ notNull: true, default: '0' }),
    failed_count: col.int({ notNull: true, default: '0' }),
    undone_count: col.int({ notNull: true, default: '0' }),
    /** Rows the running job has been through, for the progress bar. */
    progress: col.int({ notNull: true, default: '0' }),

    /** What the check found: unplaced values, records that will be created, totals to reconcile against. */
    validation: col.jsonb(),
    /** What the import made, and the undo's outcome. */
    result: col.jsonb(),
    error: col.text({ comment: 'Why the last job stopped, when it stopped on an error.' }),

    validated_at: col.timestamptz(),
    started_at: col.timestamptz(),
    finished_at: col.timestamptz(),
    undone_at: col.timestamptz(),
    /** The platform operator. Not a tenant user, so not a foreign key into app_user. */
    operator_id: col.uuid({ notNull: true }),
    operator_name: col.text(),
  },
  indexes: [{ columns: ['entity', 'status'] }, { columns: ['created_at'] }],
});

export const importRowTable = defineTable({
  name: 'import_row',
  module: 'platform',
  comment: 'One row of an imported file, as it arrived, with what became of it.',
  columns: {
    batch_id: col.fk('import_batch', { notNull: true, onDelete: 'cascade' }),
    row_number: col.int({ notNull: true, comment: 'The row in the file, so messages point at something the shop can find.' }),
    /** The cells as they arrived, keyed by the file's own headings. Edited in place when the operator fixes a row. */
    data: col.jsonb({ notNull: true }),
    status: col.enum(IMPORT_ROW_STATUSES, { notNull: true, default: "'pending'" }),
    action: col.enum(['insert', 'update', 'skip']),
    /** [{ level: error | warning, field, message }] */
    messages: col.jsonb({ notNull: true, default: "'[]'::jsonb" }),
    /** A short name for the row in lists: the customer, the tag, the account. */
    label: col.text(),
    target_table: col.text(),
    target_id: col.uuid(),
    /** For an update: the columns as they were, and as the import left them, so an undo can put them back. */
    before: col.jsonb(),
    after: col.jsonb(),
    skip_requested: col.bool({ notNull: true, default: 'false', comment: 'The operator chose to leave this row out.' }),
    imported_at: col.timestamptz(),
  },
  uniques: [{ columns: ['batch_id', 'row_number'] }],
  indexes: [{ columns: ['batch_id', 'status', 'row_number'] }, { columns: ['target_table', 'target_id'] }],
});
