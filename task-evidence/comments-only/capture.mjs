// Evidence runner for the comments-only review UI. Not part of the test suite and adds no
// dependency: PLAYWRIGHT_MODULE points at an existing playwright-core/index.mjs.
// Usage: PLAYWRIGHT_MODULE=/path/playwright-core/index.mjs node task-evidence/comments-only/capture.mjs before|after
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { chromium } = await import(
  pathToFileURL(process.env.PLAYWRIGHT_MODULE || "/tmp/lavish-bughunt-tools/node_modules/playwright-core/index.mjs")
    .href
);
const label = process.argv[2] || "after";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, "task-evidence", "comments-only");
await mkdir(out, { recursive: true });
const { serve } = await import(path.join(root, "src/server.js"));
const temp = await mkdtemp(path.join(tmpdir(), "lavish-comments-only-"));
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
const base = "http://127.0.0.1:" + server.port;
const artifact = path.join(temp, "plan.html");
const sections = Array.from({ length: 12 }, (_, i) => i + 1);
await writeFile(
  artifact,
  `<!doctype html><html lang="en" data-lavish-annotate="on"><head><meta charset="utf-8"><title>Workspace rollout plan</title>
<style>body{margin:0 auto;max-width:720px;padding:40px 36px 200px;font:17px/1.65 system-ui,sans-serif;color:#1d2330;background:#fff}h1{font-size:34px;line-height:1.15;margin:0 0 8px}h2{font-size:22px;margin:40px 0 8px}p{margin:12px 0}li{margin:4px 0}</style>
<script type="application/json" data-lavish-revisions>[{"id":"r1","label":"Clarified the owner"}]</script></head><body>
<h1 id="title">Workspace rollout plan</h1><p id="lede">How we move every team onto the new workspace in one quarter without losing a week of work.</p>
${sections
  .map(
    (
      n,
    ) => `<h2 id="h${n}">${n}. ${["Scope", "Pilot teams", "Migration", "Training", "Support", "Security", "Billing", "Data", "Comms", "Risks", "Metrics", "Timeline"][n - 1]}</h2>
<p id="p${n}a">Paragraph ${n}a. The pilot starts with ten teams that already use the old tool every day, so feedback arrives quickly and from people who know the edge cases.</p>
<p id="p${n}b"${n === 4 ? ' data-lavish-revision="r1"' : ""}>Paragraph ${n}b. Each team gets a named owner, a migration window, and a rollback plan that we rehearse once before the real move.</p>
<ul><li id="l${n}a">Owner confirmed for section ${n}</li><li id="l${n}b">Checklist reviewed with the team lead</li></ul>`,
  )
  .join("\n")}
</body></html>`,
);
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
const results = { label };
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/session/" + key);
  await page.waitForFunction(() => !document.body.classList.contains("layout-gate-active"), { timeout: 20000 });
  const frame = () => page.frames().find((f) => f.url().includes("/artifact/"));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, label + "-empty.png") });

  // 42 anchored comments: element notes on most blocks, plus three text ranges inside one paragraph.
  await frame().evaluate(
    (ids) => {
      const q = (s) => document.querySelector(s);
      for (const [index, id] of ids.entries()) {
        window.lavish.queuePrompt(
          [
            "Why this order?",
            "Can we cut this?",
            "Who owns this step, and what happens if they are out that week?",
            "Make this shorter.",
            "Is ten teams enough to learn anything real about the migration?",
          ][index % 5],
          { element: q("#" + id) },
        );
      }
      const p = q("#p2a").firstChild;
      for (const [start, end] of [
        [14, 23],
        [24, 48],
        [92, 118],
      ]) {
        const text = p.textContent.slice(start, end);
        window.lavish.queuePrompt("Question about “" + text + "”", {
          element: q("#p2a"),
          tag: "text",
          text,
          target: {
            type: "text-range",
            text,
            selector: "#p2a",
            commonAncestorSelector: "#p2a",
            start: { selector: "#p2a", path: [0], offset: start },
            end: { selector: "#p2a", path: [0], offset: end },
          },
        });
      }
    },
    sections.flatMap((n) => [`h${n}`, `p${n}a`, `p${n}b`].concat(n % 3 === 0 ? [`l${n}a`] : [])).slice(0, 39),
  );
  await page.waitForTimeout(400);
  await frame().evaluate(() => window.lavish.sendQueuedPrompts());
  await page.waitForFunction(
    () =>
      !sessionStorage.getItem(
        "lavish-axi:queued:" + JSON.parse(document.getElementById("lavish-session").textContent).key,
      ),
    { timeout: 15000 },
  );
  await page.waitForTimeout(500);
  // Agent answers: a page-level note, long answers in five threads, a Reveal, and two user follow-ups.
  const reply = (text) =>
    page.evaluate(
      async ({ key, text }) =>
        (
          await fetch("/api/" + key + "/agent-reply", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text }),
          })
        ).status,
      { key, text },
    );
  results.reply = await reply(
    [
      "I read all 42 comments. Answers are in each thread; the plan itself is unchanged until you confirm.",
      "",
      "## c1",
      "The order follows risk: scope first so nobody migrates work we are about to cut.",
      "## c2",
      "Yes. The lede repeats the title and can go.\n\nI kept it only because the template had it.",
      "## c3",
      "The section owner is named in the checklist below. If they are out, the team lead covers.",
      "## c5 reveal=r1",
      "I clarified the owner in 4b.",
      "## c8",
      "Ten teams gives us roughly 120 people, enough to see the common failure modes.\n\nThe long tail needs the second wave.",
    ].join("\n"),
  );
  for (const [thread, text] of [
    ["c1", "Fine, but say that in the doc."],
    ["c3", "And who covers the team lead?"],
  ]) {
    await page.evaluate(
      async ({ key, thread, text }) =>
        fetch("/api/" + key + "/prompts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prompts: [
              {
                prompt_id: crypto.randomUUID(),
                uid: "",
                prompt: text,
                selector: "",
                tag: "message",
                text: "Reply",
                thread_id: thread,
              },
            ],
            domSnapshot: "",
          }),
        }),
      { key, thread, text },
    );
  }
  await reply("## c1\nAdded a sentence to the scope section.\n## c3\nThe program manager, Dana.");
  await page.reload();
  await page.waitForFunction(() => !document.body.classList.contains("layout-gate-active"), { timeout: 20000 });
  await page.waitForTimeout(1200);
  results.counts = await page.evaluate(() => ({
    marginCards: document.querySelectorAll("#marginThreadCanvas .comment-thread").length,
    panel: Boolean(document.getElementById("panel")),
  }));
  await page.screenshot({ path: path.join(out, label + "-40-threads.png") });
  // Overlap check: placed margin cards must never intersect.
  results.overlaps = await page.evaluate(() => {
    const cards = [...document.querySelectorAll("#marginThreadCanvas .comment-thread")]
      .filter((n) => !n.classList.contains("is-unplaced"))
      .map((n) => n.getBoundingClientRect())
      .sort((a, b) => a.top - b.top);
    let overlaps = 0;
    for (let i = 1; i < cards.length; i++) if (cards[i].top < cards[i - 1].bottom - 0.5) overlaps += 1;
    return overlaps;
  });
  // Alignment: how far each visible card sits from its anchor (chrome globals are classic-script scope).
  results.alignment = await page.evaluate(`(() => {
    const frameTop = document.getElementById("artifact").getBoundingClientRect().top;
    const height = document.getElementById("artifact").getBoundingClientRect().height;
    const offsets = [...document.querySelectorAll("#marginThreadCanvas .comment-thread")].map((n) => {
      const g = threadGeometry.get(n.dataset.threadId);
      const top = n.getBoundingClientRect().top - frameTop;
      return g && g.top >= 0 && g.top < height ? Math.abs(top - g.top) : null;
    }).filter((v) => v !== null);
    return { visibleAnchors: offsets.length, within4px: offsets.filter((v) => v <= 4).length, worstPx: Math.round(Math.max(0, ...offsets)) };
  })()`);
  // Scroll cost: drive 60 frames of artifact scrolling and time the chrome's main thread.
  results.scroll = await page.evaluate(async () => {
    const frameWindow = document.getElementById("artifact").contentWindow;
    const deltas = [];
    let last = performance.now();
    for (let i = 0; i < 60; i++) {
      frameWindow.postMessage({ type: "lavish:restoreScroll", x: 0, y: i * 40 }, "*");
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      deltas.push(now - last);
      last = now;
    }
    deltas.sort((a, b) => a - b);
    return { p50: deltas[30].toFixed(1), p95: deltas[57].toFixed(1), max: deltas[59].toFixed(1) };
  });
  await page.evaluate(() =>
    document.getElementById("artifact").contentWindow.postMessage({ type: "lavish:restoreScroll", x: 0, y: 0 }, "*"),
  );
  await page.waitForTimeout(500);
  if (label === "after") {
    const card = page.locator('#marginThreadCanvas .comment-thread[data-thread-id="c3"]');
    await card.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, label + "-open-thread.png") });
    await page.keyboard.press("Escape");
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, label + "-light.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, label + "-phone.png") });
  results.errors = errors;
} finally {
  await browser.close();
  await server.close?.();
}
await writeFile(path.join(out, label + ".json"), JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results));
process.exit(0);
