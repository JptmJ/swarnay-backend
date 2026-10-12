/**
 * Every kind of record that can be brought over, in the order a shop's data is
 * best brought in: masters first (later files name them), then stock, then
 * what is owed, then the running accounts.
 */
import type { EntityDef } from '../types.js';
import { categories, customers, items, karigars, schemePlans, suppliers } from './masters.js';
import { openingLots, openingPieces } from './stock.js';
import { karigarBalances, ledgerBalances, metalBalances, partyBalances } from './balances.js';
import { girviLoans, schemeAccounts } from './contracts.js';

export const ENTITIES: EntityDef[] = [
  categories, items, customers, suppliers, karigars, schemePlans,
  openingPieces, openingLots,
  partyBalances, metalBalances, karigarBalances, ledgerBalances,
  schemeAccounts, girviLoans,
].sort((a, b) => a.order - b.order);

export const ENTITY_KEYS = ENTITIES.map((e) => e.key) as [string, ...string[]];

export const entityFor = (key: string): EntityDef | undefined => ENTITIES.find((e) => e.key === key);
