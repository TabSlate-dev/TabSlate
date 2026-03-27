import type { StateStorage } from "zustand/middleware";

export const chromeStorageAdapter: StateStorage = {
  getItem: (name): Promise<string | null> =>
    new Promise((resolve) =>
      chrome.storage.local.get(name, (result) => {
        const value = result[name];
        resolve(typeof value === "string" ? value : null);
      })
    ),
  setItem: (name, value): Promise<void> =>
    new Promise((resolve) =>
      chrome.storage.local.set({ [name]: value }, () => resolve())
    ),
  removeItem: (name): Promise<void> =>
    new Promise((resolve) =>
      chrome.storage.local.remove(name, () => resolve())
    ),
};
