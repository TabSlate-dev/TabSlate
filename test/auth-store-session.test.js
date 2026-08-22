import { describe, expect, test } from "bun:test";

async function runSessionFixture(testName) {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "test",
      "./test/auth-store-session-fixture.js",
      "--test-name-pattern",
      testName,
    ],
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`auth session fixture failed:\n${stdout}${stderr}`);
  }

  expect(exitCode).toBe(0);
}

describe("invalid authenticated session cleanup", () => {
  test("clears account data before transitioning to guest", async () => {
    await runSessionFixture("clears account data before transitioning to guest");
  });

  test("retires running sync work before clearing a definitively expired session", async () => {
    await runSessionFixture("retires active sync work before clearing a definitively expired session");
  });

  test("upgrades a queue-started refresh when an active pull joins it", async () => {
    await runSessionFixture("upgrades a shared refresh when the active pull joins it");
  });

  test("keeps full retirement when no active pull joins refresh", async () => {
    await runSessionFixture("keeps full retirement for a refresh with no active pull consumer");
  });

  test("retains a newer authenticated session after delayed cleanup", async () => {
    await runSessionFixture("retains a newer authenticated session after delayed cleanup");
  });
});
