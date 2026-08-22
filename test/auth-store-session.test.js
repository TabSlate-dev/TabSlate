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

  test("shares a queue-started refresh with a later pull consumer", async () => {
    await runSessionFixture("shares queue-started refresh cleanup with a later pull consumer");
  });

  test("keeps full resolution retirement when no pull joins refresh", async () => {
    await runSessionFixture("keeps full resolution retirement for a refresh with no pull consumer");
  });

  test("retains a newer authenticated session after delayed cleanup", async () => {
    await runSessionFixture("retains a newer authenticated session after delayed cleanup");
  });
});
