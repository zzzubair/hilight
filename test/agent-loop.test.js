// The whole agent loop through the CLI alone: argv arrays to `child_process.spawn`, no shell, no
// agent harness, no hook or skill. Anything an agent can do in Hilight has to work this way, from
// any shell on any OS (CI also runs this file from PowerShell on Windows).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { VERSION } from "../src/cli.js";
import { serve } from "../src/server.js";
import { canonicalFile, sessionKey } from "../src/session-store.js";

const CLI = fileURLToPath(new URL("../bin/hilight.js", import.meta.url));

const BOARD = `<!doctype html><html><head><meta charset="utf-8"><title>Math</title></head><body>
<main data-hilight-board="Math">
  <section id="intro" data-card><h2>Intro</h2><p>Adds numbers.</p></section>
  <section id="add" data-card data-code="src/math.js:1-3"><h3>add</h3></section>
</main>
</body></html>`;

/** @param {string[]} args @param {NodeJS.ProcessEnv} env */
function hilight(args, env) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
}

test("an agent runs the whole review loop with plain CLI commands: open, listen, reply in-thread, mid-turn comments, catch-up", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hilight-agent-loop-"));
  const repo = path.join(dir, "repo");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await mkdir(path.join(repo, "src"));
  await writeFile(path.join(repo, "src", "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  const board = path.join(repo, "board.html");
  await writeFile(board, BOARD);
  const stateDir = path.join(dir, "state");
  await mkdir(stateDir);
  const server = await serve({
    port: 0,
    host: "127.0.0.1",
    stateFile: path.join(stateDir, "state.json"),
    version: VERSION,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const env = {
    ...process.env,
    HILIGHT_STATE_DIR: stateDir,
    HILIGHT_PORT: String(server.port),
    HILIGHT_HOST: "127.0.0.1",
    HILIGHT_LINK_HOST: "127.0.0.1",
    HILIGHT_TELEMETRY: "0",
    HILIGHT_NO_OPEN: "1",
  };
  const key = sessionKey(await canonicalFile(board));
  let promptCount = 0;
  // What the review page sends when the reviewer presses Send.
  const reviewerSends = (prompts) =>
    fetch(`${base}/api/${key}/prompts`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({
        prompts: prompts.map((prompt) => ({
          uid: "",
          text: "",
          selector: "",
          tag: "message",
          ...prompt,
          prompt_id: `p${++promptCount}`,
        })),
      }),
    }).then((response) => assert.equal(response.status, 200));
  const replyFile = (name, body) => writeFile(path.join(dir, name), body).then(() => path.join(dir, name));
  try {
    const stamped = await hilight(["board", "stamp", board], env);
    assert.equal(stamped.status, 0, stamped.stdout + stamped.stderr);
    const opened = await hilight([board, "--no-open"], env);
    assert.equal(opened.status, 0, opened.stdout + opened.stderr);

    // The reviewer comments on a card; the agent's poll gets one compact row with the thread id.
    await reviewerSends([
      {
        selector: "#intro",
        tag: "section",
        text: "Intro",
        prompt: "What does this add?",
        target: { type: "board-card", card: "intro", kind: "html", title: "Intro" },
      },
    ]);
    const first = await hilight(["poll", board, "--timeout-ms", "3000"], env);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /prompts\[1\]\{thread_id,on,text\}:\n {2}c1,"card: Intro",What does this add\?\n/);
    assert.match(first.stdout, /code_cards: all 1 unchanged\n/);
    assert.match(first.stdout, /canvas: no new marks/);
    assert.match(first.stdout, /--agent-reply-file <reply-file>/);
    assert.match(first.stdout, /Answer everything in one reply file/, "the first delivery carries the full guidance");
    assert.doesNotMatch(first.stdout, /dom_snapshot|harness|background-job/);

    // While the agent works, three more comments arrive. Its reply is held and they come back.
    await reviewerSends([{ thread_id: "c1", selector: "#intro", prompt: "Integers only?" }]);
    await reviewerSends([{ prompt: "Add a subtract card." }]);
    await reviewerSends([{ thread_id: "c1", selector: "#intro", prompt: "And floats?" }]);
    const held = await hilight(
      ["reply", board, "--agent-reply-file", await replyFile("r1.md", "## c1\nIt adds two numbers.\n")],
      env,
    );
    assert.equal(held.status, 0, held.stdout + held.stderr);
    assert.match(held.stdout, /status: held/);
    assert.match(held.stdout, /prompts\[3\]/);
    assert.match(held.stdout, /c1,"card: Intro",Integers only\?/);
    assert.match(held.stdout, /page,page,Add a subtract card\./);
    assert.match(held.stdout, /c1,"card: Intro",And floats\?/);
    assert.match(held.stdout, /Your reply was NOT posted/);

    // One reply answers all four; nothing is left for another turn.
    const sent = await hilight(
      [
        "reply",
        board,
        "--agent-reply-file",
        await replyFile("r2.md", "Added a subtract card.\n\n## c1\nIt adds two numbers, integers and floats alike.\n"),
      ],
      env,
    );
    assert.equal(sent.status, 0, sent.stdout + sent.stderr);
    assert.match(sent.stdout, /status: sent/);
    assert.match(sent.stdout, /threads\[1\]: c1/);
    const leftover = await hilight(["poll", board, "--timeout-ms", "300"], env);
    assert.match(leftover.stdout, /status: waiting/, "no comment is left over for another turn");

    // Next turn: only what changed. A thread reply comes alone with its anchor, never the earlier
    // back-and-forth, and the code card that changed since the last turn is named.
    await writeFile(path.join(repo, "src", "math.js"), "export function add(a, b) {\n  return a - b;\n}\n");
    await reviewerSends([{ thread_id: "c1", selector: "#intro", prompt: "Thanks." }]);
    const next = await hilight(["poll", board, "--timeout-ms", "3000"], env);
    assert.match(next.stdout, /prompts\[1\]\{thread_id,on,text\}:\n {2}c1,"card: Intro",Thanks\.\n/);
    assert.doesNotMatch(next.stdout, /What does this add|Integers only|integers and floats/);
    assert.match(next.stdout, /code_cards: "?1 of 1 changed since your last turn: add \(stale\)"?\n/);
    // The full guidance came with the first delivery; later ones get one line.
    assert.match(
      next.stdout,
      /Reply: `## <thread_id>` sections in a file, then `hilight poll .* --agent-reply-file <reply-file>`\. Lost context\? `hilight catch-up /,
    );
    assert.doesNotMatch(next.stdout, /Answer everything in one reply file/);

    // An agent without the earlier context asks for it once.
    const caught = await hilight(["catch-up", board], env);
    assert.equal(caught.status, 0, caught.stdout + caught.stderr);
    assert.match(caught.stdout, /board: Math/);
    assert.match(caught.stdout, /open_threads\[2\]\{thread_id,on,last,waiting\}:/);
    assert.match(caught.stdout, /c1,"card: Intro","user: Thanks\.",you/);
    assert.match(caught.stdout, /code_cards: "?1 of 1 changed since pinned: add \(stale\)"?\n/);
    const thread = await hilight(["catch-up", board, "c1"], env);
    assert.match(thread.stdout, /messages\[5\]\{from,text\}:/);
    assert.match(thread.stdout, /user,What does this add\?/);
    const unknown = await hilight(["catch-up", board, "c9"], env);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stdout, /Unknown comment thread c9/);
    assert.match(unknown.stdout, /Threads in this session: page, c1/);

    // A mistyped flag is refused, not silently ignored, and the error names the valid ones.
    const typo = await hilight(["poll", board, "--ful"], env);
    assert.equal(typo.status, 2);
    assert.match(typo.stdout, /Unknown flag for `hilight poll`: --ful/);
    assert.match(typo.stdout, /Valid flags: --takeover, --full/);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
