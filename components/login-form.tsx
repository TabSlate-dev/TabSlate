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
import { ApiError } from "@/lib/api";

type Mode = "login" | "register";

export function LoginForm({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const [mode, setMode] = React.useState<Mode>("login");
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const setServerUrl = useAuthStore((s) => s.setServerUrl);

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
  }

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
                );
              } else {
                await register(
                  formData.get("name") as string,
                  formData.get("email") as string,
                  formData.get("password") as string,
                );
              }
            } catch (e) {
              setError(
                e instanceof ApiError ? e.message : "Something went wrong",
              );
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
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Input
              id="password"
              name="password"
              type="password"
              placeholder="••••••••"
              required
              minLength={8}
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
            />
          </Field>

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
