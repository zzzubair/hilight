import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createUpdateOutput, VERSION } from "../src/cli.js";
import { HILIGHT_TARBALL_URL } from "../src/skill.js";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/hilight.js", import.meta.url));

test("update installs from the GitHub release tarball, not the npm registry", () => {
  const calls = [];
  const output = createUpdateOutput([], {
    install: (command, args) => {
      calls.push([command, ...args]);
      return { status: 0, stdout: "", stderr: "" };
    },
  });

  assert.deepEqual(calls, [["npm", "install", "-g", HILIGHT_TARBALL_URL]]);
  assert.equal(output.update.status, "installed");
  assert.equal(output.update.previous_version, VERSION);
});

test("update --check reports the install command without running it", () => {
  const output = createUpdateOutput(["--check"], {
    install: () => assert.fail("--check must not install"),
  });

  assert.equal(output.update.status, "check");
  assert.equal(output.update.current_version, VERSION);
  assert.equal(output.update.install_command, `npm install -g ${HILIGHT_TARBALL_URL}`);
});

test("a failed update install is an error that names the manual command", () => {
  assert.throws(
    () => createUpdateOutput([], { install: () => ({ status: 1, stdout: "", stderr: "npm ERR! 404" }) }),
    (/** @type {any} */ error) => {
      assert.equal(error.code, "SERVER_ERROR");
      assert.ok(error.suggestions.some((line) => line.includes(`npm install -g ${HILIGHT_TARBALL_URL}`)));
      return true;
    },
  );
});

test("`hilight update --check` goes to the Hilight handler, not the SDK npm-registry updater", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "hilight-update-"));
  try {
    const { stdout } = await execFileAsync(process.execPath, [BIN, "update", "--check"], {
      env: { ...process.env, HILIGHT_STATE_DIR: stateDir, HILIGHT_TELEMETRY: "0" },
    });
    assert.match(stdout, /hilight-axi\.tgz/);
    assert.doesNotMatch(stdout, /registry\.npmjs\.org/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
