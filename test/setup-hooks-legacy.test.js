import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { legacyLavishHooks, removeLegacyLavishSessionStartHooks } from "../src/cli.js";

const otherHook = { matcher: "", hooks: [{ type: "command", command: "bash ~/.claude/hooks/other.sh", timeout: 10 }] };

test("removing legacy hooks drops only lavish-axi SessionStart entries", () => {
  const settings = {
    model: "opus",
    hooks: {
      SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "lavish-axi", timeout: 10 }] }, otherHook],
      Stop: [{ hooks: [{ type: "command", command: "lavish-axi-unrelated-stop" }] }],
    },
  };

  const [updated, removed] = removeLegacyLavishSessionStartHooks(settings);

  assert.equal(removed, 1);
  assert.deepEqual(updated.hooks.SessionStart, [otherHook]);
  assert.deepEqual(updated.hooks.Stop, settings.hooks.Stop, "only SessionStart is touched");
  assert.equal(updated.model, "opus");
  assert.equal(settings.hooks.SessionStart.length, 2, "input is not mutated");
});

test("a group that also holds other hooks keeps them", () => {
  const settings = {
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [
            { type: "command", command: "/home/me/.local/bin/lavish-axi", timeout: 10 },
            { type: "command", command: "echo hi" },
          ],
        },
      ],
    },
  };

  const [updated, removed] = removeLegacyLavishSessionStartHooks(settings);

  assert.equal(removed, 1);
  assert.deepEqual(updated.hooks.SessionStart, [{ matcher: "", hooks: [{ type: "command", command: "echo hi" }] }]);
});

test("settings without a lavish-axi hook are reported unchanged", () => {
  const settings = { hooks: { SessionStart: [otherHook] } };
  const [updated, removed] = removeLegacyLavishSessionStartHooks(settings);
  assert.equal(removed, 0);
  assert.equal(updated, settings);
});

function withHome(fn) {
  const home = mkdtempSync(path.join(os.tmpdir(), "hilight-hooks-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("legacyLavishHooks finds old hooks and removes them only when asked", () => {
  withHome((home) => {
    const claude = path.join(home, ".claude", "settings.json");
    const copilotDir = path.join(home, ".copilot", "hooks");
    mkdirSync(path.dirname(claude), { recursive: true });
    mkdirSync(copilotDir, { recursive: true });
    writeFileSync(
      claude,
      JSON.stringify({
        hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "lavish-axi" }] }] },
      }),
    );
    writeFileSync(path.join(copilotDir, "lavish-axi.json"), "{}");

    const found = legacyLavishHooks({ homeDir: home, copilotHookDir: copilotDir });
    assert.deepEqual(found.sort(), [claude, path.join(copilotDir, "lavish-axi.json")].sort());
    assert.match(readFileSync(claude, "utf8"), /lavish-axi/, "finding does not modify anything");

    const removed = legacyLavishHooks({ homeDir: home, copilotHookDir: copilotDir, remove: true });
    assert.deepEqual(removed.sort(), found.sort());
    assert.doesNotMatch(readFileSync(claude, "utf8"), /lavish-axi/);
    assert.equal(existsSync(path.join(copilotDir, "lavish-axi.json")), false);
    assert.deepEqual(legacyLavishHooks({ homeDir: home, copilotHookDir: copilotDir }), []);
  });
});

test("legacyLavishHooks leaves an unparseable settings file alone", () => {
  withHome((home) => {
    const claude = path.join(home, ".claude", "settings.json");
    mkdirSync(path.dirname(claude), { recursive: true });
    writeFileSync(claude, "{ not json lavish-axi");
    assert.deepEqual(legacyLavishHooks({ homeDir: home, copilotHookDir: path.join(home, "none"), remove: true }), []);
    assert.equal(readFileSync(claude, "utf8"), "{ not json lavish-axi");
  });
});
