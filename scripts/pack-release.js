// Builds the installable release asset: `npm pack` output under the fixed name
// hilight-axi.tgz, so https://github.com/zzzubair/hilight/releases/latest/download/hilight-axi.tgz
// always points at the newest release.
//
//   node scripts/pack-release.js                 # build, then write ./hilight-axi.tgz
//   node scripts/pack-release.js --out <dir>     # write <dir>/hilight-axi.tgz
//   node scripts/pack-release.js --no-build      # pack the existing dist/ (skips prepack)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RELEASE_ASSET_NAME = "hilight-axi.tgz";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outDir = path.resolve(outIndex >= 0 ? String(args[outIndex + 1] || "") : root);
const build = !args.includes("--no-build");

const staging = mkdtempSync(path.join(os.tmpdir(), "hilight-pack-staging-"));
try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packArgs = ["pack", "--json", "--pack-destination", staging, ...(build ? [] : ["--ignore-scripts"])];
  const report = JSON.parse(
    execFileSync(npm, packArgs, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      shell: process.platform === "win32",
    }),
  );
  const packed = report?.[0]?.filename;
  if (!packed) throw new Error("npm pack did not report a tarball");
  mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, RELEASE_ASSET_NAME);
  renameSync(path.join(staging, packed), target);
  console.log(`Wrote ${target}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
