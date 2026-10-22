/**
 * From the file's columns to our fields.
 *
 * `suggestMapping` reads the headings and guesses which column holds which
 * field, so the operator only corrects the odd one rather than pairing forty
 * columns by hand. `mapRow` then reads one row through the mapping: each cell
 * becomes a typed value, and each cell that cannot be read says why.
 */
import {
  cellText, normKey, parseBalance, parseBool, parseCode, parseDate, parseDecimal, parseEmail, parseEnum, parseGstin,
  parseInteger, parseMoney, parsePan, parsePercent, parsePhone, parsePincode, parseWeight, squash, type Parsed,
} from './normalize.js';
import type { EntityDef, FieldDef, Issue, LookupValue, MappedRow, Mapping, ValueMap } from './types.js';

/** How strongly a heading suggests a field: exact beats contained, longer beats shorter. */
function score(heading: string, field: FieldDef): number {
  const h = squash(heading);
  if (!h) return 0;
  let best = 0;
  for (const name of [field.key, field.label, ...(field.synonyms ?? [])]) {
    const n = squash(name);
    if (!n) continue;
    if (h === n) return 100;
    if (n.length >= 4 && h.includes(n)) best = Math.max(best, 40 + Math.round((n.length / h.length) * 40));
    else if (h.length >= 4 && n.includes(h)) best = Math.max(best, 30 + Math.round((h.length / n.length) * 30));
  }
  return best;
}

export function suggestMapping(entity: EntityDef, columns: string[]): Mapping {
  const pairs: Array<{ field: FieldDef; column: string; score: number }> = [];
  for (const field of entity.fields) {
    for (const column of columns) {
      const s = score(column, field);
      if (s >= 45) pairs.push({ field, column, score: s + (field.required ? 1 : 0) });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const mapping: Mapping = {};
  const used = new Set<string>();
  for (const p of pairs) {
    if (mapping[p.field.key] || used.has(p.column)) continue;
    mapping[p.field.key] = { column: p.column };
    used.add(p.column);
  }
  return mapping;
}

/** The text a field takes from a row: its column, or the constant typed for every row. */
export function fieldText(data: Record<string, unknown>, mapping: Mapping, field: string): string {
  const entry = mapping[field];
  if (!entry) return '';
  if (entry.column) return cellText(data[entry.column]);
  return cellText(entry.constant);
}

function parseField(field: FieldDef, text: string, mapping: Mapping): Parsed<unknown> {
  const entry = mapping[field.key] ?? {};
  switch (field.type) {
    case 'text': return { ok: true, value: text };
    case 'code': return parseCode(text, field.key === 'tag_number' ? 40 : 30);
    case 'phone': return parsePhone(text);
    case 'email': return parseEmail(text);
    case 'gstin': return parseGstin(text);
    case 'pan': return parsePan(text);
    case 'pincode': return parsePincode(text);
    case 'date': return parseDate(text, entry.format ?? 'DMY');
    case 'money': return parseMoney(text);
    case 'weight': return parseWeight(text, entry.unit ?? 'g');
    case 'percent': return parsePercent(text);
    case 'decimal': return parseDecimal(text, { decimals: 3 });
    case 'int': return parseInteger(text, { min: field.min ?? 0, max: field.max });
    case 'bool': return parseBool(text);
    case 'balance': {
      const b = parseBalance(text);
      return b.ok && entry.negate ? { ok: true, value: b.value.startsWith('-') ? b.value.slice(1) : b.value === '0' ? b.value : `-${b.value}` } : b;
    }
    case 'enum': return parseEnum(text, field.options ?? []);
    case 'list': return { ok: true, value: text.split(/[;,|]/).map((s) => s.trim()).filter(Boolean).slice(0, 50) };
    case 'lookup': return { ok: true, value: { text } satisfies LookupValue };
  }
}

/**
 * Reads one row. A value matched by hand in the value panel stands in for the
 * cell: for a lookup it is the record's id, for a closed list the option.
 */
export function mapRow(
  entity: EntityDef, row: { id: string; row_number: number; data: Record<string, unknown> },
  mapping: Mapping, valueMap: ValueMap,
): MappedRow {
  const values: Record<string, unknown> = {};
  const issues: Issue[] = [];
  for (const field of entity.fields) {
    const text = fieldText(row.data, mapping, field.key);
    if (!text) {
      if (field.required) issues.push({ level: 'error', field: field.key, message: `${field.label} is missing.` });
      continue;
    }
    const chosen = valueMap[field.key]?.[normKey(text)];
    if (field.type === 'lookup') {
      values[field.key] = { text, ...(chosen ? { id: chosen } : {}) } satisfies LookupValue;
      continue;
    }
    const parsed = parseField(field, field.type === 'enum' && chosen ? chosen : text, mapping);
    if (!parsed.ok) {
      if (field.soft) issues.push({ level: 'warning', field: field.key, message: `${field.label}: ${parsed.error}. Left blank.` });
      else issues.push({ level: 'error', field: field.key, message: `${field.label}: ${parsed.error}.` });
      continue;
    }
    if (parsed.note) issues.push({ level: 'warning', field: field.key, message: `${field.label}: ${parsed.note}.` });
    values[field.key] = parsed.value;
  }
  for (const rule of entity.requireOneOf ?? []) {
    if (!rule.fields.some((f) => values[f] !== undefined)) issues.push({ level: 'error', message: rule.message });
  }
  return { id: row.id, rowNumber: row.row_number, values, issues };
}

/** The headings a sample file carries: required fields first, then the rest, as the masters' samples do. */
export function sampleColumns(entity: EntityDef): FieldDef[] {
  return [...entity.fields.filter((f) => f.required), ...entity.fields.filter((f) => !f.required)];
}

export const hasErrors = (issues: Issue[]) => issues.some((i) => i.level === 'error');
