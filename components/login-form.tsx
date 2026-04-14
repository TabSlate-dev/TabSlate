import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useAuthStore } from "@/store/auth-store";
import { api, ApiError } from "@/lib/api";
import { Procaptcha } from "@/components/procaptcha";

type Mode = "login" | "register";

/** Prosopo site key — leave empty to disable captcha in dev. */
const PROSOPO_SITE_KEY =
  (import.meta.env.VITE_PROSOPO_SITE_KEY as string | undefined) ?? "";

/**
 * Self-hosted Prosopo server URL.
 * When set, the captcha JS bundle is loaded from this server instead of the
 * official Prosopo CDN. Leave empty to use the default (https://js.prosopo.io).
 */
const PROSOPO_SERVER_URL =
  (import.meta.env.VITE_PROSOPO_SERVER_URL as string | undefined) ?? "";

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const [mode, setMode] = React.useState<Mode>("login");
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  // Captcha state
  const [captchaToken, setCaptchaToken] = React.useState<string>("");
  const [loginCaptchaRequired, setLoginCaptchaRequired] = React.useState(false);

  // Email verification state
  const [pendingVerification, setPendingVerification] = React.useState(false);
  const [verificationEmail, setVerificationEmail] = React.useState("");
  const [resendLoading, setResendLoading] = React.useState(false);
  const [resendMessage, setResendMessage] = React.useState("");

  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const resendVerification = useAuthStore((s) => s.resendVerification);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const setServerUrl = useAuthStore((s) => s.setServerUrl);

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
    setCaptchaToken("");
    setLoginCaptchaRequired(false);
    setPendingVerification(false);
    setResendMessage("");
  }

  /** Check whether the login endpoint requires captcha for this email. */
  async function checkLoginCaptcha(email: string) {
    if (!PROSOPO_SITE_KEY || !email) return;
    try {
      const resp = await api.loginCaptchaStatus(serverUrl, email);
      setLoginCaptchaRequired(resp.captcha_required);
    } catch {
      // Non-critical — proceed without captcha.
    }
  }

  // Show captcha on register always (if sitekey configured), on login only when required.
  const showCaptcha =
    PROSOPO_SITE_KEY &&
    (mode === "register" || (mode === "login" && loginCaptchaRequired));

  // ── Pending email verification screen ──────────────────────────────────────
  if (pendingVerification) {
    return (
      <div className={cn("flex flex-col gap-6", className)} {...props}>
        <FieldGroup>
          <div className="flex flex-col items-center gap-2 text-center">
            <h1 className="text-2xl font-bold">Check your email</h1>
            <p className="text-sm text-balance text-muted-foreground">
              We sent a verification link to{" "}
              <strong>{verificationEmail}</strong>. Please check your inbox and
              click the link to verify your account.
            </p>
          </div>

          {resendMessage && (
            <p className="text-sm text-center text-muted-foreground">
              {resendMessage}
            </p>
          )}

          <Button
            variant="outline"
            disabled={resendLoading}
            onClick={async () => {
              setResendLoading(true);
              setResendMessage("");
              try {
                await resendVerification(verificationEmail);
                setResendMessage("Verification email sent. Please check your inbox.");
              } catch {
                setResendMessage("Failed to resend. Please try again.");
              } finally {
                setResendLoading(false);
              }
            }}
          >
            {resendLoading ? "Sending…" : "Resend verification email"}
          </Button>

          <FieldDescription className="text-center">
            <button
              type="button"
              className="underline underline-offset-4 hover:text-primary"
              onClick={() => {
                setPendingVerification(false);
                switchMode("login");
              }}
            >
              Back to login
            </button>
          </FieldDescription>
        </FieldGroup>
      </div>
    );
  }

  // ── Login / Register form ──────────────────────────────────────────────────
  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <FieldGroup>
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-2xl font-bold">
            {mode === "login" ? "Login to your account" : "Create an account"}
          </h1>
          <p className="text-sm text-balance text-muted-foreground">
            {mode === "login"
              ? "Enter your email below to login to your account"
              : "Enter your details below to create your account"}
          </p>
        </div>

        <form
          className="flex flex-col gap-4"
          action={async (formData) => {
            setError("");
            setLoading(true);
            try {
              if (mode === "login") {
                await login(
                  formData.get("email") as string,
                  formData.get("password") as string,
                  captchaToken || undefined,
                );
              } else {
                await register(
                  formData.get("name") as string,
                  formData.get("email") as string,
                  formData.get("password") as string,
                  captchaToken || undefined,
                );

                // If the user was created but not yet verified, show verification UI.
                const user = useAuthStore.getState().user;
                if (user && !user.is_verified) {
                  setVerificationEmail(user.email);
                  setPendingVerification(true);
                }
              }
            } catch (e) {
              if (e instanceof ApiError) {
                setError(e.message);
                // Server signals captcha is now required for this login.
                if (e.captchaRequired) {
                  setLoginCaptchaRequired(true);
                }
              } else {
                setError("Something went wrong");
              }
              // Reset captcha token so user must re-verify.
              setCaptchaToken("");
            } finally {
              setLoading(false);
            }
          }}
        >
          {mode === "register" && (
            <Field>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input
                id="name"
                name="name"
                placeholder="Your name"
                required
                autoFocus={mode === "register"}
                autoComplete="name"
              />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="you@example.com"
              required
              autoFocus={mode === "login"}
              autoComplete="email"
              onBlur={(e) => {
                if (mode === "login") {
                  checkLoginCaptcha(e.target.value);
                }
              }}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              name="password"
              type="password"
              placeholder="••••••••••"
              required
              minLength={10}
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
            />
            {mode === "register" && (
              <FieldDescription>
                At least 10 characters, including a letter and a number.
              </FieldDescription>
            )}
          </Field>

          {/* Prosopo Captcha */}
          {showCaptcha && (
            <div className="flex justify-center">
              <Procaptcha
                siteKey={PROSOPO_SITE_KEY}
                callback={(token: string) => setCaptchaToken(token)}
                serverUrl={PROSOPO_SERVER_URL || undefined}
              />
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" disabled={loading}>
            {loading
              ? "Please wait…"
              : mode === "login"
                ? "Login"
                : "Create account"}
          </Button>
        </form>

        <FieldDescription className="text-center">
          {mode === "login" ? (
            <>
              Don&apos;t have an account?{" "}
              <button
                type="button"
                className="underline underline-offset-4 hover:text-primary"
                onClick={() => switchMode("register")}
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button
                type="button"
                className="underline underline-offset-4 hover:text-primary"
                onClick={() => switchMode("login")}
              >
                Login
              </button>
            </>
          )}
        </FieldDescription>

        {/* Advanced: server URL for self-hosted instances */}
        <div className="text-center">
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-primary underline-offset-4 hover:underline"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? "Hide advanced" : "Advanced"}
          </button>
        </div>
        {showAdvanced && (
          <Field>
            <FieldLabel htmlFor="server-url">Server URL</FieldLabel>
            <Input
              id="server-url"
              placeholder="https://api.tabslate.app"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
            />
            <FieldDescription>
              For self-hosted TabSlate-server instances.
            </FieldDescription>
          </Field>
        )}
      </FieldGroup>
    </div>
  );
}
