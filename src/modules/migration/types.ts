/**
 * The vocabulary every kind of import is written in.
 *
 * An import kind (customers, opening stock, scheme accounts…) declares its
 * fields once. That one declaration drives the column matching, the sample
 * file, the parsing of every cell, and the field list the console shows — so a
 * field added here appears everywhere at once.
 */
import type { Tx } from '../../core/db/client.js';
import type { Decimal } from '../../core/util/decimal.js';
import type { z } from 'zod';
import type { Lookups } from './lookups.js';
import type { DateFormat, EnumOption, WeightUnit } from './normalize.js';

export type FieldType =
  | 'text' | 'code' | 'phone' | 'email' | 'gstin' | 'pan' | 'pincode' | 'date'
  | 'money' | 'weight' | 'percent' | 'int' | 'decimal' | 'bool' | 'enum' | 'balance' | 'list' | 'lookup';

export type LookupKind =
  | 'metal' | 'purity' | 'category' | 'item' | 'branch' | 'location' | 'party' | 'karigar' | 'plan' | 'account';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** A bad value is dropped with a warning instead of refusing the row — for contact details, birthdays and the like. */
  soft?: boolean;
  description?: string;
  /** Other headings old software uses for this field. The label and key always count. */
  synonyms?: string[];
  options?: EnumOption[];
  lookup?: LookupKind;
  /** Shown in the sample file's second line. */
  example?: string;
  /** Integer limits. */
  min?: number;
  max?: number;
}

export interface Issue { level: 'error' | 'warning'; field?: string; message: string }

/** What a lookup cell holds: the text as written, and the record it was mapped to by hand, if it was. */
export interface LookupValue { text: string; id?: string }

/** One row after its cells are read: typed values by field, and what went wrong reading them. */
export interface MappedRow {
  id: string;
  rowNumber: number;
  values: Record<string, unknown>;
  issues: Issue[];
}

export interface PreparedRow<P = unknown> {
  row: MappedRow;
  action: 'insert' | 'update' | 'skip';
  issues: Issue[];
  label?: string;
  /** Whatever the kind needs to save the row: resolved ids, computed figures. */
  plan?: P;
}

export interface CommitResult {
  rowId: string;
  ok: boolean;
  action?: 'insert' | 'update' | 'skip';
  targetTable?: string;
  targetId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  issues?: Issue[];
}

export interface ImportedRow {
  id: string;
  row_number: number;
  action: 'insert' | 'update' | 'skip' | null;
  target_table: string | null;
  target_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface UndoOutcome {
  /** Rows taken back out. */
  undone: string[];
  /** Rows that had to stay, with why. */
  kept: Array<{ rowId: string; message: string }>;
}

export interface JobContext {
  tenantId: string;
  batchId: string;
  title: string;
  mode: 'validate' | 'commit';
  options: Record<string, unknown>;
  /** The day balances and opening stock are dated. */
  asOf: string;
  today: string;
  lookups: Lookups;
  /** Keys already seen in this file, for spotting the same record twice. Lives for the whole job. */
  seen: Map<string, number>;
  /** Anything a kind needs to carry from one chunk to the next — a loan made by an earlier row, a setting read once. */
  memo: Map<string, unknown>;
  /** A value that could not be placed — counted for the value-matching panel. */
  unknown(field: string, value: string, rowNumber: number): void;
  /** A record the import will make (a missing category, item or customer). */
  willCreate(kind: string, key: string): void;
  /** Running totals over the good rows, to reconcile against the old software. */
  total(key: string, value: Decimal): void;
}

export interface EntityDef {
  key: string;
  label: string;
  group: 'masters' | 'stock' | 'balances' | 'running';
  /** Where it sits in the recommended order. */
  order: number;
  description: string;
  fields: FieldDef[];
  /** At least one field of each set must be given, e.g. a balance, or a debit or credit. */
  requireOneOf?: Array<{ fields: string[]; message: string }>;
  options: z.ZodType<Record<string, unknown>>;
  /** What the options mean, for the console. */
  optionHelp: Array<{ key: string; label: string; description: string }>;
  /** Lookup lists to load before reading rows. */
  needs: LookupKind[];
  /** True when importing posts to the books: an undo is then all or nothing. */
  posts: boolean;
  /** Rows per transaction. Kinds that do a lot per row take smaller chunks. */
  chunk: number;
  prepare(tx: Tx, rows: MappedRow[], ctx: JobContext): Promise<PreparedRow[]>;
  commit(tx: Tx, rows: PreparedRow[], ctx: JobContext): Promise<CommitResult[]>;
  /** Checks an undo can go through, before anything is touched. Returns why not, or null. */
  canUndo?(tx: Tx, rows: ImportedRow[], ctx: { batchId: string }): Promise<string | null>;
  undo(tx: Tx, rows: ImportedRow[], ctx: { batchId: string; reason: string }): Promise<UndoOutcome>;
  /** Anything to do once every chunk is in, such as moving a number series past imported numbers. */
  finish?(tx: Tx, ctx: JobContext): Promise<string[]>;
}

export interface MappingEntry {
  column?: string | null; constant?: string | null; unit?: WeightUnit; format?: DateFormat;
  /** For balances: the file writes debits as minus figures, as Tally XML does. */
  negate?: boolean;
}
export type Mapping = Record<string, MappingEntry>;
/** Field → (normalised value in the file → what it means here: a record id, or an option's value). */
export type ValueMap = Record<string, Record<string, string>>;
