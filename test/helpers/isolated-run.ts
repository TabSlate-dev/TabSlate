import { spawnSync } from "node:child_process";
import { relative } from "node:path";
// @ts-expect-error Bun provides this test module at runtime.
import { expect, test } from "bun:test";

const ISOLATED_TEST_FILE_ENV = "TABSLATE_ISOLATED_TEST_FILE";
const ISOLATED_RUN_TIMEOUT_MS = 60_000;

/**
 * Bun fixes a module's export names the first time it is imported in a test
 * process, so a file that registers a mock table missing some of a module's
 * exports would leave that module partial for every file that runs after it.
 * Such files run in their own `bun test` process instead: in the shared
 * process this registers one test that runs the file separately and returns
 * false; inside that separate process it returns true and the file registers
 * its mocks and tests as usual.
 */
export function runsInIsolatedProcess(testFile: string): boolean {
  if (process.env[ISOLATED_TEST_FILE_ENV] === testFile) {
    return true;
  }
  const displayPath = relative(process.cwd(), testFile);
  test(`${displayPath} passes in its own bun process`, () => {
    const result = spawnSync("bun", ["test", testFile], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, [ISOLATED_TEST_FILE_ENV]: testFile },
    });
    if (result.status !== 0) {
      throw new Error(`${result.stdout}\n${result.stderr}`);
    }
    expect(result.status).toBe(0);
  }, ISOLATED_RUN_TIMEOUT_MS);
  return false;
}
