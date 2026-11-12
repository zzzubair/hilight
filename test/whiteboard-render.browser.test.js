import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

import { parse } from "parse5";

import { chromePath, serveFixture } from "./fixtures/browser-fixture.js";

function dumpChromeDom(chrome, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, args, { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop();
      if (error) reject(error);
      else resolve(stdout);
    };
    const timer = setTimeout(() => finish(new Error("Chrome did not dump the fixture DOM in time")), timeoutMs);
    child.on("error", finish);
    child.on("exit", (code) => {
      if (!settled) finish(new Error(`Chrome exited before dumping the fixture DOM (${code})`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 8 * 1024 * 1024) {
        finish(new Error("Chrome fixture DOM exceeded 8 MB"));
      } else if (stdout.includes("</html>")) {
        finish();
      }
    });
  });
}

function resultFromDump(html) {
  const document = parse(html);
  const stack = /** @type {import("parse5").DefaultTreeAdapterMap["node"][]} */ ([document]);
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.nodeName === "body") {
      const element = /** @type {import("parse5").DefaultTreeAdapterMap["element"]} */ (node);
      const attribute = element.attrs.find((item) => item.name === "data-result");
      if (attribute) return JSON.parse(attribute.value);
    }
    if ("childNodes" in node) stack.push(...node.childNodes);
  }
  return null;
}

async function runBrowserFixture(t, fixtureName) {
  const chrome = await chromePath();
  if (!chrome) {
    t.skip("Chrome or Chromium is required for the real-render regression");
    return null;
  }
  const site = await serveFixture(fixtureName, (url, response) => {
    if (url.pathname !== "/result") return false;
    const value = String(url.searchParams.get("value") || "")
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><html><body data-result="${value}"></body></html>`);
    return true;
  });
  try {
    const stdout = await dumpChromeDom(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        `--user-data-dir=${path.join(site.root, "chrome-profile")}`,
        "--run-all-compositor-stages-before-draw",
        "--virtual-time-budget=20000",
        "--dump-dom",
        site.url,
      ],
      75_000,
    );
    const result = resultFromDump(stdout);
    assert.ok(result, "browser fixture did not report a result");
    assert.equal(result.pass, true, result.error);
    return result;
  } finally {
    await site.close();
  }
}

test("real Excalidraw rendering keeps loaded-font labels inside their text bounds", { timeout: 90_000 }, async (t) => {
  const result = await runBrowserFixture(t, "excalidraw-label-clipping");
  if (!result) return;
  assert.equal(result.fontReady, true);
  assert.equal(result.edgeLabels, 4);
  assert.ok(result.multilineLines >= 2);
  assert.ok(result.repaired >= 5);
  assert.ok(result.opaquePixels >= 1000);
});

test("mounted Excalidraw autosaves prompt only after genuine edits", { timeout: 90_000 }, async (t) => {
  const result = await runBrowserFixture(t, "excalidraw-autosave-conflict");
  if (!result) return;
  assert.equal(result.preMountBaselineAction, "prompt");
  assert.equal(result.viewOnlyAction, "convert");
  assert.equal(result.editedAction, "prompt");
});

test("library icon nodes keep their arrows attached and panel inserts stay named", { timeout: 90_000 }, async (t) => {
  const result = await runBrowserFixture(t, "excalidraw-library-icons");
  if (!result) return;
  assert.equal(result.lrNode.arrows, 3);
  assert.equal(result.tdNode.arrows, 3);
  assert.equal(result.lrNode.nodes, 4);
  assert.equal(result.tdNode.nodes, 4);
  assert.equal(result.panelItems, 1);
  assert.equal(result.dropped, 2);
  assert.match(result.summary, /^Added library item fixture\/Gear near \(/);
});

test(
  "a board renders live code cards, refreshes their status, and opens nested levels",
  { timeout: 90_000 },
  async (t) => {
    const result = await runBrowserFixture(t, "board-canvas");
    if (!result) return;
    assert.ok(result.opening.includes("intro"), "the board opens on its top row");
    assert.deepEqual(
      result.root.map((card) => card.id),
      ["intro", "fresh", "stale", "inside"],
    );
    assert.match(result.root.find((card) => card.id === "fresh").className, /is-fresh/);
    assert.match(result.root.find((card) => card.id === "stale").className, /is-stale/);
    assert.equal(result.changedLines, 1);
    assert.deepEqual(result.landings, [1, 1], "an arrow highlights the line it starts on and the line it ends on");
    assert.deepEqual(result.legend, ["Add"]);
    assert.match(result.health, /1 of 2 code cards changed since pinned/);
    assert.equal(result.savedCards, 5);
    assert.equal(result.savedLinks, 5, "saved cards keep their link so a reload admits them again");
    assert.equal(result.connectorsSaved, 0, "connectors come from the file, never from the saved scene");
    assert.match(result.healthAfter, /all match the code/);
    assert.deepEqual(result.nested, ["deep"]);
    assert.match(result.crumbs, /Math\s*\/\s*Inside/);
  },
);
