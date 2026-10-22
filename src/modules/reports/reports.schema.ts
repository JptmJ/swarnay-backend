/**
 * Module 11 — what Reports keeps: reports people saved, the ones they pinned,
 * what they ran recently, the alerts and schedules they set, and the inbox
 * those deliver to. The figures themselves are never stored; every report is
 * worked out from the live data when it is opened.
 */
import { defineTable } from '../../core/db/schema/registry.js';
import { col } from '../../core/db/schema/columns.js';

export const reportViewTable = defineTable({
  name: 'report_view',
  module: 'reports',
  softDelete: true,
  comment: 'A report someone designed or customised and saved.',
  columns: {
    name: col.text({ notNull: true }),
    description: col.text(),
    category: col.text({ notNull: true }),
    /** The ready report it started from, if any. */
    base_key: col.text(),
    spec: col.jsonb({ notNull: true }),
    owner_id: col.fk('app_user', { notNull: true }),
    /** Shared = everyone who can see the category sees it under Shared reports. */
    is_shared: col.bool({ notNull: true, default: 'false' }),
    last_run_at: col.timestamptz(),
  },
  indexes: [{ columns: ['owner_id'] }, { columns: ['is_shared'] }],
});

export const reportPinTable = defineTable({
  name: 'report_pin',
  module: 'reports',
  comment: 'Reports a person keeps at hand, in their own order. Shown on the Dashboard too.',
  columns: {
    user_id: col.fk('app_user', { notNull: true, onDelete: 'cascade' }),
    /** cat:<key> for a ready report, view:<id> for a saved one. */
    ref: col.text({ notNull: true }),
    position: col.int({ notNull: true, default: '0' }),
  },
  uniques: [{ columns: ['user_id', 'ref'] }],
});

export const reportRunTable = defineTable({
  name: 'report_run',
  module: 'reports',
  comment: 'Who ran which report, when, and how long it took. Feeds Recent runs.',
  columns: {
    user_id: col.fk('app_user', { notNull: true, onDelete: 'cascade' }),
    ref: col.text(),
    name: col.text({ notNull: true }),
    dataset: col.text({ notNull: true }),
    spec: col.jsonb({ notNull: true }),
    row_count: col.int({ notNull: true, default: '0' }),
    ms: col.int({ notNull: true, default: '0' }),
  },
  indexes: [{ columns: ['user_id', 'created_at'] }],
});

export const reportAlertTable = defineTable({
  name: 'report_alert',
  module: 'reports',
  softDelete: true,
  comment: 'A figure watched against a limit: sales below target, ghat above tolerance, cash above the insured amount.',
  columns: {
    name: col.text({ notNull: true }),
    /** A one-figure report: a data set, filters, a period and one total. */
    spec: col.jsonb({ notNull: true }),
    measure_key: col.text({ notNull: true }),
    op: col.enum(['gt', 'gte', 'lt', 'lte'], { notNull: true }),
    threshold: col.numeric(20, 4, { notNull: true }),
    frequency: col.enum(['hourly', 'daily'], { notNull: true, default: "'daily'" }),
    /** Who hears about it; empty = whoever set it. */
    recipient_ids: col.jsonb({ notNull: true, default: "'[]'::jsonb" }),
    is_active: col.bool({ notNull: true, default: 'true' }),
    last_checked_at: col.timestamptz(),
    last_value: col.numeric(20, 4),
    last_state: col.enum(['ok', 'triggered'], {}),
    last_triggered_at: col.timestamptz(),
    owner_id: col.fk('app_user', { notNull: true }),
  },
  indexes: [{ columns: ['is_active'] }],
});

export const reportScheduleTable = defineTable({
  name: 'report_schedule',
  module: 'reports',
  softDelete: true,
  comment: 'A report run on a timetable and delivered to people’s Reports inbox.',
  columns: {
    name: col.text({ notNull: true }),
    ref: col.text(),
    spec: col.jsonb({ notNull: true }),
    frequency: col.enum(['daily', 'weekly', 'monthly'], { notNull: true }),
    /** Weekly: 1 = Monday … 7 = Sunday. Monthly: day of the month, 1–28. */
    day: col.int(),
    at_time: col.text({ notNull: true, default: "'20:00'" }),
    recipient_ids: col.jsonb({ notNull: true, default: "'[]'::jsonb" }),
    is_active: col.bool({ notNull: true, default: 'true' }),
    next_run_at: col.timestamptz({ notNull: true }),
    last_run_at: col.timestamptz(),
    owner_id: col.fk('app_user', { notNull: true }),
  },
  indexes: [{ columns: ['is_active', 'next_run_at'] }],
});

export const reportInboxTable = defineTable({
  name: 'report_inbox',
  module: 'reports',
  comment: 'What schedules and alerts delivered to a person, with the figures as they were at that moment.',
  columns: {
    user_id: col.fk('app_user', { notNull: true, onDelete: 'cascade' }),
    kind: col.enum(['schedule', 'alert'], { notNull: true }),
    title: col.text({ notNull: true }),
    body: col.text(),
    source_id: col.uuid(),
    ref: col.text(),
    spec: col.jsonb(),
    /** The result as it was, cut to the first rows, so it can be read later as delivered. */
    snapshot: col.jsonb(),
    read_at: col.timestamptz(),
  },
  indexes: [{ columns: ['user_id', 'created_at'] }, { columns: ['user_id'], where: 'read_at is null', name: 'ix_report_inbox_unread' }],
});
