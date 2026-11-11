// Pure board-canvas logic shared by the server (prompt normalization), the
// whiteboard frame bundle (scene building and the mark summary), and the
// tests. No DOM, no Node APIs.
//
// A board is shown as an Excalidraw scene: every card is an `embeddable`
// element whose content Hilight renders, and everything else on the canvas is
// the reviewer's own marks. The scene is saved in the whiteboard sidecar store
// under the reserved index `BOARD_SCENE_INDEX`, never in the board file.

export const BOARD_SCENE_INDEX = 999;
export const BOARD_PROMPT_TAG = "board";
export const BOARD_CANVAS_TARGET_TYPE = "board-canvas";
export const BOARD_CARD_TARGET_TYPE = "board-card";
export const CARD_ELEMENT_PREFIX = "card:";
export const LINK_ELEMENT_PREFIX = "link:";
export const CARD_LINK_PREFIX = "https://hilight.invalid/card/";

// Code-card geometry, shared with the frame's renderer so a mark drawn over a
// code card can be mapped back to the source lines under it.
// Geometry of a code card, shared by the server (card size), the renderer, and
// the mark summary (which source line sits under a mark). Code is 13px
// monospace; `char` is a slightly generous advance so a row never overflows.
export const CODE_CARD_LAYOUT = Object.freeze({
  header: 52,
  note: 30,
  padTop: 8,
  padBottom: 12,
  line: 20,
  gutter: 48,
  padRight: 16,
  char: 8,
  minCols: 48,
  maxCols: 100,
  tab: 4,
});

/** Horizontal space a code card needs besides its code columns. */
export function codeChromeWidth() {
  return CODE_CARD_LAYOUT.gutter + CODE_CARD_LAYOUT.padRight + 2;
}

function expandTabs(line) {
  let out = "";
  for (const char of String(line)) {
    if (char === "\t") out += " ".repeat(CODE_CARD_LAYOUT.tab - (out.length % CODE_CARD_LAYOUT.tab));
    else out += char;
  }
  return out.replace(/\s+$/, "");
}

/**
 * How many code columns a card shows: its longest line, kept between the
 * column limits. A width from the file is a ceiling, never a reason to grow.
 * @param {string[]} lines
 * @param {number | null} [maxWidth]
 */
export function codeColumns(lines, maxWidth = null) {
  const longest = Math.max(0, ...(lines || []).map((line) => expandTabs(line).length));
  let cols = Math.min(Math.max(longest, CODE_CARD_LAYOUT.minCols), CODE_CARD_LAYOUT.maxCols);
  if (Number.isFinite(maxWidth) && maxWidth > 0) {
    const ceiling = Math.floor((maxWidth - codeChromeWidth()) / CODE_CARD_LAYOUT.char);
    cols = Math.min(cols, Math.max(ceiling, 16));
  }
  return cols;
}

/** Card width for a number of code columns. */
export function codeCardWidth(cols) {
  return Math.ceil(codeChromeWidth() + cols * CODE_CARD_LAYOUT.char);
}

/**
 * Split source lines into the rows a code card draws. A line longer than
 * `cols` wraps, preferring a space near the end of the row; continuation rows
 * keep the line's indent plus two and are flagged so the card can mark them.
 * Character counts decide the rows, so the server's card height, the drawn rows,
 * and the line under a mark always agree.
 * @param {string[]} lines
 * @param {number} cols
 * @returns {{ index: number, cont: boolean, text: string }[]}
 */
export function codeRows(lines, cols) {
  const width = Number.isFinite(cols) && cols > 0 ? Math.max(8, Math.floor(cols)) : Infinity;
  const rows = [];
  (lines || []).forEach((raw, index) => {
    const line = expandTabs(raw);
    if (line.length <= width) {
      rows.push({ index, cont: false, text: line });
      return;
    }
    const indent = Math.min((/^ */.exec(line)?.[0].length || 0) + 2, Math.floor(width / 2));
    let rest = line;
    let room = width;
    let prefix = "";
    while (rest.length > room) {
      let cut = rest.lastIndexOf(" ", room - 1) + 1;
      if (cut <= Math.floor(room * 0.6)) cut = room;
      rows.push({ index, cont: prefix !== "", text: prefix + rest.slice(0, cut) });
      rest = rest.slice(cut);
      prefix = " ".repeat(indent);
      room = width - indent;
    }
    if (rest.length) rows.push({ index, cont: prefix !== "", text: prefix + rest });
  });
  return rows;
}

const NEAR_PX = 48;
const MAX_SUMMARY_LINES = 40;
const MAX_TEXT = 200;
const STAT_KEYS = ["arrows", "notes", "shapes", "freehand", "images", "moved", "removed"];

export function cardElementId(cardId) {
  return CARD_ELEMENT_PREFIX + String(cardId);
}

export function cardIdOfElement(element) {
  const id = element?.customData?.hilightCard;
  return typeof id === "string" && id ? id : null;
}

export function isCardElement(element) {
  return cardIdOfElement(element) !== null;
}

// Connectors the agent declared with `data-to`. They are drawn from the file
// on every load, locked, and never reported back as the reviewer's marks.
export function isLinkElement(element) {
  return Boolean(element?.customData?.hilightLink) || String(element?.id || "").startsWith(LINK_ELEMENT_PREFIX);
}

const LINK_GAP = 10;

function anchorPoints(a, b) {
  const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  const horizontal = Math.abs(dx) / (a.width + b.width) >= Math.abs(dy) / (a.height + b.height);
  if (horizontal) {
    const sign = dx >= 0 ? 1 : -1;
    return [
      { x: ac.x + (sign * a.width) / 2 + sign * LINK_GAP, y: ac.y },
      { x: bc.x - (sign * b.width) / 2 - sign * LINK_GAP, y: bc.y },
    ];
  }
  const sign = dy >= 0 ? 1 : -1;
  return [
    { x: ac.x, y: ac.y + (sign * a.height) / 2 + sign * LINK_GAP },
    { x: bc.x, y: bc.y - (sign * b.height) / 2 - sign * LINK_GAP },
  ];
}

/** Arrow elements for the `data-to` connectors between visible cards of one level. */
export function createLinkElements(cards, cardElements) {
  const byCard = new Map(
    cardElements.filter((element) => !element.isDeleted).map((element) => [cardIdOfElement(element), element]),
  );
  const links = [];
  for (const card of cards) {
    const from = byCard.get(card.id);
    if (!from) continue;
    for (const targetId of Array.isArray(card.to) ? card.to : []) {
      const to = byCard.get(targetId);
      if (!to || to === from) continue;
      const [start, end] = anchorPoints(from, to);
      links.push({
        id: `${LINK_ELEMENT_PREFIX}${card.id}>${targetId}`,
        type: "arrow",
        x: start.x,
        y: start.y,
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
        points: [
          [0, 0],
          [end.x - start.x, end.y - start.y],
        ],
        angle: 0,
        strokeColor: "#6f6e69",
        backgroundColor: "transparent",
        fillStyle: "solid",
        strokeWidth: 2,
        strokeStyle: "solid",
        roughness: 0,
        opacity: 100,
        roundness: null,
        locked: true,
        startArrowhead: null,
        endArrowhead: "triangle",
        startBinding: { elementId: from.id, focus: 0, gap: LINK_GAP },
        endBinding: { elementId: to.id, focus: 0, gap: LINK_GAP },
        boundElements: [],
        groupIds: [],
        frameId: null,
        isDeleted: false,
        customData: { hilightLink: `${card.id}>${targetId}`, boardLevel: card.level },
      });
    }
  }
  return links;
}

export function elementLevel(element) {
  const level = element?.customData?.boardLevel;
  return typeof level === "string" ? level : "";
}

function sameRect(a, b) {
  return Boolean(a && b) && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function fileRect(card) {
  return { x: card.x, y: card.y, w: card.w, h: card.h };
}

/** A fresh card element at the card's position in the file. */
export function createCardElement(card) {
  return {
    id: cardElementId(card.id),
    type: "embeddable",
    x: card.x,
    y: card.y,
    width: card.w,
    height: card.h,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    roundness: { type: 3 },
    locked: false,
    link: CARD_LINK_PREFIX + encodeURIComponent(card.id),
    boundElements: [],
    groupIds: [],
    frameId: null,
    isDeleted: false,
    customData: { hilightCard: card.id, boardLevel: card.level, fileRect: fileRect(card) },
  };
}

function shiftArrow(arrow, startDelta, endDelta) {
  if (!Array.isArray(arrow.points) || arrow.points.length < 2) return arrow;
  const last = arrow.points.length - 1;
  const points = arrow.points.map((point, index) => {
    if (index === 0) return [0, 0];
    if (index === last) {
      return [point[0] + endDelta.x - startDelta.x, point[1] + endDelta.y - startDelta.y];
    }
    return [point[0] - startDelta.x, point[1] - startDelta.y];
  });
  return { ...arrow, x: arrow.x + startDelta.x, y: arrow.y + startDelta.y, points };
}

/**
 * Build one level's scene from the board model and the saved elements of that
 * level. The file decides which cards exist and what they show. A card keeps
 * the reviewer's position only while the file still places it where it was
 * when the reviewer moved it; when the agent moves a card in the file, the
 * file wins and arrows bound to the card follow it.
 * @param {any[]} cards cards of this level from the board model
 * @param {any[]} saved saved elements of this level (cards and marks)
 */
export function reconcileLevelElements(cards, saved) {
  const savedById = new Map((Array.isArray(saved) ? saved : []).map((element) => [element.id, element]));
  const liveCardIds = new Set(cards.map((card) => cardElementId(card.id)));
  const deltas = new Map();
  /** @type {any[]} */
  const cardElements = [];
  for (const card of cards) {
    const id = cardElementId(card.id);
    const previous = savedById.get(id);
    const element = createCardElement(card);
    if (previous && sameRect(previous.customData?.fileRect, fileRect(card))) {
      element.x = Number(previous.x);
      element.y = Number(previous.y);
      element.width = Number(previous.width) || element.width;
      element.height = Number(previous.height) || element.height;
      element.isDeleted = Boolean(previous.isDeleted);
    } else if (previous && !previous.isDeleted) {
      deltas.set(id, { x: element.x - Number(previous.x), y: element.y - Number(previous.y) });
    }
    cardElements.push(element);
  }
  const zero = { x: 0, y: 0 };
  const marks = [];
  for (const element of Array.isArray(saved) ? saved : []) {
    if (isCardElement(element) || String(element.id || "").startsWith(CARD_ELEMENT_PREFIX)) continue;
    if (isLinkElement(element)) continue;
    let next = element;
    const start = element.startBinding?.elementId;
    const end = element.endBinding?.elementId;
    if (start || end) {
      const startDelta = (start && deltas.get(start)) || zero;
      const endDelta = (end && deltas.get(end)) || zero;
      if (startDelta !== zero || endDelta !== zero) next = shiftArrow(next, startDelta, endDelta);
      if (start && start.startsWith(CARD_ELEMENT_PREFIX) && !liveCardIds.has(start)) {
        next = { ...next, startBinding: null };
      }
      if (end && end.startsWith(CARD_ELEMENT_PREFIX) && !liveCardIds.has(end)) next = { ...next, endBinding: null };
    }
    marks.push(next);
  }
  const links = createLinkElements(cards, cardElements);
  const bound = new Map();
  for (const mark of [...links, ...marks]) {
    if (mark.isDeleted) continue;
    for (const binding of [mark.startBinding, mark.endBinding]) {
      const target = binding?.elementId;
      if (!target || !liveCardIds.has(target)) continue;
      if (!bound.has(target)) bound.set(target, []);
      const list = bound.get(target);
      if (!list.some((entry) => entry.id === mark.id)) list.push({ id: mark.id, type: "arrow" });
    }
  }
  for (const element of cardElements) element.boundElements = bound.get(element.id) || [];
  return [...cardElements, ...links, ...marks];
}

/** Tag reviewer-made elements with the level they were drawn on. */
export function tagLevel(elements, level) {
  return elements.map((element) =>
    elementLevel(element) === level && element.customData?.boardLevel !== undefined
      ? element
      : { ...element, customData: { ...(element.customData || {}), boardLevel: level } },
  );
}

function clip(text, max = MAX_TEXT) {
  const value = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
}

function bounds(element) {
  const x = Number(element.x) || 0;
  const y = Number(element.y) || 0;
  if (Array.isArray(element.points) && element.points.length) {
    const xs = element.points.map((point) => x + Number(point[0]));
    const ys = element.points.map((point) => y + Number(point[1]));
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
  }
  return { x1: x, y1: y, x2: x + (Number(element.width) || 0), y2: y + (Number(element.height) || 0) };
}

function area(rect) {
  return Math.max(0, rect.x2 - rect.x1) * Math.max(0, rect.y2 - rect.y1);
}

function intersection(a, b) {
  return {
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
    x2: Math.min(a.x2, b.x2),
    y2: Math.min(a.y2, b.y2),
  };
}

function distance(rect, point) {
  const dx = Math.max(rect.x1 - point.x, 0, point.x - rect.x2);
  const dy = Math.max(rect.y1 - point.y, 0, point.y - rect.y2);
  return Math.hypot(dx, dy);
}

function center(rect) {
  return { x: (rect.x1 + rect.x2) / 2, y: (rect.y1 + rect.y2) / 2 };
}

function cardName(card) {
  return card.title ? `card #${card.id} "${clip(card.title, 80)}"` : `card #${card.id}`;
}

/**
 * Map a vertical span of a code card (scene coordinates) to source lines.
 * @param {any} card model card with code.start/end
 * @param {{ y: number, h: number }} cardRect current rect of the card element
 * @param {number} y1
 * @param {number} y2
 * @param {number} [scrollTop] the card's internal scroll offset
 */
export function codeLinesUnder(card, cardRect, y1, y2, scrollTop = 0) {
  const code = card?.code;
  if (!code || !Array.isArray(code.lines) || !code.lines.length) return null;
  const rows = codeRows(code.lines, code.cols);
  const top = cardRect.y + CODE_CARD_LAYOUT.header + (card.note ? CODE_CARD_LAYOUT.note : 0) + CODE_CARD_LAYOUT.padTop;
  const first = Math.floor((Math.max(y1, top) - top + scrollTop) / CODE_CARD_LAYOUT.line);
  const last = Math.floor((Math.min(y2, cardRect.y + cardRect.h) - top + scrollTop) / CODE_CARD_LAYOUT.line);
  if (last < 0 || first > rows.length - 1 || last < first) return null;
  const from = rows[Math.max(0, first)].index;
  const to = rows[Math.min(rows.length - 1, last)].index;
  return { start: code.start + from, end: code.start + to, path: code.path };
}

function describeSpot(card, rect, mark, scrollTops) {
  if (card.kind === "code") {
    const lines = codeLinesUnder(card, rect, mark.y1, mark.y2, scrollTops?.[card.id] || 0);
    if (lines) {
      const range = lines.start === lines.end ? `line ${lines.start}` : `lines ${lines.start}-${lines.end}`;
      return `${range} of ${lines.path} in ${cardName(card)}`;
    }
  }
  return cardName(card);
}

/**
 * Turn the reviewer's canvas marks into short sentences the agent can act on.
 * @param {{ cards: any[], levels: any[] }} board the model the scene was built from
 * @param {any[]} elements every element of every level (cards and marks)
 * @param {{ scrollTops?: Record<string, number> }} [options]
 */
export function summarizeBoardMarks(board, elements, { scrollTops = {} } = {}) {
  const cardsById = new Map((board?.cards || []).map((card) => [card.id, card]));
  const levels = Array.isArray(board?.levels) && board.levels.length ? board.levels : [{ id: "", title: "" }];
  const levelTitle = new Map(levels.map((level) => [level.id, level.title]));
  /** @type {Record<string, number>} */
  const stats = Object.fromEntries(STAT_KEYS.map((key) => [key, 0]));
  const lines = [];
  const all = Array.isArray(elements) ? elements : [];
  const textByContainer = new Map();
  for (const element of all) {
    if (element.type === "text" && element.containerId && !element.isDeleted) {
      textByContainer.set(element.containerId, clip(element.text || element.originalText));
    }
  }
  const levelIds = [...new Set([...levels.map((level) => level.id), ...all.map(elementLevel)])];
  for (const level of levelIds) {
    const prefix = level
      ? `[in board #${level}${levelTitle.get(level) ? ` "${clip(levelTitle.get(level), 60)}"` : ""}] `
      : "";
    const scene = all.filter((element) => elementLevel(element) === level);
    /** @type {{ card: any, rect: any, raw: any }[]} */
    const cards = [];
    for (const element of scene) {
      const id = cardIdOfElement(element);
      const card = id ? cardsById.get(id) : null;
      if (!card) continue;
      if (element.isDeleted) {
        lines.push(`${prefix}Removed ${cardName(card)} from the board`);
        stats.removed++;
        continue;
      }
      const rect = bounds(element);
      cards.push({ card, rect, raw: { y: rect.y1, h: rect.y2 - rect.y1 } });
      const before = element.customData?.fileRect;
      if (before) {
        const moved = Math.round(element.x) !== before.x || Math.round(element.y) !== before.y;
        const resized = Math.round(element.width) !== before.w || Math.round(element.height) !== before.h;
        if (moved || resized) {
          const parts = [];
          if (moved) parts.push(`to x=${Math.round(element.x)} y=${Math.round(element.y)}`);
          if (resized) parts.push(`resized to ${Math.round(element.width)}x${Math.round(element.height)}`);
          lines.push(`${prefix}Moved ${cardName(card)} ${parts.join(", ")}`);
          stats.moved++;
        }
      }
    }
    const cardAt = (point) => {
      let best = null;
      let bestDistance = Infinity;
      for (const entry of cards) {
        const d = distance(entry.rect, point);
        if (d < bestDistance) {
          best = entry;
          bestDistance = d;
        }
      }
      return best ? { ...best, distance: bestDistance } : null;
    };
    const where = (rect) => {
      const point = center(rect);
      const hit = cardAt(point);
      if (!hit) return "on the empty canvas";
      if (hit.distance === 0) return `on ${describeSpot(hit.card, hit.raw, rect, scrollTops)}`;
      if (hit.distance <= NEAR_PX * 3) return `next to ${cardName(hit.card)}`;
      return `in empty space nearest ${cardName(hit.card)}`;
    };
    const covered = (rect) =>
      cards.filter((entry) => {
        const overlap = area(intersection(entry.rect, rect));
        return overlap > 0 && overlap >= 0.6 * area(entry.rect);
      });
    const freehand = new Map();
    for (const element of scene) {
      if (element.isDeleted || isCardElement(element) || isLinkElement(element)) continue;
      if (element.type === "text" && element.containerId) continue;
      const rect = bounds(element);
      if (element.type === "arrow" || element.type === "line") {
        stats.arrows++;
        const label = textByContainer.get(element.id);
        const points = Array.isArray(element.points) ? element.points : [[0, 0]];
        const startPoint = { x: element.x + points[0][0], y: element.y + points[0][1] };
        const lastPoint = points[points.length - 1];
        const endPoint = { x: element.x + lastPoint[0], y: element.y + lastPoint[1] };
        const end = (binding, point) => {
          const id = binding?.elementId;
          const bound = id ? cards.find((entry) => cardElementId(entry.card.id) === id) : null;
          if (bound) return describeSpot(bound.card, bound.raw, { y1: point.y, y2: point.y }, scrollTops);
          if (id) {
            const target = scene.find((item) => item.id === id);
            const text = target ? textByContainer.get(target.id) || clip(target.text) : "";
            if (text) return `the note "${text}"`;
          }
          const hit = cardAt(point);
          if (hit && hit.distance <= NEAR_PX) {
            return describeSpot(hit.card, hit.raw, { y1: point.y, y2: point.y }, scrollTops);
          }
          return null;
        };
        const from = end(element.startBinding, startPoint);
        const to = end(element.endBinding, endPoint);
        const kind = element.type === "line" ? "Line" : "Arrow";
        let sentence;
        if (from && to) sentence = `${kind} from ${from} to ${to}`;
        else if (to) sentence = `${kind} pointing at ${to}`;
        else if (from) sentence = `${kind} from ${from} into empty space`;
        else sentence = `${kind} ${where(rect)}`;
        lines.push(`${prefix}${sentence}${label ? `, labeled "${label}"` : ""}`);
        continue;
      }
      if (element.type === "text") {
        stats.notes++;
        lines.push(`${prefix}Note "${clip(element.text || element.originalText)}" ${where(rect)}`);
        continue;
      }
      if (element.type === "freedraw") {
        const point = center(rect);
        const hit = cardAt(point);
        const key = hit && hit.distance === 0 ? describeSpot(hit.card, hit.raw, rect, scrollTops) : where(rect);
        freehand.set(key, (freehand.get(key) || 0) + 1);
        stats.freehand++;
        continue;
      }
      if (element.type === "image") {
        stats.images++;
        lines.push(`${prefix}Pasted an image ${where(rect)}`);
        continue;
      }
      if (["rectangle", "ellipse", "diamond"].includes(element.type)) {
        const label = textByContainer.get(element.id);
        if (label) {
          stats.notes++;
          lines.push(`${prefix}Sticky note "${label}" ${where(rect)}`);
          continue;
        }
        stats.shapes++;
        const verb = element.type === "ellipse" ? "Circled" : "Boxed";
        const around = covered(rect);
        if (around.length) {
          lines.push(`${prefix}${verb} ${around.map((entry) => cardName(entry.card)).join(", ")}`);
        } else {
          const hit = cardAt(center(rect));
          if (hit && hit.distance === 0) {
            lines.push(`${prefix}${verb} ${describeSpot(hit.card, hit.raw, rect, scrollTops)}`);
          } else {
            lines.push(`${prefix}Drew a ${element.type} ${where(rect)}`);
          }
        }
      }
    }
    for (const [spot, count] of freehand) {
      const target =
        spot.startsWith("on ") || spot.startsWith("next to") || spot.startsWith("in ") ? spot : `on ${spot}`;
      lines.push(`${prefix}Freehand mark${count === 1 ? "" : "s"} ${target}`);
    }
  }
  const overflow = lines.length - MAX_SUMMARY_LINES;
  const bounded = overflow > 0 ? [...lines.slice(0, MAX_SUMMARY_LINES), `...and ${overflow} more marks`] : lines;
  return { lines: bounded, stats };
}

/**
 * Which lines of `live` are not in `pinned` (by longest common subsequence),
 * and how many pinned lines are gone. Used to mark what changed on a stale
 * code card without changing its line layout.
 * @param {string[]} pinned
 * @param {string[]} live
 */
export function diffCodeLines(pinned, live) {
  const a = (Array.isArray(pinned) ? pinned : []).map((line) => String(line).replace(/[ \t]+$/, ""));
  const b = (Array.isArray(live) ? live : []).map((line) => String(line).replace(/[ \t]+$/, ""));
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const kept = new Set();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      kept.add(j);
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) i++;
    else j++;
  }
  const changed = [];
  for (let index = 0; index < b.length; index++) if (!kept.has(index)) changed.push(index);
  return { changed, removed: a.length - kept.size };
}

function boundedInt(value, max = 10_000) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(Math.round(number), max);
}

// Fixed-shape copies of the board prompt targets, so a hostile POST cannot put
// arbitrary structure in state.json or in front of the agent.
export function normalizeBoardCanvasTarget(target) {
  const stats = target?.stats && typeof target.stats === "object" && !Array.isArray(target.stats) ? target.stats : {};
  return {
    type: BOARD_CANVAS_TARGET_TYPE,
    revision: String(target?.revision || "").slice(0, 64),
    scenePath: String(target?.scenePath || ""),
    previewPath: String(target?.previewPath || ""),
    stats: Object.fromEntries(STAT_KEYS.map((key) => [key, boundedInt(stats[key])])),
  };
}

export function normalizeBoardCardTarget(target) {
  const kind = ["html", "code", "board"].includes(target?.kind) ? target.kind : "html";
  /** @type {Record<string, unknown>} */
  const normalized = {
    type: BOARD_CARD_TARGET_TYPE,
    card: String(target?.card || "").slice(0, 200),
    kind,
    title: clip(target?.title, 160),
  };
  if (kind === "code") {
    normalized.code = String(target?.code || "").slice(0, 500);
    normalized.status = ["fresh", "unpinned", "moved", "stale", "missing", "invalid"].includes(target?.status)
      ? target.status
      : "unpinned";
  }
  return normalized;
}
