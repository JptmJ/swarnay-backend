/**
 * Girvi — lending against a customer's jewellery.
 *
 * The gold is security, not stock: it sits in a sealed packet and goes back
 * when the loan is cleared. The shop's asset is the money lent. Interest is
 * written one period at a time and never recalculated.
 */
import { z } from 'zod';
import { defineRoute, queryOf } from '../core/http/route-registry.js';
import { transaction } from '../core/db/client.js';
import { param } from '../core/http/middleware.js';
import {
  accrueAll, accrueInterest, appraise, auctionLoan, cancelRepayment, girviSettings, loanDetail, loanList,
  portfolio, releaseLoan, repay, sanction, sendNotice, settlementQuote, vaultRegister, waiveAccrual,
} from '../modules/girvi/girvi.service.js';
import { decimal, errorEnvelope, idParam, isoDate, money, pagination, phone, record, uuid, weight } from './schemas.js';

const DAY = '2026-10-09';
const seed = [{ date: '2026-09-18', kind: 'added' as const, note: 'Girvi pawn loans.' }];
const built = (note: string) => [...seed, { date: DAY, kind: 'changed' as const, note }];
const G = '/api/girvi';
const GIRVI_STATUSES = ['draft', 'sanctioned', 'active', 'overdue', 'redeemed', 'defaulted', 'auctioned', 'cancelled'] as const;

const collateralLine = z.object({
  description: z.string().trim().min(1).max(300),
  metalId: uuid,
  purityId: uuid.nullish(),
  itemCategoryId: uuid.nullish(),
  quantity: z.coerce.number().int().min(1).max(999).default(1),
  grossWeight: weight,
  stoneWeight: weight.optional(),
  testedPurityPercent: decimal.optional().describe('Left out, the chosen purity’s fineness is used.'),
  testMethod: z.enum(['xrf', 'touchstone', 'declared']).default('xrf'),
  conditionNotes: z.string().max(500).optional(),
  photoStorageKey: z.string().max(500).optional(),
});

/* --------------------------------------------------------------- settings */

defineRoute({
  method: 'get', path: `${G}/settings`, module: 'girvi', summary: 'Girvi settings in force',
  description: 'How interest is quoted and worked out, what the shop lends against, its charges, how a payment is applied, identity rules, and the notice and auction run. Read-only here; changed in Settings.',
  permission: 'girvi.view',
  responses: [{ status: 200, description: 'The settings.', schema: record }],
  changelog: built('Every Girvi rule is a setting.'),
  handler: async () => transaction((tx) => girviSettings(tx)),
});

defineRoute({
  method: 'post', path: `${G}/appraise`, module: 'girvi', summary: 'What the collateral is worth, and the most that may be lent',
  description: 'Values the articles at the shop’s own rate — never a rate sent in from the screen — and gives the loan-to-value ceiling. Nothing is saved.',
  permission: 'girvi.view',
  body: z.object({ collateral: z.array(collateralLine).min(1).max(50), onDate: isoDate.optional() }),
  responses: [
    { status: 200, description: 'Each article valued, with the ceiling.', schema: record },
    { status: 422, description: 'No rate is set for that metal.', schema: errorEnvelope },
  ],
  changelog: built('Live appraisal, so the counter can quote before anything is saved.'),
  handler: async (req) => transaction(async (tx) => {
    const s = await girviSettings(tx);
    const onDate = req.body.onDate ?? new Date().toISOString().slice(0, 10);
    return appraise(tx, s, req.body.collateral, onDate);
  }),
});

/* ----------------------------------------------------------------- loans */

defineRoute({
  method: 'post', path: `${G}/loans`, module: 'girvi', summary: 'Give a loan against jewellery',
  description: [
    'Values the articles at the shop’s rate, caps the loan at its loan-to-value, seals the packet and hands the money over through a payment mode from Masters.',
    'The money moves from cash into a receivable; the gold is not bought and never enters stock, because it is still the borrower’s.',
    'The terms — rate, method, minimum interest, how a payment is applied — are copied onto the loan, so changing the shop’s settings later never rewrites what somebody signed.',
  ].join(' '),
  permission: 'girvi.create',
  body: z.object({
    customerId: uuid.optional().describe('Leave out for someone not on file; the borrower’s details are then required.'),
    borrowerName: z.string().trim().max(160).optional(), borrowerPhone: phone.optional(),
    borrowerAddress: z.string().max(500).optional(),
    borrowerIdType: z.enum(['aadhaar', 'pan', 'voter', 'driving_licence', 'passport']).optional(),
    borrowerIdNumber: z.string().trim().max(40).optional(), borrowerPhotoKey: z.string().max(500).optional(),
    sanctionedOn: isoDate.optional(), dueDate: isoDate.optional(),
    tenureMonths: z.coerce.number().int().min(0).max(120).optional(),
    principalAmount: money,
    quotedRate: decimal.optional().describe('In whatever the shop quotes in. Left out, the shop’s own rate is used.'),
    ltvPercent: decimal.optional(),
    disbursalMethodId: uuid, disbursalReference: z.string().trim().max(80).optional(),
    vaultPacketNumber: z.string().trim().max(40).optional(), vaultLocationId: uuid.optional(),
    packetWitnessName: z.string().trim().max(120).optional(),
    collateral: z.array(collateralLine).min(1).max(50),
    notes: z.string().max(2000).optional(),
  }),
  responses: [
    { status: 201, description: 'The loan, its collateral and the packet it is sealed in.', schema: record },
    { status: 422, description: 'Above the loan-to-value, outside the loan limits, identity or photographs missing, or a cash ceiling reached.', schema: errorEnvelope },
  ],
  changelog: built('Sanctioning posts to the books and takes custody properly.'),
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => sanction(tx, req.body))); },
});

defineRoute({
  method: 'get', path: `${G}/loans`, module: 'girvi', summary: 'Loans', permission: 'girvi.view',
  query: z.object({
    status: z.enum(GIRVI_STATUSES).optional(), branchId: uuid.optional(), customerId: uuid.optional(),
    search: z.string().trim().optional().describe('Loan number, borrower, mobile or packet.'),
    overdueOnly: z.coerce.boolean().optional(), dueBefore: isoDate.optional(),
  }).merge(pagination),
  responses: [{ status: 200, description: 'Newest first, with how many days each has to run.', schema: z.object({ rows: z.array(record), total: z.number() }) }],
  changelog: seed,
  handler: async (req) => transaction((tx) => loanList(tx, queryOf(req))),
});

defineRoute({
  method: 'get', path: `${G}/loans/:id`, module: 'girvi', summary: 'One loan with everything on it',
  description: 'The articles held, every interest period that has been charged, and every payment taken.',
  permission: 'girvi.view', params: idParam,
  responses: [
    { status: 200, description: 'The loan, its collateral, its interest and its payments.', schema: record },
    { status: 404, description: 'No such loan.', schema: errorEnvelope },
  ],
  changelog: seed,
  handler: async (req) => transaction((tx) => loanDetail(tx, param(req, 'id'))),
});

/* -------------------------------------------------------------- interest */

defineRoute({
  method: 'post', path: `${G}/loans/:id/accrue`, module: 'girvi', summary: 'Charge the interest that has fallen due',
  description: 'Writes every period up to today, one row each, and never touches a period already written. Running it twice changes nothing.',
  permission: 'girvi.update', params: idParam,
  body: z.object({ upTo: isoDate.optional() }),
  responses: [{ status: 200, description: 'How many periods were written, and the loan as it now stands.', schema: record }],
  changelog: built('Interest is actually charged, which nothing did before.'),
  handler: async (req) => transaction((tx) => accrueInterest(tx, param(req, 'id'), req.body.upTo)),
});

defineRoute({
  method: 'post', path: `${G}/accrue`, module: 'girvi', summary: 'Charge interest on every running loan',
  description: 'The month-end run. Safe to repeat: a period already charged is never charged again.',
  permission: 'girvi.update',
  body: z.object({ upTo: isoDate.optional() }),
  responses: [{ status: 200, description: 'Loans looked at, and periods written.', schema: record }],
  changelog: built('A month-end run for the whole book.'),
  handler: async (req) => transaction((tx) => accrueAll(tx, req.body.upTo)),
});

defineRoute({
  method: 'post', path: `${G}/accruals/:id/waive`, module: 'girvi', summary: 'Let a period of interest go',
  description: 'A goodwill call, kept with its reason. The period stays on the record, marked waived, so the history still adds up.',
  permission: 'girvi.waive', params: idParam,
  body: z.object({ reason: z.string().trim().min(3).max(500) }),
  responses: [
    { status: 200, description: 'Waived.', schema: record },
    { status: 422, description: 'Already waived.', schema: errorEnvelope },
  ],
  changelog: built('Waiving interest, with its own permission.'),
  handler: async (req) => transaction((tx) => waiveAccrual(tx, param(req, 'id'), req.body.reason)),
});

/* ------------------------------------------------------------- repayment */

defineRoute({
  method: 'get', path: `${G}/loans/:id/settlement`, module: 'girvi', summary: 'What it takes to clear this loan today',
  description: 'Brings the interest up to date and shows what is owed, including any least-interest the shop insists on and whatever it charges for closing early.',
  permission: 'girvi.view', params: idParam,
  responses: [{ status: 200, description: 'The figure to quote the borrower.', schema: record }],
  changelog: built('A settlement figure the counter can read out.'),
  handler: async (req) => transaction((tx) => settlementQuote(tx, param(req, 'id'))),
});

defineRoute({
  method: 'post', path: `${G}/loans/:id/repayments`, module: 'girvi', summary: 'Take a payment',
  description: [
    'Applies the money in the order the shop has set — penalty, interest and principal, or whatever order it uses — and gives a receipt.',
    'Payment modes come from Masters, so reference rules, per-mode limits and the shop’s cash ceiling apply.',
    'With `foreclose` the whole loan is settled today, including any charge for closing early.',
  ].join(' '),
  permission: 'girvi.update', params: idParam,
  body: z.object({
    amount: money, paymentMethodId: uuid, reference: z.string().trim().max(80).optional(),
    paidOn: isoDate.optional(), foreclose: z.boolean().optional(), notes: z.string().max(500).optional(),
  }),
  responses: [
    { status: 201, description: 'Taken, with the receipt and what is left.', schema: record },
    { status: 422, description: 'Loan closed, more than is owed, below the smallest payment, part-principal or interest-only where the shop does not allow it.', schema: errorEnvelope },
  ],
  changelog: built('Repayment posts to the books and follows the shop’s order of allocation.'),
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => repay(tx, param(req, 'id'), req.body))); },
});

defineRoute({
  method: 'post', path: `${G}/repayments/:id/cancel`, module: 'girvi', summary: 'Take back a payment entered by mistake',
  description: 'The money is reversed with mirror entries and the loan opens again if that payment had closed it. Nothing posted is ever deleted.',
  permission: 'girvi.update', params: idParam,
  body: z.object({ reason: z.string().trim().min(3).max(500) }),
  responses: [
    { status: 200, description: 'Taken back.', schema: record },
    { status: 422, description: 'Already taken back, or the loan has been auctioned.', schema: errorEnvelope },
  ],
  changelog: built('A wrong payment can be undone.'),
  handler: async (req) => transaction((tx) => cancelRepayment(tx, param(req, 'id'), req.body.reason)),
});

/* -------------------------------------------------- release and default */

defineRoute({
  method: 'post', path: `${G}/loans/:id/release`, module: 'girvi', summary: 'Give the packet back',
  description: 'Only once nothing is owed. The articles are marked returned, the packet is opened and a release receipt is raised.',
  permission: 'girvi.release', params: idParam,
  body: z.object({ releasedToName: z.string().trim().max(160).optional(), notes: z.string().max(500).optional() }),
  responses: [
    { status: 200, description: 'Given back, with the release number.', schema: record },
    { status: 422, description: 'Something is still owed, or it has already gone back.', schema: errorEnvelope },
  ],
  changelog: built('Release, which the module never had.'),
  handler: async (req) => transaction((tx) => releaseLoan(tx, param(req, 'id'), req.body)),
});

defineRoute({
  method: 'post', path: `${G}/loans/:id/notice`, module: 'girvi', summary: 'Record a notice sent to the borrower',
  description: 'What makes an auction lawful later. The shop sets how long after the due date the first notice goes, how many there are and the gap between them.',
  permission: 'girvi.release', params: idParam,
  body: z.object({ note: z.string().max(2000).optional() }),
  responses: [
    { status: 200, description: 'Recorded.', schema: record },
    { status: 422, description: 'Too early, too soon after the last one, or all notices already sent.', schema: errorEnvelope },
  ],
  changelog: built('The notice run before an auction.'),
  handler: async (req) => transaction((tx) => sendNotice(tx, param(req, 'id'), req.body)),
});

defineRoute({
  method: 'post', path: `${G}/loans/:id/auction`, module: 'girvi', summary: 'Sell the collateral',
  description: [
    'Allowed only once every notice has gone out and the time the shop allows has passed.',
    'What the sale fetches clears the debt in the shop’s order of allocation; anything short is the shop’s loss, and anything left over is the borrower’s money, held for them unless the shop has set otherwise.',
  ].join(' '),
  permission: 'girvi.auction', params: idParam,
  body: z.object({
    proceeds: money, auctionDate: isoDate.optional(), paymentMethodId: uuid.optional(),
    notes: z.string().max(2000).optional(),
  }),
  responses: [
    { status: 200, description: 'Sold, with what was recovered, any surplus and any shortfall.', schema: record },
    { status: 422, description: 'Notices still pending, too soon after the last one, or nothing owed.', schema: errorEnvelope },
  ],
  changelog: built('Auction, with the notice run enforced.'),
  handler: async (req) => transaction((tx) => auctionLoan(tx, param(req, 'id'), req.body)),
});

/* ------------------------------------------------------------- the book */

defineRoute({
  method: 'get', path: `${G}/vault`, module: 'girvi', summary: 'Every packet the shop is holding',
  description: 'The vault register: whose gold, how much of it, which packet and where it is kept — so anything can be found without opening a packet.',
  permission: 'girvi.view',
  query: z.object({ branchId: uuid.optional(), search: z.string().trim().optional() }),
  responses: [{ status: 200, description: 'Packets with their weights and what is lent against them.', schema: record }],
  changelog: built('The vault register.'),
  handler: async (req) => transaction((tx) => vaultRegister(tx, queryOf(req))),
});

defineRoute({
  method: 'get', path: `${G}/portfolio`, module: 'girvi', summary: 'The lending book',
  description: 'What is out, what it has earned, what is overdue, and how much gold is being held against it.',
  permission: 'girvi.view',
  query: z.object({ branchId: uuid.optional() }),
  responses: [{ status: 200, description: 'The summary.', schema: record }],
  changelog: built('The portfolio summary.'),
  handler: async (req) => transaction((tx) => portfolio(tx, queryOf<{ branchId?: string }>(req).branchId)),
});
