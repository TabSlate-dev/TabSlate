import { isFirefoxBuild } from "@/lib/browser/env";

export function supportsTabGroups(): boolean {
  return true;
}

export function supportsDynamicContentScripts(): boolean {
  return true;
}

export function supportsDefaultEngineSearch(): boolean {
  return true;
}

export function usesFirefoxSearchNamespace(): boolean {
  return isFirefoxBuild();
}
