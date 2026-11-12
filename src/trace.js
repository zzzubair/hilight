// What happened, for the agent: `hilight status` and `hilight log` read server.log (src/event-log.js)
// and the session store, and CLI errors carry the cause plus the last few relevant log lines, so an
// agent never has to go digging to explain a failure to its user.
import { eventLogText, readEvents } from "./event-log.js";

const LOG_LINES_IN_ERRORS = 5;

/**
 * `--since` as an epoch ms: an ISO time, a clock time today (`23:05`), or an age (`30m`, `2h`, `1d`).
 * @param {string | undefined} value
 * @param {number} [now]
 * @returns {number}
 */
export function parseSince(value, now = Date.now()) {
  const text = String(value || "").trim();
  if (!text) return 0;
  const age = /^(\d+)\s*(s|m|h|d)$/i.exec(text);
  if (age) {
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[age[2].toLowerCase()];
    return now - Number(age[1]) * unit;
  }
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (clock) {
    const today = new Date(now);
    today.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    return today.getTime();
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/**
 * The few log lines that explain a failure for this session: its own events and the server's.
 * @param {string} logFile
 * @param {string} [session]
 * @returns {string[]}
 */
export function recentLogLines(logFile, session = "") {
  return readEvents(logFile, { session, limit: LOG_LINES_IN_ERRORS }).map(eventLogText);
}

/**
 * Why the server went away, from its last stop or crash line since `since` (or its silence).
 * @param {string} logFile
 * @param {number} since
 */
export function serverExitCause(logFile, since) {
  const events = readEvents(logFile, { since });
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event.session && (event.event === "server-stop" || event.event === "server-crash")) {
      return `the server ${event.event === "server-crash" ? "crashed" : "stopped"} at ${event.at}: ${event.cause}`;
    }
  }
  return "the server went away without logging why (killed with SIGKILL, crashed hard, or the machine restarted)";
}

/**
 * @param {{ file: string, key: string, logFile: string, session: any, health: any, now?: number }} input
 */
export function createStatusOutput({ file, key, logFile, session, health, now = Date.now() }) {
  const events = readEvents(logFile, { session: key });
  const last = (name) => [...events].reverse().find((event) => event.event === name && event.session === key);
  const lastServer = (name) => [...events].reverse().find((event) => event.event === name && !event.session);
  const describe = (event) => (event ? `${event.at}${event.cause ? `: ${event.cause}` : ""}` : "none");
  const listener = Array.isArray(health?.listeners) ? health.listeners.find((item) => item?.key === key) : null;
  const stopped = last("listen-end");
  const listening = last("listen");
  const agent = !health
    ? "not listening: the server is not running"
    : listener
      ? `listening (${listener.label})${listening ? ` since ${listening.at}` : ""}`
      : stopped && (!listening || stopped.at >= listening.at)
        ? `not listening since ${stopped.at}: ${stopped.cause}`
        : "not listening";
  const queued = Array.isArray(session?.prompts) ? session.prompts.length : 0;
  /** @type {Record<string, unknown>} */
  const output = {
    file,
    server: health
      ? `running, pid ${health.pid ?? "?"}, v${health.version}${health.started_at ? `, up since ${health.started_at}` : ""}`
      : `not running${lastServer("server-stop") ? `; last stop ${describe(lastServer("server-stop"))}` : ""}`,
    last_restart: health?.previous_exit
      ? `${health.started_at}; the server before it: ${health.previous_exit.why}${health.previous_exit.at ? ` at ${health.previous_exit.at}` : ""}`
      : describe(lastServer("server-start")),
    session: session ? String(session.status || "open") : "none",
    agent,
    queued: `${queued} comment${queued === 1 ? "" : "s"} waiting for the agent`,
    last_delivery: describe(last("delivered")),
    last_held: describe(last("held")),
    last_reply: describe(last("reply")),
  };
  const age = health?.started_at ? now - Date.parse(health.started_at) : NaN;
  if (Number.isFinite(age) && age >= 0) output.uptime = formatAge(age);
  output.next_step = session
    ? `History: \`hilight log ${file} --since 1h\`. ${listener ? "" : `Listen: \`hilight poll ${file}\`.`}`.trim()
    : `Open it first: \`hilight ${file}\``;
  return output;
}

/**
 * @param {{ file: string, key: string, logFile: string, since?: number, limit?: number }} input
 */
export function createLogOutput({ file, key, logFile, since = 0, limit = 30 }) {
  const all = readEvents(logFile, { session: key, since });
  const events = all.slice(-limit);
  const rows = events.map((event) => ({
    at: event.at,
    event: event.event,
    detail: event.cause,
  }));
  /** @type {Record<string, unknown>} */
  const output = { file, log: logFile };
  if (!rows.length) {
    output.events = since ? "none since then" : "none recorded yet";
  } else {
    output.events = rows;
    if (all.length > rows.length)
      output.shown = `last ${rows.length} of ${all.length}; pass --limit or --since for more`;
  }
  return output;
}

function formatAge(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// A TOON string, quoted by TOON's own rule (isSafeUnquoted in @toon-format/toon), so an error with
// no cause or log renders byte for byte as the SDK's.
export function toonString(value) {
  const text = String(value ?? "");
  const safe =
    text !== "" &&
    text === text.trim() &&
    !/^(true|false|null)$/.test(text) &&
    !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text) &&
    !/^0\d+$/.test(text) &&
    !/[:"\\[\]{}\n\r\t,]/.test(text) &&
    !text.startsWith("-");
  if (safe) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}

/**
 * The CLI's error shape: the SDK's `error`, `code`, `help`, plus `why` (the cause) and `log` (the
 * last relevant server.log lines) when Hilight knows them.
 * @param {{ message: string, code: string, suggestions?: string[], why?: string, log?: string[] }} error
 */
export function formatTraceError(error) {
  const lines = [`error: ${toonString(error.message)}`];
  if (error.why) lines.push(`why: ${toonString(error.why)}`);
  lines.push(`code: ${toonString(error.code)}`);
  const help = error.suggestions || [];
  if (help.length) lines.push(`help[${help.length}]: ${help.map(toonString).join(",")}`);
  const log = error.log || [];
  if (log.length) {
    lines.push(`log[${log.length}]:`);
    for (const line of log) lines.push(`  - ${toonString(line)}`);
  }
  return `${lines.join("\n")}\n`;
}
