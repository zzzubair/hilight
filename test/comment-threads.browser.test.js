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
<p id="gamma">Ship the announcement once the first teams are happy.</p>
<div class="space"></div><p id="changed" data-lavish-revision="r1">The revised rollout starts with ten teams and a named owner.</p><div class="space"></div>
<script>window.addEventListener('message',event=>{if(event.source!==parent||event.data.type!=='thread-probe')return;
const {id,action}=event.data;const $=s=>document.querySelector(s);
if(action==='queue'){
window.lavish.queuePrompt('Why ten teams? What would we learn?',{element:$('#alpha')});
window.lavish.queuePrompt('Who owns the feedback?',{element:$('#beta')});
}
if(action==='hover'){const r=$('#alpha').getBoundingClientRect();$('#alpha').dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:r.left+5,clientY:r.top+5}));}
if(action==='unhover')document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:2,clientY:2}));
if(action==='scroll')window.scrollTo(0,120);
if(action==='top')window.scrollTo(0,0);
if(action==='click-alpha')$('#alpha').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
if(action==='annotate')$('#gamma').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
if(action==='select'){
 const node=$('#beta').firstChild,range=document.createRange();range.setStart(node,0);range.setEnd(node,16);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
}
if(action==='popup-send'){
 const input=$('[data-lavish-ui="annotation-root"]').shadowRoot.querySelector('textarea');input.value=event.data.text;input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));window.getSelection()?.removeAllRanges();
}
setTimeout(()=>{const root=$('[data-lavish-ui="annotation-root"]')?.shadowRoot;
const marks=[...(root?.querySelectorAll('.lavish-thread-highlight')||[])];const rect=id=>$(id)?.getBoundingClientRect();
const changed=rect('#changed');
parent.postMessage({type:'thread-probe-result',id,alphaTop:rect('#alpha').top,betaTop:rect('#beta')?.top,
highlights:marks.length,active:marks.filter(m=>m.classList.contains('is-active')).map(m=>m.dataset.threadId),
reveal:root?.querySelectorAll('.lavish-reveal-marker').length||0,popupFocused:!!root?.activeElement&&root.activeElement===root.querySelector('textarea'),
popup:!!root?.querySelector('.lavish-annotation-card'),textMarkWidth:marks.find(m=>!m.classList.contains('is-element'))?.getBoundingClientRect().width,
betaWidth:rect('#beta')?.width,changedVisible:changed.top>=0&&changed.bottom<=innerHeight},'*');},500);
});</script></body></html>`;

test(
  "margin threads: placement, hover glow, threaded replies, per-thread agent answers, Reveal, resolve and reopen",
  { skip: !runBrowserE2e, timeout: 300000 },
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
    const evidence = process.env.LAVISH_AXI_THREADS_EVIDENCE;
    const browser = (...args) => run("chrome-devtools-axi", args, chromeEnv);
    const cli = (...args) => run(process.execPath, ["bin/lavish-axi.js", ...args], lavishEnv);
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
    const page = (body) => evaluate(`()=>JSON.stringify((()=>{${body}})())`);
    const wait = (ms = 1200) =>
      evaluate(`async()=>{await new Promise(r=>setTimeout(r,${ms}));return JSON.stringify(true)}`);
    function probe(action = "", extra = {}) {
      return evaluate(
        `async()=>{const f=document.getElementById('artifact'),id=Math.random().toString(36);const p=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('probe timeout')),10000);function h(e){if(e.source!==f.contentWindow||e.data.type!=='thread-probe-result'||e.data.id!==id)return;clearTimeout(timer);window.removeEventListener('message',h);resolve(e.data);}window.addEventListener('message',h);});f.contentWindow.postMessage({...${JSON.stringify(extra)},type:'thread-probe',id,action:${JSON.stringify(action)}},'*');return JSON.stringify(await p)}`,
      );
    }
    const marginCards = () =>
      page(`const frame=document.getElementById('artifact').getBoundingClientRect().top;
        return [...document.querySelectorAll('#marginThreads .comment-thread')].map(n=>{const r=n.getBoundingClientRect();
        return {id:n.dataset.threadId,top:r.top-frame,bottom:r.bottom-frame,open:n.classList.contains('is-open'),active:n.classList.contains('is-active'),
        text:n.querySelector('.thread-messages').textContent,reveal:n.querySelectorAll('.thread-reveal').length}})`);
    const card = (id) =>
      `[...document.querySelectorAll('#marginThreads .comment-thread')].find(n=>n.dataset.threadId==='${id}')`;
    function screenshot(name) {
      if (evidence) browser("screenshot", path.join(evidence, name));
    }
    function assertNoOverlap(cards) {
      const sorted = [...cards].sort((a, b) => a.top - b.top);
      for (let i = 1; i < sorted.length; i++) {
        assert.ok(sorted[i].top >= sorted[i - 1].bottom + 8, `cards overlap: ${JSON.stringify(sorted)}`);
      }
    }
    try {
      if (evidence) await mkdir(evidence, { recursive: true });
      const artifact = path.join(temp, "review.html");
      await writeFile(artifact, ARTIFACT);
      const url = cli(artifact, "--no-open").match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url);
      browser("open", url);
      browser("emulate", "--viewport", "1600x1000x1");
      wait(2500);
      probe("queue");
      wait();
      assert.equal(marginCards().length, 2, "queued anchored notes show as pending margin cards");
      page(`document.getElementById('send').click();return true`);
      wait(1500);

      // Placement: each card sits beside its anchor; adjacent anchors stack without overlapping.
      let cards = marginCards();
      assert.deepEqual(
        cards.map((c) => c.id),
        ["c1", "c2"],
      );
      let anchor = probe();
      assert.ok(Math.abs(cards[0].top - anchor.alphaTop) <= 2, JSON.stringify({ cards, anchor }));
      assert.ok(cards[1].top >= anchor.betaTop - 2, "a card is never above its anchor when nothing is open");
      assertNoOverlap(cards);
      assert.equal(anchor.highlights, 2);
      anchor = probe("scroll");
      wait(300);
      cards = marginCards();
      assert.ok(Math.abs(cards[0].top - anchor.alphaTop) <= 2, "cards follow the page as it scrolls");
      probe("top");
      wait(300);

      // Hover glow, both directions.
      page(`${card("c1")}.dispatchEvent(new MouseEvent('mouseenter'));return true`);
      assert.deepEqual(probe().active, ["c1"]);
      page(`${card("c1")}.dispatchEvent(new MouseEvent('mouseleave'));return true`);
      assert.deepEqual(probe().active, []);
      probe("hover");
      assert.equal(marginCards()[0].active, true, "hovering the highlight brightens its card");
      probe("unhover");
      assert.equal(marginCards()[0].active, false);

      // One click on a highlight opens its thread with the reply box focused.
      page(`document.getElementById('annotation').click();return true`);
      wait(300);
      const clicked = probe("click-alpha");
      assert.equal(clicked.popup, false, "a click on a commented element opens its thread, not a new comment");
      wait(300);
      cards = marginCards();
      assert.equal(cards[0].open, true);
      assert.equal(page(`return document.activeElement===${card("c1")}.querySelector('textarea')`), true);
      assertNoOverlap(cards);
      screenshot("after-open-thread.png");

      // Threaded reply: Enter sends from the thread's own reply box.
      page(`const input=${card("c1")}.querySelector('textarea');input.value='Can you explain the tradeoff?';
        input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true`);
      wait(1500);
      assert.match(marginCards()[0].text, /tradeoff/);
      const poll = cli("poll", artifact, "--timeout-ms", "100");
      assert.match(poll, /thread_id/);
      assert.match(poll, /tradeoff[^\n]*,c1\n/, poll);
      assert.match(poll, /This feedback is only questions/);

      // Per-thread agent answers from one reply, one with a Reveal.
      const replyFile = path.join(temp, "reply.md");
      await writeFile(
        replyFile,
        "## c1 reveal=r1\nTen teams gives us enough variety. I clarified the rollout below.\n\n## c2\nThe launch lead owns it.\n",
      );
      cli("reply", artifact, "--agent-reply-file", replyFile);
      wait(1500);
      cards = marginCards();
      assert.match(cards[0].text, /enough variety/);
      assert.doesNotMatch(cards[0].text, /launch lead/);
      assert.match(cards[1].text, /launch lead/);
      assert.equal(cards[0].reveal, 1);
      assert.equal(cards[1].reveal, 0);
      assert.equal(
        page(`return ${card("c2")}.querySelectorAll('.thread-message.user .receipt-step.is-done').length`),
        2,
        "the thread's own note shows Seen and Done receipts",
      );
      assert.equal(
        page(`return document.querySelectorAll('#chatLog .bubble.agent, #chatLog .agent').length`),
        0,
        "thread answers do not also land in chat",
      );
      assertNoOverlap(cards);
      screenshot("after-agent-replies.png");
      browser("emulate", "--color-scheme", "dark");
      wait(300);
      screenshot("after-dark.png");
      browser("emulate", "--color-scheme", "light");

      // Reveal from the thread jumps to the changed block.
      page(`${card("c1")}.querySelector('.thread-reveal').click();return true`);
      const reveal = probe();
      assert.equal(reveal.reveal, 1);
      assert.equal(reveal.changedVisible, true);
      probe("top");
      wait(400);

      // Esc closes the reply box and keeps its draft.
      page(`${card("c1")}.click();const input=${card("c1")}.querySelector('textarea');input.value='Draft kept';
        input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true`);
      assert.equal(marginCards()[0].open, false);
      page(`${card("c1")}.click();return true`);
      assert.equal(page(`return document.activeElement.value`), "Draft kept");

      // Resolve leaves the margin and the page; it stays in the panel, survives reload, and reopens.
      page(`${card("c2")}.querySelector('.thread-resolve').click();return true`);
      wait();
      assert.deepEqual(
        marginCards().map((c) => c.id),
        ["c1"],
      );
      assert.equal(probe().highlights, 1);
      browser("open", url);
      wait(2500);
      assert.deepEqual(
        marginCards().map((c) => c.id),
        ["c1"],
      );
      assert.equal(page(`return document.querySelectorAll('#threadList .thread-reopen').length`), 1);
      assert.match(page(`return document.querySelector('#threadList summary').textContent`), /1 open · 1 resolved/);
      page(
        `document.querySelector('#threadList details').open=true;document.querySelector('#threadList .thread-reopen').click();return true`,
      );
      wait();
      assert.equal(probe().highlights, 2);
      assert.equal(marginCards().length, 2);

      // A page revision keeps messages, drafts and placement.
      await writeFile(artifact, ARTIFACT.replace("A proposal for rolling out", "A revised proposal for rolling out"));
      wait(2500);
      assert.match(marginCards()[0].text, /enough variety/);
      page(`${card("c1")}.click();return true`);
      assert.equal(page(`return document.activeElement.value`), "Draft kept");
      page(
        `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true`,
      );

      // The popup: one click to comment, focused, Enter sends straight away (no Send click).
      page(
        `if(document.getElementById('annotation').getAttribute('aria-pressed')!=='true')document.getElementById('annotation').click();return true`,
      );
      const popup = probe("annotate");
      assert.equal(popup.popup, true);
      assert.equal(popup.popupFocused, true);
      probe("popup-send", { text: "Is this too early?" });
      wait(1500);
      assert.equal(marginCards().length, 3);
      const selected = probe("select");
      assert.equal(selected.popupFocused, true);
      probe("popup-send", { text: "Which question format?" });
      wait(1500);
      const textMark = probe();
      assert.ok(textMark.textMarkWidth < textMark.betaWidth / 2, "a text comment highlights only its words");
      cards = marginCards();
      assert.equal(cards.length, 4);
      assertNoOverlap(cards);
      screenshot("after-four-threads.png");

      // A removed anchor moves its thread out of the margin into the panel list with a notice.
      await writeFile(artifact, ARTIFACT.replace('id="gamma"', 'id="gamma-removed"'));
      wait(2500);
      assert.equal(marginCards().length, 3);
      assert.equal(page(`return document.querySelectorAll('#threadList .thread-notice').length`), 1);
      await writeFile(artifact, ARTIFACT);
      wait(2500);
      assert.equal(marginCards().length, 4);

      browser("emulate", "--viewport", "390x844x1");
      wait();
      assert.equal(page(`return getComputedStyle(document.getElementById('marginThreads')).display`), "none");
      page(
        `document.querySelector('#threadList details').open=true;const t=document.getElementById('panelToggle');if(t.getAttribute('aria-expanded')!=='true')t.click();return true`,
      );
      wait();
      screenshot("after-phone.png");
      assert.equal(page(`return document.documentElement.scrollWidth<=innerWidth`), true);
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15000);
      browser("stop");
      await rm(temp, { recursive: true, force: true });
    }
  },
);
