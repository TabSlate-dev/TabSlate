import { isFirefoxBuild } from "@/lib/browser/env";

// API types — mirror server internal/model/model.go

export interface ApiUser {
  id: string;
  name: string;
  email: string;
  is_verified: boolean;
  created_at: number;
  updated_at: number;
  deletion_scheduled_at?: number | null;
}

export interface AuthResponse {
  user: ApiUser;
  access_token: string;
  refresh_token: string;
}

export interface MeResponse {
  user: ApiUser;
  subscription: {
    plan: string;
    status: string;
    expires_at?: number | null;
  };
}

export interface PlanLimits {
  max_workspaces: number;
  max_bookmarks: number;
  max_collections: number;
  max_tags: number;
  max_saved_groups: number;
  trash_grace_days: number;
}

export interface PlanUsage {
  workspaces: number;
  bookmarks: number;
  collections: number;
  tags: number;
  saved_groups: number;
}

export interface PlanResponse {
  subscription: { plan: string; status: string; expires_at: number | null };
  limits: PlanLimits;
  usage: PlanUsage;
  trash_usage?: PlanUsage;
}

export interface LoginCaptchaStatusResponse {
  captcha_required: boolean;
}

export interface ServerWorkspace {
  id: string;
  user_id: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  position: number;
  seq: number;
  deleted_at?: number;
  is_deleted: 0 | 1 | 2;
  deletion_model: 0 | 1;
  created_at: number;
  updated_at: number;
}

export type WorkspaceLifecycleAction = "delete" | "restore" | "purge";

export interface SyncWorkspaceMutation extends SyncEntity {
  lifecycle_action?: WorkspaceLifecycleAction;
}

export interface ServerCollection {
  id: string;
  user_id: string;
  workspace_id?: string;
  name: string;
  icon?: string;
  position: number;
  seq: number;
  is_deleted: number;
  is_default?: boolean;    // computed by server: true for the lowest-position active collection per workspace
  deleted_at?: number;
  archived_at?: number;
  created_at: number;
  updated_at: number;
}

export interface ServerBookmark {
  id: string;
  user_id: string;
  collection_id?: string;
  title: string;
  url: string;
  favicon_url?: string;
  description?: string;
  is_favorite: boolean;
  is_archived: boolean;
  is_trashed: number;
  tag_ids?: string[];
  position: number;
  seq: number;
  deleted_at?: number;
  created_at: number;
  updated_at: number;
}

export interface ServerTag {
  id: string;
  user_id: string;
  name: string;
  color?: string;
  seq: number;
  deleted_at?: number;
  updated_at: number;
}

export interface ServerGroupTab {
  id: string;
  group_id: string;
  title: string;
  url: string;
  favicon: string;
  position: number;
}

export interface ServerGroup {
  id: string;
  user_id: string;
  name: string;
  color: string;
  is_compact: boolean;
  is_deleted: number;
  seq: number;
  deleted_at?: number;
  created_at: number;
  updated_at: number;
  workspace_id: string | null;
  tabs: ServerGroupTab[];
}

export interface SyncEntities {
  workspaces: ServerWorkspace[];
  collections: ServerCollection[];
  bookmarks: ServerBookmark[];
  tags: ServerTag[];
  groups: ServerGroup[];
}

export interface SyncEntity {
  id: string;
  [key: string]: string | number | boolean | null | undefined | string[] | SyncEntity[];
}

export type SyncEntityType =
  | "workspace"
  | "collection"
  | "bookmark"
  | "saved_group"
  | "tag";

export type KnownSyncRejectionReason =
  | "stale"
  | "quota_exceeded"
  | "parent_rejected"
  | "invalid_parent"
  | "last_active_workspace"
  | "workspace_deleted"
  | "parent_deleted"
  | "permanently_deleted";

export interface SyncRejected {
  id: string;
  reason: string;
  type?: string;
  parent_id?: string;
  parent_type?: string;
}

export interface SyncPushEntities {
  workspaces: SyncWorkspaceMutation[];
  collections: SyncEntity[];
  bookmarks: SyncEntity[];
  tags: SyncEntity[];
  groups: SyncEntity[];
}

export function isSyncEntityType(value: string | undefined): value is SyncEntityType {
  return value === "workspace" ||
    value === "collection" ||
    value === "bookmark" ||
    value === "saved_group" ||
    value === "tag";
}

export function isKnownSyncRejectionReason(value: string): value is KnownSyncRejectionReason {
  return value === "stale" ||
    value === "quota_exceeded" ||
    value === "parent_rejected" ||
    value === "invalid_parent" ||
    value === "last_active_workspace" ||
    value === "workspace_deleted" ||
    value === "parent_deleted" ||
    value === "permanently_deleted";
}

export interface SyncPushResponse {
  server_seq: number;
  rejected: SyncRejected[];
}

export interface SyncPullResponse {
  entities: SyncEntities;
  server_seq: number;
  capabilities?: SyncCapabilities;
}

export interface SyncPushPayload {
  entities: SyncPushEntities;
}

export interface SyncCapabilities {
  workspace_parent_tombstone?: boolean;
}

interface SyncPullWorkspaceWire {
  id: string;
  user_id: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  position: number;
  seq: number;
  deleted_at?: number | null;
  is_deleted?: 0 | 1 | 2;
  deletion_model?: 0 | 1;
  created_at: number;
  updated_at: number;
}

interface SyncPullEntitiesWire {
  workspaces: SyncPullWorkspaceWire[];
  collections: ServerCollection[];
  bookmarks: ServerBookmark[];
  tags: ServerTag[];
  groups: ServerGroup[];
}

interface SyncPullResponseWire {
  entities: SyncPullEntitiesWire;
  server_seq: number;
  capabilities?: SyncCapabilities;
}

function normalizeSyncPullResponse(response: SyncPullResponseWire): SyncPullResponse {
  return {
    entities: {
      ...response.entities,
      workspaces: response.entities.workspaces.map((workspace) => ({
        ...workspace,
        deleted_at: workspace.deleted_at ?? undefined,
        is_deleted: workspace.is_deleted ?? (workspace.deleted_at ? 1 : 0),
        deletion_model: workspace.deletion_model ?? (workspace.deleted_at ? 0 : 1),
      })),
    },
    server_seq: response.server_seq,
    capabilities: response.capabilities,
  };
}

// ApiError carries the HTTP status code so callers can branch on 401, 409, etc.
export class ApiError extends Error {
  /** Whether the server is requesting a captcha (login failure threshold). */
  captchaRequired?: boolean;
  /** Seconds to wait before retrying, populated from the server's retry_after field. */
  retryAfter?: number;

  constructor(
    message: string,
    public readonly status: number,
    captchaRequired?: boolean,
    retryAfter?: number,
  ) {
    super(message);
    this.name = "ApiError";
    this.captchaRequired = captchaRequired;
    this.retryAfter = retryAfter;
  }
}

async function request<T>(
  baseUrl: string,
  path: string,
  options: RequestInit,
): Promise<T> {
  if (!baseUrl) {
    throw new ApiError(
      "Server URL is not configured. Open Advanced settings and enter your server URL.",
      0,
    );
  }
  const url = baseUrl.replace(/\/$/, "") + path;
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers as Record<string, string>),
      },
    });
  } catch (err) {
    const message = isFirefoxBuild()
      ? "Network request failed. If you are using Firefox, ensure the server allows requests from Firefox extension origins (moz-extension://...)."
      : "Network request failed. Check your server URL and network connection.";
    throw new ApiError(message, 0, undefined, undefined);
  }

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    let captchaRequired: boolean | undefined;
    let retryAfter: number | undefined;
    try {
      const body = await res.json();
      if (typeof body?.error === "string") {
        message = body.error;
      }
      if (body?.captcha_required === true) {
        captchaRequired = true;
      }
      if (typeof body?.retry_after === "number") {
        retryAfter = body.retry_after;
      }
    } catch {
      // ignore JSON parse failure — keep the generic message
    }
    throw new ApiError(message, res.status, captchaRequired, retryAfter);
  }

  // 204 No Content or genuinely empty body
  const text = await res.text();
  if (!text) {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

export const api = {
  register(
    baseUrl: string,
    name: string,
    email: string,
    password: string,
    captchaToken?: string,
    lang?: string,
  ): Promise<AuthResponse> {
    return request<AuthResponse>(baseUrl, "/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password, captcha_token: captchaToken }),
      headers: lang ? { "Accept-Language": lang } : undefined,
    });
  },

  login(
    baseUrl: string,
    email: string,
    password: string,
    captchaToken?: string,
    lang?: string,
  ): Promise<AuthResponse> {
    return request<AuthResponse>(baseUrl, "/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, captcha_token: captchaToken }),
      headers: lang ? { "Accept-Language": lang } : undefined,
    });
  },

  refresh(baseUrl: string, refreshToken: string): Promise<AuthResponse> {
    return request<AuthResponse>(baseUrl, "/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  },

  logout(
    baseUrl: string,
    accessToken: string,
    refreshToken: string,
  ): Promise<void> {
    return request<void>(baseUrl, "/auth/logout", {
      method: "POST",
      body: JSON.stringify({ refresh_token: refreshToken }),
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  },

  me(baseUrl: string, accessToken: string): Promise<MeResponse> {
    return request<MeResponse>(baseUrl, "/auth/me", {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  },

  getPlan(baseUrl: string, accessToken: string): Promise<PlanResponse> {
    return request<PlanResponse>(baseUrl, "/api/plan", {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  },

  loginCaptchaStatus(
    baseUrl: string,
    email: string,
  ): Promise<LoginCaptchaStatusResponse> {
    return request<LoginCaptchaStatusResponse>(
      baseUrl,
      `/auth/login-captcha-status?email=${encodeURIComponent(email)}`,
      { method: "GET" },
    );
  },

  resendVerification(baseUrl: string, email: string, captchaToken?: string, lang?: string): Promise<void> {
    return request<void>(baseUrl, "/auth/resend-verification", {
      method: "POST",
      body: JSON.stringify({ email, captcha_token: captchaToken }),
      headers: lang ? { "Accept-Language": lang } : undefined,
    });
  },

  otpCaptchaStatus(baseUrl: string): Promise<LoginCaptchaStatusResponse> {
    return request<LoginCaptchaStatusResponse>(baseUrl, "/auth/otp-captcha-status", {
      method: "GET",
    });
  },

  registerCaptchaStatus(baseUrl: string): Promise<LoginCaptchaStatusResponse> {
    return request<LoginCaptchaStatusResponse>(baseUrl, "/auth/register-captcha-status", {
      method: "GET",
    });
  },

  verifyEmailOTP(baseUrl: string, email: string, code: string): Promise<void> {
    return request<void>(baseUrl, "/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ email, code }),
    });
  },

  forgotPassword(baseUrl: string, email: string, captchaToken?: string, lang?: string): Promise<void> {
    return request<void>(baseUrl, "/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email, captcha_token: captchaToken }),
      headers: lang ? { "Accept-Language": lang } : undefined,
    });
  },

  resetPassword(
    baseUrl: string,
    email: string,
    code: string,
    newPassword: string,
  ): Promise<void> {
    return request<void>(baseUrl, "/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ email, code, new_password: newPassword }),
    });
  },

  issueSSEToken(baseUrl: string, accessToken: string): Promise<{ token: string }> {
    return request<{ token: string }>(baseUrl, "/auth/sse-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  },

  syncPush(
    baseUrl: string,
    accessToken: string,
    payload: SyncPushPayload,
  ): Promise<SyncPushResponse> {
    return request<SyncPushResponse>(baseUrl, "/sync/push", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ ...payload, protocol_version: 2 }),
    });
  },

  syncPull(
    baseUrl: string,
    accessToken: string,
    afterSeq: number,
  ): Promise<SyncPullResponse> {
    return request<SyncPullResponseWire>(
      baseUrl,
      `/sync/pull?after_seq=${afterSeq}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    ).then(normalizeSyncPullResponse);
  },

  deleteAccount(
    baseUrl: string,
    accessToken: string,
    password: string,
  ): Promise<{ scheduled_at: number; executes_at: number }> {
    return request<{ scheduled_at: number; executes_at: number }>(
      baseUrl,
      "/auth/delete-account",
      {
        method: "POST",
        body: JSON.stringify({ password }),
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
  },
};

export interface SearchBookmark {
  id: string;
  title: string;
  url: string;
  description: string;
  collectionId: string;
  isArchived: boolean;
}

export interface SearchResponse {
  bookmarks: SearchBookmark[];
}

export async function searchBookmarks(
  serverUrl: string,
  accessToken: string,
  query: string,
): Promise<SearchResponse> {
  const res = await fetch(
    `${serverUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new ApiError(`search failed`, res.status);
  }
  return res.json() as Promise<SearchResponse>;
}

export function getPreferences(
  baseUrl: string,
  accessToken: string,
): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>(baseUrl, "/preferences", {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export function updatePreferences(
  baseUrl: string,
  accessToken: string,
  preferences: Record<string, unknown>,
): Promise<void> {
  return request<void>(baseUrl, "/preferences", {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(preferences),
  });
}
