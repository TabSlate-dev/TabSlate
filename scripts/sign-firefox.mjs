import { spawnSync } from "node:child_process";

const isSelfhost = process.argv.includes("--selfhost");
const sourceDir = ".output/firefox-mv3";
const args = [
  "web-ext",
  "sign",
  "--source-dir",
  sourceDir,
  "--channel",
  isSelfhost ? "unlisted" : "listed",
];

if (!process.env.AMO_JWT_ISSUER || !process.env.AMO_JWT_SECRET) {
  console.error("Missing AMO_JWT_ISSUER or AMO_JWT_SECRET");
  process.exit(1);
}

const result = spawnSync("npx", args, {
  stdio: "inherit",
  env: {
    ...process.env,
    WEB_EXT_API_KEY: process.env.AMO_JWT_ISSUER,
    WEB_EXT_API_SECRET: process.env.AMO_JWT_SECRET,
  },
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
