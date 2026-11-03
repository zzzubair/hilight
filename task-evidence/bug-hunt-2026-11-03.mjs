// Evidence runner only. It does not change application source or dependencies.
// PLAYWRIGHT_MODULE may point to an existing playwright-core/index.mjs installation.
const { chromium } = await import(
  pathToFileURL(process.env.PLAYWRIGHT_MODULE || "/tmp/lavish-bughunt-tools/node_modules/playwright-core/index.mjs")
    .href
);
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { serve } = await import(path.join(root, "src/server.js"));
const temp = await mkdtemp(path.join(tmpdir(), "lavish-bughunt-"));
const stateDir = path.join(temp, "state");
await mkdir(stateDir);
const env = {
  ...process.env,
  LAVISH_AXI_STATE_DIR: stateDir,
  LAVISH_AXI_HOST: "127.0.0.1",
  LAVISH_AXI_LINK_HOST: "127.0.0.1",
  LAVISH_AXI_NO_OPEN: "1",
  LAVISH_AXI_TELEMETRY: "0",
};
const server = await serve({
  port: 0,
  stateFile: path.join(stateDir, "state.json"),
  env,
  version: "0.1.96",
  host: "127.0.0.1",
  hosts: ["127.0.0.1"],
  detectTailscale: null,
});
env.LAVISH_AXI_PORT = String(server.port);
const base = "http://127.0.0.1:" + server.port;
const artifact = path.join(temp, "review.html");
function fixture(revision = 0) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Forge review test ${revision}</title><style>html{scroll-behavior:smooth}body{font:18px/1.6 system-ui;background:#fff;color:#182033;margin:0 auto;max-width:850px;padding:32px}section{padding:28px 0;border-bottom:1px solid #ddd;min-height:550px}p{max-width:70ch}.repeat{padding:20px;background:#e9edf4}.clipped{width:220px;overflow:hidden;white-space:nowrap;border:1px solid #ccc;padding:8px}button,input{font:inherit}details{padding:20px;border:1px solid #ccc}</style></head><body><h1 id="title">Forge review board</h1><p id="intro">This introduction has enough words to select a specific phrase and ask the agent a question about it.</p><form data-lavish-question="choice"><label>Your answer <input name="answer"></label><button type="button" data-lavish-action onclick="window.lavish.queuePrompt({prompt:this.form.answer.value,tag:'answer',text:'Choice answer'},{element:this})">Queue answer</button></form><div class="clipped">ThisIsASingleUnbreakableTokenThatIsFarWiderThanItsContainerAndGetsClippedEntirely</div><details id="details"><summary>Supporting detail</summary><p>Keep this expanded while the agent answers.</p></details><main>${Array.from({ length: 12 }, (_, i) => `<section id="section-${i + 1}"><h2>Section ${i + 1}</h2><p id="paragraph-${i + 1}">Review paragraph ${i + 1}. The deployment decision needs a clear explanation and another round of questions before we decide.</p><div><div><div><div><div class="repeat">Repeated target ${i + 1}</div></div></div></div></div>${revision && i === 8 ? '<p data-lavish-revision="r1" id="changed">Agent clarified the deployment answer.</p>' : ""}</section>`).join("")}</main>${revision ? '<script type="application/json" data-lavish-revisions>[{"id":"r1","label":"Answer round 1","timestamp":"2026-11-03T12:00:00Z","summary":"Clarified deployment decision"}]</script>' : ""}</body></html>`;
}
await writeFile(artifact, fixture());
const opened = await fetch(base + "/api/sessions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ file: artifact }),
}).then((r) => r.json());
const key = opened.key;
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/opt/google/chrome/chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(5000);
const errors = [];
const network = [];
const evidence = [];
function watch(p, label) {
  p.on("pageerror", (e) => errors.push({ label, error: e.message }));
  p.on("response", async (r) => {
    if (r.status() >= 400)
      network.push({ label, url: r.url(), status: r.status(), body: (await r.text().catch(() => "")).slice(0, 1500) });
  });
}
watch(page, "main");
await page.goto(base + "/session/" + key);
await page.waitForFunction(() => !document.body.classList.contains("layout-gate-active"), { timeout: 20000 });
function frame(p = page) {
  return p.frames().find((f) => f.url().includes("/artifact/"));
}
async function cli(args) {
  return await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(root, "dist/cli.mjs"), ...args], { env });
    let stdout = "",
      stderr = "";
    p.stdout.on("data", (b) => (stdout += b));
    p.stderr.on("data", (b) => (stderr += b));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
async function shot(name, p = page) {
  const file = path.join(root, "task-evidence", name + ".png");
  await mkdir(path.dirname(file), { recursive: true });
  await p.screenshot({ path: file });
  return file;
}
async function record(name, value) {
  evidence.push({ name, value });
  await writeFile(
    path.join(root, "task-evidence", "bug-hunt-2026-11-03.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(name);
  return value;
}
async function settled() {
  await page.waitForFunction(() => !document.body.classList.contains("layout-gate-active"));
  await page.waitForTimeout(300);
}
async function selectIntro() {
  await frame().locator("#intro").scrollIntoViewIfNeeded();
  await frame().evaluate(() => {
    const p = document.querySelector("#intro");
    const r = document.createRange();
    r.setStart(p.firstChild, 5);
    r.setEnd(p.firstChild, 37);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    p.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}
async function queueCard(text) {
  await frame().locator(".lavish-annotation-card textarea").fill(text);
  await frame().getByRole("button", { name: "Queue", exact: true }).click();
  await page.waitForTimeout(200);
}
async function regenerate(n, fixed = false) {
  await writeFile(
    artifact,
    fixed ? fixture(n).replace("overflow:hidden;white-space:nowrap", "overflow-wrap:anywhere") : fixture(n),
  );
  await page.waitForTimeout(3500);
  await settled();
}
try {
  await record("environment", {
    date: "2026-11-03",
    machine: "ser5ver",
    chrome: browser.version(),
    port: server.port,
    stateDir,
  });
  await frame().locator("#paragraph-1").click();
  await queueCard("Why does this deployment need a separate approval?");
  await frame().locator("#section-1 .repeat").click();
  await queueCard("Question for repeated target ONE");
  await frame().locator("#section-2 .repeat").click();
  await page.waitForTimeout(200);
  const collision = {
    card: await frame().locator(".lavish-annotation-card").count(),
    editor: await page.locator("#queuedLog textarea").inputValue(),
    queue: await page.locator("#queuedLog").innerText(),
    selectorMatches: await frame().locator("div > div > div > div > div").count(),
    screenshot: await shot("01-selector-collision"),
  };
  assert.equal(collision.card, 0);
  assert.equal(collision.editor, "Question for repeated target ONE");
  await record("selector-collision", collision);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await selectIntro();
  await queueCard("Can you explain this selected phrase first?");
  await page.locator("#chatInput").fill("Please answer the questions before changing anything.");
  await page.locator("#send").click();
  await page.waitForTimeout(300);
  const delivered = await cli(["poll", artifact, "--timeout-ms", "500"]);
  assert.match(delivered.stdout, /prompts\[4\]/);
  await record("four-notes-delivered", delivered);
  const reply = await cli([
    "poll",
    artifact,
    "--agent-reply",
    "The extra approval protects the production rollout. Ask another question before deciding; I have not edited the artifact.",
    "--timeout-ms",
    "500",
  ]);
  assert.equal(reply.code, 0);
  await record("agent-reply", reply);

  const composerText = "UNSENT COMPOSER: Explain the risk before I decide.";
  await page.locator("#chatInput").fill(composerText);
  await page.waitForTimeout(300);
  await shot("02-composer-before-reload");
  await page.reload();
  await settled();
  const composer = {
    before: composerText,
    after: await page.locator("#chatInput").inputValue(),
    queue: await page.locator("#queuedLog").innerText(),
    screenshot: await shot("03-composer-after-reload"),
  };
  assert.equal(composer.after, "");
  assert.equal(composer.queue, "");
  await record("composer-lost-on-reload", composer);

  await selectIntro();
  const textDraft = "UNSENT TEXT SELECTION: Why is this required?";
  await frame().locator(".lavish-annotation-card textarea").fill(textDraft);
  await page.waitForTimeout(400);
  await shot("04-text-draft-before-save");
  await regenerate(1);
  const textLost = {
    before: textDraft,
    afterCards: await frame().locator(".lavish-annotation-card").count(),
    chromeText: await page.locator("body").innerText(),
    storage: await page.evaluate(() =>
      Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage[k]])),
    ),
    screenshot: await shot("05-text-draft-after-save"),
  };
  assert.equal(textLost.afterCards, 0);
  assert.ok(!JSON.stringify(textLost.storage).includes(textDraft));
  assert.ok(!textLost.chromeText.includes(textDraft));
  await record("text-draft-lost-on-save", textLost);

  await page.locator("#revisionsButton").click();
  assert.match(await page.locator("#revisionsDrawer").innerText(), /1 revision · 1 marked block/);
  await page.locator(".revision-reveal").click();
  await page.waitForTimeout(1200);
  await record("revisions-reveal", {
    scrollY: await frame().evaluate(() => scrollY),
    targetTop: await frame()
      .locator("#changed")
      .evaluate((e) => e.getBoundingClientRect().top),
  });
  await page.locator("#warningsButton").click();
  await shot("06-layout-issues");
  await page.locator(".warning-select").first().check();
  await page.locator("#warningsQueueButton").click();
  await regenerate(2, true);
  await page.locator("#chatInput").fill("This ordinary question should still be sent.");
  await page.locator("#send").click();
  await page.waitForTimeout(300);
  const conflict = {
    hint: await page.locator("#sendHint").innerText(),
    queue: await page.locator("#queuedLog").innerText(),
    responses: network.slice(),
    screenshot: await shot("07-stale-warning-send"),
  };
  assert.match(conflict.hint, /layout issue selection changed/);
  assert.ok(conflict.queue.includes("This ordinary question"));
  await page.locator("#send").click();
  await page.waitForTimeout(200);
  const empty = await cli(["poll", artifact, "--timeout-ms", "300"]);
  assert.match(empty.stdout, /status: waiting/);
  await page.locator("#queuedLog .queued-remove").first().click();
  await page.locator("#send").click();
  await page.waitForTimeout(200);
  const freed = await cli(["poll", artifact, "--timeout-ms", "300"]);
  assert.match(freed.stdout, /status: feedback/);
  await record("stale-warning-blocks-whole-batch", {
    ...conflict,
    retry: empty.stdout,
    afterRemovingWarning: freed.stdout,
  });

  // Seed a long conversation through the same agent-reply endpoint the CLI uses.
  for (let i = 1; i <= 9; i++)
    await fetch(base + "/api/" + key + "/agent-reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text:
          "Answer " +
          i +
          "\n\n" +
          Array.from(
            { length: 3 },
            (_, j) =>
              "The deployment explanation, paragraph " +
              (j + 1) +
              ". " +
              "Review this rationale before deciding. ".repeat(9),
          ).join("\n\n"),
      }),
    });
  await page.waitForTimeout(300);
  await page.locator("#panelScroll").evaluate((e) => (e.scrollTop = 0));
  const beforeScroll = await page
    .locator("#panelScroll")
    .evaluate((e) => ({ top: e.scrollTop, height: e.scrollHeight, client: e.clientHeight }));
  await shot("08-transcript-reading-old-answer");
  await fetch(base + "/api/" + key + "/agent-reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "One more answer arrived while you were reading the first answer." }),
  });
  await page.waitForTimeout(300);
  const afterScroll = await page
    .locator("#panelScroll")
    .evaluate((e) => ({ top: e.scrollTop, height: e.scrollHeight, client: e.clientHeight }));
  assert.equal(beforeScroll.top, 0);
  assert.ok(afterScroll.top > 5000);
  await record("chat-scroll-jump", {
    before: beforeScroll,
    after: afterScroll,
    screenshot: await shot("09-transcript-forced-to-bottom"),
  });

  await frame().locator("#details summary").click();
  await frame().locator('input[name="answer"]').fill("Keep this choice");
  await frame().locator("#paragraph-8").click();
  await frame().locator(".lavish-annotation-card textarea").fill("UNSENT ELEMENT: keep this question while you save");
  await page.waitForTimeout(300);
  const beforeState = await frame().evaluate(() => ({
    scrollY,
    open: document.querySelector("#details").open,
    answer: document.querySelector("input").value,
  }));
  const historyBefore = await page.evaluate(() => history.length);
  await regenerate(3, true);
  const afterState = await frame().evaluate(() => ({
    scrollY,
    open: document.querySelector("#details").open,
    answer: document.querySelector("input").value,
    card: document.querySelector('[data-lavish-ui="annotation-root"]')?.shadowRoot?.querySelector("textarea")?.value,
  }));
  assert.equal(beforeState.open, true);
  assert.equal(afterState.open, false);
  assert.equal(afterState.answer, beforeState.answer);
  assert.equal(afterState.scrollY, beforeState.scrollY);
  assert.match(afterState.card, /UNSENT ELEMENT/);
  await record("live-reload-state", {
    before: beforeState,
    after: afterState,
    historyBefore,
    historyAfter: await page.evaluate(() => history.length),
    screenshot: await shot("10-element-draft-restored"),
  });

  await frame().getByRole("button", { name: "Queue", exact: true }).click();
  await page.waitForTimeout(200);
  const page2 = await context.newPage();
  watch(page2, "second");
  page2.setDefaultTimeout(5000);
  await page2.goto(base + "/session/" + key);
  await page2.waitForFunction(() => !document.body.classList.contains("layout-gate-active"));
  await regenerate(4, true);
  assert.equal(await page.locator("#handoffBanner").isVisible(), true);
  await shot("11-source-tab-superseded");
  await page.locator("#handoffTakeover").click();
  await settled();
  await page2.locator("#moreButton").click();
  await page2.locator("#reloadArtifact").click();
  await page2.waitForTimeout(300);
  const takeover = {
    sourceQueue: await page.locator("#queuedLog").innerText(),
    secondQueue: await page2.locator("#queuedLog").innerText(),
    secondSuperseded: await page2.locator("#handoffBanner").isVisible(),
    screenshot: await shot("12-source-takeover-restores-own-queue"),
  };
  assert.ok(takeover.sourceQueue.includes("UNSENT ELEMENT"));
  assert.equal(takeover.secondQueue, "");
  assert.equal(takeover.secondSuperseded, true);
  await record("two-tab-takeover", takeover);
  await page2.close();
  const warnings = [];
  page.on("console", (m) => {
    if (m.type() === "warning") warnings.push(m.text());
  });
  await page.evaluate(() => window.close());
  await page.waitForTimeout(300);
  assert.equal(page.isClosed(), false);
  assert.ok(warnings.some((s) => s.includes("Scripts may close only")));
  await record("history-prevents-script-close", {
    historyLength: await page.evaluate(() => history.length),
    closed: page.isClosed(),
    warnings,
  });
  await record("runtime", { errors, network });
  assert.deepEqual(errors, []);
  console.log("Completed isolated browser reproduction; all expected bug observations reproduced.");
} finally {
  await browser.close();
  await server.close();
}
