import { useCallback, useEffect, useState } from "react";
import { isFirefoxBuild } from "@/lib/browser/env";
import {
  hasSettingsSyncConsent,
  removeSettingsSyncConsent,
  requestSettingsSyncConsent,
  subscribeToPermissionChanges,
} from "@/lib/browser/data-collection";
import { useSettingsStore } from "@/store/settings-store";

/**
 * Firefox-only switch for syncing view preferences, kept current when the
 * permission changes in about:addons. `granted` stays null outside Firefox.
 */
export function usePreferenceSyncConsent(): { granted: boolean | null; setGranted: (enabled: boolean) => void } {
  const [granted, setGrantedState] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isFirefoxBuild()) {
      return;
    }
    let active = true;
    const refresh = () => {
      void hasSettingsSyncConsent().then((value) => {
        if (active) {
          setGrantedState(value);
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

  const setGranted = useCallback((enabled: boolean) => {
    if (enabled) {
      // Firefox only accepts the request while handling the click, before any await.
      void requestSettingsSyncConsent()
        .then((value) => {
          setGrantedState(value);
          if (value) {
            void useSettingsStore.getState().resyncPreferences();
          }
        })
        .catch(() => {
          // The prompt can fail, e.g. when Firefox no longer sees the user gesture; show the permission it holds.
          void hasSettingsSyncConsent().then(setGrantedState);
        });
      return;
    }
    void removeSettingsSyncConsent().then((removed) => {
      if (removed) {
        setGrantedState(false);
      }
    });
  }, []);

  return { granted, setGranted };
}
