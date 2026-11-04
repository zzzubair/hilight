import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Real-browser regressions for the review loop: each subtest reproduces one bug from the
// 3 November 2026 desktop bug hunt in Chrome and asserts the repaired behavior. They share one
// server and one browser, and each uses its own artifact file, so its own session.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runBrowserE2e = process.env.HILIGHT_BROWSER_E2E === "1";

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

// The page drives itself on request: the artifact frame is sandboxed into an opaque origin, so the
// test reaches inside it only through this message probe, the way the reviewer's clicks would.
const PROBE = `<script>window.addEventListener('message',async event=>{
if(event.source!==parent||!event.data||event.data.type!=='review-probe')return;
const {id,action,selector,text,start,end}=event.data;const $=s=>document.querySelector(s);
const root=()=>$('[data-lavish-ui="annotation-root"]')?.shadowRoot;
const textarea=()=>root()?.querySelector('.lavish-annotation-card textarea');
if(action==='click')$(selector).dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
if(action==='select'){const node=$(selector).firstChild,range=document.createRange();range.setStart(node,start);range.setEnd(node,end);
getSelection().removeAllRanges();getSelection().addRange(range);$(selector).dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));}
if(action==='type'){const t=textarea();t.value=text;t.dispatchEvent(new Event('input',{bubbles:true}));}
if(action==='queue')textarea().dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
if(action==='summary')$(selector+' summary').click();
await new Promise(r=>setTimeout(r,250));
const card=root()?.querySelector('.lavish-annotation-card');
parent.postMessage({type:'review-probe-result',id,title:document.title,
card:card?{text:textarea()?.value||'',heading:card.querySelector('.lavish-heading')?.textContent||''}:null,
detailsOpen:$('#details')?$('#details').open:null},'*');});</script>`;

function fixture(revision = 0, { clipped = false } = {}) {
  const sections = Array.from(
    { length: 12 },
    (_, i) =>
      `<section id="section-${i + 1}"><h2>Section ${i + 1}</h2><p id="paragraph-${i + 1}">Review paragraph ${i + 1}. The deployment decision needs a clear explanation.</p><div><div><div><div><div class="repeat">Repeated target ${i + 1}</div></div></div></div></div></section>`,
  ).join("");
  const clip = clipped ? "overflow:hidden;white-space:nowrap" : "overflow-wrap:anywhere";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Review r${revision}</title><style>body{font:18px/1.6 system-ui;background:#fff;color:#182033;margin:0 auto;max-width:850px;padding:32px}section{padding:28px 0;border-bottom:1px solid #ddd;min-height:300px}.repeat{padding:20px;background:#e9edf4}.clipped{width:220px;${clip};border:1px solid #ccc;padding:8px}details{padding:20px;border:1px solid #ccc}</style></head><body><h1 id="title">Forge review board</h1><p id="intro">This introduction has enough words to select a specific phrase and ask the agent a question about it.</p><div class="clipped">ThisIsASingleUnbreakableTokenThatIsFarWiderThanItsContainerAndGetsClippedEntirely</div><details id="details"><summary>Supporting detail</summary><p>Keep this expanded while the agent answers.</p></details><main>${sections}</main>${PROBE}</body></html>`;
}

test("review loop regressions from the desktop bug hunt", { skip: !runBrowserE2e, timeout: 600_000 }, async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "lavish-review-flow-e2e-"));
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
    CHROME_DEVTOOLS_AXI_SESSION: `lavish-review-flow-${process.pid}`,
    CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
  };
  const evidence = process.env.HILIGHT_REVIEW_FLOW_EVIDENCE;
  const browser = (...args) => run("chrome-devtools-axi", args, chromeEnv);
  const cli = (...args) => run(process.execPath, ["bin/hilight.js", ...args], lavishEnv);
  function evaluate(expression) {
    const output = browser("eval", expression);
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
  const page = (body) => evaluate(`async()=>JSON.stringify(await (async()=>{${body}})())`);
  const wait = (ms) => page(`await new Promise(r=>setTimeout(r,${ms}));return true`);
  // Polls a page-side condition (a JS expression) until it is truthy, then returns its value.
  function until(expression, timeoutMs = 15_000) {
    const value =
      page(`const end=Date.now()+${timeoutMs};while(Date.now()<end){try{const v=await (async()=>(${expression}))();if(v)return v;}catch{}
        await new Promise(r=>setTimeout(r,150));}return null`);
    assert.ok(value, `timed out waiting for ${expression}`);
    return value;
  }
  function probe(action = "", extra = {}) {
    return page(`const f=document.getElementById('artifact'),id=Math.random().toString(36);
        return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('probe timeout')),10000);
        function h(e){if(e.source!==f.contentWindow||e.data.type!=='review-probe-result'||e.data.id!==id)return;clearTimeout(timer);window.removeEventListener('message',h);resolve(e.data);}
        window.addEventListener('message',h);f.contentWindow.postMessage({...${JSON.stringify(extra)},type:'review-probe',id,action:${JSON.stringify(action)}},'*');})`);
  }
  // Waits until the artifact frame reports the given document title, i.e. a save has loaded.
  function untilRevision(revision) {
    until(`document.getElementById('artifact')&&!document.body.classList.contains('layout-gate-active')`);
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      try {
        if (probe().title === `Review r${revision}`) return;
      } catch {
        // The frame is mid-navigation; ask again.
      }
      wait(250);
    }
    assert.fail(`the artifact never loaded revision ${revision}`);
  }
  function screenshot(name) {
    if (evidence) browser("screenshot", path.join(evidence, name));
  }
  let artifactCount = 0;
  async function openReview(options = {}) {
    artifactCount += 1;
    const artifact = path.join(temp, `review-${artifactCount}.html`);
    await writeFile(artifact, fixture(0, options));
    const url = cli(artifact, "--no-open").match(/url:\s*"([^"]+)"/)?.[1];
    assert.ok(url);
    browser("open", url);
    if (artifactCount === 1) browser("emulate", "--viewport", "1440x1000x1");
    untilRevision(0);
    const key = new URL(url).pathname.split("/").pop();
    return { artifact, url, key, save: (revision, opts = options) => writeFile(artifact, fixture(revision, opts)) };
  }

  try {
    if (evidence) await mkdir(evidence, { recursive: true });

    await t.test("1: a resolved layout note in the queue never blocks an unrelated question", async () => {
      const review = await openReview({ clipped: true });
      until(
        `(async()=>{const r=await fetch('/api/${review.key}/layout-warnings').then(r=>r.json());return r.warnings.length>0})()`,
      );
      page(`document.getElementById('warningsButton').click();return true`);
      until(`document.querySelector('.warning-select')`);
      page(
        `document.querySelector('.warning-select').click();document.getElementById('warningsQueueButton').click();return true`,
      );
      until(`document.querySelectorAll('#pageMessages .thread-message.is-draft').length===1`);

      await review.save(1, { clipped: false });
      untilRevision(1);
      until(
        `(async()=>{const r=await fetch('/api/${review.key}/layout-warnings').then(r=>r.json());return r.warnings.every(w=>w.status==='resolved')})()`,
        20_000,
      );
      page(`const input=document.getElementById('chatInput');input.value='This ordinary question should still be sent.';
          input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('send').click();return true`);
      until(`document.querySelectorAll('#pageMessages .thread-message.is-draft').length===0`);
      const hint = page(`return document.getElementById('sendHint').textContent`);
      assert.match(hint, /already fixed/);
      screenshot("01-stale-layout-note-retired.png");

      const poll = cli("poll", review.artifact, "--timeout-ms", "500");
      assert.match(poll, /status: feedback/);
      assert.match(poll, /This ordinary question should still be sent\./);
      assert.doesNotMatch(poll, /layout-warnings/);
    });

    await t.test("2: clicking a second repeated block opens its own annotation", async () => {
      await openReview();
      page(
        `if(document.getElementById('annotation').getAttribute('aria-pressed')!=='true')document.getElementById('annotation').click();return true`,
      );
      probe("click", { selector: "#section-1 .repeat" });
      probe("type", { text: "Question for repeated target ONE" });
      probe("queue");
      until(`document.querySelectorAll('#marginThreadCanvas .comment-thread.is-pending').length===1`);

      const second = probe("click", { selector: "#section-2 .repeat" });
      assert.ok(second.card, "section 2 gets its own annotation card");
      assert.equal(second.card.text, "");
      assert.equal(page(`return document.querySelectorAll('.thread-edit-input').length`), 0, "no draft editor opens");
      screenshot("02-second-repeated-block-own-card.png");
      const queued = page(
        `return JSON.parse(sessionStorage.getItem([...Object.keys(sessionStorage)].find(k=>k.startsWith('lavish-axi:queued:'))))`,
      );
      assert.match(queued[0].selector, /section#section-1/);
    });

    await t.test("3: an agent save keeps an unsent text-selection annotation", async () => {
      const review = await openReview();
      probe("select", { selector: "#intro", start: 5, end: 37 });
      probe("type", { text: "UNSENT TEXT SELECTION: Why is this required?" });
      wait(400);
      await review.save(1);
      untilRevision(1);
      const restored = probe();
      assert.ok(restored.card, "the text card comes back after the save");
      assert.equal(restored.card.text, "UNSENT TEXT SELECTION: Why is this required?");
      assert.match(restored.card.heading, /Annotate text/);
      screenshot("03-text-draft-after-save.png");
    });

    await t.test("4: a save keeps a disclosure the reviewer expanded", async () => {
      const review = await openReview();
      assert.equal(probe("summary", { selector: "#details" }).detailsOpen, true);
      wait(400);
      await review.save(1);
      untilRevision(1);
      assert.equal(probe().detailsOpen, true);
      screenshot("06-disclosure-after-save.png");
    });

    await t.test("5: saves do not grow the tab's history", async () => {
      const review = await openReview();
      const before = page(`return history.length`);
      for (let revision = 1; revision <= 3; revision += 1) {
        await review.save(revision);
        untilRevision(revision);
      }
      assert.equal(page(`return history.length`), before);
    });
  } finally {
    run(process.execPath, ["bin/hilight.js", "stop", "--port", String(port)], lavishEnv, 15000);
    browser("stop");
    await rm(temp, { recursive: true, force: true });
  }
});
