import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runBrowserE2e = process.env.HILIGHT_BROWSER_E2E === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(repoRoot, "test/fixtures/layout-audit");

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

// `chrome-devtools-axi wait <ms>` fails with "fn is not a function" in 0.1.34, so settle times sleep here.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

test(
  "real browser layout audit stays silent on acceptable pages and reports one severe root per broken case",
  { skip: !runBrowserE2e, timeout: 480_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-layout-browser-"));
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
      CHROME_DEVTOOLS_AXI_SESSION: `lavish-layout-${process.pid}`,
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, "chrome"),
    };

    function openArtifact(file) {
      const output = run(process.execPath, ["bin/hilight.js", file, "--no-open"], lavishEnv);
      const url = output.match(/url:\s*"([^"]+)"/)?.[1];
      assert.ok(url, output);
      return { file, url };
    }

    // Each audit gets its own copy of the fixture, so its warning inbox is a fresh session rather
    // than an accumulation across the viewport classes this corpus sweeps.
    let auditRun = 0;
    async function openFixture(name) {
      const file = path.join(temp, `${name}-${++auditRun}.html`);
      await copyFile(path.join(fixtures, `${name}.html`), file);
      return openArtifact(file);
    }

    // `open` returns once the page's accessibility tree is ready, and gives up after 10s on a page
    // that is deliberately slow (real-heavy-clean). The navigation has happened by then, and the
    // audit's own settle and inbox read decide the result, so only that timeout is tolerated.
    function openPage(url) {
      const result = spawnSync("chrome-devtools-axi", ["open", url], {
        cwd: repoRoot,
        env: { ...process.env, ...chromeEnv },
        encoding: "utf8",
        timeout: 45_000,
      });
      if (result.error) throw result.error;
      const output = `${result.stdout || ""}${result.stderr || ""}`;
      if (result.status !== 0 && !/waiting for the accessibility tree/.test(output)) {
        assert.fail(`chrome-devtools-axi open ${url}\n${output}`);
      }
    }

    function readInbox() {
      const output = run(
        "chrome-devtools-axi",
        [
          "eval",
          'JSON.stringify({ gate: document.body.classList.contains("layout-gate-active"), wrapHidden: document.getElementById("warningsWrap").hidden, badge: document.getElementById("warningsCount").textContent })',
        ],
        chromeEnv,
      );
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

    // The audit's detection calibration is unchanged; what changed is where findings land. A
    // severe result now fills the passive inbox and reveals the artifact, and it must never make
    // the poll return - only the user queueing a fix does that.
    async function audit(name, viewport, settleMs, expectedCount) {
      const { file, url } = await openFixture(name);
      // chrome-devtools-axi 0.1.34 refuses `emulate` until a page is selected.
      if (auditRun === 1) run("chrome-devtools-axi", ["open", "data:text/html,"], chromeEnv);
      run("chrome-devtools-axi", ["emulate", "--viewport", viewport], chromeEnv);
      openPage(url);
      sleep(settleMs);
      let inbox = readInbox();
      // A busy browser can return from navigation before the refreshed chrome has painted its
      // first diagnostic result. Re-open once when the gate is still checking (or a warning-count
      // assertion is otherwise not ready), then keep the final gate assertion strict.
      if (inbox.gate || (expectedCount > 0 && Number(inbox.badge) !== expectedCount)) {
        openPage(url);
        sleep(settleMs);
        inbox = readInbox();
      }
      const poll = run(process.execPath, ["bin/hilight.js", "poll", file, "--timeout-ms", "600"], lavishEnv);

      assert.equal(inbox.gate, false, `${name}: the artifact is always revealed after a completed pass`);
      assert.equal(Number(inbox.badge), expectedCount, name);
      assert.equal(inbox.wrapHidden, expectedCount === 0, name);
      assert.match(poll, /status:\s*waiting/, `${name}: detection alone must never wake an agent`);
      assert.doesNotMatch(poll, /layout_warnings\[/, name);
      return { inbox, poll };
    }

    try {
      await audit("control-broken-occlusion", "1440x1000x1", 3200, 1);

      const acceptable = [
        "real-plan-clean",
        "real-dashboard",
        "real-editorial",
        "real-carousel",
        "occlusion-exclusions-clean",
        "real-poster-overlap",
        "real-animated-entry",
      ];
      for (const name of acceptable) {
        const settleMs = name === "real-animated-entry" ? 5200 : 3200;
        await audit(name, "1440x1000x1", settleMs, 0);
        await audit(name, "390x844x1,mobile,touch", settleMs, 0);
      }

      await audit("control-broken-overflow", "1440x1000x1", 3200, 0);
      await audit("control-broken-overflow", "390x844x1,mobile,touch", 3200, 1);
      await audit("control-broken-clipping", "1440x1000x1", 3200, 3);
      await audit("control-broken-clipping", "390x844x1,mobile,touch", 3200, 3);
      await audit("control-broken-reachability", "1440x1000x1", 3200, 3);
      await audit("control-broken-reachability", "390x844x1,mobile,touch", 3200, 3);

      await audit("calibration-small-overflow", "390x844x1,mobile,touch", 3200, 0);

      // A slow page whose audit outruns the gate hold still reveals: a delayed audit is
      // uncertainty, never evidence of a defect.
      await audit("real-heavy-clean", "1440x1000x1", 16_000, 0);

      // A repair clears the inbox only through a newer artifact load plus a complete pass at the
      // same viewport - and it does so without the agent ever having been woken.
      const revalidationFile = path.join(temp, "root-lock-revalidation.html");
      await copyFile(path.join(fixtures, "control-broken-reachability.html"), revalidationFile);
      const revalidation = openArtifact(revalidationFile);
      run("chrome-devtools-axi", ["emulate", "--viewport", "390x844x1,mobile,touch"], chromeEnv);
      run("chrome-devtools-axi", ["open", revalidation.url], chromeEnv);
      sleep(3200);
      const detected = readInbox();
      assert.equal(Number(detected.badge), 3);
      assert.equal(detected.gate, false);
      assert.match(
        run(process.execPath, ["bin/hilight.js", "poll", revalidationFile, "--timeout-ms", "600"], lavishEnv),
        /status:\s*waiting/,
      );

      await writeFile(
        revalidationFile,
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Repaired controls</title></head><body><button>Continue</button></body></html>',
      );
      sleep(4500);
      const repaired = readInbox();
      assert.equal(Number(repaired.badge), 0);
      assert.equal(repaired.wrapHidden, true);
      assert.equal(repaired.gate, false);
    } finally {
      run(process.execPath, ["bin/hilight.js", "stop", "--port", String(port)], lavishEnv, 15_000);
      run("chrome-devtools-axi", ["stop"], chromeEnv);
      await rm(temp, { recursive: true, force: true });
    }
  },
);
