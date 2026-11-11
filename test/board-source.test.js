import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkCodeCard,
  codeRangeHash,
  parseBoardHtml,
  parseCodeRef,
  readBoard,
  stampBoardFile,
} from "../src/board-source.js";

const SOURCE = ["export function a() {", "  return 1;", "}", "", "export function b() {", "  return 2;", "}"].join(
  "\n",
);

function board(cards) {
  return `<!doctype html><html><head><title>Arch</title><style>body{color:#111}</style></head><body>
<main data-hilight-board="Architecture">
${cards}
</main>
</body></html>`;
}

async function repo(t, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hilight-board-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, ".git"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

test("parseCodeRef accepts colon and #L forms and rejects nonsense", () => {
  assert.deepEqual(parseCodeRef("src/server.js:120-180"), { path: "src/server.js", start: 120, end: 180 });
  assert.deepEqual(parseCodeRef("src/a.js#L5-L9"), { path: "src/a.js", start: 5, end: 9 });
  assert.deepEqual(parseCodeRef("src/a.js:7"), { path: "src/a.js", start: 7, end: 7 });
  assert.equal(parseCodeRef("src/a.js"), null);
  assert.equal(parseCodeRef("src/a.js:9-3"), null);
  assert.equal(parseCodeRef("src/a.js:0-3"), null);
});

test("parseBoardHtml returns null for an ordinary page", () => {
  assert.equal(parseBoardHtml("<html><body><main><section data-card>x</section></main></body></html>"), null);
});

test("parseBoardHtml reads cards, kinds, titles, nesting and layout", () => {
  const model = parseBoardHtml(
    board(`
  <section id="cli" data-card data-x="0" data-y="0" data-w="300" data-h="200"><h2>CLI</h2><p>Spawns <b>the server</b>.</p></section>
  <section id="srv" data-card data-code="src/a.js:1-3" data-hash="abc"><h3>Server</h3><p>Routes live here.</p><pre data-snapshot><code>old</code></pre></section>
  <section id="inside" data-card="board" data-title="Inside">
    <p>Zoom in.</p>
    <section id="deep" data-card><h4>Deep</h4><p>Nested card</p></section>
  </section>`),
  );
  assert.ok(model);
  assert.equal(model.title, "Architecture");
  assert.match(model.head, /<style>body\{color:#111\}<\/style>/);
  assert.doesNotMatch(model.head, /<title>/);
  assert.deepEqual(
    model.levels.map((level) => [level.id, level.title, level.parent]),
    [
      ["", "Architecture", null],
      ["inside", "Inside", ""],
    ],
  );
  const byId = Object.fromEntries(model.cards.map((card) => [card.id, card]));
  assert.equal(byId.cli.kind, "html");
  assert.equal(byId.cli.title, "CLI");
  // The heading becomes the title, so the body does not repeat it.
  assert.equal(byId.cli.html, "<p>Spawns <b>the server</b>.</p>");
  assert.deepEqual([byId.cli.x, byId.cli.y, byId.cli.w, byId.cli.h], [0, 0, 300, 200]);
  assert.equal(byId.srv.kind, "code");
  assert.equal(byId.srv.note, "Routes live here.");
  assert.deepEqual(byId.srv.code.snapshot, ["old"]);
  assert.equal(byId.srv.code.pinned, "abc");
  assert.equal(byId.inside.kind, "board");
  assert.equal(byId.inside.note, "Zoom in.");
  assert.equal(byId.inside.board.count, 1);
  assert.equal(byId.deep.level, "inside");
  // Unplaced cards flow below the placed ones instead of overlapping them.
  assert.ok(byId.srv.y >= 200);
});

test("checkCodeCard reports fresh, unpinned, stale, moved and missing", () => {
  const lines = SOURCE.split("\n");
  const pinnedLines = lines.slice(0, 3);
  const pin = codeRangeHash(pinnedLines);
  const code = { path: "a.js", start: 1, end: 3, pinned: pin, snapshot: pinnedLines };
  assert.equal(checkCodeCard(code, { lines }).status, "fresh");
  assert.equal(checkCodeCard({ ...code, pinned: null }, { lines }).status, "unpinned");
  const edited = ["export function a() {", "  return 42;", "}", ...lines.slice(3)];
  const stale = checkCodeCard(code, { lines: edited });
  assert.equal(stale.status, "stale");
  assert.deepEqual(stale.snapshot, pinnedLines);
  const shifted = ["// header", "// more", ...lines];
  const moved = checkCodeCard(code, { lines: shifted });
  assert.equal(moved.status, "moved");
  assert.deepEqual(moved.moved_to, { start: 3, end: 5 });
  assert.equal(checkCodeCard(code, { error: "file not found" }).status, "missing");
  assert.equal(checkCodeCard({ ...code, start: 50, end: 60, snapshot: null }, { lines }).status, "missing");
  // A range past the end whose pinned lines still exist elsewhere has moved, not vanished.
  assert.equal(checkCodeCard({ ...code, start: 50, end: 52 }, { lines }).status, "moved");
  // Trailing whitespace is not a change.
  assert.equal(checkCodeCard(code, { lines: lines.map((line) => line + "  ") }).status, "fresh");
});

test("readBoard reads pinned code from the repository root and flags stale ranges", async (t) => {
  const pin = codeRangeHash(SOURCE.split("\n").slice(4, 7));
  const dir = await repo(t, {
    "src/a.js": SOURCE,
    ".hilight/board.html": board(`
  <section id="b" data-card data-code="src/a.js:5-7" data-hash="${pin}"><h3>b()</h3></section>
  <section id="a" data-card data-code="src/a.js:1-3" data-hash="000000000000"><h3>a()</h3></section>
  <section id="gone" data-card data-code="src/missing.js:1-2"><h3>gone</h3></section>
  <section id="escape" data-card data-code="../outside.js:1-2"><h3>escape</h3></section>`),
  });
  await writeFile(path.join(path.dirname(dir), "outside.js"), "secret\nsecret\n").catch(() => {});
  const model = await readBoard(path.join(dir, ".hilight/board.html"));
  assert.ok(model);
  const byId = Object.fromEntries(model.cards.map((card) => [card.id, card]));
  assert.equal(byId.b.code.status, "fresh");
  assert.deepEqual(byId.b.code.lines, ["export function b() {", "  return 2;", "}"]);
  assert.equal(byId.a.code.status, "stale");
  assert.equal(byId.gone.code.status, "missing");
  assert.equal(byId.escape.code.status, "missing");
  assert.equal(byId.escape.code.lines.length, 0);
  assert.match(byId.escape.code.error, /outside the repository/);
  assert.match(model.revision, /^[0-9a-f]{16}$/);
});

test("readBoard never follows a symlink out of the repository", async (t) => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "hilight-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "secret.txt"), "top secret\n");
  const dir = await repo(t, {
    "board.html": board(`<section id="s" data-card data-code="link/secret.txt:1"><h3>s</h3></section>`),
  });
  await symlink(outside, path.join(dir, "link"));
  const model = await readBoard(path.join(dir, "board.html"));
  assert.equal(model?.cards[0].code.status, "missing");
  assert.deepEqual(model?.cards[0].code.lines, []);
});

test("stampBoardFile pins unpinned cards, writes a snapshot, and leaves stale pins alone", async (t) => {
  const dir = await repo(t, {
    "src/a.js": SOURCE,
    "board.html": board(`  <section id="a" data-card data-code="src/a.js:1-3">
    <h3>a()</h3>
  </section>
  <section id="b" data-card data-code="src/a.js:5-7" data-hash="000000000000"><h3>b()</h3></section>`),
  });
  const file = path.join(dir, "board.html");
  const first = await stampBoardFile(file);
  assert.ok(first);
  assert.deepEqual(
    first.cards.map((card) => [card.card, card.status]),
    [
      ["a", "pinned"],
      ["b", "stale"],
    ],
  );
  const written = await readFile(file, "utf8");
  const pin = codeRangeHash(SOURCE.split("\n").slice(0, 3));
  assert.match(written, new RegExp(`data-code="src/a.js:1-3" data-hash="${pin}"`));
  assert.match(written, /<pre data-snapshot><code>export function a\(\) \{\n {2}return 1;\n\}<\/code><\/pre>/);
  assert.match(written, /data-hash="000000000000"/);
  const model = await readBoard(file);
  assert.equal(model?.cards.find((card) => card.id === "a")?.code.status, "fresh");

  // Stamping again changes nothing.
  const second = await stampBoardFile(file);
  assert.equal(second?.changed, false);
  assert.equal(second?.cards[0].status, "ok");

  // --repin accepts the current lines.
  const repinned = await stampBoardFile(file, { repin: true });
  assert.equal(repinned?.cards.find((card) => card.card === "b")?.status, "repinned");
  const after = await readBoard(file);
  assert.equal(after?.cards.find((card) => card.id === "b")?.code.status, "fresh");
});

test("stampBoardFile reports a moved range and --repin follows it", async (t) => {
  const dir = await repo(t, {
    "src/a.js": SOURCE,
    "board.html": board(`<section id="a" data-card data-code="src/a.js:1-3"><h3>a()</h3></section>`),
  });
  const file = path.join(dir, "board.html");
  await stampBoardFile(file);
  await writeFile(path.join(dir, "src/a.js"), `// one\n// two\n${SOURCE}`);
  const report = await stampBoardFile(file);
  assert.equal(report?.cards[0].status, "moved");
  assert.equal(report?.cards[0].moved_to, "src/a.js:3-5");
  assert.equal(report?.changed, false);
  const repinned = await stampBoardFile(file, { repin: true });
  assert.equal(repinned?.cards[0].status, "repinned");
  assert.match(await readFile(file, "utf8"), /data-code="src\/a.js:3-5"/);
});
