export type AuthSessionStatus =
  | "guest"
  | "unverified"
  | "offline"
  | "verified";

interface AuthSessionSnapshot {
  accessToken: string | null;
  refreshToken: string | null;
  isVerified: boolean | null;
}

interface GuestWorkspaceInitializationInput {
  sessionStatus: AuthSessionStatus;
  storesHydrated: boolean;
  workspaceCount: number;
}

export function resolveAuthSessionStatus({
  accessToken,
  refreshToken,
  isVerified,
}: AuthSessionSnapshot): AuthSessionStatus {
  if (!accessToken && !refreshToken) {
    return "guest";
  }
  if (isVerified !== true) {
    return "unverified";
  }
  if (!accessToken) {
    return "offline";
  }
  return "verified";
}

export function shouldInitializeGuestWorkspace({
  sessionStatus,
  storesHydrated,
  workspaceCount,
}: GuestWorkspaceInitializationInput): boolean {
  return storesHydrated && sessionStatus === "guest" && workspaceCount === 0;
}

export function canStartSync(
  status: AuthSessionStatus,
  serverUrl: string,
): boolean {
  return status === "verified" && serverUrl.length > 0;
}

export function shouldResetLocalData(
  previousStatus: AuthSessionStatus | null,
  currentStatus: AuthSessionStatus,
): boolean {
  return previousStatus !== null &&
    previousStatus !== "guest" &&
    currentStatus === "guest";
}

export type AuthEntryMode = "login" | "register";
export type AuthDialogView = "credentials" | "verify-email";

export function resolveAuthEntryModeAfterAccountSwitch(
  currentMode: AuthEntryMode,
): AuthEntryMode {
  if (currentMode === "register") {
    return "login";
  }
  return currentMode;
}

interface AuthDialogPresentationInput {
  requestedOpen: boolean;
  hasUser: boolean;
  isVerified: boolean;
}

interface AuthDialogPresentation {
  open: boolean;
  view: AuthDialogView;
  dismissible: boolean;
}

export function resolveAuthDialogPresentation({
  requestedOpen,
  hasUser,
  isVerified,
}: AuthDialogPresentationInput): AuthDialogPresentation {
  if (hasUser && !isVerified) {
    return {
      open: true,
      view: "verify-email",
      dismissible: false,
    };
  }
  if (hasUser && isVerified) {
    return {
      open: false,
      view: "credentials",
      dismissible: true,
    };
  }
  return {
    open: requestedOpen,
    view: "credentials",
    dismissible: true,
  };
}
