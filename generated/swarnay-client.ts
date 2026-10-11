/**
 * Swarnay API client — GENERATED, DO NOT EDIT BY HAND.
 *
 * Regenerate with `npm run gen:client` in the backend, then copy this file
 * into the frontend. Every type here comes from the schema that validates the
 * real request, so a mismatch between this file and the server is impossible.
 *
 * Generated 2026-10-09T22:46:47.154Z from 226 endpoints.
 */

export interface ApiError {
  code: "validation_error" | "unauthorized" | "session_expired" | "invalid_credentials" | "account_locked" | "account_inactive" | "tenant_inactive" | "no_branch" | "rate_limited" | "forbidden" | "branch_forbidden" | "password_change_required" | "module_locked" | "module_disabled" | "module_required" | "not_found" | "duplicate" | "in_use" | "conflict" | "busy" | "check_failed" | "business_rule" | "insufficient_stock" | "rate_missing" | "numbering_series_missing" | "already_posted" | "backdating_not_allowed" | "invalid_stage_move" | "vault_disabled" | "vault_not_allowed" | "vault_passcode_invalid" | "vault_locked" | "vault_passcode_required" | "internal_error" | (string & {});
  message: string;
  details?: unknown;
  requestId?: string;
}

/** Thrown by every client method when the server returns a non-2xx response. */
export class SwarnayApiError extends Error {
  constructor(readonly status: number, readonly error: ApiError) {
    super(error.message);
    this.name = 'SwarnayApiError';
  }
  /** Field-level messages from a 400, ready to drop onto a form. */
  get fieldErrors(): Array<{ field: string; message: string }> {
    return Array.isArray(this.error.details) ? (this.error.details as Array<{ field: string; message: string }>) : [];
  }
}

export interface ClientOptions {
  baseUrl: string;
  /** Called before each request. Return null when signed out. */
  getToken?: () => string | null | undefined;
  /** Sent as X-Branch-Id, so the server knows which branch you are acting at. */
  getBranchId?: () => string | null | undefined;
  /** Called on a 401 so the app can refresh the token or sign the user out. */
  onUnauthorized?: () => void;
  fetch?: typeof globalThis.fetch;
}

export function createClient(options: ClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch;

  async function request<T>(
    method: string,
    path: string,
    init: { query?: Record<string, unknown>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(path, options.baseUrl);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const token = options.getToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    const branchId = options.getBranchId?.();
    if (branchId) headers['x-branch-id'] = branchId;

    const response = await doFetch(url.toString(), {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    if (response.status === 204) return undefined as T;

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) options.onUnauthorized?.();
      throw new SwarnayApiError(
        response.status,
        (payload as { error?: ApiError })?.error ?? { code: 'internal_error', message: response.statusText },
      );
    }
    return payload as T;
  }

  return {
    request,
    /**
     * Sign in
     *
     * Returns an access token and the whole session, so the app can render straight away. The refresh token is set as the httpOnly `sw_rt` cookie; call with `credentials: "include"`. After 20 failed attempts in a minute from one network for one shop, further attempts are refused for the rest of that minute.
     * `POST /api/auth/login`
     */
    postAuthLogin(body: {
      /** The shop code, e.g. "aarohi". */
      tenantCode: string;
      /** Email address or mobile number. */
      identifier: string;
      password: string;
      /** true: signed in for 30 days on this device. false: until the browser closes (12 hours at most). */
      remember?: boolean;
    }): Promise<{
      /** Send as `Authorization: Bearer <token>`. Lives 15 minutes; keep it in memory only. */
      accessToken: string;
      session: {
        user: {
          id: string;
          fullName: string;
          email: unknown;
          phone: unknown;
          /** True: show only the change-password screen; every other call is refused until it is done. */
          mustChangePassword: boolean;
        };
        tenant: {
          id: string;
          code: string;
          name: string;
          kind: string;
          status: string;
        };
        /** The branch this session works in. Send it back as `X-Branch-Id`. */
        branchId: string | null;
        branches: Array<{
          id: string;
          code: string;
          name: string;
        }>;
        roles: Array<string>;
        /** At the active branch. `*` or `module.*` are wildcards. */
        permissions: Array<string>;
        /** Modules this shop may see. Absent means never shown — a module switched off by the super admin is absent, and its endpoints answer 403 `module_disabled`. */
        modules: Array<{
          key: string;
          order: number;
          group: string;
          name: string;
          shortName: string;
          description: string;
          statusLabel: string;
          licence: "included" | "purchased" | "trial" | "expired";
          /** Held but lapsed: show disabled, with a renew prompt. */
          locked: boolean;
          trialEndsAt: unknown;
          expiresAt: unknown;
          subModules: Array<{
            key: string;
            name: string;
            status: string;
          }>;
          /** Sub-modules the super admin switched off, e.g. ["pos.purchase"]. Hide anything gated on a permission under them; the API answers 403 `module_disabled`. */
          disabledSubModules: Array<string>;
        }>;
        theme: {
          preset_key: string;
          css_variables: Record<string, unknown>;
          logo_url: unknown;
        };
        /** Non-null only when a Swarnay operator is inside this business through a support session. Show the support banner while it is set. */
        support: {
          sessionId: string;
          canWrite: boolean;
          endsAt: string;
        } | null;
      };
    }> {
      return request<{
      /** Send as `Authorization: Bearer <token>`. Lives 15 minutes; keep it in memory only. */
      accessToken: string;
      session: {
        user: {
          id: string;
          fullName: string;
          email: unknown;
          phone: unknown;
          /** True: show only the change-password screen; every other call is refused until it is done. */
          mustChangePassword: boolean;
        };
        tenant: {
          id: string;
          code: string;
          name: string;
          kind: string;
          status: string;
        };
        /** The branch this session works in. Send it back as `X-Branch-Id`. */
        branchId: string | null;
        branches: Array<{
          id: string;
          code: string;
          name: string;
        }>;
        roles: Array<string>;
        /** At the active branch. `*` or `module.*` are wildcards. */
        permissions: Array<string>;
        /** Modules this shop may see. Absent means never shown — a module switched off by the super admin is absent, and its endpoints answer 403 `module_disabled`. */
        modules: Array<{
          key: string;
          order: number;
          group: string;
          name: string;
          shortName: string;
          description: string;
          statusLabel: string;
          licence: "included" | "purchased" | "trial" | "expired";
          /** Held but lapsed: show disabled, with a renew prompt. */
          locked: boolean;
          trialEndsAt: unknown;
          expiresAt: unknown;
          subModules: Array<{
            key: string;
            name: string;
            status: string;
          }>;
          /** Sub-modules the super admin switched off, e.g. ["pos.purchase"]. Hide anything gated on a permission under them; the API answers 403 `module_disabled`. */
          disabledSubModules: Array<string>;
        }>;
        theme: {
          preset_key: string;
          css_variables: Record<string, unknown>;
          logo_url: unknown;
        };
        /** Non-null only when a Swarnay operator is inside this business through a support session. Show the support banner while it is set. */
        support: {
          sessionId: string;
          canWrite: boolean;
          endsAt: string;
        } | null;
      };
    }>('POST', "/api/auth/login", { body });
    },
    /**
     * Get a new access token
     *
     * Uses the `sw_rt` cookie and rotates it. Two calls within 30 seconds with the same cookie (a retry, or two tabs) both succeed; an old cookie presented later ends the whole sign-in.
     * `POST /api/auth/refresh`
     */
    postAuthRefresh(): Promise<{
      /** Send as `Authorization: Bearer <token>`. Lives 15 minutes; keep it in memory only. */
      accessToken: string;
    }> {
      return request<{
      /** Send as `Authorization: Bearer <token>`. Lives 15 minutes; keep it in memory only. */
      accessToken: string;
    }>('POST', "/api/auth/refresh");
    },
    /**
     * Sign out
     *
     * Ends this sign-in on every tab and clears the cookie. Safe to call when already signed out.
     * `POST /api/auth/logout`
     */
    postAuthLogout(): Promise<void> {
      return request<void>('POST', "/api/auth/logout");
    },
    /**
     * Change your own password
     *
     * Signs out every other device and returns a new access token for this one. The refresh token is set as the httpOnly `sw_rt` cookie; call with `credentials: "include"`.
     * `POST /api/me/password`
     */
    postMePassword(body: {
      currentPassword: string;
      newPassword: string;
    }): Promise<{
      /** Send as `Authorization: Bearer <token>`. Lives 15 minutes; keep it in memory only. */
      accessToken: string;
    }> {
      return request<{
      /** Send as `Authorization: Bearer <token>`. Lives 15 minutes; keep it in memory only. */
      accessToken: string;
    }>('POST', "/api/me/password", { body });
    },
    /**
     * The session: user, shop, branch, permissions, modules and theme
     *
     * The same `session` sign-in returns. Call it when the app opens, and with `X-Branch-Id` after switching branch.
     * `GET /api/me`
     */
    getMe(): Promise<{
      user: {
        id: string;
        fullName: string;
        email: unknown;
        phone: unknown;
        /** True: show only the change-password screen; every other call is refused until it is done. */
        mustChangePassword: boolean;
      };
      tenant: {
        id: string;
        code: string;
        name: string;
        kind: string;
        status: string;
      };
      /** The branch this session works in. Send it back as `X-Branch-Id`. */
      branchId: string | null;
      branches: Array<{
        id: string;
        code: string;
        name: string;
      }>;
      roles: Array<string>;
      /** At the active branch. `*` or `module.*` are wildcards. */
      permissions: Array<string>;
      /** Modules this shop may see. Absent means never shown — a module switched off by the super admin is absent, and its endpoints answer 403 `module_disabled`. */
      modules: Array<{
        key: string;
        order: number;
        group: string;
        name: string;
        shortName: string;
        description: string;
        statusLabel: string;
        licence: "included" | "purchased" | "trial" | "expired";
        /** Held but lapsed: show disabled, with a renew prompt. */
        locked: boolean;
        trialEndsAt: unknown;
        expiresAt: unknown;
        subModules: Array<{
          key: string;
          name: string;
          status: string;
        }>;
        /** Sub-modules the super admin switched off, e.g. ["pos.purchase"]. Hide anything gated on a permission under them; the API answers 403 `module_disabled`. */
        disabledSubModules: Array<string>;
      }>;
      theme: {
        preset_key: string;
        css_variables: Record<string, unknown>;
        logo_url: unknown;
      };
      /** Non-null only when a Swarnay operator is inside this business through a support session. Show the support banner while it is set. */
      support: {
        sessionId: string;
        canWrite: boolean;
        endsAt: string;
      } | null;
    }> {
      return request<{
      user: {
        id: string;
        fullName: string;
        email: unknown;
        phone: unknown;
        /** True: show only the change-password screen; every other call is refused until it is done. */
        mustChangePassword: boolean;
      };
      tenant: {
        id: string;
        code: string;
        name: string;
        kind: string;
        status: string;
      };
      /** The branch this session works in. Send it back as `X-Branch-Id`. */
      branchId: string | null;
      branches: Array<{
        id: string;
        code: string;
        name: string;
      }>;
      roles: Array<string>;
      /** At the active branch. `*` or `module.*` are wildcards. */
      permissions: Array<string>;
      /** Modules this shop may see. Absent means never shown — a module switched off by the super admin is absent, and its endpoints answer 403 `module_disabled`. */
      modules: Array<{
        key: string;
        order: number;
        group: string;
        name: string;
        shortName: string;
        description: string;
        statusLabel: string;
        licence: "included" | "purchased" | "trial" | "expired";
        /** Held but lapsed: show disabled, with a renew prompt. */
        locked: boolean;
        trialEndsAt: unknown;
        expiresAt: unknown;
        subModules: Array<{
          key: string;
          name: string;
          status: string;
        }>;
        /** Sub-modules the super admin switched off, e.g. ["pos.purchase"]. Hide anything gated on a permission under them; the API answers 403 `module_disabled`. */
        disabledSubModules: Array<string>;
      }>;
      theme: {
        preset_key: string;
        css_variables: Record<string, unknown>;
        logo_url: unknown;
      };
      /** Non-null only when a Swarnay operator is inside this business through a support session. Show the support banner while it is set. */
      support: {
        sessionId: string;
        canWrite: boolean;
        endsAt: string;
      } | null;
    }>('GET', "/api/me");
    },
    /**
     * The full module catalog, independent of any tenant
     *
     * Every module the platform offers. Used by the SaaS admin screen when provisioning.
     * `GET /api/tenancy/catalog`
     * Requires `platform.tenants.view`.
     */
    getTenancyCatalog(): Promise<{
      modules: Array<Record<string, unknown>>;
    }> {
      return request<{
      modules: Array<Record<string, unknown>>;
    }>('GET', "/api/tenancy/catalog");
    },
    /**
     * All settings with their effective values
     *
     * Each entry carries `value` (what applies now) and `source` (whether that came from a branch override, a tenant override, or the built-in default). Grouped by `group` so the settings screen can render tabs directly.
     * `GET /api/settings/config`
     * Requires `settings.config.view`.
     */
    getSettingsConfig(): Promise<{
      groups: Record<string, unknown>;
    }> {
      return request<{
      groups: Record<string, unknown>;
    }>('GET', "/api/settings/config");
    },
    /**
     * Change one setting
     *
     * Validated against the setting’s declared type. Settings marked `sensitive` change how past numbers are interpreted — warn before saving those.
     * `PUT /api/settings/config/:key`
     * Requires `settings.config.update`.
     */
    putSettingsConfigByKey(params: { key: string }, body: {
      /** Must match the setting’s declared type. */
      value: unknown;
      /** Only for branch-scoped settings. */
      branchId?: string | null;
      reason?: string;
    }): Promise<{
      ok: boolean;
      key: string;
    }> {
      return request<{
      ok: boolean;
      key: string;
    }>('PUT', `/api/settings/config/${encodeURIComponent(params.key)}`, { body });
    },
    /**
     * The active theme
     *
     * `GET /api/settings/theme`
     * Requires `settings.theme.view`.
     */
    getSettingsTheme(): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', "/api/settings/theme");
    },
    /**
     * Change the theme
     *
     * Preset keys match the frontend theme ids exactly.
     * `PUT /api/settings/theme`
     * Requires `settings.theme.update`.
     */
    putSettingsTheme(body: {
      preset_key: "deep-forest" | "royal-ruby" | "sapphire-platinum" | "obsidian-luxury" | "rose-gold" | "custom";
      /** CSS custom properties layered over the preset. */
      css_variables?: Record<string, unknown>;
      logo_url?: string | null;
      /** Null sets the tenant default. */
      branch_id?: string | null;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PUT', "/api/settings/theme", { body });
    },
    /**
     * The owner cockpit figures
     *
     * One call returns every headline metric the dashboard shows. Computed live; cache it on the client for a minute rather than polling.
     * `GET /api/dashboard/summary`
     * Requires `reports.owner.view`.
     */
    getDashboardSummary(query?: {
      branchId?: string;
    }): Promise<{
      stockValue: {
        total: string;
        goldWeight: string;
        silverWeight: string;
      };
      todaySales: {
        amount: string;
        count: number;
      };
      customers: {
        total: number;
      };
      pendingOrders: {
        count: number;
        value: string;
      };
      oldGoldToday: {
        weight: string;
        value: string;
      };
      schemeDue: {
        count: number;
        amount: string;
      };
      receivables: {
        amount: string;
        accounts: number;
      };
      alerts: Array<{
        key: string;
        label: string;
        count: number;
      }>;
    }> {
      return request<{
      stockValue: {
        total: string;
        goldWeight: string;
        silverWeight: string;
      };
      todaySales: {
        amount: string;
        count: number;
      };
      customers: {
        total: number;
      };
      pendingOrders: {
        count: number;
        value: string;
      };
      oldGoldToday: {
        weight: string;
        value: string;
      };
      schemeDue: {
        count: number;
        amount: string;
      };
      receivables: {
        amount: string;
        accounts: number;
      };
      alerts: Array<{
        key: string;
        label: string;
        count: number;
      }>;
    }>('GET', "/api/dashboard/summary", { query });
    },
    /**
     * The saved widget layout for the signed-in user
     *
     * Falls back to the role default when the user has not customised anything.
     * `GET /api/dashboard/layout`
     * Requires `reports.owner.view`.
     */
    getDashboardLayout(): Promise<{
      widgets: Array<Record<string, unknown>>;
      source: string;
    }> {
      return request<{
      widgets: Array<Record<string, unknown>>;
      source: string;
    }>('GET', "/api/dashboard/layout");
    },
    /**
     * Save the widget layout
     *
     * `PUT /api/dashboard/layout`
     * Requires `reports.owner.view`.
     */
    putDashboardLayout(body: {
      /** In display order. */
      widgets: Array<{
        key: string;
        visible?: boolean;
        section?: "overview" | "signals" | "insights" | "operations";
        order?: number;
      }>;
    }): Promise<{
      ok: boolean;
    }> {
      return request<{
      ok: boolean;
    }>('PUT', "/api/dashboard/layout", { body });
    },
    /**
     * List branchs
     *
     * Paginated. `total` is the count before paging, for the pager.
     * `GET /api/master/branches`
     * Requires `master.branch.view`.
     */
    getMasterBranches(query?: {
      /** Matches code, name, city. */
      search?: string;
      kind?: "showroom" | "factory" | "warehouse" | "office";
      is_active?: "true" | "false";
      /** From the previous page's nextCursor (large lists only). */
      cursor?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }>('GET', "/api/master/branches", { query });
    },
    /**
     * Get one branch
     *
     * `GET /api/master/branches/:id`
     * Requires `master.branch.view`.
     */
    getMasterBranchesById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/master/branches/${encodeURIComponent(params.id)}`);
    },
    /**
     * Create a branch
     *
     * `POST /api/master/branches`
     * Requires `master.branch.create`.
     */
    postMasterBranches(body: {
      code: string;
      name: string;
      kind?: "showroom" | "factory" | "warehouse" | "office";
      /** Its first two digits become state_code. */
      gstin?: string;
      /** Only needed without a GSTIN. */
      state_code?: string;
      address_line1?: string;
      city?: string;
      state?: string;
      pincode?: string;
      phone?: string;
      email?: string;
      /** Principal place of business. Setting it moves it from any other branch. */
      is_head_office?: boolean;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/master/branches", { body });
    },
    /**
     * Update a branch
     *
     * Only the fields you send are changed.
     * `PATCH /api/master/branches/:id`
     * Requires `master.branch.update`.
     */
    patchMasterBranchesById(params: { id: string }, body: {
      code?: string;
      name?: string;
      gstin?: string | null;
      state_code?: string | null;
      address_line1?: unknown;
      city?: unknown;
      state?: unknown;
      pincode?: unknown;
      phone?: unknown;
      email?: string | null;
      is_head_office?: boolean;
      is_active?: boolean;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PATCH', `/api/master/branches/${encodeURIComponent(params.id)}`, { body });
    },
    /**
     * Remove a branch
     *
     * Soft delete — the row stays for the audit trail and disappears from lists.
     * `DELETE /api/master/branches/:id`
     * Requires `master.branch.delete`.
     */
    deleteMasterBranchesById(params: { id: string }): Promise<void> {
      return request<void>('DELETE', `/api/master/branches/${encodeURIComponent(params.id)}`);
    },
    /**
     * List customer or suppliers
     *
     * Paginated. `total` is the count before paging, for the pager.
     * `GET /api/master/parties`
     * Requires `master.customer.view`.
     */
    getMasterParties(query?: {
      /** Matches name, phone, code. */
      search?: string;
      is_customer?: "true" | "false";
      is_supplier?: "true" | "false";
      is_active?: "true" | "false";
      city?: string;
      gstin?: string;
      /** From the previous page's nextCursor (large lists only). */
      cursor?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }>('GET', "/api/master/parties", { query });
    },
    /**
     * Get one customer or supplier
     *
     * `GET /api/master/parties/:id`
     * Requires `master.customer.view`.
     */
    getMasterPartiesById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/master/parties/${encodeURIComponent(params.id)}`);
    },
    /**
     * Create a customer or supplier
     *
     * `POST /api/master/parties`
     * Requires `master.customer.create`.
     */
    postMasterParties(body: {
      /** Leave out to get the next code, e.g. C000124. */
      code?: string;
      is_customer?: boolean;
      is_supplier?: boolean;
      /** Customer name is required. */
      name: string;
      party_type?: "individual" | "business";
      /** 10-digit Indian numbers are stored as +91XXXXXXXXXX. */
      phone?: string;
      email?: string;
      /** Its first two digits become state_code. */
      gstin?: string;
      pan?: string;
      state_code?: string;
      address_line1?: string;
      city?: string;
      state?: string;
      pincode?: string;
      /** Rupees, as a string. Never a float. */
      credit_limit?: string;
      credit_days?: number;
      date_of_birth?: string;
      anniversary?: string;
      notes?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/master/parties", { body });
    },
    /**
     * Update a customer or supplier
     *
     * Only the fields you send are changed.
     * `PATCH /api/master/parties/:id`
     * Requires `master.customer.update`.
     */
    patchMasterPartiesById(params: { id: string }, body: {
      name?: string | null;
      party_type?: "individual" | "business" | null;
      phone?: string | null;
      email?: string | null;
      gstin?: string | null;
      pan?: string | null;
      state_code?: string | null;
      address_line1?: unknown;
      city?: unknown;
      state?: unknown;
      pincode?: unknown;
      credit_limit?: string | null;
      credit_days?: number | null;
      date_of_birth?: unknown;
      anniversary?: unknown;
      notes?: unknown;
      is_customer?: unknown;
      is_supplier?: unknown;
      kyc_status?: "none" | "pending" | "verified" | "rejected" | null;
      is_active?: unknown;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PATCH', `/api/master/parties/${encodeURIComponent(params.id)}`, { body });
    },
    /**
     * Remove a customer or supplier
     *
     * Soft delete — the row stays for the audit trail and disappears from lists.
     * `DELETE /api/master/parties/:id`
     * Requires `master.customer.delete`.
     */
    deleteMasterPartiesById(params: { id: string }): Promise<void> {
      return request<void>('DELETE', `/api/master/parties/${encodeURIComponent(params.id)}`);
    },
    /**
     * List items
     *
     * Paginated. `total` is the count before paging, for the pager.
     * `GET /api/master/items`
     * Requires `master.item.view`.
     */
    getMasterItems(query?: {
      /** Matches code, name, hsn_code. */
      search?: string;
      nature?: "raw_metal" | "finished" | "stone" | "consumable" | "service";
      tracking?: "lot" | "piece";
      is_active?: "true" | "false";
      category_id?: string;
      /** From the previous page's nextCursor (large lists only). */
      cursor?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }>('GET', "/api/master/items", { query });
    },
    /**
     * Get one item
     *
     * `GET /api/master/items/:id`
     * Requires `master.item.view`.
     */
    getMasterItemsById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/master/items/${encodeURIComponent(params.id)}`);
    },
    /**
     * Create a item
     *
     * `POST /api/master/items`
     * Requires `master.item.create`.
     */
    postMasterItems(body: {
      code: string;
      name: string;
      nature?: "raw_metal" | "finished" | "stone" | "consumable" | "service";
      /** piece = individually tagged and counted. lot = bulk metal, measured in grams only. */
      tracking?: "lot" | "piece";
      category_id?: string;
      metal_id?: string;
      default_purity_id?: string;
      /** 7113 for jewellery articles. */
      hsn_code?: string;
      uom?: "gram" | "piece" | "carat" | "millilitre";
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/master/items", { body });
    },
    /**
     * Update a item
     *
     * Only the fields you send are changed.
     * `PATCH /api/master/items/:id`
     * Requires `master.item.update`.
     */
    patchMasterItemsById(params: { id: string }, body: {
      name?: string;
      category_id?: string | null;
      default_purity_id?: string | null;
      hsn_code?: unknown;
      is_active?: boolean;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PATCH', `/api/master/items/${encodeURIComponent(params.id)}`, { body });
    },
    /**
     * Remove a item
     *
     * Soft delete — the row stays for the audit trail and disappears from lists.
     * `DELETE /api/master/items/:id`
     * Requires `master.item.delete`.
     */
    deleteMasterItemsById(params: { id: string }): Promise<void> {
      return request<void>('DELETE', `/api/master/items/${encodeURIComponent(params.id)}`);
    },
    /**
     * List categorys
     *
     * Paginated. `total` is the count before paging, for the pager.
     * `GET /api/master/categories`
     * Requires `master.item.view`.
     */
    getMasterCategories(query?: {
      /** Matches code, name. */
      search?: string;
      is_active?: "true" | "false";
      /** From the previous page's nextCursor (large lists only). */
      cursor?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }>('GET', "/api/master/categories", { query });
    },
    /**
     * Get one category
     *
     * `GET /api/master/categories/:id`
     * Requires `master.item.view`.
     */
    getMasterCategoriesById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/master/categories/${encodeURIComponent(params.id)}`);
    },
    /**
     * Create a category
     *
     * `POST /api/master/categories`
     * Requires `master.item.create`.
     */
    postMasterCategories(body: {
      code: string;
      parent_id?: string;
      name: string;
      hsn_code?: string;
      /** Names shown under the category. */
      sub_categories?: Array<string>;
      /** Metal codes. Empty = any metal. */
      applicable_metals?: Array<string>;
      /** Default making-charge rule. */
      making_rule_id?: string;
      sort_order?: number;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/master/categories", { body });
    },
    /**
     * Update a category
     *
     * Only the fields you send are changed.
     * `PATCH /api/master/categories/:id`
     * Requires `master.item.update`.
     */
    patchMasterCategoriesById(params: { id: string }, body: {
      code?: string;
      name?: string;
      hsn_code?: string | null;
      /** Names shown under the category. */
      sub_categories?: Array<string>;
      /** Metal codes. Empty = any metal. */
      applicable_metals?: Array<string>;
      making_rule_id?: string | null;
      sort_order?: number;
      is_active?: boolean;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PATCH', `/api/master/categories/${encodeURIComponent(params.id)}`, { body });
    },
    /**
     * Remove a category
     *
     * Hard delete. Fails if anything references it.
     * `DELETE /api/master/categories/:id`
     * Requires `master.item.delete`.
     */
    deleteMasterCategoriesById(params: { id: string }): Promise<void> {
      return request<void>('DELETE', `/api/master/categories/${encodeURIComponent(params.id)}`);
    },
    /**
     * List puritys
     *
     * Paginated. `total` is the count before paging, for the pager.
     * `GET /api/master/purities`
     * Requires `master.purity.view`.
     */
    getMasterPurities(query?: {
      /** Matches code, name. */
      search?: string;
      metal_id?: string;
      is_active?: "true" | "false";
      /** From the previous page's nextCursor (large lists only). */
      cursor?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }>('GET', "/api/master/purities", { query });
    },
    /**
     * Get one purity
     *
     * `GET /api/master/purities/:id`
     * Requires `master.purity.view`.
     */
    getMasterPuritiesById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/master/purities/${encodeURIComponent(params.id)}`);
    },
    /**
     * Create a purity
     *
     * `POST /api/master/purities`
     * Requires `master.purity.create`.
     */
    postMasterPurities(body: {
      metal_id: string;
      name: string;
      /** e.g. 22K. Left out: taken from the name. */
      code?: string;
      /** 91.600 for 22K. Everything calculates from this. */
      fineness_percent: string;
      is_hallmarkable?: boolean;
      /** Left out: placed after the metal’s other purities. */
      sort_order?: number;
      /** How it is written: 22K, 916 or 91.6%. */
      notation?: "karat" | "fineness" | "percentage";
      /** Unit forms start in. Stored weights are always grams. */
      default_unit?: "g" | "kg" | "tola" | "oz";
      /** Pre-selected for its metal. Setting it moves it from the metal’s other purities. */
      is_default?: boolean;
      description?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/master/purities", { body });
    },
    /**
     * Update a purity
     *
     * Only the fields you send are changed.
     * `PATCH /api/master/purities/:id`
     * Requires `master.purity.update`.
     */
    patchMasterPuritiesById(params: { id: string }, body: {
      name?: string;
      fineness_percent?: string;
      is_hallmarkable?: boolean;
      is_active?: boolean;
      sort_order?: number;
      /** How it is written: 22K, 916 or 91.6%. */
      notation?: "karat" | "fineness" | "percentage";
      /** Unit forms start in. Stored weights are always grams. */
      default_unit?: "g" | "kg" | "tola" | "oz";
      /** Pre-selected for its metal. Setting it moves it from the metal’s other purities. */
      is_default?: boolean;
      description?: string | null;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PATCH', `/api/master/purities/${encodeURIComponent(params.id)}`, { body });
    },
    /**
     * Remove a purity
     *
     * Hard delete. Fails if anything references it.
     * `DELETE /api/master/purities/:id`
     * Requires `master.purity.delete`.
     */
    deleteMasterPuritiesById(params: { id: string }): Promise<void> {
      return request<void>('DELETE', `/api/master/purities/${encodeURIComponent(params.id)}`);
    },
    /**
     * List metals
     *
     * Paginated. `total` is the count before paging, for the pager.
     * `GET /api/master/metals`
     * Requires `master.purity.view`.
     */
    getMasterMetals(query?: {
      /** Matches code, name. */
      search?: string;
      /** From the previous page's nextCursor (large lists only). */
      cursor?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }>('GET', "/api/master/metals", { query });
    },
    /**
     * Get one metal
     *
     * `GET /api/master/metals/:id`
     * Requires `master.purity.view`.
     */
    getMasterMetalsById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/master/metals/${encodeURIComponent(params.id)}`);
    },
    /**
     * Create a metal
     *
     * `POST /api/master/metals`
     * Requires `master.purity.create`.
     */
    postMasterMetals(body: {
      code: string;
      name: string;
      hsn_code?: string;
      sort_order?: number;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/master/metals", { body });
    },
    /**
     * Update a metal
     *
     * Only the fields you send are changed.
     * `PATCH /api/master/metals/:id`
     * Requires `master.purity.update`.
     */
    patchMasterMetalsById(params: { id: string }, body: {
      name?: string;
      is_active?: boolean;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PATCH', `/api/master/metals/${encodeURIComponent(params.id)}`, { body });
    },
    /**
     * Remove a metal
     *
     * Hard delete. Fails if anything references it.
     * `DELETE /api/master/metals/:id`
     * Requires `master.purity.delete`.
     */
    deleteMasterMetalsById(params: { id: string }): Promise<void> {
      return request<void>('DELETE', `/api/master/metals/${encodeURIComponent(params.id)}`);
    },
    /**
     * List karigars
     *
     * Paginated. `total` is the count before paging, for the pager.
     * `GET /api/master/karigars`
     * Requires `master.karigar.view`.
     */
    getMasterKarigars(query?: {
      /** Matches code, name, workshop_name, speciality. */
      search?: string;
      engagement?: "in_house" | "external";
      is_active?: "true" | "false";
      /** From the previous page's nextCursor (large lists only). */
      cursor?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }>('GET', "/api/master/karigars", { query });
    },
    /**
     * Get one karigar
     *
     * `GET /api/master/karigars/:id`
     * Requires `master.karigar.view`.
     */
    getMasterKarigarsById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/master/karigars/${encodeURIComponent(params.id)}`);
    },
    /**
     * Create a karigar
     *
     * `POST /api/master/karigars`
     * Requires `master.karigar.create`.
     */
    postMasterKarigars(body: {
      /** Leave out to get the next code, e.g. K0012. */
      code?: string;
      name: string;
      workshop_name?: string;
      engagement?: "in_house" | "external";
      /** e.g. "Bridal Sets", "Kundan Meena". */
      speciality?: string;
      phone?: string;
      address?: string;
      pan?: string;
      gstin?: string;
      /** Agreed metal loss allowance, in percent. */
      standard_ghat_percent?: string;
      /** Rupees, as a string. Never a float. */
      labour_rate_per_gram?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/master/karigars", { body });
    },
    /**
     * Update a karigar
     *
     * Only the fields you send are changed.
     * `PATCH /api/master/karigars/:id`
     * Requires `master.karigar.update`.
     */
    patchMasterKarigarsById(params: { id: string }, body: {
      name?: string | null;
      workshop_name?: unknown;
      engagement?: "in_house" | "external" | null;
      speciality?: string | null;
      phone?: unknown;
      address?: unknown;
      pan?: string | null;
      gstin?: string | null;
      standard_ghat_percent?: string | null;
      labour_rate_per_gram?: string | null;
      is_active?: boolean;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PATCH', `/api/master/karigars/${encodeURIComponent(params.id)}`, { body });
    },
    /**
     * Remove a karigar
     *
     * Soft delete — the row stays for the audit trail and disappears from lists.
     * `DELETE /api/master/karigars/:id`
     * Requires `master.karigar.delete`.
     */
    deleteMasterKarigarsById(params: { id: string }): Promise<void> {
      return request<void>('DELETE', `/api/master/karigars/${encodeURIComponent(params.id)}`);
    },
    /**
     * List stock locations
     *
     * Paginated. `total` is the count before paging, for the pager.
     * `GET /api/master/locations`
     * Requires `master.branch.view`.
     */
    getMasterLocations(query?: {
      /** Matches code, name. */
      search?: string;
      branch_id?: string;
      kind?: "counter" | "vault" | "window" | "floor" | "transit" | "karigar";
      /** From the previous page's nextCursor (large lists only). */
      cursor?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }>('GET', "/api/master/locations", { query });
    },
    /**
     * Get one stock location
     *
     * `GET /api/master/locations/:id`
     * Requires `master.branch.view`.
     */
    getMasterLocationsById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/master/locations/${encodeURIComponent(params.id)}`);
    },
    /**
     * Create a stock location
     *
     * `POST /api/master/locations`
     * Requires `master.branch.create`.
     */
    postMasterLocations(body: {
      branch_id: string;
      code: string;
      name: string;
      kind?: "counter" | "vault" | "window" | "floor" | "transit" | "karigar";
      is_default?: boolean;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/master/locations", { body });
    },
    /**
     * Update a stock location
     *
     * Only the fields you send are changed.
     * `PATCH /api/master/locations/:id`
     * Requires `master.branch.update`.
     */
    patchMasterLocationsById(params: { id: string }, body: {
      name?: string;
      is_default?: boolean;
      is_active?: boolean;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PATCH', `/api/master/locations/${encodeURIComponent(params.id)}`, { body });
    },
    /**
     * Remove a stock location
     *
     * Soft delete — the row stays for the audit trail and disappears from lists.
     * `DELETE /api/master/locations/:id`
     * Requires `master.branch.delete`.
     */
    deleteMasterLocationsById(params: { id: string }): Promise<void> {
      return request<void>('DELETE', `/api/master/locations/${encodeURIComponent(params.id)}`);
    },
    /**
     * Today’s rate for every active purity
     *
     * One row per active purity, with its latest rate (a branch rate beats the shared one) and the last rate before today, for the day’s change. A purity with no rate yet has null rate fields — POS refuses to bill it with `rate_missing`.
     * 
     * Send `configured=true` for the Rates screen: only the metal + purity pairs the shop has set a rate for. `is_today` is false for a rate last set before today (shop time zone), so the screen can ask for today’s rate.
     * `GET /api/master/rates/current`
     * Requires `master.rates.view`.
     */
    getMasterRatesCurrent(query?: {
      branchId?: string;
      /** true = only purities that have a rate. */
      configured?: "true" | "false";
    }): Promise<{
      rates: Array<{
        purity_id: string;
        purity_code: string;
        purity_name: string;
        fineness_percent: string;
        metal_id: string;
        metal_code: string;
        metal_name: string;
        id: string | null;
        rate_per_gram: string | null;
        buying_rate_per_gram: string | null;
        effective_from: unknown;
        source: unknown;
        /** Last rate set before today (shop time zone). */
        previous_rate_per_gram: string | null;
        /** Null = the rate is shared by every branch. */
        rate_branch_id: string | null;
        /** Who set the current rate. */
        set_by_name: unknown;
        /** The current rate was set today. */
        is_today: boolean;
      }>;
    }> {
      return request<{
      rates: Array<{
        purity_id: string;
        purity_code: string;
        purity_name: string;
        fineness_percent: string;
        metal_id: string;
        metal_code: string;
        metal_name: string;
        id: string | null;
        rate_per_gram: string | null;
        buying_rate_per_gram: string | null;
        effective_from: unknown;
        source: unknown;
        /** Last rate set before today (shop time zone). */
        previous_rate_per_gram: string | null;
        /** Null = the rate is shared by every branch. */
        rate_branch_id: string | null;
        /** Who set the current rate. */
        set_by_name: unknown;
        /** The current rate was set today. */
        is_today: boolean;
      }>;
    }>('GET', "/api/master/rates/current", { query });
    },
    /**
     * Set today’s rate for a metal and purity
     *
     * A new rate is a new row — rates are never edited. Yesterday’s invoices keep pointing at yesterday’s rate, so an old bill can always be explained. Setting a rate for a purity that was removed puts it back on the list. Every screen that picks a metal and purity — billing, orders, old gold, purchase, schemes — uses the latest rate set here.
     * `POST /api/master/rates`
     * Requires `master.rates.create`.
     */
    postMasterRates(body: {
      metal_id: string;
      /** Omit for a pure-metal rate. */
      purity_id?: string;
      /** Sale / billing rate. */
      rate_per_gram: string;
      /** Purchase / buying rate — what you pay for old gold. Normally lower. */
      buying_rate_per_gram?: string;
      /** Omit to broadcast to every branch. */
      branch_id?: string;
      /** Defaults to now. */
      effective_from?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/master/rates", { body });
    },
    /**
     * Remove a metal + purity from the rate list
     *
     * Nothing is deleted: its rates stay in history and on every bill that used them, but no new price is taken from them, so billing that purity is refused with `rate_missing` until a rate is set again. Applies to every branch.
     * `DELETE /api/master/rates/:purityId`
     * Requires `master.rates.delete`.
     */
    deleteMasterRatesByPurityId(params: { purityId: string }): Promise<{
      retired: number;
    }> {
      return request<{
      retired: number;
    }>('DELETE', `/api/master/rates/${encodeURIComponent(params.purityId)}`);
    },
    /**
     * Rate history for a purity
     *
     * Every rate set in the window, newest first, including removed ones (`retired_at` set) and who set each.
     * `GET /api/master/rates/history`
     * Requires `master.rates.view`.
     */
    getMasterRatesHistory(query?: {
      purityId: string;
      days?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
    }>('GET', "/api/master/rates/history", { query });
    },
    /**
     * List GST rates
     *
     * Paginated. `total` is the count before paging, for the pager.
     * `GET /api/master/gst-rates`
     * Requires `master.tax.view`.
     */
    getMasterGstrates(query?: {
      /** Matches hsn_code, description. */
      search?: string;
      hsn_code?: string;
      component?: "metal" | "making" | "stone" | "service" | "hallmark" | "other";
      code_type?: "hsn" | "sac";
      /** From the previous page's nextCursor (large lists only). */
      cursor?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }>('GET', "/api/master/gst-rates", { query });
    },
    /**
     * Get one GST rate
     *
     * `GET /api/master/gst-rates/:id`
     * Requires `master.tax.view`.
     */
    getMasterGstratesById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/master/gst-rates/${encodeURIComponent(params.id)}`);
    },
    /**
     * Create a GST rate
     *
     * `POST /api/master/gst-rates`
     * Requires `master.tax.create`.
     */
    postMasterGstrates(body: {
      hsn_code: string;
      code_type?: "hsn" | "sac";
      description?: string;
      component: "metal" | "making" | "stone" | "service" | "hallmark" | "other";
      /** Total GST %, e.g. 3. CGST/SGST/IGST are derived from it. */
      gst_rate: string;
      cess_rate?: string;
      is_reverse_charge?: boolean;
      effective_from: string;
      /** Notification number or CA confirmation. */
      source_note?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/master/gst-rates", { body });
    },
    /**
     * Update a GST rate
     *
     * Only the fields you send are changed.
     * `PATCH /api/master/gst-rates/:id`
     * Requires `master.tax.update`.
     */
    patchMasterGstratesById(params: { id: string }, body: {
      description?: string | null;
      source_note?: string | null;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PATCH', `/api/master/gst-rates/${encodeURIComponent(params.id)}`, { body });
    },
    /**
     * Remove a GST rate
     *
     * Hard delete. Fails if anything references it.
     * `DELETE /api/master/gst-rates/:id`
     * Requires `master.tax.delete`.
     */
    deleteMasterGstratesById(params: { id: string }): Promise<void> {
      return request<void>('DELETE', `/api/master/gst-rates/${encodeURIComponent(params.id)}`);
    },
    /**
     * List price rules
     *
     * Paginated. `total` is the count before paging, for the pager.
     * `GET /api/master/price-rules`
     * Requires `master.pricing.view`.
     */
    getMasterPricerules(query?: {
      /** Matches code, name. */
      search?: string;
      applies_to?: "making" | "wastage" | "stone" | "hallmark" | "discount";
      is_active?: "true" | "false";
      metal_id?: string;
      item_category_id?: string;
      branch_id?: string;
      /** From the previous page's nextCursor (large lists only). */
      cursor?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }>('GET', "/api/master/price-rules", { query });
    },
    /**
     * Get one price rule
     *
     * `GET /api/master/price-rules/:id`
     * Requires `master.pricing.view`.
     */
    getMasterPricerulesById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/master/price-rules/${encodeURIComponent(params.id)}`);
    },
    /**
     * Create a price rule
     *
     * `POST /api/master/price-rules`
     * Requires `master.pricing.create`.
     */
    postMasterPricerules(body: {
      code: string;
      name: string;
      /** Stones are priced from the value on each tag; discounts are given on the bill, on making and wastage. */
      applies_to: "making" | "wastage" | "hallmark";
      basis: "per_gram" | "percent" | "flat" | "slab" | "hybrid";
      rate?: string | null;
      flat_amount?: string | null;
      slabs?: Array<{
        fromG: string;
        toG: string | null;
        rate: string;
      }>;
      slab_mode?: "whole" | "tiered";
      minimum_amount?: string | null;
      metal_id?: string | null;
      purity_id?: string | null;
      item_category_id?: string | null;
      item_id?: string | null;
      branch_id?: string | null;
      priority?: number;
      effective_from?: string;
      effective_to?: string | null;
      is_active?: boolean;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/master/price-rules", { body });
    },
    /**
     * Update a price rule
     *
     * Only the fields you send are changed.
     * `PATCH /api/master/price-rules/:id`
     * Requires `master.pricing.update`.
     */
    patchMasterPricerulesById(params: { id: string }, body: {
      name?: string;
      /** Stones are priced from the value on each tag; discounts are given on the bill, on making and wastage. */
      applies_to?: "making" | "wastage" | "hallmark";
      basis?: "per_gram" | "percent" | "flat" | "slab" | "hybrid";
      rate?: string | null;
      flat_amount?: string | null;
      slabs?: Array<{
        fromG: string;
        toG: string | null;
        rate: string;
      }>;
      slab_mode?: "whole" | "tiered";
      minimum_amount?: string | null;
      metal_id?: string | null;
      purity_id?: string | null;
      item_category_id?: string | null;
      item_id?: string | null;
      branch_id?: string | null;
      priority?: number;
      effective_from?: string;
      effective_to?: string | null;
      is_active?: boolean;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PATCH', `/api/master/price-rules/${encodeURIComponent(params.id)}`, { body });
    },
    /**
     * Remove a price rule
     *
     * Soft delete — the row stays for the audit trail and disappears from lists.
     * `DELETE /api/master/price-rules/:id`
     * Requires `master.pricing.delete`.
     */
    deleteMasterPricerulesById(params: { id: string }): Promise<void> {
      return request<void>('DELETE', `/api/master/price-rules/${encodeURIComponent(params.id)}`);
    },
    /**
     * List payment methods
     *
     * Paginated. `total` is the count before paging, for the pager.
     * `GET /api/master/payment-methods`
     * Requires `master.payment.view`.
     */
    getMasterPaymentmethods(query?: {
      /** Matches code, name. */
      search?: string;
      kind?: "cash" | "card" | "upi" | "bank_transfer" | "cheque" | "credit" | "old_gold" | "scheme" | "advance" | "emi" | "wallet";
      is_active?: "true" | "false";
      /** From the previous page's nextCursor (large lists only). */
      cursor?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }>('GET', "/api/master/payment-methods", { query });
    },
    /**
     * Get one payment method
     *
     * `GET /api/master/payment-methods/:id`
     * Requires `master.payment.view`.
     */
    getMasterPaymentmethodsById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/master/payment-methods/${encodeURIComponent(params.id)}`);
    },
    /**
     * Create a payment method
     *
     * `POST /api/master/payment-methods`
     * Requires `master.payment.create`.
     */
    postMasterPaymentmethods(body: {
      name: string;
      /** Ledger the money lands in. */
      account_id?: string | null;
      requires_reference?: boolean;
      charges_percent?: string | null;
      /** Per-tender limit. Empty = no limit. */
      max_amount?: string | null;
      sort_order?: number;
      is_active?: boolean;
      code: string;
      /** How the system settles it. Cannot be changed later. */
      kind: "cash" | "card" | "upi" | "bank_transfer" | "cheque" | "credit" | "old_gold" | "scheme" | "advance" | "emi" | "wallet";
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/master/payment-methods", { body });
    },
    /**
     * Update a payment method
     *
     * Only the fields you send are changed.
     * `PATCH /api/master/payment-methods/:id`
     * Requires `master.payment.update`.
     */
    patchMasterPaymentmethodsById(params: { id: string }, body: {
      name?: string;
      /** Ledger the money lands in. */
      account_id?: string | null;
      requires_reference?: boolean;
      charges_percent?: string | null;
      /** Per-tender limit. Empty = no limit. */
      max_amount?: string | null;
      sort_order?: number;
      is_active?: boolean;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PATCH', `/api/master/payment-methods/${encodeURIComponent(params.id)}`, { body });
    },
    /**
     * Remove a payment method
     *
     * Soft delete — the row stays for the audit trail and disappears from lists.
     * `DELETE /api/master/payment-methods/:id`
     * Requires `master.payment.delete`.
     */
    deleteMasterPaymentmethodsById(params: { id: string }): Promise<void> {
      return request<void>('DELETE', `/api/master/payment-methods/${encodeURIComponent(params.id)}`);
    },
    /**
     * Choose which branches offer this payment method
     *
     * Send the full list. An empty list means every branch.
     * `PUT /api/master/payment-methods/:id/branches`
     * Requires `master.payment.update`.
     */
    putMasterPaymentmethodsByIdBranches(params: { id: string }, body: {
      branchIds: Array<string>;
    }): Promise<void> {
      return request<void>('PUT', `/api/master/payment-methods/${encodeURIComponent(params.id)}/branches`, { body });
    },
    /**
     * Bill number series
     *
     * One entry per document type. The preview is worked out by the same code that numbers real documents.
     * `GET /api/master/numbering`
     * Requires `settings.numbering.view`.
     */
    getMasterNumbering(): Promise<{
      rows: Array<{
        id: string;
        docType: string;
        name: string;
        prefix: string;
        digitPadding: number;
        /** The last number handed out in the current period. 0 = none yet. */
        lastNumber: number;
        /** Counter starts again at 1 each April. */
        financialYearReset: boolean;
        financialYearFormat: "YY-YY" | "YYYY" | "none";
        branchScope: "shared" | "per_branch";
        /** Exactly what the next document at your branch will get. */
        nextNumberPreview: string;
      }>;
    }> {
      return request<{
      rows: Array<{
        id: string;
        docType: string;
        name: string;
        prefix: string;
        digitPadding: number;
        /** The last number handed out in the current period. 0 = none yet. */
        lastNumber: number;
        /** Counter starts again at 1 each April. */
        financialYearReset: boolean;
        financialYearFormat: "YY-YY" | "YYYY" | "none";
        branchScope: "shared" | "per_branch";
        /** Exactly what the next document at your branch will get. */
        nextNumberPreview: string;
      }>;
    }>('GET', "/api/master/numbering");
    },
    /**
     * Change a bill number series
     *
     * Shared: one counter for all branches. Per branch: each branch counts on its own and its code is part of the number, so two branches can never produce the same number. `lastNumber` can only move forward (e.g. to continue from old software); going back would reissue numbers.
     * `PATCH /api/master/numbering/:id`
     * Requires `settings.numbering.update`.
     */
    patchMasterNumberingById(params: { id: string }, body: {
      name?: string;
      prefix: string;
      digitPadding: number;
      lastNumber?: number;
      financialYearReset: boolean;
      financialYearFormat: "YY-YY" | "YYYY" | "none";
      branchScope: "shared" | "per_branch";
    }): Promise<{
      id: string;
      docType: string;
      name: string;
      prefix: string;
      digitPadding: number;
      /** The last number handed out in the current period. 0 = none yet. */
      lastNumber: number;
      /** Counter starts again at 1 each April. */
      financialYearReset: boolean;
      financialYearFormat: "YY-YY" | "YYYY" | "none";
      branchScope: "shared" | "per_branch";
      /** Exactly what the next document at your branch will get. */
      nextNumberPreview: string;
    }> {
      return request<{
      id: string;
      docType: string;
      name: string;
      prefix: string;
      digitPadding: number;
      /** The last number handed out in the current period. 0 = none yet. */
      lastNumber: number;
      /** Counter starts again at 1 each April. */
      financialYearReset: boolean;
      financialYearFormat: "YY-YY" | "YYYY" | "none";
      branchScope: "shared" | "per_branch";
      /** Exactly what the next document at your branch will get. */
      nextNumberPreview: string;
    }>('PATCH', `/api/master/numbering/${encodeURIComponent(params.id)}`, { body });
    },
    /**
     * Print formats
     *
     * A business that has none yet gets the six standard formats on first call.
     * `GET /api/master/document-formats`
     * Requires `master.documents.view`.
     */
    getMasterDocumentformats(): Promise<{
      rows: Array<{
        id: string;
        code: string;
        doc_type: "invoice" | "advance_receipt" | "old_gold_voucher" | "scheme_receipt" | "girvi_pawn_ticket";
        title: string;
        paper_size: "A4" | "A5" | "Thermal_80mm" | "Thermal_3inch";
        header_style: "logo_top" | "letterhead_preprinted" | "minimal";
        numbering_doc_type: unknown;
        field_toggles: Record<string, unknown>;
        terms: string;
        updated_at: string;
      }>;
    }> {
      return request<{
      rows: Array<{
        id: string;
        code: string;
        doc_type: "invoice" | "advance_receipt" | "old_gold_voucher" | "scheme_receipt" | "girvi_pawn_ticket";
        title: string;
        paper_size: "A4" | "A5" | "Thermal_80mm" | "Thermal_3inch";
        header_style: "logo_top" | "letterhead_preprinted" | "minimal";
        numbering_doc_type: unknown;
        field_toggles: Record<string, unknown>;
        terms: string;
        updated_at: string;
      }>;
    }>('GET', "/api/master/document-formats");
    },
    /**
     * Change a print format
     *
     * Send only what changed. `field_toggles` is merged, so one switch can be sent on its own.
     * `PATCH /api/master/document-formats/:id`
     * Requires `master.documents.update`.
     */
    patchMasterDocumentformatsById(params: { id: string }, body: {
      title?: string;
      paper_size?: "A4" | "A5" | "Thermal_80mm" | "Thermal_3inch";
      header_style?: "logo_top" | "letterhead_preprinted" | "minimal";
      field_toggles?: {
        showWeightBreakdown?: boolean;
        showGstSplit?: boolean;
        showHuidList?: boolean;
        showQrCode?: boolean;
        showBankDetails?: boolean;
        showTermsAndConditions?: boolean;
        showCashierSignature?: boolean;
        showCustomerSignature?: boolean;
      };
      terms?: string;
    }): Promise<{
      id: string;
      code: string;
      doc_type: "invoice" | "advance_receipt" | "old_gold_voucher" | "scheme_receipt" | "girvi_pawn_ticket";
      title: string;
      paper_size: "A4" | "A5" | "Thermal_80mm" | "Thermal_3inch";
      header_style: "logo_top" | "letterhead_preprinted" | "minimal";
      numbering_doc_type: unknown;
      field_toggles: Record<string, unknown>;
      terms: string;
      updated_at: string;
    }> {
      return request<{
      id: string;
      code: string;
      doc_type: "invoice" | "advance_receipt" | "old_gold_voucher" | "scheme_receipt" | "girvi_pawn_ticket";
      title: string;
      paper_size: "A4" | "A5" | "Thermal_80mm" | "Thermal_3inch";
      header_style: "logo_top" | "letterhead_preprinted" | "minimal";
      numbering_doc_type: unknown;
      field_toggles: Record<string, unknown>;
      terms: string;
      updated_at: string;
    }>('PATCH', `/api/master/document-formats/${encodeURIComponent(params.id)}`, { body });
    },
    /**
     * Import masters in bulk
     *
     * kind: customers, karigars, categories or items. Up to 1,000 rows a call; send a big file as several calls, passing `firstRow` so errors name the spreadsheet row. Matched on `code`: an existing code is updated and a blank cell keeps the saved value. Customers and karigars without a code get the next one. Items name their category, metal and purity by code (import categories first). Needs the create permission of that master.
     * `POST /api/master/import/:kind`
     */
    postMasterImportByKind(params: { kind: string }, body: {
      rows: Array<Record<string, unknown>>;
      /** Spreadsheet row of rows[0] — 2 when row 1 holds the headings. */
      firstRow?: number;
    }): Promise<{
      received: number;
      inserted: number;
      updated: number;
      /** Rows not saved, with the spreadsheet row number. */
      failed: Array<{
        row: number;
        message: string;
      }>;
    }> {
      return request<{
      received: number;
      inserted: number;
      updated: number;
      /** Rows not saved, with the spreadsheet row number. */
      failed: Array<{
        row: number;
        message: string;
      }>;
    }>('POST', `/api/master/import/${encodeURIComponent(params.kind)}`, { body });
    },
    /**
     * The Kanban stages for every order type
     *
     * Each order type has its own stage sequence — a repair genuinely has different steps from a wedding order. Read this rather than hardcoding stage names; a tenant can override the list.
     * `GET /api/orders/pipelines`
     * Requires `orders.view`.
     */
    getOrdersPipelines(): Promise<{
      pipelines: Array<{
        orderType: "booking" | "custom" | "repair" | "wedding" | "corporate";
        label: string;
        stages: Array<{
          key: string;
          label: string;
          terminal?: boolean;
          external?: boolean;
        }>;
      }>;
    }> {
      return request<{
      pipelines: Array<{
        orderType: "booking" | "custom" | "repair" | "wedding" | "corporate";
        label: string;
        stages: Array<{
          key: string;
          label: string;
          terminal?: boolean;
          external?: boolean;
        }>;
      }>;
    }>('GET', "/api/orders/pipelines");
    },
    /**
     * The Kanban board for one order type
     *
     * Active orders grouped into their stage columns, ready to render.
     * `GET /api/orders/board`
     * Requires `orders.view`.
     */
    getOrdersBoard(query?: {
      orderType: "booking" | "custom" | "repair" | "wedding" | "corporate";
      branchId?: string;
    }): Promise<{
      orderType: string;
      stages: Array<{
        key: string;
        label: string;
        orders: Array<Record<string, unknown>>;
      }>;
    }> {
      return request<{
      orderType: string;
      stages: Array<{
        key: string;
        label: string;
        orders: Array<Record<string, unknown>>;
      }>;
    }>('GET', "/api/orders/board", { query });
    },
    /**
     * List orders
     *
     * `GET /api/orders`
     * Requires `orders.view`.
     */
    getOrders(query?: {
      orderType?: "booking" | "custom" | "repair" | "wedding" | "corporate";
      stage?: string;
      status?: "draft" | "active" | "completed" | "cancelled";
      customerId?: string;
      karigarId?: string;
      branchId?: string;
      from?: string;
      to?: string;
      /** Matches order number or customer name. */
      search?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }>('GET', "/api/orders", { query });
    },
    /**
     * One order with everything attached
     *
     * Lines, timeline, payments, attachments, acknowledgement and messages, in one call.
     * `GET /api/orders/:id`
     * Requires `orders.view`.
     */
    getOrdersById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/orders/${encodeURIComponent(params.id)}`);
    },
    /**
     * Create an order
     *
     * One endpoint for all five types; `orderType` decides which fields are required. Corporate orders need `companyName` and `poReference`; repairs need `repairItemDescription`. Lines are priced server-side from the rate master, so the client never has to compute GST.
     * `POST /api/orders`
     * Requires `orders.create`.
     */
    postOrders(body: {
      orderType: "booking" | "custom" | "repair" | "wedding" | "corporate";
      customerId: string;
      branchId: string;
      orderDate: string;
      /** Expected delivery date is required. */
      expectedDeliveryDate: string;
      salespersonId?: string;
      karigarId?: string;
      rateLockType?: "today" | "floating" | "fixed_future";
      /** Rupees, as a string. Never a float. */
      lockedRatePerGram?: string;
      /** Cannot exceed the order value. */
      advanceAmount?: string;
      lines?: Array<{
        /** booking reserves existing stock; custom is made to order. */
        lineMode?: "booking" | "custom";
        /** Every line needs a title. */
        title: string;
        designSpecification?: string;
        itemId?: string | null;
        pieceId?: string | null;
        purityId?: string | null;
        categoryId?: string | null;
        quantity?: string;
        /** Grams, as a string. */
        grossWeight?: string;
        /** Grams, as a string. */
        stoneWeight?: string;
        /** Falls back to the order’s locked rate, then today’s sale rate in Masters → Rates for the line’s purity. */
        ratePerGram?: string;
        makingBasis?: "per_gram" | "percent" | "flat";
        makingRate?: string;
        wastagePercent?: string;
        /** Rupees, as a string. Never a float. */
        stoneAmount?: string;
        /** Rupees, as a string. Never a float. */
        discountAmount?: string;
        gstRate?: string;
        hsnCode?: string;
        specialInstructions?: string;
      }>;
      notes?: string;
      /** Custom orders. */
      requirementDescription?: string;
      sizeSpecifications?: string;
      /** Rupees, as a string. Never a float. */
      budgetMin?: string;
      /** Rupees, as a string. Never a float. */
      budgetMax?: string;
      manufacturingRoute?: "in_house" | "external";
      externalManufacturerId?: string;
      /** Required for repair orders. */
      repairItemDescription?: string;
      repairIssueDescription?: string;
      /** e.g. ["clasp","stone_loose"] */
      repairIssueTypes?: Array<string>;
      underWarranty?: boolean;
      originalInvoiceNumber?: string;
      /** Wedding orders. */
      eventDate?: string;
      eventType?: string;
      /** Required for corporate orders. */
      companyName?: string;
      companyGstin?: string;
      /** Required for corporate orders. */
      poReference?: string;
      creditTerms?: "net_15" | "net_30" | "custom";
      creditTermsNote?: string;
      brandingNotes?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/orders", { body });
    },
    /**
     * Move an order to another stage
     *
     * Moving backward is allowed but requires `reason` — it is written to the timeline and the audit stream. Reaching a terminal stage completes the order.
     * `POST /api/orders/:id/stage`
     * Requires `orders.update`.
     */
    postOrdersByIdStage(params: { id: string }, body: {
      /** Must exist in this order type’s pipeline. */
      stage: string;
      /** Required when moving backward. */
      reason?: string;
      note?: string;
    }): Promise<{
      order: Record<string, unknown>;
      moved: boolean;
      direction?: string;
    }> {
      return request<{
      order: Record<string, unknown>;
      moved: boolean;
      direction?: string;
    }>('POST', `/api/orders/${encodeURIComponent(params.id)}/stage`, { body });
    },
    /**
     * Cancel an order
     *
     * The order stays in the audit trail and leaves the active pipeline.
     * `POST /api/orders/:id/cancel`
     * Requires `orders.cancel`.
     */
    postOrdersByIdCancel(params: { id: string }, body: {
      reason: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/orders/${encodeURIComponent(params.id)}/cancel`, { body });
    },
    /**
     * Record an advance or token payment
     *
     * `POST /api/orders/:id/payments`
     * Requires `orders.update`.
     */
    postOrdersByIdPayments(params: { id: string }, body: {
      mode: "cash" | "card" | "upi" | "bank_transfer" | "cheque" | "emi" | "old_gold" | "scheme";
      /** Rupees, as a string. Never a float. */
      amount: string;
      reference?: string;
      notes?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/orders/${encodeURIComponent(params.id)}/payments`, { body });
    },
    /**
     * Capture the customer acknowledgement on a repair intake
     *
     * Required before a repair leaves the counter. Either a captured signature or a verified OTP reference — never the OTP code itself.
     * `POST /api/orders/:id/acknowledge`
     * Requires `orders.update`.
     */
    postOrdersByIdAcknowledge(params: { id: string }, body: {
      method: "signature" | "otp";
      /** Required when method is signature. */
      signatureStorageKey?: string;
      /** The provider’s reference, required when method is otp. */
      otpReference?: string;
      acknowledgedByName?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/orders/${encodeURIComponent(params.id)}/acknowledge`, { body });
    },
    /**
     * Import orders in bulk
     *
     * Up to 1,000 rows a call; send a big file as several calls, passing `firstRow` so problems name the spreadsheet row. One row = one order with one line, at the branch in `X-Branch-Id`.
     * 
     * **Customer**: matched on `customer_code`, else `customer_phone`. A phone nobody has yet becomes a new customer when `customer_name` is given.
     * **Price**: `rate_per_gram`, else today’s sale rate in Masters → Rates for the purity. A purity with weight and no rate anywhere is refused (repairs excepted).
     * **Stage**: a stage key of that order type’s pipeline (default: its first). A terminal stage imports the order as completed.
     * **reference**: the old order number; a reference already imported is skipped, not duplicated.
     * 
     * Past order dates are allowed here even when back-dating is switched off, since bringing old orders across is the point.
     * `POST /api/orders/import`
     * Requires `orders.import`.
     */
    postOrdersImport(body: {
      rows: Array<Record<string, unknown>>;
      /** Spreadsheet row of rows[0] — 2 when row 1 holds the headings. */
      firstRow?: number;
    }): Promise<{
      received: number;
      inserted: number;
      /** Rows whose reference was imported before. */
      skipped: number;
      customersCreated: number;
      failed: Array<{
        row: number;
        message: string;
      }>;
    }> {
      return request<{
      received: number;
      inserted: number;
      /** Rows whose reference was imported before. */
      skipped: number;
      customersCreated: number;
      failed: Array<{
        row: number;
        message: string;
      }>;
    }>('POST', "/api/orders/import", { body });
    },
    /**
     * Old Gold settings in force
     *
     * Valuation basis, rate source, margin, melting loss, estimate, buyback, cash limit, own-jewellery terms, identity rules, hold days and register columns. Read-only here; changed in Settings.
     * `GET /api/oldgold/settings`
     * Requires `oldgold.view`.
     */
    getOldgoldSettings(): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', "/api/oldgold/settings");
    },
    /**
     * Value old gold as it will be credited
     *
     * The same valuation an intake saves, from Old Gold settings: fine or purity basis, rate, margin, melting loss, own-jewellery terms. Nothing is saved.
     * `POST /api/oldgold/quote`
     * Requires `oldgold.view`.
     */
    postOldgoldQuote(body: {
      lines: Array<{
        description: string;
        metalId?: string;
        itemCategoryId?: string | null;
        /** Grams, as a string. */
        grossWeight: string;
        /** Grams, as a string. */
        stoneWeight?: string;
        /** Grams, as a string. */
        dirtWeight?: string;
        testMethod: "xrf" | "touchstone" | "hallmark" | "estimate";
        /** As tested or estimated, e.g. 91.2. For the shop’s own piece its purity is used when left out. */
        testedPurityPercent?: string;
        declaredPurityPercent?: string;
        testInstrument?: string;
        huid?: string;
        /** Tag number or HUID of a piece this shop sold: own-jewellery terms apply. */
        ownPiece?: string;
        /** Used only when Old Gold settings let staff change the melting loss. */
        lossPercent?: string;
        notes?: string;
      }>;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/oldgold/quote", { body });
    },
    /**
     * Take old gold in
     *
     * Posts at once: old gold into stock at the location, its value credited to the customer. `exchange` keeps the credit to spend on a bill or as advance; `buyback` pays it out now (needs `payout`). Proof of identity and PAN are asked as Old Gold settings and the ₹2 lakh rule say; cash payouts follow the daily cash limit.
     * `POST /api/oldgold/intakes`
     * Requires `oldgold.create`.
     */
    postOldgoldIntakes(body: {
      customerId: string;
      locationId?: string;
      settlement: "exchange" | "buyback";
      payout?: {
        paymentMethodId: string;
        reference?: string;
      };
      idProof?: {
        type: "aadhaar" | "pan" | "voter_id" | "driving_licence" | "passport" | "other";
        number: string;
      };
      pan?: string;
      notes?: string;
      lines: Array<{
        description: string;
        metalId?: string;
        itemCategoryId?: string | null;
        /** Grams, as a string. */
        grossWeight: string;
        /** Grams, as a string. */
        stoneWeight?: string;
        /** Grams, as a string. */
        dirtWeight?: string;
        testMethod: "xrf" | "touchstone" | "hallmark" | "estimate";
        /** As tested or estimated, e.g. 91.2. For the shop’s own piece its purity is used when left out. */
        testedPurityPercent?: string;
        declaredPurityPercent?: string;
        testInstrument?: string;
        huid?: string;
        /** Tag number or HUID of a piece this shop sold: own-jewellery terms apply. */
        ownPiece?: string;
        /** Used only when Old Gold settings let staff change the melting loss. */
        lossPercent?: string;
        notes?: string;
      }>;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/oldgold/intakes", { body });
    },
    /**
     * Old gold intakes
     *
     * `GET /api/oldgold/intakes`
     * Requires `oldgold.view`.
     */
    getOldgoldIntakes(query?: {
      customerId?: string;
      status?: "posted" | "cancelled";
      /** Voucher number, customer name or mobile. */
      search?: string;
      cursor?: string;
      limit?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }>('GET', "/api/oldgold/intakes", { query });
    },
    /**
     * One intake, as it prints
     *
     * `GET /api/oldgold/intakes/:id`
     * Requires `oldgold.view`.
     */
    getOldgoldIntakesById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/oldgold/intakes/${encodeURIComponent(params.id)}`);
    },
    /**
     * Pay out old-gold credit
     *
     * Pays the customer some or all of what is left of an intake’s credit (a buyback after all). Same identity, PAN and cash rules as a buyback.
     * `POST /api/oldgold/intakes/:id/payout`
     * Requires `oldgold.payout`.
     */
    postOldgoldIntakesByIdPayout(params: { id: string }, body: {
      paymentMethodId: string;
      /** Rupees, as a string. Never a float. */
      amount?: string;
      reference?: string;
      idProof?: {
        type: "aadhaar" | "pan" | "voter_id" | "driving_licence" | "passport" | "other";
        number: string;
      };
      pan?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/oldgold/intakes/${encodeURIComponent(params.id)}/payout`, { body });
    },
    /**
     * Cancel an intake entered by mistake
     *
     * Only while nothing is melted, nothing was paid out and the credit is unspent. One taken in on a bill is cancelled with the bill.
     * `POST /api/oldgold/intakes/:id/cancel`
     * Requires `oldgold.cancel`.
     */
    postOldgoldIntakesByIdCancel(params: { id: string }, body: {
      reason: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/oldgold/intakes/${encodeURIComponent(params.id)}/cancel`, { body });
    },
    /**
     * Old gold waiting to be melted, and at refiners
     *
     * `GET /api/oldgold/stock`
     * Requires `oldgold.view`.
     */
    getOldgoldStock(query?: {
      metalId?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', "/api/oldgold/stock", { query });
    },
    /**
     * Melt old gold, or send it to a refiner
     *
     * `melt`: in-house, with what came out (bullion item, purity, weight, assay). `refine`: sent to `refinerId`, received later. One metal per batch; the hold period in settings applies.
     * `POST /api/oldgold/melt-batches`
     * Requires `oldgold.melt`.
     */
    postOldgoldMeltbatches(body: {
      kind: "melt" | "refine";
      itemIds: Array<string>;
      refinerId?: string;
      output?: {
        outputItemId: string;
        outputPurityId: string;
        /** Grams, as a string. */
        outputWeight: string;
        assayPercent?: string;
        locationId?: string;
      };
      notes?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/oldgold/melt-batches", { body });
    },
    /**
     * Melt and refine batches
     *
     * `GET /api/oldgold/melt-batches`
     * Requires `oldgold.view`.
     */
    getOldgoldMeltbatches(query?: {
      status?: "melted" | "sent" | "received" | "cancelled";
      cursor?: string;
      limit?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }>('GET', "/api/oldgold/melt-batches", { query });
    },
    /**
     * One batch with the old gold in it
     *
     * `GET /api/oldgold/melt-batches/:id`
     * Requires `oldgold.view`.
     */
    getOldgoldMeltbatchesById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/oldgold/melt-batches/${encodeURIComponent(params.id)}`);
    },
    /**
     * Receive refined metal
     *
     * What came back from the refiner (bullion item, purity, weight, assay) and the refining charge, which is owed to the refiner.
     * `POST /api/oldgold/melt-batches/:id/receive`
     * Requires `oldgold.melt`.
     */
    postOldgoldMeltbatchesByIdReceive(params: { id: string }, body: {
      outputItemId: string;
      outputPurityId: string;
      /** Grams, as a string. */
      outputWeight: string;
      assayPercent?: string;
      locationId?: string;
      /** Rupees, as a string. Never a float. */
      refiningCharge?: string;
      certificateNumber?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/oldgold/melt-batches/${encodeURIComponent(params.id)}/receive`, { body });
    },
    /**
     * Cancel a batch
     *
     * While its bullion is still in stock. The old gold returns, unmelted.
     * `POST /api/oldgold/melt-batches/:id/cancel`
     * Requires `oldgold.melt`.
     */
    postOldgoldMeltbatchesByIdCancel(params: { id: string }, body: {
      reason: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/oldgold/melt-batches/${encodeURIComponent(params.id)}/cancel`, { body });
    },
    /**
     * The old gold register
     *
     * Every article taken in between two dates, with the customer, identity proof, weights, purity, value and how it was settled. The Register tab chooses and orders the columns.
     * `GET /api/oldgold/register`
     * Requires `oldgold.view`.
     */
    getOldgoldRegister(query?: {
      from: string;
      to: string;
      search?: string;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
    }>('GET', "/api/oldgold/register", { query });
    },
    /**
     * Payment methods offered at this branch
     *
     * `GET /api/pos/tenders`
     * Requires `pos.view`.
     */
    getPosTenders(): Promise<{
      rows: Array<Record<string, unknown>>;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
    }>('GET', "/api/pos/tenders");
    },
    /**
     * Find a piece by tag number or HUID for the bill
     *
     * Exact match on the tag or HUID. Says where the piece is when it cannot be sold here.
     * `GET /api/pos/scan/:code`
     * Requires `pos.view`.
     */
    getPosScanByCode(params: { code: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/pos/scan/${encodeURIComponent(params.code)}`);
    },
    /**
     * Bill the customer
     *
     * Prices every line on the server (rate; making and wastage from the tag, else Masters → Formulas; GST), takes the discount off making and wastage, takes the tenders and posts at once: stock out at cost, the books, and any unpaid balance on the customer. A discount above the counter limit needs `approver` (someone with discount approval) unless the biller has it. A bill of ₹2 lakh or more needs the customer’s PAN; cash reaching ₹2 lakh from one customer in a day (bills and receipts together) is refused. Without customerId it is a walk-in bill: paid in full, under ₹2 lakh, no advance.
     * `POST /api/pos/checkout`
     * Requires `pos.create`.
     */
    postPosCheckout(body: {
      /** Leave out for a walk-in: paid in full and under ₹2 lakh. */
      customerId?: string;
      lines: Array<{
        pieceId?: string;
        itemId?: string;
        purityId?: string;
        locationId?: string;
        /** Grams, as a string. */
        grossWeight?: string;
        /** Rupees, as a string. Never a float. */
        hallmarkAmount?: string;
      }>;
      tenders: Array<{
        paymentMethodId: string;
        /** Rupees, as a string. Never a float. */
        amount: string;
        reference?: string;
      }>;
      /** Rupees, as a string. Never a float. */
      discount?: string;
      approver?: {
        identifier: string;
        password: string;
      };
      pan?: string;
      salespersonId?: string;
      notes?: string;
      /** The total the counter showed; refused with price_changed if the price moved since. */
      expectedTotal?: string;
      /** Old gold handed over with this bill: taken in and used as payment up to what is left; any more stays as advance (not for a walk-in). */
      oldGold?: {
        lines: Array<{
          description: string;
          metalId?: string;
          itemCategoryId?: string | null;
          /** Grams, as a string. */
          grossWeight: string;
          /** Grams, as a string. */
          stoneWeight?: string;
          /** Grams, as a string. */
          dirtWeight?: string;
          testMethod: "xrf" | "touchstone" | "hallmark" | "estimate";
          /** As tested or estimated, e.g. 91.2. For the shop’s own piece its purity is used when left out. */
          testedPurityPercent?: string;
          declaredPurityPercent?: string;
          testInstrument?: string;
          huid?: string;
          /** Tag number or HUID of a piece this shop sold: own-jewellery terms apply. */
          ownPiece?: string;
          /** Used only when Old Gold settings let staff change the melting loss. */
          lossPercent?: string;
          notes?: string;
        }>;
        locationId?: string;
        idProof?: {
          type: "aadhaar" | "pan" | "voter_id" | "driving_licence" | "passport" | "other";
          number: string;
        };
      };
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/pos/checkout", { body });
    },
    /**
     * Price the bill on the counter
     *
     * The same pricing checkout will save — tag terms, formulas, discount on making and wastage, GST, round off — with each line’s metal, wastage and making, and where they came from. Nothing is saved.
     * `POST /api/pos/quote`
     * Requires `pos.create`.
     */
    postPosQuote(body: {
      customerId?: string | null;
      lines: Array<{
        pieceId?: string;
        itemId?: string;
        purityId?: string;
        locationId?: string;
        /** Grams, as a string. */
        grossWeight?: string;
        /** Rupees, as a string. Never a float. */
        hallmarkAmount?: string;
      }>;
      /** Rupees, as a string. Never a float. */
      discount?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/pos/quote", { body });
    },
    /**
     * Bills
     *
     * `GET /api/pos/invoices`
     * Requires `pos.view`.
     */
    getPosInvoices(query?: {
      search?: string;
      status?: "posted" | "cancelled";
      customerId?: string;
      due?: "true" | "false";
      from?: string;
      to?: string;
      cursor?: string;
      limit?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }>('GET', "/api/pos/invoices", { query });
    },
    /**
     * One bill: lines, payments and returns, ready to print
     *
     * `GET /api/pos/invoices/:id`
     * Requires `pos.view`.
     */
    getPosInvoicesById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/pos/invoices/${encodeURIComponent(params.id)}`);
    },
    /**
     * Cancel a bill entered by mistake
     *
     * Everything reverses and the pieces go back on the shelf. Not once goods came back on a return or a receipt was paid against it.
     * `POST /api/pos/invoices/:id/cancel`
     * Requires `pos.cancel`.
     */
    postPosInvoicesByIdCancel(params: { id: string }, body: {
      reason: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/pos/invoices/${encodeURIComponent(params.id)}/cancel`, { body });
    },
    /**
     * Take goods back from a customer
     *
     * Against one bill. The value comes back in proportion, first clearing anything still owed on that bill, then as a refund or a credit note for an exchange.
     * `POST /api/pos/returns`
     * Requires `pos.return.create`.
     */
    postPosReturns(body: {
      invoiceId: string;
      lines: Array<{
        invoiceLineId: string;
        /** Grams, as a string. */
        netWeight?: string;
      }>;
      settlement: "refund" | "credit_note";
      refundPaymentMethodId?: string;
      /** Rupees, as a string. Never a float. */
      deduction?: string;
      locationId?: string;
      reason?: "defect" | "size" | "dislike" | "wrong_item" | "other";
      notes?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/pos/returns", { body });
    },
    /**
     * Customer returns
     *
     * `GET /api/pos/returns`
     * Requires `pos.view`.
     */
    getPosReturns(query?: {
      customerId?: string;
      /** Return or bill number, customer name or mobile. */
      search?: string;
      cursor?: string;
      limit?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }>('GET', "/api/pos/returns", { query });
    },
    /**
     * What a customer owes and holds
     *
     * Owed on bills, advance and credit notes, bills with a balance, and pieces out on approval.
     * `GET /api/pos/customers/:id/balance`
     * Requires `pos.view`.
     */
    getPosCustomersByIdBalance(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/pos/customers/${encodeURIComponent(params.id)}/balance`);
    },
    /**
     * Receive money from a customer
     *
     * Clears their oldest unpaid bills first; anything more is kept as advance for a later bill.
     * `POST /api/pos/receipts`
     * Requires `pos.create`.
     */
    postPosReceipts(body: {
      customerId: string;
      /** Rupees, as a string. Never a float. */
      amount: string;
      paymentMethodId: string;
      reference?: string;
      notes?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/pos/receipts", { body });
    },
    /**
     * Customer receipts
     *
     * `GET /api/pos/receipts`
     * Requires `pos.view`.
     */
    getPosReceipts(query?: {
      customerId?: string;
      cursor?: string;
      limit?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }>('GET', "/api/pos/receipts", { query });
    },
    /**
     * One receipt, as it prints
     *
     * `GET /api/pos/receipts/:id`
     * Requires `pos.view`.
     */
    getPosReceiptsById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/pos/receipts/${encodeURIComponent(params.id)}`);
    },
    /**
     * Cancel a receipt
     *
     * `POST /api/pos/receipts/:id/cancel`
     * Requires `pos.cancel`.
     */
    postPosReceiptsByIdCancel(params: { id: string }, body: {
      reason: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/pos/receipts/${encodeURIComponent(params.id)}/cancel`, { body });
    },
    /**
     * Approval memos
     *
     * `GET /api/pos/memos`
     * Requires `pos.view`.
     */
    getPosMemos(query?: {
      status?: "open" | "closed";
      overdue?: "true" | "false";
      cursor?: string;
      limit?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }>('GET', "/api/pos/memos", { query });
    },
    /**
     * One approval memo
     *
     * `GET /api/pos/memos/:id`
     * Requires `pos.view`.
     */
    getPosMemosById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/pos/memos/${encodeURIComponent(params.id)}`);
    },
    /**
     * Send pieces to a customer on approval
     *
     * The pieces stay ours and show "On approval". Bill them to the same customer from the counter, or take them back.
     * `POST /api/pos/memos`
     * Requires `pos.create`.
     */
    postPosMemos(body: {
      customerId: string;
      pieceIds: Array<string>;
      dueDate: string;
      notes?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/pos/memos", { body });
    },
    /**
     * Take pieces back from approval
     *
     * `POST /api/pos/memos/:id/return`
     * Requires `pos.create`.
     */
    postPosMemosByIdReturn(params: { id: string }, body: {
      pieceIds: Array<string>;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/pos/memos/${encodeURIComponent(params.id)}/return`, { body });
    },
    /**
     * Purchase orders
     *
     * `GET /api/purchase/orders`
     * Requires `pos.purchase.view`.
     */
    getPurchaseOrders(query?: {
      supplierId?: string;
      status?: "confirmed" | "closed" | "cancelled";
      search?: string;
      cursor?: string;
      limit?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }>('GET', "/api/purchase/orders", { query });
    },
    /**
     * One purchase order with its lines
     *
     * `GET /api/purchase/orders/:id`
     * Requires `pos.purchase.view`.
     */
    getPurchaseOrdersById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/purchase/orders/${encodeURIComponent(params.id)}`);
    },
    /**
     * Place a purchase order
     *
     * What was asked of the supplier. Affects nothing until goods arrive; inwards against it show what is still due.
     * `POST /api/purchase/orders`
     * Requires `pos.purchase.create`.
     */
    postPurchaseOrders(body: {
      supplierId: string;
      docDate?: string;
      expectedDate?: string;
      notes?: string;
      lines: Array<{
        itemId: string;
        purityId: string;
        quantity?: number;
        /** Grams, as a string. */
        grossWeight: string;
        /** Rupees, as a string. Never a float. */
        ratePerGram?: string;
        notes?: string;
      }>;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/purchase/orders", { body });
    },
    /**
     * Close or cancel an order
     *
     * `status: closed` when no more is coming; `cancelled` only while nothing has arrived.
     * `POST /api/purchase/orders/:id/close`
     * Requires `pos.purchase.create`.
     */
    postPurchaseOrdersByIdClose(params: { id: string }, body: {
      reason: string;
      status: "closed" | "cancelled";
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/purchase/orders/${encodeURIComponent(params.id)}/close`, { body });
    },
    /**
     * Goods inwards and direct purchases
     *
     * `GET /api/purchase/inwards`
     * Requires `pos.purchase.view`.
     */
    getPurchaseInwards(query?: {
      supplierId?: string;
      status?: "posted" | "cancelled";
      /** Inward number or the supplier’s bill number. */
      search?: string;
      unbilled?: "true" | "false";
      /** true = direct purchases only; false = goods inwards only. */
      direct?: "true" | "false";
      cursor?: string;
      limit?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }>('GET', "/api/purchase/inwards", { query });
    },
    /**
     * One inward with its lines and tagging progress
     *
     * `GET /api/purchase/inwards/:id`
     * Requires `pos.purchase.view`.
     */
    getPurchaseInwardsById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/purchase/inwards/${encodeURIComponent(params.id)}`);
    },
    /**
     * Receive goods (and the bill, if it came with them)
     *
     * Posts at once: stock goes up at the location, the supplier is owed rupees and/or fine metal, and pieces wait in Tagging as a lot. Rupee basis: metal at the rate. Fine basis: fine metal owed = net × touch %; making and stones in rupees. Send `bill` when the supplier bill came with the goods; otherwise enter it later. `direct: true` is a direct purchase: the bill is required, and goods and bill are one record — cancelled together, never separately.
     * `POST /api/purchase/inwards`
     * Requires `pos.purchase.create`.
     */
    postPurchaseInwards(body: {
      supplierId: string;
      docDate?: string;
      locationId: string;
      purchaseOrderId?: string;
      /** The supplier’s challan number. */
      referenceNumber?: string;
      notes?: string;
      lines: Array<{
        itemId: string;
        purityId: string;
        pieces?: number;
        /** Grams, as a string. */
        grossWeight: string;
        /** Grams, as a string. */
        stoneWeight?: string;
        /** Grams, as a string. */
        otherWeight?: string;
        /** Grams, as a string. */
        declaredWeight?: string;
        metalBasis: "rupee" | "fine";
        /** Rupee basis: the agreed rate. Fine basis: the stock value per gram (defaults to today’s buying rate). */
        ratePerGram?: string;
        /** Fine basis: % of net weight owed back as pure metal. */
        touchPercent?: string;
        makingBasis?: "per_gram" | "flat" | "percent";
        /** Rupees, as a string. Never a float. */
        makingRate?: string;
        /** Rupees, as a string. Never a float. */
        stoneAmount?: string;
        purchaseOrderLineId?: string;
      }>;
      bill?: {
        /** Blank when the seller gave no numbered bill: our purchase number is used. */
        supplierInvoiceNumber?: string;
        supplierInvoiceDate: string;
        dueDate?: string;
        /** Rupees, as a string. Never a float. */
        gstAmount?: string;
      };
      direct?: boolean;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/purchase/inwards", { body });
    },
    /**
     * Cancel an inward or a direct purchase entered by mistake
     *
     * Only while nothing from it is tagged, returned or already sold. An inward must not be billed; a direct purchase cancels its bill with it.
     * `POST /api/purchase/inwards/:id/cancel`
     * Requires `pos.purchase.post`.
     */
    postPurchaseInwardsByIdCancel(params: { id: string }, body: {
      reason: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/purchase/inwards/${encodeURIComponent(params.id)}/cancel`, { body });
    },
    /**
     * Close a purchase lot in Tagging
     *
     * Whatever was not tagged (a weighing difference, a missing piece) leaves stock on one tagging-difference adjustment.
     * `POST /api/purchase/lots/:id/close`
     * Requires `stock.adjustment.post`.
     */
    postPurchaseLotsByIdClose(params: { id: string }, body: {
      note: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/purchase/lots/${encodeURIComponent(params.id)}/close`, { body });
    },
    /**
     * Purchase lots waiting in Tagging
     *
     * `GET /api/purchase/lots`
     * Requires `tagging.view`.
     */
    getPurchaseLots(): Promise<{
      rows: Array<Record<string, unknown>>;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
    }>('GET', "/api/purchase/lots");
    },
    /**
     * Supplier bills
     *
     * `GET /api/purchase/bills`
     * Requires `pos.purchase.view`.
     */
    getPurchaseBills(query?: {
      supplierId?: string;
      status?: "posted" | "cancelled";
      search?: string;
      cursor?: string;
      limit?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }>('GET', "/api/purchase/bills", { query });
    },
    /**
     * Enter a supplier bill for received goods
     *
     * Covers one or more unbilled inwards of the supplier. GST is worked out from each line’s HSN; send `gstAmount` to match the printed bill exactly.
     * `POST /api/purchase/bills`
     * Requires `pos.purchase.post`.
     */
    postPurchaseBills(body: {
      /** Blank when the seller gave no numbered bill: our purchase number is used. */
      supplierInvoiceNumber?: string;
      supplierInvoiceDate: string;
      dueDate?: string;
      /** Rupees, as a string. Never a float. */
      gstAmount?: string;
      supplierId: string;
      inwardIds: Array<string>;
      docDate?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/purchase/bills", { body });
    },
    /**
     * Cancel a supplier bill
     *
     * The GST entry reverses and its inwards become unbilled again.
     * `POST /api/purchase/bills/:id/cancel`
     * Requires `pos.purchase.post`.
     */
    postPurchaseBillsByIdCancel(params: { id: string }, body: {
      reason: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/purchase/bills/${encodeURIComponent(params.id)}/cancel`, { body });
    },
    /**
     * Returns to suppliers
     *
     * `GET /api/purchase/returns`
     * Requires `pos.purchase.view`.
     */
    getPurchaseReturns(query?: {
      supplierId?: string;
      search?: string;
      cursor?: string;
      limit?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }>('GET', "/api/purchase/returns", { query });
    },
    /**
     * Send goods back to the supplier
     *
     * Against one inward: tagged pieces (scanned), untagged pieces still in Tagging, or lot weight. The supplier’s rupees, fine metal and (if billed) GST come down in proportion.
     * `POST /api/purchase/returns`
     * Requires `pos.purchase.create`.
     */
    postPurchaseReturns(body: {
      goodsReceiptId: string;
      reason?: "quality" | "wrong_item" | "excess" | "damaged" | "other";
      notes?: string;
      docDate?: string;
      /** Tagged pieces as scanned; each is matched to its inward line. */
      pieceIds?: Array<string>;
      lines?: Array<{
        goodsReceiptLineId: string;
        pieces?: number;
        /** Grams, as a string. */
        grossWeight?: string;
        /** Grams, as a string. */
        netWeight?: string;
      }>;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/purchase/returns", { body });
    },
    /**
     * What a supplier is owed
     *
     * Rupees on Sundry Creditors, fine metal per metal (with its average carrying rate), and unbilled inwards.
     * `GET /api/purchase/suppliers/:id/balance`
     * Requires `pos.purchase.view`.
     */
    getPurchaseSuppliersByIdBalance(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/purchase/suppliers/${encodeURIComponent(params.id)}/balance`);
    },
    /**
     * Every supplier we owe
     *
     * Rupees and fine metal per supplier, largest first.
     * `GET /api/purchase/payables`
     * Requires `pos.purchase.view`.
     */
    getPurchasePayables(): Promise<{
      rows: Array<Record<string, unknown>>;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
    }>('GET', "/api/purchase/payables");
    },
    /**
     * Supplier payments
     *
     * `GET /api/purchase/settlements`
     * Requires `pos.purchase.view`.
     */
    getPurchaseSettlements(query?: {
      supplierId?: string;
      cursor?: string;
      limit?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }>('GET', "/api/purchase/settlements", { query });
    },
    /**
     * One supplier payment, as it prints
     *
     * `GET /api/purchase/settlements/:id`
     * Requires `pos.purchase.view`.
     */
    getPurchaseSettlementsById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/purchase/settlements/${encodeURIComponent(params.id)}`);
    },
    /**
     * Pay a supplier in rupees or metal
     *
     * `payment`: rupees by a payment method from Masters. `metal`: fine metal given from a lot in stock (item, purity, location, net weight). `rate_fix`: fine metal owed converted to rupees at an agreed rate per fine gram. Metal cannot exceed what is owed. The difference between the carrying value and the settlement is booked as metal gain or loss.
     * `POST /api/purchase/settlements`
     * Requires `pos.purchase.post`.
     */
    postPurchaseSettlements(body: {
      supplierId: string;
      kind: "payment" | "metal" | "rate_fix";
      docDate?: string;
      /** Rupees, as a string. Never a float. */
      amount?: string;
      paymentMethodId?: string;
      reference?: string;
      itemId?: string;
      purityId?: string;
      locationId?: string;
      /** Grams, as a string. */
      netWeight?: string;
      metalId?: string;
      /** Grams, as a string. */
      fineWeight?: string;
      /** Rupees, as a string. Never a float. */
      ratePerGram?: string;
      notes?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/purchase/settlements", { body });
    },
    /**
     * Cancel a supplier payment
     *
     * `POST /api/purchase/settlements/:id/cancel`
     * Requires `pos.purchase.post`.
     */
    postPurchaseSettlementsByIdCancel(params: { id: string }, body: {
      reason: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/purchase/settlements/${encodeURIComponent(params.id)}/cancel`, { body });
    },
    /**
     * Can this person unlock private figures?
     *
     * Whether the vault is on for this business and whether the signed-in person may unlock it. No secret is returned. When `canUnlock` is false, show `message` instead of the passcode box.
     * `GET /api/security/vault`
     * Requires `settings.vault.unlock`.
     */
    getSecurityVault(): Promise<{
      /** False = switched off by the super admin; private figures stay hidden. */
      enabled: boolean;
      canUnlock: boolean;
      /** How long one unlock lasts. */
      unlockMinutes: number;
      reason: "disabled" | "role" | null;
      /** Plain-English reason when canUnlock is false. */
      message: unknown;
    }> {
      return request<{
      /** False = switched off by the super admin; private figures stay hidden. */
      enabled: boolean;
      canUnlock: boolean;
      /** How long one unlock lasts. */
      unlockMinutes: number;
      reason: "disabled" | "role" | null;
      /** Plain-English reason when canUnlock is false. */
      message: unknown;
    }>('GET', "/api/security/vault");
    },
    /**
     * Unlock private figures with the vault passcode
     *
     * Checks the passcode against the hash the super admin set. Five wrong tries lock that person out for 15 minutes. The token is valid for the configured minutes, and stops working early if the vault is switched off or re-configured, or the person’s password or role changes.
     * `POST /api/security/vault/unlock`
     * Requires `settings.vault.unlock`.
     */
    postSecurityVaultUnlock(body: {
      passcode: string;
    }): Promise<{
      token: string;
      /** Unix milliseconds. */
      expiresAt: number;
    }> {
      return request<{
      token: string;
      /** Unix milliseconds. */
      expiresAt: number;
    }>('POST', "/api/security/vault/unlock", { body });
    },
    /**
     * Is this unlock still good?
     *
     * Send the token from unlock. Returns its expiry, or `null` once it has expired or been ended for any reason — then lock the screen.
     * `POST /api/security/vault/session`
     * Requires `settings.vault.unlock`.
     */
    postSecurityVaultSession(body: {
      /** The token returned by unlock. Keep it in memory for this tab only. */
      token: string;
    }): Promise<{
      /** Unix milliseconds. */
      expiresAt: number;
    } | null> {
      return request<{
      /** Unix milliseconds. */
      expiresAt: number;
    } | null>('POST', "/api/security/vault/session", { body });
    },
    /**
     * Lock private figures now
     *
     * `POST /api/security/vault/lock`
     * Requires `settings.vault.unlock`.
     */
    postSecurityVaultLock(body: {
      /** The token returned by unlock. Keep it in memory for this tab only. */
      token: string;
    }): Promise<void> {
      return request<void>('POST', "/api/security/vault/lock", { body });
    },
    /**
     * A business’s security vault and private entry settings
     *
     * The passcode itself is never returned — only whether one is set. Includes how many vault unlocks are open right now and who is locked out.
     * `GET /api/platform/tenants/:id/security`
     * Requires `platform.tenants.view`.
     */
    getPlatformTenantsByIdSecurity(params: { id: string }): Promise<{
      vault: {
        enabled: boolean;
        hasPasscode: boolean;
        passcodeChangedAt: unknown;
        unlockMinutes: number;
        allowedRoleTypes: Array<"owner" | "admin" | "staff">;
        revision: number;
        updatedAt: unknown;
      };
      gateway: {
        enabled: boolean;
        path: string;
        points: Array<{
          x: number;
          y: number;
        }>;
        revision: number;
        updatedAt: unknown;
      };
      activeUnlocks: number;
      lockouts: Array<{
        kind: "vault" | "gateway";
        userId: string;
        userName: string;
        lockedUntil: string;
      }>;
    }> {
      return request<{
      vault: {
        enabled: boolean;
        hasPasscode: boolean;
        passcodeChangedAt: unknown;
        unlockMinutes: number;
        allowedRoleTypes: Array<"owner" | "admin" | "staff">;
        revision: number;
        updatedAt: unknown;
      };
      gateway: {
        enabled: boolean;
        path: string;
        points: Array<{
          x: number;
          y: number;
        }>;
        revision: number;
        updatedAt: unknown;
      };
      activeUnlocks: number;
      lockouts: Array<{
        kind: "vault" | "gateway";
        userId: string;
        userName: string;
        lockedUntil: string;
      }>;
    }>('GET', `/api/platform/tenants/${encodeURIComponent(params.id)}/security`);
    },
    /**
     * Switch the vault on or off, set its passcode and who may unlock it
     *
     * Send the whole setting with the `revision` you loaded; a stale revision gets 409. Leave `passcode` out to keep the current one. Every save locks the vault for everyone who had it open, and a new passcode clears old wrong-try lockouts.
     * `PUT /api/platform/tenants/:id/security/vault`
     * Requires `platform.tenants.update`.
     */
    putPlatformTenantsByIdSecurityVault(params: { id: string }, body: {
      enabled: boolean;
      /** Only when setting or changing it. Never stored readable. */
      passcode?: string;
      /** How long one unlock lasts. */
      unlockMinutes: number;
      /** owner, admin (branch admins) and/or staff. */
      allowedRoleTypes: Array<"owner" | "admin" | "staff">;
      revision: number;
    }): Promise<{
      enabled: boolean;
      hasPasscode: boolean;
      passcodeChangedAt: unknown;
      unlockMinutes: number;
      allowedRoleTypes: Array<"owner" | "admin" | "staff">;
      revision: number;
      updatedAt: unknown;
    }> {
      return request<{
      enabled: boolean;
      hasPasscode: boolean;
      passcodeChangedAt: unknown;
      unlockMinutes: number;
      allowedRoleTypes: Array<"owner" | "admin" | "staff">;
      revision: number;
      updatedAt: unknown;
    }>('PUT', `/api/platform/tenants/${encodeURIComponent(params.id)}/security/vault`, { body });
    },
    /**
     * Set the private entry path and its three points
     *
     * Points are normalised over the 404 artwork (x 0.07–0.93, y 0.10–0.90) and at least 96 artwork units apart. Switching it on needs a valid path and three points. Every save ends any open private-entry grant.
     * `PUT /api/platform/tenants/:id/security/gateway`
     * Requires `platform.tenants.update`.
     */
    putPlatformTenantsByIdSecurityGateway(params: { id: string }, body: {
      enabled: boolean;
      /** e.g. /quiet-door. Lowercase letters, digits and hyphens; not a path the app uses. */
      path: string;
      points: Array<{
        x: number;
        y: number;
      }>;
      revision: number;
    }): Promise<{
      enabled: boolean;
      path: string;
      points: Array<{
        x: number;
        y: number;
      }>;
      revision: number;
      updatedAt: unknown;
    }> {
      return request<{
      enabled: boolean;
      path: string;
      points: Array<{
        x: number;
        y: number;
      }>;
      revision: number;
      updatedAt: unknown;
    }>('PUT', `/api/platform/tenants/${encodeURIComponent(params.id)}/security/gateway`, { body });
    },
    /**
     * Let locked-out people try again now
     *
     * Omit `userId` to clear everyone in this business.
     * `POST /api/platform/tenants/:id/security/lockouts/clear`
     * Requires `platform.tenants.update`.
     */
    postPlatformTenantsByIdSecurityLockoutsClear(params: { id: string }, body: {
      userId?: string;
    }): Promise<{
      cleared: number;
    }> {
      return request<{
      cleared: number;
    }>('POST', `/api/platform/tenants/${encodeURIComponent(params.id)}/security/lockouts/clear`, { body });
    },
    /**
     * Stock totals for the header cards
     *
     * Per metal: pieces, gross, net and fine weight and cost value on hand (goods in transit excluded), plus the tag print queue (whole branch, and tagged by you), hallmarkable pieces without a HUID, transfers on the road to this branch and open counts.
     * `GET /api/stock/summary`
     * Requires `stock.view`.
     */
    getStockSummary(query?: {
      branchId?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', "/api/stock/summary", { query });
    },
    /**
     * Tagged pieces
     *
     * Newest first, a page at a time. `search` matches tag number, HUID or item name. `unprinted=true` is the tag print queue; `mine=true` keeps pieces you tagged.
     * `GET /api/stock/pieces`
     * Requires `stock.view`.
     */
    getStockPieces(query?: {
      search?: string;
      status?: "in_stock" | "on_memo" | "sold" | "in_transit" | "with_karigar" | "in_repair" | "melted" | "written_off";
      branchId?: string;
      locationId?: string;
      itemId?: string;
      purityId?: string;
      unprinted?: "true" | "false";
      mine?: "true" | "false";
      /** From the previous page’s nextCursor. */
      cursor?: string;
      limit?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }>('GET', "/api/stock/pieces", { query });
    },
    /**
     * One piece with its history
     *
     * The piece, every stock movement it made, and its HUID history.
     * `GET /api/stock/pieces/:id`
     * Requires `stock.view`.
     */
    getStockPiecesById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/stock/pieces/${encodeURIComponent(params.id)}`);
    },
    /**
     * Add or replace a piece’s HUID
     *
     * The old HUID is kept in the history as superseded.
     * `POST /api/stock/pieces/:id/huid`
     * Requires `tagging.update`.
     */
    postStockPiecesByIdHuid(params: { id: string }, body: {
      huid: string;
      hallmarkCentre?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/stock/pieces/${encodeURIComponent(params.id)}/huid`, { body });
    },
    /**
     * Correct a piece’s weights
     *
     * For a weighing mistake. Posts a weighing-correction adjustment so stock follows. Owner and branch admin only.
     * `POST /api/stock/pieces/:id/weights`
     * Requires `stock.adjustment.post`.
     */
    postStockPiecesByIdWeights(params: { id: string }, body: {
      /** Grams, as a string. */
      grossWeight: string;
      /** Grams, as a string. */
      stoneWeight?: string;
      /** Grams, as a string. */
      otherWeight?: string;
      note: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/stock/pieces/${encodeURIComponent(params.id)}/weights`, { body });
    },
    /**
     * Change the making and wastage on a tag
     *
     * A repricing, or a mistake at tagging. Send nulls to hand the piece back to Masters → Formulas.
     * `POST /api/stock/pieces/:id/pricing`
     * Requires `tagging.create`.
     */
    postStockPiecesByIdPricing(params: { id: string }, body: {
      makingBasis: "per_gram" | "flat" | "percent" | null;
      makingRate: string | null;
      wastagePercent: string | null;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/stock/pieces/${encodeURIComponent(params.id)}/pricing`, { body });
    },
    /**
     * Stock by item, purity and location
     *
     * `tracking=lot` is the Lots view: bulk metal and findings by weight, valued at average cost.
     * `GET /api/stock/balances`
     * Requires `stock.view`.
     */
    getStockBalances(query?: {
      branchId?: string;
      locationId?: string;
      itemId?: string;
      tracking?: "lot" | "piece";
      search?: string;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
    }>('GET', "/api/stock/balances", { query });
    },
    /**
     * The stock journal
     *
     * Append-only, newest first. This is how you answer “where did those 4 grams go”.
     * `GET /api/stock/movements`
     * Requires `stock.view`.
     */
    getStockMovements(query?: {
      itemId?: string;
      locationId?: string;
      pieceId?: string;
      sourceType?: string;
      sourceId?: string;
      /** From the previous page’s nextCursor. */
      cursor?: string;
      limit?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }>('GET', "/api/stock/movements", { query });
    },
    /**
     * Rebuild balances from the journal
     *
     * Recomputes every balance from stock_movement. Nothing should need this, which is why it exists.
     * `POST /api/stock/balances/rebuild`
     * Requires `stock.adjustment.post`.
     */
    postStockBalancesRebuild(): Promise<{
      ok: boolean;
      rebuilt: number;
    }> {
      return request<{
      ok: boolean;
      rebuilt: number;
    }>('POST', "/api/stock/balances/rebuild");
    },
    /**
     * Opening stock in bulk
     *
     * kind: pieces (one row per tagged piece; blank tag_number takes the next tag) or lots (one row per item + purity, by weight). Every row goes into `locationId`. Up to 1,000 rows a call; good rows are saved, bad ones come back with their spreadsheet row. Items and purities are named by code.
     * `POST /api/stock/import/:kind`
     * Requires `stock.opening.create`.
     */
    postStockImportByKind(params: { kind: string }, body: {
      locationId: string;
      rows: Array<Record<string, unknown>>;
      /** Spreadsheet row of rows[0]. */
      firstRow?: number;
    }): Promise<{
      received: number;
      inserted: number;
      failed: Array<{
        row: number;
        message: string;
      }>;
    }> {
      return request<{
      received: number;
      inserted: number;
      failed: Array<{
        row: number;
        message: string;
      }>;
    }>('POST', `/api/stock/import/${encodeURIComponent(params.kind)}`, { body });
    },
    /**
     * Transfers
     *
     * `branchId` matches either end.
     * `GET /api/stock/transfers`
     * Requires `stock.view`.
     */
    getStockTransfers(query?: {
      status?: "in_transit" | "received" | "cancelled";
      branchId?: string;
      /** From the previous page’s nextCursor. */
      cursor?: string;
      limit?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }>('GET', "/api/stock/transfers", { query });
    },
    /**
     * One transfer with its lines
     *
     * `GET /api/stock/transfers/:id`
     * Requires `stock.view`.
     */
    getStockTransfersById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/stock/transfers/${encodeURIComponent(params.id)}`);
    },
    /**
     * Send stock to another location
     *
     * Inside a branch it completes at once. To another branch it stays in transit until that branch receives it.
     * `POST /api/stock/transfers`
     * Requires `stock.transfer.create`.
     */
    postStockTransfers(body: {
      fromLocationId: string;
      toLocationId: string;
      pieceIds?: Array<string>;
      lots?: Array<{
        itemId: string;
        purityId: string;
        /** Grams, as a string. */
        netWeight: string;
        /** Grams, as a string. */
        grossWeight?: string;
      }>;
      note?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/stock/transfers", { body });
    },
    /**
     * Receive a transfer
     *
     * The receiving branch confirms the goods arrived.
     * `POST /api/stock/transfers/:id/receive`
     * Requires `stock.transfer.post`.
     */
    postStockTransfersByIdReceive(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/stock/transfers/${encodeURIComponent(params.id)}/receive`);
    },
    /**
     * Cancel a transfer on the road
     *
     * The goods go back to where they were sent from.
     * `POST /api/stock/transfers/:id/cancel`
     * Requires `stock.transfer.cancel`.
     */
    postStockTransfersByIdCancel(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/stock/transfers/${encodeURIComponent(params.id)}/cancel`);
    },
    /**
     * Adjustments
     *
     * `GET /api/stock/adjustments`
     * Requires `stock.view`.
     */
    getStockAdjustments(query?: {
      branchId?: string;
      /** From the previous page’s nextCursor. */
      cursor?: string;
      limit?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }>('GET', "/api/stock/adjustments", { query });
    },
    /**
     * Adjust stock
     *
     * shortage, damage, loss and write_off take pieces (written off) and lot weight out; found adds lot weight. One branch per adjustment, a note is required, and it cannot be edited. Owner and branch admin only.
     * `POST /api/stock/adjustments`
     * Requires `stock.adjustment.post`.
     */
    postStockAdjustments(body: {
      reason: "shortage" | "damage" | "loss" | "write_off" | "found";
      note: string;
      pieceIds?: Array<string>;
      lots?: Array<{
        itemId: string;
        purityId: string;
        /** Grams, as a string. */
        netWeight: string;
        /** Grams, as a string. */
        grossWeight?: string;
        locationId: string;
      }>;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/stock/adjustments", { body });
    },
    /**
     * Stock counts
     *
     * `GET /api/stock/counts`
     * Requires `stock.view`.
     */
    getStockCounts(query?: {
      branchId?: string;
      status?: "open" | "posted" | "cancelled";
      /** From the previous page’s nextCursor. */
      cursor?: string;
      limit?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      nextCursor: unknown;
    }>('GET', "/api/stock/counts", { query });
    },
    /**
     * Start counting a location
     *
     * `POST /api/stock/counts`
     * Requires `stock.count.create`.
     */
    postStockCounts(body: {
      locationId: string;
      note?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/stock/counts", { body });
    },
    /**
     * A count against the books
     *
     * Every piece as found, missing, elsewhere or unknown; every lot with book and counted weight.
     * `GET /api/stock/counts/:id`
     * Requires `stock.view`.
     */
    getStockCountsById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/stock/counts/${encodeURIComponent(params.id)}`);
    },
    /**
     * Scan tags
     *
     * Send one tag per scan, or many pasted at once. A tag already scanned is ignored.
     * `POST /api/stock/counts/:id/scan`
     * Requires `stock.count.create`.
     */
    postStockCountsByIdScan(params: { id: string }, body: {
      tags: Array<string>;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
    }>('POST', `/api/stock/counts/${encodeURIComponent(params.id)}/scan`, { body });
    },
    /**
     * Record a lot’s weight on the scale
     *
     * `POST /api/stock/counts/:id/lots`
     * Requires `stock.count.create`.
     */
    postStockCountsByIdLots(params: { id: string }, body: {
      itemId: string;
      purityId: string;
      /** Grams, as a string. */
      netWeight: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/stock/counts/${encodeURIComponent(params.id)}/lots`, { body });
    },
    /**
     * Remove a scanned tag or weighed lot
     *
     * `DELETE /api/stock/counts/:id/lines/:lineId`
     * Requires `stock.count.create`.
     */
    deleteStockCountsByIdLinesByLineId(params: { id: string; lineId: string }): Promise<void> {
      return request<void>('DELETE', `/api/stock/counts/${encodeURIComponent(params.id)}/lines/${encodeURIComponent(params.lineId)}`);
    },
    /**
     * Post a count
     *
     * Moves pieces found here from other locations of the branch, sets weighed lots to the scale weight, and writes off missing pieces only if `writeOffMissing`. One stock-count adjustment. Owner and branch admin only.
     * `POST /api/stock/counts/:id/post`
     * Requires `stock.count.post`.
     */
    postStockCountsByIdPost(params: { id: string }, body: {
      writeOffMissing?: boolean;
      note: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/stock/counts/${encodeURIComponent(params.id)}/post`, { body });
    },
    /**
     * Cancel a count
     *
     * Nothing changes in stock.
     * `POST /api/stock/counts/:id/cancel`
     * Requires `stock.count.create`.
     */
    postStockCountsByIdCancel(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/stock/counts/${encodeURIComponent(params.id)}/cancel`);
    },
    /**
     * Tag pieces
     *
     * Creates the pieces, their HUID records and their opening stock, all or nothing. The pieces join the tag print queue.
     * `POST /api/tagging/pieces`
     * Requires `tagging.create`.
     */
    postTaggingPieces(body: {
      pieces: Array<{
        itemId: string;
        purityId: string;
        locationId: string;
        /** As on the scale. */
        grossWeight: string;
        /** Grams, as a string. */
        stoneWeight?: string;
        /** Grams, as a string. */
        otherWeight?: string;
        stoneCount?: number;
        /** Rupees, as a string. Never a float. */
        stoneValue?: string;
        huid?: string;
        hallmarkCentre?: string;
        /** Rupees, as a string. Never a float. */
        costValue?: string;
        /** Rupees, as a string. Never a float. */
        makingCost?: string;
        supplierId?: string;
        /** Leave out to take the next tag number. */
        tagNumber?: string;
        /** How the tag’s making is charged. With makingRate it wins over Masters → Formulas. */
        makingBasis?: "per_gram" | "flat" | "percent";
        /** ₹/g, ₹/piece, or % of metal value. */
        makingRate?: string;
        /** % of net weight charged as extra metal. Blank uses the formula. */
        wastagePercent?: string;
        /** A purchase lot waiting in Tagging: the piece takes its location, supplier and a share of its cost. */
        taggingLotId?: string;
      }>;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
    }>('POST', "/api/tagging/pieces", { body });
    },
    /**
     * Print tags
     *
     * Logs the print against the design used, takes the pieces out of the print queue, and returns the values for each label. The browser draws and prints them. A queue print refuses pieces already printed (someone else printed them a moment ago) and names who and when; `reprint: true` prints a tag again on purpose.
     * `POST /api/tagging/print`
     * Requires `tagging.create`.
     */
    postTaggingPrint(body: {
      templateId: string;
      pieceIds: Array<string>;
      reprint?: boolean;
    }): Promise<{
      jobId: string;
      labels: Array<Record<string, unknown>>;
    }> {
      return request<{
      jobId: string;
      labels: Array<Record<string, unknown>>;
    }>('POST', "/api/tagging/print", { body });
    },
    /**
     * List tag designs
     *
     * Paginated. `total` is the count before paging, for the pager.
     * `GET /api/tagging/templates`
     * Requires `tagging.template.view`.
     */
    getTaggingTemplates(query?: {
      /** Matches nothing. */
      search?: string;
      /** From the previous page's nextCursor (large lists only). */
      cursor?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }>('GET', "/api/tagging/templates", { query });
    },
    /**
     * Get one tag design
     *
     * `GET /api/tagging/templates/:id`
     * Requires `tagging.template.view`.
     */
    getTaggingTemplatesById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/tagging/templates/${encodeURIComponent(params.id)}`);
    },
    /**
     * Create a tag design
     *
     * `POST /api/tagging/templates`
     * Requires `tagging.template.create`.
     */
    postTaggingTemplates(body: {
      code: string;
      name: string;
      /** Size and margins in mm, as the designer keeps them. */
      page: Record<string, unknown>;
      /** The Fabric canvas. */
      canvas_json: string;
      /** Which field each text object prints. */
      bindings: Array<Record<string, unknown>>;
      is_default?: boolean;
      is_active?: boolean;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/tagging/templates", { body });
    },
    /**
     * Update a tag design
     *
     * Only the fields you send are changed.
     * `PATCH /api/tagging/templates/:id`
     * Requires `tagging.template.update`.
     */
    patchTaggingTemplatesById(params: { id: string }, body: {
      name?: string;
      /** Size and margins in mm, as the designer keeps them. */
      page?: Record<string, unknown>;
      /** The Fabric canvas. */
      canvas_json?: string;
      /** Which field each text object prints. */
      bindings?: Array<Record<string, unknown>>;
      is_default?: boolean;
      is_active?: boolean;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PATCH', `/api/tagging/templates/${encodeURIComponent(params.id)}`, { body });
    },
    /**
     * Remove a tag design
     *
     * Soft delete — the row stays for the audit trail and disappears from lists.
     * `DELETE /api/tagging/templates/:id`
     * Requires `tagging.template.delete`.
     */
    deleteTaggingTemplatesById(params: { id: string }): Promise<void> {
      return request<void>('DELETE', `/api/tagging/templates/${encodeURIComponent(params.id)}`);
    },
    /**
     * List scheme plans
     *
     * Paginated. `total` is the count before paging, for the pager.
     * `GET /api/schemes/plans`
     * Requires `schemes.plans.view`.
     */
    getSchemesPlans(query?: {
      /** Matches code, name. */
      search?: string;
      is_active?: boolean;
      /** From the previous page's nextCursor (large lists only). */
      cursor?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }>('GET', "/api/schemes/plans", { query });
    },
    /**
     * Get one scheme plan
     *
     * `GET /api/schemes/plans/:id`
     * Requires `schemes.plans.view`.
     */
    getSchemesPlansById(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('GET', `/api/schemes/plans/${encodeURIComponent(params.id)}`);
    },
    /**
     * Create a scheme plan
     *
     * `POST /api/schemes/plans`
     * Requires `schemes.plans.create`.
     */
    postSchemesPlans(body: {
      code: string;
      name: string;
      description?: string;
      metal_id: string;
      /** weight accrues grams at each payment’s rate — the customer is owed metal, not money. */
      accrual_basis?: "rupee" | "weight";
      tenure_months: number;
      /** Rupees, as a string. Never a float. */
      installment_amount?: string;
      is_flexible_amount?: boolean;
      /** The classic "pay 11, get 12" is 1. */
      bonus_installments?: string;
      bonus_percent?: string;
      max_missed_installments?: number;
      making_charge_discount_percent?: string;
      allow_partial_redemption?: boolean;
      allow_cash_redemption?: boolean;
      grace_period_days?: number;
      terms_and_conditions?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/schemes/plans", { body });
    },
    /**
     * Update a scheme plan
     *
     * Only the fields you send are changed.
     * `PATCH /api/schemes/plans/:id`
     * Requires `schemes.plans.update`.
     */
    patchSchemesPlansById(params: { id: string }, body: {
      name?: string;
      is_active?: boolean;
      bonus_installments?: string;
      terms_and_conditions?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PATCH', `/api/schemes/plans/${encodeURIComponent(params.id)}`, { body });
    },
    /**
     * Remove a scheme plan
     *
     * Soft delete — the row stays for the audit trail and disappears from lists.
     * `DELETE /api/schemes/plans/:id`
     * Requires `schemes.plans.delete`.
     */
    deleteSchemesPlansById(params: { id: string }): Promise<void> {
      return request<void>('DELETE', `/api/schemes/plans/${encodeURIComponent(params.id)}`);
    },
    /**
     * Enroll a customer and generate the installment schedule
     *
     * Creates the account and writes every installment row up front, so “what is due this month” is a simple query rather than a calculation.
     * `POST /api/schemes/accounts`
     * Requires `schemes.accounts.create`.
     */
    postSchemesAccounts(body: {
      schemePlanId: string;
      customerId: string;
      branchId: string;
      enrolledOn: string;
      /** Rupees, as a string. Never a float. */
      installmentAmount: string;
      dueDay?: number;
      nomineeName?: string;
      nomineeRelationship?: string;
      nomineePhone?: string;
    }): Promise<{
      account: Record<string, unknown>;
      installments: number;
    }> {
      return request<{
      account: Record<string, unknown>;
      installments: number;
    }>('POST', "/api/schemes/accounts", { body });
    },
    /**
     * Collect an installment
     *
     * Records the payment and, for weight-basis plans, the grams it bought at today’s rate — which is what the customer is actually owed.
     * `POST /api/schemes/installments/:id/collect`
     * Requires `schemes.collection.create`.
     */
    postSchemesInstallmentsByIdCollect(params: { id: string }, body: {
      /** Rupees, as a string. Never a float. */
      amountPaid: string;
      paidOn: string;
      paymentMode: "cash" | "card" | "upi" | "bank_transfer" | "cheque" | "auto_debit";
      paymentReference?: string;
      /** Rupees, as a string. Never a float. */
      ratePerGram?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/schemes/installments/${encodeURIComponent(params.id)}/collect`, { body });
    },
    /**
     * List scheme accounts
     *
     * `GET /api/schemes/accounts`
     * Requires `schemes.accounts.view`.
     */
    getSchemesAccounts(query?: {
      status?: "active" | "matured" | "redeemed" | "defaulted" | "cancelled" | "closed";
      customerId?: string;
      branchId?: string;
      search?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }>('GET', "/api/schemes/accounts", { query });
    },
    /**
     * Installments due or missed
     *
     * Drives the "Scheme collections due today" dashboard alert and the reminder run.
     * `GET /api/schemes/due`
     * Requires `schemes.collection.view`.
     */
    getSchemesDue(query?: {
      onDate?: string;
      includeMissed?: boolean;
      branchId?: string;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      /** Rupees, as a string. Never a float. */
      totalDue: string;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      /** Rupees, as a string. Never a float. */
      totalDue: string;
    }>('GET', "/api/schemes/due", { query });
    },
    /**
     * Sanction a Girvi loan
     *
     * Appraises the collateral, caps the principal at the configured LTV (75% by default), and records the vault packet the items are sealed into.
     * `POST /api/girvi/loans`
     * Requires `girvi.create`.
     */
    postGirviLoans(body: {
      branchId: string;
      /** Omit for a walk-in; the borrower fields are then required. */
      customerId?: string;
      borrowerName: string;
      borrowerPhone: string;
      borrowerAddress?: string;
      borrowerIdType?: "aadhaar" | "pan" | "voter" | "driving_licence" | "passport";
      borrowerIdNumber?: string;
      sanctionedOn: string;
      dueDate: string;
      /** Regulatory cap is 75%. */
      ltvPercent?: string;
      /** Rupees, as a string. Never a float. */
      principalAmount: string;
      interestRateMonthly: string;
      /** Rupees, as a string. Never a float. */
      processingFee?: string;
      disbursalMode?: "cash" | "bank_transfer" | "upi" | "cheque";
      vaultPacketNumber?: string;
      vaultLocationId?: string;
      collateral: Array<{
        description: string;
        metalId: string;
        purityId?: string | null;
        quantity?: number;
        /** Grams, as a string. */
        grossWeight: string;
        /** Grams, as a string. */
        stoneWeight?: string;
        testedPurityPercent: string;
        testMethod?: "xrf" | "touchstone" | "declared";
        /** Buying rate used for appraisal. */
        ratePerGram: string;
        conditionNotes?: string;
        photoStorageKey?: string;
      }>;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', "/api/girvi/loans", { body });
    },
    /**
     * List Girvi loans
     *
     * `GET /api/girvi/loans`
     * Requires `girvi.view`.
     */
    getGirviLoans(query?: {
      status?: "draft" | "sanctioned" | "active" | "overdue" | "redeemed" | "defaulted" | "auctioned" | "cancelled";
      branchId?: string;
      /** Matches loan number, borrower or vault packet. */
      search?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }>('GET', "/api/girvi/loans", { query });
    },
    /**
     * Record a repayment
     *
     * Interest is cleared before principal. The balance after the payment is stored so a receipt reprints exactly.
     * `POST /api/girvi/loans/:id/repayments`
     * Requires `girvi.update`.
     */
    postGirviLoansByIdRepayments(params: { id: string }, body: {
      /** Rupees, as a string. Never a float. */
      amount: string;
      paidOn: string;
      mode?: "cash" | "card" | "upi" | "bank_transfer" | "cheque";
      reference?: string;
      /** Rupees, as a string. Never a float. */
      penaltyComponent?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/girvi/loans/${encodeURIComponent(params.id)}/repayments`, { body });
    },
    /**
     * The precious metal ledger, in fine grams
     *
     * The gram side of the dual ledger. Weights are fine (pure) so purities are comparable.
     * `GET /api/accounts/metal-ledger`
     * Requires `accounts.metal.view`.
     */
    getAccountsMetalledger(query?: {
      accountId?: string;
      partyId?: string;
      metalId?: string;
      from?: string;
      to?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      /** Grams, as a string. */
      balance: string;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      /** Grams, as a string. */
      balance: string;
    }>('GET', "/api/accounts/metal-ledger", { query });
    },
    /**
     * Trial balance
     *
     * Debits and credits per account. If these do not match, something is badly wrong — they always should.
     * `GET /api/accounts/trial-balance`
     * Requires `accounts.cash.view`.
     */
    getAccountsTrialbalance(query?: {
      from?: string;
      to?: string;
      branchId?: string;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      /** Rupees, as a string. Never a float. */
      totalDebit: string;
      /** Rupees, as a string. Never a float. */
      totalCredit: string;
      balanced: boolean;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      /** Rupees, as a string. Never a float. */
      totalDebit: string;
      /** Rupees, as a string. Never a float. */
      totalCredit: string;
      balanced: boolean;
    }>('GET', "/api/accounts/trial-balance", { query });
    },
    /**
     * Karigar metal and ghat ledger
     *
     * Metal issued to each goldsmith, what came back, and the ghat (loss). Loss above the agreed allowance is recoverable and is what this screen exists to surface.
     * `GET /api/accounts/karigar-ledger`
     * Requires `accounts.ghat.view`.
     */
    getAccountsKarigarledger(query?: {
      karigarId?: string;
      from?: string;
      to?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      /** Grams, as a string. */
      metalBalance: string;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      /** Grams, as a string. */
      metalBalance: string;
    }>('GET', "/api/accounts/karigar-ledger", { query });
    },
    /**
     * Every permission a role can hold, grouped by module
     *
     * Reference only. Roles are fixed in code, so nothing here can be assigned or combined into a new role from inside a business.
     * `GET /api/settings/permissions`
     * Requires `settings.roles.view`.
     */
    getSettingsPermissions(): Promise<{
      permissions: Array<Record<string, unknown>>;
    }> {
      return request<{
      permissions: Array<Record<string, unknown>>;
    }>('GET', "/api/settings/permissions");
    },
    /**
     * The roles in this business, their permissions and how many people hold each
     *
     * Fixed in code and seeded per business. A shop can see what each role can do; only the super admin decides who holds one.
     * `GET /api/settings/roles`
     * Requires `settings.roles.view`.
     */
    getSettingsRoles(): Promise<{
      rows: Array<Record<string, unknown>>;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
    }>('GET', "/api/settings/roles");
    },
    /**
     * Who works in this business, and their roles at each branch
     *
     * Staff are created, named and given their access by the super admin. From inside the business the list is read-only, apart from switching someone off — see `POST /api/settings/users/:id/status`.
     * `GET /api/settings/users`
     * Requires `settings.users.view`.
     */
    getSettingsUsers(query?: {
      search?: string;
      roleId?: string;
      branchId?: string;
      isActive?: "true" | "false";
    }): Promise<{
      rows: Array<Record<string, unknown>>;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
    }>('GET', "/api/settings/users", { query });
    },
    /**
     * Switch a staff account on or off
     *
     * The one change a business may make to its own people, because somebody leaving at short notice should not wait on us. Deactivating signs them out everywhere immediately.
     * 
     * Everything else about a staff member — creating them, their name, their role, what it reaches — stays with the super admin. An owner cannot be deactivated here, and nobody can switch off their own account.
     * `POST /api/settings/users/:id/status`
     * Requires `settings.users.status`.
     */
    postSettingsUsersByIdStatus(params: { id: string }, body: {
      isActive: boolean;
    }): Promise<void> {
      return request<void>('POST', `/api/settings/users/${encodeURIComponent(params.id)}/status`, { body });
    },
    /**
     * Price lines exactly as billing will — nothing is saved
     *
     * For live totals while a bill or order is being built. Posting a document always re-prices on the server; the client's numbers are never trusted.
     * `POST /api/pricing/preview`
     * Requires `pos.view`.
     */
    postPricingPreview(body: {
      customerStateCode?: string | null;
      lines: Array<{
        metalId: string;
        purityId: string;
        itemId?: string | null;
        categoryId?: string | null;
        hsnCode?: unknown;
        quantity?: number;
        grossWeightG: string;
        stoneWeightG?: string;
        otherWeightG?: string;
        stoneAmount?: string;
        hallmarkAmount?: string;
        discount?: {
          amount: string;
          on: "making" | "charges" | "total";
        } | null;
        override?: {
          ratePerGram?: string;
          making?: {
            id?: null;
            basis: "per_gram" | "percent" | "flat" | "slab" | "hybrid";
            rate: string | null;
            flatAmount?: string | null;
            slabs?: Array<{
              fromG: string;
              toG: string | null;
              rate: string;
            }>;
            slabMode?: "whole" | "tiered";
            minimumAmount?: string | null;
          };
        };
      }>;
    }): Promise<{
      lines: Array<Record<string, unknown>>;
      totals: Record<string, unknown>;
    }> {
      return request<{
      lines: Array<Record<string, unknown>>;
      totals: Record<string, unknown>;
    }>('POST', "/api/pricing/preview", { body });
    },
    /**
     * Super admin sign-in
     *
     * No tenant code — platform operators do not belong to a tenant. The token returned is a *platform* token and is rejected by every tenant route, and vice versa.
     * `POST /api/platform/auth/login`
     */
    postPlatformAuthLogin(body: {
      email: string;
      password: string;
    }): Promise<{
      accessToken: string;
      refreshToken: string;
      user: {
        id: string;
        email: string;
        fullName: string;
        role: string;
        roleName: string;
      };
      permissions: Array<string>;
    }> {
      return request<{
      accessToken: string;
      refreshToken: string;
      user: {
        id: string;
        email: string;
        fullName: string;
        role: string;
        roleName: string;
      };
      permissions: Array<string>;
    }>('POST', "/api/platform/auth/login", { body });
    },
    /**
     * Refresh a platform session
     *
     * `POST /api/platform/auth/refresh`
     */
    postPlatformAuthRefresh(body: {
      refreshToken: string;
    }): Promise<{
      accessToken: string;
    }> {
      return request<{
      accessToken: string;
    }>('POST', "/api/platform/auth/refresh", { body });
    },
    /**
     * Revoke a platform refresh token
     *
     * `POST /api/platform/auth/logout`
     */
    postPlatformAuthLogout(body: {
      refreshToken: string;
    }): Promise<void> {
      return request<void>('POST', "/api/platform/auth/logout", { body });
    },
    /**
     * The role templates
     *
     * One platform role, holding everything. Inside a business there are three kinds: `owner`, `admin` and `staff`. Only the first two are seeded — staff roles are named and given their permissions per business, because one shop’s accountant is not another’s. `isBranchAdmin` marks the role limited to one holder per branch.
     * `GET /api/platform/roles`
     */
    getPlatformRoles(): Promise<{
      platform: {
        code: string;
        name: string;
        description: string;
        permissions: Array<string>;
      };
      roleTypes: Array<string>;
      tenant: Array<{
        code: string;
        name: string;
        type: string;
        description: string;
        isBranchAdmin: boolean;
        permissions: Array<string>;
      }>;
    }> {
      return request<{
      platform: {
        code: string;
        name: string;
        description: string;
        permissions: Array<string>;
      };
      roleTypes: Array<string>;
      tenant: Array<{
        code: string;
        name: string;
        type: string;
        description: string;
        isBranchAdmin: boolean;
        permissions: Array<string>;
      }>;
    }>('GET', "/api/platform/roles");
    },
    /**
     * Every permission a staff role can be given, as module → group → action
     *
     * What the role builder ticks. Built from the live routes, so it cannot offer a switch the API does not enforce — if a permission is here, granting it genuinely grants something.
     * 
     * `module` is the top level (Billing, Stock). `groups` are the areas within it, and a group whose key equals the module is that module’s own actions rather than a sub-area. `wildcard` on each level is the string to grant for "all of this".
     * `GET /api/platform/permission-tree`
     * Requires `platform.tenants.view`.
     */
    getPlatformPermissiontree(): Promise<{
      modules: Array<{
        key: string;
        name: string;
        wildcard: string;
        groups: Array<{
          key: string;
          name: string;
          wildcard: unknown;
          permissions: Array<{
            code: string;
            action: string;
            description: string;
          }>;
        }>;
      }>;
    }> {
      return request<{
      modules: Array<{
        key: string;
        name: string;
        wildcard: string;
        groups: Array<{
          key: string;
          name: string;
          wildcard: unknown;
          permissions: Array<{
            code: string;
            action: string;
            description: string;
          }>;
        }>;
      }>;
    }>('GET', "/api/platform/permission-tree");
    },
    /**
     * The module catalog, for provisioning
     *
     * `GET /api/platform/modules`
     * Requires `platform.tenants.view`.
     */
    getPlatformModules(): Promise<{
      modules: Array<Record<string, unknown>>;
    }> {
      return request<{
      modules: Array<Record<string, unknown>>;
    }>('GET', "/api/platform/modules");
    },
    /**
     * List every tenant
     *
     * `GET /api/platform/tenants`
     * Requires `platform.tenants.view`.
     */
    getPlatformTenants(query?: {
      status?: "trial" | "active" | "suspended" | "closed";
      kind?: "manufacturer" | "retailer" | "both";
      /** Matches code or name. */
      search?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
      total?: number;
      limit?: number;
      offset?: number;
    }>('GET', "/api/platform/tenants", { query });
    },
    /**
     * Create a tenant with its Admin and first branch
     *
     * One call sets up everything a business needs to start: the tenant, its chart of accounts, purities, numbering series, the five roles, the head user (Admin) and the first branch with its stock locations. A half-created tenant is worse than none, so this does the lot.
     * `POST /api/platform/tenants`
     * Requires `platform.tenants.create`.
     */
    postPlatformTenants(body: {
      /** Used at sign-in and in URLs. Cannot be changed later. */
      code: string;
      legalName: string;
      displayName?: string;
      /** Decides which modules the tenant can see at all. */
      kind?: "manufacturer" | "retailer" | "both";
      gstin?: string;
      pan?: string;
      /** GST state code — decides CGST+SGST vs IGST. */
      stateCode?: string;
      /** How many branches they may have. Omit for no limit. */
      maxBranches?: number | null;
      /** The head user. Gets the Admin role and can then create all other staff. */
      admin: {
        email: string;
        fullName: string;
        /** At least 8 characters. */
        password: string;
        phone?: string;
      };
      /** Omit to get a default "MAIN" branch. */
      branch?: {
        code: string;
        name: string;
        kind?: "showroom" | "factory" | "warehouse" | "office";
        city?: string;
        state?: string;
        stateCode?: string;
      };
      /** Omit to use each module’s default licence. */
      modules?: Array<{
        key: string;
        licence: "included" | "purchased" | "trial";
        trialDays?: number;
        /** false creates the tenant with this module switched off. Not allowed for required modules. */
        enabled?: boolean;
      }>;
    }): Promise<{
      tenantId: string;
      branchId: string;
      adminUserId: string;
    }> {
      return request<{
      tenantId: string;
      branchId: string;
      adminUserId: string;
    }>('POST', "/api/platform/tenants", { body });
    },
    /**
     * One tenant with its branches, users and module licences
     *
     * The staff list is included only for a role holding `platform.users.view`. A Billing Admin can see the business and its licences without seeing who works there.
     * `GET /api/platform/tenants/:id`
     * Requires `platform.tenants.view`.
     */
    getPlatformTenantsById(params: { id: string }): Promise<{
      tenant: Record<string, unknown>;
      branches: Array<Record<string, unknown>>;
      users: Array<Record<string, unknown>>;
      modules: Array<Record<string, unknown>>;
    }> {
      return request<{
      tenant: Record<string, unknown>;
      branches: Array<Record<string, unknown>>;
      users: Array<Record<string, unknown>>;
      modules: Array<Record<string, unknown>>;
    }>('GET', `/api/platform/tenants/${encodeURIComponent(params.id)}`);
    },
    /**
     * Update a tenant
     *
     * Setting `status` to `suspended` blocks every user of that tenant from signing in. Their data is untouched.
     * `PATCH /api/platform/tenants/:id`
     * Requires `platform.tenants.update`.
     */
    patchPlatformTenantsById(params: { id: string }, body: {
      displayName?: string;
      legalName?: string;
      status?: "trial" | "active" | "suspended" | "closed";
      kind?: "manufacturer" | "retailer" | "both";
      gstin?: string;
      pan?: string;
      /** How many branches this business may have. Null means no limit. */
      maxBranches?: number | null;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PATCH', `/api/platform/tenants/${encodeURIComponent(params.id)}`, { body });
    },
    /**
     * The roles this business has
     *
     * Owner and Branch Admin are seeded and fixed. Everything else is a staff role you named and gave permissions to. `user_count` is how many people hold each.
     * `GET /api/platform/tenants/:id/roles`
     * Requires `platform.tenants.view`.
     */
    getPlatformTenantsByIdRoles(params: { id: string }): Promise<{
      rows: Array<Record<string, unknown>>;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
    }>('GET', `/api/platform/tenants/${encodeURIComponent(params.id)}/roles`);
    },
    /**
     * Create a staff role for this business
     *
     * The code is derived from the name. Permissions must come from `GET /api/platform/permission-tree` — anything else is refused, so a role cannot be given a right that nothing enforces.
     * 
     * Only staff roles can be created: Owner and Branch Admin already exist and are fixed.
     * `POST /api/platform/tenants/:id/roles`
     * Requires `platform.tenants.update`.
     */
    postPlatformTenantsByIdRoles(params: { id: string }, body: {
      name: string;
      description?: string | null;
      permissions: Array<string>;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/platform/tenants/${encodeURIComponent(params.id)}/roles`, { body });
    },
    /**
     * Rename a staff role, or change what it can reach
     *
     * Send the complete permission list, not a delta. Everyone holding the role is signed back in against the new list immediately rather than at token expiry.
     * `PATCH /api/platform/tenants/:id/roles/:roleId`
     * Requires `platform.tenants.update`.
     */
    patchPlatformTenantsByIdRolesByRoleId(params: { id: string; roleId: string }, body: {
      name?: string;
      description?: string | null;
      permissions?: Array<string>;
      isActive?: boolean;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PATCH', `/api/platform/tenants/${encodeURIComponent(params.id)}/roles/${encodeURIComponent(params.roleId)}`, { body });
    },
    /**
     * Delete a staff role nobody holds
     *
     * `DELETE /api/platform/tenants/:id/roles/:roleId`
     * Requires `platform.tenants.update`.
     */
    deletePlatformTenantsByIdRolesByRoleId(params: { id: string; roleId: string }): Promise<void> {
      return request<void>('DELETE', `/api/platform/tenants/${encodeURIComponent(params.id)}/roles/${encodeURIComponent(params.roleId)}`);
    },
    /**
     * Add a branch to a tenant
     *
     * Creates the branch together with its stock locations and its own document numbering series — without those the first invoice at that branch would fail.
     * `POST /api/platform/tenants/:id/branches`
     * Requires `platform.tenants.update`.
     */
    postPlatformTenantsByIdBranches(params: { id: string }, body: {
      code: string;
      name: string;
      kind?: "showroom" | "factory" | "warehouse" | "office";
      gstin?: string;
      stateCode?: string;
      city?: string;
      state?: string;
      address_line1?: string;
      pincode?: string;
      phone?: string;
      email?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/platform/tenants/${encodeURIComponent(params.id)}/branches`, { body });
    },
    /**
     * Create a user inside a tenant
     *
     * Only you can do this — nobody inside the business can create users. Give `branchId` to place the person at one branch; leave it out and they cover all branches. A branch has exactly one admin, so creating a second one for the same branch is refused with `409` naming whoever already holds the slot.
     * `POST /api/platform/tenants/:id/users`
     * Requires `platform.users.create`.
     */
    postPlatformTenantsByIdUsers(params: { id: string }, body: {
      email?: string | null;
      phone?: unknown;
      fullName: string;
      password: string;
      roleCode?: string;
      role?: string;
      /** Their branch. Omit to cover all branches. */
      branchId?: string;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/platform/tenants/${encodeURIComponent(params.id)}/users`, { body });
    },
    /**
     * Change a user’s role, branch, contact details or activation
     *
     * Moving someone to `admin`, or moving an existing admin to another branch, is refused if that branch already has one. The only admin in a business cannot be deactivated — the shop would be left with nobody able to run it.
     * 
     * Name and contact editing lives here because it has no tenant-side equivalent: a shop cannot edit its own staff, so without this a misspelled name could never be corrected.
     * `PATCH /api/platform/tenants/:id/users/:userId`
     * Requires `platform.users.update`.
     */
    patchPlatformTenantsByIdUsersByUserId(params: { id: string; userId: string }, body: {
      roleCode?: string;
      role?: string;
      /** Null moves them to all branches. Omit to leave their branch alone. */
      branchId?: string | null;
      isActive?: boolean;
      fullName?: string;
      email?: string | null;
      phone?: unknown;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PATCH', `/api/platform/tenants/${encodeURIComponent(params.id)}/users/${encodeURIComponent(params.userId)}`, { body });
    },
    /**
     * Give a tenant user a new temporary password
     *
     * The recovery path for a locked-out shop, and the only one: staff are yours to manage, so the tenant-side reset no longer exists. The password is returned once and never stored in readable form. They are signed out everywhere and must set a new password at next sign-in.
     * `POST /api/platform/tenants/:id/users/:userId/reset-password`
     * Requires `platform.users.reset_password`.
     */
    postPlatformTenantsByIdUsersByUserIdResetpassword(params: { id: string; userId: string }): Promise<{
      temporaryPassword: string;
    }> {
      return request<{
      temporaryPassword: string;
    }>('POST', `/api/platform/tenants/${encodeURIComponent(params.id)}/users/${encodeURIComponent(params.userId)}/reset-password`);
    },
    /**
     * The signed-in operator, with their role and permissions
     *
     * What this operator may actually do, so a panel can hide what they cannot reach rather than letting them find a 403. Only `super_admin` has an account today and it is seeded from the command line — there is no endpoint that creates an operator.
     * `GET /api/platform/me`
     */
    getPlatformMe(): Promise<{
      id: string;
      email: string;
      full_name: string;
      role: string;
      roleName: string;
      roleDescription: string;
      permissions: Array<string>;
      phone: unknown;
      is_active: boolean;
      last_login_at: unknown;
      created_at: string;
    }> {
      return request<{
      id: string;
      email: string;
      full_name: string;
      role: string;
      roleName: string;
      roleDescription: string;
      permissions: Array<string>;
      phone: unknown;
      is_active: boolean;
      last_login_at: unknown;
      created_at: string;
    }>('GET', "/api/platform/me");
    },
    /**
     * Platform audit log
     *
     * Every super-admin action, newest first.
     * `GET /api/platform/audit`
     * Requires `platform.audit.view`.
     */
    getPlatformAudit(query?: {
      tenantId?: string;
      action?: string;
      limit?: number;
      offset?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
    }>('GET', "/api/platform/audit", { query });
    },
    /**
     * Platform-wide counts for the super admin dashboard
     *
     * `GET /api/platform/stats`
     * Requires `platform.tenants.view`.
     */
    getPlatformStats(): Promise<{
      tenants: {
        total: number;
        active: number;
        trial: number;
        suspended: number;
      };
      users: number;
      branches: number;
      operators: number;
    }> {
      return request<{
      tenants: {
        total: number;
        active: number;
        trial: number;
        suspended: number;
      };
      users: number;
      branches: number;
      operators: number;
    }>('GET', "/api/platform/stats");
    },
    /**
     * Change a tenant’s module entitlement
     *
     * Grant, revoke, or move a module between included / purchased / trial. A module whose trial or term has lapsed still appears in the tenant’s dock, but locked — so they can see what they are missing rather than having it silently vanish.
     * 
     * `enabled: false` switches the module off: it leaves the tenant’s dock and every endpoint belonging to it answers 403 `module_disabled`, for staff and support sessions alike. `disabledSubmodules` does the same for single sub-modules that have permissions of their own (e.g. `pos.purchase`) — see `enforced` on `GET /api/platform/modules`. Other sub-module keys are accepted but nothing checks them yet. Data is never touched, so switching back on restores everything as it was.
     * 
     * Master Data, Settings and SaaS Admin are `required` in the catalog and cannot be switched off.
     * `PUT /api/platform/tenants/:id/modules/:moduleKey`
     * Requires `platform.entitlement.update`.
     */
    putPlatformTenantsByIdModulesByModuleKey(params: { id: string; moduleKey: string }, body: {
      /** false switches the whole module off for this tenant. */
      enabled?: boolean;
      licence?: "included" | "purchased" | "trial" | "expired";
      /** Omit to keep the current date; null clears it. */
      trialEndsAt?: string | null;
      /** Omit to keep the current date; null clears it. */
      expiresAt?: string | null;
      /** The full list of sub-module keys to switch off, e.g. ["orders.repair"]. Replaces the previous list; [] turns them all back on. */
      disabledSubmodules?: Array<string>;
    }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('PUT', `/api/platform/tenants/${encodeURIComponent(params.id)}/modules/${encodeURIComponent(params.moduleKey)}`, { body });
    },
    /**
     * Start a support session into a tenant
     *
     * The only way a platform role reaches business data. Returns a `token` to send as `Authorization: Bearer` against ordinary tenant endpoints — it is shown once and stored only as a hash, so a lost token means opening a new session.
     * 
     * Read-only unless `canWrite` is set. The session row is checked on every request, so ending it locks the operator out at once rather than when the token would have expired. Every action inside the window is tagged with the session in the tenant’s own audit log.
     * `POST /api/platform/support-sessions`
     * Requires `platform.support.create`.
     */
    postPlatformSupportsessions(body: {
      tenantId: string;
      reason: string;
      durationMinutes?: number;
      /** Needs `platform.support.write`. A deliberate escalation. */
      canWrite?: boolean;
    }): Promise<{
      session: Record<string, unknown>;
      token: string;
      endsAt: string;
    }> {
      return request<{
      session: Record<string, unknown>;
      token: string;
      endsAt: string;
    }>('POST', "/api/platform/support-sessions", { body });
    },
    /**
     * Support sessions, open and past
     *
     * This is the record a tenant is shown when they ask who looked at their data. `action_count` is how many audited changes were made inside the window.
     * `GET /api/platform/support-sessions`
     * Requires `platform.support.view`.
     */
    getPlatformSupportsessions(query?: {
      tenantId?: string;
      /** Only sessions still running. */
      openOnly?: boolean;
      limit?: number;
    }): Promise<{
      rows: Array<Record<string, unknown>>;
    }> {
      return request<{
      rows: Array<Record<string, unknown>>;
    }>('GET', "/api/platform/support-sessions", { query });
    },
    /**
     * Close a support session now
     *
     * The operator’s next request is refused. Closing also discards the token, so it cannot be reused.
     * `POST /api/platform/support-sessions/:id/end`
     * Requires `platform.support.end`.
     */
    postPlatformSupportsessionsByIdEnd(params: { id: string }): Promise<Record<string, unknown>> {
      return request<Record<string, unknown>>('POST', `/api/platform/support-sessions/${encodeURIComponent(params.id)}/end`);
    },
  };
}

export type SwarnayClient = ReturnType<typeof createClient>;
