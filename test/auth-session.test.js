import { describe, expect, test } from "bun:test";
import {
  canStartSync,
  resolveAuthDialogPresentation,
  resolveAuthSessionStatus,
  shouldInitializeGuestWorkspace,
  shouldResetLocalData,
} from "../lib/auth-session";

describe("authentication session policy", () => {
  test("classifies guest, unverified, offline, and verified sessions", () => {
    expect(resolveAuthSessionStatus({
      accessToken: null,
      refreshToken: null,
      isVerified: null,
    })).toBe("guest");

    expect(resolveAuthSessionStatus({
      accessToken: "access",
      refreshToken: "refresh",
      isVerified: false,
    })).toBe("unverified");

    expect(resolveAuthSessionStatus({
      accessToken: null,
      refreshToken: "refresh",
      isVerified: true,
    })).toBe("offline");

    expect(resolveAuthSessionStatus({
      accessToken: "access",
      refreshToken: "refresh",
      isVerified: true,
    })).toBe("verified");
  });

  test("initializes a workspace only for a hydrated empty guest", () => {
    expect(shouldInitializeGuestWorkspace({
      sessionStatus: "guest",
      storesHydrated: true,
      workspaceCount: 0,
    })).toBe(true);

    expect(shouldInitializeGuestWorkspace({
      sessionStatus: "guest",
      storesHydrated: false,
      workspaceCount: 0,
    })).toBe(false);

    expect(shouldInitializeGuestWorkspace({
      sessionStatus: "guest",
      storesHydrated: true,
      workspaceCount: 1,
    })).toBe(false);

    expect(shouldInitializeGuestWorkspace({
      sessionStatus: "offline",
      storesHydrated: true,
      workspaceCount: 0,
    })).toBe(false);
  });

  test("starts synchronization only for a verified session with a server URL", () => {
    expect(canStartSync("verified", "https://api.tabslate.com")).toBe(true);
    expect(canStartSync("verified", "")).toBe(false);
    expect(canStartSync("guest", "https://api.tabslate.com")).toBe(false);
    expect(canStartSync("unverified", "https://api.tabslate.com")).toBe(false);
    expect(canStartSync("offline", "https://api.tabslate.com")).toBe(false);
  });

  test("resets local account data only when a session becomes guest", () => {
    expect(shouldResetLocalData(null, "guest")).toBe(false);
    expect(shouldResetLocalData("guest", "verified")).toBe(false);
    expect(shouldResetLocalData("offline", "verified")).toBe(false);
    expect(shouldResetLocalData("verified", "guest")).toBe(true);
    expect(shouldResetLocalData("unverified", "guest")).toBe(true);
  });
});

describe("authentication dialog presentation", () => {
  test("uses a dismissible credentials view for a guest request", () => {
    expect(resolveAuthDialogPresentation({
      requestedOpen: true,
      hasUser: false,
      isVerified: false,
    })).toEqual({
      open: true,
      view: "credentials",
      dismissible: true,
    });
  });

  test("forces a non-dismissible OTP view for an unverified user", () => {
    expect(resolveAuthDialogPresentation({
      requestedOpen: false,
      hasUser: true,
      isVerified: false,
    })).toEqual({
      open: true,
      view: "verify-email",
      dismissible: false,
    });
  });

  test("closes after the user becomes verified", () => {
    expect(resolveAuthDialogPresentation({
      requestedOpen: true,
      hasUser: true,
      isVerified: true,
    })).toEqual({
      open: false,
      view: "credentials",
      dismissible: true,
    });
  });
});
