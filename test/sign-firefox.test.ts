// @ts-expect-error Bun provides this test module at runtime.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const tempDirs: string[] = [];

const createMockNpx = () => {
  const dir = mkdtempSync(join(tmpdir(), "tabslate-sign-firefox-"));
  const capturePath = join(dir, "capture.json");
  const mockPath = join(dir, "npx");

  writeFileSync(
    mockPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const capturePath = process.env.MOCK_CAPTURE_PATH;
fs.writeFileSync(
  capturePath,
  JSON.stringify({
    argv: process.argv.slice(2),
    apiKey: process.env.AMO_JWT_ISSUER,
    apiSecret: process.env.AMO_JWT_SECRET,
  }),
);
process.exit(0);
`,
  );

  chmodSync(mockPath, 0o755);
  tempDirs.push(dir);

  return { capturePath, dir };
};

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("sign-firefox helper", () => {
  test("passes AMO credentials and listed channel to web-ext", () => {
    const { capturePath, dir } = createMockNpx();

    const result = spawnSync("node", ["scripts/sign-firefox.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AMO_JWT_ISSUER: "issuer-value",
        AMO_JWT_SECRET: "secret-value",
        MOCK_CAPTURE_PATH: capturePath,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      argv: string[];
      apiKey: string;
      apiSecret: string;
    };

    expect(capture.argv).toEqual([
      "web-ext",
      "sign",
      "--source-dir",
      ".output/firefox-mv3",
      "--channel",
      "listed",
      "--api-key",
      "issuer-value",
      "--api-secret",
      "secret-value",
    ]);
  });

  test("uses unlisted channel for self-hosted signing", () => {
    const { capturePath, dir } = createMockNpx();

    const result = spawnSync("node", ["scripts/sign-firefox.mjs", "--selfhost"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AMO_JWT_ISSUER: "issuer-value",
        AMO_JWT_SECRET: "secret-value",
        MOCK_CAPTURE_PATH: capturePath,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      argv: string[];
    };

    expect(capture.argv).toContain("--channel");
    expect(capture.argv).toContain("unlisted");
  });

  test("fails fast when AMO credentials are missing", () => {
    const result = spawnSync("node", ["scripts/sign-firefox.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AMO_JWT_ISSUER: "",
        AMO_JWT_SECRET: "",
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing AMO_JWT_ISSUER or AMO_JWT_SECRET");
  });
});
