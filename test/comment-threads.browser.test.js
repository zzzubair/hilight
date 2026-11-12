import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

// The artifact answers `thread-probe` messages from the chrome with its own view of the page:
// where the anchors are, which highlights exist, and which of them are lit.
const PROBE_SCRIPT = `<script>window.addEventListener('message',event=>{if(event.source!==parent||event.data.type!=='thread-probe')return;
const {id,action}=event.data;const $=s=>document.querySelector(s);
if(action==='queue'){
window.lavish.queuePrompt('Why ten teams? What would we learn?',{element:$('#alpha')});
window.lavish.queuePrompt('Who owns the feedback?',{element:$('#beta')});
}
if(action==='queue-many'){
const ids=[...document.querySelectorAll('[data-c]')].map(n=>n.id);
ids.forEach((nodeId,i)=>window.lavish.queuePrompt(['Why this order?','Can we cut this?','Who owns this step, and what happens if they are out that week?','Make this shorter.'][i%4],{element:$('#'+nodeId)}));
const text=$('#crowded').firstChild;
for(const [start,end] of [[0,9],[10,24],[60,84]]){const words=text.textContent.slice(start,end);
window.lavish.queuePrompt('About '+words,{element:$('#crowded'),tag:'text',text:words,target:{type:'text-range',text:words,selector:'#crowded',commonAncestorSelector:'#crowded',start:{selector:'#crowded',path:[0],offset:start},end:{selector:'#crowded',path:[0],offset:end}}});}
}
if(action==='hover'){const r=$('#alpha').getBoundingClientRect();$('#alpha').dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:r.left+5,clientY:r.top+5}));}
if(action==='unhover')document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:2,clientY:2}));
if(action==='scroll')window.scrollTo(0,event.data.y??120);
if(action==='top')window.scrollTo(0,0);
if(action==='click-alpha')$('#alpha').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
if(action==='annotate')$('#gamma').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
if(action==='popup-save'){
 const input=$('[data-lavish-ui="annotation-root"]').shadowRoot.querySelector('textarea');input.value=event.data.text;input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));window.getSelection()?.removeAllRanges();
}
setTimeout(()=>{const root=$('[data-lavish-ui="annotation-root"]')?.shadowRoot;
const marks=[...(root?.querySelectorAll('.lavish-thread-highlight')||[])];const rect=s=>$(s)?.getBoundingClientRect();
const changed=rect('#changed');const rest=marks.find(m=>!m.classList.contains('is-active'));
parent.postMessage({type:'thread-probe-result',id,alphaTop:rect('#alpha')?.top,betaTop:rect('#beta')?.top,
highlights:marks.length,active:marks.filter(m=>m.classList.contains('is-active')).map(m=>m.dataset.threadId),
restBackground:rest?getComputedStyle(rest).backgroundColor:'',
reveal:root?.querySelectorAll('.lavish-reveal-marker').length||0,popupFocused:!!root?.activeElement&&root.activeElement===root.querySelector('textarea'),
popup:!!root?.querySelector('.lavish-annotation-card'),changedVisible:changed?changed.top>=0&&changed.bottom<=innerHeight:false},'*');},event.data.settle??500);
});</script>`;

const ARTIFACT = `<!doctype html><html data-lavish-annotate="off"><head><meta charset="utf-8"><title>Reviewing the launch plan</title>
<style>body{margin:60px auto;max-width:650px;padding:0 36px;font:18px/1.7 Georgia;color:#292820;background:#fcfaf4}h1{font-size:36px;line-height:1.2}h2{font-size:25px}p{margin:20px 0}.space{height:1100px}</style>
<script type="application/json" data-lavish-revisions>[{"id":"r1","label":"Clarified the rollout"}]</script></head>
<body><h1>A quieter launch</h1><p>A proposal for rolling out the new workspace.</p><h2>Start with a small group</h2>
<p id="alpha">Invite ten teams first. Give them a full week to use the workspace before opening it to everyone.</p>
<p id="beta">Collect feedback in one place, with an owner for each question and a clear next step.</p>
<p id="gamma">Ship the announcement once the first teams are happy.</p>
<div class="space"></div><p id="changed" data-lavish-revision="r1">The revised rollout starts with ten teams and a named owner.</p><div class="space"></div>
${PROBE_SCRIPT}</body></html>`;

const SECTIONS = Array.from({ length: 13 }, (_, i) => i + 1);
const CROWDED_ARTIFACT = `<!doctype html><html data-lavish-annotate="off"><head><meta charset="utf-8"><title>Workspace rollout plan</title>
<style>body{margin:0 auto;max-width:700px;padding:40px 36px 300px;font:17px/1.65 system-ui,sans-serif;color:#1d2330;background:#fff}h2{font-size:22px;margin:36px 0 8px}p{margin:12px 0}</style></head><body>
<h1>Workspace rollout plan</h1>
<p id="crowded">The pilot starts with ten teams that already use the old tool every day, so feedback arrives quickly.</p>
${SECTIONS.map(
  (n) =>
    `<h2 id="h${n}" data-c>${n}. Section</h2><p id="p${n}a" data-c>Paragraph ${n}a. Each team gets a named owner and a migration window.</p><p id="p${n}b" data-c>Paragraph ${n}b. We rehearse the rollback once before the real move.</p>`,
).join("\n")}
${PROBE_SCRIPT}</body></html>`;

function harness(temp, port, sessionName) {
  const lavishEnv = {
    HILIGHT_PORT: String(port),
    HILIGHT_STATE_DIR: path.join(temp, "state"),
    HILIGHT_NO_OPEN: "1",
    HILIGHT_TELEMETRY: "0",
    HILIGHT_HOST: "127.0.0.1",
    HILIGHT_LINK_HOST: "127.0.0.1",
  };
  const chromeEnv = {
    CHROME_DEVTOOLS_AXI_SESSION: `${sessionName}-${process.pid}`,
    CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
  };
  const evidence = process.env.HILIGHT_THREADS_EVIDENCE;
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
  const page = (body) => evaluate(`()=>JSON.stringify((()=>{${body}})())`);
  const pageAsync = (body) => evaluate(`async()=>JSON.stringify(await (async()=>{${body}})())`);
  const wait = (ms = 1200) =>
    evaluate(`async()=>{await new Promise(r=>setTimeout(r,${ms}));return JSON.stringify(true)}`);
  function probe(action = "", extra = {}) {
    return evaluate(
      `async()=>{const f=document.getElementById('artifact'),id=Math.random().toString(36);const p=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('probe timeout')),10000);function h(e){if(e.source!==f.contentWindow||e.data.type!=='thread-probe-result'||e.data.id!==id)return;clearTimeout(timer);window.removeEventListener('message',h);resolve(e.data);}window.addEventListener('message',h);});f.contentWindow.postMessage({...${JSON.stringify(extra)},type:'thread-probe',id,action:${JSON.stringify(action)}},'*');return JSON.stringify(await p)}`,
    );
  }
  const marginCards = () =>
    page(`const frame=document.getElementById('artifact').getBoundingClientRect().top;
      return [...document.querySelectorAll('#marginThreadCanvas .comment-thread')].filter(n=>!n.classList.contains('is-unplaced')).map(n=>{const r=n.getBoundingClientRect();
      return {id:n.dataset.threadId,top:r.top-frame,bottom:r.bottom-frame,open:n.classList.contains('is-open'),active:n.classList.contains('is-active'),
      compact:n.classList.contains('is-compact'),status:n.querySelector('.thread-status')?.textContent||'',
      text:n.querySelector('.thread-messages').textContent,reveal:n.querySelectorAll('.thread-reveal').length,
      anchor:threadGeometry.get(n.dataset.threadId)?.top??null}})`);
  // A compact row per card: 42 full cards overflow what one chrome-devtools-axi eval prints.
  const cardRows = () =>
    page(`const frame=document.getElementById('artifact').getBoundingClientRect().top;
      return [...document.querySelectorAll('#marginThreadCanvas .comment-thread')].filter(n=>!n.classList.contains('is-unplaced')).map(n=>{const r=n.getBoundingClientRect();
      const g=threadGeometry.get(n.dataset.threadId)?.top;return [n.dataset.threadId,Math.round(r.top-frame),Math.round(r.bottom-frame),
      n.classList.contains('is-open')?1:0,n.classList.contains('is-compact')?1:0,g===undefined||g===null?null:Math.round(g)]})`).map(
      ([id, top, bottom, open, compact, anchor]) => ({
        id,
        top,
        bottom,
        open: open === 1,
        compact: compact === 1,
        anchor,
      }),
    );
  const card = (id) => `document.querySelector('#marginThreadCanvas .comment-thread[data-thread-id="${id}"]')`;
  function screenshot(name) {
    if (evidence) browser("screenshot", path.join(evidence, name));
  }
  function assertNoOverlap(cards) {
    const sorted = [...cards].sort((a, b) => a.top - b.top);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(
        sorted[i].top >= sorted[i - 1].bottom + 4,
        `cards overlap: ${JSON.stringify(sorted.slice(i - 1, i + 1))}`,
      );
    }
  }
  async function stop() {
    run(process.execPath, ["bin/hilight.js", "stop", "--port", String(port)], lavishEnv, 15000);
    browser("stop");
  }
  return {
    browser,
    cli,
    page,
    pageAsync,
    wait,
    probe,
    marginCards,
    cardRows,
    card,
    screenshot,
    assertNoOverlap,
    stop,
    evidence,
  };
}

test(
  "comments-only review: page thread, drafts, batch send, per-thread answers, Reveal, resolve with undo, keyboard and phone",
  { skip: !runBrowserE2e, timeout: 420000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-threads-e2e-"));
    const port = await freePort();
    const h = harness(temp, port, "lavish-threads");
    const { browser, cli, page, wait, probe, marginCards, card, screenshot, assertNoOverlap } = h;
    try {
      if (h.evidence) await mkdir(h.evidence, { recursive: true });
      const artifact = path.join(temp, "review.html");
      await writeFile(artifact, ARTIFACT);
      const url = cli(artifact, "--no-open").match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url);
      browser("open", url);
      browser("emulate", "--viewport", "1600x1000x1");
      wait(2500);

      // No side panel: one comments margin with the page thread on top and one Send at the bottom.
      const shell = page(`return {panel:!!document.getElementById('panel'),chatLog:!!document.getElementById('chatLog'),
        revisions:!!document.getElementById('revisionsButton'),pageThread:!!document.querySelector('#comments #pageThread'),
        sendInFoot:!!document.querySelector('.comments-foot #send'),status:document.getElementById('agentStatus').textContent,
        frameWidth:document.getElementById('artifact').getBoundingClientRect().width,
        commentsWidth:document.getElementById('comments').getBoundingClientRect().width}`);
      assert.deepEqual(
        { ...shell, frameWidth: undefined, commentsWidth: undefined },
        {
          panel: false,
          chatLog: false,
          revisions: false,
          pageThread: true,
          sendInFoot: true,
          status: "Not listening",
          frameWidth: undefined,
          commentsWidth: undefined,
        },
      );
      assert.ok(shell.frameWidth > shell.commentsWidth * 3, JSON.stringify(shell));
      screenshot("after-empty.png");

      // Drafts: anchored notes and a page comment are saved, never sent, until Send to agent.
      probe("queue");
      wait();
      let cards = marginCards();
      assert.equal(cards.length, 2, "queued anchored notes show as margin cards");
      assert.deepEqual(
        cards.map((c) => c.status),
        ["Not sent", "Not sent"],
      );
      page(`const input=document.getElementById('chatInput');input.focus();input.value='Overall this reads well.';
        input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true`);
      wait(400);
      assert.equal(page(`return document.getElementById('chatInput').value`), "");
      assert.match(page(`return document.getElementById('pageMessages').textContent`), /Overall this reads well/);
      assert.equal(page(`return document.getElementById('pageThreadStatus').textContent`), "Not sent");
      assert.equal(page(`return document.getElementById('send').textContent`), "Send to agent (3)");
      assert.doesNotMatch(cli("poll", artifact, "--timeout-ms", "300"), /Overall this reads well|Why ten teams/);

      // Half-typed page text and saved drafts survive a reload of the review page.
      page(
        `const input=document.getElementById('chatInput');input.value='Half a thought';input.dispatchEvent(new Event('input',{bubbles:true}));return true`,
      );
      browser("open", url);
      wait(2500);
      assert.equal(page(`return document.getElementById('chatInput').value`), "Half a thought");
      assert.equal(marginCards().length, 2);
      assert.equal(page(`return document.getElementById('send').textContent`), "Send to agent (4)");
      page(
        `const input=document.getElementById('chatInput');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));return true`,
      );

      // One Send delivers every draft in one poll round.
      page(`document.getElementById('send').click();return true`);
      wait(1500);
      cards = marginCards();
      assert.deepEqual(
        cards.map((c) => [c.id, c.status]),
        [
          ["c1", "Sent"],
          ["c2", "Sent"],
        ],
      );
      let poll = cli("poll", artifact, "--timeout-ms", "300");
      assert.match(poll, /Why ten teams/);
      assert.match(poll, /Who owns the feedback/);
      assert.match(poll, /Overall this reads well/);
      wait(800);
      assert.deepEqual(
        marginCards().map((c) => c.status),
        ["Seen", "Seen"],
      );

      // Placement: each card sits beside its anchor and nothing overlaps. Highlights are faint at rest.
      cards = marginCards();
      let anchor = probe();
      assert.ok(Math.abs(cards[0].top - anchor.alphaTop) <= 2, JSON.stringify({ cards, anchor }));
      assertNoOverlap(cards);
      assert.equal(anchor.highlights, 2);
      assert.deepEqual(anchor.active, [], "nothing is lit at rest");
      assert.equal(anchor.restBackground, "rgba(0, 0, 0, 0)", "a resting highlight has no fill");
      anchor = probe("scroll");
      wait(300);
      cards = marginCards();
      assert.ok(Math.abs(cards[0].top - anchor.alphaTop) <= 2, "cards follow the page as it scrolls");
      probe("top");
      wait(300);

      // Hover lights the highlight from the card, and the card from the highlight.
      page(`${card("c1")}.dispatchEvent(new MouseEvent('mouseenter'));return true`);
      assert.deepEqual(probe().active, ["c1"]);
      page(`${card("c1")}.dispatchEvent(new MouseEvent('mouseleave'));return true`);
      assert.deepEqual(probe().active, []);
      probe("hover");
      assert.equal(marginCards()[0].active, true, "hovering the highlight brightens its card");
      probe("unhover");
      assert.equal(marginCards()[0].active, false);

      // A click on a commented element in annotate mode opens its thread with the reply box focused.
      page(`document.getElementById('annotation').click();return true`);
      wait(300);
      assert.equal(probe("click-alpha").popup, false, "a commented element opens its thread, not a new comment");
      wait(300);
      cards = marginCards();
      assert.equal(cards[0].open, true);
      assert.equal(page(`return document.activeElement===${card("c1")}.querySelector('textarea')`), true);
      assert.deepEqual(probe().active, ["c1"], "the open thread keeps its highlight lit");
      assertNoOverlap(cards);

      // A reply is a draft too: Enter saves it in the thread, and only Send delivers it.
      page(`const input=${card("c1")}.querySelector('textarea');input.value='Can you explain the tradeoff?';
        input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true`);
      wait(400);
      assert.match(marginCards()[0].text, /tradeoff/);
      assert.equal(marginCards()[0].status, "Not sent");
      assert.doesNotMatch(cli("poll", artifact, "--timeout-ms", "300"), /tradeoff/);
      page(`document.getElementById('send').click();return true`);
      wait(1500);
      poll = cli("poll", artifact, "--timeout-ms", "300");
      assert.match(poll, /^ {2}c1,[^\n]*tradeoff/m, poll);

      // One agent reply: the lead-in goes to the page thread, each section to its own card.
      const replyFile = path.join(temp, "reply.md");
      await writeFile(
        replyFile,
        "Thanks, answered below.\n\n## c1 reveal=r1\nTen teams gives us enough variety. I clarified the rollout below.\n\n## c2\nThe launch lead owns it.\n",
      );
      cli("reply", artifact, "--agent-reply-file", replyFile);
      wait(1500);
      cards = marginCards();
      assert.match(cards[0].text, /enough variety/);
      assert.doesNotMatch(cards[0].text, /launch lead/);
      assert.match(cards[1].text, /launch lead/);
      assert.deepEqual(
        cards.map((c) => [c.reveal, c.status]),
        [
          [1, "Replied"],
          [0, "Replied"],
        ],
      );
      let pageText = page(`return document.getElementById('pageMessages').textContent`);
      assert.match(pageText, /Thanks, answered below/);
      assert.doesNotMatch(pageText, /enough variety|launch lead/, "thread answers stay in their threads");
      // A reply with no thread sections lands in the page thread whole.
      cli("reply", artifact, "--agent-reply", "All three notes are handled.");
      wait(1200);
      pageText = page(`return document.getElementById('pageMessages').textContent`);
      assert.match(pageText, /All three notes are handled/);
      assertNoOverlap(marginCards());
      screenshot("after-agent-replies.png");

      // Reveal from the thread jumps to the changed block.
      page(`${card("c1")}.querySelector('.thread-reveal').click();return true`);
      const reveal = probe();
      assert.equal(reveal.reveal, 1);
      assert.equal(reveal.changedVisible, true);
      probe("top");
      wait(400);

      // Esc closes the reply box and keeps its draft.
      page(`const input=${card("c1")}.querySelector('textarea');input.focus();input.value='Draft kept';
        input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true`);
      wait(300);
      assert.equal(marginCards()[0].open, false);
      page(`${card("c1")}.click();return true`);
      wait(300);
      assert.equal(page(`return document.activeElement.value`), "Draft kept");
      page(
        `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true`,
      );
      wait(300);

      // Keyboard: with a card focused, j and k step through threads in page order.
      page(
        `${card("c1")}.focus();${card("c1")}.dispatchEvent(new KeyboardEvent('keydown',{key:'j',bubbles:true}));return true`,
      );
      assert.equal(page(`return document.activeElement.dataset.threadId`), "c2");
      page(
        `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));return true`,
      );
      assert.equal(page(`return document.activeElement.dataset.threadId`), "c1");
      page(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'k',bubbles:true}));return true`);
      assert.equal(page(`return document.activeElement.dataset.threadId`), "page");
      page(`document.activeElement.blur();return true`);

      // Resolve hides the thread from the margin and the page, with an Undo toast.
      page(`${card("c2")}.click();return true`);
      wait(300);
      page(`${card("c2")}.querySelector('.thread-resolve').click();return true`);
      wait();
      assert.deepEqual(
        marginCards().map((c) => c.id),
        ["c1"],
      );
      assert.equal(probe().highlights, 1);
      assert.deepEqual(
        page(
          `return [document.getElementById('resolveToast').hidden,document.getElementById('resolveToastText').textContent]`,
        ),
        [false, "Resolved"],
      );
      screenshot("after-resolve-toast.png");
      page(`document.getElementById('resolveUndo').click();return true`);
      wait();
      assert.equal(marginCards().length, 2, "Undo puts the thread back");
      page(`${card("c2")}.click();return true`);
      wait(300);
      page(`${card("c2")}.querySelector('.thread-resolve').click();return true`);
      wait(6600);
      assert.equal(page(`return document.getElementById('resolveToast').hidden`), true, "the toast leaves on its own");

      // Resolved survives a reload; the top bar lists it, and Reopen restores it with its history.
      browser("open", url);
      wait(2500);
      assert.deepEqual(
        marginCards().map((c) => c.id),
        ["c1"],
      );
      assert.equal(page(`return document.getElementById('resolvedCount').textContent`), "1 resolved");
      page(`document.getElementById('resolvedButton').click();return true`);
      wait(300);
      const drawer = page(`const list=document.getElementById('resolvedList');
        const box=document.getElementById('resolvedDrawer').getBoundingClientRect(),c=list.querySelector('.comment-thread').getBoundingClientRect();
        return {quote:list.querySelector('.thread-quote')?.textContent||'',text:list.textContent,reopen:[...list.querySelectorAll('.comment-thread:not(.is-open) .thread-reopen')].filter((b)=>b.getBoundingClientRect().height>=32).length,
        inside:c.left>=box.left&&c.right<=box.right+0.5}`);
      assert.match(drawer.quote, /Collect feedback/);
      assert.match(drawer.text, /launch lead/);
      assert.equal(drawer.reopen, 1, "Reopen shows on the collapsed row with a 32px target");
      assert.equal(drawer.inside, true, "a drawer card stays inside the drawer");
      screenshot("after-resolved-drawer.png");
      page(`document.querySelector('#resolvedList .thread-reopen').click();return true`);
      wait();
      assert.equal(probe().highlights, 2);
      cards = marginCards();
      assert.equal(cards.length, 2);
      assert.match(cards.find((c) => c.id === "c2").text, /launch lead/, "Reopen keeps the full history");

      // An artifact save keeps messages, drafts and placement.
      await writeFile(artifact, ARTIFACT.replace("A proposal for rolling out", "A revised proposal for rolling out"));
      wait(2500);
      assert.match(marginCards()[0].text, /enough variety/);
      page(`${card("c1")}.click();return true`);
      wait(300);
      assert.equal(page(`return document.activeElement.value`), "Draft kept");
      page(
        `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true`,
      );

      // The annotation popup: one click, focused, and Enter saves a draft card instead of sending.
      page(
        `if(document.getElementById('annotation').getAttribute('aria-pressed')!=='true')document.getElementById('annotation').click();return true`,
      );
      const popup = probe("annotate");
      assert.equal(popup.popup, true);
      assert.equal(popup.popupFocused, true);
      probe("popup-save", { text: "Is this too early?" });
      wait(800);
      cards = marginCards();
      assert.equal(cards.length, 3);
      assert.equal(cards.find((c) => /too early/.test(c.text)).status, "Not sent");
      assert.doesNotMatch(cli("poll", artifact, "--timeout-ms", "300"), /too early/);
      assertNoOverlap(cards);

      // A removed anchor moves its thread to the top-bar drawer with a notice.
      page(`document.getElementById('send').click();return true`);
      wait(1500);
      cli("poll", artifact, "--timeout-ms", "300");
      await writeFile(artifact, ARTIFACT.replace('id="gamma"', 'id="gamma-removed"'));
      wait(2500);
      assert.equal(marginCards().length, 2);
      assert.match(page(`return document.getElementById('resolvedCount').textContent`), /1 off-page/);
      assert.equal(page(`return document.querySelectorAll('#resolvedList .thread-notice').length`), 1);
      await writeFile(artifact, ARTIFACT);
      wait(2500);
      assert.equal(marginCards().length, 3);

      // Phone: the margin becomes a bottom sheet of stacked threads with Send pinned at the bottom.
      browser("emulate", "--viewport", "390x844x1");
      wait();
      page(
        `const t=document.getElementById('sheetToggle');if(t.getAttribute('aria-expanded')!=='true')t.click();return true`,
      );
      wait(800);
      const phone =
        page(`const cards=[...document.querySelectorAll('#comments .comment-thread')].map(n=>n.getBoundingClientRect());
        const send=document.getElementById('send').getBoundingClientRect();
        return {count:cards.length,stacked:cards.every((r,i)=>i===0||r.top>=cards[i-1].bottom-0.5),
        inside:cards.every(r=>r.left>=0&&r.right<=innerWidth+0.5),
        sendVisible:send.bottom<=innerHeight&&send.top>0,noScroll:document.documentElement.scrollWidth<=innerWidth,
        transforms:[...document.querySelectorAll('#marginThreadCanvas .comment-thread')].filter(n=>n.style.transform).length}`);
      screenshot("after-phone.png");
      assert.deepEqual(phone, {
        count: 4,
        stacked: true,
        inside: true,
        sendVisible: true,
        noScroll: true,
        transforms: 0,
      });
    } finally {
      await h.stop();
      await rm(temp, { recursive: true, force: true });
    }
  },
);

test(
  "42 margin threads: no overlap, page order, compact when crowded, the open card expands at its anchor, long threads fold, scrolling stays cheap",
  { skip: !runBrowserE2e, timeout: 300000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-many-threads-e2e-"));
    const port = await freePort();
    const h = harness(temp, port, "lavish-many-threads");
    const { browser, cli, page, pageAsync, wait, probe, cardRows, card, screenshot, assertNoOverlap } = h;
    try {
      if (h.evidence) await mkdir(h.evidence, { recursive: true });
      const artifact = path.join(temp, "plan.html");
      await writeFile(artifact, CROWDED_ARTIFACT);
      const url = cli(artifact, "--no-open").match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url);
      browser("open", url);
      browser("emulate", "--viewport", "1440x960x1");
      wait(2500);
      probe("queue-many");
      wait(800);
      page(`document.getElementById('send').click();return true`);
      wait(2000);
      cli("poll", artifact, "--timeout-ms", "300");

      // A long thread: four more replies on c1, then an answer.
      const key = page(`return JSON.parse(document.getElementById('lavish-session').textContent).key`);
      for (const text of ["First follow-up", "Second follow-up", "Third follow-up", "Fourth follow-up"]) {
        pageAsync(`const r=await fetch('/api/${key}/prompts',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({prompts:[{prompt_id:crypto.randomUUID(),uid:'',prompt:${JSON.stringify(text)},selector:'',tag:'message',text:'Reply',thread_id:'c1'}],domSnapshot:''})});return r.status`);
      }
      cli("poll", artifact, "--timeout-ms", "300");
      cli("reply", artifact, "--agent-reply", "## c1\nThe final answer for the long thread.");
      browser("open", url);
      wait(3000);

      let cards = cardRows();
      assert.equal(page(`return document.querySelectorAll('#marginThreadCanvas .comment-thread').length`), 42);
      assertNoOverlap(cards);
      const byAnchor = cards.filter((c) => c.anchor !== null).sort((a, b) => a.anchor - b.anchor || a.top - b.top);
      assert.deepEqual(
        byAnchor.map((c) => c.id),
        [...byAnchor].sort((a, b) => a.top - b.top).map((c) => c.id),
        "cards keep page order",
      );
      assert.ok(
        cards.some((c) => c.compact),
        "crowded cards shrink to one line",
      );
      assert.equal(
        page(`return ${card("c1")}.querySelectorAll('.thread-message.is-middle').length>0`),
        true,
        "a long closed thread folds its middle replies",
      );
      screenshot("after-42-threads.png");

      // Three comments in the same paragraph: opening the middle one expands it beside its anchor.
      const crowded = cards.filter((c) => c.id === "c40" || c.id === "c41" || c.id === "c42");
      assert.equal(crowded.length, 3, JSON.stringify(cards.map((c) => c.id)));
      page(`${card("c41")}.click();return true`);
      wait(600);
      cards = cardRows();
      const open = cards.find((c) => c.id === "c41");
      assert.equal(open.open, true);
      assert.equal(open.compact, false, "the open card expands");
      assert.ok(Math.abs(open.top - open.anchor) <= 2, JSON.stringify(open));
      assertNoOverlap(cards);
      page(
        `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return true`,
      );
      wait(400);

      // Scrolling the artifact keeps cards in place without overlap, at about one frame per step.
      const frames =
        pageAsync(`const w=document.getElementById('artifact').contentWindow,deltas=[];let last=performance.now();
        for(let i=0;i<60;i++){w.postMessage({type:'lavish:restoreScroll',x:0,y:i*30},'*');await new Promise(r=>requestAnimationFrame(r));
        const now=performance.now();deltas.push(now-last);last=now;}
        deltas.sort((a,b)=>a-b);return {p50:deltas[30],p95:deltas[57]}`);
      assert.ok(frames.p95 < 50, JSON.stringify(frames));
      wait(500);
      assertNoOverlap(cardRows());
      probe("scroll", { y: 1400 });
      wait(500);
      cards = cardRows();
      assertNoOverlap(cards);
      const inView = cards.filter((c) => c.anchor !== null && c.anchor > 80 && c.anchor < 700 && !c.compact);
      for (const c of inView)
        assert.ok(c.top >= c.anchor - 2, `a card never sits above its anchor: ${JSON.stringify(c)}`);
      screenshot("after-42-threads-scrolled.png");
    } finally {
      await h.stop();
      await rm(temp, { recursive: true, force: true });
    }
  },
);
