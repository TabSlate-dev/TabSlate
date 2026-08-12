import * as React from "react";
import { LoginForm } from "@/components/login-form";
import { VerifyEmailScreen } from "@/components/auth/verify-email-screen";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  resolveAuthDialogPresentation,
  resolveAuthEntryModeAfterAccountSwitch,
  type AuthEntryMode,
} from "@/lib/auth-session";
import { useAuthStore } from "@/store/auth-store";
import { useTranslation } from "@/hooks/use-translation";

interface AuthDialogProps {
  open: boolean;
  initialMode: AuthEntryMode;
  onOpenChange: (open: boolean) => void;
}

export function AuthDialog({
  open,
  initialMode,
  onOpenChange,
}: AuthDialogProps) {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [credentialModeOverride, setCredentialModeOverride] =
    React.useState<AuthEntryMode | null>(null);
  const credentialMode = credentialModeOverride ?? initialMode;
  const presentation = resolveAuthDialogPresentation({
    requestedOpen: open,
    hasUser: user !== null,
    isVerified: user?.is_verified ?? false,
  });

  React.useEffect(() => {
    if (!open) {
      setCredentialModeOverride(null);
    }
  }, [open]);

  React.useEffect(() => {
    if (open && user?.is_verified) {
      onOpenChange(false);
    }
  }, [onOpenChange, open, user?.is_verified]);

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    if (!nextOpen && !presentation.dismissible) {
      return;
    }
    onOpenChange(nextOpen);
  }, [onOpenChange, presentation.dismissible]);

  const handleUseDifferentAccount = React.useCallback(async () => {
    setCredentialModeOverride(
      resolveAuthEntryModeAfterAccountSwitch(credentialMode),
    );
    await logout();
    onOpenChange(true);
  }, [credentialMode, logout, onOpenChange]);

  const handleBlockedDismiss = React.useCallback((event: Event) => {
    if (!presentation.dismissible) {
      event.preventDefault();
    }
  }, [presentation.dismissible]);

  return (
    <Dialog open={presentation.open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-md max-h-[90svh] overflow-y-auto"
        aria-describedby={undefined}
        showCloseButton={presentation.dismissible}
        onEscapeKeyDown={handleBlockedDismiss}
        onPointerDownOutside={handleBlockedDismiss}
      >
        <DialogTitle className="sr-only">
          {presentation.view === "verify-email"
            ? t("auth_checkEmail")
            : credentialMode === "register"
              ? t("auth_registerTitle")
              : t("auth_loginTitle")}
        </DialogTitle>
        {presentation.view === "verify-email" && user ? (
          <VerifyEmailScreen
            email={user.email}
            onUseDifferentAccount={handleUseDifferentAccount}
          />
        ) : (
          <LoginForm key={credentialMode} initialMode={credentialMode} />
        )}
      </DialogContent>
    </Dialog>
  );
}
