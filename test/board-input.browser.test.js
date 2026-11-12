import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { chromePath, serveFixture } from "./fixtures/browser-fixture.js";

// Real Chrome, real Excalidraw, trusted input: every wheel, pinch, drag and key below goes through
// the DevTools protocol's Input domain, the same path as a hardware event, never a synthetic DOM
// event. Skips when no Chrome is installed.

const WIDTH = 1280;
const HEIGHT = 800;
const SHIFT = 8;
const CTRL = 2;
const META = 4;

class Cdp {
  /** @param {WebSocket} socket */
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
    this.pending = new Map();
    socket.addEventListener("message", (message) => {
      const data = JSON.parse(String(message.data));
      const waiter = data.id ? this.pending.get(data.id) : null;
      if (!waiter) return;
      this.pending.delete(data.id);
      if (data.error) waiter.reject(new Error(`${data.error.message} ${data.error.data || ""}`.trim()));
      else waiter.resolve(data.result);
    });
  }

  /** @param {string} method @param {Record<string, unknown>} [params] */
  send(method, params = {}) {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** @param {string} expression */
  async eval(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(label, check, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function openBrowser(chrome, url, profile, { width = WIDTH, height = HEIGHT } = {}) {
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--no-first-run",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      "about:blank",
    ],
    { detached: true, stdio: "ignore" },
  );
  const stop = () => {
    try {
      process.kill(-(child.pid || 0), "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  try {
    const port = await until("DevTools port", async () => {
      try {
        return (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
      } catch {
        return "";
      }
    });
    const targets = await until("a page target", async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find((target) => target.type === "page") ? list : null;
    });
    const socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const cdp = new Cdp(socket);
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url });
    await until("the board's cards", () => cdp.eval("Boolean(window.probe?.ready())"));
    return {
      cdp,
      close() {
        socket.close();
        stop();
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}

test("a board answers trackpad and mouse input in real Chrome", { timeout: 180_000 }, async (t) => {
  const chrome = await chromePath();
  if (!chrome) {
    t.skip("Chrome or Chromium is required for the real-input regression");
    return;
  }
  const site = await serveFixture("board-input");
  const browser = await openBrowser(chrome, site.url, path.join(site.root, "chrome-profile")).catch(async (error) => {
    await site.close();
    throw error;
  });
  const { cdp } = browser;
  t.after(async () => {
    browser.close();
    await site.close();
  });

  const probe = (call) => cdp.eval(`window.probe.${call}`);
  const frames = (count = 2) => probe(`frames(${count})`);
  const cards = () => probe("cards()");
  const wheel = (x, y, deltaX, deltaY, modifiers = 0) =>
    cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY, modifiers });
  const mouse = (type, x, y, button = "none", buttons = 0, modifiers = 0) =>
    cdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button,
      buttons,
      modifiers,
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  const key = async (type, keyName, code, keyCode, text) =>
    cdp.send("Input.dispatchKeyEvent", {
      type,
      key: keyName,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      ...(text && type === "keyDown" ? { text } : {}),
    });
  const press = async (keyName, code, keyCode) => {
    await key("keyDown", keyName, code, keyCode, keyName);
    await key("keyUp", keyName, code, keyCode);
  };
  async function drag(from, by, button, buttons, steps = 6) {
    await mouse("mouseMoved", from.x, from.y);
    await mouse("mousePressed", from.x, from.y, button, buttons);
    for (let step = 1; step <= steps; step += 1) {
      await mouse("mouseMoved", from.x + (by.x * step) / steps, from.y + (by.y * step) / steps, button, buttons);
      await frames(1);
    }
    await mouse("mouseReleased", from.x + by.x, from.y + by.y, button, 0);
    await frames(2);
  }
  // Fit, so every check starts from the same view with every card drawn.
  async function reset() {
    await probe("fit()");
    await sleep(450);
    await frames(3);
    return cards();
  }
  // How a card moved between two readings: the pan in screen pixels and the zoom ratio.
  // A card scrolled off the canvas stays in the page at zero size, so the reference is one drawn in both.
  const drawn = (box) => Boolean(box && box.w > 0);
  function moved(
    before,
    after,
    id = Object.keys(before).find((name) => name !== "long" && drawn(before[name]) && drawn(after[name])),
  ) {
    assert.ok(id && drawn(before[id]) && drawn(after[id]), "a reference card stays drawn");
    return { dx: after[id].x - before[id].x, dy: after[id].y - before[id].y, scale: after[id].w / before[id].w };
  }
  const near = (actual, expected, tolerance, label) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} +-${tolerance}, got ${actual}`);
  // The scene point under the cursor stays under it: same fraction of the card before and after.
  function steadyUnder(point, before, after, id, tolerance = 1.5) {
    const fx = (point.x - before[id].x) / before[id].w;
    const fy = (point.y - before[id].y) / before[id].h;
    near(after[id].x + fx * after[id].w, point.x, tolerance, `${id} x under the cursor`);
    near(after[id].y + fy * after[id].h, point.y, tolerance, `${id} y under the cursor`);
  }
  const centreOf = (box) => ({ x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) });
  const start = await probe("page()");

  await t.test("two-finger scroll pans by exactly its deltas and never zooms", async () => {
    const before = await reset();
    const at = centreOf(before.b);
    for (let index = 0; index < 40; index += 1) {
      await wheel(at.x, at.y, 2, 3);
      if (index % 4 === 3) await frames(1);
    }
    await frames(2);
    const move = moved(before, await cards());
    near(move.dx, -80, 1.5, "sideways pan");
    near(move.dy, -120, 1.5, "vertical pan");
    near(move.scale, 1, 0.001, "zoom");
  });

  await t.test("a momentum tail glides smoothly, one small step per frame, without zooming", async () => {
    const before = await reset();
    const at = centreOf(before.b);
    let total = 0;
    let largest = 0;
    let last = before;
    for (let index = 0; index < 36; index += 1) {
      const delta = Math.max(1, Math.round(24 * 0.88 ** index));
      total += delta;
      await wheel(at.x, at.y, 0, delta);
      await frames(1);
      const now = await cards();
      largest = Math.max(largest, Math.abs(moved(last, now).dy));
      last = now;
    }
    const move = moved(before, last);
    near(move.dy, -total, 1.5, "the whole glide");
    assert.ok(largest <= 25, `largest step ${largest}px`);
    near(move.scale, 1, 0.001, "zoom");
  });

  await t.test("a wheel-delta spike is capped instead of jumping the board", async () => {
    const before = await reset();
    const at = centreOf(before.b);
    await wheel(at.x, at.y, 0, 5000);
    await frames(2);
    const move = moved(before, await cards());
    near(move.dy, -400, 1.5, "capped pan");
    near(move.scale, 1, 0.001, "zoom");
  });

  await t.test("a trackpad pinch (ctrl + wheel) zooms around the cursor", async () => {
    const before = await reset();
    const at = { x: Math.round(before.b.x + before.b.w * 0.3), y: Math.round(before.b.y + before.b.h * 0.7) };
    for (let index = 0; index < 6; index += 1) {
      await wheel(at.x, at.y, 0, -8, CTRL);
      await frames(1);
    }
    await frames(2);
    const after = await cards();
    assert.ok(moved(before, after, "b").scale > 1.2, "zoomed in");
    steadyUnder(at, before, after, "b");
  });

  await t.test("a synthesized touchpad pinch gesture zooms around the cursor", async (sub) => {
    const before = await reset();
    const at = centreOf(before.b);
    try {
      await cdp.send("Input.synthesizePinchGesture", {
        x: at.x,
        y: at.y,
        scaleFactor: 1.5,
        relativeSpeed: 600,
        gestureSourceType: "mouse",
      });
    } catch (error) {
      sub.skip(`Input.synthesizePinchGesture is not available here: ${error.message}`);
      return;
    }
    // A loaded CI runner can still be delivering the gesture's last wheels after the command
    // returns, so read once the zoom has stopped changing rather than after a fixed wait.
    let after = await cards();
    for (let settled = 0, tries = 0; settled < 2 && tries < 30; tries += 1) {
      await sleep(100);
      await frames(2);
      const next = await cards();
      settled = Math.abs(moved(after, next, "b").scale - 1) < 0.001 ? settled + 1 : 0;
      after = next;
    }
    // A loaded runner delivers less of a synthesized 1.5x gesture (1.16x was seen settled on CI),
    // so this checks the direction and the anchor, not the amount. A broken pinch stays at 1.0x.
    const { scale } = moved(before, after, "b");
    assert.ok(scale > 1.1, `zoomed in (${scale.toFixed(3)}x)`);
    steadyUnder(at, before, after, "b", 3);
    assert.equal((await probe("page()")).href, start.href, "the page itself never zoomed or navigated");
  });

  await t.test("a sideways swipe at the page edge pans the board and never goes back or forward", async () => {
    const before = await reset();
    const editor = await probe("editor()");
    const edge = { x: Math.round(editor.x + 6), y: Math.round(editor.y + editor.h / 2) };
    for (let index = 0; index < 20; index += 1) {
      await wheel(edge.x, edge.y, -15, 0);
      if (index % 2) await frames(1);
    }
    await frames(2);
    const move = moved(before, await cards());
    near(move.dx, 300, 1.5, "pan right");
    near(move.dy, 0, 0.5, "no vertical drift");
    await sleep(300);
    const page = await probe("page()");
    assert.equal(page.href, start.href);
    assert.equal(page.history, start.history);
  });

  await t.test("over a code card the code scrolls while it can, then hands the wheel to the board", async () => {
    const before = await reset();
    const code = await probe('code("long")');
    assert.ok(code && code.max > 100, `the code card has more lines than room (${JSON.stringify(code)})`);
    const box = before.long;
    const over = { x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h * 0.75) };
    // At the top, scrolling up has no room: the board pans.
    await wheel(over.x, over.y, 0, -40);
    await frames(2);
    let now = await cards();
    near(moved(before, now).dy, 40, 1.5, "at the top limit the board pans");
    assert.equal((await probe('code("long")')).top, 0);
    // Scrolling down moves the code, not the board.
    let pointer = { x: over.x, y: over.y + 40 };
    let mark = now;
    await wheel(pointer.x, pointer.y, 0, 30);
    await frames(2);
    now = await cards();
    near(moved(mark, now).dy, 0, 0.5, "the board stays while the code scrolls");
    assert.ok((await probe('code("long")')).top > 0, "the code scrolled");
    // Run the code to its bottom, then one more wheel pans the board.
    for (let index = 0; index < 80 && (await probe('code("long")')).top < code.max - 0.5; index += 1) {
      await wheel(pointer.x, pointer.y, 0, 60);
      await frames(1);
    }
    near((await probe('code("long")')).top, code.max, 1, "the code reached its bottom");
    await frames(2);
    mark = await cards();
    await wheel(pointer.x, pointer.y, 0, 50);
    await frames(2);
    now = await cards();
    near(moved(mark, now).dy, -50, 1.5, "at the bottom limit the board pans");
    near((await probe('code("long")')).top, code.max, 1, "the code stays at its bottom");
  });

  await t.test("a mouse wheel pans vertically and shift + wheel pans sideways", async () => {
    let before = await reset();
    const at = centreOf(before.b);
    await wheel(at.x, at.y, 0, 100);
    await frames(2);
    let move = moved(before, await cards());
    near(move.dy, -100, 1.5, "wheel pans down");
    near(move.dx, 0, 0.5, "no sideways drift");
    near(move.scale, 1, 0.001, "zoom");
    before = await reset();
    await wheel(at.x, at.y, 0, 100, SHIFT);
    await frames(2);
    move = moved(before, await cards());
    near(move.dx, -100, 1.5, "shift + wheel pans sideways");
    near(move.dy, 0, 0.5, "no vertical drift");
    near(move.scale, 1, 0.001, "zoom");
  });

  await t.test("ctrl + wheel and cmd + wheel zoom around the cursor", async () => {
    for (const { label, modifiers } of [
      { label: "ctrl", modifiers: CTRL },
      { label: "cmd", modifiers: META },
    ]) {
      const before = await reset();
      const at = { x: Math.round(before.c.x + before.c.w * 0.2), y: Math.round(before.c.y + before.c.h * 0.4) };
      await wheel(at.x, at.y, 0, -100, modifiers);
      await frames(2);
      const after = await cards();
      assert.ok(moved(before, after, "c").scale > 1.1, `${label} + wheel zoomed in`);
      steadyUnder(at, before, after, "c");
    }
  });

  await t.test("a middle-button drag pans", async () => {
    const before = await reset();
    const from = await probe("empty()");
    assert.ok(from, "an empty spot on the canvas");
    await drag(from, { x: 120, y: 70 }, "middle", 4);
    const move = moved(before, await cards());
    near(move.dx, 120, 2, "pan x");
    near(move.dy, 70, 2, "pan y");
    near(move.scale, 1, 0.001, "zoom");
  });

  await t.test("space + left drag pans", async () => {
    const before = await reset();
    const from = await probe("empty()");
    await mouse("mousePressed", from.x, from.y, "left", 1);
    await mouse("mouseReleased", from.x, from.y, "left", 0);
    await key("keyDown", " ", "Space", 32, " ");
    await drag(from, { x: -90, y: 50 }, "left", 1);
    await key("keyUp", " ", "Space", 32);
    const move = moved(before, await cards());
    near(move.dx, -90, 2, "pan x");
    near(move.dy, 50, 2, "pan y");
  });

  await t.test("the hand tool (H) drags the board", async () => {
    const before = await reset();
    const from = await probe("empty()");
    await press("h", "KeyH", 72);
    await frames(2);
    await drag(from, { x: 60, y: -40 }, "left", 1);
    await press("v", "KeyV", 86);
    const move = moved(before, await cards());
    near(move.dx, 60, 2, "pan x");
    near(move.dy, -40, 2, "pan y");
  });

  await t.test("no wheel reached the page, and nothing navigated", async () => {
    const { wheels, unprevented } = await probe("wheels()");
    assert.ok(wheels > 100, `${wheels} wheels sent`);
    assert.equal(unprevented, 0, "every wheel was handled by the board");
    const page = await probe("page()");
    assert.equal(page.href, start.href);
    assert.equal(page.history, start.history);
    assert.equal(page.scrollX, 0);
    assert.equal(page.scrollY, 0);
  });
});

// Two things float at the top of a board: Excalidraw's Draw toolbar and the new-card toast. The
// toast never sits on the toolbar: with Draw on it is 8px below it, and with Draw off back at rest.
test("the new-card toast sits below the Draw toolbar, never on it", { timeout: 180_000 }, async (t) => {
  const chrome = await chromePath();
  if (!chrome) {
    t.skip("Chrome or Chromium is required for the real-layout regression");
    return;
  }
  const site = await serveFixture("board-input");
  t.after(() => site.close());
  for (const [width, height] of [
    [1470, 860],
    [1116, 826],
  ]) {
    const browser = await openBrowser(chrome, `${site.url}?toast=1`, path.join(site.root, `profile-${width}`), {
      width,
      height,
    });
    try {
      const probe = (call) => browser.cdp.eval(`window.probe.${call}`);
      const settle = async () => {
        await probe("frames(3)");
        await sleep(250);
      };
      const atRest = await until("the new-card toast", () => probe("toast()"));
      const shellTop = await probe("shellTop()");
      assert.equal(Math.round(atRest.y - shellTop), 12, `${width}x${height}: toast at rest`);
      assert.equal(await probe("toolbar()"), null, "the Draw toolbar is hidden until Draw");

      await probe("draw()");
      await settle();
      const toolbar = await probe("toolbar()");
      const toast = await probe("toast()");
      assert.ok(toolbar && toast, `${width}x${height}: both shown`);
      const intersect =
        toast.x < toolbar.x + toolbar.w &&
        toast.x + toast.w > toolbar.x &&
        toast.y < toolbar.y + toolbar.h &&
        toast.y + toast.h > toolbar.y;
      assert.equal(
        intersect,
        false,
        `${width}x${height}: toast ${JSON.stringify(toast)} on toolbar ${JSON.stringify(toolbar)}`,
      );
      assert.equal(Math.round(toast.y - (toolbar.y + toolbar.h)), 8, `${width}x${height}: 8px below the toolbar`);

      await probe("draw()");
      await settle();
      assert.equal(await probe("toolbar()"), null);
      assert.equal(Math.round((await probe("toast()")).y - shellTop), 12, `${width}x${height}: back at rest`);
    } finally {
      browser.close();
    }
  }
});
