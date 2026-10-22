import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useLayoutEffect, type ReactNode } from "react";
import type { StateStorage } from "zustand/middleware";
import { importFresh, type ModuleReplacer } from "./module-replacer";

/** Registers happy-dom for a component test file. teardownDom is safe after a partial setup. */
export function setupDom(): void {
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register();
  }
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  // Store modules open IndexedDB while loading. A request that never settles keeps persistence inert.
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    writable: true,
    value: { open: () => ({}) },
  });
}

export async function teardownDom(): Promise<void> {
  Reflect.deleteProperty(globalThis, "indexedDB");
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister();
  }
}

/** Test translation: the key, followed by its substitutions in brackets, e.g. "tagDeleteDialog_desc_other[3]". */
export function translateKey(key: string, substitutions?: string | string[]): string {
  if (substitutions === undefined) {
    return key;
  }
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  return `${key}[${values.join(",")}]`;
}

export interface AppModules {
  createRoot: typeof import("react-dom/client").createRoot;
  useBookmarksStore: typeof import("@/store/bookmarks-store").useBookmarksStore;
  useWorkspaceStore: typeof import("@/store/workspace-store").useWorkspaceStore;
}

function createMemoryStorage(): StateStorage {
  const items = new Map<string, string>();
  return {
    getItem: async (name) => items.get(name) ?? null,
    setItem: async (name, value) => {
      items.set(name, value);
    },
    removeItem: async (name) => {
      items.delete(name);
    },
  };
}

/**
 * Points the modules most component tests render through at fresh real copies
 * (other test files leave partial fakes registered) and stubs translations.
 * Each store is registered before the next one loads, so every copy links
 * against complete modules. The plan store persists through chrome.storage,
 * which tests don't have, so it gets an in-memory adapter.
 */
export async function installAppModules(replacer: ModuleReplacer): Promise<AppModules> {
  // Store initialization must never cache the inert DOM request in the shared IDB module.
  await replacer.replace(
    "@/lib/idb",
    await importFresh<typeof import("@/lib/idb")>("lib/idb.ts"),
  );
  const reactDomClient = await importFresh<typeof import("react-dom/client")>("node_modules/react-dom/client.js");
  await replacer.replace("react-dom/client", reactDomClient);
  // Radix picks its layout-effect hook once, when it first loads. A test file that renders to a string
  // loads Radix without a DOM and leaves the hook a no-op for the rest of the run, so portals never mount.
  await replacer.replace("@radix-ui/react-use-layout-effect", { useLayoutEffect });
  await replacer.replace("@/hooks/use-translation", {
    useTranslation: () => ({
      t: translateKey,
      tNode: (_key: string, node: ReactNode) => node,
      language: "en",
    }),
  });
  await replacer.replace("@/lib/chrome-storage-adapter", { chromeStorageAdapter: createMemoryStorage() });
  // Store actions report analytics, and Bun loads a developer's .env, so tests
  // would otherwise send events to the configured OpenPanel host.
  const realAnalytics = await importFresh<typeof import("@/lib/analytics")>("lib/analytics.ts");
  await replacer.replace("@/lib/analytics", { ...realAnalytics, analytics: { init: async () => {}, track: () => {} } });
  await replacer.replace(
    "@/store/plan-store",
    await importFresh<typeof import("@/store/plan-store")>("store/plan-store.ts"),
  );
  const bookmarksStore = await importFresh<typeof import("@/store/bookmarks-store")>("store/bookmarks-store.ts");
  await replacer.replace("@/store/bookmarks-store", bookmarksStore);
  // Tag mutation queues are scoped to an application session; another test may
  // leave hydration waiting on its inert IndexedDB request.
  await replacer.replace("@/lib/tag-persistence", await importFresh<typeof import("@/lib/tag-persistence")>("lib/tag-persistence.ts"));
  const workspaceStore = await importFresh<typeof import("@/store/workspace-store")>("store/workspace-store.ts");
  await replacer.replace("@/store/workspace-store", workspaceStore);
  await replacer.replace(
    "@/store/i18n-store",
    await importFresh<typeof import("@/store/i18n-store")>("store/i18n-store.ts"),
  );
  return {
    createRoot: reactDomClient.createRoot,
    useBookmarksStore: bookmarksStore.useBookmarksStore,
    useWorkspaceStore: workspaceStore.useWorkspaceStore,
  };
}

export interface RenderResult {
  container: HTMLElement;
  rerender: (element: ReactNode) => void;
  unmount: () => void;
}

export function render(app: Pick<AppModules, "createRoot">, element: ReactNode): RenderResult {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = app.createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    rerender: (next) => {
      act(() => {
        root.render(next);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

export function click(element: Element, init: MouseEventInit = {}): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init }));
  });
}

export function rightClick(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 8, clientY: 8 }));
  });
}

/** Radix dropdown triggers open on pointerdown, not click. */
export function openDropdown(trigger: Element): void {
  act(() => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
  });
}

export function pressKey(element: Element, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...init }));
  });
}

export function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  act(() => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function submitForm(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

export async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

export function queryByText(text: string, root: ParentNode = document.body): HTMLElement | null {
  const matches = Array.from(root.querySelectorAll<HTMLElement>("*")).filter(
    (element) => element.textContent?.trim() === text,
  );
  return matches.at(-1) ?? null;
}

export function getByText(text: string, root: ParentNode = document.body): HTMLElement {
  const element = queryByText(text, root);
  if (!element) {
    throw new Error(`No element with text "${text}"`);
  }
  return element;
}

export function getBySelector<T extends Element = HTMLElement>(selector: string, root: ParentNode = document.body): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`No element matches ${selector}`);
  }
  return element;
}
