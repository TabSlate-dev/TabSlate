import { spawnSync } from "node:child_process";
import { relative } from "node:path";
// @ts-expect-error Bun provides this test module at runtime.
import { expect, test } from "bun:test";

const ISOLATED_TEST_FILE_ENV = "TABSLATE_ISOLATED_TEST_FILE";
const ISOLATED_RUN_TIMEOUT_MS = 60_000;

/** The last count Bun's summary reports for a pattern, e.g. " 12 pass". */
function summaryCount(output: string, pattern: RegExp): number | null {
  const last = [...output.matchAll(pattern)].at(-1);
  return last ? Number(last[1]) : null;
}

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
    const result = spawnSync(process.execPath, ["test", testFile], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, [ISOLATED_TEST_FILE_ENV]: testFile },
      timeout: ISOLATED_RUN_TIMEOUT_MS,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    const ran = summaryCount(output, /^Ran (\d+) tests? across/gm) ?? 0;
    const passed = summaryCount(output, /^ *(\d+) pass$/gm) ?? 0;
    const failed = summaryCount(output, /^ *(\d+) fail$/gm);
    // Bun exits 0 when the file registers no tests or skips them all, so a pass must be reported too.
    if (result.status !== 0 || passed === 0 || failed !== 0) {
      const exit = result.error?.message ?? `exit ${result.status ?? result.signal}`;
      throw new Error(
        `${displayPath} did not pass in its own process (tests run: ${ran}, pass: ${passed}, fail: ${failed ?? "not reported"}; ${exit})\n${output}`,
      );
    }
    expect(result.status).toBe(0);
  }, ISOLATED_RUN_TIMEOUT_MS);
  return false;
}
