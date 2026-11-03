import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("check script runs all verification commands", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const checkCommands = packageJson.scripts.check.split(" && ");

  assert.deepEqual(checkCommands, [
    "npm run build",
    "npm run lint",
    "npm run format:check",
    "npm run typecheck",
    "npm test",
    "node scripts/build-skill.js --check",
    "node scripts/build-plugin.js --check",
  ]);
});

test("committed skill matches the generator stub", async () => {
  const { createSkillMarkdown } = await import("../src/skill.js");
  const committed = await readFile(new URL("../skills/hilight/SKILL.md", import.meta.url), "utf8");

  assert.equal(committed, createSkillMarkdown(), "run `npm run build:skill` and commit the result");
});

test("published package includes the installable skill", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.ok(packageJson.files.includes("skills/hilight"));
});

test("published package root is a complete Agent Plugin", async () => {
  // The tarball root doubles as the plugin root, so both the manifest and the skills it
  // discovers have to ship; without either, an installed copy is not installable as a plugin.
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.ok(packageJson.files.includes("plugin.json"));
  assert.ok(packageJson.files.includes("skills/hilight"));
});

test("release-please keeps the plugin manifest version in step with the package", async () => {
  const config = JSON.parse(await readFile(new URL("../release-please-config.json", import.meta.url), "utf8"));

  assert.deepEqual(config.packages["."]["extra-files"], [{ type: "json", path: "plugin.json", jsonpath: "$.version" }]);
});

test("lavish-design agent skill is marked internal for skills CLI discovery", async () => {
  const skillMd = await readFile(new URL("../.agents/skills/lavish-design/SKILL.md", import.meta.url), "utf8");
  const frontmatter = skillMd.slice(4, skillMd.indexOf("\n---\n", 4));

  assert.match(frontmatter, /^name: lavish-design$/m);
  assert.match(frontmatter, /^metadata:\n {2}internal: true$/m);
});

test("public hilight skill is not marked internal", async () => {
  const skillMd = await readFile(new URL("../skills/hilight/SKILL.md", import.meta.url), "utf8");
  const frontmatter = skillMd.slice(4, skillMd.indexOf("\n---\n", 4));

  assert.doesNotMatch(frontmatter, /^metadata:\n {2}internal: true$/m);
});

test("build copies local design assets for published artifact injection", async () => {
  const buildScript = await readFile(new URL("../scripts/build.js", import.meta.url), "utf8");

  assert.match(buildScript, /daisyui\.css/);
  assert.match(buildScript, /daisyui-themes\.css/);
  assert.match(buildScript, /tailwindcss-browser\.js/);
});

test("package metadata points at the Hilight repository", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.repository.url, "git+https://github.com/zzzubair/hilight.git");
  assert.equal(packageJson.bugs.url, "https://github.com/zzzubair/hilight/issues");
  assert.equal(packageJson.homepage, "https://github.com/zzzubair/hilight#readme");
});

test("the package installs only the hilight command", async () => {
  // A lavish-axi bin would clash with a real Lavish install on the same machine.
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.equal(packageJson.name, "hilight-axi");
  assert.deepEqual(packageJson.bin, { hilight: "dist/cli.mjs" });
});

test("pnpm lock root importer matches the publish manifest", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const pnpmLock = await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");

  for (const [name, specifier] of Object.entries(packageJson.dependencies)) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedSpecifier = specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    assert.match(pnpmLock, new RegExp(`["']?${escapedName}["']?:[\\s\\S]*?specifier: ${escapedSpecifier}`));
  }
});

test("release workflow publishes from the release tag checkout", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release-please.yml", import.meta.url), "utf8");

  assert.match(
    workflow,
    /uses: actions\/checkout@v6\n\s+if: \$\{\{ steps\.release\.outputs\.release_created \}\}\n\s+with:\n\s+ref: \$\{\{ steps\.release\.outputs\.tag_name \}\}/,
  );
});

test("release workflow attaches the fixed-name tarball instead of publishing to npm", async () => {
  // Hilight is not on the npm registry. Installs use releases/latest/download/hilight-axi.tgz,
  // so every release must carry an asset with exactly that name.
  const workflow = await readFile(new URL("../.github/workflows/release-please.yml", import.meta.url), "utf8");

  assert.doesNotMatch(workflow, /npm publish/);
  assert.match(workflow, /run: pnpm run pack:release\n/);
  assert.match(
    workflow,
    /gh release upload "\$\{\{ steps\.release\.outputs\.tag_name \}\}" hilight-axi\.tgz --clobber/,
  );
});

test("a release created by hand also gets the tarball", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release-asset.yml", import.meta.url), "utf8");

  assert.match(workflow, /release:\n\s+types: \[published\]/);
  assert.match(workflow, /run: pnpm run pack:release\n/);
  assert.match(workflow, /gh release upload "\$TAG" hilight-axi\.tgz --clobber/);
});

test("pack:release writes hilight-axi.tgz holding the hilight bin, dist, and skill", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const out = mkdtempSync(path.join(os.tmpdir(), "hilight-pack-"));
  try {
    // --no-build packs the dist/ that `pnpm run check` already built, so this test never
    // rewrites dist/ while other test files read it.
    execFileSync(process.execPath, ["scripts/pack-release.js", "--no-build", "--out", out], {
      cwd: new URL("..", import.meta.url),
      stdio: "pipe",
    });
    const tarball = path.join(out, "hilight-axi.tgz");
    const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split(/\r?\n/);
    for (const file of [
      "package/package.json",
      "package/dist/cli.mjs",
      "package/dist/server.mjs",
      "package/skills/hilight/SKILL.md",
    ]) {
      assert.ok(listing.includes(file), `${file} is in the tarball`);
    }
    const manifest = JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }));
    assert.equal(manifest.name, "hilight-axi");
    assert.deepEqual(manifest.bin, { hilight: "dist/cli.mjs" });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
