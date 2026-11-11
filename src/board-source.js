import crypto from "node:crypto";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse, serializeOuter } from "parse5";

import { CODE_CARD_LAYOUT } from "./board-core.js";

// Server-side reading of a board artifact: one HTML file whose
// `[data-hilight-board]` element holds `[data-card]` sections. The file on
// disk is the source of truth. Hilight never serves a rewritten board: the
// SDK shows the canvas at view time, and this module only reads the file (and
// the code ranges it pins) to build the model the canvas renders. The one
// writer is `stampBoardFile`, which runs only when the agent asks for it
// (`hilight board stamp`).

export const BOARD_ATTRIBUTE = "data-hilight-board";
export const CARD_ATTRIBUTE = "data-card";
export const MAX_BOARD_CARDS = 200;
export const MAX_CODE_CARD_LINES = 400;
export const MAX_CODE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CARD_HTML_CHARS = 200_000;
const MAX_NOTE_CHARS = 600;
const MAX_TITLE_CHARS = 160;
const GRID_GAP = 56;
const GRID_COLUMNS = 3;

const DEFAULT_SIZE = {
  html: { w: 380, h: 260 },
  code: { w: 560, h: 200 },
  board: { w: 380, h: 240 },
};

const LANGUAGE_BY_EXTENSION = {
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "js",
  ".ts": "ts",
  ".tsx": "ts",
  ".py": "py",
  ".go": "go",
  ".rs": "rs",
  ".css": "css",
  ".html": "html",
  ".htm": "html",
  ".json": "json",
  ".sh": "sh",
  ".bash": "sh",
  ".md": "md",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".rb": "rb",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".swift": "swift",
  ".kt": "kt",
};

/**
 * `src/server.js:120-180`, `src/server.js:120`, or `src/server.js#L120-L180`.
 * @param {unknown} ref
 */
export function parseCodeRef(ref) {
  const text = String(ref || "").trim();
  const match = /^(.+?)(?::|#L)(\d+)(?:-L?(\d+))?$/.exec(text);
  if (!match) return null;
  const start = Number(match[2]);
  const end = match[3] ? Number(match[3]) : start;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
  const file = match[1].trim();
  if (!file || file.includes("\0")) return null;
  return { path: file, start, end };
}

export function formatCodeRef({ path: file, start, end }) {
  return start === end ? `${file}:${start}` : `${file}:${start}-${end}`;
}

export function splitLines(text) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  // A trailing newline ends the last line; it does not start a new one.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// The pin: a short hash of the exact lines, so a card can prove it still shows
// what the agent saw. Trailing whitespace is ignored so an editor that trims
// lines does not mark every card stale.
export function codeRangeHash(lines) {
  const normalized = lines.map((line) => String(line).replace(/[ \t]+$/, "")).join("\n");
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

export function codeLanguage(file) {
  return LANGUAGE_BY_EXTENSION[path.extname(String(file || "")).toLowerCase()] || "text";
}

function attr(node, name) {
  const found = Array.isArray(node?.attrs) ? node.attrs.find((item) => item.name === name) : null;
  return found ? String(found.value) : null;
}

function hasAttr(node, name) {
  return attr(node, name) !== null;
}

function elementChildren(node) {
  return Array.isArray(node?.childNodes) ? node.childNodes.filter((child) => child.tagName) : [];
}

function textOf(node) {
  if (node.nodeName === "#text") return String(node.value || "");
  if (node.tagName === "script" || node.tagName === "style" || node.tagName === "template") return "";
  return Array.isArray(node.childNodes) ? node.childNodes.map(textOf).join("") : "";
}

function squash(text, max) {
  const value = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function findFirst(node, predicate) {
  for (const child of elementChildren(node)) {
    if (predicate(child)) return child;
    const nested = findFirst(child, predicate);
    if (nested) return nested;
  }
  return null;
}

function isCard(node) {
  return hasAttr(node, CARD_ATTRIBUTE);
}

function isSnapshot(node) {
  return node.tagName === "pre" && hasAttr(node, "data-snapshot");
}

function isHeading(node) {
  return /^h[1-4]$/.test(node.tagName || "");
}

function finiteAttr(node, name) {
  const raw = attr(node, name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// Cards directly owned by `container`: the first `[data-card]` on every path
// down from it. A nested board card owns the cards inside it.
function directCards(container) {
  const found = [];
  const visit = (node) => {
    for (const child of elementChildren(node)) {
      if (isCard(child)) found.push(child);
      else visit(child);
    }
  };
  visit(container);
  return found;
}

function cardKind(node) {
  const declared = String(attr(node, CARD_ATTRIBUTE) || "")
    .trim()
    .toLowerCase();
  if (declared === "board" || directCards(node).length > 0) return "board";
  if (hasAttr(node, "data-code")) return "code";
  return "html";
}

// The title is `data-title`, else the card's first heading that sits outside
// any nested card. That heading is not repeated in the card body.
function cardTitle(node) {
  const explicit = attr(node, "data-title");
  if (explicit && explicit.trim()) return { title: squash(explicit, MAX_TITLE_CHARS), heading: null };
  const heading = findFirst(node, (child) => isHeading(child) || isCard(child));
  if (heading && isHeading(heading)) return { title: squash(textOf(heading), MAX_TITLE_CHARS), heading };
  return { title: "", heading: null };
}

function ownContent(node, skip) {
  return (Array.isArray(node.childNodes) ? node.childNodes : []).filter(
    (child) => child !== skip && !(child.tagName && (isCard(child) || isSnapshot(child))),
  );
}

function noteText(node, skip) {
  return squash(ownContent(node, skip).map(textOf).join(" "), MAX_NOTE_CHARS);
}

function cardHtml(node, skip) {
  const html = ownContent(node, skip)
    .map((child) => serializeOuter(child))
    .join("")
    .trim();
  return html.length > MAX_CARD_HTML_CHARS ? html.slice(0, MAX_CARD_HTML_CHARS) : html;
}

function wrapperAttrs(node) {
  return (node.attrs || [])
    .filter((item) => item.name !== "style" && !/^data-(x|y|w|h)$/.test(item.name))
    .map((item) => [item.name, item.value]);
}

function snapshotLines(node) {
  const pre = elementChildren(node).find(isSnapshot);
  if (!pre) return null;
  let text = textOf(pre);
  if (text.startsWith("\n")) text = text.slice(1);
  return splitLines(text.replace(/\n$/, ""));
}

function headHtml(document) {
  const html = elementChildren(document).find((node) => node.tagName === "html");
  const head = elementChildren(html).find((node) => node.tagName === "head");
  if (!head) return "";
  return elementChildren(head)
    .filter((node) => node.tagName !== "title" && node.tagName !== "base")
    .map((node) => serializeOuter(node))
    .join("\n");
}

/**
 * Parse a board file into a plain model: levels (the root board and every
 * nested board) and cards with their layout. Code cards carry their reference
 * and pin only; `readBoard` adds the live code. Returns null when the HTML has
 * no `[data-hilight-board]` element.
 * @param {string} html
 */
export function parseBoardHtml(html) {
  const document = parse(String(html || ""));
  const root = findFirst(document, (node) => hasAttr(node, BOARD_ATTRIBUTE));
  if (!root) return null;
  const pageTitle = findFirst(document, (node) => node.tagName === "title");
  const rootTitle =
    squash(attr(root, BOARD_ATTRIBUTE) || "", MAX_TITLE_CHARS) ||
    squash(attr(root, "data-title") || "", MAX_TITLE_CHARS) ||
    (pageTitle ? squash(textOf(pageTitle), MAX_TITLE_CHARS) : "") ||
    "Board";
  /** @type {any[]} */
  const cards = [];
  const levels = [{ id: "", title: rootTitle, parent: null }];
  const usedIds = new Set();
  let generated = 0;

  const visitLevel = (container, levelId) => {
    for (const node of directCards(container)) {
      if (cards.length >= MAX_BOARD_CARDS) return;
      let id = String(attr(node, "id") || "").trim();
      if (!id || usedIds.has(id)) {
        do id = `card-${++generated}`;
        while (usedIds.has(id));
      }
      usedIds.add(id);
      const kind = cardKind(node);
      const { title, heading } = cardTitle(node);
      /** @type {any} */
      const card = {
        id,
        level: levelId,
        kind,
        title,
        x: finiteAttr(node, "data-x"),
        y: finiteAttr(node, "data-y"),
        w: finiteAttr(node, "data-w"),
        h: finiteAttr(node, "data-h"),
        has_id: Boolean(attr(node, "id")),
        to: String(attr(node, "data-to") || "")
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 12),
      };
      if (kind === "html") {
        card.html = cardHtml(node, heading);
        card.attrs = wrapperAttrs(node);
      } else {
        card.note = noteText(node, heading);
      }
      if (kind === "code") {
        const ref = parseCodeRef(attr(node, "data-code"));
        card.code = ref
          ? {
              ref: formatCodeRef(ref),
              path: ref.path,
              start: ref.start,
              end: ref.end,
              lang: codeLanguage(ref.path),
              pinned: (attr(node, "data-hash") || "").trim().toLowerCase() || null,
              snapshot: snapshotLines(node),
            }
          : { ref: String(attr(node, "data-code") || ""), error: "data-code must look like src/file.js:120-180" };
      }
      cards.push(card);
      if (kind === "board") {
        levels.push({ id, title: title || id, parent: levelId });
        visitLevel(node, id);
      }
    }
  };
  visitLevel(root, "");
  for (const level of levels) {
    layoutLevel(cards.filter((card) => card.level === level.id));
  }
  for (const card of cards) {
    if (card.kind !== "board") continue;
    const children = cards.filter((child) => child.level === card.id);
    card.board = { count: children.length, preview: previewRects(children) };
  }
  return {
    title: rootTitle,
    head: headHtml(document),
    main_attrs: wrapperAttrs(root),
    levels,
    cards,
  };
}

// A code card is always exactly as tall as its pinned range, so every line is
// on the canvas (no inner scrolling) and a mark drawn over the card maps back
// to the source lines under it (CODE_CARD_LAYOUT, shared with the renderer).
export function codeCardHeight(card) {
  const lines = card.code && !card.code.error ? Math.min(card.code.end - card.code.start + 1, MAX_CODE_CARD_LINES) : 3;
  return (
    CODE_CARD_LAYOUT.header +
    (card.note ? CODE_CARD_LAYOUT.note : 0) +
    CODE_CARD_LAYOUT.padTop +
    lines * CODE_CARD_LAYOUT.line +
    14
  );
}

// Cards without explicit positions flow into a three-column grid after any
// explicitly placed cards, so an agent can write a board without coordinates.
export function layoutLevel(cards) {
  for (const card of cards) {
    if (card.w === null || card.w <= 0) card.w = DEFAULT_SIZE[card.kind].w;
    if (card.h === null || card.h <= 0) card.h = DEFAULT_SIZE[card.kind].h;
    card.w = Math.min(Math.max(card.w, 160), 2400);
    card.h = card.kind === "code" ? codeCardHeight(card) : Math.min(Math.max(card.h, 100), 2400);
  }
  const placed = cards.filter((card) => card.x !== null && card.y !== null);
  const floating = cards.filter((card) => card.x === null || card.y === null);
  let originY = placed.length ? Math.max(...placed.map((card) => card.y + card.h)) + GRID_GAP * 2 : 0;
  const originX = placed.length ? Math.min(...placed.map((card) => card.x)) : 0;
  for (let index = 0; index < floating.length; index += GRID_COLUMNS) {
    const row = floating.slice(index, index + GRID_COLUMNS);
    let x = originX;
    for (const card of row) {
      card.x = x;
      card.y = originY;
      x += card.w + GRID_GAP;
    }
    originY += Math.max(...row.map((card) => card.h)) + GRID_GAP;
  }
}

function previewRects(children) {
  if (!children.length) return [];
  const minX = Math.min(...children.map((card) => card.x));
  const minY = Math.min(...children.map((card) => card.y));
  const maxX = Math.max(...children.map((card) => card.x + card.w));
  const maxY = Math.max(...children.map((card) => card.y + card.h));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  return children.slice(0, 40).map((card) => ({
    x: round3((card.x - minX) / width),
    y: round3((card.y - minY) / height),
    w: round3(card.w / width),
    h: round3(card.h / height),
    kind: card.kind,
  }));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

async function exists(file) {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

// Code paths resolve against the repository that holds the board (the nearest
// ancestor with a `.git` entry), else the board's own directory. That root is
// also the confinement boundary: a pinned path never reads outside it.
export async function findCodeRoot(boardFile) {
  let dir = path.dirname(path.resolve(boardFile));
  for (;;) {
    if (await exists(path.join(dir, ".git"))) return realpath(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return realpath(path.dirname(path.resolve(boardFile)));
}

/**
 * Read one pinned file inside `root`. Returns `{ lines }` or `{ error }`.
 * @param {string} root realpath of the code root
 * @param {string} file path from the card, relative to root
 */
export async function readCodeFile(root, file) {
  if (path.isAbsolute(file)) return { error: "use a path relative to the repository root" };
  const resolved = path.resolve(root, file);
  let real;
  try {
    real = await realpath(resolved);
  } catch {
    return { error: "file not found" };
  }
  const relative = path.relative(root, real);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return { error: "path is outside the repository" };
  }
  const info = await stat(real);
  if (!info.isFile()) return { error: "not a regular file" };
  if (info.size > MAX_CODE_FILE_BYTES) return { error: "file is larger than 2 MB" };
  const text = await readFile(real, "utf8");
  if (text.includes("\0")) return { error: "binary file" };
  return { lines: splitLines(text) };
}

function findBlock(lines, block, near) {
  if (!block.length || block.length > lines.length) return -1;
  let best = -1;
  for (let index = 0; index + block.length <= lines.length; index++) {
    let matches = true;
    for (let offset = 0; offset < block.length; offset++) {
      if (lines[index + offset].replace(/[ \t]+$/, "") !== block[offset].replace(/[ \t]+$/, "")) {
        matches = false;
        break;
      }
    }
    if (matches && (best === -1 || Math.abs(index - near) < Math.abs(best - near))) best = index;
  }
  return best;
}

/**
 * @typedef {{ status: string, error?: string, live?: string, lines?: string[], total?: number,
 *   moved_to?: { start: number, end: number }, snapshot?: string[] }} CodeCheck
 */

/**
 * Check one code card against the file on disk.
 * status: fresh (pin matches), unpinned (no pin yet), moved (the pinned lines
 * now sit at another range), stale (the lines changed), missing (file or range
 * gone), invalid (bad reference).
 * @param {any} code the card's `code` from parseBoardHtml
 * @param {{ lines?: string[], error?: string }} file
 * @returns {CodeCheck}
 */
export function checkCodeCard(code, file) {
  if (code.error) return { status: "invalid", error: code.error };
  if (file.error) return { status: "missing", error: file.error };
  const lines = file.lines || [];
  const span = code.end - code.start + 1;
  const pinnedSnapshot =
    Array.isArray(code.snapshot) && code.pinned && codeRangeHash(code.snapshot) === code.pinned ? code.snapshot : null;
  if (code.start > lines.length) {
    if (code.pinned && pinnedSnapshot) {
      const at = findBlock(lines, pinnedSnapshot, code.start - 1);
      if (at >= 0) return movedResult(lines, at, span);
    }
    return { status: "missing", error: `line ${code.start} is past the end of the file (${lines.length} lines)` };
  }
  const current = lines.slice(code.start - 1, code.end);
  const live = codeRangeHash(current);
  const total = lines.length;
  if (!code.pinned) return { status: "unpinned", live, lines: current, total };
  if (code.pinned === live) return { status: "fresh", live, lines: current, total };
  if (pinnedSnapshot) {
    const at = findBlock(lines, pinnedSnapshot, code.start - 1);
    if (at >= 0) return movedResult(lines, at, span);
  }
  return {
    status: "stale",
    live,
    lines: current,
    total,
    ...(pinnedSnapshot ? { snapshot: pinnedSnapshot } : {}),
  };
}

/** @returns {CodeCheck} */
function movedResult(lines, at, span) {
  const current = lines.slice(at, at + span);
  return {
    status: "moved",
    live: codeRangeHash(current),
    lines: current,
    total: lines.length,
    moved_to: { start: at + 1, end: at + span },
  };
}

/**
 * The full board model for the canvas: the parsed file plus live code read
 * from disk. Returns null when the file is not a board.
 * @param {string} boardFile
 * @param {string} [html] the file's contents, when already read
 */
export async function readBoard(boardFile, html) {
  const source = html ?? (await readFile(boardFile, "utf8"));
  const board = parseBoardHtml(source);
  if (!board) return null;
  const root = await findCodeRoot(boardFile);
  const files = new Map();
  for (const card of board.cards) {
    if (card.kind !== "code" || !card.code) continue;
    const code = card.code;
    if (!code.error && !files.has(code.path)) files.set(code.path, readCodeFile(root, code.path));
    const file = code.error ? {} : await files.get(code.path);
    const result = checkCodeCard(code, file);
    const shown = Array.isArray(result.lines) ? result.lines : [];
    card.code = {
      ref: code.ref,
      path: code.path,
      start: result.moved_to ? result.moved_to.start : code.start,
      end: result.moved_to ? result.moved_to.end : code.end,
      pinned_start: code.start,
      pinned_end: code.end,
      lang: code.lang,
      status: result.status,
      pinned: code.pinned || null,
      live: result.live || null,
      lines: shown.slice(0, MAX_CODE_CARD_LINES),
      truncated: shown.length > MAX_CODE_CARD_LINES,
      total: result.total || 0,
      ...(result.error ? { error: result.error } : {}),
      ...(result.moved_to ? { moved_to: result.moved_to } : {}),
      ...(result.snapshot ? { snapshot: result.snapshot.slice(0, MAX_CODE_CARD_LINES) } : {}),
    };
  }
  board.revision = crypto.createHash("sha256").update(source).digest("hex").slice(0, 16);
  board.root = path.basename(root);
  return board;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function lineIndent(html, offset) {
  const lineStart = html.lastIndexOf("\n", offset - 1) + 1;
  const match = /^[ \t]*/.exec(html.slice(lineStart, offset));
  return match ? match[0] : "";
}

function snapshotMarkup(lines, indent) {
  return `${indent}  <pre data-snapshot><code>${escapeHtml(lines.join("\n"))}</code></pre>\n`;
}

/**
 * Pin every code card in a board file: write `data-hash` and a
 * `<pre data-snapshot>` copy of the lines (so the plain page shows the code and
 * a stale card can show what changed). Cards that already have a pin are left
 * alone unless `repin` is set, so stamping never hides staleness by accident.
 * @param {string} boardFile
 * @param {{ repin?: boolean, write?: boolean }} [options]
 */
export async function stampBoardFile(boardFile, { repin = false, write = true } = {}) {
  const html = await readFile(boardFile, "utf8");
  const document = parse(html, { sourceCodeLocationInfo: true });
  const root = findFirst(document, (node) => hasAttr(node, BOARD_ATTRIBUTE));
  if (!root) return null;
  const codeRoot = await findCodeRoot(boardFile);
  /** @type {{ start: number, end: number, text: string }[]} */
  const edits = [];
  /** @type {any[]} */
  const results = [];
  const fileCache = new Map();
  const cardNodes = [];
  const collect = (node) => {
    for (const child of elementChildren(node)) {
      if (isCard(child) && hasAttr(child, "data-code")) cardNodes.push(child);
      collect(child);
    }
  };
  collect(root);
  let index = 0;
  for (const node of cardNodes) {
    index++;
    const id = attr(node, "id") || `code card ${index}`;
    const ref = parseCodeRef(attr(node, "data-code"));
    if (!ref) {
      results.push({ card: id, code: String(attr(node, "data-code") || ""), state: "invalid", status: "invalid" });
      continue;
    }
    if (!fileCache.has(ref.path)) fileCache.set(ref.path, readCodeFile(codeRoot, ref.path));
    const file = await fileCache.get(ref.path);
    const pinned = (attr(node, "data-hash") || "").trim().toLowerCase() || null;
    const snapshot = snapshotLines(node);
    const check = checkCodeCard(
      { ref: formatCodeRef(ref), path: ref.path, start: ref.start, end: ref.end, pinned, snapshot },
      file,
    );
    const location = node.sourceCodeLocation;
    if (check.status === "missing" || check.status === "invalid" || !location?.startTag) {
      results.push({
        card: id,
        code: formatCodeRef(ref),
        state: check.status,
        status: check.status,
        error: check.error || "",
      });
      continue;
    }
    let range = ref;
    let lines = check.lines || [];
    let action = check.status;
    if (check.status === "unpinned") action = "pinned";
    else if (check.status === "moved" && repin) {
      range = { path: ref.path, ...check.moved_to };
      action = "repinned";
    } else if (check.status === "stale" && repin) action = "repinned";
    const writePin = action === "pinned" || action === "repinned";
    const attrs = location.startTag.attrs || {};
    if (writePin) {
      const hash = codeRangeHash(lines);
      if (attrs["data-hash"]) {
        edits.push({
          start: attrs["data-hash"].startOffset,
          end: attrs["data-hash"].endOffset,
          text: `data-hash="${hash}"`,
        });
      } else {
        const after = attrs["data-code"].endOffset;
        edits.push({ start: after, end: after, text: ` data-hash="${hash}"` });
      }
      if (range !== ref) {
        edits.push({
          start: attrs["data-code"].startOffset,
          end: attrs["data-code"].endOffset,
          text: `data-code="${escapeHtml(formatCodeRef(range))}"`,
        });
      }
    }
    const pre = elementChildren(node).find(isSnapshot);
    const needsSnapshot =
      writePin || (check.status === "fresh" && (!snapshot || codeRangeHash(snapshot) !== codeRangeHash(lines)));
    if (needsSnapshot) {
      const indent = lineIndent(html, location.startTag.startOffset);
      if (pre?.sourceCodeLocation?.endTag) {
        const start = pre.sourceCodeLocation.startOffset;
        edits.push({
          start,
          end: pre.sourceCodeLocation.endOffset,
          text: snapshotMarkup(lines, "").trimStart().trimEnd(),
        });
      } else if (location.endTag) {
        const at = location.endTag.startOffset;
        const lineStart = html.lastIndexOf("\n", at - 1) + 1;
        if (/^[ \t]*$/.test(html.slice(lineStart, at))) {
          edits.push({ start: lineStart, end: lineStart, text: snapshotMarkup(lines, indent) });
        } else {
          edits.push({ start: at, end: at, text: `\n${snapshotMarkup(lines, indent)}${indent}` });
        }
      }
      if (action === "fresh") action = "snapshot";
    }
    results.push({
      card: id,
      code: formatCodeRef(range),
      state: check.status,
      status: action === "fresh" ? "ok" : action,
      ...(check.status === "moved" && !repin ? { moved_to: formatCodeRef({ path: ref.path, ...check.moved_to }) } : {}),
    });
  }
  edits.sort((a, b) => b.start - a.start);
  let next = html;
  for (const edit of edits) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  const changed = next !== html;
  if (changed && write) await writeFile(boardFile, next);
  return { file: boardFile, root: codeRoot, changed, cards: results, html: next };
}
