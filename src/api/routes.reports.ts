/**
 * Reports — any figure in the business, worked out in the database.
 *
 * Ready reports, the owner’s own designs over any data set, pins, recent runs,
 * alerts, schedules and the inbox they deliver to.
 */
import { z } from 'zod';
import { defineRoute, queryOf } from '../core/http/route-registry.js';
import { transaction } from '../core/db/client.js';
import { param } from '../core/http/middleware.js';
import {
  checkAlert, datasetsFor, deleteAlert, deleteSchedule, deleteView, inbox, listAlerts, listSchedules, markRead, overview, reportSettings,
  run, saveAlert, saveSchedule, saveView, sendSchedule, setPins,
} from '../modules/reports/reports.service.js';
import { AGGS, BUCKETS, FILTER_OPS, RANGE_PRESETS, fieldValues } from '../modules/reports/engine.js';
import { errorEnvelope, idParam, isoDate, record, uuid } from './schemas.js';

const R = '/api/reports';
const DAY = '2026-10-10';
const seed = [{ date: DAY, kind: 'added' as const, note: 'Reports run on the server over real data.' }];

const filter = z.object({ field: z.string().min(1).max(60), op: z.enum(FILTER_OPS), value: z.unknown().optional() });
const groupKey = z.string().regex(/^[a-z_0-9]+(:(day|week|month|quarter|year|weekday))?$/, 'Group by a field, or a date field with :day, :week, :month…');
export const specSchema = z.object({
  dataset: z.string().min(1).max(60),
  columns: z.array(z.string().max(60)).max(40).optional(),
  groupBy: z.array(groupKey).max(2).optional(),
  measures: z.array(z.object({ field: z.string().max(60), agg: z.enum(AGGS as [string, ...string[]]) })).max(12).optional(),
  filters: z.array(filter).max(30).optional(),
  having: z.array(z.object({ key: z.string().max(80), op: z.enum(FILTER_OPS), value: z.unknown().optional() })).max(10).optional(),
  range: z.object({ preset: z.enum(RANGE_PRESETS).optional(), from: isoDate.optional(), to: isoDate.optional() }).optional(),
  branchId: uuid.nullish(),
  sort: z.array(z.object({ key: z.string().max(80), dir: z.enum(['asc', 'desc']) })).max(4).optional(),
  limit: z.coerce.number().int().min(1).max(10000).optional(),
  compare: z.boolean().optional(),
  chart: z.enum(['table', 'bar', 'line', 'donut', 'area']).optional(),
});
const BUCKET_NOTE = `Date groupings: ${BUCKETS.join(', ')}.`;

defineRoute({
  method: 'get', path: `${R}`, module: 'reports', summary: 'Everything Reports opens with',
  description: 'The categories and ready reports this person may see, their saved and shared reports, pins, recent runs and unread inbox count.',
  permission: 'reports.view',
  responses: [{ status: 200, description: 'The catalogue.', schema: record }],
  changelog: seed,
  handler: async () => transaction((tx) => overview(tx)),
});

defineRoute({
  method: 'get', path: `${R}/settings`, module: 'reports', summary: 'Reports settings in force',
  permission: 'reports.view',
  responses: [{ status: 200, description: 'The settings.', schema: record }],
  changelog: seed,
  handler: async () => transaction((tx) => reportSettings(tx)),
});

defineRoute({
  method: 'get', path: `${R}/datasets`, module: 'reports', summary: 'The data a report can be built from',
  description: `Each data set with the fields this person may see: type, whether it can be grouped, its default total, and how to pick values. Cost and margin appear only with reports.cost.view. ${BUCKET_NOTE}`,
  permission: 'reports.view',
  responses: [{ status: 200, description: 'Data sets and fields.', schema: z.array(record) }],
  changelog: seed,
  handler: async () => transaction(async (tx) => datasetsFor(tx)),
});

defineRoute({
  method: 'get', path: `${R}/datasets/:dataset/values/:field`, module: 'reports', summary: 'Values to filter a field by',
  description: 'The most common values of a groupable field, optionally matching a search, for filter pickers.',
  permission: 'reports.view',
  params: z.object({ dataset: z.string().max(60), field: z.string().max(60) }),
  query: z.object({ search: z.string().max(80).optional() }),
  responses: [{ status: 200, description: 'Values with how often each appears.', schema: z.array(record) }],
  changelog: seed,
  handler: async (req) => transaction((tx) => fieldValues(tx, param(req, 'dataset'), param(req, 'field'), queryOf<{ search?: string }>(req).search)),
});

defineRoute({
  method: 'post', path: `${R}/run`, module: 'reports', summary: 'Run a report',
  description: [
    'A ready report (`ref: "cat:<key>"`), a saved one (`ref: "view:<id>"`), or a design (`spec`), or a ready report with its settings changed (both).',
    'List mode returns rows a page at a time; summary mode (groupBy / measures) returns the groups. Totals always cover every matching row.',
    'With compare, the same period before is worked out alongside. With export, up to the download limit is returned.',
  ].join(' '),
  permission: 'reports.view',
  body: z.object({
    ref: z.string().max(80).optional(), spec: specSchema.optional(), name: z.string().max(120).optional(),
    offset: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(200000).optional(), export: z.boolean().optional(),
  }),
  responses: [
    { status: 200, description: 'Columns, rows, totals, row count and the period.', schema: record },
    { status: 403, description: 'The data, or cost and margin, are not open to this person.', schema: errorEnvelope },
    { status: 400, description: 'A field, filter or grouping that the data set does not have.', schema: errorEnvelope },
  ],
  changelog: seed,
  handler: async (req) => transaction((tx) => run(tx, req.body)),
});

/* ----------------------------------------------------------- saved reports */

const viewBody = z.object({
  name: z.string().trim().min(2).max(120), description: z.string().max(500).nullish(), spec: specSchema,
  baseKey: z.string().max(80).nullish(), isShared: z.boolean().optional(),
});

defineRoute({
  method: 'post', path: `${R}/views`, module: 'reports', summary: 'Save a report',
  description: 'Keeps a design (or a ready report with changes) under its own name. Shared reports are seen by everyone who may see that kind of report.',
  permission: 'reports.design', body: viewBody,
  responses: [{ status: 201, description: 'The saved report.', schema: record }],
  changelog: seed,
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => saveView(tx, req.body))); },
});

defineRoute({
  method: 'put', path: `${R}/views/:id`, module: 'reports', summary: 'Change a saved report',
  permission: 'reports.design', params: idParam, body: viewBody,
  responses: [{ status: 200, description: 'The saved report.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => saveView(tx, { ...req.body, id: param(req, 'id') })),
});

defineRoute({
  method: 'delete', path: `${R}/views/:id`, module: 'reports', summary: 'Remove a saved report',
  permission: 'reports.design', params: idParam,
  responses: [{ status: 200, description: 'Removed.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => deleteView(tx, param(req, 'id'))),
});

defineRoute({
  method: 'put', path: `${R}/pins`, module: 'reports', summary: 'Set the reports pinned, in order',
  description: 'Send the whole list. Pinned reports also show on the Dashboard.',
  permission: 'reports.view', body: z.object({ refs: z.array(z.string().max(80)).max(30) }),
  responses: [{ status: 200, description: 'The pins.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => setPins(tx, req.body.refs)),
});

/* ------------------------------------------------------------------ inbox */

defineRoute({
  method: 'get', path: `${R}/inbox`, module: 'reports', summary: 'Reports and alerts delivered to me',
  description: 'Anything due is delivered first, so the inbox is current when it opens.',
  permission: 'reports.view', query: z.object({ unreadOnly: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }),
  responses: [{ status: 200, description: 'Items, newest first, and the unread count.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => inbox(tx, queryOf(req))),
});

defineRoute({
  method: 'post', path: `${R}/inbox/:id/read`, module: 'reports', summary: 'Mark an inbox item read',
  permission: 'reports.view', params: z.object({ id: z.union([uuid, z.literal('all')]) }),
  responses: [{ status: 200, description: 'Done.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => markRead(tx, param(req, 'id'))),
});

/* ---------------------------------------------------------------- alerts */

const alertBody = z.object({
  name: z.string().trim().min(2).max(120), spec: specSchema, measureKey: z.string().max(80),
  op: z.enum(['gt', 'gte', 'lt', 'lte']), threshold: z.coerce.number(), frequency: z.enum(['hourly', 'daily']),
  recipientIds: z.array(uuid).max(50).optional(), isActive: z.boolean().optional(),
});

defineRoute({
  method: 'get', path: `${R}/alerts`, module: 'reports', summary: 'Alert rules',
  permission: 'reports.alerts.manage',
  responses: [{ status: 200, description: 'Alerts with their last value and state.', schema: z.array(record) }],
  changelog: seed,
  handler: async () => transaction((tx) => listAlerts(tx)),
});

defineRoute({
  method: 'post', path: `${R}/alerts`, module: 'reports', summary: 'Create an alert',
  description: 'Watches one total of a report (no groupings) against a limit, hourly or daily. Crossing the limit delivers once to each recipient allowed to see the report; it fires again only after the figure has come back.',
  permission: 'reports.alerts.manage', body: alertBody,
  responses: [{ status: 201, description: 'The alert.', schema: record }],
  changelog: seed,
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => saveAlert(tx, req.body))); },
});

defineRoute({
  method: 'put', path: `${R}/alerts/:id`, module: 'reports', summary: 'Change an alert',
  permission: 'reports.alerts.manage', params: idParam, body: alertBody,
  responses: [{ status: 200, description: 'The alert.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => saveAlert(tx, { ...req.body, id: param(req, 'id') })),
});

defineRoute({
  method: 'post', path: `${R}/alerts/:id/check`, module: 'reports', summary: 'Check an alert now',
  permission: 'reports.alerts.manage', params: idParam,
  responses: [{ status: 200, description: 'The alert with its current value and state.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => checkAlert(tx, param(req, 'id'))),
});

defineRoute({
  method: 'delete', path: `${R}/alerts/:id`, module: 'reports', summary: 'Remove an alert',
  permission: 'reports.alerts.manage', params: idParam,
  responses: [{ status: 200, description: 'Removed.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => deleteAlert(tx, param(req, 'id'))),
});

/* ------------------------------------------------------------- schedules */

const scheduleBody = z.object({
  name: z.string().trim().min(2).max(120), ref: z.string().max(80).nullish(), spec: specSchema.optional(),
  frequency: z.enum(['daily', 'weekly', 'monthly']), day: z.coerce.number().int().min(1).max(28).nullish(),
  atTime: z.string().regex(/^\d{2}:\d{2}$/), recipientIds: z.array(uuid).max(50).optional(), isActive: z.boolean().optional(),
});

defineRoute({
  method: 'get', path: `${R}/schedules`, module: 'reports', summary: 'Scheduled reports',
  permission: 'reports.schedules.manage',
  responses: [{ status: 200, description: 'Schedules with their next run.', schema: z.array(record) }],
  changelog: seed,
  handler: async () => transaction((tx) => listSchedules(tx)),
});

defineRoute({
  method: 'post', path: `${R}/schedules`, module: 'reports', summary: 'Schedule a report',
  description: 'Runs a report daily, weekly or monthly at a time of day in the shop’s timezone and delivers it to the recipients’ Reports inbox.',
  permission: 'reports.schedules.manage', body: scheduleBody,
  responses: [{ status: 201, description: 'The schedule.', schema: record }],
  changelog: seed,
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => saveSchedule(tx, req.body))); },
});

defineRoute({
  method: 'put', path: `${R}/schedules/:id`, module: 'reports', summary: 'Change a schedule',
  permission: 'reports.schedules.manage', params: idParam, body: scheduleBody,
  responses: [{ status: 200, description: 'The schedule.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => saveSchedule(tx, { ...req.body, id: param(req, 'id') })),
});

defineRoute({
  method: 'post', path: `${R}/schedules/:id/send`, module: 'reports', summary: 'Send a scheduled report now',
  permission: 'reports.schedules.manage', params: idParam,
  responses: [{ status: 200, description: 'How many it went to, and the next run.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => sendSchedule(tx, param(req, 'id'))),
});

defineRoute({
  method: 'delete', path: `${R}/schedules/:id`, module: 'reports', summary: 'Remove a schedule',
  permission: 'reports.schedules.manage', params: idParam,
  responses: [{ status: 200, description: 'Removed.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => deleteSchedule(tx, param(req, 'id'))),
});
