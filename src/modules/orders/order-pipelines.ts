/**
 * Each order type moves through its own sequence of stages.
 *
 * A repair is not a wedding order wearing a different label — it genuinely has
 * different steps, different people and different paperwork. Forcing all five
 * through one shared status column would mean every screen and every report
 * carried a pile of "if type is repair" branches forever.
 *
 * These are the built-in defaults. A tenant can override the stage list per
 * type in `order_pipeline`, which is why the board is config-driven rather
 * than hardcoded in the UI.
 */
export const ORDER_TYPES = ['booking', 'custom', 'repair', 'wedding', 'corporate'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export interface StageSpec {
  key: string;
  label: string;
  /** Terminal stages close the order; nothing moves out of them. */
  terminal?: boolean;
  /** Stages where the piece is physically with someone outside the shop. */
  external?: boolean;
}

export const ORDER_PIPELINES: Record<OrderType, StageSpec[]> = {
  booking: [
    { key: 'booked', label: 'Booked' },
    { key: 'sourcing', label: 'Sourcing' },
    { key: 'ready', label: 'Ready' },
    { key: 'delivered', label: 'Delivered', terminal: true },
  ],
  custom: [
    { key: 'intake', label: 'Intake' },
    { key: 'design', label: 'Design' },
    { key: 'crafting', label: 'Crafting', external: true },
    { key: 'finishing', label: 'Finishing' },
    { key: 'compliance', label: 'Compliance' },
    { key: 'ready', label: 'Ready' },
    { key: 'delivered', label: 'Delivered', terminal: true },
  ],
  repair: [
    { key: 'received', label: 'Received' },
    { key: 'repair', label: 'In Repair', external: true },
    { key: 'quality', label: 'Quality Check' },
    { key: 'ready', label: 'Ready' },
    { key: 'delivered', label: 'Delivered', terminal: true },
  ],
  wedding: [
    { key: 'planning', label: 'Planning' },
    { key: 'sourcing', label: 'Sourcing' },
    { key: 'production', label: 'Production', external: true },
    { key: 'quality', label: 'Quality Check' },
    { key: 'ready', label: 'Ready' },
    { key: 'delivered', label: 'Delivered', terminal: true },
  ],
  corporate: [
    { key: 'confirmed', label: 'Confirmed' },
    { key: 'sourcing', label: 'Sourcing' },
    { key: 'production', label: 'Production', external: true },
    { key: 'quality', label: 'Quality Check' },
    { key: 'ready', label: 'Ready' },
    { key: 'delivered', label: 'Delivered', terminal: true },
  ],
};

/** Every stage key used anywhere, for the CHECK constraint on order.stage. */
export const ALL_STAGE_KEYS = [
  ...new Set(Object.values(ORDER_PIPELINES).flatMap((stages) => stages.map((s) => s.key))),
].sort();

export const firstStage = (type: OrderType): string => ORDER_PIPELINES[type][0]!.key;

export function stageIndex(type: OrderType, stage: string): number {
  return ORDER_PIPELINES[type].findIndex((s) => s.key === stage);
}

/**
 * Moving backwards is allowed but unusual — the frontend warns before doing it
 * and the move is written to the timeline either way.
 */
export function stageMoveDirection(type: OrderType, from: string, to: string): 'forward' | 'backward' | 'same' | 'invalid' {
  const a = stageIndex(type, from);
  const b = stageIndex(type, to);
  if (a < 0 || b < 0) return 'invalid';
  return a === b ? 'same' : b > a ? 'forward' : 'backward';
}

export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  booking: 'Booking',
  custom: 'Custom / Made-to-Order',
  repair: 'Repair & Alteration',
  wedding: 'Bulk / Wedding',
  corporate: 'Corporate / Bulk Gifting',
};

/**
 * How an order is priced: at the rate the day it was taken (held, maybe with an
 * expiry), at the rate on the day it is billed, or at a rate agreed and typed in.
 */
export const RATE_LOCK_TYPES = ['booking', 'delivery', 'fixed'] as const;
export type RateLockType = (typeof RATE_LOCK_TYPES)[number];
