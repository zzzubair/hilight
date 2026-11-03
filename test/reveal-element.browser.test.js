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

// The sandboxed artifact reports its own geometry. The test never weakens the iframe sandbox
// or reaches through it from the chrome. Its deliberately smooth CSS also tests reduced motion.
const ARTIFACT_HTML = `<!doctype html>
<html data-lavish-annotate="off"><head><meta charset="utf-8"><title>Reveal regression</title>
<style>
html { scroll-behavior: smooth; background: #f7f3ea; color: #171a21; font: 18px/1.5 system-ui; }
body { margin: 40px; } h1 { font-size: 32px; }
section { box-sizing: border-box; padding: 24px; border: 1px solid #8c96aa; background: #fffbf3; }
.space { height: 1600px; }
#scroller { height: 240px; overflow: auto; scroll-behavior: smooth; }
</style>
<script type="application/json" data-lavish-revisions>[{"id":"r1","label":"Updated sections"}]</script>
</head><body><h1>Reveal regression</h1><p>Two revised blocks below the fold.</p>
<div class="space"></div><section id="first" data-lavish-revision="r1">First changed block</section>
<div class="space"></div><section id="second" data-lavish-revision="r1">Second changed block</section>
<div class="space"></div><div id="scroller"><div class="space"></div>
<section id="nested">Nested scroll target</section><div class="space"></div></div><div class="space"></div>
<script>
const nativeScrollIntoView = Element.prototype.scrollIntoView;
let lastBehavior;
Element.prototype.scrollIntoView = function(options) {
  lastBehavior = options.behavior;
  return nativeScrollIntoView.call(this, options);
};
window.addEventListener('message', async (event) => {
  if (event.source !== parent || event.data.type !== 'reveal-probe') return;
  const { id, selector, action, reduced } = event.data;
  if (action === 'motion') {
    const nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = query => query === '(prefers-reduced-motion: reduce)'
      ? { matches: reduced } : nativeMatchMedia(query);
  }
  if (action === 'scroll') window.scrollBy({ top: 80, behavior: 'instant' });
  if (action === 'nested-scroll') document.getElementById('scroller').scrollTop += 60;
  if (action === 'resize-target') document.querySelector(selector).style.padding = '48px';
  if (action === 'remove') document.querySelector(selector).remove();
  await new Promise(resolve => setTimeout(resolve, action === 'expire' ? 2600 : 900));
  const root = document.querySelector('[data-lavish-ui="annotation-root"]')?.shadowRoot;
  const markers = root ? [...root.querySelectorAll('.lavish-reveal-marker')] : [];
  const target = document.querySelector(selector);
  const rect = target?.getBoundingClientRect();
  const marker = markers[0]?.getBoundingClientRect();
  parent.postMessage({ type: 'reveal-probe-result', id, count: markers.length, lastBehavior,
    excluded: !!root?.host.closest('[data-lavish-ui]'),
    animation: markers[0] ? getComputedStyle(markers[0]).animationName : null,
    visible: !!rect && rect.top >= 0 && rect.bottom <= innerHeight,
    error: rect && marker ? Math.max(...['left','top','width','height'].map(k => Math.abs(rect[k] - marker[k]))) : null
  }, '*');
});
</script></body></html>`;

test(
  "Reveal tracks off-screen revision blocks, later scrolling, nested scrolling and reduced motion",
  { skip: !runBrowserE2e, timeout: 180_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-reveal-e2e-"));
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
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-reveal-e2e-${process.pid}`,
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
    function probe(selector, { action = "", reveal = false, revision = 0, reduced = false } = {}) {
      return evaluate(`async () => {
        const frame = document.getElementById('artifact');
        const id = Math.random().toString(36);
        const response = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { window.removeEventListener('message', handler); reject(new Error('probe timeout')); }, 10000);
          function handler(event) {
            if (event.source !== frame.contentWindow || event.data.type !== 'reveal-probe-result' || event.data.id !== id) return;
            clearTimeout(timeout); window.removeEventListener('message', handler); resolve(event.data);
          }
          window.addEventListener('message', handler);
        });
        for (let i = 0; i < ${revision}; i++) document.querySelector('.revision-reveal').click();
        ${reveal ? `frame.contentWindow.postMessage({ type: 'lavish:revealElement', selector: ${JSON.stringify(selector)} }, '*');` : ""}
        frame.contentWindow.postMessage({ type: 'reveal-probe', id, selector: ${JSON.stringify(selector)}, action: ${JSON.stringify(action)}, reduced: ${reduced} }, '*');
        return JSON.stringify(await response);
      }`);
    }
    function aligned(result) {
      assert.equal(result.count, 1, JSON.stringify(result));
      assert.equal(result.visible, true, JSON.stringify(result));
      assert.ok(result.error <= 1, `marker must cover the target: ${JSON.stringify(result)}`);
      assert.equal(result.excluded, true, "the marker stays inside excluded Lavish UI");
    }

    try {
      const artifact = path.join(temp, "review.html");
      await writeFile(artifact, ARTIFACT_HTML);
      const output = run(process.execPath, ["bin/lavish-axi.js", artifact, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);
      browser("open", url);
      browser("emulate", "--viewport", "1440x1000x1");
      evaluate(`async () => { await new Promise(resolve => setTimeout(resolve, 4000)); return JSON.stringify(true); }`);
      evaluate(`() => { document.getElementById('revisionsButton').click(); return JSON.stringify(true); }`);

      const first = probe("#first", { revision: 1 });
      if (process.env.LAVISH_AXI_REVEAL_SCREENSHOT) {
        await mkdir(path.dirname(process.env.LAVISH_AXI_REVEAL_SCREENSHOT), { recursive: true });
        browser("screenshot", process.env.LAVISH_AXI_REVEAL_SCREENSHOT);
      }
      aligned(first);
      assert.equal(first.lastBehavior, "smooth");
      aligned(probe("#first", { action: "scroll" }));
      aligned(probe("#second", { revision: 1 }));
      aligned(probe("#first", { revision: 3 }));

      // Change the preference inside the fixture, leaving CSS scroll-behavior smooth.
      probe("#first", { action: "motion", reduced: true });
      const reduced = probe("#second", { reveal: true });
      aligned(reduced);
      assert.equal(reduced.lastBehavior, "instant", "reduced motion overrides CSS smooth scrolling");
      assert.equal(reduced.animation, "none", "reduced motion avoids the highlight pulse");
      aligned(probe("#second", { reveal: true, action: "resize-target" }));
      aligned(probe("#nested", { reveal: true }));
      aligned(probe("#nested", { action: "nested-scroll" }));
      assert.equal(probe("#nested", { action: "expire" }).count, 0);
      aligned(probe("#second", { reveal: true }));
      assert.equal(probe("#second", { action: "remove" }).count, 0);
    } finally {
      run(process.execPath, ["bin/lavish-axi.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      browser("stop");
      await rm(temp, { recursive: true, force: true });
    }
  },
);
