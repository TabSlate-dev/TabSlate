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

  test("retains a newer authenticated session after delayed cleanup", async () => {
    await runSessionFixture("retains a newer authenticated session after delayed cleanup");
  });
});
