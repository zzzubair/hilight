import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.HILIGHT_HOST = "127.0.0.1";
process.env.HILIGHT_LINK_HOST = "127.0.0.1";

import { BOARD_SCENE_INDEX } from "../src/board-core.js";
import { stampBoardFile } from "../src/board-source.js";
import { isWhiteboardWriteApiPath, serve } from "../src/server.js";

const CODE = ["export function add(a, b) {", "  return a + b;", "}", ""].join("\n");
const BOARD = `<!doctype html><html><head><title>Math</title></head><body>
<main data-hilight-board="Math">
  <section id="intro" data-card><h2>Intro</h2><p>Adds numbers.</p></section>
  <section id="add" data-card data-code="src/math.js:1-3"><h3>add</h3></section>
</main>
</body></html>`;

async function startBoardServer({ html = BOARD } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "hilight-board-server-"));
  const repo = path.join(dir, "repo");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await mkdir(path.join(repo, "src"));
  await mkdir(path.join(repo, "docs"));
  await writeFile(path.join(repo, "src", "math.js"), CODE);
  const file = path.join(repo, "docs", "board.html");
  await writeFile(file, html);
  const server = await serve({ port: 0, stateFile: path.join(dir, "state.json"), version: "9.9.9-test" });
  const base = `http://127.0.0.1:${server.port}`;
  const opened = await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file }),
  }).then((res) => res.json());
  return {
    repo,
    file,
    base,
    key: opened.key,
    async close() {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("GET /api/:key/board reads code cards live and reports a changed pin as stale", async () => {
  const ctx = await startBoardServer();
  try {
    await stampBoardFile(ctx.file, { write: true });
    const fresh = await fetch(`${ctx.base}/api/${ctx.key}/board`).then((res) => res.json());
    assert.equal(fresh.board.title, "Math");
    assert.deepEqual(
      fresh.board.cards.map((card) => [card.id, card.kind]),
      [
        ["intro", "html"],
        ["add", "code"],
      ],
    );
    const add = fresh.board.cards.find((card) => card.id === "add");
    assert.equal(add.code.status, "fresh");
    assert.deepEqual(add.code.lines, ["export function add(a, b) {", "  return a + b;", "}"]);

    await writeFile(path.join(ctx.repo, "src", "math.js"), CODE.replace("a + b", "a - b"));
    const stale = await fetch(`${ctx.base}/api/${ctx.key}/board`).then((res) => res.json());
    const changed = stale.board.cards.find((card) => card.id === "add");
    assert.equal(changed.code.status, "stale");
    assert.equal(changed.code.lines[1], "  return a - b;");
    // The revision follows the board file, not the code, so a code change refreshes
    // the cards without resetting the reviewer's saved scene.
    assert.equal(stale.board.revision, fresh.board.revision);

    // The board route reads; it never rewrites the artifact.
    assert.match(await readFile(ctx.file, "utf8"), /data-hash="[0-9a-f]{12}"/);
  } finally {
    await ctx.close();
  }
});

test("GET /api/:key/board refuses a foreign origin and a page that is not a board", async () => {
  const ctx = await startBoardServer();
  try {
    const foreign = await fetch(`${ctx.base}/api/${ctx.key}/board`, { headers: { origin: "https://evil.example" } });
    assert.equal(foreign.status, 403);
    await writeFile(ctx.file, "<!doctype html><html><body><h1>Plain page</h1></body></html>");
    const plain = await fetch(`${ctx.base}/api/${ctx.key}/board`);
    assert.equal(plain.status, 404);
    const missing = await fetch(`${ctx.base}/api/0123456789abcdef/board`);
    assert.equal(missing.status, 404);
  } finally {
    await ctx.close();
  }
});

test("the board scene uses one reserved whiteboard index everywhere", async () => {
  assert.equal(isWhiteboardWriteApiPath(`/api/0123456789abcdef/whiteboard/${BOARD_SCENE_INDEX}`), true);
  const chrome = await readFile(new URL("../src/chrome-client.js", import.meta.url), "utf8");
  assert.match(chrome, new RegExp(`const BOARD_SCENE_INDEX = ${BOARD_SCENE_INDEX};`));
});
