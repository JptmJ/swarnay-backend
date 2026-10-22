/**
 * Opening balances: what is owed, either way, on the cut-over day.
 *
 * - Customer and supplier balances, in rupees (Sundry Debtors, advances, Sundry Creditors).
 * - Metal owed in grams, to or by customers and suppliers.
 * - Karigars: metal in their hands and wages owed.
 * - Every other ledger of the old trial balance: cash, bank, capital, loans, assets, expenses.
 *
 * Each posts opening vouchers dated the cut-over day, against Opening Balance
 * Difference — exactly what Accounts → Opening Balances does by hand. Once the
 * whole trial balance is in, that difference comes to nothing; if it does not,
 * Accounts shows what is left over.
 *
 * Balances are "set", not "added" (unless the operator asks otherwise): the
 * figure in the file is what the balance should be, and only the change from
 * any opening already there is posted. Importing the same file twice therefore
 * changes nothing the second time.
 */
import { z } from 'zod';
import type { Tx } from '../../../core/db/client.js';
import { compare, div, isZero, mul, round, sub, type Decimal } from '../../../core/util/decimal.js';
import { repo } from '../../../core/db/repository.js';
import type { MetalEntry, MoneyEntry } from '../../accounts/ledger.service.js';
import type { AccountRow, PartyRow, PurityRow } from '../lookups.js';
import { isPlanned } from '../lookups.js';
import { normKey, PHONE_WORDS } from '../normalize.js';
import type { CommitResult, EntityDef, FieldDef, Issue, JobContext, LookupValue, PreparedRow } from '../types.js';
import { branchField, branchFor, postingHelp, postingOptions, postOpening, reverseImportVouchers, signed } from './shared.js';

const BALANCE_MODE = z.enum(['set', 'add']).default('set');
const balanceModeHelp = {
  key: 'balanceMode', label: 'If a balance is already there',
  description: 'set: the file’s figure becomes the opening balance (only the difference is posted, so importing twice changes nothing). add: the figure is added to what is there.',
};
const WEIGHT_BASIS = z.enum(['fine', 'purity']).default('fine');
const weightBasisHelp = {
  key: 'weightBasis', label: 'Weights are',
  description: 'fine: the grams are pure metal. purity: the grams are of the purity given on the row and are turned into fine grams.',
};

/* ------------------------------------------------------------- fields */

const partyFields: FieldDef[] = [
  { key: 'code', label: 'Party code', type: 'code', synonyms: ['code', 'party code', 'ledger code', 'customer code', 'supplier code', 'account code', 'ac code'] },
  { key: 'party', label: 'Party name', type: 'lookup', lookup: 'party',
    synonyms: ['party', 'party name', 'name', 'ledger', 'ledger name', 'account', 'account name', 'particulars', 'customer', 'supplier', 'customer name', 'supplier name'], example: 'Ramesh Patel' },
  { key: 'phone', label: 'Mobile', type: 'phone', soft: true, synonyms: PHONE_WORDS },
  { key: 'party_type', label: 'Customer or supplier', type: 'enum', synonyms: ['type', 'party type', 'nature', 'debtor creditor'],
    options: [
      { value: 'customer', label: 'Customer', synonyms: ['debtor', 'debtors', 'sundry debtor', 'sundry debtors', 'receivable', 'cust', 'c', 'buyer'] },
      { value: 'supplier', label: 'Supplier', synonyms: ['creditor', 'creditors', 'sundry creditor', 'sundry creditors', 'payable', 'vendor', 's', 'seller'] },
    ] },
  { key: 'group', label: 'Group', type: 'text', synonyms: ['group', 'under', 'parent', 'account group', 'ledger group', 'group name'],
    description: 'Tally’s "Under": Sundry Debtors rows are customers, Sundry Creditors suppliers; other groups are left for the ledger import.' },
];
const moneyFields = (what: string): FieldDef[] => [
  { key: 'balance', label: 'Balance', type: 'balance', synonyms: ['balance', 'closing balance', 'opening balance', 'amount', 'outstanding', 'due', 'net balance', 'closing', 'bal'],
    description: `Dr or a plain positive figure: ${what} owes the shop. Cr or a minus figure: the shop owes ${what}.`, example: '12,500 Dr' },
  { key: 'debit', label: 'Debit', type: 'money', synonyms: ['debit', 'dr', 'dr amount', 'debit amount', 'receivable', 'dr balance', 'closing dr'] },
  { key: 'credit', label: 'Credit', type: 'money', synonyms: ['credit', 'cr', 'cr amount', 'credit amount', 'payable', 'cr balance', 'closing cr'] },
];
const metalField: FieldDef = { key: 'metal', label: 'Metal', type: 'lookup', lookup: 'metal', synonyms: ['metal', 'metal type'] };
const purityField: FieldDef = { key: 'purity', label: 'Purity', type: 'lookup', lookup: 'purity', synonyms: ['purity', 'karat', 'touch', 'tunch', 'fineness'] };

/** Debit-positive amount from a balance, or from separate debit and credit columns. */
function amountOf(v: Record<string, unknown>): Decimal {
  if (v.balance !== undefined) return v.balance as Decimal;
  return sub((v.debit as Decimal | undefined) ?? '0', (v.credit as Decimal | undefined) ?? '0');
}

/** Sundry Debtors → customer, Sundry Creditors → supplier, anything else → not a party. */
function roleFromGroup(group: unknown): 'customer' | 'supplier' | 'other' | null {
  const g = normKey(group);
  if (!g) return null;
  if (/debtor|receivable|customer/.test(g)) return 'customer';
  if (/creditor|payable|supplier|vendor/.test(g)) return 'supplier';
  return 'other';
}

/** Finds the party a balance row names, making it if allowed. */
async function partyForRow(
  tx: Tx, v: Record<string, unknown>, ctx: JobContext, role: 'customer' | 'supplier', issues: Issue[], rowNumber: number,
): Promise<{ party: PartyRow; addRole: boolean } | null> {
  const l = ctx.lookups;
  const named = v.party as LookupValue | undefined;
  const code = v.code as string | undefined;
  let hit = code ? l.party({ text: code }) : { kind: 'missing' as const };
  if (hit.kind === 'found' && hit.row.code.toUpperCase() !== code?.toUpperCase()) hit = { kind: 'missing' };
  if (hit.kind !== 'found' && named) hit = l.party(named, { role, phone: v.phone as string | undefined });
  if (hit.kind === 'found') {
    const has = role === 'customer' ? hit.row.is_customer : hit.row.is_supplier;
    if (!has) issues.push({ level: 'warning', message: `${hit.row.name} (${hit.row.code}) is not marked as a ${role} yet and will be.` });
    return { party: hit.row, addRole: !has };
  }
  const shown = named?.text ?? code ?? '';
  if (hit.kind === 'ambiguous') {
    ctx.unknown('party', shown, rowNumber);
    issues.push({ level: 'error', field: 'party', message: `"${shown}" matches ${hit.count} parties: ${hit.names.join(', ')}. Add the code or mobile, or choose in the value panel.` });
    return null;
  }
  if (!ctx.options.createMissingParties || !named) {
    ctx.unknown('party', shown, rowNumber);
    issues.push({ level: 'error', field: 'party', message: `${role === 'customer' ? 'Customer' : 'Supplier'} "${shown}" is not in the masters. Import ${role}s first, or allow missing parties to be made.` });
    return null;
  }
  const party = await l.createParty(tx, ctx, { name: named.text, phone: v.phone as string | undefined, role });
  issues.push({ level: 'warning', message: `${named.text} is not in the masters yet; a ${role} will be made.` });
  return { party, addRole: false };
}

/** Opening figures already on the books for these parties, debit-positive, by party and ledger. */
async function openingByParty(tx: Tx, partyIds: string[], codes: string[]): Promise<Map<string, Decimal>> {
  const rows = await tx.query<{ party_id: string; code: string; net: Decimal }>(
    `select e.party_id, a.code, sum(e.debit - e.credit)::text as net
       from ledger_entry e join account a on a.id = e.account_id
       join voucher v on v.id = e.voucher_id and v.voucher_type = 'opening'
      where e.party_id = any($1::uuid[]) and a.code = any($2::text[])
      group by e.party_id, a.code`, [partyIds, codes]);
  return new Map(rows.map((r) => [`${r.party_id}|${r.code}`, r.net]));
}

/* ====================================================== party balances */

interface PartyPlan { partyId: string; role: 'customer' | 'supplier'; amount: Decimal; branchId: string; addRole: boolean }

export const partyBalances: EntityDef = {
  key: 'party_balances', label: 'Customer & supplier balances', group: 'balances', order: 90, posts: true, chunk: 500,
  description: 'What each customer owes the shop (or has paid in advance), and what the shop owes each supplier, on the cut-over day. A Tally trial balance can be given as it is: rows under Sundry Debtors and Sundry Creditors are taken, the rest are left for the ledger import.',
  needs: ['party', 'branch'],
  requireOneOf: [
    { fields: ['balance', 'debit', 'credit'], message: 'Give the balance, or a debit or credit figure.' },
    { fields: ['party', 'code'], message: 'Give the party’s name or code.' },
  ],
  options: z.object({
    ...postingOptions, balanceMode: BALANCE_MODE, createMissingParties: z.boolean().default(true),
    defaultPartyType: z.enum(['customer', 'supplier']).default('customer'),
  }) as unknown as z.ZodType<Record<string, unknown>>,
  optionHelp: [...postingHelp, balanceModeHelp,
    { key: 'createMissingParties', label: 'Make missing parties', description: 'A name not in the masters becomes a new customer or supplier. Off: such rows are refused.' },
    { key: 'defaultPartyType', label: 'Rows that do not say', description: 'Whether a row with no type and no group is a customer or a supplier.' }],
  fields: [...partyFields, ...moneyFields('the party'), branchField],

  async prepare(tx, rows, ctx) {
    const out: PreparedRow<PartyPlan>[] = [];
    for (const row of rows) {
      const issues: Issue[] = [...row.issues];
      const v = row.values;
      const label = `${(v.party as LookupValue | undefined)?.text ?? v.code ?? ''}`;
      if (issues.some((i) => i.level === 'error')) { out.push({ row, action: 'insert', issues, label }); continue; }
      const fromGroup = roleFromGroup(v.group);
      if (!v.party_type && fromGroup === 'other') {
        out.push({ row, action: 'skip', label, issues: [...issues, { level: 'warning', message: `Under "${v.group}", so not a customer or supplier. Bring it in with Ledger balances.` }] });
        continue;
      }
      const role = (v.party_type as 'customer' | 'supplier' | undefined) ?? (fromGroup as 'customer' | 'supplier' | null) ?? (ctx.options.defaultPartyType as 'customer' | 'supplier');
      const amount = round(amountOf(v), 2);
      if (isZero(amount)) { out.push({ row, action: 'skip', label, issues: [...issues, { level: 'warning', message: 'Nothing owed either way; nothing to bring over.' }] }); continue; }
      const branch = branchFor(v, ctx, issues, row.rowNumber);
      const found = await partyForRow(tx, v, ctx, role, issues, row.rowNumber);
      if (!found || !branch) { out.push({ row, action: 'insert', issues, label }); continue; }
      const key = `bal:${found.party.id}|${role}`;
      const first = ctx.seen.get(key);
      if (first !== undefined && first !== row.rowNumber) {
        issues.push({ level: 'error', message: `${found.party.name} already has a balance on row ${first}. Put them together into one row.` });
      } else ctx.seen.set(key, row.rowNumber);
      if (!issues.some((i) => i.level === 'error')) {
        if (compare(amount, '0') > 0) ctx.total('debit', amount); else ctx.total('credit', sub('0', amount));
      }
      out.push({ row, action: 'insert', issues, label: `${found.party.name} · ${fmt(amount)}`,
        plan: { partyId: found.party.id, role, amount, branchId: branch.id, addRole: found.addRole } });
    }
    return out;
  },

  async commit(tx, rows, ctx) {
    const plans = rows.map((r) => r.plan as PartyPlan);
    for (const p of plans) {
      if (p.addRole) await ctx.lookups.addRole(tx, ctx, ctx.lookups.parties.find((x) => x.id === p.partyId)!, p.role);
    }
    const have = ctx.options.balanceMode === 'set'
      ? await openingByParty(tx, plans.map((p) => p.partyId), ['1100', '2400', '2000'])
      : new Map<string, Decimal>();
    const byBranch = new Map<string, MoneyEntry[]>();
    const narration = `Opening balance — ${ctx.title}`;
    for (const p of plans) {
      const want: Array<[string, Decimal]> = p.role === 'customer'
        // Owed by the customer sits in Sundry Debtors; paid ahead sits in Advances, as a credit.
        ? [['1100', compare(p.amount, '0') > 0 ? p.amount : '0'], ['2400', compare(p.amount, '0') < 0 ? p.amount : '0']]
        : [['2000', p.amount]];
      const lines = byBranch.get(p.branchId) ?? [];
      for (const [code, value] of want) {
        const delta = sub(value, have.get(`${p.partyId}|${code}`) ?? '0');
        if (!isZero(delta)) lines.push(signed(code, delta, narration, p.partyId));
      }
      byBranch.set(p.branchId, lines);
    }
    for (const [branchId, money] of byBranch) await postOpening(tx, ctx, { branchId, narration, money });
    return rows.map((r, i): CommitResult => ({ rowId: r.row.id, ok: true, action: 'insert', targetTable: 'party', targetId: plans[i]!.partyId }));
  },

  async undo(tx, rows, { batchId, reason }) {
    await reverseImportVouchers(tx, batchId, reason);
    return { undone: rows.map((r) => r.id), kept: [] };
  },
};

/* ====================================================== metal balances */

interface MetalPlan { partyId: string; role: 'customer' | 'supplier'; metalId: string; purityId: string | null; gross: Decimal; fine: Decimal; branchId: string; addRole: boolean }

/** The metal and purity a row is in, and its weight turned into fine grams when the weights are of a purity. */
function metalOf(v: Record<string, unknown>, ctx: JobContext, issues: Issue[], rowNumber: number): { metalId: string; purity: PurityRow | null } | null {
  const l = ctx.lookups;
  let metalId: string | undefined;
  if (v.metal) {
    const m = l.metal(v.metal as LookupValue);
    if (m.kind !== 'found') { ctx.unknown('metal', (v.metal as LookupValue).text, rowNumber); issues.push({ level: 'error', field: 'metal', message: `Metal "${(v.metal as LookupValue).text}" is not one this shop deals in.` }); return null; }
    metalId = m.row.id;
  }
  let purity: PurityRow | null = null;
  if (v.purity) {
    const p = l.purity(v.purity as LookupValue, metalId);
    if (p.kind !== 'found') { ctx.unknown('purity', (v.purity as LookupValue).text, rowNumber); issues.push({ level: 'error', field: 'purity', message: `Purity "${(v.purity as LookupValue).text}" is not set up.` }); return null; }
    purity = p.row;
    metalId ??= p.row.metal_id;
  }
  metalId ??= l.metals.find((m) => m.code === 'GOLD')?.id;
  if (!metalId) { issues.push({ level: 'error', field: 'metal', message: 'Say which metal.' }); return null; }
  if (ctx.options.weightBasis === 'purity' && !purity) {
    issues.push({ level: 'error', field: 'purity', message: 'Weights are of a purity (see the options), so each row needs its purity.' });
    return null;
  }
  return { metalId, purity };
}

const toFine = (ctx: JobContext, weight: Decimal, purity: PurityRow | null): Decimal =>
  ctx.options.weightBasis === 'purity' && purity ? round(div(mul(weight, purity.fineness), '100'), 3) : weight;

export const metalBalances: EntityDef = {
  key: 'metal_balances', label: 'Metal balances (grams)', group: 'balances', order: 100, posts: true, chunk: 500,
  description: 'Gold and silver owed in grams on the cut-over day: fine metal owed to bullion suppliers, and metal customers have left with the shop or owe it.',
  needs: ['party', 'metal', 'purity', 'branch'],
  requireOneOf: [
    { fields: ['weight', 'they_owe', 'we_owe'], message: 'Give the weight, or what they owe or the shop owes.' },
    { fields: ['party', 'code'], message: 'Give the party’s name or code.' },
  ],
  options: z.object({
    ...postingOptions, balanceMode: BALANCE_MODE, weightBasis: WEIGHT_BASIS, createMissingParties: z.boolean().default(true),
    defaultPartyType: z.enum(['customer', 'supplier']).default('supplier'),
  }) as unknown as z.ZodType<Record<string, unknown>>,
  optionHelp: [...postingHelp, balanceModeHelp, weightBasisHelp,
    { key: 'createMissingParties', label: 'Make missing parties', description: 'A name not in the masters becomes a new customer or supplier.' },
    { key: 'defaultPartyType', label: 'Rows that do not say', description: 'Whether a row with no type and no group is a customer or a supplier.' }],
  fields: [
    ...partyFields, metalField, purityField,
    { key: 'weight', label: 'Balance (grams)', type: 'balance', synonyms: ['weight', 'balance', 'fine', 'fine weight', 'fine balance', 'metal balance', 'grams', 'closing weight', 'net weight'],
      description: 'Dr or plain: they owe the shop metal. Cr or minus: the shop owes them metal.', example: '125.500 Cr' },
    { key: 'they_owe', label: 'They owe (g)', type: 'weight', synonyms: ['dr weight', 'receivable weight', 'they owe', 'metal receivable', 'debit weight'] },
    { key: 'we_owe', label: 'Shop owes (g)', type: 'weight', synonyms: ['cr weight', 'payable weight', 'we owe', 'metal payable', 'credit weight'] },
    branchField,
  ],

  async prepare(tx, rows, ctx) {
    const out: PreparedRow<MetalPlan>[] = [];
    for (const row of rows) {
      const issues: Issue[] = [...row.issues];
      const v = row.values;
      const label = `${(v.party as LookupValue | undefined)?.text ?? v.code ?? ''}`;
      if (issues.some((i) => i.level === 'error')) { out.push({ row, action: 'insert', issues, label }); continue; }
      const fromGroup = roleFromGroup(v.group);
      if (!v.party_type && fromGroup === 'other') {
        out.push({ row, action: 'skip', label, issues: [...issues, { level: 'warning', message: `Under "${v.group}", so not a customer or supplier.` }] });
        continue;
      }
      const role = (v.party_type as 'customer' | 'supplier' | undefined) ?? (fromGroup as 'customer' | 'supplier' | null) ?? (ctx.options.defaultPartyType as 'customer' | 'supplier');
      // Debit-positive grams: they owe the shop.
      const raw = v.weight !== undefined
        ? round(v.weight as Decimal, 3)
        : sub((v.they_owe as Decimal | undefined) ?? '0', (v.we_owe as Decimal | undefined) ?? '0');
      if (isZero(raw)) { out.push({ row, action: 'skip', label, issues: [...issues, { level: 'warning', message: 'No metal owed either way.' }] }); continue; }
      const metal = metalOf(v, ctx, issues, row.rowNumber);
      const branch = branchFor(v, ctx, issues, row.rowNumber);
      const found = await partyForRow(tx, v, ctx, role, issues, row.rowNumber);
      if (!metal || !found || !branch) { out.push({ row, action: 'insert', issues, label }); continue; }
      const fine = toFine(ctx, raw, metal.purity);
      const key = `metal:${found.party.id}|${metal.metalId}|${metal.purity?.id ?? ''}`;
      const first = ctx.seen.get(key);
      if (first !== undefined && first !== row.rowNumber) issues.push({ level: 'error', message: `${found.party.name} already has this metal on row ${first}.` });
      else ctx.seen.set(key, row.rowNumber);
      if (!issues.some((i) => i.level === 'error')) ctx.total(compare(fine, '0') > 0 ? 'they_owe_fine' : 'shop_owes_fine', compare(fine, '0') > 0 ? fine : sub('0', fine));
      out.push({ row, action: 'insert', issues, label: `${found.party.name} · ${fine} g fine`,
        plan: { partyId: found.party.id, role, metalId: metal.metalId, purityId: ctx.options.weightBasis === 'purity' ? metal.purity?.id ?? null : null,
          gross: raw, fine, branchId: branch.id, addRole: found.addRole } });
    }
    return out;
  },

  async commit(tx, rows, ctx) {
    const plans = rows.map((r) => r.plan as MetalPlan);
    for (const p of plans) {
      if (p.addRole) await ctx.lookups.addRole(tx, ctx, ctx.lookups.parties.find((x) => x.id === p.partyId)!, p.role);
    }
    const have = new Map<string, Decimal>();
    if (ctx.options.balanceMode === 'set') {
      const rowsHave = await tx.query<{ party_id: string; code: string; metal_id: string; purity_id: string | null; net: Decimal }>(
        `select e.party_id, a.code, e.metal_id, e.purity_id, sum(e.weight_in - e.weight_out)::text as net
           from metal_ledger_entry e join account a on a.id = e.account_id
           join voucher v on v.id = e.voucher_id and v.voucher_type = 'opening'
          where e.party_id = any($1::uuid[]) and a.code in ('2010', '2100')
          group by e.party_id, a.code, e.metal_id, e.purity_id`, [plans.map((p) => p.partyId)]);
      for (const r of rowsHave) have.set(`${r.party_id}|${r.code}|${r.metal_id}|${r.purity_id ?? ''}`, r.net);
    }
    const byBranch = new Map<string, MetalEntry[]>();
    const narration = `Opening metal balance — ${ctx.title}`;
    for (const p of plans) {
      const code = p.role === 'supplier' ? '2010' : '2100';
      // On these liability ledgers, grams in = owed by the shop. The plan is "they owe" positive, so it flips.
      const want = sub('0', p.fine);
      const delta = sub(want, have.get(`${p.partyId}|${code}|${p.metalId}|${p.purityId ?? ''}`) ?? '0');
      if (isZero(delta)) continue;
      const list = byBranch.get(p.branchId) ?? [];
      list.push({ accountCode: code, partyId: p.partyId, metalId: p.metalId, purityId: p.purityId, narration,
        grossWeight: p.purityId ? (compare(p.gross, '0') < 0 ? sub('0', p.gross) : p.gross) : undefined,
        ...(compare(delta, '0') > 0 ? { weightIn: delta } : { weightOut: sub('0', delta) }) });
      byBranch.set(p.branchId, list);
    }
    for (const [branchId, metal] of byBranch) await postOpening(tx, ctx, { branchId, narration, metal });
    return rows.map((r, i): CommitResult => ({ rowId: r.row.id, ok: true, action: 'insert', targetTable: 'party', targetId: plans[i]!.partyId }));
  },

  async undo(tx, rows, { batchId, reason }) {
    await reverseImportVouchers(tx, batchId, reason);
    return { undone: rows.map((r) => r.id), kept: [] };
  },
};

/* ===================================================== karigar balances */

interface KarigarPlan {
  karigarId: string; branchId: string; metalId: string | null; purityId: string | null;
  withKarigar: Decimal; owedToKarigar: Decimal; gross: Decimal; value: Decimal; wagesOwed: Decimal; advance: Decimal;
}

/** Keeps the karigar master's running balances in step with their ledger, as the karigar screens do. */
async function refreshKarigars(tx: Tx, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await tx.query(
    `update karigar k
        set metal_balance_fine = b.metal, wage_balance = b.wage, updated_at = now()
       from (select karigar_id, coalesce(sum(weight_out - weight_in), 0) as metal, coalesce(sum(amount_credit - amount_debit), 0) as wage
               from karigar_ledger where karigar_id = any($1::uuid[]) group by karigar_id) b
      where k.id = b.karigar_id`, [ids]);
}

export const karigarBalances: EntityDef = {
  key: 'karigar_balances', label: 'Karigar balances', group: 'balances', order: 110, posts: true, chunk: 300,
  description: 'Metal sitting with each karigar on the cut-over day, and wages owed to them (or paid ahead).',
  needs: ['karigar', 'metal', 'purity', 'branch'],
  requireOneOf: [{ fields: ['metal_with_karigar', 'metal_owed_to_karigar', 'wages_owed', 'wage_advance'], message: 'Give the metal with them, or the wages owed.' }],
  options: z.object({ ...postingOptions, weightBasis: WEIGHT_BASIS, createMissingKarigars: z.boolean().default(true) }) as unknown as z.ZodType<Record<string, unknown>>,
  optionHelp: [...postingHelp, weightBasisHelp,
    { key: 'createMissingKarigars', label: 'Make missing karigars', description: 'A karigar not in the masters is created.' }],
  fields: [
    { key: 'karigar', label: 'Karigar', type: 'lookup', lookup: 'karigar', required: true, synonyms: ['karigar', 'kariger', 'karigar name', 'name', 'worker', 'goldsmith', 'code'], example: 'Shyam Soni' },
    { key: 'phone', label: 'Mobile', type: 'phone', soft: true, synonyms: PHONE_WORDS },
    metalField, purityField,
    { key: 'metal_with_karigar', label: 'Metal with karigar (g)', type: 'weight', synonyms: ['metal with karigar', 'metal balance', 'issued balance', 'balance weight', 'fine balance', 'metal due'] },
    { key: 'metal_owed_to_karigar', label: 'Metal owed to karigar (g)', type: 'weight', synonyms: ['metal owed', 'excess received', 'metal payable'] },
    { key: 'metal_value', label: 'Value of that metal', type: 'money', synonyms: ['metal value', 'value', 'cost'] },
    { key: 'wages_owed', label: 'Wages owed', type: 'money', synonyms: ['wages', 'wages owed', 'labour due', 'majuri due', 'labour payable', 'amount due', 'balance amount'] },
    { key: 'wage_advance', label: 'Wages paid ahead', type: 'money', synonyms: ['advance', 'wage advance', 'labour advance'] },
    branchField,
  ],

  async prepare(tx, rows, ctx) {
    const out: PreparedRow<KarigarPlan>[] = [];
    const l = ctx.lookups;
    for (const row of rows) {
      const issues: Issue[] = [...row.issues];
      const v = row.values;
      const named = v.karigar as LookupValue | undefined;
      const label = named?.text ?? '';
      if (issues.some((i) => i.level === 'error')) { out.push({ row, action: 'insert', issues, label }); continue; }
      const withK = (v.metal_with_karigar as Decimal | undefined) ?? '0';
      const owedK = (v.metal_owed_to_karigar as Decimal | undefined) ?? '0';
      const wages = (v.wages_owed as Decimal | undefined) ?? '0';
      const advance = (v.wage_advance as Decimal | undefined) ?? '0';
      if (!isZero(withK) && !isZero(owedK)) issues.push({ level: 'error', message: 'Give metal with the karigar or metal owed to them, not both — net them off.' });
      if (!isZero(wages) && !isZero(advance)) issues.push({ level: 'error', message: 'Give wages owed or wages paid ahead, not both — net them off.' });
      const hasMetal = !isZero(withK) || !isZero(owedK);
      const metal = hasMetal ? metalOf(v, ctx, issues, row.rowNumber) : null;
      const branch = branchFor(v, ctx, issues, row.rowNumber);
      let karigarId: string | null = null;
      if (named) {
        const hit = l.karigar(named, v.phone as string | undefined);
        if (hit.kind === 'found') karigarId = hit.row.id;
        else if (hit.kind === 'ambiguous') { ctx.unknown('karigar', named.text, row.rowNumber); issues.push({ level: 'error', field: 'karigar', message: `"${named.text}" matches ${hit.count} karigars.` }); }
        else if (ctx.options.createMissingKarigars) {
          karigarId = (await l.createKarigar(tx, ctx, { name: named.text, phone: v.phone as string | undefined })).id;
          issues.push({ level: 'warning', message: `${named.text} is not in the masters yet; a karigar will be made.` });
        } else { ctx.unknown('karigar', named.text, row.rowNumber); issues.push({ level: 'error', field: 'karigar', message: `Karigar "${named.text}" is not in the masters.` }); }
      }
      if (!karigarId || !branch || (hasMetal && !metal) || issues.some((i) => i.level === 'error')) { out.push({ row, action: 'insert', issues, label }); continue; }
      const key = `karigar:${karigarId}|${metal?.metalId ?? ''}`;
      const first = ctx.seen.get(key);
      if (first !== undefined && first !== row.rowNumber) issues.push({ level: 'error', message: `This karigar is also on row ${first}.` });
      else ctx.seen.set(key, row.rowNumber);
      const existing = isPlanned(karigarId) ? null : await tx.maybeOne<{ n: number }>(`select count(*)::int as n from karigar_ledger where karigar_id = $1`, [karigarId]);
      if (existing && existing.n > 0) issues.push({ level: 'warning', message: 'This karigar already has entries; the figures here are added to them.' });
      const fineWith = metal ? toFine(ctx, withK, metal.purity) : '0';
      const fineOwed = metal ? toFine(ctx, owedK, metal.purity) : '0';
      if (!issues.some((i) => i.level === 'error')) {
        ctx.total('metal_with_karigars_fine', fineWith); ctx.total('wages_owed', wages);
      }
      out.push({ row, action: 'insert', issues, label: `${named?.text}${hasMetal ? ` · ${fineWith || fineOwed} g` : ''}`,
        plan: { karigarId, branchId: branch.id, metalId: metal?.metalId ?? null, purityId: ctx.options.weightBasis === 'purity' ? metal?.purity?.id ?? null : null,
          withKarigar: fineWith, owedToKarigar: fineOwed, gross: !isZero(withK) ? withK : owedK,
          value: (v.metal_value as Decimal | undefined) ?? '0', wagesOwed: wages, advance } });
    }
    return out;
  },

  async commit(tx, rows, ctx) {
    const plans = rows.map((r) => r.plan as KarigarPlan);
    const narration = `Opening karigar balance — ${ctx.title}`;
    const byBranch = new Map<string, { money: MoneyEntry[]; metal: MetalEntry[]; ledger: Record<string, unknown>[] }>();
    for (const p of plans) {
      const b = byBranch.get(p.branchId) ?? { money: [], metal: [], ledger: [] };
      if (p.metalId && (!isZero(p.withKarigar) || !isZero(p.owedToKarigar))) {
        b.metal.push({ accountCode: '1220', metalId: p.metalId, purityId: p.purityId, grossWeight: p.gross, narration,
          ...(!isZero(p.withKarigar) ? { weightIn: p.withKarigar } : { weightOut: p.owedToKarigar }) });
      }
      if (!isZero(p.value)) b.money.push(signed('1220', isZero(p.owedToKarigar) ? p.value : sub('0', p.value), narration));
      if (!isZero(p.wagesOwed)) b.money.push(signed('2020', sub('0', p.wagesOwed), narration));
      if (!isZero(p.advance)) b.money.push(signed('2020', p.advance, narration));
      b.ledger.push({
        karigar_id: p.karigarId, entry_type: 'adjustment', entry_date: ctx.asOf, branch_id: p.branchId,
        metal_id: p.metalId, purity_id: p.purityId, gross_weight: p.gross,
        // The karigar ledger counts from the karigar's side: metal out to them, wages owed to them.
        weight_out: p.withKarigar, weight_in: p.owedToKarigar, amount_credit: p.wagesOwed, amount_debit: p.advance,
        narration: 'Opening balance (data import)',
      });
      byBranch.set(p.branchId, b);
    }
    for (const [branchId, b] of byBranch) {
      const voucherId = await postOpening(tx, ctx, { branchId, narration, money: b.money, metal: b.metal });
      await repo(tx, 'karigar_ledger').insertMany(b.ledger.map((e) => ({ ...e, voucher_id: voucherId })));
    }
    await refreshKarigars(tx, [...new Set(plans.map((p) => p.karigarId))]);
    return rows.map((r, i): CommitResult => ({ rowId: r.row.id, ok: true, action: 'insert', targetTable: 'karigar', targetId: plans[i]!.karigarId }));
  },

  async undo(tx, rows, { batchId, reason }) {
    const vouchers = (await tx.query<{ id: string }>(`select id from voucher where source_type = 'data_import' and source_id = $1`, [batchId])).map((v) => v.id);
    const entries = await tx.query<Record<string, unknown> & { karigar_id: string }>(
      `select karigar_id, branch_id, metal_id, purity_id, gross_weight, weight_in, weight_out, amount_debit, amount_credit
         from karigar_ledger where voucher_id = any($1::uuid[]) and entry_type = 'adjustment'`, [vouchers]);
    const today = await tx.one<{ d: string }>(`select (now() at time zone timezone)::date::text as d from tenant where id = $1`, [tx.context.tenantId]);
    // The karigar ledger is never edited: mirror entries take the opening back out.
    await repo(tx, 'karigar_ledger').insertMany(entries.map((e) => ({
      karigar_id: e.karigar_id, entry_type: 'adjustment', entry_date: today.d, branch_id: e.branch_id, metal_id: e.metal_id, purity_id: e.purity_id,
      gross_weight: e.gross_weight, weight_in: e.weight_out, weight_out: e.weight_in, amount_debit: e.amount_credit, amount_credit: e.amount_debit,
      narration: `Opening balance taken back: ${reason}`,
    })));
    await reverseImportVouchers(tx, batchId, reason);
    await refreshKarigars(tx, [...new Set(entries.map((e) => e.karigar_id))]);
    return { undone: rows.map((r) => r.id), kept: [] };
  },
};

/* ===================================================== ledger balances */

/** Ledgers other imports fill. Typing a figure into them here would count it twice. */
const FILLED_ELSEWHERE: Record<string, string> = {
  '1100': 'Sundry Debtors are opened customer by customer — use Customer & supplier balances.',
  '2400': 'Customer advances are opened customer by customer — use Customer & supplier balances.',
  '2000': 'Sundry Creditors are opened supplier by supplier — use Customer & supplier balances.',
  '2010': 'Metal owed to suppliers is opened supplier by supplier — use Metal balances.',
  '2100': 'Metal owed to customers is opened customer by customer — use Metal balances.',
  '1200': 'Stock is opened piece by piece and lot by lot — use the opening stock imports.',
  '1210': 'Metal stock is opened with the stock itself — use the opening stock imports.',
  '1220': 'Metal with karigars is opened karigar by karigar — use Karigar balances.',
  '2020': 'Karigar wages are opened karigar by karigar — use Karigar balances.',
  '2300': 'Scheme deposits are opened member by member — use Scheme members.',
  '2310': 'Scheme gold is opened member by member — use Scheme members.',
  '1400': 'Girvi loans are opened loan by loan — use Girvi loans.',
  '1410': 'Girvi interest due is opened loan by loan — use Girvi loans.',
  '3900': 'Opening Balance Difference fills itself.',
  '3100': 'Retained earnings are worked out by the year close.',
};

interface LedgerPlan { accountId: string; amount: Decimal; branchId: string }

export const ledgerBalances: EntityDef = {
  key: 'ledger_balances', label: 'Ledger balances (trial balance)', group: 'balances', order: 120, posts: true, chunk: 500,
  description: 'The rest of the old trial balance: cash, bank, capital, loans, fixed assets, deposits, taxes. Ledgers are matched by name (Tally names included); ones the chart does not have are made under the group the file names. Rows the other imports cover are passed over with a note, so a whole Tally trial balance can be given as it is.',
  needs: ['account', 'branch'],
  requireOneOf: [
    { fields: ['balance', 'debit', 'credit'], message: 'Give the balance, or a debit or credit figure.' },
    { fields: ['account', 'code'], message: 'Give the ledger’s name or code.' },
  ],
  options: z.object({ ...postingOptions, balanceMode: BALANCE_MODE, createMissingLedgers: z.boolean().default(true) }) as unknown as z.ZodType<Record<string, unknown>>,
  optionHelp: [...postingHelp, balanceModeHelp,
    { key: 'createMissingLedgers', label: 'Make missing ledgers', description: 'A ledger the chart does not have is created under the group the row names (Tally’s "Under"). Off: such rows are refused.' }],
  fields: [
    { key: 'code', label: 'Ledger code', type: 'code', synonyms: ['code', 'ledger code', 'account code', 'ac code'] },
    { key: 'account', label: 'Ledger name', type: 'lookup', lookup: 'account',
      synonyms: ['ledger', 'ledger name', 'account', 'account name', 'particulars', 'head', 'account head', 'name'], example: 'Cash in Hand' },
    { key: 'group', label: 'Group', type: 'text', synonyms: ['group', 'under', 'parent', 'account group', 'ledger group', 'primary group'], example: 'Cash-in-Hand' },
    ...moneyFields('the ledger'),
    branchField,
  ],

  async prepare(tx, rows, ctx) {
    const out: PreparedRow<LedgerPlan>[] = [];
    const l = ctx.lookups;
    for (const row of rows) {
      const issues: Issue[] = [...row.issues];
      const v = row.values;
      const named = (v.account as LookupValue | undefined) ?? (v.code ? { text: v.code as string } : undefined);
      const label = named?.text ?? '';
      if (issues.some((i) => i.level === 'error') || !named) { out.push({ row, action: 'insert', issues, label }); continue; }
      const amount = round(amountOf(v), 2);
      const groupRole = roleFromGroup(v.group);
      if (groupRole === 'customer' || groupRole === 'supplier') {
        out.push({ row, action: 'skip', label, issues: [...issues, { level: 'warning', message: `Under "${v.group}": a ${groupRole}. Bring it in with Customer & supplier balances.` }] });
        continue;
      }
      if (isZero(amount)) { out.push({ row, action: 'skip', label, issues: [...issues, { level: 'warning', message: 'Nil balance; nothing to bring over.' }] }); continue; }
      let account: AccountRow | null = null;
      const byCode = v.code ? l.account({ text: v.code as string }) : { kind: 'missing' as const };
      const hit = byCode.kind === 'found' ? byCode : l.account(named);
      if (hit.kind === 'found') account = hit.row;
      else if (hit.kind === 'ambiguous') {
        ctx.unknown('account', named.text, row.rowNumber);
        issues.push({ level: 'error', field: 'account', message: `"${named.text}" matches ${hit.count} ledgers: ${hit.names.join(', ')}. Choose one in the value panel.` });
      } else if (ctx.options.createMissingLedgers && v.group) {
        const group = l.group(String(v.group));
        if (group) {
          account = await l.createLedger(tx, ctx, named.text, group);
          issues.push({ level: 'warning', message: `No ledger called ${named.text}; one will be made under ${group.name}.` });
        } else {
          ctx.unknown('account', named.text, row.rowNumber);
          issues.push({ level: 'error', field: 'group', message: `Group "${v.group}" is not one of the chart’s groups. Match the ledger in the value panel.` });
        }
      } else {
        ctx.unknown('account', named.text, row.rowNumber);
        issues.push({ level: 'error', field: 'account', message: `No ledger called "${named.text}". Give its group (Tally’s "Under") so it can be made, or match it in the value panel.` });
      }
      const branch = branchFor(v, ctx, issues, row.rowNumber);
      if (!account || !branch) { out.push({ row, action: 'insert', issues, label }); continue; }
      if (FILLED_ELSEWHERE[account.code]) {
        out.push({ row, action: 'skip', label, issues: [...issues, { level: 'warning', message: FILLED_ELSEWHERE[account.code]! }] });
        continue;
      }
      if (account.is_group) { issues.push({ level: 'error', field: 'account', message: `${account.name} is a group. Give the ledgers under it instead.` }); out.push({ row, action: 'insert', issues, label }); continue; }
      if (account.is_control) {
        out.push({ row, action: 'skip', label, issues: [...issues, { level: 'warning', message: `${account.name} is opened party by party, through the party imports.` }] });
        continue;
      }
      const key = `ledger:${account.id}|${branch.id}`;
      const first = ctx.seen.get(key);
      if (first !== undefined && first !== row.rowNumber) issues.push({ level: 'error', message: `${account.name} is also on row ${first}. Add the two together.` });
      else ctx.seen.set(key, row.rowNumber);
      if (!issues.some((i) => i.level === 'error')) {
        if (compare(amount, '0') > 0) ctx.total('debit', amount); else ctx.total('credit', sub('0', amount));
      }
      out.push({ row, action: 'insert', issues, label: `${account.name} · ${fmt(amount)}`, plan: { accountId: account.id, amount, branchId: branch.id } });
    }
    return out;
  },

  async commit(tx, rows, ctx) {
    const plans = rows.map((r) => r.plan as LedgerPlan);
    const have = new Map<string, Decimal>();
    if (ctx.options.balanceMode === 'set') {
      const existing = await tx.query<{ account_id: string; branch_id: string; net: Decimal }>(
        `select e.account_id, e.branch_id, sum(e.debit - e.credit)::text as net
           from ledger_entry e join voucher v on v.id = e.voucher_id and v.voucher_type = 'opening'
          where e.account_id = any($1::uuid[]) group by e.account_id, e.branch_id`, [plans.map((p) => p.accountId)]);
      for (const r of existing) have.set(`${r.account_id}|${r.branch_id}`, r.net);
    }
    const narration = `Opening balance — ${ctx.title}`;
    const byBranch = new Map<string, MoneyEntry[]>();
    for (const p of plans) {
      const delta = sub(p.amount, have.get(`${p.accountId}|${p.branchId}`) ?? '0');
      if (isZero(delta)) continue;
      const line = signed('', delta, narration);
      delete line.accountCode;
      byBranch.set(p.branchId, [...(byBranch.get(p.branchId) ?? []), { ...line, accountId: p.accountId }]);
    }
    for (const [branchId, money] of byBranch) await postOpening(tx, ctx, { branchId, narration, money });
    return rows.map((r, i): CommitResult => ({ rowId: r.row.id, ok: true, action: 'insert', targetTable: 'account', targetId: plans[i]!.accountId }));
  },

  async undo(tx, rows, { batchId, reason }) {
    await reverseImportVouchers(tx, batchId, reason);
    return { undone: rows.map((r) => r.id), kept: [] };
  },
};

const fmt = (amount: Decimal) =>
  `₹${Number(compare(amount, '0') < 0 ? sub('0', amount) : amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })} ${compare(amount, '0') < 0 ? 'Cr' : 'Dr'}`;
