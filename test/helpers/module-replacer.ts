// @ts-expect-error Bun provides this test module at runtime.
import { mock } from "bun:test";

/**
 * Bun keeps module mocks for the whole run and patches modules that are
 * already loaded in place, so a test file that swaps a module must put the
 * previous exports back when it finishes. Bun also ignores a module namespace
 * returned from a mock factory, so replacements are handed over as plain
 * object copies. Specifiers must be `@/` aliases or package names.
 */
export interface ModuleReplacer {
  replace: (specifier: string, replacement: object) => Promise<void>;
  restore: () => void;
}

export function createModuleReplacer(): ModuleReplacer {
  const previous: Array<readonly [string, object]> = [];
  return {
    async replace(specifier, replacement) {
      previous.push([specifier, { ...(await import(specifier)) }]);
      mock.module(specifier, () => ({ ...replacement }));
    },
    restore() {
      for (const [specifier, exports] of [...previous].reverse()) {
        mock.module(specifier, () => exports);
      }
      previous.length = 0;
    },
  };
}

let freshImportCount = 0;

/**
 * Loads a fresh copy of a module, given its path from the repository root.
 * The query string bypasses any mock another test file registered for the
 * same path; the copy's own imports still resolve through the registry.
 */
export async function importFresh<T>(repoPath: string): Promise<T> {
  freshImportCount += 1;
  return await import(`../../${repoPath}?fresh=${freshImportCount}`);
}
