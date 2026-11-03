import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";

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

const ARTIFACT = `<!doctype html><html data-lavish-annotate="off"><head><meta charset="utf-8"><title>Reviewing the launch plan</title>
<style>body{margin:60px auto;max-width:650px;padding:0 36px;font:18px/1.7 Georgia;color:#292820;background:#fcfaf4}h1{font-size:36px;line-height:1.2}h2{font-size:25px}p{margin:20px 0}.space{height:1100px}</style>
<script type="application/json" data-lavish-revisions>[{"id":"r1","label":"Clarified the rollout"}]</script></head>
<body><h1>A quieter launch</h1><p>A proposal for rolling out the new workspace.</p><h2>Start with a small group</h2>
<p id="alpha">Invite ten teams first. Give them a full week to use the workspace before opening it to everyone.</p>
<p id="beta">Collect feedback in one place, with an owner for each question and a clear next step.</p>
<div class="space"></div><p id="changed" data-lavish-revision="r1">The revised rollout starts with ten teams and a named owner.</p><div class="space"></div>
<script>window.addEventListener('message',event=>{if(event.source!==parent||event.data.type!=='thread-probe')return;
const {id,action}=event.data;
if(action==='queue'){
window.lavish.queuePrompt('Why ten teams? What would we learn?',{element:document.getElementById('alpha')});
window.lavish.queuePrompt('Who owns the feedback?',{element:document.getElementById('beta')});
}
if(action==='hover')document.getElementById('alpha').dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:document.getElementById('alpha').getBoundingClientRect().left+5,clientY:document.getElementById('alpha').getBoundingClientRect().top+5}));
if(action==='scroll')window.scrollTo(0,120);
if(action==='annotate')document.querySelector('h2').dispatchEvent(new MouseEvent('click',{bubbles:true}));
if(action==='select'){
 const node=document.getElementById('beta').firstChild,range=document.createRange();range.setStart(node,0);range.setEnd(node,16);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
}
if(action==='popup-send'){
 const input=document.querySelector('[data-lavish-ui="annotation-root"]').shadowRoot.querySelector('textarea');input.value='Explain this part';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));window.getSelection()?.removeAllRanges();
}
setTimeout(()=>{const root=document.querySelector('[data-lavish-ui="annotation-root"]')?.shadowRoot;
const marks=[...(root?.querySelectorAll('.lavish-thread-highlight')||[])];const el=document.getElementById('alpha');const rect=el.getBoundingClientRect();
parent.postMessage({type:'thread-probe-result',id,top:rect.top,highlights:marks.length,active:marks.filter(m=>m.classList.contains('is-active')).length,reveal:root?.querySelectorAll('.lavish-reveal-marker').length||0,popupFocused:root?.querySelector('textarea')===root?.activeElement,popup:!!root?.querySelector('.lavish-annotation-card'),selectedMarkWidth:marks.at(-1)?.getBoundingClientRect().width,betaWidth:document.getElementById('beta').getBoundingClientRect().width,changedVisible:document.getElementById('changed').getBoundingClientRect().top>=0&&document.getElementById('changed').getBoundingClientRect().bottom<=innerHeight},'*');},500);
});</script></body></html>`;

test(
  "margin threads align, glow, reply, resolve/reopen, persist and reveal per-thread revisions",
  { skip: !runBrowserE2e, timeout: 240000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-threads-e2e-"));
    const port = await freePort();
    const lavishEnv = {
      LAVISH_AXI_PORT: String(port),
      LAVISH_AXI_STATE_DIR: path.join(temp, "state"),
      LAVISH_AXI_NO_OPEN: "1",
      LAVISH_AXI_TELEMETRY: "0",
      LAVISH_AXI_HOST: "127.0.0.1",
      LAVISH_AXI_LINK_HOST: "127.0.0.1",
    };
    const chromeEnv = {
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-threads-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };
    const browser = (...args) => run("chrome-devtools-axi", args, chromeEnv);
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
    const wait = () => evaluate(`async()=>{await new Promise(r=>setTimeout(r,1500));return JSON.stringify(true)}`);
    function probe(action = "") {
      return evaluate(
        `async()=>{const f=document.getElementById('artifact'),id=Math.random().toString(36);const p=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('probe timeout')),10000);function h(e){if(e.source!==f.contentWindow||e.data.type!=='thread-probe-result'||e.data.id!==id)return;clearTimeout(timer);window.removeEventListener('message',h);resolve(e.data);}window.addEventListener('message',h);});f.contentWindow.postMessage({type:'thread-probe',id,action:${JSON.stringify(action)}},'*');return JSON.stringify(await p)}`,
      );
    }
    function screenshot(name) {
      browser("screenshot", path.join(repoRoot, "task-evidence", name));
    }
    try {
      const artifact = path.join(temp, "review.html");
      await writeFile(artifact, ARTIFACT);
      await mkdir(path.join(repoRoot, "task-evidence"), { recursive: true });
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);
      browser("open", url);
      browser("emulate", "--viewport", "1600x1000x1");
      wait();
      probe("queue");
      wait();
      if (process.env.LAVISH_AXI_THREADS_BEFORE === "1") {
        screenshot("threads-before.png");
        return;
      }
      assert.equal(
        evaluate(`()=>JSON.stringify(document.querySelectorAll('#marginThreads .comment-thread').length)`),
        2,
      );
      evaluate(`()=>{document.getElementById('send').click();return JSON.stringify(true)}`);
      wait();
      const ids = evaluate(
        `()=>JSON.stringify([...document.querySelectorAll('#marginThreads .comment-thread')].map(n=>n.dataset.threadId))`,
      );
      assert.equal(ids.length, 2);
      let geometry = evaluate(
        `()=>JSON.stringify([...document.querySelectorAll('#marginThreads .comment-thread')].map(n=>{const r=n.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left}}))`,
      );
      const anchor = probe();
      const frameTop = evaluate(`()=>JSON.stringify(document.getElementById('artifact').getBoundingClientRect().top)`);
      assert.ok(Math.abs(geometry[0].top - frameTop - anchor.top) < 3, JSON.stringify({ geometry, anchor, frameTop }));
      assert.ok(geometry[1].top >= geometry[0].bottom + 8);
      assert.equal(anchor.highlights, 2);
      evaluate(
        `()=>{document.querySelector('#marginThreads .comment-thread').dispatchEvent(new MouseEvent('mouseenter'));return JSON.stringify(true)}`,
      );
      assert.equal(probe().active, 1);
      evaluate(
        `()=>{document.querySelector('#marginThreads .comment-thread').dispatchEvent(new MouseEvent('mouseleave'));return JSON.stringify(true)}`,
      );
      probe("hover");
      assert.equal(
        evaluate(
          `()=>JSON.stringify(document.querySelector('#marginThreads .comment-thread').classList.contains('is-active'))`,
        ),
        true,
      );
      evaluate(`()=>{document.querySelector('#marginThreads textarea').focus();return JSON.stringify(true)}`);
      assert.equal(probe().active, 1);
      evaluate(
        `()=>{const input=document.querySelector('#marginThreads textarea');input.value='Can you explain the tradeoff?';input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return JSON.stringify(true)}`,
      );
      wait();
      assert.match(
        evaluate(`()=>JSON.stringify(document.querySelector('#marginThreads .thread-messages').textContent)`),
        /tradeoff/,
      );
      const poll = run(process.execPath, ["bin/lavish-axi.js", "poll", artifact, "--timeout-ms", "100"], lavishEnv);
      assert.match(poll, /thread_id/);
      assert.match(poll, /tradeoff/);
      run(
        process.execPath,
        [
          "bin/lavish-axi.js",
          "reply",
          artifact,
          "--thread",
          ids[0],
          "--revision",
          "r1",
          "--agent-reply",
          "Ten teams gives us enough variety. I clarified the rollout below.",
        ],
        lavishEnv,
      );
      wait();
      assert.match(
        evaluate(`()=>JSON.stringify(document.querySelector('#marginThreads .thread-messages').textContent)`),
        /enough variety/,
      );
      assert.equal(
        evaluate(`()=>JSON.stringify(document.querySelectorAll('#marginThreads .thread-reveal').length)`),
        1,
      );
      screenshot("threads-after.png");
      browser("emulate", "--color-scheme", "dark");
      screenshot("threads-dark.png");
      browser("emulate", "--color-scheme", "light");
      evaluate(`()=>{document.querySelector('#marginThreads .thread-reveal').click();return JSON.stringify(true)}`);
      const reveal = probe();
      assert.equal(reveal.reveal, 1);
      assert.equal(reveal.changedVisible, true);
      evaluate(`()=>{document.querySelector('#marginThreads .thread-resolve').click();return JSON.stringify(true)}`);
      wait();
      assert.equal(probe().highlights, 1);
      assert.equal(
        evaluate(`()=>JSON.stringify(document.querySelectorAll('#marginThreads .comment-thread').length)`),
        1,
      );
      assert.equal(evaluate(`()=>JSON.stringify(document.querySelectorAll('#threadList .thread-reopen').length)`), 1);
      browser("open", url);
      wait();
      assert.equal(evaluate(`()=>JSON.stringify(document.querySelectorAll('#threadList .thread-reopen').length)`), 1);
      evaluate(`()=>{document.querySelector('#threadList .thread-reopen').click();return JSON.stringify(true)}`);
      wait();
      assert.equal(probe().highlights, 2);
      // Saving a new page revision must not drop thread messages, resolution or drafts.
      evaluate(
        `()=>{const input=document.querySelector('#marginThreads textarea');input.value='Draft kept across revision';input.dispatchEvent(new Event('input',{bubbles:true}));return JSON.stringify(true)}`,
      );
      await writeFile(artifact, ARTIFACT.replace("A proposal for rolling out", "A revised proposal for rolling out"));
      wait();
      wait();
      assert.equal(
        evaluate(`()=>JSON.stringify(document.querySelector('#marginThreads textarea').value)`),
        "Draft kept across revision",
      );
      assert.match(
        evaluate(`()=>JSON.stringify(document.querySelector('#marginThreads .thread-messages').textContent)`),
        /enough variety/,
      );
      // The thread composer closes on Escape without losing its draft, and opens in one click.
      evaluate(
        `()=>{const input=document.querySelector('#marginThreads textarea');input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return JSON.stringify(true)}`,
      );
      assert.equal(
        evaluate(
          `()=>JSON.stringify(document.querySelector('#marginThreads .comment-thread').classList.contains('reply-closed'))`,
        ),
        true,
      );
      evaluate(`()=>{document.querySelector('#marginThreads .thread-anchor').click();return JSON.stringify(true)}`);
      assert.equal(
        evaluate(`()=>JSON.stringify(document.activeElement===document.querySelector('#marginThreads textarea'))`),
        true,
      );
      // Actual annotation popup: one element click focuses it, then Enter sends.
      evaluate(`()=>{document.getElementById('annotation').click();return JSON.stringify(true)}`);
      const popup = probe("annotate");
      assert.equal(popup.popupFocused, true);
      assert.equal(popup.popup, true);
      probe("popup-send");
      wait();
      const selected = probe("select");
      assert.equal(selected.popupFocused, true);
      probe("popup-send");
      wait();
      const selectedMark = probe();
      assert.ok(selectedMark.selectedMarkWidth < selectedMark.betaWidth / 2, JSON.stringify(selectedMark));
      assert.equal(
        evaluate(`()=>JSON.stringify(document.querySelectorAll('#marginThreads .comment-thread').length)`),
        4,
      );
      // The selection remains exact after reloading the same HTML; removed anchors are retained as missing.
      await writeFile(artifact, ARTIFACT.replace("A proposal for rolling out", "The final proposal for rolling out"));
      wait();
      wait();
      assert.equal(
        evaluate(`()=>JSON.stringify(document.querySelectorAll('#marginThreads .anchor-missing').length)`),
        0,
      );
      await writeFile(artifact, ARTIFACT.replace('id="beta"', 'id="beta-removed"'));
      wait();
      wait();
      assert.equal(
        evaluate(`()=>JSON.stringify(document.querySelectorAll('#marginThreads .anchor-missing').length)`),
        2,
      );
      await writeFile(artifact, ARTIFACT);
      wait();
      wait();
      browser("emulate", "--viewport", "390x844x1");
      wait();
      evaluate(
        `()=>{const details=document.querySelector('#threadList details');details.open=true;const toggle=document.getElementById('panelToggle');if(toggle.getAttribute('aria-expanded')!=='true')toggle.click();return JSON.stringify(true)}`,
      );
      wait();
      screenshot("threads-phone.png");
      assert.equal(evaluate(`()=>JSON.stringify(document.documentElement.scrollWidth<=innerWidth)`), true);
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15000);
      browser("stop");
      await rm(temp, { recursive: true, force: true });
    }
  },
);
