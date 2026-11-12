import assert from "node:assert/strict";
import test from "node:test";

import {
  cardElementId,
  codeBodyTop,
  codeColumns,
  codeChromeWidth,
  codeLineSpan,
  codeLinesUnder,
  codeNoteHeight,
  codeRows,
  CODE_CARD_LAYOUT,
  createCardElement,
  createLinkElements,
  diffCodeLines,
  FLOW_COLORS,
  linkLandings,
  noteRows,
  normalizeBoardCanvasTarget,
  normalizeBoardCardTarget,
  parseEndpoint,
  parseLinkToken,
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

function flow(steps, extra = {}) {
  return {
    id: "f1",
    name: "Request",
    level: "",
    color: FLOW_COLORS[0],
    steps: steps.map(([from, to]) => ({ from: end(from), to: end(to), text: "" })),
    ...extra,
  };
}

function end(text) {
  const [card, lines] = text.split(":");
  if (!lines) return { card, lines: null };
  const [a, b] = lines.split("-").map(Number);
  return { card, lines: { start: a, end: b || a } };
}

function absolute(link) {
  return link.points.map(([x, y]) => [link.x + x, link.y + y]);
}

function linksFor(cards, flows) {
  return createLinkElements(cards, cards.map(createCardElement), flows);
}

function assertOrthogonal(points) {
  for (let index = 1; index < points.length; index += 1) {
    const [x1, y1] = points[index - 1];
    const [x2, y2] = points[index];
    assert.ok(x1 === x2 || y1 === y2, `segment ${index} is horizontal or vertical: ${JSON.stringify(points)}`);
  }
}

// True when the segment passes through the inside of the rect.
function crosses([x1, y1], [x2, y2], rect) {
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  return left < rect.x + rect.w && right > rect.x && top < rect.y + rect.h && bottom > rect.y;
}

test("flow arrows run edge to edge for whole cards, in the flow's colour, unbound, and are never reported as marks", () => {
  const elements = reconcileLevelElements(
    [cli, server],
    [
      {
        id: "link:old",
        type: "arrow",
        x: 0,
        y: 0,
        points: [
          [0, 0],
          [1, 1],
        ],
        customData: { hilightLink: "f1.1" },
      },
    ],
    [flow([["cli", "server"]], { color: FLOW_COLORS[2] })],
  );
  const links = elements.filter((element) => element.customData?.hilightLink);
  assert.equal(links.length, 1);
  assert.equal(links[0].strokeColor, FLOW_COLORS[2]);
  assert.equal(links[0].locked, true);
  assert.equal(links[0].startBinding, null);
  assert.equal(links[0].endBinding, null);
  assert.deepEqual(absolute(links[0]), [
    [300, 100],
    [500, 100],
  ]);
  assert.deepEqual(elements.find((element) => element.id === cardElementId("cli")).boundElements, []);
  assert.deepEqual(summarizeBoardMarks(board, elements).lines, []);
});

test("parseEndpoint and parseLinkToken read cards and line spans", () => {
  assert.deepEqual(parseEndpoint("server"), { card: "server", lines: null });
  assert.deepEqual(parseEndpoint("server:L10-L12"), { card: "server", lines: { start: 10, end: 12 } });
  assert.equal(parseEndpoint("server:12-3"), null);
  assert.equal(parseEndpoint("server:"), null);
  assert.deepEqual(parseLinkToken("88-90>server:120"), {
    card: "server",
    lines: { start: 120, end: 120 },
    from: { start: 88, end: 90 },
  });
  assert.equal(parseLinkToken("x>server"), null);
});

test("an arrow between code lines starts and ends inside the cards, on those lines, both highlighted", () => {
  const source = { ...server, id: "src", x: 0 };
  const target = { ...server, id: "dst", x: 700 };
  const flows = [flow([["src:104", "dst:110-112"]])];
  const [link] = linksFor([source, target], flows);
  const row = (n) => codeBodyTop(server) + n * CODE_CARD_LAYOUT.line;
  const points = absolute(link);
  assert.deepEqual(points[0], [488, row(4) + CODE_CARD_LAYOUT.line / 2], "starts inside src on line 104");
  assert.deepEqual(points.at(-1), [712, row(10) + (3 * CODE_CARD_LAYOUT.line) / 2], "ends inside dst on 110-112");
  assertOrthogonal(points);
  const landings = linkLandings([source, target], flows);
  assert.deepEqual([...landings.get("src")], [[4, FLOW_COLORS[0]]]);
  assert.deepEqual([...landings.get("dst").keys()], [10, 11, 12]);
});

test("line anchors use the pinned numbering, so they follow code that moved", () => {
  const moved = { ...server, code: { ...server.code, start: 110, end: 129, pinned_start: 100 } };
  assert.deepEqual(
    [
      ...linkLandings([cli, moved], [flow([["cli", "server:105"]])])
        .get("server")
        .keys(),
    ],
    [5],
  );
  assert.equal(codeLineSpan(moved, { start: 105, end: 105 })?.top, codeBodyTop(moved) + 5 * CODE_CARD_LAYOUT.line);
  // A line outside the card falls back to its edge and highlights nothing.
  const [outside] = linksFor([cli, server], [flow([["cli", "server:400"]])]);
  assert.equal(absolute(outside).at(-1)[0], 500);
  assert.equal(linkLandings([cli, server], [flow([["cli", "server:400"]])]).size, 0);
});

test("an arrow routes around every card it does not connect", () => {
  const a = { ...cli, id: "a", x: 0, y: 0 };
  const wall = { ...cli, id: "wall", x: 400, y: -100, w: 200, h: 420 };
  const b = { ...cli, id: "b", x: 700, y: 0 };
  const [link] = linksFor([a, wall, b], [flow([["a", "b"]])]);
  const points = absolute(link);
  assertOrthogonal(points);
  const onEdge = ([x, y], r) =>
    ((x === r.x || x === r.x + r.w) && y >= r.y && y <= r.y + r.h) ||
    ((y === r.y || y === r.y + r.h) && x >= r.x && x <= r.x + r.w);
  assert.ok(onEdge(points[0], a), "starts on a's edge");
  assert.ok(onEdge(points.at(-1), b), "ends on b's edge");
  for (let index = 1; index < points.length; index += 1) {
    assert.ok(!crosses(points[index - 1], points[index], wall), `segment ${index} stays clear of the wall`);
  }
  // Stacked code cards with a line anchor still never cross a third card.
  const above = { ...cli, id: "above", x: 0, y: 0 };
  const middle = { ...cli, id: "middle", x: 0, y: 260, w: 600, h: 100 };
  const below = { ...server, id: "below", x: 0, y: 420 };
  const [down] = linksFor([above, middle, below], [flow([["above", "below:103"]])]);
  const route = absolute(down);
  assertOrthogonal(route);
  for (let index = 1; index < route.length; index += 1) {
    assert.ok(!crosses(route[index - 1], route[index], middle), `segment ${index} stays clear of the middle card`);
  }
});

test("overlapping segments of different flows are nudged apart", () => {
  const a = { ...cli, id: "a", x: 0, y: 0, w: 300, h: 100 };
  const b = { ...cli, id: "b", x: 600, y: 300, w: 300, h: 100 };
  const links = linksFor(
    [a, b],
    [flow([["a", "b"]]), flow([["a", "b"]], { id: "f2", name: "Reply", color: FLOW_COLORS[1] })],
  );
  assert.equal(links.length, 2);
  assert.notEqual(links[0].strokeColor, links[1].strokeColor);
  const vertical = (link) => {
    const points = absolute(link);
    const index = points.findIndex((point, i) => i > 0 && point[0] === points[i - 1][0]);
    return points[index][0];
  };
  assert.equal(Math.abs(vertical(links[0]) - vertical(links[1])), 6);
});

test("a code card's note wraps to the rows its width allows, and the code starts below it", () => {
  assert.equal(noteRows("", 500), 0);
  assert.equal(noteRows("Short note.", 500), 1);
  const long = "Why these lines matter in the flow and what would break without them. ".repeat(4);
  assert.equal(noteRows(long, 500), 4, "capped at four rows");
  assert.ok(noteRows(long.slice(0, 120), 500) >= 2);
  const noted = { ...server, note: long.slice(0, 120) };
  assert.equal(codeBodyTop(noted), CODE_CARD_LAYOUT.header + codeNoteHeight(noted) + CODE_CARD_LAYOUT.padTop);
  assert.ok(codeNoteHeight(noted) >= 2 * CODE_CARD_LAYOUT.line);
  const rect = { y: 0, h: 400 };
  assert.equal(codeLinesUnder(noted, rect, codeBodyTop(noted) + 1, codeBodyTop(noted) + 2)?.start, 100);
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
