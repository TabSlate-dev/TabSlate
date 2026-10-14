import { useEffect, useState } from "react";
import { isFirefoxBuild } from "@/lib/browser/env";
import {
  hasAccountDataConsent,
  subscribeToPermissionChanges,
} from "@/lib/browser/data-collection";

/**
 * Whether the user allows the account data collection that sign-in and sync
 * need, kept current when it is granted or revoked (e.g. in about:addons).
 * Always true outside Firefox; `null` until Firefox has answered.
 */
export function useAccountDataConsent(): boolean | null {
  const [granted, setGranted] = useState<boolean | null>(() => (isFirefoxBuild() ? null : true));

  useEffect(() => {
    if (!isFirefoxBuild()) {
      return;
    }

    let active = true;
    const refresh = () => {
      void hasAccountDataConsent().then((value) => {
        if (active) {
          setGranted(value);
        }
      });
    };

    refresh();
    const unsubscribe = subscribeToPermissionChanges(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return granted;
}
