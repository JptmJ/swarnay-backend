import { describe, expect, it } from 'vitest';
import {
  HIT_RADIUS, matchesPattern, pointDistance, validGatewayPath, validGatewayPoints, type GatewayPoint,
} from '../src/modules/security/gateway-rules.js';
import { toIsoDate } from '../src/api/routes.orders-import.js';

const stored: GatewayPoint[] = [{ x: 0.2, y: 0.3 }, { x: 0.5, y: 0.6 }, { x: 0.8, y: 0.3 }];

describe('private entry path', () => {
  it('accepts short lowercase private paths', () => {
    expect(validGatewayPath('/quiet-door')).toBe(true);
    expect(validGatewayPath('/abc/de/f')).toBe(true);
  });
  it('refuses app paths, traversal, queries and capitals', () => {
    for (const path of ['/api', '/api-x', '/settings', '/login/x', '/ab', '/Quiet', '/a/../b', '/door?x=1', '/door#x', 'door', '/a/b/c/d', '/%2e%2e']) {
      expect(validGatewayPath(path), path).toBe(false);
    }
  });
});

describe('private entry points', () => {
  it('needs exactly three separated points inside the safe area', () => {
    expect(validGatewayPoints(stored)).toBe(true);
    expect(validGatewayPoints(stored.slice(0, 2))).toBe(false);
    expect(validGatewayPoints([...stored.slice(0, 2), { x: 0.95, y: 0.5 }])).toBe(false);
    expect(validGatewayPoints([stored[0]!, { x: 0.21, y: 0.31 }, stored[2]!])).toBe(false);
    expect(validGatewayPoints([stored[0]!, stored[1]!, { x: Number.NaN, y: 0.5 }])).toBe(false);
  });

  it('matches clicks within the hit radius, in order only', () => {
    expect(matchesPattern(stored, stored)).toBe(true);
    const nudged = stored.map((p) => ({ x: p.x + (HIT_RADIUS - 1) / 640, y: p.y }));
    expect(matchesPattern(stored, nudged)).toBe(true);
    const outside = stored.map((p) => ({ x: p.x + (HIT_RADIUS + 1) / 640, y: p.y }));
    expect(matchesPattern(stored, outside)).toBe(false);
    expect(matchesPattern(stored, [stored[1]!, stored[0]!, stored[2]!])).toBe(false);
    expect(matchesPattern(stored, stored.slice(0, 2))).toBe(false);
  });

  it('measures distance in artwork units', () => {
    expect(pointDistance({ x: 0, y: 0 }, { x: 1, y: 0 })).toBe(640);
    expect(pointDistance({ x: 0, y: 0 }, { x: 0, y: 1 })).toBe(440);
  });
});

describe('import dates', () => {
  it('reads the ways a date is written in a sheet', () => {
    expect(toIsoDate('2026-10-09')).toBe('2026-10-09');
    expect(toIsoDate('09/10/2026')).toBe('2026-10-09');
    expect(toIsoDate('9-10-26')).toBe('2026-10-09');
    expect(toIsoDate('9.10.2026')).toBe('2026-10-09');
    expect(toIsoDate('46304')).toBe('2026-10-09');
    expect(toIsoDate('2026-10-09T00:00:00.000Z')).toBe('2026-10-09');
    expect(toIsoDate('')).toBeUndefined();
  });
  it('leaves impossible dates for validation to refuse', () => {
    expect(toIsoDate('31/02/2026')).toBe('31/02/2026');
    expect(toIsoDate('next week')).toBe('next week');
  });
});
