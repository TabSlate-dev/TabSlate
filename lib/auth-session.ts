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
