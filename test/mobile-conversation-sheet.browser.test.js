import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The phone-width comments surface, measured in a real browser. A side-by-side margin leaves
// neither half usable on a phone, so the comments become a bottom sheet over the artifact, and
// these assertions are the geometry an end user would notice: nothing clipped, Send and the page
// comment box inside the viewport, the artifact never under the dock, and the desktop margin
// untouched.
const runBrowserE2e = process.env.HILIGHT_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, env, timeout = 45_000) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout || ""}${result.stderr || ""}`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

const ARTIFACT = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sheet fixture</title>
<style>body{margin:0;padding:24px;font-family:Georgia,serif;background:#fffbf3;color:#17130a}h1{margin:0 0 12px}section{border:1px solid #e8e1cf;border-radius:12px;padding:16px;margin:16px 0;background:#fff}</style>
</head><body>
<h1>Checkout redesign</h1>
<section><h2>Step 1</h2><p>Autofill the address from the browser profile.</p></section>
<section><h2>Step 2</h2><p>Card, Apple Pay, and Link.</p></section>
<section><h2>Step 3</h2><p>Review the order before paying.</p></section>
<section><h2>Open questions</h2><p>Do we keep guest checkout?</p></section>
</body></html>`;

// Enough replies to make the page thread taller than any phone's sheet can show at once.
const REPLIES = [
  "Here is the first draft of the checkout redesign plan. I collapsed the three steps into one page.",
  "I also added an open-questions card at the bottom. Let me know whether guest checkout stays in scope.",
  "Updated the review table with real line items so the totals read correctly.",
  "The payment step now uses hosted fields so PCI scope stays small.",
  "Address lookup falls back to manual entry when the postcode service is down.",
  "Guest checkout stays, but it now asks for an email before the payment step.",
  "The order summary sticks to the top of the screen on small phones.",
  "Promo codes moved into the summary so they no longer interrupt payment.",
  "Saved cards show the last four digits and the expiry month.",
  "Errors now appear next to the field that caused them instead of at the top.",
];

const GEOMETRY = `() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height) }; };
  const body = document.getElementById("commentsBody");
  const comments = document.getElementById("comments");
  return JSON.stringify({
    viewport: { width: innerWidth, height: innerHeight },
    open: document.body.classList.contains("sheet-open"),
    commentsPosition: getComputedStyle(comments).position,
    comments: rect(comments),
    head: rect(document.getElementById("sheetHead")),
    frame: rect(document.getElementById("artifact")),
    body: { visible: body.clientHeight, content: body.scrollHeight, inert: body.inert },
    messages: {
      visible: document.getElementById("pageMessages").clientHeight,
      content: document.getElementById("pageMessages").scrollHeight,
    },
    attachments: {
      visible: document.getElementById("chatAttachments").clientHeight,
      content: document.getElementById("chatAttachments").scrollHeight,
    },
    foot: rect(document.getElementById("commentsFoot")),
    send: rect(document.getElementById("send")),
    textarea: rect(document.getElementById("chatInput")),
    pageOpen: document.getElementById("pageThread").classList.contains("is-open"),
    summary: document.getElementById("sheetSummary").textContent,
    toggleLabel: document.getElementById("sheetToggle").getAttribute("aria-label"),
    documentScrollable: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
  });
}`;

test(
  "the comments are a dock and bottom sheet on a phone, and a margin on desktop",
  { skip: !runBrowserE2e, timeout: 300_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-mobile-sheet-"));
    const port = await freePort();
    const lavishEnv = {
      HILIGHT_PORT: String(port),
      HILIGHT_STATE_DIR: path.join(temp, "state"),
      HILIGHT_NO_OPEN: "1",
      HILIGHT_TELEMETRY: "0",
      HILIGHT_HOST: "127.0.0.1",
      HILIGHT_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-mobile-sheet-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    function evaluate(expression) {
      const output = run("chrome-devtools-axi", ["eval", expression], chromeEnv);
      const raw = output.match(/result:\s*("(?:[^"\\]|\\.)*")/s)?.[1];
      assert.ok(raw, output);
      let value = JSON.parse(raw);
      while (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          break;
        }
      }
      return value;
    }
    // An in-page timer: `chrome-devtools-axi wait <ms>` fails with "fn is not a function" in 0.1.34.
    function wait(ms) {
      run(
        "chrome-devtools-axi",
        ["eval", `async()=>{await new Promise(r=>setTimeout(r,${ms}));return true}`],
        chromeEnv,
        ms + 45_000,
      );
    }
    function emulate(viewport) {
      run("chrome-devtools-axi", ["emulate", "--viewport", viewport], chromeEnv);
    }
    function open(url, settleMs = 4000) {
      run("chrome-devtools-axi", ["open", url], chromeEnv);
      wait(settleMs);
    }
    function geometry() {
      return evaluate(GEOMETRY);
    }
    function openPageThread() {
      evaluate(
        '() => { const page = document.getElementById("pageThread"); if (!page.classList.contains("is-open")) page.click(); return "ok"; }',
      );
      wait(500);
    }

    // Everything the user can reach in the sheet sits inside the viewport, and the threads scroll
    // inside the sheet rather than being cut off by it.
    function assertSheetUsable(g) {
      assert.equal(g.open, true);
      assert.equal(g.commentsPosition, "fixed");
      assert.ok(g.comments.top >= 48, `sheet clears the bar: ${JSON.stringify(g.comments)}`);
      assert.equal(g.comments.bottom, g.viewport.height, "sheet reaches the bottom edge");
      assert.equal(g.foot.bottom, g.viewport.height, "the send foot ends at the viewport edge");
      // The page comment box shows once its thread is open; Send is always reachable.
      for (const [name, r] of [["send", g.send], ...(g.pageOpen ? [["textarea", g.textarea]] : [])]) {
        assert.ok(
          r.top >= g.comments.top && r.bottom <= g.viewport.height,
          `${name} is inside the viewport: ${JSON.stringify(r)}`,
        );
        assert.ok(r.left >= 0 && r.right <= g.viewport.width, `${name} is inside the viewport: ${JSON.stringify(r)}`);
      }
      assert.ok(g.body.visible >= 120, `the thread list keeps real height: ${JSON.stringify(g.body)}`);
      // A closed thread folds its middle replies, and an open one scrolls its own message list, so
      // the fixture overflows once the page thread is open, inside the sheet rather than past it.
      if (g.pageOpen) {
        assert.ok(
          g.body.content > g.body.visible || g.messages.content > g.messages.visible,
          `fixture threads are taller than the viewport, so they must scroll: ${JSON.stringify({ body: g.body, messages: g.messages })}`,
        );
      }
      assert.equal(g.body.inert, false);
      assert.equal(g.documentScrollable, false, "the page itself never scrolls");
    }

    function populateComposer() {
      evaluate(`() => {
        document.getElementById("chatAttachments").innerHTML = ${JSON.stringify(
          Array.from(
            { length: 4 },
            (_, index) =>
              `<div class="chat-attachment-chip"><span class="chat-attachment-thumb"></span><span class="chat-attachment-copy"><strong>Screenshot ${index + 1}</strong><span class="chat-attachment-status">Ready</span></span><button type="button">Remove</button></div>`,
          ).join(""),
        )};
        document.getElementById("commentsBody").scrollTop = 0;
        return "ok";
      }`);
      wait(300);
    }

    // With attachments in the page comment box, the thread list scrolls and Send stays pinned.
    function assertPopulatedComposerUsable(g) {
      assert.equal(g.open, true);
      assert.ok(g.body.visible >= 56, `the thread list retains usable height: ${JSON.stringify(g.body)}`);
      for (const [name, rect] of [
        ["foot", g.foot],
        ["send", g.send],
      ]) {
        assert.ok(
          rect.top >= g.comments.top && rect.bottom <= g.viewport.height,
          `${name} stays visible: ${JSON.stringify(rect)}`,
        );
      }
      assert.ok(
        g.body.content > g.body.visible ||
          g.messages.content > g.messages.visible ||
          g.attachments.content > g.attachments.visible,
        `the populated sheet contains its overflow: ${JSON.stringify({ body: g.body, messages: g.messages, attachments: g.attachments })}`,
      );
      assert.equal(g.documentScrollable, false);
    }

    function assertDocked(g) {
      assert.equal(g.open, false);
      assert.equal(g.commentsPosition, "fixed");
      assert.equal(g.head.bottom, g.viewport.height, "dock sits on the bottom edge");
      assert.ok(g.head.height >= 56, `dock is a touch-sized target: ${JSON.stringify(g.head)}`);
      assert.ok(
        g.frame.bottom <= g.head.top,
        `artifact never runs under the dock: ${JSON.stringify({ frame: g.frame, head: g.head })}`,
      );
      assert.ok(
        g.frame.height >= g.viewport.height * 0.7,
        `artifact owns the screen while docked: ${JSON.stringify(g.frame)}`,
      );
      assert.equal(g.body.inert, true, "the hidden part of the sheet is unreachable");
      assert.equal(g.toggleLabel, "Show comments");
      assert.equal(g.documentScrollable, false, "the page itself never scrolls");
    }

    try {
      const artifact = path.join(temp, "review.html");
      await writeFile(artifact, ARTIFACT);
      const output = run(process.execPath, ["bin/hilight.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);
      for (const reply of REPLIES) {
        run(
          process.execPath,
          ["bin/hilight.js", "poll", artifact, "--agent-reply", reply, "--timeout-ms", "200"],
          lavishEnv,
          30_000,
        );
      }

      // ---- Portrait phone ----
      // chrome-devtools-axi 0.1.34 refuses `emulate` until a page is selected.
      run("chrome-devtools-axi", ["open", "data:text/html,"], chromeEnv);
      emulate("390x844x3,mobile,touch");
      open(url);
      let g = geometry();
      assertDocked(g);
      // "since <time>" follows once a poll has come and gone; this page has seen none or one.
      assert.match(g.summary, /^Agent not listening( since .+)?$/);

      evaluate('() => { document.getElementById("sheetHead").click(); return "ok"; }');
      wait(500);
      assertSheetUsable(geometry());
      openPageThread();
      g = geometry();
      assert.equal(g.pageOpen, true, "tapping the page thread opens its comment box");
      assertSheetUsable(g);

      // The scrim lowers it again and the artifact is back to full height.
      evaluate('() => { document.getElementById("sheetScrim").click(); return "ok"; }');
      wait(500);
      assertDocked(geometry());

      // ---- Short phone (small-height case) ----
      emulate("375x548x2,mobile,touch");
      open(url);
      g = geometry();
      assertDocked(g);
      evaluate('() => { document.getElementById("sheetToggle").click(); return "ok"; }');
      wait(500);
      assertSheetUsable(geometry());
      openPageThread();
      assertSheetUsable(geometry());

      // The open sheet survives a chrome reload on the same tab.
      open(url, 3000);
      assertSheetUsable(geometry());
      openPageThread();
      populateComposer();
      g = geometry();
      assertPopulatedComposerUsable(g);
      assert.ok(g.body.visible >= 56, `normal visual viewport retains the list minimum: ${JSON.stringify(g.body)}`);

      evaluate(`() => {
        document.documentElement.style.setProperty("--vv-top", "0px");
        document.documentElement.style.setProperty("--vv-height", "240px");
        return "ok";
      }`);
      wait(300);
      g = geometry();
      assert.equal(g.comments.bottom, 240);
      assert.equal(g.foot.bottom, 240);
      assert.ok(g.body.visible >= 0);
      for (const [name, rect] of [
        ["foot", g.foot],
        ["send", g.send],
      ]) {
        assert.ok(
          rect.top >= 0 && rect.bottom <= 240,
          `${name} stays inside the short visual viewport: ${JSON.stringify(rect)}`,
        );
      }
      evaluate(`() => {
        document.documentElement.style.removeProperty("--vv-top");
        document.documentElement.style.removeProperty("--vv-height");
        return "ok";
      }`);
      wait(300);

      emulate("844x390x1,mobile,touch");
      open(url, 3000);
      openPageThread();
      populateComposer();
      g = geometry();
      assert.equal(g.comments.bottom, g.viewport.height);
      assertPopulatedComposerUsable(g);

      // ---- Desktop: a comments margin, never a sheet ----
      emulate("1440x1000x1");
      open(url, 3000);
      g = geometry();
      assert.equal(g.open, false);
      assert.notEqual(g.commentsPosition, "fixed");
      assert.equal(g.comments.top, 48);
      assert.equal(g.comments.bottom, g.viewport.height);
      assert.equal(g.comments.right - g.comments.left, 320, "the desktop margin keeps its width");
      assert.equal(g.body.inert, false);
      assert.equal(g.frame.right, g.comments.left, "artifact and margin sit side by side");
    } finally {
      run(process.execPath, ["bin/hilight.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
