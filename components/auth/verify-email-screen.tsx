/**
 * Full-screen email verification gate shown by AuthGate when the user has a
 * valid access token but has not yet verified their email address.
 *
 * After successful verification the store's user.is_verified flips to true,
 * AuthGate re-renders and the dashboard is shown automatically.
 */
import * as React from "react";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldDescription, FieldGroup } from "@/components/ui/field";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { Procaptcha } from "@/components/procaptcha";
import { useAuthStore } from "@/store/auth-store";
import { api, ApiError } from "@/lib/api";

interface VerifyEmailScreenProps {
  email: string;
}

const PROSOPO_SITE_KEY =
  (import.meta.env.VITE_PROSOPO_SITE_KEY as string | undefined) ?? "";
const PROSOPO_CAPTCHA_TYPE =
  (import.meta.env.VITE_PROSOPO_CAPTCHA_TYPE as
    | "frictionless"
    | "pow"
    | "image"
    | undefined) ?? undefined;

export function VerifyEmailScreen({ email }: VerifyEmailScreenProps) {
  const [code, setCode] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [resent, setResent] = React.useState(false);
  const [retryAfter, setRetryAfter] = React.useState(0);

  // Per-IP captcha state for resend
  const [captchaRequired, setCaptchaRequired] = React.useState(false);
  const [captchaToken, setCaptchaToken] = React.useState("");
  const [captchaKey, setCaptchaKey] = React.useState(0);

  const verifyEmailOTP = useAuthStore((s) => s.verifyEmailOTP);
  const resendVerification = useAuthStore((s) => s.resendVerification);
  const logout = useAuthStore((s) => s.logout);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const otpSentAt = useAuthStore((s) => s.otpSentAt);

  // Compute remaining cooldown from the timestamp recorded when the OTP was
  // last sent (set by register or resendVerification in the store). This avoids
  // an extra API call on mount and the resulting 429 noise in backend logs.
  React.useEffect(() => {
    if (!otpSentAt) return;
    const elapsed = (Date.now() - otpSentAt) / 1000;
    const remaining = Math.max(0, 60 - elapsed);
    if (remaining > 0) {
      setRetryAfter(Math.round(remaining));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check per-IP captcha requirement on mount
  React.useEffect(() => {
    if (!PROSOPO_SITE_KEY) return;
    api.otpCaptchaStatus(serverUrl).then((r) => {
      setCaptchaRequired(r.captcha_required);
    }).catch(() => {});
  }, [serverUrl]);

  // Countdown timer for retry_after
  React.useEffect(() => {
    if (retryAfter <= 0) return;
    const id = setInterval(() => setRetryAfter((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(id);
  }, [retryAfter]);

  // Theme for captcha iframe
  const [theme, setTheme] = React.useState<"light" | "dark">(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = (e: MediaQueryListEvent) => setTheme(e.matches ? "dark" : "light");
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);

  async function submitCode(value: string) {
    if (value.length < 6 || loading) return;
    setError("");
    setLoading(true);
    try {
      await verifyEmailOTP(email, value);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
      setCode("");
    } finally {
      setLoading(false);
    }
  }

  function handleChange(value: string) {
    setCode(value);
    if (value.length === 6) { submitCode(value); }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    submitCode(code);
  }

  async function handleResend() {
    if (retryAfter > 0) return;
    setResent(false);
    setError("");
    try {
      await resendVerification(email, captchaToken || undefined);
      setResent(true);
      setRetryAfter(60);
      setCaptchaToken("");
      setCaptchaKey((k) => k + 1);
      // Re-check captcha status after resend
      if (PROSOPO_SITE_KEY) {
        const r = await api.otpCaptchaStatus(serverUrl);
        setCaptchaRequired(r.captcha_required);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.captchaRequired) {
          setCaptchaRequired(true);
          setCaptchaToken("");
          setCaptchaKey((k) => k + 1);
        } else if (err.status === 429) {
          setError(err.message);
          setRetryAfter(err.retryAfter ?? 60);
        } else {
          setError(err.message);
        }
      }
    }
  }

  const showCaptcha = PROSOPO_SITE_KEY && captchaRequired;

  return (
    <div className="flex items-center justify-center h-svh bg-background">
      <div className="w-full max-w-sm px-4">
        <FieldGroup>
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Mail className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-2xl font-bold">Check your email</h1>
            <p className="text-sm text-balance text-muted-foreground">
              We sent a 6-digit code to <strong>{email}</strong>.
              Enter it below to verify your account.
            </p>
          </div>

          <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
            <div className="flex justify-center">
              <InputOTP maxLength={6} value={code} onChange={handleChange} autoFocus>
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

            {error && (
              <p role="alert" className="text-sm text-center text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" disabled={loading || code.length < 6}>
              {loading ? "Verifying…" : "Verify email"}
            </Button>
          </form>

          {/* Resend section — shows captcha when IP threshold is reached */}
          <div className="flex flex-col gap-3">
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

            <FieldDescription className="text-center text-sm">
              Didn&apos;t receive it?{" "}
              <button
                type="button"
                disabled={retryAfter > 0 || (!!showCaptcha && !captchaToken)}
                className="underline underline-offset-4 hover:text-primary disabled:opacity-50 disabled:no-underline"
                onClick={handleResend}
              >
                {retryAfter > 0 ? `Resend in ${retryAfter}s` : "Resend code"}
              </button>
              {resent && (
                <span className="ml-1 text-muted-foreground">— sent!</span>
              )}
            </FieldDescription>
          </div>

          <FieldDescription className="text-center">
            <button
              type="button"
              className="underline underline-offset-4 hover:text-primary"
              onClick={() => logout()}
            >
              Use a different account
            </button>
          </FieldDescription>
        </FieldGroup>
      </div>
    </div>
  );
}
