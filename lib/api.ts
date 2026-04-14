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

// ApiError carries the HTTP status code so callers can branch on 401, 409, etc.
export class ApiError extends Error {
  /** Whether the server is requesting a captcha (login failure threshold). */
  captchaRequired?: boolean;

  constructor(
    message: string,
    public readonly status: number,
    captchaRequired?: boolean,
  ) {
    super(message);
    this.name = "ApiError";
    this.captchaRequired = captchaRequired;
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
    try {
      const body = await res.json();
      if (typeof body?.error === "string") {
        message = body.error;
      }
      if (body?.captcha_required === true) {
        captchaRequired = true;
      }
    } catch {
      // ignore JSON parse failure — keep the generic message
    }
    throw new ApiError(message, res.status, captchaRequired);
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

  resendVerification(baseUrl: string, email: string): Promise<void> {
    return request<void>(baseUrl, "/auth/resend-verification", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  },
};
