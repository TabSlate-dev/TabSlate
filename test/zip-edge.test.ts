// @ts-expect-error Bun provides this test module at runtime.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const tempDirs: string[] = [];

const chromeZipPath = join(process.cwd(), ".output", "tab-slate-0.1.5-chrome.zip");
const edgeZipPath = join(process.cwd(), ".output", "tab-slate-0.1.5-edge.zip");
const backupChromeZipPath = `${chromeZipPath}.bak-test`;
const backupEdgeZipPath = `${edgeZipPath}.bak-test`;

const backupArtifact = (filePath: string, backupPath: string) => {
  if (!existsSync(filePath)) {
    return false;
  }

  copyFileSync(filePath, backupPath);
  unlinkSync(filePath);

  return true;
};

const restoreArtifact = (filePath: string, backupPath: string) => {
  if (!existsSync(backupPath)) {
    return;
  }

  copyFileSync(backupPath, filePath);
  unlinkSync(backupPath);
};

const createMockNpx = () => {
  const dir = mkdtempSync(join(tmpdir(), "tabslate-zip-edge-"));
  const capturePath = join(dir, "capture.json");
  const mockPath = join(dir, "npx");

  writeFileSync(
    mockPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const capturePath = process.env.MOCK_CAPTURE_PATH;
const outputDir = path.join(process.cwd(), ".output");
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(
  path.join(outputDir, "tab-slate-0.1.5-chrome.zip"),
  "mock chrome zip",
);
fs.writeFileSync(
  capturePath,
  JSON.stringify({
    argv: process.argv.slice(2),
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

  if (existsSync(edgeZipPath)) {
    unlinkSync(edgeZipPath);
  }

  if (existsSync(chromeZipPath) && readFileSync(chromeZipPath, "utf8") === "mock chrome zip") {
    unlinkSync(chromeZipPath);
  }

  restoreArtifact(chromeZipPath, backupChromeZipPath);
  restoreArtifact(edgeZipPath, backupEdgeZipPath);
});

describe("zip-edge helper", () => {
  test("creates a distinct Edge zip artifact after Chromium packaging", () => {
    const { capturePath, dir } = createMockNpx();
    const hadChromeBackup = backupArtifact(chromeZipPath, backupChromeZipPath);
    const hadEdgeBackup = backupArtifact(edgeZipPath, backupEdgeZipPath);

    expect(hadChromeBackup || !existsSync(chromeZipPath)).toBeTrue();
    expect(hadEdgeBackup || !existsSync(edgeZipPath)).toBeTrue();

    const result = spawnSync("node", ["scripts/zip-edge.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MOCK_CAPTURE_PATH: capturePath,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const capture = JSON.parse(readFileSync(capturePath, "utf8")) as {
      argv: string[];
    };

    expect(capture.argv).toEqual(["wxt", "zip", "-b", "chrome", "--mv3"]);
    expect(existsSync(chromeZipPath)).toBeTrue();
    expect(existsSync(edgeZipPath)).toBeTrue();
    expect(readFileSync(edgeZipPath, "utf8")).toBe("mock chrome zip");
  });
});
