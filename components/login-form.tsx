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
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";

type Mode =
  | "login"
  | "register"
  | "forgot-password" // email input to request reset code
  | "reset-password"; // OTP + new password input

/** Prosopo site key — leave empty to disable captcha in dev. */
const PROSOPO_SITE_KEY =
  (import.meta.env.VITE_PROSOPO_SITE_KEY as string | undefined) ?? "";

/** Captcha type for the site key — must match the Prosopo dashboard setting.
 *  Values: "frictionless" | "pow" | "image". Defaults to Prosopo's own default. */
const PROSOPO_CAPTCHA_TYPE =
  (import.meta.env.VITE_PROSOPO_CAPTCHA_TYPE as "frictionless" | "pow" | "image" | undefined) ?? undefined;

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const [mode, setMode] = React.useState<Mode>("login");
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [showAdvanced, setShowAdvanced] = React.useState(false);
  const [formKey, setFormKey] = React.useState(0);

  // Captcha state (login/register)
  const [captchaToken, setCaptchaToken] = React.useState<string>("");
  const [captchaKey, setCaptchaKey] = React.useState(0);
  const [loginCaptchaRequired, setLoginCaptchaRequired] = React.useState(false);
  const [registerCaptchaRequired, setRegisterCaptchaRequired] = React.useState(false);

  // Per-IP captcha state for forgot-password (OTP send)
  const [forgotCaptchaRequired, setForgotCaptchaRequired] = React.useState(false);
  const [forgotCaptchaToken, setForgotCaptchaToken] = React.useState("");
  const [forgotCaptchaKey, setForgotCaptchaKey] = React.useState(0);

  // Email carried across multi-step flows (verify-email, forgot/reset-password)
  const [pendingEmail, setPendingEmail] = React.useState("");

  // Controlled OTP value for the reset-password screen
  const [resetCode, setResetCode] = React.useState("");

  // Theme detection for captcha iframe
  const [theme, setTheme] = React.useState<"light" | "dark">(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );

  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) =>
      setTheme(e.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  /** Reset the captcha iframe so the user gets a fresh token on retry. */
  function resetCaptcha() {
    setCaptchaToken("");
    setCaptchaKey((k) => k + 1);
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
    resetCaptcha();
    setLoginCaptchaRequired(false);
    if (next === "login" || next === "register") {
      setFormKey((k) => k + 1);
    }
  }

  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const forgotPassword = useAuthStore((s) => s.forgotPassword);
  const resetPassword = useAuthStore((s) => s.resetPassword);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const setServerUrl = useAuthStore((s) => s.setServerUrl);

  // Check per-IP captcha requirement whenever entering register or forgot-password mode
  React.useEffect(() => {
    if (!PROSOPO_SITE_KEY) return;
    if (mode === "register") {
      api.registerCaptchaStatus(serverUrl).then((r) => {
        setRegisterCaptchaRequired(r.captcha_required);
      }).catch(() => {});
    } else if (mode === "forgot-password") {
      api.otpCaptchaStatus(serverUrl).then((r) => {
        setForgotCaptchaRequired(r.captcha_required);
      }).catch(() => {});
    }
  }, [mode, serverUrl]);

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

  // Show captcha on register when threshold reached, on login after repeated failures.
  const showCaptcha =
    PROSOPO_SITE_KEY &&
    ((mode === "register" && registerCaptchaRequired) || (mode === "login" && loginCaptchaRequired));

  // ── Forgot password — email input ──────────────────────────────────────────
  if (mode === "forgot-password") {
    return (
      <div className={cn("flex flex-col gap-6", className)} {...props}>
        <FieldGroup>
          <div className="flex flex-col items-center gap-2 text-center">
            <h1 className="text-2xl font-bold">Forgot password</h1>
            <p className="text-sm text-balance text-muted-foreground">
              Enter your email and we&apos;ll send a 6-digit reset code.
            </p>
          </div>

          <form
            className="flex flex-col gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              const email = (new FormData(e.currentTarget).get("email") as string).trim();
              setError("");
              setLoading(true);
              try {
                await forgotPassword(email, forgotCaptchaToken || undefined);
                setPendingEmail(email);
                switchMode("reset-password");
              } catch (err) {
                if (err instanceof ApiError) {
                  setError(err.message);
                  if (err.captchaRequired) {
                    setForgotCaptchaRequired(true);
                    setForgotCaptchaToken("");
                    setForgotCaptchaKey((k) => k + 1);
                  }
                } else {
                  setError("Something went wrong");
                }
              } finally {
                setLoading(false);
              }
            }}
          >
            <Field>
              <FieldLabel htmlFor="email">Email</FieldLabel>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="you@example.com"
                required
                autoFocus
                autoComplete="email"
              />
            </Field>

            {PROSOPO_SITE_KEY && forgotCaptchaRequired && (
              <Procaptcha
                key={forgotCaptchaKey}
                siteKey={PROSOPO_SITE_KEY}
                serverUrl={serverUrl}
                onToken={setForgotCaptchaToken}
                captchaType={PROSOPO_CAPTCHA_TYPE}
                theme={theme}
              />
            )}

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <Button
              type="submit"
              disabled={loading || !!(PROSOPO_SITE_KEY && forgotCaptchaRequired && !forgotCaptchaToken)}
            >
              {loading ? "Sending…" : "Send reset code"}
            </Button>
          </form>

          <FieldDescription className="text-center">
            <button
              type="button"
              className="underline underline-offset-4 hover:text-primary"
              onClick={() => switchMode("login")}
            >
              Back to login
            </button>
          </FieldDescription>
        </FieldGroup>
      </div>
    );
  }

  // ── Reset password — OTP + new password ────────────────────────────────────
  if (mode === "reset-password") {
    return (
      <div className={cn("flex flex-col gap-6", className)} {...props}>
        <FieldGroup>
          <div className="flex flex-col items-center gap-2 text-center">
            <h1 className="text-2xl font-bold">Reset password</h1>
            <p className="text-sm text-balance text-muted-foreground">
              Enter the 6-digit code sent to <strong>{pendingEmail}</strong> and
              choose a new password.
            </p>
          </div>

          <form
            className="flex flex-col gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              const newPassword = (new FormData(e.currentTarget).get("new_password")) as string;
              setError("");
              setLoading(true);
              try {
                await resetPassword(pendingEmail, resetCode, newPassword);
                switchMode("login");
              } catch (err) {
                setError(err instanceof ApiError ? err.message : "Something went wrong");
                setResetCode("");
              } finally {
                setLoading(false);
              }
            }}
          >
            {/* Hidden email field — tells the browser password manager which
                account this new password belongs to, preventing it from
                filling the new password into the login form's email field. */}
            <input type="hidden" autoComplete="username" value={pendingEmail} readOnly />

            <div className="flex justify-center">
              <InputOTP
                maxLength={6}
                value={resetCode}
                onChange={setResetCode}
                autoFocus
              >
                <InputOTPGroup className="gap-2 *:data-[slot=input-otp-slot]:rounded-md *:data-[slot=input-otp-slot]:border">
                  <InputOTPSlot index={0} />
                  <InputOTPSlot index={1} />
                  <InputOTPSlot index={2} />
                </InputOTPGroup>
                <InputOTPSeparator />
                <InputOTPGroup className="gap-2 *:data-[slot=input-otp-slot]:rounded-md *:data-[slot=input-otp-slot]:border">
                  <InputOTPSlot index={3} />
                  <InputOTPSlot index={4} />
                  <InputOTPSlot index={5} />
                </InputOTPGroup>
              </InputOTP>
            </div>

            <Field>
              <FieldLabel htmlFor="new_password">New password</FieldLabel>
              <Input
                id="new_password"
                name="new_password"
                type="password"
                placeholder="••••••••••"
                required
                minLength={10}
                autoComplete="new-password"
              />
              <FieldDescription>
                At least 10 characters, including a letter and a number.
              </FieldDescription>
            </Field>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" disabled={loading || resetCode.length < 6}>
              {loading ? "Resetting…" : "Reset password"}
            </Button>
          </form>

          <FieldDescription className="text-center text-sm">
            Didn&apos;t receive it?{" "}
            <button
              type="button"
              className="underline underline-offset-4 hover:text-primary"
              onClick={async () => {
                try {
                  await forgotPassword(pendingEmail);
                } catch {
                  // best-effort
                }
              }}
            >
              Resend code
            </button>
          </FieldDescription>

          <FieldDescription className="text-center">
            <button
              type="button"
              className="underline underline-offset-4 hover:text-primary"
              onClick={() => switchMode("login")}
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
          key={formKey}
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const formData = new FormData(e.currentTarget);
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
                // AuthGate detects user.is_verified === false and shows
                // VerifyEmailScreen automatically — no switchMode needed.
              }
            } catch (err) {
              if (err instanceof ApiError) {
                setError(err.message);
                if (mode === "login" && err.captchaRequired) {
                  setLoginCaptchaRequired(true);
                } else if (mode === "register" && PROSOPO_SITE_KEY) {
                  // Re-check in case the threshold was crossed during this attempt.
                  api.registerCaptchaStatus(serverUrl).then((r) => {
                    setRegisterCaptchaRequired(r.captcha_required);
                  }).catch(() => {});
                }
              } else {
                setError("Something went wrong");
              }
              resetCaptcha();
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
            <Procaptcha
              key={captchaKey}
              siteKey={PROSOPO_SITE_KEY}
              serverUrl={serverUrl}
              onToken={setCaptchaToken}
              captchaType={PROSOPO_CAPTCHA_TYPE}
              theme={theme}
            />
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

        {mode === "login" && (
          <FieldDescription className="text-center">
            <button
              type="button"
              className="underline underline-offset-4 hover:text-primary"
              onClick={() => switchMode("forgot-password")}
            >
              Forgot password?
            </button>
          </FieldDescription>
        )}

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
