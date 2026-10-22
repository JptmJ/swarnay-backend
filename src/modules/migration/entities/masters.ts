/**
 * Masters: categories, items, customers, suppliers, karigars and savings plans.
 *
 * All six work the same way, so they share one engine. A row is matched to a
 * record the shop already has — by code, then by what identifies that kind of
 * record (a GSTIN, a phone together with the name, a name) — and then either
 * added, updated or left alone, as the operator chose. Every update keeps the
 * values it replaced, so an undo can put them back; every record it added can
 * be taken out again as long as nothing has used it since.
 */
import { z } from 'zod';
import type { Tx } from '../../../core/db/client.js';
import { repo } from '../../../core/db/repository.js';
import { getTable } from '../../../core/db/schema/registry.js';
import { quoteIdent } from '../../../core/db/schema/sql.js';
import { compare } from '../../../core/util/decimal.js';
import { reserveDocumentNumbers } from '../../numbering/numbering.service.js';
import type { Lookups } from '../lookups.js';
import { bumpSeriesPast } from './shared.js';
import { deriveCode, normKey, PHONE_WORDS, stateCodeFor, stateNameFor } from '../normalize.js';
import type { CommitResult, EntityDef, FieldDef, ImportedRow, Issue, JobContext, LookupValue, PreparedRow, UndoOutcome } from '../types.js';

type Row = Record<string, unknown>;

export const ON_EXISTING = z.enum(['update', 'fill_blanks', 'skip']).default('update');
const onExistingHelp = {
  key: 'onExisting', label: 'When the record already exists',
  description: 'update: the file’s values replace the saved ones (a blank cell keeps what is saved). fill_blanks: only empty fields are filled in. skip: existing records are left exactly as they are.',
};

interface Match { id: string; code: string; name: string }

interface MasterSpec {
  key: string; label: string; order: number; description: string;
  fields: FieldDef[];
  table: string;
  remember: 'category' | 'item' | 'party' | 'karigar' | 'plan';
  /** Series that numbers rows without a code; without one, codes are made from the name. */
  codeSeries?: 'party' | 'karigar';
  codeMax: number;
  needs: EntityDef['needs'];
  options?: z.ZodRawShape;
  optionHelp?: EntityDef['optionHelp'];
  /** Booleans that are only ever switched on by an import: a supplier imported as a customer stays a supplier. */
  flags?: string[];
  /** The row as table columns, or null when it cannot be saved (the reason is in `issues`). */
  columns(tx: Tx, v: Row, ctx: JobContext, issues: Issue[], rowNumber: number): Promise<Row | null>;
  match(v: Row, cols: Row, l: Lookups, issues: Issue[]): Match | null;
  /** What makes two rows of the file the same record. */
  keys(cols: Row): string[];
  rowLabel(cols: Row): string;
}

const text = (key: string, label: string, synonyms: string[] = [], extra: Partial<FieldDef> = {}): FieldDef =>
  ({ key, label, type: 'text', synonyms, ...extra });

/** Two values are the same when they read the same: 6500 and 6500.0000 included. */
function same(a: unknown, b: unknown): boolean {
  const blank = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
  if (blank(a) && blank(b)) return true;
  if (blank(a) || blank(b)) return false;
  const num = /^-?\d+(\.\d+)?$/;
  if (typeof a === 'string' && typeof b === 'string' && num.test(a) && num.test(b)) return compare(a, b) === 0;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}
const isEmpty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

function masterEntity(spec: MasterSpec): EntityDef {
  const def = getTable(spec.table)!;
  const jsonColumns = new Set(Object.entries(def.columns).filter(([, c]) => c.type === 'jsonb').map(([k]) => k));

  return {
    key: spec.key, label: spec.label, group: 'masters', order: spec.order, description: spec.description,
    fields: spec.fields, needs: spec.needs, posts: false, chunk: 500,
    options: z.object({ onExisting: ON_EXISTING, ...(spec.options ?? {}) }) as unknown as z.ZodType<Row>,
    optionHelp: [onExistingHelp, ...(spec.optionHelp ?? [])],

    async prepare(tx, rows, ctx) {
      const out: PreparedRow[] = [];
      for (const row of rows) {
        const issues: Issue[] = [...row.issues];
        if (issues.some((i) => i.level === 'error')) { out.push({ row, action: 'insert', issues }); continue; }
        const cols = await spec.columns(tx, row.values, ctx, issues, row.rowNumber);
        if (!cols) { out.push({ row, action: 'insert', issues }); continue; }
        const label = spec.rowLabel(cols);

        // The same record twice in one file: the first row stands, the later one is refused.
        const dup = spec.keys(cols).map((k) => ctx.seen.get(k)).find((n) => n !== undefined && n !== row.rowNumber);
        if (dup !== undefined) {
          issues.push({ level: 'error', message: `Same ${spec.label.replace(/s$/, '').toLowerCase()} as row ${dup}. Remove one of the two, or skip this row.` });
          out.push({ row, action: 'insert', issues, label });
          continue;
        }
        for (const k of spec.keys(cols)) ctx.seen.set(k, row.rowNumber);

        const existing = spec.match(row.values, cols, ctx.lookups, issues);
        if (existing && ctx.options.onExisting === 'skip') {
          issues.push({ level: 'warning', message: `Already in the masters as ${existing.name} (${existing.code}); left as it is.` });
          out.push({ row, action: 'skip', issues, label, plan: { cols, existingId: existing.id } });
          continue;
        }
        if (!existing && ctx.mode === 'validate') {
          // So that a later row naming this one (an item's category, say) finds it during the check as well.
          ctx.lookups.rememberRow(spec.remember, { id: `new:${spec.key}:${row.rowNumber}`, code: String(cols.code ?? ''), name: String(cols.name ?? ''), ...cols });
        }
        out.push({ row, action: existing ? 'update' : 'insert', issues, label, plan: { cols, existingId: existing?.id ?? null } });
      }
      return out;
    },

    async commit(tx, rows, ctx) {
      const results: CommitResult[] = [];
      const inserts = rows.filter((r) => r.action === 'insert');
      const updates = rows.filter((r) => r.action === 'update');
      for (const r of rows.filter((x) => x.action === 'skip')) {
        results.push({ rowId: r.row.id, ok: true, action: 'skip', targetTable: spec.table, targetId: (r.plan as { existingId: string }).existingId });
      }

      if (inserts.length) {
        const plans = inserts.map((r) => (r.plan as { cols: Row }).cols);
        const uncoded = plans.filter((c) => !c.code);
        if (uncoded.length && spec.codeSeries) {
          const { numbers } = await reserveDocumentNumbers(tx, spec.codeSeries, uncoded.length);
          uncoded.forEach((c, i) => { c.code = numbers[i]; });
        }
        // Blank values are left out so the table's own defaults apply; rows carrying the same columns go in together.
        const groups = new Map<string, number[]>();
        const values = plans.map((c, i) => {
          const kept = Object.fromEntries(Object.entries(c)
            .filter(([, v]) => v !== null && v !== undefined)
            .map(([k, v]) => [k, jsonColumns.has(k) ? JSON.stringify(v) : v]));
          const key = Object.keys(kept).sort().join(',');
          groups.set(key, [...(groups.get(key) ?? []), i]);
          return kept;
        });
        for (const indexes of groups.values()) {
          const saved = await repo<Row & { id: string; code: string; name: string }>(tx, spec.table).insertMany(indexes.map((i) => values[i]!));
          saved.forEach((row, n) => {
            ctx.lookups.rememberRow(spec.remember, row);
            results.push({ rowId: inserts[indexes[n]!]!.row.id, ok: true, action: 'insert', targetTable: spec.table, targetId: row.id });
          });
        }
      }

      if (updates.length) {
        const ids = updates.map((r) => (r.plan as { existingId: string }).existingId);
        const current = new Map((await tx.query<Row & { id: string }>(
          `select * from ${quoteIdent(spec.table)} where id = any($1::uuid[]) for update`, [ids])).map((r) => [r.id, r]));
        const groups = new Map<string, Array<{ id: string; set: Row }>>();
        for (const r of updates) {
          const { cols, existingId } = r.plan as { cols: Row; existingId: string };
          const now = current.get(existingId);
          if (!now) {
            results.push({ rowId: r.row.id, ok: false, issues: [{ level: 'error', message: 'The record it matched was removed while the import ran.' }] });
            continue;
          }
          const set: Row = {};
          for (const [col, value] of Object.entries(cols)) {
            if (col === 'code' || value === undefined || value === null || value === '') continue;
            if (spec.flags?.includes(col)) { if (value === true && now[col] !== true) set[col] = true; continue; }
            if (ctx.options.onExisting === 'fill_blanks' && !isEmpty(now[col])) continue;
            if (!same(now[col], value)) set[col] = value;
          }
          const columns = Object.keys(set).sort();
          if (!columns.length) {
            results.push({ rowId: r.row.id, ok: true, action: 'update', targetTable: spec.table, targetId: existingId, before: null, after: null,
              issues: [{ level: 'warning', message: 'Already up to date; nothing changed.' }] });
            continue;
          }
          const before = Object.fromEntries(columns.map((c) => [c, now[c] ?? null]));
          results.push({ rowId: r.row.id, ok: true, action: 'update', targetTable: spec.table, targetId: existingId, before, after: set });
          const key = columns.join(',');
          groups.set(key, [...(groups.get(key) ?? []), { id: existingId, set }]);
        }
        for (const [key, list] of groups) await updateMany(tx, spec.table, key.split(','), list);
      }
      return results;
    },

    async undo(tx, rows, ctx) {
      return undoMasters(tx, spec.table, rows, ctx.reason);
    },

    // Old codes like C000500 move the shop's own series past them, so a customer added by hand later never collides.
    ...(spec.codeSeries ? {
      async finish(tx: Tx, ctx: JobContext) {
        const codes = await tx.query<{ code: string }>(
          `select t.code from import_row r join ${quoteIdent(spec.table)} t on t.id = r.target_id
            where r.batch_id = $1 and r.status = 'imported'`, [ctx.batchId]);
        const note = await bumpSeriesPast(tx, spec.codeSeries!, codes.map((c) => c.code));
        return note ? [note] : [];
      },
    } : {}),
  };
}

/** One statement for every row that changes the same columns. */
export async function updateMany(tx: Tx, table: string, columns: string[], list: Array<{ id: string; set: Row }>): Promise<void> {
  const def = getTable(table)!;
  const types = columns.map((c) => `${quoteIdent(c)} ${def.columns[c]!.type}`);
  await tx.query(
    `update ${quoteIdent(table)} t
        set ${columns.map((c) => `${quoteIdent(c)} = x.${quoteIdent(c)}`).join(', ')}, updated_at = now(), updated_by = $2
       from jsonb_to_recordset($1::jsonb) as x(id uuid, ${types.join(', ')})
      where t.id = x.id`,
    [JSON.stringify(list.map((r) => ({ id: r.id, ...r.set }))), tx.context.userId]);
}

/**
 * Takes masters back out. A record the import added goes, unless something has
 * used it since (a bill, a balance, a scheme) — then it stays and says so. A
 * record it changed gets its old values back, field by field, except where
 * someone has changed that field again since: their edit wins.
 */
export async function undoMasters(tx: Tx, table: string, rows: ImportedRow[], reason: string): Promise<UndoOutcome> {
  const out: UndoOutcome = { undone: [], kept: [] };
  const t = quoteIdent(table);
  const added = rows.filter((r) => r.action === 'insert' && r.target_id);
  if (added.length) {
    await tx.query('savepoint undo_all');
    try {
      await tx.raw.query(`delete from ${t} where id = any($1::uuid[])`, [added.map((r) => r.target_id)]);
      await tx.query('release savepoint undo_all');
      out.undone.push(...added.map((r) => r.id));
    } catch {
      await tx.query('rollback to savepoint undo_all');
      // Something points at some of them. One at a time, to keep the ones that can go.
      for (const r of added) {
        await tx.query('savepoint undo_one');
        try {
          await tx.raw.query(`delete from ${t} where id = $1`, [r.target_id]);
          await tx.query('release savepoint undo_one');
          out.undone.push(r.id);
        } catch {
          await tx.query('rollback to savepoint undo_one');
          out.kept.push({ rowId: r.id, message: 'Kept: it has been used since it was imported (on a bill, a balance, a stock record or another master).' });
        }
      }
    }
  }

  const changed = rows.filter((r) => r.action === 'update' && r.target_id && r.before && r.after);
  if (changed.length) {
    const current = new Map((await tx.query<Row & { id: string }>(
      `select * from ${t} where id = any($1::uuid[]) for update`, [changed.map((r) => r.target_id)])).map((r) => [r.id, r]));
    const groups = new Map<string, Array<{ id: string; set: Row }>>();
    for (const r of changed) {
      const now = current.get(r.target_id!);
      if (!now) { out.kept.push({ rowId: r.id, message: 'The record no longer exists.' }); continue; }
      const set: Row = {};
      const later: string[] = [];
      for (const [col, was] of Object.entries(r.before!)) {
        if (same(now[col], r.after![col])) set[col] = was;
        else later.push(col);
      }
      if (later.length) out.kept.push({ rowId: r.id, message: `Changed again since the import, so left as it is now: ${later.join(', ')}.` });
      if (!Object.keys(set).length) continue;
      const key = Object.keys(set).sort().join(',');
      groups.set(key, [...(groups.get(key) ?? []), { id: r.target_id!, set }]);
      if (!later.length) out.undone.push(r.id);
    }
    for (const [key, list] of groups) await updateMany(tx, table, key.split(','), list);
  }
  // A row that only matched (nothing changed, or skipped) has nothing to undo.
  for (const r of rows) {
    if (!out.undone.includes(r.id) && !out.kept.some((k) => k.rowId === r.id) && !(r.action === 'insert' && r.target_id)) out.undone.push(r.id);
  }
  void reason;
  return out;
}

/* ================================================================ fields */

const PARTY_TYPE = { key: 'party_type', label: 'Individual or business', type: 'enum' as const, synonyms: ['type', 'party type', 'customer type'],
  options: [
    { value: 'individual', label: 'Individual', synonyms: ['person', 'retail', 'b2c', 'indiv', 'i', 'personal', 'consumer'] },
    { value: 'business', label: 'Business', synonyms: ['company', 'firm', 'b2b', 'dealer', 'wholesale', 'wholesaler', 'b', 'shop', 'trader', 'corporate'] },
  ] };

const contactFields = (who: 'customer' | 'supplier'): FieldDef[] => [
  { key: 'code', label: who === 'customer' ? 'Customer code' : 'Supplier code', type: 'code',
    synonyms: ['code', 'id', 'ac code', 'account code', 'party code', 'ledger code', `${who} id`, `${who} no`, 'cust code', 'custid', 'sr no'],
    description: 'Kept as it is, so the shop’s old codes still work. Leave blank to get the next code.' },
  text('name', who === 'customer' ? 'Customer name' : 'Supplier name',
    ['name', 'party name', 'party', 'ledger name', 'account name', 'customer', 'supplier', 'full name', 'firm name', 'company name', 'cust name', 'vendor', 'vendor name'],
    { required: true, example: who === 'customer' ? 'Ramesh Patel' : 'Mumbai Bullion Traders' }),
  { key: 'phone', label: 'Mobile', type: 'phone', soft: true, synonyms: PHONE_WORDS, example: '98765 43210' },
  { key: 'email', label: 'Email', type: 'email', soft: true, synonyms: ['email id', 'e mail', 'mail'] },
  { key: 'gstin', label: 'GSTIN', type: 'gstin', soft: true, synonyms: ['gst', 'gst no', 'gstin no', 'gst number', 'gstin uin'] },
  { key: 'pan', label: 'PAN', type: 'pan', soft: true, synonyms: ['pan no', 'pan number', 'it pan'] },
  text('address_line1', 'Address', ['address', 'address 1', 'address line 1', 'addr', 'street']),
  text('address_line2', 'Address line 2', ['address 2', 'area', 'locality', 'landmark']),
  text('city', 'City', ['town', 'place', 'district']),
  text('state', 'State', ['state name', 'province']),
  { key: 'pincode', label: 'PIN code', type: 'pincode', soft: true, synonyms: ['pin', 'pin code', 'postal code', 'zip'] },
  PARTY_TYPE,
  { key: 'credit_limit', label: 'Credit limit', type: 'money', synonyms: ['credit limit', 'limit'] },
  { key: 'credit_days', label: 'Credit days', type: 'int', synonyms: ['credit period', 'due days', 'payment terms'] },
  ...(who === 'customer' ? [
    { key: 'date_of_birth', label: 'Date of birth', type: 'date', soft: true, synonyms: ['dob', 'birth date', 'birthday'] } as FieldDef,
    { key: 'anniversary', label: 'Anniversary', type: 'date', soft: true, synonyms: ['anniversary date', 'marriage date', 'wedding date', 'doa'] } as FieldDef,
  ] : []),
  text('notes', 'Notes', ['remarks', 'remark', 'comment', 'comments', 'narration']),
  { key: 'is_active', label: 'Active', type: 'bool', soft: true, synonyms: ['status', 'active', 'enabled'] },
];

/** Party columns as the masters keep them: state code from the GSTIN or the state's name. */
function partyColumns(v: Row, role: 'customer' | 'supplier', issues: Issue[]): Row {
  const gstin = v.gstin as string | undefined;
  const stateCode = gstin ? gstin.slice(0, 2) : stateCodeFor(v.state);
  if (v.state && !stateCode) issues.push({ level: 'warning', field: 'state', message: `State "${v.state}" was not recognised, so GST will treat this ${role} as being in the shop’s own state.` });
  if (gstin && v.pan && gstin.slice(2, 12) !== v.pan) issues.push({ level: 'warning', field: 'pan', message: 'The PAN does not match the one inside the GSTIN.' });
  return {
    code: v.code || null, name: String(v.name).trim(), phone: v.phone ?? null, email: v.email ?? null, gstin: gstin ?? null,
    pan: v.pan ?? (gstin ? gstin.slice(2, 12) : null), state_code: stateCode, state: v.state ?? stateNameFor(stateCode),
    address_line1: v.address_line1 ?? null, address_line2: v.address_line2 ?? null, city: v.city ?? null, pincode: v.pincode ?? null,
    party_type: v.party_type ?? (role === 'supplier' || gstin ? 'business' : 'individual'),
    credit_limit: v.credit_limit ?? null, credit_days: v.credit_days ?? null,
    date_of_birth: v.date_of_birth ?? null, anniversary: v.anniversary ?? null, notes: v.notes ?? null,
    is_active: v.is_active ?? true,
    is_customer: role === 'customer', is_supplier: role === 'supplier',
  };
}

function matchParty(cols: Row, l: Lookups, role: 'customer' | 'supplier', issues: Issue[]): Match | null {
  const code = cols.code as string | null;
  if (code) {
    const hit = l.party({ text: code });
    if (hit.kind === 'found' && hit.row.code.toUpperCase() === code) return hit.row;
  }
  if (cols.gstin) {
    const byGstin = l.partyByGstin(cols.gstin as string);
    if (byGstin.length === 1) return byGstin[0]!;
  }
  const phone = cols.phone as string | null;
  const sharing = l.partiesWithPhone(phone);
  const sameName = sharing.filter((p) => normKey(p.name) === normKey(cols.name));
  if (sameName.length === 1) return sameName[0]!;
  if (sharing.length && !code) {
    issues.push({ level: 'warning', field: 'phone', message: `Shares a mobile number with ${sharing.slice(0, 2).map((p) => `${p.name} (${p.code})`).join(', ')}; added as a separate ${role}.` });
  }
  if (role === 'supplier' && !code && !phone) {
    const byName = l.party({ text: String(cols.name) }, { role: 'supplier' });
    if (byName.kind === 'found' && byName.row.is_supplier) return byName.row;
  }
  return null;
}

const partyKeys = (cols: Row) => [
  ...(cols.code ? [`code:${cols.code}`] : []),
  ...(cols.gstin ? [`gstin:${cols.gstin}`] : []),
  ...(cols.phone ? [`pn:${String(cols.phone).slice(-10)}|${normKey(cols.name)}`] : []),
];

/* =============================================================== entities */

export const customers = masterEntity({
  key: 'customers', label: 'Customers', order: 30, table: 'party', remember: 'party', codeSeries: 'party', codeMax: 30,
  description: 'The customer book: names, mobiles, addresses, GSTIN and PAN, birthdays and anniversaries. Matched to existing customers by code, GSTIN, or mobile and name together.',
  fields: contactFields('customer'), needs: ['party'], flags: ['is_customer', 'is_supplier'],
  async columns(_tx, v, _ctx, issues) { return partyColumns(v, 'customer', issues); },
  match: (_v, cols, l, issues) => matchParty(cols, l, 'customer', issues),
  keys: partyKeys,
  rowLabel: (c) => `${c.name}${c.phone ? ` · ${c.phone}` : ''}`,
});

export const suppliers = masterEntity({
  key: 'suppliers', label: 'Suppliers', order: 40, table: 'party', remember: 'party', codeSeries: 'party', codeMax: 30,
  description: 'Suppliers, wholesalers and bullion dealers. A supplier who is already a customer is marked as both rather than duplicated.',
  fields: contactFields('supplier'), needs: ['party'], flags: ['is_customer', 'is_supplier'],
  async columns(_tx, v, _ctx, issues) { return partyColumns(v, 'supplier', issues); },
  match: (_v, cols, l, issues) => matchParty(cols, l, 'supplier', issues),
  keys: partyKeys,
  rowLabel: (c) => String(c.name),
});

export const karigars = masterEntity({
  key: 'karigars', label: 'Karigars', order: 50, table: 'karigar', remember: 'karigar', codeSeries: 'karigar', codeMax: 30,
  description: 'Goldsmiths and outside workshops, with their agreed ghat (loss allowance) and labour rate.',
  needs: ['karigar'],
  fields: [
    { key: 'code', label: 'Karigar code', type: 'code', synonyms: ['code', 'karigar code', 'kariger code', 'id', 'worker code'] },
    text('name', 'Karigar name', ['name', 'karigar', 'kariger', 'karigar name', 'worker', 'goldsmith', 'artisan'], { required: true, example: 'Shyam Soni' }),
    text('workshop_name', 'Workshop', ['workshop', 'firm', 'firm name', 'shop name', 'company']),
    { key: 'engagement', label: 'In-house or outside', type: 'enum', synonyms: ['type', 'engagement', 'employment'],
      options: [
        { value: 'in_house', label: 'In-house', synonyms: ['inhouse', 'internal', 'employee', 'staff', 'own'] },
        { value: 'external', label: 'Outside', synonyms: ['external', 'outsource', 'outsourced', 'job work', 'contract', 'outside'] },
      ] },
    text('speciality', 'Speciality', ['specialty', 'skill', 'work type', 'expertise']),
    { key: 'phone', label: 'Mobile', type: 'phone', soft: true, synonyms: PHONE_WORDS },
    text('address', 'Address', ['addr']),
    { key: 'pan', label: 'PAN', type: 'pan', soft: true, synonyms: ['pan no'] },
    { key: 'gstin', label: 'GSTIN', type: 'gstin', soft: true, synonyms: ['gst', 'gst no'] },
    { key: 'standard_ghat_percent', label: 'Ghat % allowed', type: 'percent', synonyms: ['ghat', 'ghat %', 'wastage', 'loss', 'loss %', 'touch loss', 'allowed loss'] },
    { key: 'labour_rate_per_gram', label: 'Labour per gram', type: 'money', synonyms: ['labour', 'labour rate', 'majuri', 'making rate', 'wages per gram', 'mazdoori'] },
    { key: 'is_active', label: 'Active', type: 'bool', soft: true, synonyms: ['status'] },
  ],
  async columns(_tx, v) {
    return {
      code: v.code || null, name: String(v.name).trim(), workshop_name: v.workshop_name ?? null, engagement: v.engagement ?? 'external',
      speciality: v.speciality ?? null, phone: v.phone ?? null, address: v.address ?? null, pan: v.pan ?? null, gstin: v.gstin ?? null,
      standard_ghat_percent: v.standard_ghat_percent ?? null, labour_rate_per_gram: v.labour_rate_per_gram ?? null, is_active: v.is_active ?? true,
    };
  },
  match(_v, cols, l) {
    if (cols.code) { const hit = l.karigar({ text: String(cols.code) }); if (hit.kind === 'found' && hit.row.code.toUpperCase() === cols.code) return hit.row; }
    const hit = l.karigar({ text: String(cols.name) }, cols.phone as string | null);
    return hit.kind === 'found' ? hit.row : null;
  },
  keys: (c) => [...(c.code ? [`code:${c.code}`] : []), `name:${normKey(c.name)}|${String(c.phone ?? '').slice(-10)}`],
  rowLabel: (c) => String(c.name),
});

export const categories = masterEntity({
  key: 'categories', label: 'Item categories', order: 10, table: 'item_category', remember: 'category', codeMax: 30,
  description: 'Rings, chains, bangles… Codes are kept; without one a code is made from the name. Import these before items.',
  needs: ['category', 'metal'],
  fields: [
    { key: 'code', label: 'Category code', type: 'code', synonyms: ['code', 'category code', 'group code', 'cat code'] },
    text('name', 'Category name', ['name', 'category', 'category name', 'group', 'group name', 'item group', 'product group'], { required: true, example: 'Rings' }),
    { key: 'hsn_code', label: 'HSN code', type: 'text', synonyms: ['hsn', 'hsn code', 'hsn sac'] },
    { key: 'sub_categories', label: 'Sub-categories', type: 'list', synonyms: ['sub category', 'subcategories', 'sub groups'], description: 'Separate with commas.' },
    { key: 'applicable_metals', label: 'Metals', type: 'list', synonyms: ['metal', 'metals'], description: 'GOLD, SILVER… separated by commas. Blank = any.' },
    { key: 'is_active', label: 'Active', type: 'bool', soft: true, synonyms: ['status'] },
  ],
  async columns(_tx, v, ctx, issues) {
    const hsn = v.hsn_code ? String(v.hsn_code).replace(/\D/g, '') : null;
    if (v.hsn_code && !/^\d{4,8}$/.test(hsn ?? '')) issues.push({ level: 'warning', field: 'hsn_code', message: `HSN "${v.hsn_code}" is not 4 to 8 digits; left blank.` });
    const metals: string[] = [];
    for (const m of (v.applicable_metals as string[] | undefined) ?? []) {
      const hit = ctx.lookups.metal({ text: m });
      if (hit.kind === 'found') metals.push(hit.row.code);
      else issues.push({ level: 'warning', field: 'applicable_metals', message: `Metal "${m}" is not one this shop deals in; left out.` });
    }
    const existing = ctx.lookups.category({ text: String(v.code ?? v.name) });
    const code = v.code ? String(v.code) : existing.kind === 'found' ? existing.row.code : deriveCode(String(v.name), ctx.lookups.codes.category);
    return {
      code, name: String(v.name).trim(), hsn_code: /^\d{4,8}$/.test(hsn ?? '') ? hsn : null,
      sub_categories: v.sub_categories ?? null, applicable_metals: metals.length ? metals : null, is_active: v.is_active ?? true,
    };
  },
  match(_v, cols, l) {
    const byCode = l.category({ text: String(cols.code) });
    if (byCode.kind === 'found' && byCode.row.code.toUpperCase() === String(cols.code).toUpperCase()) return byCode.row;
    const byName = l.category({ text: String(cols.name) });
    return byName.kind === 'found' ? byName.row : null;
  },
  keys: (c) => [`code:${c.code}`, `name:${normKey(c.name)}`],
  rowLabel: (c) => `${c.name} (${c.code})`,
});

const TRACKING = { key: 'tracking', label: 'Tagged or by weight', type: 'enum' as const, synonyms: ['tracking', 'stock type', 'type', 'unit type'],
  options: [
    { value: 'piece', label: 'Tagged piece by piece', synonyms: ['piece', 'pieces', 'pcs', 'pc', 'tag', 'tagged', 'tag wise', 'piece wise', 'ornament', 'item'] },
    { value: 'lot', label: 'By weight', synonyms: ['lot', 'weight', 'bulk', 'gram', 'grams', 'loose', 'weight wise', 'raw', 'bullion'] },
  ] };

export const items = masterEntity({
  key: 'items', label: 'Items', order: 20, table: 'item', remember: 'item', codeMax: 40,
  description: 'The product master. Each item names its category, metal and purity; categories the shop does not have yet can be made on the way.',
  needs: ['item', 'category', 'metal', 'purity'],
  options: { createMissingCategories: z.boolean().default(true) },
  optionHelp: [{ key: 'createMissingCategories', label: 'Make missing categories', description: 'A category named in the file that the shop does not have is created. Off: such rows are refused.' }],
  fields: [
    { key: 'code', label: 'Item code', type: 'code', synonyms: ['code', 'item code', 'product code', 'design code', 'sku', 'style code', 'item id'] },
    text('name', 'Item name', ['name', 'item', 'item name', 'product', 'product name', 'description', 'design name', 'article'], { required: true, example: 'Gold Ring 22K' }),
    { key: 'category', label: 'Category', type: 'lookup', lookup: 'category', synonyms: ['category', 'group', 'item group', 'category name', 'product group'] },
    { key: 'metal', label: 'Metal', type: 'lookup', lookup: 'metal', synonyms: ['metal', 'metal type'], example: 'Gold' },
    { key: 'purity', label: 'Purity', type: 'lookup', lookup: 'purity', synonyms: ['purity', 'karat', 'carat', 'kt', 'touch', 'fineness', 'tunch'], example: '22K' },
    { key: 'hsn_code', label: 'HSN code', type: 'text', synonyms: ['hsn', 'hsn code'] },
    { key: 'nature', label: 'Nature', type: 'enum', synonyms: ['nature', 'item nature', 'kind'],
      options: [
        { value: 'finished', label: 'Finished jewellery', synonyms: ['finished', 'ornament', 'jewellery', 'jewelry', 'fg', 'finished goods'] },
        { value: 'raw_metal', label: 'Raw metal', synonyms: ['raw', 'raw metal', 'bullion', 'bar', 'fine', 'metal'] },
        { value: 'stone', label: 'Stone', synonyms: ['stone', 'diamond', 'gem', 'gemstone', 'stones'] },
        { value: 'consumable', label: 'Consumable', synonyms: ['consumable', 'packing', 'box'] },
        { value: 'service', label: 'Service', synonyms: ['service', 'labour', 'repair'] },
      ] },
    TRACKING,
    { key: 'uom', label: 'Unit', type: 'enum', synonyms: ['unit', 'uom', 'units'],
      options: [
        { value: 'gram', label: 'Gram', synonyms: ['g', 'gm', 'gms', 'grams', 'gram'] },
        { value: 'piece', label: 'Piece', synonyms: ['pc', 'pcs', 'nos', 'no', 'piece', 'pieces'] },
        { value: 'carat', label: 'Carat', synonyms: ['ct', 'cts', 'carat', 'carats'] },
        { value: 'millilitre', label: 'Millilitre', synonyms: ['ml'] },
      ] },
    { key: 'is_active', label: 'Active', type: 'bool', soft: true, synonyms: ['status'] },
  ],
  async columns(tx, v, ctx, issues, rowNumber) {
    const l = ctx.lookups;
    let categoryId: string | null = null;
    const cat = v.category as LookupValue | undefined;
    if (cat) {
      const hit = l.category(cat);
      if (hit.kind === 'found') categoryId = hit.row.id;
      else if (hit.kind === 'ambiguous') { issues.push({ level: 'error', field: 'category', message: `Category "${cat.text}" matches ${hit.count}: ${hit.names.join(', ')}. Choose one in the value panel.` }); return null; }
      else if (ctx.options.createMissingCategories) categoryId = await l.ensureCategory(tx, ctx, cat.text);
      else { ctx.unknown('category', cat.text, rowNumber); issues.push({ level: 'error', field: 'category', message: `Category "${cat.text}" does not exist.` }); return null; }
    }
    let metalId: string | null = null;
    const metal = v.metal as LookupValue | undefined;
    if (metal) {
      const hit = l.metal(metal);
      if (hit.kind !== 'found') { ctx.unknown('metal', metal.text, rowNumber); issues.push({ level: 'error', field: 'metal', message: `Metal "${metal.text}" is not one this shop deals in.` }); return null; }
      metalId = hit.row.id;
    }
    let purityId: string | null = null;
    const purity = v.purity as LookupValue | undefined;
    if (purity) {
      const hit = l.purity(purity, metalId);
      if (hit.kind === 'found') { purityId = hit.row.id; metalId ??= hit.row.metal_id; }
      else {
        ctx.unknown('purity', purity.text, rowNumber);
        issues.push({ level: 'error', field: 'purity', message: hit.kind === 'ambiguous'
          ? `Purity "${purity.text}" could be ${hit.names.join(' or ')}. Give the metal, or choose in the value panel.`
          : `Purity "${purity.text}" is not set up in Masters → Purities.` });
        return null;
      }
    }
    const existing = l.item({ text: String(v.code ?? v.name) });
    const code = v.code ? String(v.code) : existing.kind === 'found' ? existing.row.code : deriveCode(String(v.name), l.codes.item, 40);
    return {
      code, name: String(v.name).trim(), category_id: categoryId, metal_id: metalId, default_purity_id: purityId,
      hsn_code: v.hsn_code ? String(v.hsn_code).replace(/\D/g, '') || null : null,
      nature: v.nature ?? 'finished', tracking: v.tracking ?? 'piece', uom: v.uom ?? 'gram', is_active: v.is_active ?? true,
    };
  },
  match(_v, cols, l) {
    const byCode = l.item({ text: String(cols.code) });
    if (byCode.kind === 'found' && byCode.row.code.toUpperCase() === String(cols.code).toUpperCase()) return byCode.row;
    const byName = l.item({ text: String(cols.name) });
    return byName.kind === 'found' ? byName.row : null;
  },
  keys: (c) => [`code:${c.code}`, `name:${normKey(c.name)}`],
  rowLabel: (c) => `${c.name} (${c.code})`,
});


export const schemePlans = masterEntity({
  key: 'scheme_plans', label: 'Savings plans', order: 60, table: 'scheme_plan', remember: 'plan', codeMax: 30,
  description: 'The gold savings schemes the shop runs (11+1, weight plans…). Import these before scheme members.',
  needs: ['plan', 'metal', 'purity'],
  fields: [
    { key: 'code', label: 'Plan code', type: 'code', synonyms: ['code', 'scheme code', 'plan code'] },
    text('name', 'Plan name', ['name', 'scheme', 'scheme name', 'plan', 'plan name'], { required: true, example: 'Swarna Nidhi 11+1' }),
    { key: 'tenure_months', label: 'Months', type: 'int', required: true, min: 1, max: 120, synonyms: ['tenure', 'duration', 'months', 'no of installments', 'installments', 'period'], example: '11' },
    { key: 'installment_amount', label: 'Monthly amount', type: 'money', synonyms: ['installment', 'emi', 'monthly', 'amount', 'installment amount', 'monthly amount'], example: '5000' },
    { key: 'accrual_basis', label: 'Saves in', type: 'enum', synonyms: ['basis', 'type', 'scheme type', 'accrual'],
      options: [
        { value: 'rupee', label: 'Rupees', synonyms: ['rupee', 'amount', 'money', 'cash', 'value', 'rs'] },
        { value: 'weight', label: 'Grams', synonyms: ['weight', 'gold', 'gram', 'grams', 'metal', 'gold weight'] },
      ] },
    { key: 'metal', label: 'Metal', type: 'lookup', lookup: 'metal', synonyms: ['metal'] },
    { key: 'purity', label: 'Purity', type: 'lookup', lookup: 'purity', synonyms: ['purity', 'karat'] },
    { key: 'is_flexible_amount', label: 'Any amount', type: 'bool', synonyms: ['flexible', 'flexi', 'variable amount'] },
    { key: 'minimum_installment', label: 'Smallest amount', type: 'money', synonyms: ['minimum', 'min amount', 'minimum installment'] },
    { key: 'bonus_installments', label: 'Bonus months', type: 'decimal', synonyms: ['bonus', 'free installments', 'bonus installment', 'bonus months'] },
    { key: 'bonus_percent', label: 'Bonus %', type: 'percent', synonyms: ['bonus percent', 'bonus %'] },
    { key: 'max_missed_installments', label: 'Months that may be missed', type: 'int', synonyms: ['max missed', 'allowed missed', 'missed allowed'] },
    { key: 'making_charge_discount_percent', label: 'Making discount %', type: 'percent', synonyms: ['making discount', 'mc discount', 'making off'] },
    { key: 'grace_period_days', label: 'Grace days', type: 'int', synonyms: ['grace', 'grace period', 'grace days'] },
    text('description', 'Description', ['details', 'remarks']),
    { key: 'is_active', label: 'Open to new members', type: 'bool', soft: true, synonyms: ['active', 'status'] },
  ],
  async columns(_tx, v, ctx, issues, rowNumber) {
    const l = ctx.lookups;
    const metal = v.metal ? l.metal(v.metal as LookupValue) : { kind: 'found' as const, row: l.metals.find((m) => m.code === 'GOLD') ?? l.metals[0]! };
    if (metal.kind !== 'found' || !metal.row) { issues.push({ level: 'error', field: 'metal', message: `Metal "${(v.metal as LookupValue).text}" is not one this shop deals in.` }); return null; }
    let purityId: string | null = null;
    if (v.purity) {
      const hit = l.purity(v.purity as LookupValue, metal.row.id);
      if (hit.kind !== 'found') { ctx.unknown('purity', (v.purity as LookupValue).text, rowNumber); issues.push({ level: 'error', field: 'purity', message: `Purity "${(v.purity as LookupValue).text}" is not set up for ${metal.row.name}.` }); return null; }
      purityId = hit.row.id;
    }
    if (!v.is_flexible_amount && !v.installment_amount) {
      issues.push({ level: 'error', field: 'installment_amount', message: 'A fixed plan needs its monthly amount. Mark it as "any amount" if members pay what they like.' });
      return null;
    }
    const existing = l.plan({ text: String(v.code ?? v.name) });
    const code = v.code ? String(v.code) : existing.kind === 'found' ? existing.row.code : deriveCode(String(v.name), l.codes.plan);
    return {
      code, name: String(v.name).trim(), description: v.description ?? null, metal_id: metal.row.id, purity_id: purityId,
      accrual_basis: v.accrual_basis ?? 'rupee', tenure_months: v.tenure_months, installment_amount: v.installment_amount ?? null,
      minimum_installment: v.minimum_installment ?? null, is_flexible_amount: v.is_flexible_amount ?? false,
      bonus_installments: v.bonus_installments ?? null, bonus_percent: v.bonus_percent ?? null,
      max_missed_installments: v.max_missed_installments ?? null, making_charge_discount_percent: v.making_charge_discount_percent ?? null,
      grace_period_days: v.grace_period_days ?? null, is_active: v.is_active ?? true,
    };
  },
  match(_v, cols, l) {
    const byCode = l.plan({ text: String(cols.code) });
    if (byCode.kind === 'found' && byCode.row.code.toUpperCase() === String(cols.code).toUpperCase()) return byCode.row;
    const byName = l.plan({ text: String(cols.name) });
    return byName.kind === 'found' ? byName.row : null;
  },
  keys: (c) => [`code:${c.code}`, `name:${normKey(c.name)}`],
  rowLabel: (c) => `${c.name} (${c.code})`,
});
