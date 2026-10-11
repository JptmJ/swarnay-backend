/**
 * The private entry's path and point rules — the same ones the shop app's
 * `src/utils/privateGateway.ts` uses, so a pattern that looks right in the
 * editor is judged the same way here.
 *
 * Points are normalised over the 404 artwork (viewBox 640×440): x and y run
 * 0–1 across its width and height, so a pattern survives any screen size.
 */
export interface GatewayPoint { x: number; y: number }

export const ARTWORK_VERSION = 1;
export const ARTWORK = { width: 640, height: 440 } as const;
/** A click within this many artwork units of the stored point counts as a hit. */
export const HIT_RADIUS = 44;
/** Two stored points must be this far apart, so their circles never overlap. */
export const MIN_SEPARATION = HIT_RADIUS * 2 + 8;
export const GRANT_LIFETIME_MS = 60_000;
export const ACCESS_LIFETIME_MS = 5 * 60_000;

const PATH_SHAPE = /^\/[a-z0-9][a-z0-9-]{2,63}(?:\/[a-z0-9][a-z0-9-]{0,63}){0,2}$/;
const RESERVED = /^\/(?:api|assets|locales|src|public|dev-docs|health|index|login|settings|admin|billing|dashboard|modules)(?:[./-]|$)/;

/** One to three lowercase segments, never a path the app itself uses. */
export const validGatewayPath = (path: string): boolean => PATH_SHAPE.test(path) && !RESERVED.test(path);

export const validGatewayPoint = (p: GatewayPoint): boolean =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0.07 && p.x <= 0.93 && p.y >= 0.1 && p.y <= 0.9;

export const pointDistance = (a: GatewayPoint, b: GatewayPoint): number =>
  Math.hypot((a.x - b.x) * ARTWORK.width, (a.y - b.y) * ARTWORK.height);

/** Exactly three points, inside the safe area, far enough apart. */
export const validGatewayPoints = (points: GatewayPoint[]): boolean =>
  Array.isArray(points) && points.length === 3 && points.every(validGatewayPoint)
  && points.every((p, i) => points.slice(i + 1).every((q) => pointDistance(p, q) >= MIN_SEPARATION));

/** In order: the first click must hit the first point, and so on. No sliding, no unordered matching. */
export const matchesPattern = (stored: GatewayPoint[], clicked: GatewayPoint[]): boolean =>
  stored.length === 3 && clicked.length === 3
  && clicked.every((p, i) => Number.isFinite(p.x) && Number.isFinite(p.y) && pointDistance(p, stored[i]!) <= HIT_RADIUS);
