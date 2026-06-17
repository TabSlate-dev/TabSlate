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
import { useTranslation } from "@/hooks/use-translation";

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
  const { t, language } = useTranslation();
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

  // Resend cooldown for the reset-password screen (seconds remaining)
  const [resetCooldown, setResetCooldown] = React.useState(0);

  React.useEffect(() => {
    if (resetCooldown <= 0) return;
    const id = setInterval(() => setResetCooldown((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(id);
  }, [resetCooldown]);

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
            <h1 className="text-2xl font-bold">{t("auth_forgotPassword")}</h1>
            <p className="text-sm text-balance text-muted-foreground">
              {t("auth_forgotPasswordDesc")}
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
                setResetCooldown(60);
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
                  setError(t("auth_somethingWentWrong"));
                }
              } finally {
                setLoading(false);
              }
            }}
          >
            <Field>
              <FieldLabel htmlFor="email">{t("auth_email")}</FieldLabel>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder={t("auth_emailPlaceholder")}
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
              {loading ? t("auth_sending") : t("auth_sendResetCode")}
            </Button>
          </form>

          <FieldDescription className="text-center">
            <button
              type="button"
              className="underline underline-offset-4 hover:text-primary"
              onClick={() => switchMode("login")}
            >
              {t("auth_backToLogin")}
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
            <h1 className="text-2xl font-bold">{t("auth_resetPassword")}</h1>
            <p className="text-sm text-balance text-muted-foreground">
              {t("auth_resetPasswordDesc1")} <strong>{pendingEmail}</strong> {t("auth_resetPasswordDesc2")}
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
                setError(err instanceof ApiError ? err.message : t("auth_somethingWentWrong"));
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
              <FieldLabel htmlFor="new_password">{t("auth_newPassword")}</FieldLabel>
              <Input
                id="new_password"
                name="new_password"
                type="password"
                placeholder={t("auth_passwordPlaceholder")}
                required
                minLength={10}
                autoComplete="new-password"
              />
              <FieldDescription>
                {t("auth_passwordRequirement")}
              </FieldDescription>
            </Field>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" disabled={loading || resetCode.length < 6}>
              {loading ? t("auth_resetting") : t("auth_resetPassword")}
            </Button>
          </form>

          <FieldDescription className="text-center text-sm">
            {t("auth_didntReceive")}{" "}
            <button
              type="button"
              disabled={resetCooldown > 0}
              className="underline underline-offset-4 hover:text-primary disabled:no-underline disabled:opacity-50 disabled:cursor-default"
              onClick={async () => {
                try {
                  await forgotPassword(pendingEmail);
                  setResetCooldown(60);
                } catch {
                  // best-effort
                }
              }}
            >
              {resetCooldown > 0 ? t("auth_resendIn", resetCooldown.toString()) : t("auth_resendCode")}
            </button>
          </FieldDescription>

          <FieldDescription className="text-center">
            <button
              type="button"
              className="underline underline-offset-4 hover:text-primary"
              onClick={() => switchMode("login")}
            >
              {t("auth_backToLogin")}
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
            {mode === "login" ? t("auth_loginTitle") : t("auth_registerTitle")}
          </h1>
          <p className="text-sm text-balance text-muted-foreground">
            {mode === "login" ? t("auth_loginDesc") : t("auth_registerDesc")}
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
                setError(t("auth_somethingWentWrong"));
              }
              resetCaptcha();
            } finally {
              setLoading(false);
            }
          }}
        >
          {mode === "register" && (
            <Field>
              <FieldLabel htmlFor="name">{t("auth_name")}</FieldLabel>
              <Input
                id="name"
                name="name"
                placeholder={t("auth_namePlaceholder")}
                required
                autoFocus={mode === "register"}
                autoComplete="name"
              />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="email">{t("auth_email")}</FieldLabel>
            <Input
              id="email"
              name="email"
              type="email"
              placeholder={t("auth_emailPlaceholder")}
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
            <FieldLabel htmlFor="password">{t("auth_password")}</FieldLabel>
            <Input
              id="password"
              name="password"
              type="password"
              placeholder={t("auth_passwordPlaceholder")}
              required
              minLength={10}
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
            />
            {mode === "register" && (
              <FieldDescription>
                {t("auth_passwordRequirement")}
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
              ? t("auth_pleaseWait")
              : mode === "login"
                ? t("auth_loginBtn")
                : t("auth_registerBtn")}
          </Button>

          {mode === "register" && (
            <p className="text-xs text-center text-muted-foreground leading-relaxed px-2">
              {t("auth_registerTermsDesc1")}
              <a
                href={`https://tabslate.com/${language === "zh_CN" ? "zh/" : ""}terms`}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4 hover:text-primary"
              >
                {t("auth_termsOfService")}
              </a>
              {t("auth_registerTermsDesc2")}
              <a
                href={`https://tabslate.com/${language === "zh_CN" ? "zh/" : ""}privacy-policy`}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4 hover:text-primary"
              >
                {t("auth_privacyPolicy")}
              </a>
              {t("auth_registerTermsDesc3")}
            </p>
          )}
        </form>

        <FieldDescription className="text-center">
          {mode === "login" ? (
            <>
              {t("auth_noAccount")}{" "}
              <button
                type="button"
                className="underline underline-offset-4 hover:text-primary"
                onClick={() => switchMode("register")}
              >
                {t("auth_signUp")}
              </button>
            </>
          ) : (
            <>
              {t("auth_hasAccount")}{" "}
              <button
                type="button"
                className="underline underline-offset-4 hover:text-primary"
                onClick={() => switchMode("login")}
              >
                {t("auth_loginBtn")}
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
              {t("auth_forgotPasswordLink")}
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
            {showAdvanced ? t("auth_hideAdvanced") : t("auth_advanced")}
          </button>
        </div>
        {showAdvanced && (
          <Field>
            <FieldLabel htmlFor="server-url">{t("auth_serverUrl")}</FieldLabel>
            <Input
              id="server-url"
              placeholder="https://api.tabslate.com"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
            />
            <FieldDescription>
              {t("auth_serverUrlDesc")}
            </FieldDescription>
          </Field>
        )}
      </FieldGroup>
    </div>
  );
}
