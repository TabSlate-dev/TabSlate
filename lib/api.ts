// API types — mirror server internal/model/model.go

export interface ApiUser {
  id: string;
  name: string;
  email: string;
  is_verified: boolean;
  created_at: number;
  updated_at: number;
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

export interface LoginCaptchaStatusResponse {
  captcha_required: boolean;
}

export interface ServerWorkspace {
  id: string;
  user_id: string;
  name: string;
  icon?: string;
  color?: string;
  position: number;
  seq: number;
  deleted_at?: number;
  created_at: number;
  updated_at: number;
}

export interface ServerCollection {
  id: string;
  user_id: string;
  workspace_id?: string;
  name: string;
  icon?: string;
  position: number;
  seq: number;
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
  is_trashed: boolean;
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

export interface SyncRejected {
  id: string;
  reason: "stale" | "quota_exceeded";
}

export interface SyncPushResponse {
  server_seq: number;
  rejected: SyncRejected[];
}

export interface SyncPullResponse {
  entities: SyncEntities;
  server_seq: number;
}

export interface SyncPushPayload {
  entities: {
    workspaces: object[];
    collections: object[];
    bookmarks: object[];
    tags: object[];
    groups: object[];
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
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string>),
    },
  });

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
  ): Promise<AuthResponse> {
    return request<AuthResponse>(baseUrl, "/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password, captcha_token: captchaToken }),
    });
  },

  login(
    baseUrl: string,
    email: string,
    password: string,
    captchaToken?: string,
  ): Promise<AuthResponse> {
    return request<AuthResponse>(baseUrl, "/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, captcha_token: captchaToken }),
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

  resendVerification(baseUrl: string, email: string, captchaToken?: string): Promise<void> {
    return request<void>(baseUrl, "/auth/resend-verification", {
      method: "POST",
      body: JSON.stringify({ email, captcha_token: captchaToken }),
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

  forgotPassword(baseUrl: string, email: string, captchaToken?: string): Promise<void> {
    return request<void>(baseUrl, "/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email, captcha_token: captchaToken }),
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
      body: JSON.stringify(payload),
    });
  },

  syncPull(
    baseUrl: string,
    accessToken: string,
    afterSeq: number,
  ): Promise<SyncPullResponse> {
    return request<SyncPullResponse>(
      baseUrl,
      `/sync/pull?after_seq=${afterSeq}`,
      {
        method: "GET",
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

