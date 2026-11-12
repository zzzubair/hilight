/* global document, location, window */

import "@excalidraw/excalidraw/index.css";
import "../../src/whiteboard-frame.css";

import { parseEndpoint } from "../../src/board-core.js";
import { startBoard } from "../../src/board-frame.js";

window.EXCALIDRAW_ASSET_PATH = `${location.origin}/whiteboard-assets/`;

const pinned = ["export function add(a, b) {", "  return a + b;", "}"];
const card = (id, extra) => ({ id, level: "", kind: "html", title: id, x: 0, y: 0, w: 320, h: 180, ...extra });
const code = (status, lines, extra = {}) => ({
  ref: "src/math.js:1-3",
  path: "src/math.js",
  start: 1,
  end: 3,
  pinned_start: 1,
  pinned_end: 3,
  lang: "js",
  status,
  pinned: "aaaaaaaaaaaa",
  live: status === "fresh" ? "aaaaaaaaaaaa" : "bbbbbbbbbbbb",
  lines,
  truncated: false,
  total: 3,
  snapshot: pinned,
  ...extra,
});

function model(staleStatus) {
  return {
    title: "Math",
    head: "",
    main_attrs: [["data-hilight-board", "Math"]],
    revision: "0123456789abcdef",
    root: "repo",
    levels: [
      { id: "", title: "Math", parent: null },
      { id: "inside", title: "Inside", parent: "" },
    ],
    cards: [
      card("intro", { html: "<p>Adds numbers.</p>", attrs: [["id", "intro"]] }),
      card("fresh", { kind: "code", x: 400, h: 120, note: "", code: code("fresh", pinned) }),
      card("stale", {
        kind: "code",
        // Code cards size themselves (48 columns at least), so leave room after "fresh".
        x: 900,
        h: 120,
        note: "",
        code: code(staleStatus, staleStatus === "fresh" ? pinned : [pinned[0], "  return a - b;", pinned[2]]),
      }),
      card("inside", {
        kind: "board",
        y: 300,
        note: "",
        board: { count: 1, preview: [{ x: 0, y: 0, w: 1, h: 1, kind: "html" }] },
      }),
      card("deep", { level: "inside", html: "<p>One level down.</p>", attrs: [["id", "deep"]] }),
    ],
    flows: [
      {
        id: "flow-1",
        name: "Add",
        level: "",
        color: "#7048e8",
        steps: [{ from: parseEndpoint("fresh:2"), to: parseEndpoint("stale:2"), text: "the sum is checked" }],
      },
    ],
  };
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function until(label, check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(
    `timed out waiting for ${label}: ${JSON.stringify(visibleCards())} ${document.body.innerHTML.slice(0, 600)}`,
  );
}

const visibleCards = () =>
  [...document.querySelectorAll(".bd-card")].map((node) => ({ id: node.dataset.card, className: node.className }));

async function run() {
  const posts = [];
  const board = startBoard({ board: model("stale"), saved: null, theme: "light" }, { post: (m) => posts.push(m) });
  // The board opens on its top row at a readable zoom, which may leave cards off-screen
  // (Excalidraw renders only on-screen embeddables); Fit shows the whole level.
  await until("opening view", () => visibleCards().some((item) => item.id === "intro"));
  const opening = visibleCards().map((item) => item.id);
  document.querySelector("button[title='Fit the board to the screen']").click();
  await until("root cards", () => visibleCards().length === 4);
  const root = visibleCards();
  // The board has no bar: its title path and code-card health go to the review page's top bar.
  const header = () => posts.filter((m) => m.type === "hilight-board:header").at(-1);
  const health = header()?.health?.text || "";
  const changedLines = [...document.querySelectorAll('.bd-card[data-card="stale"] .bd-line.is-changed')].length;
  // Both ends of a flow step highlight the lines the arrow joins, and the legend names the flow.
  const landings = ["fresh", "stale"].map(
    (id) => [...document.querySelectorAll(`.bd-card[data-card="${id}"] .bd-line.is-landing`)].length,
  );
  const legend = [...document.querySelectorAll(".bd-legend-item")].map((item) => item.textContent.trim());

  // Excalidraw draws a link icon beside any linked element; cards drop their link once admitted.
  await sleep(400);
  const save = await until("autosave", () => posts.find((m) => m.type === "lavish-whiteboard:save"), 6000);
  const savedCards = save.scene.elements.filter((element) => String(element.id).startsWith("card:"));
  const savedLinks = savedCards.filter((element) =>
    String(element.link || "").startsWith("https://hilight.invalid/card/"),
  );
  const connectorsSaved = save.scene.elements.filter((element) => String(element.id).startsWith("link:")).length;

  // The chrome re-reads the code: a fixed range turns the card back to fresh.
  board.onTopMessage({ type: "hilight-board:update", board: model("fresh") });
  await until("refresh", () => header()?.health?.text.includes("match"));
  const healthAfter = header()?.health?.text || "";

  // Revealing a nested card opens its board level.
  board.onParentMessage({ type: "hilight-board:reveal", card: "deep" });
  await until("nested level", () => visibleCards().some((item) => item.id === "deep"));
  await sleep(300);
  const nested = visibleCards().map((item) => item.id);
  const crumbs = (header()?.path || []).map((level) => level.title).join(" / ");

  return {
    pass: true,
    opening,
    root,
    health,
    changedLines,
    landings,
    legend,
    savedCards: savedCards.length,
    savedLinks: savedLinks.length,
    connectorsSaved,
    healthAfter,
    nested,
    crumbs,
  };
}

function report(result) {
  location.replace(`/result?value=${encodeURIComponent(JSON.stringify(result))}`);
}

run().then(
  (result) => report(result),
  (error) => report({ pass: false, error: error?.stack || String(error) }),
);
