// A server restart in the middle of a review, end to end: the agent's poll rides it out and still
// gets a comment sent afterwards, server.log keeps why it happened, `hilight status` and
// `hilight log` explain it, the page is told why the agent stopped listening, and a poll that
// cannot reconnect fails with the cause and the log lines inline.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once, on } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocket } from "ws";

import { VERSION } from "../src/cli.js";
import { serve } from "../src/server.js";
import { canonicalFile, sessionKey } from "../src/session-store.js";

const CLI = fileURLToPath(new URL("../bin/hilight.js", import.meta.url));

/** @param {string[]} args @param {NodeJS.ProcessEnv} env */
function spawnHilight(args, env) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  const run = { stdout: "", stderr: "", status: /** @type {number | null} */ (null) };
  child.stdout.setEncoding("utf8").on("data", (chunk) => (run.stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (run.stderr += chunk));
  const done = new Promise((resolve) =>
    child.on("close", (status) => {
      run.status = status;
      resolve(run);
    }),
  );
  return { child, run, done };
}

/** @param {() => boolean} predicate @param {string} label */
async function until(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hilight-restart-"));
  const stateDir = path.join(dir, "state");
  await mkdir(stateDir);
  const page = path.join(dir, "page.html");
  await writeFile(page, "<!doctype html><html><body><p id='a'>Hello</p></body></html>");
  const stateFile = path.join(stateDir, "state.json");
  const start = (port = 0) => serve({ port, host: "127.0.0.1", stateFile, version: VERSION });
  const server = await start();
  const env = {
    ...process.env,
    HILIGHT_STATE_DIR: stateDir,
    HILIGHT_PORT: String(server.port),
    HILIGHT_HOST: "127.0.0.1",
    HILIGHT_LINK_HOST: "127.0.0.1",
    HILIGHT_TELEMETRY: "0",
    HILIGHT_NO_OPEN: "1",
  };
  const key = sessionKey(await canonicalFile(page));
  return { dir, stateDir, page, server, start, env, key, logFile: path.join(stateDir, "server.log") };
}

/** @param {string} base @param {string} key @param {string} text */
function reviewerSends(base, key, text) {
  return fetch(`${base}/api/${key}/prompts`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      prompts: [{ uid: "", text: "", selector: "", tag: "message", prompt: text, prompt_id: "p1" }],
    }),
  }).then((response) => assert.equal(response.status, 200));
}

/** The first `agent-presence` event a freshly opened page receives. */
async function pagePresence(base, key) {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/events/${key}`, { origin: base });
  const messages = on(socket, "message");
  await once(socket, "open");
  try {
    for await (const [raw] of messages) {
      const message = JSON.parse(String(raw));
      if (message.type === "agent-presence") return message.data ?? message;
    }
  } finally {
    socket.close();
  }
  return null;
}

test("a poll rides out a server restart, and the log, status and page all say why", async () => {
  const ctx = await setup();
  let server = ctx.server;
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const opened = spawnHilight([ctx.page, "--no-open"], ctx.env);
    assert.equal((await opened.done).status, 0, opened.run.stdout + opened.run.stderr);

    const poll = spawnHilight(["poll", ctx.page], ctx.env);
    await until(() => /\[hilight\]/.test(poll.run.stderr), "the poll banner");

    // The supervisor restarts the server: SIGTERM, then a new process on the same port and state.
    await server.stop("SIGTERM: stopped by its supervisor or a kill");
    server = await ctx.start(Number(new URL(base).port));
    await until(() => /Reconnected/.test(poll.run.stderr), "the poll to reconnect");
    assert.match(poll.run.stderr, /Lost the server: the server stopped at \S+: SIGTERM/);

    // A comment sent after the restart still reaches the same poll.
    await reviewerSends(base, ctx.key, "Still there?");
    const result = await poll.done;
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Still there\?/);

    // server.log kept the reason, in order, for this session and for the server.
    const log = await readFile(ctx.logFile, "utf8");
    const order = [
      new RegExp(`${ctx.key} listen-end the server stopped \\(SIGTERM`),
      / - server-stop SIGTERM: stopped by its supervisor or a kill, pid \d+, up /,
      / - server-start pid \d+, v[^,]+, port \d+, previous server: SIGTERM/,
      new RegExp(`${ctx.key} listen reconnected after the server went away`),
      new RegExp(`${ctx.key} delivered 1 comment \\(page\\)`),
    ];
    let from = 0;
    for (const pattern of order) {
      const index = log.slice(from).search(pattern);
      assert.notEqual(index, -1, `server.log is missing ${pattern} after offset ${from}:\n${log}`);
      from += index;
    }

    // status and log explain it without the agent reading server.log itself.
    const status = await spawnHilight(["status", ctx.page], ctx.env).done;
    assert.equal(status.status, 0, status.stdout);
    assert.match(status.stdout, /server: "running, pid \d+/);
    assert.match(status.stdout, /last_restart: ".*the server before it: SIGTERM/);
    assert.match(status.stdout, /last_delivery: ".*1 comment \(page\)"/);
    assert.match(status.stdout, /queued: 0 comments waiting for the agent/);
    const history = await spawnHilight(["log", ctx.page, "--since", "1h"], ctx.env).done;
    assert.equal(history.status, 0, history.stdout);
    assert.match(history.stdout, /events\[\d+\]\{at,event,detail\}:/);
    assert.match(history.stdout, /server-stop,"SIGTERM/);
    assert.match(history.stdout, /listen,reconnected after the server went away/);
    const badSince = await spawnHilight(["log", ctx.page, "--since", "soon"], ctx.env).done;
    assert.equal(badSince.status, 2);

    // The agent's poll is gone when the server comes back (its turn ended during the outage). The
    // page is told since when and why nobody is listening, not a bare "Not listening".
    const lastPoll = spawnHilight(["poll", ctx.page], ctx.env);
    await until(() => /\[hilight\]/.test(lastPoll.run.stderr), "the second poll banner");
    await server.stop("SIGTERM: stopped by its supervisor or a kill");
    lastPoll.child.kill("SIGKILL");
    await lastPoll.done;
    server = await ctx.start(Number(new URL(base).port));
    const presence = await pagePresence(base, ctx.key);
    assert.equal(presence?.state, "waiting");
    assert.match(String(presence?.why), /^the server stopped \(SIGTERM/);
    assert.ok(Date.parse(String(presence?.since)) > 0, "the page knows since when");
  } finally {
    await server.close();
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("a poll that cannot reconnect fails with the cause and the log lines inline", async () => {
  const ctx = await setup();
  try {
    const opened = spawnHilight([ctx.page, "--no-open"], ctx.env);
    assert.equal((await opened.done).status, 0, opened.run.stdout + opened.run.stderr);
    const poll = spawnHilight(["poll", ctx.page], { ...ctx.env, HILIGHT_POLL_RECONNECT_MS: "1500" });
    await until(() => /\[hilight\]/.test(poll.run.stderr), "the poll banner");
    await ctx.server.stop("SIGTERM: stopped by its supervisor or a kill");
    const result = await poll.done;
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^error: The Hilight server went away and did not come back within 1\.5s$/m);
    assert.match(result.stdout, /^why: "the server stopped at \S+: SIGTERM/m);
    assert.match(result.stdout, /^code: SERVER_ERROR$/m);
    assert.match(result.stdout, /Re-run `hilight poll .*` once the server is up: queued feedback is kept/);
    assert.match(result.stdout, /^log\[\d\]:$/m);
    assert.match(result.stdout, / - server-stop SIGTERM/);
    assert.match(result.stdout, /Inspect `.*server\.log`/, "the log exists, so the hint points at it");
  } finally {
    await ctx.server.close().catch(() => {});
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

test("`hilight stop` stops a listening poll too, instead of the poll starting the server again", async () => {
  const ctx = await setup();
  const base = `http://127.0.0.1:${ctx.server.port}`;
  try {
    const opened = spawnHilight([ctx.page, "--no-open"], ctx.env);
    assert.equal((await opened.done).status, 0, opened.run.stdout + opened.run.stderr);
    const poll = spawnHilight(["poll", ctx.page], ctx.env);
    await until(() => /\[hilight\]/.test(poll.run.stderr), "the poll banner");
    const stopped = await spawnHilight(["stop"], ctx.env).done;
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    const result = await poll.done;
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^error: "The Hilight server was stopped, so this poll stopped too"$/m);
    assert.match(result.stdout, /^why: ".*stopped with `hilight stop`/m);
    assert.doesNotMatch(result.stderr, /Reconnecting/);
    await assert.rejects(fetch(`${base}/health`), "nothing started the server again");
  } finally {
    await ctx.server.close().catch(() => {});
    await rm(ctx.dir, { recursive: true, force: true });
  }
});
