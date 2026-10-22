/**
 * Accounts — where every rupee and every gram the business moves ends up.
 *
 * The Money Desk on top, then the chart, the vouchers typed by hand, the cash
 * drawer, month and year close, the reports, the bank and the Tally export.
 * Every module posts here on its own; nothing in this file posts a bill.
 */
import { z } from 'zod';
import { defineRoute, queryOf } from '../core/http/route-registry.js';
import { transaction } from '../core/db/client.js';
import { param } from '../core/http/middleware.js';
import { accountsSettings, chartTree, createAccount, deleteAccount, moneyAccounts, updateAccount } from '../modules/accounts/chart.service.js';
import {
  approveJournal, cancelJournal, createJournal, journalDetail, journalList, openingState, rejectJournal, saveOpening,
} from '../modules/accounts/journal.service.js';
import { closeDay, closeMonth, closeYear, dayHistory, dayStatus, openDay, periodsOverview, reopenDay, reopenPeriod } from '../modules/accounts/close.service.js';
import {
  ageing, assertRange, balanceSheet, cashForecast, dayBook, gstSummary, karigarLedger, ledgerStatement, metalLedger, metalPosition, moneyDesk,
  partyStatement, profitAndLoss, trialBalance, voucherDetail, watchlist,
} from '../modules/accounts/reports.service.js';
import {
  autoMatch, clearEntry, ignoreLine, importStatement, matchLine, reconciliation, tallyExport, tallyPending, unmatchLine,
} from '../modules/accounts/bank.service.js';
import { JOURNAL_TYPES, VOUCHER_TYPES } from '../modules/accounts/accounts.schema.js';
import { decimal, errorEnvelope, idParam, isoDate, money, pagination, record, uuid, weight } from './schemas.js';

const A = '/api/accounts';
const DAY = '2026-10-09';
const seed = [{ date: DAY, kind: 'added' as const, note: 'Accounts built end to end.' }];
const old = [{ date: '2026-09-18', kind: 'added' as const, note: 'Initial endpoint.' }, { date: DAY, kind: 'changed' as const, note: 'Totals cover every matching entry, not just the page shown.' }];
const range = z.object({ from: isoDate.optional(), to: isoDate.optional(), branchId: uuid.optional() });
const reason = z.object({ reason: z.string().trim().min(3).max(500) });
const ranged = <T>(q: T & { from?: string; to?: string }) => { assertRange(q.from, q.to); return q; };

/* ------------------------------------------------------------- the desk */

defineRoute({
  method: 'get', path: `${A}/settings`, module: 'accounts', summary: 'Accounts settings in force',
  description: 'GST registration, how sales are split, card fees, financial year, day/month/year close rules, approval, Tally, revaluation, TDS and the watchlist thresholds. Changed in Settings.',
  permission: 'accounts.view',
  responses: [{ status: 200, description: 'The settings.', schema: record }],
  changelog: seed,
  handler: async () => transaction((tx) => accountsSettings(tx)),
});

defineRoute({
  method: 'get', path: `${A}/desk`, module: 'accounts', summary: 'The Money Desk: the whole business on one page',
  description: 'Cash and bank now, today’s money by where it came from, this month’s sales and profit, receivables and payables, GST, girvi and scheme positions, metal held, what needs attention, and where cash is heading.',
  permission: 'accounts.view',
  query: z.object({ date: isoDate.optional(), branchId: uuid.optional() }),
  responses: [{ status: 200, description: 'Everything the landing page shows, in one call.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => moneyDesk(tx, queryOf(req))),
});

defineRoute({
  method: 'get', path: `${A}/watchlist`, module: 'accounts', summary: 'Things in the books that need a look',
  description: 'Cash below zero, ₹2 lakh cash from one person in a day, back-dated entries, heavy discounts, days not closed, reversals, approvals waiting, and suspense balances.',
  permission: 'accounts.view',
  query: z.object({ days: z.coerce.number().int().min(1).max(365).optional(), branchId: uuid.optional() }),
  responses: [{ status: 200, description: 'Flags, most serious first.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => watchlist(tx, queryOf(req))),
});

/* ------------------------------------------------------------- the chart */

defineRoute({
  method: 'get', path: `${A}/chart`, module: 'accounts', summary: 'Chart of accounts with balances',
  description: 'Groups and ledgers in display order, each group carrying the total of everything under it. Balances as at `to` (or over `from`–`to`), for one branch or all.',
  permission: 'accounts.view',
  query: range.extend({ includeInactive: z.coerce.boolean().optional() }),
  responses: [{ status: 200, description: 'Rows with depth, debit, credit and balance.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => chartTree(tx, ranged(queryOf(req)))),
});

defineRoute({
  method: 'get', path: `${A}/money-accounts`, module: 'accounts', summary: 'Cash and bank ledgers with balances',
  description: 'Each cash drawer and bank account, what the books say is in it, and which payment modes post to it.',
  permission: 'accounts.view',
  query: z.object({ asOn: isoDate.optional(), branchId: uuid.optional() }),
  responses: [{ status: 200, description: 'The ledgers.', schema: z.array(record) }],
  changelog: seed,
  handler: async (req) => transaction((tx) => moneyAccounts(tx, queryOf(req))),
});

const accountBody = z.object({
  name: z.string().trim().min(2).max(120),
  parentId: uuid.describe('The group it sits under; its type (asset, expense…) comes from there.'),
  code: z.string().trim().max(20).optional(),
  isGroup: z.boolean().optional(),
  ledgerKind: z.enum(['cash', 'bank', 'general']).optional(),
  description: z.string().max(500).nullish(),
  bankName: z.string().max(120).nullish(), bankAccountNumber: z.string().max(40).nullish(),
  bankIfsc: z.string().max(20).nullish(), tallyName: z.string().max(120).nullish(),
  isActive: z.boolean().optional(),
});

defineRoute({
  method: 'post', path: `${A}/chart`, module: 'accounts', summary: 'Add a ledger or group',
  description: 'A new expense head, a second bank account, a drawer for another counter. The code is picked automatically unless one is given.',
  permission: 'accounts.chart.manage', body: accountBody,
  responses: [{ status: 201, description: 'The ledger.', schema: record }, { status: 422, description: 'Name or code taken, or the parent is a ledger.', schema: errorEnvelope }],
  changelog: seed,
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => createAccount(tx, req.body))); },
});

defineRoute({
  method: 'patch', path: `${A}/chart/:id`, module: 'accounts', summary: 'Change a ledger',
  description: 'Rename, move to another group of the same type, bank details, Tally name, or switch off (only with no balance). Standard ledgers keep their place and stay on.',
  permission: 'accounts.chart.manage', params: idParam, body: accountBody.partial(),
  responses: [{ status: 200, description: 'The ledger.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => updateAccount(tx, param(req, 'id'), req.body)),
});

defineRoute({
  method: 'delete', path: `${A}/chart/:id`, module: 'accounts', summary: 'Remove a ledger never used',
  description: 'Only a ledger the shop made, with no entries, nothing under it and no payment mode pointing at it. Otherwise switch it off.',
  permission: 'accounts.chart.manage', params: idParam,
  responses: [{ status: 200, description: 'Removed.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => deleteAccount(tx, param(req, 'id'))),
});

/* --------------------------------------------------------------- vouchers */

const line = z.object({
  accountId: uuid, partyId: uuid.nullish(), debit: money.optional(), credit: money.optional(), narration: z.string().max(300).optional(),
  metalId: uuid.nullish(), purityId: uuid.nullish(), weightIn: weight.optional(), weightOut: weight.optional(),
});
const common = { docDate: isoDate.optional(), narration: z.string().trim().max(500).optional(), reference: z.string().trim().max(80).optional(),
  attachmentKey: z.string().max(500).optional() };
const journalBody = z.discriminatedUnion('docType', [
  z.object({ docType: z.literal('expense'), ...common, accountId: uuid, amount: money, gstAmount: money.optional(), gstRate: decimal.optional(),
    interState: z.boolean().optional(), paymentMethodId: uuid.optional(), payableTo: z.enum(['expenses_payable', 'supplier']).optional(),
    partyId: uuid.optional(), payee: z.string().trim().max(120).optional(), tdsPercent: decimal.optional(),
    billNumber: z.string().trim().max(60).optional(), billDate: isoDate.optional() }),
  z.object({ docType: z.literal('payment'), ...common, accountId: uuid, amount: money, paymentMethodId: uuid, partyId: uuid.optional(),
    payee: z.string().trim().max(120).optional(), tdsPercent: decimal.optional() }),
  z.object({ docType: z.literal('receipt'), ...common, accountId: uuid, amount: money, paymentMethodId: uuid, partyId: uuid.optional(),
    payee: z.string().trim().max(120).optional() }),
  z.object({ docType: z.literal('contra'), ...common, fromAccountId: uuid, toAccountId: uuid, amount: money }),
  z.object({ docType: z.literal('journal'), ...common, lines: z.array(line).min(2).max(60) }),
]);

defineRoute({
  method: 'post', path: `${A}/journals`, module: 'accounts', summary: 'Enter an expense, payment, receipt, contra or journal',
  description: [
    'expense: an expense head, the amount before GST, GST (claimed as input credit, or added to the cost under composition), TDS if held back, and how it was paid — a payment mode, owed to a supplier, or owed for later.',
    'payment / receipt: money out to, or in from, a ledger that is not cash or bank (rent, GST to the government, a loan) through a payment mode.',
    'contra: cash to bank, bank to cash, bank to bank.',
    'journal: any balanced set of lines, including grams on metal ledgers. Control accounts (Debtors, Creditors) need the party.',
    'Posted at once, or left waiting when expenses need approval and the person entering cannot approve.',
  ].join(' '),
  permission: 'accounts.journal.create', body: journalBody,
  responses: [
    { status: 201, description: 'The voucher with its lines and, once posted, its voucher number.', schema: record },
    { status: 422, description: 'Does not balance, a ledger is a group or switched off, a period or day is closed, or a control account was used.', schema: errorEnvelope },
  ],
  changelog: seed,
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => createJournal(tx, req.body))); },
});

defineRoute({
  method: 'get', path: `${A}/journals`, module: 'accounts', summary: 'Vouchers entered in Accounts',
  permission: 'accounts.view',
  query: z.object({
    docType: z.enum(JOURNAL_TYPES).optional(), status: z.enum(['pending_approval', 'posted', 'rejected', 'cancelled']).optional(),
    search: z.string().trim().optional(), accountId: uuid.optional(),
  }).merge(range).merge(pagination),
  responses: [{ status: 200, description: 'Newest first.', schema: z.object({ rows: z.array(record), total: z.number(), postedAmount: money }) }],
  changelog: seed,
  handler: async (req) => transaction((tx) => journalList(tx, ranged(queryOf(req)))),
});

defineRoute({
  method: 'get', path: `${A}/journals/:id`, module: 'accounts', summary: 'One voucher with its lines',
  permission: 'accounts.view', params: idParam,
  responses: [{ status: 200, description: 'The voucher.', schema: record }, { status: 404, description: 'No such voucher.', schema: errorEnvelope }],
  changelog: seed,
  handler: async (req) => transaction((tx) => journalDetail(tx, param(req, 'id'))),
});

defineRoute({
  method: 'post', path: `${A}/journals/:id/approve`, module: 'accounts', summary: 'Approve an expense and post it',
  permission: 'accounts.journal.approve', params: idParam,
  responses: [{ status: 200, description: 'The voucher, now posted.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => approveJournal(tx, param(req, 'id'))),
});

defineRoute({
  method: 'post', path: `${A}/journals/:id/reject`, module: 'accounts', summary: 'Turn down an expense waiting for approval',
  permission: 'accounts.journal.approve', params: idParam, body: reason,
  responses: [{ status: 200, description: 'The voucher, rejected. Nothing reached the books.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => rejectJournal(tx, param(req, 'id'), req.body.reason)),
});

defineRoute({
  method: 'post', path: `${A}/journals/:id/cancel`, module: 'accounts', summary: 'Cancel a voucher',
  description: 'A posted voucher is undone by its mirror entry, dated today; the original stays for the record. Entries written by a day or month close are undone by reopening that close instead.',
  permission: 'accounts.journal.cancel', params: idParam, body: reason,
  responses: [{ status: 200, description: 'The voucher, cancelled.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => cancelJournal(tx, param(req, 'id'), req.body.reason)),
});

/* -------------------------------------------------------- opening balances */

defineRoute({
  method: 'get', path: `${A}/opening`, module: 'accounts', summary: 'Opening balances',
  description: 'What every ledger, customer and supplier started with, in rupees and grams, and how much does not yet add up.',
  permission: 'accounts.view',
  responses: [{ status: 200, description: 'The opening position.', schema: record }],
  changelog: seed,
  handler: async () => transaction((tx) => openingState(tx)),
});

defineRoute({
  method: 'post', path: `${A}/opening`, module: 'accounts', summary: 'Set opening balances',
  description: 'Send the figures as they should be; only the change is posted, as one opening voucher. Whatever does not balance waits in Opening Balance Difference.',
  permission: 'accounts.opening.manage',
  body: z.object({
    date: isoDate.optional(),
    ledgers: z.array(z.object({ accountId: uuid, debit: money.optional(), credit: money.optional() })).max(500).optional(),
    parties: z.array(z.object({ partyId: uuid, accountCode: z.enum(['1100', '2400', '2000']), debit: money.optional(), credit: money.optional() })).max(2000).optional(),
    metals: z.array(z.object({ accountCode: z.enum(['2010', '2100', '1220']), partyId: uuid.nullish(), metalId: uuid, purityId: uuid.nullish(),
      weightIn: weight.optional(), weightOut: weight.optional() })).max(2000).optional(),
  }),
  responses: [{ status: 200, description: 'Whether anything changed, and the opening position after.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => saveOpening(tx, req.body)),
});

/* ------------------------------------------------------------------ day */

const count = z.object({
  accountId: uuid.optional().describe('The cash ledger; the main drawer when left out.'),
  counted: money.optional(), denominations: z.record(z.string().regex(/^\d+$/), z.coerce.number().int().min(0)).optional(),
  note: z.string().trim().max(500).optional(), branchId: uuid.optional(),
});

defineRoute({
  method: 'get', path: `${A}/day`, module: 'accounts', summary: 'The cash drawer today',
  description: 'For each cash ledger at the branch: what it opened with, what came in and went out by source, what should be there now, and its open/close record.',
  permission: 'accounts.view',
  query: z.object({ date: isoDate.optional(), branchId: uuid.optional() }),
  responses: [{ status: 200, description: 'The day.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => dayStatus(tx, queryOf(req))),
});

defineRoute({
  method: 'post', path: `${A}/day/open`, module: 'accounts', summary: 'Open the day',
  description: 'Counts the drawer (or takes what the books carried forward, where counting on open is off). A difference is written to Cash Short / Excess.',
  permission: 'accounts.day.manage', body: count,
  responses: [{ status: 200, description: 'The day.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => openDay(tx, req.body)),
});

defineRoute({
  method: 'post', path: `${A}/day/close`, module: 'accounts', summary: 'Close the day',
  description: 'Counts the drawer against what the books say, writes any difference to Cash Short / Excess, and freezes the day’s summary. With the lock on, nothing more can be dated that day at the branch.',
  permission: 'accounts.day.manage', body: count.extend({ date: isoDate.optional() }),
  responses: [{ status: 200, description: 'The day.', schema: record }, { status: 422, description: 'Already closed, or a difference above the tolerance with no note.', schema: errorEnvelope }],
  changelog: seed,
  handler: async (req) => transaction((tx) => closeDay(tx, req.body)),
});

defineRoute({
  method: 'post', path: `${A}/day/:id/reopen`, module: 'accounts', summary: 'Reopen a closed day',
  permission: 'accounts.day.reopen', params: idParam, body: reason,
  responses: [{ status: 200, description: 'The day, open again.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => reopenDay(tx, param(req, 'id'), req.body.reason)),
});

defineRoute({
  method: 'get', path: `${A}/day/history`, module: 'accounts', summary: 'Past day closes',
  permission: 'accounts.view',
  query: range.extend({ limit: z.coerce.number().int().min(1).max(366).optional() }),
  responses: [{ status: 200, description: 'Newest first.', schema: z.array(record) }],
  changelog: seed,
  handler: async (req) => transaction((tx) => dayHistory(tx, queryOf(req))),
});

/* --------------------------------------------------------- months & years */

defineRoute({
  method: 'get', path: `${A}/periods`, module: 'accounts', summary: 'Months and the year, and where each stands',
  description: 'Every month of the financial year: open, due to close, closed or locked, its profit, and what stands in the way of closing it.',
  permission: 'accounts.view',
  query: z.object({ date: isoDate.optional() }),
  responses: [{ status: 200, description: 'The year.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => periodsOverview(tx, queryOf(req))),
});

defineRoute({
  method: 'post', path: `${A}/periods/close-month`, module: 'accounts', summary: 'Close a month',
  description: 'Sets off GST (output less input into GST Payable, or credit carried forward), optionally marks metal stock to market for the month-end figures, and locks the month.',
  permission: 'accounts.period.close',
  body: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'Use YYYY-MM'), note: z.string().max(500).optional() }),
  responses: [{ status: 200, description: 'What the close wrote.', schema: record }, { status: 422, description: 'Not over yet, already closed, or approvals / cash days outstanding.', schema: errorEnvelope }],
  changelog: seed,
  handler: async (req) => transaction((tx) => closeMonth(tx, req.body)),
});

defineRoute({
  method: 'post', path: `${A}/periods/close-year`, module: 'accounts', summary: 'Close the financial year',
  description: 'Moves the year’s profit (or loss) to capital or retained earnings, branch by branch, and locks the year. Months still open are closed with it when asked.',
  permission: 'accounts.period.close',
  body: z.object({ date: isoDate.optional().describe('Any date in the year to close; the last finished year when left out.'), closeOpenMonths: z.boolean().optional() }),
  responses: [{ status: 200, description: 'The profit moved and the months closed.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => closeYear(tx, req.body)),
});

defineRoute({
  method: 'post', path: `${A}/periods/:id/reopen`, module: 'accounts', summary: 'Reopen a closed month or year',
  permission: 'accounts.period.reopen', params: idParam, body: reason,
  responses: [{ status: 200, description: 'Reopened.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => reopenPeriod(tx, param(req, 'id'), req.body.reason)),
});

/* ------------------------------------------------------- vouchers & books */

defineRoute({
  method: 'get', path: `${A}/vouchers`, module: 'accounts', summary: 'Every voucher from every module (day book)',
  description: 'Sales, purchases, old gold, schemes, girvi, karigar, stock and Accounts’ own — each with its lines and the document it came from. Reversals are left out unless asked for.',
  permission: 'accounts.view',
  query: range.extend({
    voucherType: z.enum(VOUCHER_TYPES).optional(), search: z.string().trim().optional(), accountId: uuid.optional(),
    includeReversed: z.coerce.boolean().optional(), reversedOnly: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(), offset: z.coerce.number().int().min(0).optional(),
  }),
  responses: [{ status: 200, description: 'Vouchers, newest first, with the period’s count and total.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => dayBook(tx, ranged(queryOf(req)))),
});

defineRoute({
  method: 'get', path: `${A}/vouchers/:id`, module: 'accounts', summary: 'One voucher: its money and metal lines',
  permission: 'accounts.view', params: idParam,
  responses: [{ status: 200, description: 'The voucher.', schema: record }, { status: 404, description: 'No such voucher.', schema: errorEnvelope }],
  changelog: seed,
  handler: async (req) => transaction((tx) => voucherDetail(tx, param(req, 'id'))),
});

/* ---------------------------------------------------------------- reports */

const report = (path: string, summary: string, description: string, query: z.ZodObject<z.ZodRawShape>, fn: (tx: Parameters<typeof trialBalance>[0], q: never) => Promise<unknown>) =>
  defineRoute({
    method: 'get', path: `${A}/reports/${path}`, module: 'accounts', summary, description, permission: 'accounts.reports.view', query,
    responses: [{ status: 200, description: 'The report.', schema: record }],
    changelog: seed,
    handler: async (req) => transaction((tx) => fn(tx, ranged(queryOf(req)) as never)),
  });

report('trial-balance', 'Trial balance', 'Opening, debits, credits and closing for every ledger and group. If debits and credits ever differ, something is badly wrong.',
  range.extend({ showZero: z.coerce.boolean().optional() }), trialBalance);
report('ledger', 'Ledger statement', 'Every entry in a ledger (or every ledger under a group) with a running balance; grams too on metal ledgers. Optionally one party on a control account.',
  range.extend({ accountId: uuid, partyId: uuid.optional() }), ledgerStatement);
report('party', 'Customer or supplier statement', 'Bills, payments, advances, girvi and savings for one person as one running balance, plus grams owed either way.',
  z.object({ partyId: uuid, from: isoDate.optional(), to: isoDate.optional() }), partyStatement);
report('profit-loss', 'Profit & loss', 'Trading (sales less what was sold cost) to gross profit, then other income and expenses to net profit, against the period before. Shows where the margin came from: metal, making, wastage, stones.',
  range, profitAndLoss);
report('balance-sheet', 'Balance sheet', 'What the business owns and owes as at a date, by group, with the profit not yet closed to capital.',
  z.object({ asOn: isoDate.optional(), branchId: uuid.optional() }), balanceSheet);
report('ageing', 'Who owes and for how long', 'Receivables or payables per party in 0–30, 31–60, 61–90, 91–180 and 180+ day buckets, oldest bill cleared first, with what is past the party’s credit days.',
  z.object({ kind: z.enum(['receivable', 'payable']), asOn: isoDate.optional(), branchId: uuid.optional() }), ageing);
report('gst', 'GST summary', 'Output and input GST by CGST, SGST and IGST, the net payable, B2B and B2C sales, purchases, returns, and the HSN summary for the return.',
  range, gstSummary);
report('metal-position', 'Metal position', 'Fine grams in stock and with karigars, against grams owed to suppliers, customers and savings members, and girvi gold held as security, valued at today’s rate.',
  z.object({ asOn: isoDate.optional(), branchId: uuid.optional() }), metalPosition);
report('forecast', 'Cash forecast', 'What should come in (customer dues, girvi, savings, order balances) and go out (suppliers, GST, TDS, wages) day by day, and the lowest point cash reaches.',
  z.object({ days: z.coerce.number().int().min(7).max(120).optional(), branchId: uuid.optional() }), cashForecast);

defineRoute({
  method: 'get', path: `${A}/metal-ledger`, module: 'accounts', summary: 'The precious metal ledger, in fine grams',
  description: 'The gram side of the dual ledger. Weights are fine (pure) so purities are comparable. The balance covers every matching entry, not only the page.',
  permission: 'accounts.metal.view',
  query: z.object({ accountId: uuid.optional(), partyId: uuid.optional(), metalId: uuid.optional(), from: isoDate.optional(), to: isoDate.optional() }).merge(pagination),
  responses: [{ status: 200, description: 'Metal entries with the balance.', schema: z.object({ rows: z.array(record), total: z.number(), balance: weight, weightIn: weight, weightOut: weight }) }],
  changelog: old,
  handler: async (req) => transaction((tx) => metalLedger(tx, ranged(queryOf(req)))),
});

defineRoute({
  method: 'get', path: `${A}/karigar-ledger`, module: 'accounts', summary: 'Karigar metal and ghat ledger',
  description: 'Metal issued to each goldsmith, what came back, and the ghat (loss). The balance covers every matching entry, not only the page.',
  permission: 'accounts.ghat.view',
  query: z.object({ karigarId: uuid.optional(), from: isoDate.optional(), to: isoDate.optional() }).merge(pagination),
  responses: [{ status: 200, description: 'Karigar entries with the balance.', schema: z.object({ rows: z.array(record), total: z.number(), metalBalance: weight }) }],
  changelog: old,
  handler: async (req) => transaction((tx) => karigarLedger(tx, ranged(queryOf(req)))),
});

/* ------------------------------------------------------------------ bank */

defineRoute({
  method: 'get', path: `${A}/bank/reconciliation`, module: 'accounts', summary: 'Bank reconciliation',
  description: 'The statement lines and the book entries side by side, what is matched, and why the bank and the books differ.',
  permission: 'accounts.bank.manage',
  query: z.object({ accountId: uuid, from: isoDate.optional(), to: isoDate.optional() }),
  responses: [{ status: 200, description: 'The reconciliation.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => reconciliation(tx, ranged(queryOf(req)))),
});

defineRoute({
  method: 'post', path: `${A}/bank/statement`, module: 'accounts', summary: 'Import bank statement lines',
  description: 'Lines read from the bank’s CSV or typed in. A line already imported is skipped. Matching runs straight after.',
  permission: 'accounts.bank.manage',
  body: z.object({ accountId: uuid, rows: z.array(z.object({
    date: isoDate, description: z.string().max(500).optional(), reference: z.string().max(120).optional(),
    withdrawal: money.optional(), deposit: money.optional(), balance: decimal.optional(),
  })).min(1).max(5000) }),
  responses: [{ status: 200, description: 'How many were added, skipped and matched.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => importStatement(tx, req.body)),
});

defineRoute({
  method: 'post', path: `${A}/bank/auto-match`, module: 'accounts', summary: 'Match statement lines to the books automatically',
  description: 'Same amount and direction, within a week, a matching reference preferred. Each entry is used once.',
  permission: 'accounts.bank.manage', body: z.object({ accountId: uuid }),
  responses: [{ status: 200, description: 'How many were matched.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => autoMatch(tx, req.body.accountId)),
});

defineRoute({
  method: 'post', path: `${A}/bank/lines/:id/match`, module: 'accounts', summary: 'Match a statement line to an entry',
  permission: 'accounts.bank.manage', params: idParam, body: z.object({ entryId: uuid }),
  responses: [{ status: 200, description: 'Matched.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => matchLine(tx, param(req, 'id'), req.body.entryId)),
});

defineRoute({
  method: 'post', path: `${A}/bank/lines/:id/unmatch`, module: 'accounts', summary: 'Undo a match',
  permission: 'accounts.bank.manage', params: idParam,
  responses: [{ status: 200, description: 'Unmatched.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => unmatchLine(tx, param(req, 'id'))),
});

defineRoute({
  method: 'post', path: `${A}/bank/lines/:id/ignore`, module: 'accounts', summary: 'Set a statement line aside',
  description: 'For a line that has no entry in the books on purpose (a bank-side correction reversed the same day).',
  permission: 'accounts.bank.manage', params: idParam, body: z.object({ note: z.string().trim().min(3).max(300) }),
  responses: [{ status: 200, description: 'Set aside.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => ignoreLine(tx, param(req, 'id'), req.body.note)),
});

defineRoute({
  method: 'post', path: `${A}/bank/entries/:id/clear`, module: 'accounts', summary: 'Tick a bank entry as cleared',
  description: 'Without a statement line — from a passbook, say. Send null to untick.',
  permission: 'accounts.bank.manage', params: idParam, body: z.object({ clearedOn: isoDate.nullable() }),
  responses: [{ status: 200, description: 'Ticked or unticked.', schema: record }],
  changelog: seed,
  handler: async (req) => transaction((tx) => clearEntry(tx, param(req, 'id'), req.body.clearedOn)),
});

/* ----------------------------------------------------------------- Tally */

defineRoute({
  method: 'get', path: `${A}/tally/status`, module: 'accounts', summary: 'Vouchers not yet sent to Tally',
  permission: 'accounts.tally.export',
  responses: [{ status: 200, description: 'The count.', schema: z.object({ pending: z.number() }) }],
  changelog: seed,
  handler: async () => transaction(async (tx) => ({ pending: await tallyPending(tx) })),
});

defineRoute({
  method: 'post', path: `${A}/tally/export`, module: 'accounts', summary: 'Export to Tally (XML)',
  description: 'Ledgers and vouchers as Tally XML, customers and suppliers as their own ledgers. With onlyNew, only what has not gone before; with markExported, those are marked as sent.',
  permission: 'accounts.tally.export',
  body: z.object({ from: isoDate.optional(), to: isoDate.optional(), onlyNew: z.boolean().optional(), markExported: z.boolean().optional() }),
  responses: [{ status: 200, description: 'The XML and what it holds.', schema: record }, { status: 422, description: 'The Tally export is switched off.', schema: errorEnvelope }],
  changelog: seed,
  handler: async (req) => transaction((tx) => tallyExport(tx, ranged(req.body))),
});
