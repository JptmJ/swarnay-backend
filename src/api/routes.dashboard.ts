/**
 * Dashboard — the day's figures, charts, what needs attention and what
 * happened, plus each person's layout and the defaults the owner sets per role.
 *
 * The screen asks for each part separately and only for the widgets it shows,
 * so the parts load side by side and a hidden widget costs nothing.
 */
import { z } from 'zod';
import { defineRoute } from '../core/http/route-registry.js';
import { transaction } from '../core/db/client.js';
import { param } from '../core/http/middleware.js';
import {
  activity, alerts, charts, deleteDefault, getLayout, layoutDefaults, resetLayout, saveDefault, saveLayout, summary, TREND_DAYS,
} from '../modules/dashboard/dashboard.service.js';
import { isoDate, ok, record, uuid } from './schemas.js';

const D = '/api/dashboard';
const DAY = '2026-10-12';
const seed = [{ date: DAY, kind: 'added' as const, note: 'Dashboard on live figures, defined like the matching reports.' }];
const M = 'dashboard';

const widgetList = z.string().max(2000).optional()
  .transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined))
  .describe('Comma-separated widget ids to compute; omit for every widget you may see.');
const scope = { date: isoDate.optional().describe('The day to show; today in the shop’s time zone when omitted.'),
  branchId: uuid.optional().describe('One branch; omit for every branch.') };
const widgetId = z.string().regex(/^((kpi|chart|panel)_[a-z_]+|report_(cat|view):[A-Za-z0-9_-]+)$/, 'Not a dashboard widget.');
const layoutBody = z.object({
  widgets: z.array(z.object({ id: widgetId, visible: z.boolean(), order: z.coerce.number().int().min(0).max(1000) })).max(80),
  settings: z.object({ salesTrendDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional() }).passthrough().default({}),
});

defineRoute({
  method: 'get', path: `${D}/summary`, module: M,
  summary: 'The headline figures',
  description: 'Stock, today’s sales, customers, orders, old gold, savings, receivables, cash and bank, girvi and this month’s gross profit, each with the last days for a sparkline. Only figures you may see are returned.',
  permission: 'dashboard.view',
  query: z.object({ ...scope, widgets: widgetList }),
  responses: [{ status: 200, description: 'The figures, keyed by widget.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => summary(tx, req.query as never)),
});

defineRoute({
  method: 'get', path: `${D}/charts`, module: M,
  summary: 'The charts',
  description: 'Sales by day, by category and by payment mode over the last 7, 30 or 90 days; customers by city; stock by age.',
  permission: 'dashboard.view',
  query: z.object({ ...scope, days: z.coerce.number().int().refine((d) => (TREND_DAYS as readonly number[]).includes(d), 'Choose 7, 30 or 90 days.').optional(), widgets: widgetList }),
  responses: [{ status: 200, description: 'Each chart’s points.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => charts(tx, req.query as never)),
});

defineRoute({
  method: 'get', path: `${D}/alerts`, module: M,
  summary: 'What needs attention',
  description: 'Rates not entered, late and due orders, karigar jobs out too long, categories running low, old unpaid bills, overdue girvi, missed savings, pieces without HUID, unprinted tags, open cash days, entries awaiting approval and unread report alerts. Limits come from the dashboard settings; kinds can be switched off.',
  permission: 'dashboard.view',
  query: z.object(scope),
  responses: [{ status: 200, description: 'Warnings, the most serious first.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => alerts(tx, req.query as never)),
});

defineRoute({
  method: 'get', path: `${D}/activity`, module: M,
  summary: 'What happened on the day',
  description: 'Every document posted that day (bills, purchases, old gold, savings, girvi, vouchers…), orders taken and master changes, newest first, limited to the modules you may see.',
  permission: 'dashboard.view',
  query: z.object({ ...scope, limit: z.coerce.number().int().min(1).max(300).optional() }),
  responses: [{ status: 200, description: 'The day’s activity.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => activity(tx, req.query as never)),
});

defineRoute({
  method: 'get', path: `${D}/layout`, module: M,
  summary: 'My layout, pinned reports and the shop’s dashboard rules',
  description: 'Your own layout, else your role’s default, else the default for everyone; null means the built-in one.',
  permission: 'dashboard.view',
  responses: [{ status: 200, description: 'Layout, where it came from, pinned reports and rules.', schema: record }],
  changelog: seed,
  handler: async () => transaction((tx) => getLayout(tx)),
});

defineRoute({
  method: 'put', path: `${D}/layout`, module: M,
  summary: 'Save my layout',
  permission: 'dashboard.view',
  body: layoutBody,
  responses: [{ status: 200, description: 'Saved.', schema: ok }],
  changelog: [{ date: DAY, kind: 'changed', note: 'Takes { widgets: [{ id, visible, order }], settings }.' }],
  handler: async (req) => transaction((tx) => saveLayout(tx, req.body as never)),
});

defineRoute({
  method: 'delete', path: `${D}/layout`, module: M,
  summary: 'Go back to the default layout',
  permission: 'dashboard.view',
  responses: [{ status: 200, description: 'The layout now in use.', schema: record }],
  changelog: seed,
  handler: async () => transaction((tx) => resetLayout(tx)),
});

defineRoute({
  method: 'get', path: `${D}/layout/defaults`, module: M,
  summary: 'Roles and their default layouts',
  permission: 'dashboard.layout.manage',
  responses: [{ status: 200, description: 'Every role, with whether it has a default. "*" is everyone.', schema: z.array(record) }],
  changelog: seed,
  handler: async () => transaction((tx) => layoutDefaults(tx)),
});

defineRoute({
  method: 'put', path: `${D}/layout/defaults/:roleCode`, module: M,
  summary: 'Set the default layout for a role',
  description: 'People of that role who never arranged their own Dashboard see this one. Use "*" for everyone.',
  permission: 'dashboard.layout.manage',
  params: z.object({ roleCode: z.string().min(1).max(60) }),
  body: layoutBody,
  responses: [{ status: 200, description: 'Roles and their defaults.', schema: z.array(record) }],
  changelog: seed,
  handler: async (req) => transaction((tx) => saveDefault(tx, param(req, 'roleCode'), req.body as never)),
});

defineRoute({
  method: 'delete', path: `${D}/layout/defaults/:roleCode`, module: M,
  summary: 'Remove a role’s default layout',
  permission: 'dashboard.layout.manage',
  params: z.object({ roleCode: z.string().min(1).max(60) }),
  responses: [{ status: 200, description: 'Roles and their defaults.', schema: z.array(record) }],
  changelog: seed,
  handler: async (req) => transaction((tx) => deleteDefault(tx, param(req, 'roleCode'))),
});
