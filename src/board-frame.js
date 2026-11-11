/* global document, window, location, FileReader */

// Board canvas inside the whiteboard frame. The artifact SDK mounts this frame
// over a board file (`[data-hilight-board]`) with diagramIndex
// BOARD_SCENE_INDEX; the chrome authenticates it like any inline whiteboard and
// sends `lavish-whiteboard:init` with a `board` model instead of a Mermaid
// source. Every card is an Excalidraw `embeddable` whose content this module
// renders; everything else on the canvas is the reviewer's marks.
//
// Layering: the cards render beneath a transparent Excalidraw canvas, so a mark
// drawn over a card stays visible. A card comes to the front only while the
// reviewer interacts with it (Excalidraw's "active" embeddable).
//
// The frame talks to two windows. The chrome (window.top) owns persistence and
// prompts, exactly as for Mermaid whiteboards. The artifact SDK (window.parent)
// gets card geometry and comment requests so margin threads and the annotation
// card work over the canvas; it may send view-only commands back (reveal a
// card, thread counts).

import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  exportToBlob,
  getCommonBounds,
  restore,
  sceneCoordsToViewportCoords,
} from "@excalidraw/excalidraw";
import React from "react";
import { createRoot } from "react-dom/client";
import "./board-frame.css";

import {
  CARD_LINK_PREFIX,
  CODE_CARD_LAYOUT,
  cardElementId,
  cardIdOfElement,
  diffCodeLines,
  elementLevel,
  isCardElement,
  isLinkElement,
  reconcileLevelElements,
  summarizeBoardMarks,
  tagLevel,
} from "./board-core.js";
import { sanitizeSceneLink } from "./whiteboard-core.js";

const h = React.createElement;
const SAVE_DEBOUNCE_MS = 800;
const INK = "#1f6fe0";
const EXCALIFONT = 5;

const STATUS_LABEL = {
  fresh: "Live",
  unpinned: "Unpinned",
  moved: "Moved",
  stale: "Stale",
  missing: "Missing",
  invalid: "Bad reference",
};

const KEYWORDS = new Set(
  (
    "async await break case catch class const continue default delete do else export extends false finally for " +
    "from function if import in instanceof let new null of return static super switch this throw true try typeof " +
    "undefined var void while yield def elif except lambda None True False pass raise with as fn pub mut impl " +
    "struct enum match use type interface package func go defer chan map range nil self"
  ).split(" "),
);
const HASH_COMMENT_LANGS = new Set(["py", "sh", "yaml", "rb"]);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function tokenize(line, lang) {
  const hash = HASH_COMMENT_LANGS.has(lang) ? "|#.*$" : "";
  const pattern = new RegExp(
    `(\\/\\/.*$${hash}|\\/\\*.*?\\*\\/|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`|\\b\\d[\\d_.]*\\b|[A-Za-z_$][\\w$]*)`,
    "g",
  );
  const parts = [];
  let last = 0;
  let match;
  while ((match = pattern.exec(line))) {
    if (match.index > last) parts.push(["", line.slice(last, match.index)]);
    const token = match[0];
    let cls = "";
    if (token.startsWith("//") || token.startsWith("/*") || (hash && token.startsWith("#"))) cls = "c";
    else if (/^["'`]/.test(token)) cls = "s";
    else if (/^\d/.test(token)) cls = "n";
    else if (KEYWORDS.has(token)) cls = "k";
    else if (line[match.index + token.length] === "(") cls = "f";
    parts.push([cls, token]);
    last = match.index + token.length;
  }
  if (last < line.length) parts.push(["", line.slice(last)]);
  return parts;
}

function attrString(attrs) {
  return (Array.isArray(attrs) ? attrs : [])
    .filter((pair) => Array.isArray(pair) && /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(String(pair[0])))
    .map(([name, value]) => ` ${name}="${String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`)
    .join("");
}

// HTML cards render in their own sandboxed document (scripts allowed, opaque
// origin, no access to this frame). The board's <head> loads there too and the
// card sits inside copies of its board and card wrappers, so the author's CSS
// applies on the canvas the same way it does on the plain page.
const CARD_RESET = `html,body{margin:0!important;padding:0!important;background:transparent!important;max-width:none!important;width:auto!important;min-height:0!important}
[data-hilight-board]{display:block!important;margin:0!important;padding:0!important;max-width:none!important;width:auto!important;min-height:0!important;background:transparent!important;border:0!important;box-shadow:none!important}
[data-hilight-board]>[data-card]{display:block!important;margin:0!important;border:0!important;border-radius:0!important;box-shadow:none!important;background:transparent!important;padding:2px 16px 16px!important;width:auto!important;height:auto!important;max-width:none!important;min-height:0!important;overflow:visible!important}
[data-hilight-board]>[data-card]>:first-child{margin-top:0!important}`;

function cardSrcdoc(card, model, base) {
  return `<!doctype html><html><head><meta charset="utf-8"><base href="${base}" target="_blank"><style>body{font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1c1c1a}</style>
${model.head || ""}
<style>${CARD_RESET}</style></head><body><main${attrString(model.main_attrs)}><section${attrString(card.attrs)}>${card.html || ""}</section></main></body></html>`;
}

/**
 * @param {any} init the chrome's init message
 * @param {{ post: (message: any) => void }} context
 */
export function startBoard(init, { post }) {
  const s = {
    model: init.board,
    cardsById: new Map(),
    levelsById: new Map(),
    level: "",
    elementsByLevel: new Map(),
    viewByLevel: new Map(),
    files: {},
    api: /** @type {any} */ (null),
    saveTimer: 0,
    teardownFlushId: "",
    flushIds: new Set(),
    queueBusy: false,
    geometryFrame: 0,
    lastGeometry: "",
    selectedCard: "",
    threadCounts: /** @type {Record<string, number>} */ ({}),
    theme: init.theme === "dark" ? "dark" : "light",
    base: `${location.origin}/artifact/${encodeURIComponent(new URL(location.href).searchParams.get("key") || "")}/`,
    switching: false,
    linkStripPending: false,
    admittedCards: new Set(),
  };
  const listeners = new Set();
  let version = 0;
  const notifyCards = () => {
    version++;
    for (const listener of listeners) listener();
  };
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const getVersion = () => version;
  const srcdocCache = new Map();

  function indexModel(model) {
    s.model = model;
    s.cardsById = new Map(model.cards.map((card) => [card.id, card]));
    s.levelsById = new Map(model.levels.map((level) => [level.id, level]));
  }
  indexModel(init.board);

  function postParent(message) {
    if (window.parent && window.parent !== window) window.parent.postMessage(message, "*");
  }

  // ---------------------------------------------------------------------------
  // Shell
  document.body.dataset.lavishWhiteboardTheme = s.theme;
  document.body.dataset.hilightBoard = "";
  const crumbs = el("nav", { className: "bd-crumbs", ariaLabel: "Board levels" });
  const health = el("button", { className: "bd-health", type: "button", hidden: true });
  const note = el("input", { className: "bd-note", placeholder: "Note for the agent (optional)", autocomplete: "off" });
  const fit = el("button", { className: "bd-button bd-icon", type: "button", title: "Fit the board to the screen" });
  fit.innerHTML =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/></svg>';
  const queue = el("button", { className: "bd-button bd-primary", type: "button", textContent: "Queue marks" });
  queue.title = "Describe your arrows, notes and marks to the agent as a page comment";
  const bar = el(
    "header",
    { className: "bd-bar" },
    crumbs,
    health,
    el("div", { className: "bd-spacer" }),
    note,
    fit,
    queue,
  );
  const editor = el("div", { className: "bd-editor" });
  const toolbar = el("div", { className: "bd-cardbar", hidden: true });
  const commentButton = el("button", { type: "button", className: "bd-chip" });
  commentButton.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg><span>Comment</span>';
  const openButton = el("button", { type: "button", className: "bd-chip", textContent: "Open board →" });
  toolbar.append(commentButton, openButton);
  const status = el("div", { className: "bd-status", hidden: true, role: "status" });
  const shell = el("div", { className: "bd-shell" }, bar, editor, toolbar, status);
  document.body.append(shell);

  let statusTimer = 0;
  function showStatus(text, { transient = true } = {}) {
    status.textContent = text;
    status.hidden = !text;
    window.clearTimeout(statusTimer);
    if (transient && text) statusTimer = window.setTimeout(() => (status.hidden = true), 4500);
  }

  function levelPath(levelId) {
    const path = [];
    let current = s.levelsById.get(levelId);
    while (current) {
      path.unshift(current);
      current = current.parent === null ? null : s.levelsById.get(current.parent);
    }
    return path;
  }

  function renderCrumbs() {
    crumbs.replaceChildren();
    const path = levelPath(s.level);
    path.forEach((level, index) => {
      if (index > 0) crumbs.append(el("span", { className: "bd-sep", textContent: "/" }));
      const last = index === path.length - 1;
      const crumb = el("button", {
        type: "button",
        className: "bd-crumb" + (last ? " is-current" : ""),
        textContent: level.title || "Board",
        disabled: last,
      });
      crumb.onclick = () => openLevel(level.id);
      crumbs.append(crumb);
    });
  }

  function renderHealth() {
    const code = s.model.cards.filter((card) => card.kind === "code" && card.code);
    if (!code.length) {
      health.hidden = true;
      return;
    }
    const drifted = code.filter((card) => ["stale", "moved", "missing", "invalid"].includes(card.code.status));
    const unpinned = code.filter((card) => card.code.status === "unpinned");
    health.hidden = false;
    health.className = "bd-health" + (drifted.length ? " is-warn" : "");
    health.textContent = drifted.length
      ? `${drifted.length} of ${code.length} code cards changed since pinned`
      : unpinned.length
        ? `${code.length} code cards · ${unpinned.length} unpinned`
        : `${code.length} code cards · all match the code`;
    health.title = drifted.length
      ? "Show the first one"
      : "Every pinned range was re-read from disk when this board opened";
    health.onclick = () => {
      if (drifted[0]) revealCard(drifted[0].id);
    };
  }

  // ---------------------------------------------------------------------------
  // Cards

  function StatusPill({ code }) {
    const label =
      code.status === "moved" && code.moved_to
        ? `Moved to L${code.moved_to.start}–${code.moved_to.end}`
        : STATUS_LABEL[code.status] || code.status;
    return h("span", { className: `bd-pill is-${code.status}`, title: statusTitle(code) }, label);
  }

  function statusTitle(code) {
    if (code.status === "fresh") return "These lines still match what the agent pinned";
    if (code.status === "unpinned") return "Showing live lines; the agent has not pinned them yet";
    if (code.status === "moved") return `The pinned lines now sit at L${code.moved_to.start}-${code.moved_to.end}`;
    if (code.status === "stale") return "These lines changed after the agent wrote this card";
    return code.error || "";
  }

  function ThreadBadge({ id }) {
    const count = s.threadCounts[id] || 0;
    if (!count) return null;
    return h(
      "span",
      { className: "bd-threads", title: `${count} comment thread${count === 1 ? "" : "s"}` },
      h(
        "svg",
        { width: 11, height: 11, viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": "true" },
        h("path", { d: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" }),
      ),
      String(count),
    );
  }

  function CodeBody({ card }) {
    const code = card.code;
    if (!code.lines?.length) {
      return h("div", { className: "bd-code-empty" }, code.error || "No lines to show.");
    }
    const changed =
      code.status === "stale" && code.snapshot ? new Set(diffCodeLines(code.snapshot, code.lines).changed) : null;
    return h(
      "div",
      { className: "bd-code", style: { paddingTop: CODE_CARD_LAYOUT.padTop + "px" } },
      code.lines.map((line, index) =>
        h(
          "div",
          { key: index, className: "bd-line" + (changed?.has(index) ? " is-changed" : "") },
          h("span", { className: "bd-ln" }, String(code.start + index)),
          h(
            "span",
            { className: "bd-src" },
            tokenize(line, code.lang).map(([cls, text], part) =>
              cls ? h("span", { key: part, className: "t" + cls }, text) : text,
            ),
          ),
        ),
      ),
    );
  }

  function BoardBody({ card }) {
    const preview = card.board?.preview || [];
    return h(
      "div",
      { className: "bd-sub" },
      card.note ? h("p", { className: "bd-sub-note" }, card.note) : null,
      h(
        "div",
        { className: "bd-mini" },
        h(
          "svg",
          { viewBox: "0 0 100 62", preserveAspectRatio: "xMidYMid meet", "aria-hidden": "true" },
          preview.map((rect, index) =>
            h("rect", {
              key: index,
              x: 2 + rect.x * 96,
              y: 2 + rect.y * 58,
              width: Math.max(1.5, rect.w * 96),
              height: Math.max(1.5, rect.h * 58),
              rx: 1.4,
              className: "k-" + rect.kind,
            }),
          ),
        ),
      ),
      h("div", { className: "bd-sub-hint" }, "Double-click to open"),
    );
  }

  function HtmlBody({ card }) {
    const key = `${s.model.revision}:${card.id}`;
    if (!srcdocCache.has(key)) srcdocCache.set(key, cardSrcdoc(card, s.model, s.base));
    return h("iframe", {
      className: "bd-html",
      title: card.title || card.id,
      sandbox: "allow-scripts allow-popups",
      srcDoc: srcdocCache.get(key),
      scrolling: "auto",
    });
  }

  function CardView({ id, active }) {
    React.useSyncExternalStore(subscribe, getVersion);
    const card = s.cardsById.get(id);
    if (!card) return h("div", { className: "bd-card is-gone" }, "This card is no longer in the board file.");
    const code = card.kind === "code" ? card.code : null;
    const meta =
      card.kind === "code" && code
        ? h(
            "div",
            { className: "bd-meta" },
            h(
              "span",
              { className: "bd-ref", title: code.ref },
              code.path,
              h("span", { className: "bd-range" }, ` L${code.start}–${code.end}`),
            ),
            h(StatusPill, { code }),
          )
        : card.kind === "board"
          ? h("div", { className: "bd-meta" }, `Board · ${card.board?.count || 0} cards`)
          : null;
    return h(
      "div",
      {
        className:
          `bd-card k-${card.kind}` +
          (code ? ` is-${code.status}` : "") +
          (active ? " is-active" : "") +
          (s.selectedCard === id ? " is-selected" : ""),
        "data-card": id,
      },
      h(
        "div",
        {
          className: "bd-head" + (meta ? "" : " is-compact"),
          style: meta ? { height: CODE_CARD_LAYOUT.header + "px" } : null,
        },
        h(
          "div",
          { className: "bd-title-row" },
          h("span", { className: "bd-title" }, card.title || card.id),
          h(ThreadBadge, { id }),
        ),
        meta,
      ),
      card.kind === "code" && card.note
        ? h(
            "div",
            { className: "bd-note-line", style: { height: CODE_CARD_LAYOUT.note + "px" }, title: card.note },
            card.note,
          )
        : null,
      card.kind === "code"
        ? h(CodeBody, { card })
        : card.kind === "board"
          ? h(BoardBody, { card })
          : h(HtmlBody, { card }),
    );
  }

  function renderEmbeddable(element, appState) {
    const id = cardIdOfElement(element);
    if (!id) return null;
    const active =
      appState?.activeEmbeddable?.element?.id === element.id && appState.activeEmbeddable.state === "active";
    return h(CardView, { id, active });
  }

  // ---------------------------------------------------------------------------
  // Scene

  const savedScene = init.saved?.scene && typeof init.saved.scene === "object" ? init.saved.scene : null;
  const savedElements = Array.isArray(savedScene?.elements) ? savedScene.elements : [];
  s.files = savedScene?.files && typeof savedScene.files === "object" ? savedScene.files : {};
  const savedBoardState = savedScene?.appState?.hilightBoard || {};
  for (const level of s.model.levels) {
    const cards = s.model.cards.filter((card) => card.level === level.id);
    const saved = savedElements.filter((element) => elementLevel(element) === level.id);
    s.elementsByLevel.set(level.id, reconcileLevelElements(cards, saved));
  }
  // Marks on a nested board the file no longer has are kept, unseen, rather
  // than silently discarded.
  for (const element of savedElements) {
    const level = elementLevel(element);
    if (s.levelsById.has(level)) continue;
    if (!s.elementsByLevel.has(level)) s.elementsByLevel.set(level, []);
    s.elementsByLevel.get(level).push(element);
  }
  if (savedBoardState.views && typeof savedBoardState.views === "object") {
    for (const [level, view] of Object.entries(savedBoardState.views)) {
      if (s.levelsById.has(level) && view && typeof view === "object") s.viewByLevel.set(level, view);
    }
  }
  if (typeof savedBoardState.level === "string" && s.levelsById.has(savedBoardState.level)) {
    s.level = savedBoardState.level;
  }

  function restored(elements) {
    return restore({ elements, appState: null, files: s.files }, null, null, { repairBindings: true }).elements;
  }

  function stashLevel() {
    if (!s.api) return;
    const current = s.api
      .getSceneElementsIncludingDeleted()
      .filter((element) => (!element.isDeleted || isCardElement(element)) && !isLinkElement(element))
      .map((element) => JSON.parse(JSON.stringify(element)))
      .map((element) => (isCardElement(element) ? { ...element, link: cardLink(element) } : element));
    s.elementsByLevel.set(s.level, tagLevel(current, s.level));
    const appState = s.api.getAppState();
    s.viewByLevel.set(s.level, { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom });
  }

  function allElements() {
    stashLevel();
    return [...s.elementsByLevel.values()].flat();
  }

  function persistencePayload() {
    const elements = allElements();
    const views = Object.fromEntries(s.viewByLevel);
    const view = s.viewByLevel.get(s.level) || {};
    return {
      sourceHash: s.model.revision,
      textMetricsVersion: 0,
      scene: {
        elements,
        appState: { ...view, hilightBoard: { level: s.level, views } },
        files: s.api?.getFiles() || s.files,
      },
      baseline: null,
    };
  }

  function postSave(flushId = "") {
    if (!s.api) return false;
    post({ type: "lavish-whiteboard:save", ...persistencePayload(), ...(flushId ? { flushId } : {}) });
    return true;
  }

  function scheduleSave() {
    if (s.teardownFlushId || s.switching) return;
    window.clearTimeout(s.saveTimer);
    s.saveTimer = window.setTimeout(() => postSave(), SAVE_DEBOUNCE_MS);
  }

  // ---------------------------------------------------------------------------
  // Geometry for the SDK: viewport rects of the visible level's cards, so margin
  // threads and the annotation card follow cards as the reviewer pans.

  function scheduleGeometry() {
    if (s.geometryFrame) return;
    s.geometryFrame = window.requestAnimationFrame(sendGeometry);
  }

  function cardRects() {
    if (!s.api) return {};
    const appState = s.api.getAppState();
    const zoom = appState.zoom.value;
    /** @type {Record<string, number[]>} */
    const rects = {};
    for (const element of s.api.getSceneElements()) {
      const id = cardIdOfElement(element);
      if (!id) continue;
      const { x, y } = sceneCoordsToViewportCoords({ sceneX: element.x, sceneY: element.y }, appState);
      rects[id] = [Math.round(x), Math.round(y), Math.round(element.width * zoom), Math.round(element.height * zoom)];
    }
    return rects;
  }

  function sendGeometry() {
    s.geometryFrame = 0;
    const rects = cardRects();
    placeToolbar(rects);
    const serialized = JSON.stringify(rects);
    if (serialized === s.lastGeometry) return;
    s.lastGeometry = serialized;
    postParent({ type: "hilight-board:geometry", cards: rects });
  }

  function placeToolbar(rects) {
    const rect = s.selectedCard ? rects[s.selectedCard] : null;
    const card = s.selectedCard ? s.cardsById.get(s.selectedCard) : null;
    if (!rect || !card || s.switching) {
      toolbar.hidden = true;
      return;
    }
    openButton.hidden = card.kind !== "board";
    toolbar.hidden = false;
    const width = toolbar.offsetWidth || 180;
    const left = Math.max(8, Math.min(rect[0] + rect[2] - width, window.innerWidth - width - 8));
    const above = rect[1] - 44;
    toolbar.style.left = left + "px";
    toolbar.style.top = (above < 48 ? rect[1] + 8 : above) + "px";
  }

  function selectedCardId(appState) {
    const ids = Object.keys(appState.selectedElementIds || {}).filter((id) => appState.selectedElementIds[id]);
    if (ids.length !== 1 || !ids[0].startsWith("card:")) return "";
    const element = s.api?.getSceneElements().find((item) => item.id === ids[0]);
    return element ? cardIdOfElement(element) || "" : "";
  }

  function cardLink(element) {
    return CARD_LINK_PREFIX + encodeURIComponent(cardIdOfElement(element) || "");
  }

  // Excalidraw needs a card's link once, to admit it as an embeddable, and then
  // caches that verdict by element id. A linked element also gets a link icon
  // drawn beside it, so the live scene drops the link after that first check.
  // Only cards seen by onChange are stripped: Excalidraw calls onChange after its
  // validation pass, while an element read straight after updateScene may not be
  // validated yet, and stripping it then would leave an empty embed.
  // Stashed and saved copies get the link back (stashLevel), so a reload validates again.
  function stripAdmittedLinks(elements) {
    for (const element of elements) {
      if (isCardElement(element) && element.link) s.admittedCards.add(element.id);
    }
    if (s.linkStripPending || !s.admittedCards.size) return;
    s.linkStripPending = true;
    window.requestAnimationFrame(() => {
      s.linkStripPending = false;
      if (!s.api) return;
      const current = s.api.getSceneElementsIncludingDeleted();
      const strip = (element) => element.link && s.admittedCards.has(element.id);
      if (!current.some(strip)) return;
      s.api.updateScene({
        elements: current.map((element) => (strip(element) ? { ...element, link: null } : element)),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
  }

  function onChange(elements, appState) {
    stripAdmittedLinks(elements);
    if (s.switching) return;
    const selected = selectedCardId(appState);
    if (selected !== s.selectedCard) {
      s.selectedCard = selected;
      // A card has no stroke or fill to style, so its selection hides Excalidraw's style panel.
      editor.classList.toggle("is-card-selected", Boolean(selected));
      notifyCards();
      postParent({ type: "hilight-board:select", card: selected });
    }
    scheduleGeometry();
    scheduleSave();
  }

  // ---------------------------------------------------------------------------
  // Levels

  async function openLevel(levelId, { animate = true } = {}) {
    if (!s.api || levelId === s.level || !s.levelsById.has(levelId) || s.switching) return;
    const target = s.levelsById.get(levelId);
    const goingIn = target.parent === s.level;
    stashLevel();
    s.switching = true;
    toolbar.hidden = true;
    if (goingIn && animate) {
      const card = s.api.getSceneElements().find((element) => element.id === cardElementId(levelId));
      if (card) {
        s.api.scrollToContent(card, { fitToViewport: true, viewportZoomFactor: 0.9, animate: true, duration: 320 });
        await sleep(300);
      }
    }
    editor.classList.add("is-switching");
    await sleep(120);
    s.level = levelId;
    s.selectedCard = "";
    editor.classList.remove("is-card-selected");
    const view = s.viewByLevel.get(levelId);
    s.api.updateScene({
      elements: restored(s.elementsByLevel.get(levelId) || []),
      appState: { selectedElementIds: {}, activeEmbeddable: null, ...(view || {}) },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    s.api.history?.clear?.();
    if (!view) fitAll();
    renderCrumbs();
    notifyCards();
    editor.classList.remove("is-switching");
    s.switching = false;
    s.lastGeometry = "";
    scheduleGeometry();
    scheduleSave();
  }

  // Fit the level with a margin, never past 100%, and sit the content slightly low
  // so the top row clears Excalidraw's floating toolbar. Computed in one update:
  // scrollToContent applies its state later, so it cannot be adjusted afterwards.
  function fitAll() {
    if (!s.api) return;
    const elements = s.api.getSceneElements();
    if (!elements.length) return;
    const [minX, minY, maxX, maxY] = getCommonBounds(elements);
    const { width, height } = s.api.getAppState();
    const toolbar = 56;
    const zoom = Math.max(
      0.1,
      Math.min(
        1,
        ((width - 48) / Math.max(1, maxX - minX)) * 0.94,
        ((height - toolbar - 48) / Math.max(1, maxY - minY)) * 0.94,
      ),
    );
    s.api.updateScene({
      appState: {
        zoom: { value: zoom },
        scrollX: width / 2 / zoom - (minX + maxX) / 2,
        scrollY: (height + toolbar) / 2 / zoom - (minY + maxY) / 2,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }

  async function revealCard(cardId) {
    const card = s.cardsById.get(cardId);
    if (!card || !s.api) return;
    if (card.level !== s.level) await openLevel(card.level, { animate: false });
    const element = s.api.getSceneElements().find((item) => item.id === cardElementId(cardId));
    if (!element) return;
    s.api.updateScene({
      appState: { selectedElementIds: { [element.id]: true } },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    s.api.scrollToContent(element, { fitToViewport: true, viewportZoomFactor: 0.55, animate: true, duration: 360 });
  }

  // ---------------------------------------------------------------------------
  // Feedback: the marks, in words, as one page comment.

  function exportElements(elements) {
    const marks = elements.filter((element) => !isCardElement(element) && !element.isDeleted);
    // Agent connectors stay in the preview; they are part of the board.
    const skeletons = elements
      .filter((element) => isCardElement(element) && !element.isDeleted)
      .map((element) => {
        const card = s.cardsById.get(cardIdOfElement(element));
        const sub = card?.kind === "code" ? card.code?.ref || "" : card?.kind === "board" ? "board" : "";
        return {
          type: "rectangle",
          id: element.id,
          x: element.x,
          y: element.y,
          width: element.width,
          height: element.height,
          strokeColor: "#a3a39e",
          backgroundColor: "#ffffff",
          fillStyle: "solid",
          strokeWidth: 1,
          roughness: 0,
          roundness: { type: 3 },
          label: {
            text: [card?.title || card?.id || "", sub].filter(Boolean).join("\n"),
            fontSize: 18,
            textAlign: "left",
            verticalAlign: "top",
            strokeColor: "#1c1c1a",
          },
        };
      });
    return [...convertToExcalidrawElements(skeletons, { regenerateIds: false }), ...marks];
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("could not encode PNG preview"));
      reader.readAsDataURL(blob);
    });
  }

  async function queueMarks() {
    if (!s.api || s.queueBusy) return;
    const payload = persistencePayload();
    const summary = summarizeBoardMarks(s.model, payload.scene.elements);
    const text = note.value.trim();
    if (!summary.lines.length && !text) {
      showStatus("Nothing to send yet: draw an arrow, write a note, or circle something first.");
      return;
    }
    s.queueBusy = true;
    queue.disabled = true;
    queue.textContent = "Queueing…";
    try {
      const blob = await exportToBlob({
        elements: exportElements(s.elementsByLevel.get(s.level) || []),
        appState: { exportBackground: true, viewBackgroundColor: "#f6f6f3" },
        files: s.api.getFiles() || null,
        mimeType: "image/png",
      });
      post({
        type: "lavish-whiteboard:queueFeedback",
        board: true,
        ...payload,
        note: text,
        summaryLines: summary.lines,
        stats: summary.stats,
        pngDataUrl: await blobToDataUrl(blob),
      });
    } catch (error) {
      resetQueue();
      showStatus(`Queue failed: ${error instanceof Error ? error.message : String(error)}`, { transient: false });
    }
  }

  function resetQueue() {
    s.queueBusy = false;
    queue.disabled = false;
    queue.textContent = "Queue marks";
  }

  queue.onclick = () => queueMarks();
  note.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      queueMarks();
    }
  });
  fit.onclick = () => fitAll();
  commentButton.onclick = () => {
    const card = s.cardsById.get(s.selectedCard);
    if (!card) return;
    postParent({
      type: "hilight-board:comment",
      card: card.id,
      kind: card.kind,
      title: card.title || card.id,
      ...(card.kind === "code" && card.code ? { code: card.code.ref, status: card.code.status } : {}),
    });
  };
  openButton.onclick = () => {
    if (s.selectedCard) openLevel(s.selectedCard);
  };
  // Double-click opens a nested board. Capture phase, so Excalidraw does not
  // also start a text element there.
  editor.addEventListener(
    "dblclick",
    (event) => {
      const target = /** @type {Element | null} */ (event.target);
      const hit = cardAtPoint(event.clientX, event.clientY);
      if (hit?.kind === "board" && !target?.closest?.(".bd-cardbar")) {
        event.preventDefault();
        event.stopPropagation();
        openLevel(hit.id);
      }
    },
    true,
  );

  function cardAtPoint(x, y) {
    const rects = cardRects();
    let found = null;
    for (const [id, rect] of Object.entries(rects)) {
      if (x >= rect[0] && x <= rect[0] + rect[2] && y >= rect[1] && y <= rect[1] + rect[3]) found = s.cardsById.get(id);
    }
    return found;
  }

  function onLinkOpen(element, event) {
    event.preventDefault();
    const link = String(element?.link || "");
    if (link.startsWith(CARD_LINK_PREFIX)) return;
    const safe = sanitizeSceneLink(link);
    if (safe) window.open(safe, "_blank", "noopener,noreferrer");
  }

  // ---------------------------------------------------------------------------
  // Mount

  const view = s.viewByLevel.get(s.level);
  function BoardApp() {
    return h(Excalidraw, {
      initialData: {
        elements: restored(s.elementsByLevel.get(s.level) || []),
        appState: {
          viewBackgroundColor: "transparent",
          currentItemStrokeColor: INK,
          currentItemFontFamily: EXCALIFONT,
          currentItemRoughness: 1,
          ...(view || {}),
        },
        files: s.files,
        scrollToContent: !view,
      },
      theme: s.theme,
      onChange,
      onScrollChange: scheduleGeometry,
      onLinkOpen,
      validateEmbeddable: (link) => (String(link).startsWith(CARD_LINK_PREFIX) ? true : undefined),
      renderEmbeddable,
      excalidrawAPI: (api) => {
        s.api = api;
        if (!view) {
          window.setTimeout(() => {
            try {
              fitAll();
            } catch {
              // Cosmetic.
            }
            scheduleGeometry();
          }, 0);
        }
        window.setTimeout(scheduleGeometry, 50);
      },
      UIOptions: {
        canvasActions: {
          loadScene: false,
          saveToActiveFile: false,
          toggleTheme: false,
          export: false,
          saveAsImage: false,
          clearCanvas: false,
          changeViewBackgroundColor: false,
        },
      },
    });
  }
  createRoot(editor).render(h(BoardApp));
  renderCrumbs();
  renderHealth();
  window.addEventListener("resize", scheduleGeometry);

  // ---------------------------------------------------------------------------
  // Messages

  function handleSaveResult(message) {
    const flushId = String(message.flushId || "");
    if (!flushId) return;
    if (flushId === s.teardownFlushId) {
      s.teardownFlushId = "";
      if (message.ok) post({ type: "lavish-whiteboard:teardownReady", flushId });
      else {
        const error = String(message.error || "failed to save the board");
        showStatus(`Could not save before reloading: ${error}`, { transient: false });
        post({ type: "lavish-whiteboard:teardownFailed", flushId, error });
      }
      return;
    }
    if (s.flushIds.delete(flushId)) post({ type: "lavish-whiteboard:flushComplete", flushId, ok: Boolean(message.ok) });
  }

  function onTopMessage(message) {
    if (message.type === "lavish-whiteboard:prepareTeardown") {
      const flushId = String(message.flushId || "");
      if (!flushId) return;
      s.teardownFlushId = flushId;
      window.clearTimeout(s.saveTimer);
      if (!postSave(flushId)) {
        s.teardownFlushId = "";
        post({ type: "lavish-whiteboard:teardownReady", flushId });
      }
    }
    if (message.type === "lavish-whiteboard:flush") {
      const flushId = String(message.flushId || "");
      if (!flushId || s.flushIds.has(flushId)) return;
      s.flushIds.add(flushId);
      window.clearTimeout(s.saveTimer);
      if (!postSave(flushId)) {
        s.flushIds.delete(flushId);
        post({ type: "lavish-whiteboard:flushComplete", flushId, ok: true });
      }
    }
    if (message.type === "lavish-whiteboard:saveResult") handleSaveResult(message);
    if (message.type === "lavish-whiteboard:queueResult") {
      resetQueue();
      if (message.ok) {
        note.value = "";
        showStatus("Queued as a page comment. Press Send to agent in the margin when you are ready.");
      } else {
        showStatus(`Queue failed: ${String(message.error || "unknown error")}`, { transient: false });
      }
    }
    // The chrome re-reads the board (code ranges included) while it is open, so
    // a card flips to stale when its file changes on disk.
    if (message.type === "hilight-board:update" && message.board && message.board.revision === s.model.revision) {
      indexModel(message.board);
      renderHealth();
      notifyCards();
    }
  }

  function onParentMessage(message) {
    if (message.type === "hilight-board:reveal") revealCard(String(message.card || ""));
    if (message.type === "hilight-board:threads") {
      const counts = message.counts && typeof message.counts === "object" ? message.counts : {};
      s.threadCounts = Object.fromEntries(
        Object.entries(counts).filter(([, count]) => Number.isInteger(count) && count > 0),
      );
      notifyCards();
    }
  }

  return { onTopMessage, onParentMessage };
}
