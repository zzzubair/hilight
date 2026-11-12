// The server's event log: server.log in the state directory, one line per event, for both the user
// and the agent to trace what happened after the fact (why a poll died, when a comment reached the
// agent). It is append-only and never truncated: a restart adds a line, it does not start a new
// file. Rotation keeps a few files of a bounded size (server.log, server.log.1, server.log.2).
//
// Line shape: `<ISO time> <session key or -> <event> <cause>`. A detached server's stdio is also
// appended to server.log (crash traces, warnings); those lines start with the time and `[hilight]`
// and never parse as events, so readers skip them.
import { appendFileSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";

export const EVENT_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const EVENT_LOG_FILES = 3;
const EVENT_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) ([0-9a-f]{16}|-) ([a-z][a-z-]*)(?: (.*))?$/;

/**
 * @typedef {{ at: string, session: string, event: string, cause: string }} LogEvent
 */

/** @param {{ at?: Date, session?: string, event: string, cause?: string }} entry */
export function formatEventLine({ at = new Date(), session = "", event, cause = "" }) {
  const oneLine = String(cause || "")
    .replace(/\s+/g, " ")
    .trim();
  return `${at.toISOString()} ${session || "-"} ${event}${oneLine ? ` ${oneLine}` : ""}`;
}

/** @param {string} line @returns {LogEvent | null} */
export function parseEventLine(line) {
  const match = EVENT_LINE.exec(line);
  if (!match) return null;
  return { at: match[1], session: match[2] === "-" ? "" : match[2], event: match[3], cause: match[4] || "" };
}

/**
 * Appends synchronously, so the line is on disk before a shutdown closes sockets or the process
 * exits. Logging must never break the server: every failure is swallowed.
 * @param {string} file
 * @param {{ maxBytes?: number, files?: number, now?: () => Date }} [options]
 */
export function createEventLog(file, { maxBytes = EVENT_LOG_MAX_BYTES, files = EVENT_LOG_FILES, now } = {}) {
  return {
    file,
    /** @param {string} session @param {string} event @param {string} [cause] */
    write(session, event, cause = "") {
      appendEventLine(file, formatEventLine({ at: now?.() ?? new Date(), session, event, cause }), {
        maxBytes,
        files,
      });
    },
  };
}

/** @param {string} file @param {string} line @param {{ maxBytes?: number, files?: number }} [options] */
export function appendEventLine(file, line, { maxBytes = EVENT_LOG_MAX_BYTES, files = EVENT_LOG_FILES } = {}) {
  try {
    rotateIfFull(file, maxBytes, files);
    appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    // A full disk or a read-only state dir must not take the server down with it.
  }
}

function rotateIfFull(file, maxBytes, files) {
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;
  rmSync(`${file}.${files - 1}`, { force: true });
  for (let index = files - 2; index >= 1; index -= 1) {
    try {
      renameSync(`${file}.${index}`, `${file}.${index + 1}`);
    } catch {
      // That generation does not exist yet.
    }
  }
  renameSync(file, `${file}.1`);
}

/**
 * Events from server.log and its rotated files, oldest first. `session` keeps that session's
 * events plus the server's own (start, stop), which explain the gaps between them.
 * @param {string} file
 * @param {{ session?: string, since?: number, limit?: number, files?: number }} [options]
 * @returns {LogEvent[]}
 */
export function readEvents(file, { session = "", since = 0, limit = 0, files = EVENT_LOG_FILES } = {}) {
  /** @type {LogEvent[]} */
  const events = [];
  for (let index = files - 1; index >= 0; index -= 1) {
    let text;
    try {
      text = readFileSync(index === 0 ? file : `${file}.${index}`, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const event = parseEventLine(line);
      if (!event) continue;
      if (session && event.session && event.session !== session) continue;
      if (since && Date.parse(event.at) < since) continue;
      events.push(event);
    }
  }
  return limit > 0 ? events.slice(-limit) : events;
}

/**
 * Why the server before this one went away: its last stop line, or, when it has none after its
 * start, that it exited without one (killed with SIGKILL, a crash, a machine restart).
 * @param {LogEvent[]} events
 * @returns {{ at: string, why: string } | null}
 */
export function previousServerExit(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.session) continue;
    if (event.event === "server-stop" || event.event === "server-crash") return { at: event.at, why: event.cause };
    if (event.event === "server-start") {
      // Only the start time is known; the exit itself left no line.
      return { at: "", why: "it exited without logging why (killed, crashed, or the machine restarted)" };
    }
  }
  return null;
}

/** @param {LogEvent} event */
export function eventLogText(event) {
  return `${event.at} ${event.session || "-"} ${event.event}${event.cause ? ` ${event.cause}` : ""}`;
}

/**
 * One event as the reviewer reads it on the page's Activity list.
 * @param {LogEvent} event
 */
export function pageEventText(event) {
  const cause = event.cause;
  switch (event.event) {
    case "opened":
      return "Review opened";
    case "listen":
      return /reconnected/.test(cause) ? "Agent listening again after the server came back" : "Agent started listening";
    case "listen-end":
      return `Agent stopped listening: ${cause || "the poll ended"}`;
    case "delivered":
      return `Agent got ${cause}`;
    case "held":
      return `Agent's reply waited so it could answer ${cause.split(",")[0]} too`;
    case "reply":
      return `Agent replied ${cause}`;
    case "requeued":
      return cause ? cause.charAt(0).toUpperCase() + cause.slice(1) : "Comments put back in the queue";
    case "ended":
      return `Session ended ${cause}`.trim();
    case "server-start":
      return "Hilight server started";
    case "server-stop":
      return `Hilight server stopped: ${cause.split(", pid ")[0]}`;
    case "server-crash":
      return `Hilight server crashed: ${cause}`;
    default:
      return `${event.event} ${cause}`.trim();
  }
}
