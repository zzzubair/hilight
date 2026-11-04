import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readEnv } from "../src/env.js";
import { bindHost, defaultPort, stateDir } from "../src/paths.js";

test("readEnv prefers HILIGHT_* and falls back to the legacy LAVISH_AXI_* name", () => {
  assert.equal(readEnv({ HILIGHT_PORT: "5000", LAVISH_AXI_PORT: "4000" }, "PORT"), "5000");
  assert.equal(readEnv({ LAVISH_AXI_PORT: "4000" }, "PORT"), "4000");
  assert.equal(readEnv({}, "PORT"), undefined);
});

test("an explicitly set HILIGHT_* value wins even when it is empty", () => {
  assert.equal(readEnv({ HILIGHT_HOST: "", LAVISH_AXI_HOST: "100.64.0.1" }, "HOST"), "");
});

test("settings read through the env helper accept legacy LAVISH_AXI_* variables", () => {
  assert.equal(bindHost({ LAVISH_AXI_HOST: "100.64.0.9" }), "100.64.0.9");
  assert.equal(bindHost({ HILIGHT_HOST: "100.64.0.8", LAVISH_AXI_HOST: "100.64.0.9" }), "100.64.0.8");
  assert.equal(defaultPort({ LAVISH_AXI_PORT: "4400" }), 4400);
  assert.equal(defaultPort({ HILIGHT_PORT: "4401", LAVISH_AXI_PORT: "4400" }), 4401);
  assert.equal(defaultPort({}), 4387);
});

function withHome(fn) {
  const home = mkdtempSync(path.join(os.tmpdir(), "hilight-home-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("state dir: HILIGHT_STATE_DIR wins, then LAVISH_AXI_STATE_DIR", () => {
  withHome((home) => {
    assert.equal(stateDir({ env: { HILIGHT_STATE_DIR: "/a", LAVISH_AXI_STATE_DIR: "/b" }, home }), "/a");
    assert.equal(stateDir({ env: { LAVISH_AXI_STATE_DIR: "/b" }, home }), "/b");
  });
});

test("state dir defaults to ~/.hilight on a fresh machine", () => {
  withHome((home) => {
    assert.equal(stateDir({ env: {}, home }), path.join(home, ".hilight"));
  });
});

test("state dir keeps using an existing ~/.lavish-axi when ~/.hilight does not exist", () => {
  withHome((home) => {
    mkdirSync(path.join(home, ".lavish-axi"));
    assert.equal(stateDir({ env: {}, home }), path.join(home, ".lavish-axi"));
  });
});

test("state dir prefers ~/.hilight once it exists, even next to ~/.lavish-axi", () => {
  withHome((home) => {
    mkdirSync(path.join(home, ".lavish-axi"));
    mkdirSync(path.join(home, ".hilight"));
    assert.equal(stateDir({ env: {}, home }), path.join(home, ".hilight"));
  });
});
