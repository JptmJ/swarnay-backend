/**
 * What the books say, in the forms an owner and an accountant read them.
 *
 * Every report is worked out from the ledger itself — nothing is stored twice —
 * so a figure on one screen always agrees with the same figure on another.
 * Each takes a period and, where it makes sense, a branch.
 */
import type { Tx } from '../../core/db/client.js';
import { NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { add, compare, isZero, mul, round, sub, sum, type Decimal } from '../../core/util/decimal.js';
import { businessDate } from '../../core/util/business-date.js';
import {
  accountsSettings, addDays, balances, buildTree, fyBounds, loadChart, monthEnd, monthStart, moneyAccounts, natural,
  naturalSide, type ChartAccount, type TreeRow,
} from './chart.service.js';
import { SOURCE_LABELS } from './close.service.js';

const rs = (v: Decimal) => round(v, 2);
const abs = (v: Decimal) => (compare(v, '0') < 0 ? sub('0', v) : v);
const today_ = (tx: Tx) => businessDate(tx);

/** The number of the document a voucher came from, whatever module wrote it. */
export const SOURCE_NUMBER_SQL = (v: string) => `case ${v}.source_type
    when 'sales_invoice' then (select doc_number from sales_invoice where id = ${v}.source_id)
    when 'sales_return' then (select doc_number from sales_return where id = ${v}.source_id)
    when 'customer_receipt' then (select doc_number from customer_receipt where id = ${v}.source_id)
    when 'goods_receipt' then (select doc_number from goods_receipt where id = ${v}.source_id)
    when 'purchase_invoice' then (select doc_number from purchase_invoice where id = ${v}.source_id)
    when 'purchase_return' then (select doc_number from purchase_return where id = ${v}.source_id)
    when 'supplier_settlement' then (select doc_number from supplier_settlement where id = ${v}.source_id)
    when 'stock_adjustment' then (select doc_number from stock_adjustment where id = ${v}.source_id)
    when 'stock_transfer' then (select doc_number from stock_transfer where id = ${v}.source_id)
    when 'old_gold_intake' then (select voucher_number from old_gold_intake where id = ${v}.source_id)
    when 'old_gold_payout' then (select i.voucher_number from old_gold_payout p join old_gold_intake i on i.id = p.old_gold_intake_id where p.id = ${v}.source_id)
    when 'melt_batch' then (select batch_number from melt_batch where id = ${v}.source_id)
    when 'order_payment' then (select receipt_number from order_payment where id = ${v}.source_id)
    when 'karigar_job' then (select job_number from karigar_job where id = ${v}.source_id)
    when 'karigar_job_receive' then (select job_number from karigar_job where id = ${v}.source_id)
    when 'karigar_payment' then (select name from karigar where id = ${v}.source_id)
    when 'scheme_installment' then (select receipt_number from scheme_installment where id = ${v}.source_id)
    when 'scheme_redemption' then (select redemption_number from scheme_redemption where id = ${v}.source_id)
    when 'girvi_loan' then (select loan_number from girvi_loan where id = ${v}.source_id)
    when 'girvi_accrual' then (select loan_number from girvi_loan where id = ${v}.source_id)
    when 'girvi_repayment' then (select receipt_number from girvi_repayment where id = ${v}.source_id)
    when 'journal_entry' then (select doc_number from journal_entry where id = ${v}.source_id)
    when 'data_import' then (select 'Import: ' || title from import_batch where id = ${v}.source_id)
    else null end`;

/** Which screen a voucher's document is opened on. */
export const SOURCE_MODULE: Record<string, string> = {
  sales_invoice: 'pos', sales_return: 'pos', customer_receipt: 'pos', goods_receipt: 'purchase', purchase_invoice: 'purchase',
  purchase_return: 'purchase', supplier_settlement: 'purchase', stock_adjustment: 'stock', stock_transfer: 'stock', stock_opening: 'stock',
  stock_piece: 'stock', stock_count: 'stock', tagging_lot: 'tagging', old_gold_intake: 'oldgold', old_gold_payout: 'oldgold',
  melt_batch: 'oldgold', order_payment: 'orders', karigar_job: 'orders', karigar_job_receive: 'orders', karigar_payment: 'orders',
  scheme_installment: 'schemes', scheme_redemption: 'schemes', girvi_loan: 'girvi', girvi_accrual: 'girvi', girvi_repayment: 'girvi',
  journal_entry: 'accounts', data_import: 'accounts',
};

/* ------------------------------------------------------------ trial balance */

export async function trialBalance(tx: Tx, q: { from?: string; to?: string; branchId?: string; showZero?: boolean }) {
  const to = q.to ?? (await today_(tx));
  const chart = await loadChart(tx);
  const [open, period] = await Promise.all([
    q.from ? balances(tx, { to: addDays(q.from, -1), branchId: q.branchId }) : Promise.resolve(new Map()),
    balances(tx, { from: q.from, to, branchId: q.branchId }),
  ]);
  const openTree = new Map(buildTree(chart, open).map((r) => [r.id, r]));
  const rows = buildTree(chart, period).map((r) => {
    const o = openTree.get(r.id)!;
    const closing = add(o.net, r.net);
    return {
      id: r.id, code: r.code, name: r.name, account_type: r.account_type, is_group: r.is_group, depth: r.depth, parent_id: r.parent_id,
      ledger_kind: r.ledger_kind, is_control: r.is_control,
      opening: o.net, debit: r.debit, credit: r.credit, closing,
      closingDebit: compare(closing, '0') > 0 ? closing : '0', closingCredit: compare(closing, '0') < 0 ? abs(closing) : '0',
    };
  }).filter((r) => q.showZero || !isZero(r.opening) || !isZero(r.debit) || !isZero(r.credit));
  const ledgers = rows.filter((r) => !r.is_group);
  const totals = {
    openingDebit: sum(ledgers.map((r) => (compare(r.opening, '0') > 0 ? r.opening : '0'))),
    openingCredit: sum(ledgers.map((r) => (compare(r.opening, '0') < 0 ? abs(r.opening) : '0'))),
    debit: sum(ledgers.map((r) => r.debit)), credit: sum(ledgers.map((r) => r.credit)),
    closingDebit: sum(ledgers.map((r) => r.closingDebit)), closingCredit: sum(ledgers.map((r) => r.closingCredit)),
  };
  return { from: q.from ?? null, to, rows, totals, balanced: compare(totals.closingDebit, totals.closingCredit) === 0 && compare(totals.debit, totals.credit) === 0 };
}

/* ------------------------------------------------------- ledger statement */

export async function ledgerStatement(tx: Tx, q: { accountId: string; partyId?: string; from?: string; to?: string; branchId?: string }) {
  const account = await tx.maybeOne<ChartAccount>(`select * from account where id = $1`, [q.accountId]);
  if (!account) throw new NotFoundError('That ledger does not exist.');
  const to = q.to ?? (await today_(tx));
  const from = q.from ?? fyBounds(to, (await accountsSettings(tx)).fyStartMonth).start;
  // A group's statement is every ledger under it.
  const ids = (await tx.query<{ id: string }>(
    `with recursive tree as (select id from account where id = $1 union all select a.id from account a join tree t on a.parent_id = t.id)
     select id from tree`, [q.accountId])).map((r) => r.id);
  const params = [ids, from, to, q.branchId ?? null, q.partyId ?? null];
  const filter = `e.account_id = any($1::uuid[]) and ($4::uuid is null or e.branch_id = $4) and ($5::uuid is null or e.party_id = $5)`;
  const [opening, rows, metalOpening, metal] = await Promise.all([
    tx.one<{ v: Decimal }>(`select coalesce(sum(e.debit - e.credit), 0)::text as v from ledger_entry e where ${filter} and e.entry_date < $2 and $3::date is not null`, params),
    tx.query<{ id: string; entry_date: string; debit: Decimal; credit: Decimal; voucher_id: string; voucher_number: string; voucher_type: string;
      narration: string | null; party_name: string | null; account_name: string; source_type: string; source_id: string; source_number: string | null;
      branch_name: string; bank_cleared_on: string | null }>(
      `select e.id, e.entry_date::text, e.debit, e.credit, e.voucher_id, v.voucher_number, v.voucher_type, coalesce(e.narration, v.narration) as narration,
              p.name as party_name, a.name as account_name, v.source_type, v.source_id, ${SOURCE_NUMBER_SQL('v')} as source_number,
              b.name as branch_name, e.bank_cleared_on::text
         from ledger_entry e join voucher v on v.id = e.voucher_id join account a on a.id = e.account_id join branch b on b.id = e.branch_id
         left join party p on p.id = e.party_id
        where ${filter} and e.entry_date between $2 and $3
        order by e.entry_date, v.created_at, e.created_at limit 5000`, params),
    account.tracks_metal ? tx.query<{ metal: string; fine: Decimal }>(
      `select m.name as metal, sum(e.weight_in - e.weight_out)::text as fine from metal_ledger_entry e join metal m on m.id = e.metal_id
        where ${filter} and e.entry_date < $2 and $3::date is not null group by m.name`, params) : Promise.resolve([]),
    account.tracks_metal ? tx.query<{ entry_date: string; metal: string; purity: string | null; weight_in: Decimal; weight_out: Decimal;
      voucher_number: string; narration: string | null; party_name: string | null; rate_per_gram: Decimal | null }>(
      `select e.entry_date::text, m.name as metal, pu.code as purity, e.weight_in, e.weight_out, v.voucher_number,
              coalesce(e.narration, v.narration) as narration, p.name as party_name, e.rate_per_gram
         from metal_ledger_entry e join voucher v on v.id = e.voucher_id join metal m on m.id = e.metal_id
         left join purity pu on pu.id = e.purity_id left join party p on p.id = e.party_id
        where ${filter} and e.entry_date between $2 and $3 order by e.entry_date, v.created_at limit 5000`, params) : Promise.resolve([]),
  ]);
  let running = opening.v;
  const lines = rows.map((r) => {
    running = add(running, sub(r.debit, r.credit));
    return { ...r, balance: running, module: SOURCE_MODULE[r.source_type] ?? null };
  });
  const fine = new Map(metalOpening.map((m) => [m.metal, m.fine]));
  const metalLines = metal.map((m) => {
    const next = add(fine.get(m.metal) ?? '0', sub(m.weight_in, m.weight_out));
    fine.set(m.metal, next);
    return { ...m, balance: next };
  });
  return {
    account: { ...account, side: naturalSide(account.account_type) },
    from, to, opening: opening.v, closing: running,
    totalDebit: sum(rows.map((r) => r.debit)), totalCredit: sum(rows.map((r) => r.credit)),
    lines, truncated: rows.length >= 5000,
    metal: account.tracks_metal ? { opening: metalOpening, lines: metalLines, closing: [...fine].map(([metal, v]) => ({ metal, fine: v })) } : null,
  };
}

/* -------------------------------------------------------- party statement */

const PARTY_ACCOUNTS = ['1100', '2400', '2000', '1400', '1410', '2300'];

/** Everything between the shop and one customer or supplier, in rupees and in grams, as one running balance. */
export async function partyStatement(tx: Tx, q: { partyId: string; from?: string; to?: string }) {
  const party = await tx.maybeOne<{ id: string; code: string; name: string; phone: string | null; gstin: string | null;
    is_customer: boolean; is_supplier: boolean; credit_limit: Decimal | null; credit_days: number | null; city: string | null }>(
    `select id, code, name, phone, gstin, is_customer, is_supplier, credit_limit, credit_days, city from party where id = $1`, [q.partyId]);
  if (!party) throw new NotFoundError('That customer or supplier does not exist.');
  const to = q.to ?? (await today_(tx));
  const from = q.from ?? addDays(to, -365);
  const params = [q.partyId, from, to, PARTY_ACCOUNTS];
  const [opening, rows, byAccount, metal] = await Promise.all([
    tx.one<{ v: Decimal }>(
      `select coalesce(sum(e.debit - e.credit), 0)::text as v from ledger_entry e join account a on a.id = e.account_id
        where e.party_id = $1 and a.code = any($3::text[]) and e.entry_date < $2`, [q.partyId, from, PARTY_ACCOUNTS]),
    tx.query<{ entry_date: string; account_code: string; account_name: string; debit: Decimal; credit: Decimal; voucher_id: string;
      voucher_number: string; voucher_type: string; narration: string | null; source_type: string; source_id: string; source_number: string | null }>(
      `select e.entry_date::text, a.code as account_code, a.name as account_name, e.debit, e.credit, v.id as voucher_id, v.voucher_number,
              v.voucher_type, coalesce(e.narration, v.narration) as narration, v.source_type, v.source_id, ${SOURCE_NUMBER_SQL('v')} as source_number
         from ledger_entry e join account a on a.id = e.account_id join voucher v on v.id = e.voucher_id
        where e.party_id = $1 and a.code = any($4::text[]) and e.entry_date between $2 and $3
        order by e.entry_date, v.created_at limit 5000`, params),
    tx.query<{ code: string; name: string; net: Decimal }>(
      `select a.code, a.name, sum(e.debit - e.credit)::text as net from ledger_entry e join account a on a.id = e.account_id
        where e.party_id = $1 and e.entry_date <= $2 group by a.code, a.name having sum(e.debit - e.credit) <> 0 order by a.code`, [q.partyId, to]),
    tx.query<{ account_name: string; metal: string; fine: Decimal }>(
      `select a.name as account_name, m.name as metal, sum(e.weight_in - e.weight_out)::text as fine
         from metal_ledger_entry e join account a on a.id = e.account_id join metal m on m.id = e.metal_id
        where e.party_id = $1 and e.entry_date <= $2 group by a.name, m.name having sum(e.weight_in - e.weight_out) <> 0`, [q.partyId, to]),
  ]);
  let running = opening.v;
  const lines = rows.map((r) => {
    running = add(running, sub(r.debit, r.credit));
    return { ...r, balance: running, module: SOURCE_MODULE[r.source_type] ?? null };
  });
  return {
    party, from, to, opening: opening.v, closing: running,
    /** Positive: they owe the shop. Negative: the shop owes them. */
    meaning: compare(running, '0') > 0 ? 'receivable' : compare(running, '0') < 0 ? 'payable' : 'settled',
    lines, byAccount, metal,
  };
}

/* --------------------------------------------------------------- day book */

export async function dayBook(tx: Tx, q: { from?: string; to?: string; branchId?: string; voucherType?: string; search?: string;
  accountId?: string; includeReversed?: boolean; reversedOnly?: boolean; limit?: number; offset?: number }) {
  const to = q.to ?? (await today_(tx));
  const from = q.from ?? to;
  const where = ['v.voucher_date between $1 and $2']; const params: unknown[] = [from, to];
  const p = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (q.branchId) p('v.branch_id = ?', q.branchId);
  if (q.voucherType) p('v.voucher_type = ?', q.voucherType);
  if (q.accountId) p('exists (select 1 from ledger_entry x where x.voucher_id = v.id and x.account_id = ?)', q.accountId);
  if (q.search) p(`(v.voucher_number ilike ? or v.narration ilike ? or (${SOURCE_NUMBER_SQL('v')}) ilike ?)`, `%${q.search}%`);
  if (q.reversedOnly) where.push('(v.is_reversed or v.reverses_voucher_id is not null)');
  else if (!q.includeReversed) where.push('not v.is_reversed and v.reverses_voucher_id is null');
  const sql = where.join(' and ');
  const [rows, totals] = await Promise.all([
    tx.query(
      `select v.id, v.voucher_number, v.voucher_type, v.voucher_date::text, v.narration, v.source_type, v.source_id, v.is_reversed,
              v.reverses_voucher_id, rv.voucher_number as reverses_number,
              (select o.voucher_number from voucher o where o.reverses_voucher_id = v.id limit 1) as reversed_by_number,
              ${SOURCE_NUMBER_SQL('v')} as source_number, b.name as branch_name, u.full_name as created_by_name, v.created_at,
              coalesce((select sum(debit) from ledger_entry where voucher_id = v.id), 0)::text as amount,
              coalesce((select json_agg(json_build_object('account', a.name, 'code', a.code, 'party', pt.name, 'debit', e.debit, 'credit', e.credit)
                                        order by e.debit desc, e.credit)
                          from ledger_entry e join account a on a.id = e.account_id left join party pt on pt.id = e.party_id
                         where e.voucher_id = v.id), '[]') as lines
         from voucher v join branch b on b.id = v.branch_id left join app_user u on u.id = v.created_by
         left join voucher rv on rv.id = v.reverses_voucher_id
        where ${sql} order by v.voucher_date desc, v.created_at desc limit ${Number(q.limit ?? 100)} offset ${Number(q.offset ?? 0)}`, params),
    tx.one<{ n: number; amount: Decimal }>(
      `select count(*)::int as n, coalesce(sum((select sum(debit) from ledger_entry where voucher_id = v.id)), 0)::text as amount
         from voucher v where ${sql}`, params),
  ]);
  return {
    from, to, total: totals.n, amount: totals.amount,
    rows: rows.map((r: Record<string, unknown>) => ({ ...r, type_label: SOURCE_LABELS[r.voucher_type as string] ?? r.voucher_type, module: SOURCE_MODULE[r.source_type as string] ?? null })),
  };
}

export async function voucherDetail(tx: Tx, id: string) {
  const v = await tx.maybeOne<Record<string, unknown> & { source_type: string }>(
    `select v.*, v.voucher_date::text as voucher_date, ${SOURCE_NUMBER_SQL('v')} as source_number, b.name as branch_name,
            u.full_name as created_by_name, rv.voucher_number as reverses_number,
            (select o.voucher_number from voucher o where o.reverses_voucher_id = v.id limit 1) as reversed_by_number,
            (select o.id from voucher o where o.reverses_voucher_id = v.id limit 1) as reversed_by_id
       from voucher v join branch b on b.id = v.branch_id left join app_user u on u.id = v.created_by
       left join voucher rv on rv.id = v.reverses_voucher_id where v.id = $1`, [id]);
  if (!v) throw new NotFoundError('That voucher does not exist.');
  const [money, metal] = await Promise.all([
    tx.query(`select e.id, e.debit, e.credit, e.narration, a.id as account_id, a.code as account_code, a.name as account_name,
                     p.id as party_id, p.name as party_name
                from ledger_entry e join account a on a.id = e.account_id left join party p on p.id = e.party_id
               where e.voucher_id = $1 order by e.debit desc, e.credit desc`, [id]),
    tx.query(`select e.id, e.gross_weight, e.weight_in, e.weight_out, e.rate_per_gram, e.narration, a.name as account_name,
                     m.name as metal_name, pu.code as purity_code, p.name as party_name
                from metal_ledger_entry e join account a on a.id = e.account_id join metal m on m.id = e.metal_id
                left join purity pu on pu.id = e.purity_id left join party p on p.id = e.party_id where e.voucher_id = $1`, [id]),
  ]);
  return { ...v, type_label: SOURCE_LABELS[v.voucher_type as string] ?? v.voucher_type, module: SOURCE_MODULE[v.source_type] ?? null, money, metal };
}

/* ---------------------------------------------------- profit & loss, BS */

function sectionOf(chart: ChartAccount[], a: ChartAccount): 'trading' | 'indirect' {
  const byId = new Map(chart.map((c) => [c.id, c]));
  let p = a.parent_id ? byId.get(a.parent_id) : undefined;
  while (p) { if (p.is_direct) return 'trading'; p = p.parent_id ? byId.get(p.parent_id) : undefined; }
  return 'indirect';
}

async function pnlFor(tx: Tx, chart: ChartAccount[], from: string, to: string, branchId?: string) {
  const sums = await balances(tx, { from, to, branchId, excludeYearClose: true });
  const ledger = (a: ChartAccount) => {
    const b = sums.get(a.id) ?? { debit: '0', credit: '0' };
    return { id: a.id, code: a.code, name: a.name, amount: natural(a.account_type, sub(b.debit, b.credit)), parent_id: a.parent_id };
  };
  const list = chart.filter((a) => !a.is_group && (a.account_type === 'income' || a.account_type === 'expense'));
  const pick = (type: 'income' | 'expense', section: 'trading' | 'indirect') =>
    list.filter((a) => a.account_type === type && sectionOf(chart, a) === section).map(ledger).filter((r) => !isZero(r.amount));
  const tradingIncome = pick('income', 'trading'); const tradingExpense = pick('expense', 'trading');
  const otherIncome = pick('income', 'indirect'); const otherExpense = pick('expense', 'indirect');
  const t = (rows: { amount: Decimal }[]) => sum(rows.map((r) => r.amount));
  const gross = sub(t(tradingIncome), t(tradingExpense));
  const net = add(gross, sub(t(otherIncome), t(otherExpense)));
  const sales = (codes: string[]) => sum(tradingIncome.filter((r) => codes.includes(r.code)).map((r) => r.amount));
  const cogs = sum(tradingExpense.filter((r) => r.code === '5100').map((r) => r.amount));
  return {
    tradingIncome, tradingExpense, otherIncome, otherExpense,
    totals: { tradingIncome: t(tradingIncome), tradingExpense: t(tradingExpense), otherIncome: t(otherIncome), otherExpense: t(otherExpense) },
    grossProfit: gross, netProfit: net,
    /** Where the money was made: each part of the sale, against what the goods cost. */
    margin: {
      metal: sales(['4001']), making: sales(['4002']), wastage: sales(['4003']), stones: sales(['4004']), hallmarking: sales(['4005']),
      discount: sales(['4009']), combined: sales(['4000']), labour: sum(tradingIncome.filter((r) => r.code === '4100').map((r) => r.amount)),
      netSales: t(tradingIncome.filter((r) => r.code.startsWith('40'))), cogs,
      grossMarginPercent: compare(t(tradingIncome), '0') > 0 ? rs(String((Number(gross) / Number(t(tradingIncome))) * 100)) : '0',
    },
  };
}

export async function profitAndLoss(tx: Tx, q: { from?: string; to?: string; branchId?: string }) {
  const to = q.to ?? (await today_(tx));
  const from = q.from ?? monthStart(to);
  const chart = await loadChart(tx);
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const prevTo = addDays(from, -1); const prevFrom = addDays(from, -days);
  const [current, previous] = await Promise.all([pnlFor(tx, chart, from, to, q.branchId), pnlFor(tx, chart, prevFrom, prevTo, q.branchId)]);
  return { from, to, ...current, previous: { from: prevFrom, to: prevTo, grossProfit: previous.grossProfit, netProfit: previous.netProfit, totals: previous.totals } };
}

export async function balanceSheet(tx: Tx, q: { asOn?: string; branchId?: string }) {
  const asOn = q.asOn ?? (await today_(tx));
  const [chart, sums] = await Promise.all([loadChart(tx), balances(tx, { to: asOn, branchId: q.branchId })]);
  const tree = buildTree(chart, sums);
  const keep = (types: string[]) => tree.filter((r) => types.includes(r.account_type) && (!isZero(r.net) || (r.is_group && r.depth === 0)));
  const assets = keep(['asset']);
  const liabilities = keep(['liability', 'equity']);
  const tops = (rows: TreeRow[]) => sum(rows.filter((r) => r.depth === 0).map((r) => r.balance));
  // Profit not yet moved to capital by a year close.
  const pnl = sub(sum(tree.filter((r) => r.depth === 0 && r.account_type === 'income').map((r) => r.balance)),
    sum(tree.filter((r) => r.depth === 0 && r.account_type === 'expense').map((r) => r.balance)));
  const totalAssets = tops(assets);
  const totalLiabilities = add(tops(liabilities), pnl);
  return {
    asOn, assets, liabilities, profitAndLoss: pnl,
    totals: { assets: totalAssets, liabilities: totalLiabilities, difference: sub(totalAssets, totalLiabilities) },
    balanced: isZero(sub(totalAssets, totalLiabilities)),
  };
}

/* ----------------------------------------------------------------- ageing */

const BUCKETS = [30, 60, 90, 180] as const;

/** Who owes what and for how long, oldest first — payments clear the oldest bill. */
export async function ageing(tx: Tx, q: { kind: 'receivable' | 'payable'; asOn?: string; branchId?: string }) {
  const asOn = q.asOn ?? (await today_(tx));
  const code = q.kind === 'receivable' ? '1100' : '2000';
  const rows = await tx.query<{ party_id: string; name: string; code: string; phone: string | null; credit_days: number | null; entry_date: string; amount: Decimal }>(
    `select e.party_id, p.name, p.code, p.phone, p.credit_days, e.entry_date::text,
            ${q.kind === 'receivable' ? '(e.debit - e.credit)' : '(e.credit - e.debit)'}::text as amount
       from ledger_entry e join account a on a.id = e.account_id join party p on p.id = e.party_id
      where a.code = $1 and e.entry_date <= $2 and ($3::uuid is null or e.branch_id = $3)
      order by e.party_id, e.entry_date, e.created_at`, [code, asOn, q.branchId ?? null]);
  const byParty = new Map<string, typeof rows>();
  for (const r of rows) byParty.set(r.party_id, [...(byParty.get(r.party_id) ?? []), r]);
  interface AgeRow {
    partyId: string; name: string; code: string; phone: string | null; creditDays: number; total: Decimal; advance: Decimal; overdue: Decimal;
    buckets: { d0_30: Decimal; d31_60: Decimal; d61_90: Decimal; d91_180: Decimal; d180_plus: Decimal }; oldest: string | null; oldestDays: number;
  }
  const out: AgeRow[] = [];
  for (const [partyId, list] of byParty) {
    const bills: { date: string; left: Decimal }[] = [];
    let paid = '0';
    for (const r of list) {
      if (compare(r.amount, '0') > 0) bills.push({ date: r.entry_date, left: r.amount });
      else paid = add(paid, abs(r.amount));
    }
    for (const b of bills) {
      if (!(compare(paid, '0') > 0)) break;
      const take = compare(b.left, paid) < 0 ? b.left : paid;
      b.left = sub(b.left, take); paid = sub(paid, take);
    }
    const open = bills.filter((b) => compare(b.left, '0') > 0);
    const total = sub(sum(open.map((b) => b.left)), paid);
    if (isZero(total)) continue;
    const ageOf = (d: string) => Math.floor((Date.parse(asOn) - Date.parse(d)) / 86400000);
    const buckets = [0, 0, 0, 0, 0].map(() => '0');
    for (const b of open) {
      const age = ageOf(b.date);
      const i = BUCKETS.findIndex((x) => age <= x);
      buckets[i < 0 ? 4 : i] = add(buckets[i < 0 ? 4 : i]!, b.left);
    }
    const creditDays = list[0]!.credit_days ?? 0;
    const overdue = sum(open.filter((b) => ageOf(b.date) > creditDays).map((b) => b.left));
    out.push({
      partyId, name: list[0]!.name, code: list[0]!.code, phone: list[0]!.phone, creditDays,
      total, advance: compare(paid, '0') > 0 ? paid : '0', overdue,
      buckets: { d0_30: buckets[0]!, d31_60: buckets[1]!, d61_90: buckets[2]!, d91_180: buckets[3]!, d180_plus: buckets[4]! },
      oldest: open[0]?.date ?? null, oldestDays: open[0] ? ageOf(open[0].date) : 0,
    });
  }
  out.sort((a, b) => compare(b.total, a.total));
  const col = (k: keyof AgeRow['buckets']) => sum(out.map((r) => r.buckets[k]));
  return {
    kind: q.kind, asOn, rows: out,
    totals: { total: sum(out.map((r) => r.total)), overdue: sum(out.map((r) => r.overdue)),
      d0_30: col('d0_30'), d31_60: col('d31_60'), d61_90: col('d61_90'), d91_180: col('d91_180'), d180_plus: col('d180_plus') },
  };
}

/* ------------------------------------------------------------------- GST */

export async function gstSummary(tx: Tx, q: { from?: string; to?: string; branchId?: string }) {
  const to = q.to ?? (await today_(tx));
  const from = q.from ?? monthStart(to);
  const s = await accountsSettings(tx);
  const params = [from, to, q.branchId ?? null];
  const [ledgers, sales, returns, purchases, hsn, b2b] = await Promise.all([
    tx.query<{ code: string; name: string; net: Decimal }>(
      `select a.code, a.name, sum(e.credit - e.debit)::text as net
         from ledger_entry e join account a on a.id = e.account_id join voucher v on v.id = e.voucher_id
        where a.code in ('2200','2201','2202','2203','1300','1301','1302','1303','2210') and v.voucher_type <> 'gst_settlement'
          and e.entry_date between $1 and $2 and ($3::uuid is null or e.branch_id = $3)
        group by a.code, a.name order by a.code`, params),
    tx.one<Record<string, Decimal | number>>(
      `select count(*)::int as bills, coalesce(sum(taxable_amount), 0)::text as taxable, coalesce(sum(cgst_amount), 0)::text as cgst,
              coalesce(sum(sgst_amount), 0)::text as sgst, coalesce(sum(igst_amount), 0)::text as igst, coalesce(sum(total_amount), 0)::text as total
         from sales_invoice where status = 'posted' and doc_date between $1 and $2 and ($3::uuid is null or branch_id = $3)`, params),
    tx.one<Record<string, Decimal | number>>(
      `select count(*)::int as returns, coalesce(sum(taxable_amount), 0)::text as taxable, coalesce(sum(cgst_amount), 0)::text as gst,
              coalesce(sum(total_amount), 0)::text as total
         from sales_return where status = 'posted' and doc_date between $1 and $2 and ($3::uuid is null or branch_id = $3)`, params),
    tx.one<Record<string, Decimal | number>>(
      `select count(*)::int as bills, coalesce(sum(taxable_amount), 0)::text as taxable, coalesce(sum(cgst_amount), 0)::text as cgst,
              coalesce(sum(sgst_amount), 0)::text as sgst, coalesce(sum(igst_amount), 0)::text as igst, coalesce(sum(total_amount), 0)::text as total
         from purchase_invoice where status = 'posted' and supplier_invoice_date between $1 and $2 and ($3::uuid is null or branch_id = $3)`, params),
    tx.query(
      `select coalesce(l.hsn_code, '-') as hsn_code, l.gst_rate::text as gst_rate, count(*)::int as lines,
              sum(l.net_weight)::text as net_weight, sum(l.taxable_amount)::text as taxable,
              sum(l.cgst_amount)::text as cgst, sum(l.sgst_amount)::text as sgst, sum(l.igst_amount)::text as igst
         from sales_invoice_line l join sales_invoice s on s.id = l.sales_invoice_id
        where s.status = 'posted' and s.doc_date between $1 and $2 and ($3::uuid is null or s.branch_id = $3)
        group by l.hsn_code, l.gst_rate order by l.hsn_code, l.gst_rate`, params),
    tx.query<{ kind: string; bills: number; taxable: Decimal; tax: Decimal }>(
      `select case when p.gstin is not null and p.gstin <> '' then 'b2b' else 'b2c' end as kind, count(*)::int as bills,
              sum(s.taxable_amount)::text as taxable, sum(s.cgst_amount + s.sgst_amount + s.igst_amount)::text as tax
         from sales_invoice s join party p on p.id = s.customer_id
        where s.status = 'posted' and s.doc_date between $1 and $2 and ($3::uuid is null or s.branch_id = $3)
        group by 1`, params),
  ]);
  const val = (code: string) => ledgers.find((l) => l.code === code)?.net ?? '0';
  const output = { cgst: add(val('2201'), '0'), sgst: val('2202'), igst: val('2203'), combined: val('2200') };
  const input = { cgst: sub('0', val('1301')), sgst: sub('0', val('1302')), igst: sub('0', val('1303')), combined: sub('0', val('1300')) };
  const outputTotal = sum(Object.values(output)); const inputTotal = sum(Object.values(input));
  return {
    from, to, registration: s.registration, output, input, outputTotal, inputTotal, netPayable: sub(outputTotal, inputTotal),
    composition: { taxAccrued: val('2210'), rate: s.compositionRate },
    sales, returns, purchases, hsn,
    b2b: b2b.find((r) => r.kind === 'b2b') ?? { kind: 'b2b', bills: 0, taxable: '0', tax: '0' },
    b2c: b2b.find((r) => r.kind === 'b2c') ?? { kind: 'b2c', bills: 0, taxable: '0', tax: '0' },
  };
}

/* ---------------------------------------------------------- metal position */

/** Gold and silver the shop holds, is holding for others, and owes — and what is left that is truly its own. */
export async function metalPosition(tx: Tx, q: { asOn?: string; branchId?: string }) {
  const asOn = q.asOn ?? (await today_(tx));
  const s = await accountsSettings(tx);
  const [rows, girvi, rates] = await Promise.all([
    tx.query<{ metal_id: string; metal: string; code: string; account: string; fine: Decimal }>(
      `select m.id as metal_id, m.name as metal, a.code, a.name as account, sum(e.weight_in - e.weight_out)::text as fine
         from metal_ledger_entry e join account a on a.id = e.account_id join metal m on m.id = e.metal_id
        where e.entry_date <= $1 and ($2::uuid is null or e.branch_id = $2)
        group by m.id, m.name, a.code, a.name having sum(e.weight_in - e.weight_out) <> 0`, [asOn, q.branchId ?? null]),
    tx.query<{ metal_id: string; fine: Decimal }>(
      `select c.metal_id, sum(c.fine_weight)::text as fine from girvi_collateral c join girvi_loan l on l.id = c.girvi_loan_id
        where l.status in ('active', 'overdue', 'sanctioned', 'defaulted') and not c.is_released and ($1::uuid is null or l.branch_id = $1)
        group by c.metal_id`, [q.branchId ?? null]),
    tx.query<{ metal_id: string; rate: Decimal | null; fineness: Decimal }>(
      `select distinct on (r.metal_id) r.metal_id,
              (case when $2 = 'buying' then coalesce(r.buying_rate_per_gram, r.rate_per_gram) else r.rate_per_gram end)::text as rate,
              coalesce(pu.fineness_percent, 100)::text as fineness
         from metal_rate r left join purity pu on pu.id = r.purity_id
        where r.effective_from < ($1::date + 1) order by r.metal_id, coalesce(pu.fineness_percent, 100) desc, r.effective_from desc`, [asOn, s.metalRate]),
  ]);
  const metals = await tx.query<{ id: string; name: string; code: string }>(`select id, name, code from metal order by name`);
  const rateOf = new Map(rates.filter((r) => r.rate).map((r) => [r.metal_id, rs(String(Number(r.rate) * 100 / Number(r.fineness)))]));
  const out = metals.map((m) => {
    const f = (code: string) => rows.find((r) => r.metal_id === m.id && r.code === code)?.fine ?? '0';
    const stock = f('1210'); const withKarigars = f('1220');
    const supplierOwed = f('2010'); const customerOwed = f('2100'); const schemeOwed = f('2310');
    const net = sub(add(stock, withKarigars), add(supplierOwed, add(customerOwed, schemeOwed)));
    const rate = rateOf.get(m.id) ?? null;
    return {
      metalId: m.id, metal: m.name, code: m.code, ratePerGram: rate,
      stock, withKarigars, supplierOwed, customerOwed, schemeOwed, net,
      girviHeld: girvi.find((g) => g.metal_id === m.id)?.fine ?? '0',
      netValue: rate ? rs(mul(net, rate)) : null,
    };
  }).filter((m) => !isZero(m.stock) || !isZero(m.withKarigars) || !isZero(m.supplierOwed) || !isZero(m.customerOwed) || !isZero(m.schemeOwed) || !isZero(m.girviHeld));
  return { asOn, rateBasis: s.metalRate, metals: out };
}

/* -------------------------------------------------------------- forecast */

/** What should come in and go out over the next weeks, and where the cash ends up each day. */
export async function cashForecast(tx: Tx, q: { days?: number; branchId?: string }) {
  const s = await accountsSettings(tx);
  const today = await today_(tx);
  const days = q.days ?? s.forecastDays;
  const until = addDays(today, days);
  const b = q.branchId ?? null;
  const [money, debtors, girvi, schemes, orders, creditors, dues] = await Promise.all([
    moneyAccounts(tx, { branchId: q.branchId }),
    ageing(tx, { kind: 'receivable', branchId: q.branchId }),
    tx.query<{ id: string; loan_number: string; borrower_name: string; due_date: string; amount: Decimal }>(
      `select id, loan_number, borrower_name, due_date::text, outstanding_amount::text as amount from girvi_loan
        where status in ('active', 'overdue') and due_date is not null and due_date <= $1 and ($2::uuid is null or branch_id = $2)
        order by due_date`, [until, b]),
    tx.one<{ amount: Decimal; count: number; overdue: Decimal }>(
      `select coalesce(sum(i.amount_due - i.amount_paid) filter (where i.due_date >= $2), 0)::text as amount,
              count(*)::int as count,
              coalesce(sum(i.amount_due - i.amount_paid) filter (where i.due_date < $2), 0)::text as overdue
         from scheme_installment i join scheme_account a on a.id = i.scheme_account_id
        where i.status = 'due' and i.due_date <= $1 and a.status = 'active' and ($3::uuid is null or a.branch_id = $3)`, [until, today, b]),
    tx.query<{ id: string; order_number: string; customer_name: string; due_date: string; amount: Decimal }>(
      `select o.id, o.order_number, p.name as customer_name, o.expected_delivery_date::text as due_date, o.balance_amount::text as amount
         from retail_order o join party p on p.id = o.customer_id
        where o.status = 'active' and o.balance_amount > 0 and o.expected_delivery_date <= $1 and ($2::uuid is null or o.branch_id = $2)
        order by o.expected_delivery_date`, [until, b]),
    ageing(tx, { kind: 'payable', branchId: q.branchId }),
    tx.query<{ code: string; name: string; net: Decimal }>(
      `select a.code, a.name, sum(e.credit - e.debit)::text as net from ledger_entry e join account a on a.id = e.account_id
        where a.code in ('2020', '2030', '2040', '2250', '2299', '2200', '2201', '2202', '2203', '1300', '1301', '1302', '1303', '1309', '2210')
          and ($1::uuid is null or e.branch_id = $1)
        group by a.code, a.name`, [b]),
  ]);
  const due = (d: string, creditDays: number) => { const x = addDays(d, creditDays); return x < today ? today : x; };
  type Item = { date: string; direction: 'in' | 'out'; kind: string; label: string; amount: Decimal; ref?: string };
  const items: Item[] = [];
  for (const r of debtors.rows) {
    if (!r.oldest) continue;
    const date = due(r.oldest, r.creditDays);
    if (date <= until) items.push({ date, direction: 'in', kind: 'customer', label: `${r.name} owes`, amount: r.total, ref: r.partyId });
  }
  for (const g of girvi) items.push({ date: g.due_date < today ? today : g.due_date, direction: 'in', kind: 'girvi', label: `${g.loan_number} ${g.borrower_name}`, amount: g.amount, ref: g.id });
  if (compare(add(schemes.amount, schemes.overdue), '0') > 0) {
    items.push({ date: today, direction: 'in', kind: 'scheme', label: `${schemes.count} savings instalment(s) due`, amount: add(schemes.amount, schemes.overdue) });
  }
  for (const o of orders) items.push({ date: o.due_date < today ? today : o.due_date, direction: 'in', kind: 'order', label: `${o.order_number} ${o.customer_name} balance`, amount: o.amount, ref: o.id });
  for (const r of creditors.rows) {
    if (!r.oldest) continue;
    const date = due(r.oldest, r.creditDays);
    if (date <= until) items.push({ date, direction: 'out', kind: 'supplier', label: `Pay ${r.name}`, amount: r.total, ref: r.partyId });
  }
  const v = (code: string) => dues.find((d) => d.code === code)?.net ?? '0';
  const nextMonth = (day: number) => { const d = addDays(monthEnd(today), day); return d <= until ? d : null; };
  const gstNow = add(v('2299'), sub(add(v('2200'), add(v('2201'), add(v('2202'), v('2203')))),
    sub('0', add(v('1300'), add(v('1301'), add(v('1302'), add(v('1303'), v('1309'))))))));
  const gstDate = nextMonth(20);
  if (gstDate && compare(gstNow, '0') > 0) items.push({ date: gstDate, direction: 'out', kind: 'gst', label: 'GST for the month', amount: gstNow });
  if (s.registration === 'composition' && compare(v('2210'), '0') > 0) {
    const d = nextMonth(18); if (d) items.push({ date: d, direction: 'out', kind: 'gst', label: 'Composition tax', amount: v('2210') });
  }
  const tdsDate = nextMonth(7);
  if (tdsDate && compare(v('2250'), '0') > 0) items.push({ date: tdsDate, direction: 'out', kind: 'tds', label: 'TDS deducted', amount: v('2250') });
  for (const [code, label] of [['2020', 'Karigar wages owed'], ['2030', 'Salaries owed'], ['2040', 'Expenses owed']] as const) {
    if (compare(v(code), '0') > 0) items.push({ date: today, direction: 'out', kind: 'payable', label, amount: v(code) });
  }
  items.sort((a, b) => a.date.localeCompare(b.date));
  const startCash = sum(money.map((m) => m.balance));
  let running = startCash;
  const series: { date: string; balance: Decimal; in: Decimal; out: Decimal }[] = [];
  for (let d = today; d <= until; d = addDays(d, 1)) {
    const dayIn = sum(items.filter((i) => i.date === d && i.direction === 'in').map((i) => i.amount));
    const dayOut = sum(items.filter((i) => i.date === d && i.direction === 'out').map((i) => i.amount));
    running = add(running, sub(dayIn, dayOut));
    series.push({ date: d, balance: running, in: dayIn, out: dayOut });
  }
  const totalIn = sum(items.filter((i) => i.direction === 'in').map((i) => i.amount));
  const totalOut = sum(items.filter((i) => i.direction === 'out').map((i) => i.amount));
  const lowest = series.reduce((m, x) => (compare(x.balance, m.balance) < 0 ? x : m), series[0]!);
  return { today, until, days, startCash, totalIn, totalOut, endCash: running, lowest, items, series, accounts: money };
}

/* -------------------------------------------------------------- watchlist */

export async function watchlist(tx: Tx, q: { days?: number; branchId?: string }) {
  const s = await accountsSettings(tx);
  const today = await today_(tx);
  const since = addDays(today, -(q.days ?? 30));
  const b = q.branchId ?? null;
  const [backdated, discounts, cash, reversals, unclosed, pending, odd, negative] = await Promise.all([
    tx.query<{ id: string; voucher_number: string; voucher_type: string; voucher_date: string; entered: string; days: number; amount: Decimal }>(
      `select v.id, v.voucher_number, v.voucher_type, v.voucher_date::text, (v.created_at at time zone t.timezone)::date::text as entered,
              ((v.created_at at time zone t.timezone)::date - v.voucher_date)::int as days,
              coalesce((select sum(debit) from ledger_entry where voucher_id = v.id), 0)::text as amount
         from voucher v join tenant t on t.id = v.tenant_id
        where v.created_at >= $1::date and ((v.created_at at time zone t.timezone)::date - v.voucher_date) > $2
          and v.voucher_type not in ('opening', 'gst_settlement', 'year_close', 'revaluation') and v.reverses_voucher_id is null
          and ($3::uuid is null or v.branch_id = $3)
        order by days desc limit 50`, [since, s.watchBackdateDays, b]),
    tx.query<{ id: string; doc_number: string; doc_date: string; customer: string; discount: Decimal; percent: Decimal }>(
      `select s.id, s.doc_number, s.doc_date::text, p.name as customer, s.discount_amount::text as discount,
              round(s.discount_amount * 100 / nullif(s.taxable_amount + s.discount_amount, 0), 2)::text as percent
         from sales_invoice s join party p on p.id = s.customer_id
        where s.status = 'posted' and s.doc_date >= $1 and s.discount_amount > 0
          and s.discount_amount * 100 / nullif(s.taxable_amount + s.discount_amount, 0) > $2 and ($3::uuid is null or s.branch_id = $3)
        order by percent desc limit 50`, [since, s.watchDiscountPercent, b]),
    tx.query<{ party_id: string; party: string; day: string; amount: Decimal }>(
      `with cash_in as (
         select v.voucher_date as day, e.debit,
                (select x.party_id from ledger_entry x where x.voucher_id = v.id and x.party_id is not null limit 1) as party_id
           from ledger_entry e join account a on a.id = e.account_id and a.ledger_kind = 'cash' join voucher v on v.id = e.voucher_id
          where v.voucher_date >= $1 and e.debit > 0 and not v.is_reversed and v.reverses_voucher_id is null and ($3::uuid is null or e.branch_id = $3))
       select c.party_id, p.name as party, c.day::text, sum(c.debit)::text as amount
         from cash_in c join party p on p.id = c.party_id where p.code <> 'WALKIN'
        group by c.party_id, p.name, c.day having sum(c.debit) >= $2 order by c.day desc`, [since, s.watchCashLimit, b]),
    tx.query<{ id: string; voucher_number: string; voucher_type: string; voucher_date: string; narration: string | null; amount: Decimal }>(
      `select v.id, v.voucher_number, v.voucher_type, v.voucher_date::text, v.narration,
              coalesce((select sum(debit) from ledger_entry where voucher_id = v.id), 0)::text as amount
         from voucher v where v.reverses_voucher_id is not null and v.voucher_date >= $1 and ($2::uuid is null or v.branch_id = $2)
        order by v.voucher_date desc limit 50`, [since, b]),
    tx.query<{ branch: string; day: string }>(
      `select b.name as branch, e.entry_date::text as day
         from ledger_entry e join account a on a.id = e.account_id and a.ledger_kind = 'cash' join branch b on b.id = e.branch_id
        where e.entry_date >= $1 and e.entry_date < $2 and ($3::uuid is null or e.branch_id = $3)
          and exists (select 1 from cash_day)
          and not exists (select 1 from cash_day d where d.branch_id = e.branch_id and d.business_date = e.entry_date and d.status = 'closed')
        group by b.name, e.entry_date order by e.entry_date desc limit 31`, [since, today, b]),
    tx.query<{ id: string; doc_number: string; doc_date: string; amount: Decimal; narration: string | null }>(
      `select id, doc_number, doc_date::text, amount::text, narration from journal_entry where status = 'pending_approval' order by doc_date`),
    tx.query<{ code: string; name: string; net: Decimal }>(
      `select a.code, a.name, sum(e.debit - e.credit)::text as net from ledger_entry e join account a on a.id = e.account_id
        where a.code in ('1900', '3900', '1600') group by a.code, a.name having sum(e.debit - e.credit) <> 0`),
    tx.query<{ branch: string; account: string; day: string; balance: Decimal }>(
      `with daily as (
         select e.branch_id, e.account_id, e.entry_date, sum(e.debit - e.credit) as net
           from ledger_entry e join account a on a.id = e.account_id and a.ledger_kind = 'cash'
          where ($1::uuid is null or e.branch_id = $1) group by e.branch_id, e.account_id, e.entry_date),
       running as (select *, sum(net) over (partition by branch_id, account_id order by entry_date) as balance from daily)
       select b.name as branch, a.name as account, r.entry_date::text as day, r.balance::text
         from running r join branch b on b.id = r.branch_id join account a on a.id = r.account_id
        where r.balance < 0 and r.entry_date >= $2 order by r.entry_date desc limit 20`, [b, since]),
  ]);
  type Flag = { kind: string; severity: 'high' | 'medium' | 'low'; title: string; detail: string; ref?: { type: string; id: string; number?: string } };
  const flags: Flag[] = [
    ...negative.map((n): Flag => ({ kind: 'negative_cash', severity: 'high', title: `${n.account} went below zero`,
      detail: `${n.branch} on ${n.day}: ₹${Number(n.balance).toLocaleString('en-IN')}. Money was paid out that the books never received.` })),
    ...cash.map((c): Flag => ({ kind: 'cash_limit', severity: 'high', title: `₹${Number(c.amount).toLocaleString('en-IN')} cash from ${c.party} on ${c.day}`,
      detail: `At or above ₹${s.watchCashLimit.toLocaleString('en-IN')} in a day (section 269ST).`, ref: { type: 'party', id: c.party_id } })),
    ...odd.map((o): Flag => ({ kind: 'suspense', severity: 'medium', title: `${o.name} is not zero`,
      detail: `₹${Number(abs(o.net)).toLocaleString('en-IN')} is waiting in ${o.name}. ${o.code === '3900' ? 'Opening balances do not add up.' : o.code === '1600' ? 'Stock sent between branches has not been received.' : 'Find where it belongs and move it.'}` })),
    ...pending.map((p): Flag => ({ kind: 'approval', severity: 'medium', title: `${p.doc_number} waits for approval`,
      detail: `₹${Number(p.amount).toLocaleString('en-IN')} on ${p.doc_date}${p.narration ? `: ${p.narration}` : ''}`, ref: { type: 'journal', id: p.id, number: p.doc_number } })),
    ...backdated.map((v): Flag => ({ kind: 'backdated', severity: v.days > 30 ? 'high' : 'medium', title: `${v.voucher_number} dated ${v.days} days back`,
      detail: `${SOURCE_LABELS[v.voucher_type] ?? v.voucher_type} of ₹${Number(v.amount).toLocaleString('en-IN')} dated ${v.voucher_date}, entered ${v.entered}.`,
      ref: { type: 'voucher', id: v.id, number: v.voucher_number } })),
    ...discounts.map((d): Flag => ({ kind: 'discount', severity: 'medium', title: `${d.percent}% off ${d.doc_number}`,
      detail: `₹${Number(d.discount).toLocaleString('en-IN')} to ${d.customer} on ${d.doc_date}.`, ref: { type: 'sales_invoice', id: d.id, number: d.doc_number } })),
    ...unclosed.map((u): Flag => ({ kind: 'day_not_closed', severity: 'low', title: `${u.day} was not closed`, detail: `${u.branch}: cash moved but the drawer was never counted.` })),
    ...reversals.map((r): Flag => ({ kind: 'reversal', severity: 'low', title: `${r.voucher_number} undid an entry`,
      detail: `${r.voucher_date}: ₹${Number(r.amount).toLocaleString('en-IN')}. ${r.narration ?? ''}`, ref: { type: 'voucher', id: r.id, number: r.voucher_number } })),
  ];
  return {
    since, flags,
    counts: { high: flags.filter((f) => f.severity === 'high').length, medium: flags.filter((f) => f.severity === 'medium').length, low: flags.filter((f) => f.severity === 'low').length },
  };
}

/* ------------------------------------------------------------- money desk */

/**
 * The one page an owner opens: cash and bank now, today's drawer, this
 * month's profit, who owes and who is owed, GST, metal, what needs attention
 * and where cash is heading.
 */
export async function moneyDesk(tx: Tx, q: { date?: string; branchId?: string }) {
  const today = await today_(tx);
  const date = q.date ?? today;
  const from = monthStart(date);
  const chart = await loadChart(tx);
  const b = q.branchId ?? null;
  const [accounts, pnl, positions, todayFlow, trend, topExpenses, watch, forecast, metal, recent, pendingCount] = await Promise.all([
    moneyAccounts(tx, { asOn: date, branchId: q.branchId }),
    pnlFor(tx, chart, from, date, q.branchId),
    tx.query<{ code: string; net: Decimal }>(
      `select a.code, sum(e.debit - e.credit)::text as net from ledger_entry e join account a on a.id = e.account_id
        where a.code in ('1100','2400','2000','2010','1400','1410','2300','2299','2200','2201','2202','2203','1300','1301','1302','1303','1309','2210','2020','2040','2250')
          and e.entry_date <= $1 and ($2::uuid is null or e.branch_id = $2) group by a.code`, [date, b]),
    tx.query<{ voucher_type: string; cash_in: Decimal; cash_out: Decimal }>(
      `select v.voucher_type, sum(e.debit)::text as cash_in, sum(e.credit)::text as cash_out
         from ledger_entry e join account a on a.id = e.account_id and a.ledger_kind in ('cash', 'bank') join voucher v on v.id = e.voucher_id
        where e.entry_date = $1 and ($2::uuid is null or e.branch_id = $2) and v.voucher_type <> 'contra'
        group by v.voucher_type order by v.voucher_type`, [date, b]),
    tx.query<{ day: string; sales: Decimal; cash_net: Decimal }>(
      `with days as (select generate_series($1::date - 13, $1::date, '1 day')::date as day)
       select d.day::text,
              coalesce((select sum(e.credit - e.debit) from ledger_entry e join account a on a.id = e.account_id
                         where e.entry_date = d.day and a.code like '40%' and ($2::uuid is null or e.branch_id = $2)), 0)::text as sales,
              coalesce((select sum(e.debit - e.credit) from ledger_entry e join account a on a.id = e.account_id
                         where e.entry_date = d.day and a.ledger_kind in ('cash', 'bank') and ($2::uuid is null or e.branch_id = $2)), 0)::text as cash_net
         from days d order by d.day`, [date, b]),
    tx.query<{ name: string; amount: Decimal }>(
      `select a.name, sum(e.debit - e.credit)::text as amount from ledger_entry e join account a on a.id = e.account_id
         join voucher v on v.id = e.voucher_id
        where a.account_type = 'expense' and a.code not in ('5100', '5000') and v.voucher_type <> 'year_close'
          and e.entry_date between $1 and $2 and ($3::uuid is null or e.branch_id = $3)
        group by a.name having sum(e.debit - e.credit) > 0 order by sum(e.debit - e.credit) desc limit 6`, [from, date, b]),
    watchlist(tx, { days: 30, branchId: q.branchId }),
    cashForecast(tx, { branchId: q.branchId }),
    metalPosition(tx, { asOn: date, branchId: q.branchId }),
    dayBook(tx, { from: addDays(date, -6), to: date, branchId: q.branchId, limit: 8 }),
    tx.one<{ n: number }>(`select count(*)::int as n from journal_entry where status = 'pending_approval'`),
  ]);
  const v = (code: string) => positions.find((p) => p.code === code)?.net ?? '0';
  const neg = (x: Decimal) => sub('0', x);
  const gstOutput = neg(add(v('2200'), add(v('2201'), add(v('2202'), v('2203')))));
  const gstInput = add(v('1300'), add(v('1301'), add(v('1302'), add(v('1303'), v('1309')))));
  const cash = sum(accounts.filter((a) => a.ledger_kind === 'cash').map((a) => a.balance));
  const bank = sum(accounts.filter((a) => a.ledger_kind === 'bank').map((a) => a.balance));
  const day = q.branchId || tx.context.branchId
    ? await tx.query<{ status: string; account_name: string; closing_counted: Decimal | null; difference: Decimal | null }>(
      `select d.status, a.name as account_name, d.closing_counted::text, d.difference::text from cash_day d join account a on a.id = d.account_id
        where d.branch_id = $1 and d.business_date = $2`, [q.branchId ?? tx.context.branchId, date])
    : [];
  return {
    date, today, monthFrom: from,
    money: { cash, bank, total: add(cash, bank), accounts },
    today_: {
      bySource: todayFlow.map((t) => ({ ...t, label: SOURCE_LABELS[t.voucher_type] ?? t.voucher_type, net: sub(t.cash_in, t.cash_out) })),
      cashIn: sum(todayFlow.map((t) => t.cash_in)), cashOut: sum(todayFlow.map((t) => t.cash_out)),
      day,
    },
    month: {
      sales: pnl.margin.netSales, labour: pnl.margin.labour, grossProfit: pnl.grossProfit, netProfit: pnl.netProfit,
      expenses: pnl.totals.otherExpense, otherIncome: pnl.totals.otherIncome, margin: pnl.margin, topExpenses,
    },
    position: {
      receivable: v('1100'), advances: neg(v('2400')), payable: neg(v('2000')), supplierMetalValue: neg(v('2010')),
      girviOut: v('1400'), girviInterestDue: v('1410'), schemeLiability: neg(v('2300')),
      gstOutput, gstInput, gstNet: add(neg(v('2299')), sub(gstOutput, gstInput)), compositionTax: neg(v('2210')),
      karigarWages: neg(v('2020')), expensesOwed: neg(v('2040')), tds: neg(v('2250')),
    },
    metal: metal.metals,
    trend,
    attention: { ...watch.counts, top: watch.flags.slice(0, 6), pendingApprovals: pendingCount.n },
    forecast: { days: forecast.days, totalIn: forecast.totalIn, totalOut: forecast.totalOut, endCash: forecast.endCash, lowest: forecast.lowest, series: forecast.series },
    recent: recent.rows,
  };
}

/* -------------------------------------------------------- metal & karigar */

export async function metalLedger(tx: Tx, q: { accountId?: string; partyId?: string; metalId?: string; from?: string; to?: string; limit?: number; offset?: number }) {
  const clauses: string[] = []; const params: unknown[] = [];
  for (const [key, col] of [['accountId', 'm.account_id'], ['partyId', 'm.party_id'], ['metalId', 'm.metal_id']] as const) {
    if (q[key]) { params.push(q[key]); clauses.push(`${col} = $${params.length}`); }
  }
  if (q.from) { params.push(q.from); clauses.push(`m.entry_date >= $${params.length}`); }
  if (q.to) { params.push(q.to); clauses.push(`m.entry_date <= $${params.length}`); }
  const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
  const [rows, total] = await Promise.all([
    tx.query(
      `select m.*, m.entry_date::text as entry_date, a.code as account_code, a.name as account_name, p.name as party_name,
              mt.code as metal_code, mt.name as metal_name, pu.code as purity_code, v.voucher_number, v.voucher_type
         from metal_ledger_entry m join account a on a.id = m.account_id
         join metal mt on mt.id = m.metal_id join voucher v on v.id = m.voucher_id
         left join party p on p.id = m.party_id left join purity pu on pu.id = m.purity_id
        ${where} order by m.entry_date desc, m.created_at desc
        limit ${Number(q.limit ?? 50)} offset ${Number(q.offset ?? 0)}`, params),
    tx.one<{ n: number; balance: Decimal; weight_in: Decimal; weight_out: Decimal }>(
      `select count(*)::int as n, coalesce(sum(m.weight_in - m.weight_out), 0)::text as balance,
              coalesce(sum(m.weight_in), 0)::text as weight_in, coalesce(sum(m.weight_out), 0)::text as weight_out
         from metal_ledger_entry m ${where}`, params),
  ]);
  return { rows, total: total.n, balance: total.balance, weightIn: total.weight_in, weightOut: total.weight_out };
}

export async function karigarLedger(tx: Tx, q: { karigarId?: string; from?: string; to?: string; limit?: number; offset?: number }) {
  const clauses: string[] = []; const params: unknown[] = [];
  if (q.karigarId) { params.push(q.karigarId); clauses.push(`kl.karigar_id = $${params.length}`); }
  if (q.from) { params.push(q.from); clauses.push(`kl.entry_date >= $${params.length}`); }
  if (q.to) { params.push(q.to); clauses.push(`kl.entry_date <= $${params.length}`); }
  const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
  const [rows, total] = await Promise.all([
    tx.query(
      `select kl.*, k.name as karigar_name, k.standard_ghat_percent, o.order_number
         from karigar_ledger kl join karigar k on k.id = kl.karigar_id
         left join retail_order o on o.id = kl.retail_order_id
        ${where} order by kl.entry_date desc limit ${Number(q.limit ?? 50)} offset ${Number(q.offset ?? 0)}`, params),
    tx.one<{ n: number; metal: Decimal }>(
      `select count(*)::int as n, coalesce(sum(kl.weight_out - kl.weight_in), 0)::text as metal from karigar_ledger kl ${where}`, params),
  ]);
  return { rows, total: total.n, metalBalance: total.metal };
}

export const assertRange = (from?: string, to?: string) => {
  if (from && to && from > to) throw new ValidationError('The start date is after the end date.');
};
