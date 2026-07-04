import { copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

import pkg from "../package.json" with { type: "json" };

const version = pkg.version;
const chromeZipPath = `.output/tab-slate-${version}-chrome.zip`;
const edgeZipPath = `.output/tab-slate-${version}-edge.zip`;

const result = spawnSync("npx", ["wxt", "zip", "-b", "chrome", "--mv3"], {
  stdio: "inherit",
  env: process.env,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (!existsSync(chromeZipPath)) {
  console.error(`Expected Chrome zip artifact at ${chromeZipPath}`);
  process.exit(1);
}

copyFileSync(chromeZipPath, edgeZipPath);
