/* global document, location, window, requestAnimationFrame */

// A board mounted on its own page for test/board-input.browser.test.js, which drives it with
// trusted input over the DevTools protocol. `window.probe` reads what a reviewer would see.

import "@excalidraw/excalidraw/index.css";
import "../../src/whiteboard-frame.css";

import { startBoard } from "../../src/board-frame.js";

window.EXCALIDRAW_ASSET_PATH = `${location.origin}/whiteboard-assets/`;

const card = (id, x, y, extra = {}) => ({
  id,
  level: "",
  kind: "html",
  title: id,
  x,
  y,
  w: 320,
  h: 180,
  html: `<p>Card ${id}.</p>`,
  attrs: [["id", id]],
  ...extra,
});
const lines = Array.from({ length: 60 }, (_, index) => `export const value${index + 1} = ${index + 1};`);

// Every wheel over the page must be handled by the board: none may scroll the page or reach the
// browser's own back/forward swipe. Registered before the board, whose capture listener stops
// every wheel it handles.
let wheels = 0;
let unprevented = 0;
window.addEventListener(
  "wheel",
  (event) => {
    wheels += 1;
    // After the whole dispatch: for a trusted event, microtasks run between listeners.
    window.setTimeout(() => {
      if (!event.defaultPrevented) unprevented += 1;
    }, 0);
  },
  { capture: true, passive: false },
);

startBoard(
  {
    board: {
      title: "Input",
      head: "",
      main_attrs: [["data-hilight-board", "Input"]],
      revision: "0123456789abcdef",
      root: "repo",
      levels: [{ id: "", title: "Input", parent: null }],
      cards: [
        card("a", 0, 0),
        card("b", 400, 0),
        card("c", 800, 0),
        card("d", 0, 300),
        card("long", 400, 300, {
          kind: "code",
          html: "",
          attrs: [],
          note: "",
          code: {
            ref: "src/values.js:1-60",
            path: "src/values.js",
            start: 1,
            end: 60,
            pinned_start: 1,
            pinned_end: 60,
            lang: "js",
            status: "fresh",
            pinned: "aaaaaaaaaaaa",
            live: "aaaaaaaaaaaa",
            lines,
            truncated: false,
            total: 60,
            snapshot: lines,
          },
        }),
      ],
      flows: [],
    },
    // `?toast=1`: the saved scene knew every card but "long", so "long" is new and the new-card
    // toast shows.
    saved: new URLSearchParams(location.search).has("toast")
      ? { scene: { elements: [], appState: { hilightBoard: { known: { cards: ["a", "b", "c", "d"], steps: [] } } } } }
      : null,
    theme: "light",
  },
  { post: () => {} },
);

const rect = (node) => {
  const box = node.getBoundingClientRect();
  return { x: box.left, y: box.top, w: box.width, h: box.height };
};

window.probe = {
  cards: () =>
    Object.fromEntries([...document.querySelectorAll(".bd-card")].map((node) => [node.dataset.card, rect(node)])),
  editor: () => rect(document.querySelector(".bd-editor")),
  code: (id) => {
    const node = document.querySelector(`.bd-card[data-card="${id}"] .bd-code`);
    return node ? { top: node.scrollTop, max: node.scrollHeight - node.clientHeight } : null;
  },
  zoomLabel: () => document.querySelector(".bd-zoom, [data-zoom]")?.textContent || "",
  wheels: () => ({ wheels, unprevented }),
  page: () => ({
    href: location.href,
    history: window.history.length,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  }),
  fit: () => document.querySelector("button[title='Fit the board to the screen']")?.click(),
  frames: (count = 2) =>
    new Promise((resolve) => {
      const step = (left) => (left <= 0 ? resolve(true) : requestAnimationFrame(() => step(left - 1)));
      step(count);
    }),
  // A canvas point with no card under it, for drags that must start on empty board.
  empty: () => {
    const editor = rect(document.querySelector(".bd-editor"));
    for (let y = editor.y + editor.h - 30; y > editor.y + 80; y -= 20) {
      for (let x = editor.x + 40; x < editor.x + editor.w - 40; x += 20) {
        const hit = document.elementFromPoint(x, y);
        if (hit?.tagName === "CANVAS") return { x, y };
      }
    }
    return null;
  },
  ready: () => document.querySelectorAll(".bd-card").length > 0,
  // The new-card toast and Excalidraw's Draw toolbar, as drawn now (null when not shown).
  toast: () => {
    const node = document.querySelector(".bd-reveal");
    return node && !node.hidden ? rect(node) : null;
  },
  toolbar: () => {
    const node = document.querySelector(".App-toolbar");
    return node && node.getBoundingClientRect().height ? rect(node) : null;
  },
  shellTop: () => document.querySelector(".bd-shell").getBoundingClientRect().top,
  draw: () => document.querySelector(".bd-draw").click(),
};
