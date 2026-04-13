// API types — mirror server internal/model/model.go

export interface ApiUser {
  id: string;
  name: string;
  email: string;
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

// ApiError carries the HTTP status code so callers can branch on 401, 409, etc.
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
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
    try {
      const body = await res.json();
      if (typeof body?.error === "string") {
        message = body.error;
      }
    } catch {
      // ignore JSON parse failure — keep the generic message
    }
    throw new ApiError(message, res.status);
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
  ): Promise<AuthResponse> {
    return request<AuthResponse>(baseUrl, "/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password }),
    });
  },

  login(
    baseUrl: string,
    email: string,
    password: string,
  ): Promise<AuthResponse> {
    return request<AuthResponse>(baseUrl, "/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
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
};
