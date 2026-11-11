import assert from "node:assert/strict";
import test from "node:test";

import {
  cardElementId,
  codeColumns,
  codeChromeWidth,
  codeLinesUnder,
  codeRows,
  CODE_CARD_LAYOUT,
  createCardElement,
  diffCodeLines,
  normalizeBoardCanvasTarget,
  normalizeBoardCardTarget,
  reconcileLevelElements,
  summarizeBoardMarks,
} from "../src/board-core.js";

const cli = { id: "cli", level: "", kind: "html", title: "CLI", x: 0, y: 0, w: 300, h: 200 };
const server = {
  id: "server",
  level: "",
  kind: "code",
  title: "Artifact route",
  x: 500,
  y: 0,
  w: 500,
  h: 400,
  note: "",
  code: { path: "src/server.js", start: 100, end: 119, lines: Array.from({ length: 20 }, (_, i) => `line ${i}`) },
};
const deep = { id: "deep", level: "inside", kind: "html", title: "Deep", x: 0, y: 0, w: 300, h: 200 };
const board = {
  levels: [
    { id: "", title: "Architecture", parent: null },
    { id: "inside", title: "Inside", parent: "" },
  ],
  cards: [cli, server, { id: "inside", level: "", kind: "board", title: "Inside", x: 0, y: 500, w: 300, h: 200 }, deep],
};

function arrow(id, from, to, points, extra = {}) {
  return {
    id,
    type: "arrow",
    x: points[0][0],
    y: points[0][1],
    points: points.map(([x, y]) => [x - points[0][0], y - points[0][1]]),
    startBinding: from ? { elementId: cardElementId(from) } : null,
    endBinding: to ? { elementId: cardElementId(to) } : null,
    customData: { boardLevel: "" },
    ...extra,
  };
}

test("reconcileLevelElements keeps a reviewer's move until the file moves the card", () => {
  const moved = { ...createCardElement(cli), x: 40, y: 60 };
  const link = arrow("a1", "cli", "server", [
    [340, 160],
    [500, 100],
  ]);
  const kept = reconcileLevelElements([cli, server], [moved, link]);
  const keptCli = kept.find((element) => element.id === cardElementId("cli"));
  assert.deepEqual([keptCli.x, keptCli.y], [40, 60]);
  assert.deepEqual(keptCli.boundElements, [{ id: "a1", type: "arrow" }]);

  // The agent moved the card in the file: the file wins and the arrow's start follows.
  const relocated = { ...cli, x: 100, y: 20 };
  const next = reconcileLevelElements([relocated, server], [moved, link]);
  const nextCli = next.find((element) => element.id === cardElementId("cli"));
  assert.deepEqual([nextCli.x, nextCli.y], [100, 20]);
  const nextArrow = next.find((element) => element.id === "a1");
  assert.deepEqual([nextArrow.x, nextArrow.y], [340 + 60, 160 - 40]);
  assert.deepEqual(nextArrow.points.at(-1), [500 - 400, 100 - 120]);
});

test("reconcileLevelElements drops cards the file removed and unbinds their arrows", () => {
  const link = arrow("a1", "cli", "server", [
    [340, 160],
    [500, 100],
  ]);
  const next = reconcileLevelElements([server], [createCardElement(cli), createCardElement(server), link]);
  assert.equal(
    next.some((element) => element.id === cardElementId("cli")),
    false,
  );
  assert.equal(next.find((element) => element.id === "a1").startBinding, null);
});

test("codeLinesUnder maps a vertical span of a code card to source lines", () => {
  const top = CODE_CARD_LAYOUT.header + CODE_CARD_LAYOUT.padTop;
  const rect = { y: 0, h: 400 };
  assert.deepEqual(codeLinesUnder(server, rect, top + 2 * CODE_CARD_LAYOUT.line, top + 4 * CODE_CARD_LAYOUT.line + 3), {
    start: 102,
    end: 104,
    path: "src/server.js",
  });
  assert.deepEqual(codeLinesUnder(server, rect, top, top + 1, CODE_CARD_LAYOUT.line * 5)?.start, 105);
});

test("summarizeBoardMarks describes marks in terms of cards and code lines", () => {
  const top = CODE_CARD_LAYOUT.header + CODE_CARD_LAYOUT.padTop;
  const elements = [
    createCardElement(cli),
    { ...createCardElement(server), x: 520 },
    createCardElement(board.cards[2]),
    { ...createCardElement(deep), isDeleted: true },
    arrow("a1", "cli", "server", [
      [300, 100],
      [520, 100],
    ]),
    { id: "t1", type: "text", containerId: "a1", text: "why not direct?", customData: { boardLevel: "" } },
    {
      id: "e1",
      type: "ellipse",
      x: 540,
      y: top + 3 * CODE_CARD_LAYOUT.line,
      width: 200,
      height: 2 * CODE_CARD_LAYOUT.line - 2,
      customData: { boardLevel: "" },
    },
    {
      id: "n1",
      type: "text",
      x: 10,
      y: 220,
      width: 100,
      height: 20,
      text: "too vague",
      customData: { boardLevel: "" },
    },
    { id: "r1", type: "rectangle", x: -10, y: -10, width: 320, height: 220, customData: { boardLevel: "" } },
    {
      id: "f1",
      type: "freedraw",
      x: 20,
      y: 20,
      points: [
        [0, 0],
        [10, 10],
      ],
      customData: { boardLevel: "" },
    },
  ];
  const { lines, stats } = summarizeBoardMarks(board, elements);
  assert.deepEqual(lines, [
    'Moved card #server "Artifact route" to x=520 y=0',
    'Arrow from card #cli "CLI" to line 102 of src/server.js in card #server "Artifact route", labeled "why not direct?"',
    'Circled lines 103-104 of src/server.js in card #server "Artifact route"',
    'Note "too vague" next to card #cli "CLI"',
    'Boxed card #cli "CLI"',
    'Freehand mark on card #cli "CLI"',
    '[in board #inside "Inside"] Removed card #deep "Deep" from the board',
  ]);
  assert.equal(stats.arrows, 1);
  assert.equal(stats.shapes, 2);
  assert.equal(stats.removed, 1);
});

test("board prompt targets are normalized to a fixed shape", () => {
  assert.deepEqual(
    normalizeBoardCanvasTarget({ type: "board-canvas", scenePath: "/x", evil: 1, stats: { arrows: 2.4 } }),
    {
      type: "board-canvas",
      revision: "",
      scenePath: "/x",
      previewPath: "",
      stats: { arrows: 2, notes: 0, shapes: 0, freehand: 0, images: 0, moved: 0, removed: 0 },
    },
  );
  assert.deepEqual(
    normalizeBoardCardTarget({ card: "srv", kind: "code", title: "S", code: "src/a.js:1-2", status: "stale", x: 1 }),
    { type: "board-card", card: "srv", kind: "code", title: "S", code: "src/a.js:1-2", status: "stale" },
  );
  assert.equal(normalizeBoardCardTarget({ kind: "bogus" }).kind, "html");
});

test("diffCodeLines marks the live lines that are not in the pinned copy", () => {
  assert.deepEqual(diffCodeLines(["a", "b", "c", "d"], ["a", "B", "c", "d", "e"]), { changed: [1, 4], removed: 1 });
  assert.deepEqual(diffCodeLines(["a", "b"], ["a", "b  "]), { changed: [], removed: 0 });
});

test("data-to connectors are drawn from the file, bound to both cards, and never reported as marks", () => {
  const a = { ...cli, to: ["server"] };
  const elements = reconcileLevelElements(
    [a, server],
    [
      {
        id: "link:cli>server",
        type: "arrow",
        x: 0,
        y: 0,
        points: [
          [0, 0],
          [1, 1],
        ],
        customData: { hilightLink: "cli>server" },
      },
    ],
  );
  const links = elements.filter((element) => element.customData?.hilightLink);
  assert.equal(links.length, 1);
  assert.equal(links[0].startBinding.elementId, cardElementId("cli"));
  assert.equal(links[0].endBinding.elementId, cardElementId("server"));
  assert.equal(links[0].locked, true);
  // From the right edge of cli to the left edge of server.
  assert.deepEqual([links[0].x, links[0].y], [310, 100]);
  assert.deepEqual(elements.find((element) => element.id === cardElementId("cli")).boundElements, [
    { id: "link:cli>server", type: "arrow" },
  ]);
  assert.deepEqual(summarizeBoardMarks(board, elements).lines, []);
});

test("codeRows wraps a long line at a word boundary, keeps its indent, and marks continuations", () => {
  const rows = codeRows(["short", "    return someFunction(alpha, beta, gamma) + another(delta);"], 40);
  assert.deepEqual(
    rows.map((row) => [row.index, row.cont, row.text]),
    [
      [0, false, "short"],
      [1, false, "    return someFunction(alpha, beta, "],
      [1, true, "      gamma) + another(delta);"],
    ],
  );
  assert.ok(rows.every((row) => row.text.length <= 40));
  // Tabs expand before measuring, so a tabbed line wraps where it is drawn.
  assert.equal(codeRows(["\tx"], 40)[0].text, "    x");
});

test("codeColumns sizes a card to its longest line within the column limits", () => {
  assert.equal(codeColumns(["a".repeat(30)]), CODE_CARD_LAYOUT.minCols);
  assert.equal(codeColumns(["a".repeat(70)]), 70);
  assert.equal(codeColumns(["a".repeat(300)]), CODE_CARD_LAYOUT.maxCols);
  // A width from the file is a ceiling, never a reason to grow.
  assert.equal(codeColumns(["a".repeat(70)], 400), Math.floor((400 - codeChromeWidth()) / CODE_CARD_LAYOUT.char));
  assert.equal(codeColumns(["a".repeat(50)], 2000), 50);
});

test("codeLinesUnder maps wrapped rows back to their source line", () => {
  const card = {
    note: "",
    code: { path: "src/a.js", start: 10, end: 12, cols: 40, lines: ["one", "x".repeat(100), "three"] },
  };
  const top = CODE_CARD_LAYOUT.header + CODE_CARD_LAYOUT.padTop;
  const rect = { y: 0, h: 1000 };
  // Rows: 0 -> line 10, 1..3 -> line 11 (wrapped), 4 -> line 12.
  assert.deepEqual(
    codeLinesUnder(card, rect, top + 3 * CODE_CARD_LAYOUT.line + 2, top + 4 * CODE_CARD_LAYOUT.line + 5),
    {
      start: 11,
      end: 12,
      path: "src/a.js",
    },
  );
});
