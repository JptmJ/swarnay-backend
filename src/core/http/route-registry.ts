/**
 * One declaration per endpoint, used three ways.
 *
 *   defineRoute(...)  ──┬──►  the live Express route
 *                       ├──►  /dev-docs
 *                       └──►  the generated TypeScript client
 *
 * That is the whole point of this file. Documentation that is written by hand
 * beside the code drifts within a week; documentation generated from the same
 * object that validates the request cannot drift at all. If the body schema
 * changes, the docs and the client change with it on the next restart.
 */
import { Router, type RequestHandler, type Request, type Response } from 'express';
import { z, type ZodType } from 'zod';
import { handler as asyncHandler, requireModule, requirePermission, validate } from './middleware.js';
import { moduleGateFor } from '../../modules/tenancy/module-catalog.js';
import { logger } from '../util/logger.js';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface ResponseSpec {
  status: number;
  description: string;
  /** Omit for empty bodies such as 204. */
  schema?: ZodType;
}

export interface RouteChange {
  /** ISO date, e.g. "2026-09-18". */
  date: string;
  /** What changed, in the words a frontend developer needs. */
  note: string;
  kind: 'added' | 'changed' | 'fixed' | 'removed' | 'deprecated';
}

export interface RouteSpec {
  method: HttpMethod;
  /** Full path including the /api prefix, e.g. "/api/orders/:id/stage". */
  path: string;
  /** Module key from the catalog — groups the endpoint in the docs. */
  module: string;
  /** One line, shown in the endpoint list. */
  summary: string;
  /** Longer explanation, shown when the endpoint is expanded. */
  description?: string;
  /** Permission string checked before the handler runs. Omit for open routes. */
  permission?: string;
  /** Requires a signed-in user. Defaults to true. */
  auth?: boolean;
  /**
   * Which kind of token this route accepts.
   *   tenant   — a normal user of a jewellery business (the default)
   *   platform — a super admin / support engineer, who has no tenant
   * Routes under /api/platform are platform-scoped automatically.
   */
  scope?: 'tenant' | 'platform';
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
  responses: ResponseSpec[];
  /** Per-endpoint history, surfaced in the "Recently updated" feed. */
  changelog?: RouteChange[];
  /** Extra middleware that runs after auth and validation. */
  middleware?: RequestHandler[];
  handler: (req: Request, res: Response) => Promise<unknown>;
  /** Marks an endpoint that still works but should not be used in new code. */
  deprecated?: { since: string; useInstead?: string; note?: string };
  /**
   * Live and authorised like any other route, but left out of /dev-docs, the
   * generated client, Postman and the permission tree. For endpoints whose
   * very name should not be advertised. Concealment is never the only guard.
   */
  hidden?: boolean;
  /** Sends `Cache-Control: private, no-store` on every response, errors included. */
  noStore?: boolean;
}

const routes: RouteSpec[] = [];

export function defineRoute(spec: RouteSpec): RouteSpec {
  const duplicate = routes.find((r) => r.method === spec.method && r.path === spec.path);
  if (duplicate) {
    throw new Error(`Route ${spec.method.toUpperCase()} ${spec.path} is declared twice.`);
  }
  // Path is the source of truth for scope, so a platform route can never be
  // declared with tenant auth by accident.
  const scope = spec.scope ?? (spec.path.startsWith('/api/platform') ? 'platform' : 'tenant');
  routes.push({ ...spec, scope });
  return spec;
}

export const routeScope = (route: RouteSpec): 'tenant' | 'platform' =>
  route.scope ?? (route.path.startsWith('/api/platform') ? 'platform' : 'tenant');

/** Every documented route. Hidden routes are left out, so nothing generated from this lists them. */
export const allRoutes = (): RouteSpec[] => routes.filter((r) => !r.hidden);

/** Every route the server answers, hidden ones included. For audits, never for docs. */
export const liveRoutes = (): RouteSpec[] => [...routes];

export const routesByModule = (): Map<string, RouteSpec[]> => {
  const grouped = new Map<string, RouteSpec[]>();
  for (const route of allRoutes()) {
    const list = grouped.get(route.module) ?? [];
    list.push(route);
    grouped.set(route.module, list);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  }
  return grouped;
};

/**
 * Every change across every endpoint, newest first. This is what the
 * "Recently updated" panel at the top of /dev-docs reads.
 */
export function changeFeed(limit = 60): Array<RouteChange & { method: HttpMethod; path: string; module: string }> {
  return allRoutes()
    .flatMap((route) =>
      (route.changelog ?? []).map((change) => ({
        ...change,
        method: route.method,
        path: route.path,
        module: route.module,
      })),
    )
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

/**
 * Builds an Express router from the declared routes.
 *
 * `filter` lets the app mount tenant and platform routes on separate routers,
 * each behind its own authentication middleware.
 */
export function buildRouter(filter?: (route: RouteSpec) => boolean): Router {
  const router = Router();
  const selected = filter ? routes.filter(filter) : routes;

  for (const route of selected) {
    const chain: RequestHandler[] = [];

    if (route.noStore) chain.push((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
    if (route.permission) chain.push(requirePermission(route.permission));
    // A module switched off by the super admin is refused at the API, not just
    // hidden from the menu. Signed-out routes have no tenant to check.
    const gate = routeScope(route) === 'tenant' && route.auth !== false
      ? moduleGateFor(route.module, route.permission)
      : null;
    if (gate) chain.push(requireModule(gate));
    if (route.params || route.query || route.body) {
      chain.push(validate({ params: route.params, query: route.query, body: route.body }));
    }
    if (route.middleware) chain.push(...route.middleware);

    chain.push(
      asyncHandler(async (req, res) => {
        const result = await route.handler(req, res);
        // A handler may write the response itself; only send when it did not.
        if (!res.headersSent && result !== undefined) res.json(result);
        else if (!res.headersSent) res.status(204).end();
      }),
    );

    router[route.method](route.path, ...chain);
  }

  logger.debug({ routes: selected.length }, 'Routes registered on router');
  return router;
}

/** Converts a Zod schema to JSON Schema for the docs. Never throws. */
export function toJsonSchema(schema: ZodType | undefined, io: 'input' | 'output' = 'input'): unknown {
  if (!schema) return undefined;
  try {
    return z.toJSONSchema(schema, { io, unrepresentable: 'any', cycles: 'ref' });
  } catch (error) {
    logger.debug({ err: error }, 'Could not convert a schema for the docs');
    return { type: 'object', description: 'Schema could not be rendered automatically.' };
  }
}

/** ":id" style params, pulled out of the path for the docs table. */
export const pathParams = (path: string): string[] =>
  [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);

/**
 * Express types `req.query` loosely; `validate` has already parsed it against
 * the route's schema by the time a handler runs, so this is the narrowing every
 * handler would otherwise write by hand.
 */
export const queryOf = <T>(req: { query: unknown }): T => req.query as T;
export const bodyOf = <T>(req: { body: unknown }): T => req.body as T;
