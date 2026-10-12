import type { Request, RequestHandler } from 'express';
import { AppError } from '../errors/app-error.js';

/**
 * Refuses a key once it has failed `limit` times inside the window. Successes
 * are never counted, so a busy counter signing staff in is never slowed down.
 * In memory: enough to slow guessing from one place; per-account lockout, in
 * the database, is the real guard.
 */
export function limitFailures(options: { limit: number; windowMs: number; key: (req: Request) => string; message: string }): RequestHandler {
  const failures = new Map<string, { count: number; resetAt: number }>();
  return (req, res, next) => {
    const key = options.key(req);
    const hit = failures.get(key);
    if (hit && hit.resetAt > Date.now() && hit.count >= options.limit) {
      return next(new AppError(options.message, 429, 'rate_limited'));
    }
    res.on('finish', () => {
      if (res.statusCode < 400 || res.statusCode === 429) return;
      const now = Date.now();
      const current = failures.get(key);
      if (current && current.resetAt > now) current.count += 1;
      else {
        if (failures.size >= 10_000) failures.clear();
        failures.set(key, { count: 1, resetAt: now + options.windowMs });
      }
    });
    next();
  };
}

/**
 * Caps every request for a key, successes included — for endpoints whose
 * refusals look like successes (a silent `null`), which `limitFailures` would
 * never count.
 */
export function limitRequests(options: { limit: number; windowMs: number; key: (req: Request) => string; message: string }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req, _res, next) => {
    const key = options.key(req);
    const now = Date.now();
    const hit = hits.get(key);
    if (hit && hit.resetAt > now) {
      if (hit.count >= options.limit) return next(new AppError(options.message, 429, 'rate_limited'));
      hit.count += 1;
    } else {
      if (hits.size >= 10_000) hits.clear();
      hits.set(key, { count: 1, resetAt: now + options.windowMs });
    }
    next();
  };
}
