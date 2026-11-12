import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createEventLog,
  formatEventLine,
  pageEventText,
  parseEventLine,
  previousServerExit,
  readEvents,
} from "../src/event-log.js";
import { formatTraceError, parseSince, toonString } from "../src/trace.js";

const KEY = "0123456789abcdef";

test("server.log appends across restarts and rotates into a few bounded files, never truncating", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hilight-event-log-"));
  const file = path.join(dir, "server.log");
  try {
    await writeFile(file, "2026-11-12T10:00:00.000Z [hilight] a crash trace line from stdio\n");
    const first = createEventLog(file, { maxBytes: 400, files: 3 });
    first.write("", "server-start", "pid 1");
    const second = createEventLog(file, { maxBytes: 400, files: 3 });
    second.write(KEY, "listen", "");
    assert.match(await readFile(file, "utf8"), /a crash trace line[\s\S]*server-start pid 1[\s\S]*listen/);
    for (let index = 0; index < 40; index += 1) second.write(KEY, "delivered", `1 comment (c${index})`);
    const current = await readFile(file, "utf8");
    assert.ok(current.length <= 400 + 80, "the live file stays near the cap");
    assert.ok((await readFile(`${file}.1`, "utf8")).length > 0);
    await assert.rejects(readFile(`${file}.3`), "only three files are kept");
    const events = readEvents(file, { session: KEY, files: 3 });
    assert.equal(events.at(-1)?.cause, "1 comment (c39)", "readers see the newest events across rotated files");
    assert.ok(events.every((event) => event.session === KEY || event.session === ""));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("event lines parse back, and stdio lines are skipped", () => {
  const line = formatEventLine({
    at: new Date("2026-11-12T23:05:00.000Z"),
    session: KEY,
    event: "listen-end",
    cause: "the server\nstopped",
  });
  assert.equal(line, `2026-11-12T23:05:00.000Z ${KEY} listen-end the server stopped`);
  assert.deepEqual(parseEventLine(line), {
    at: "2026-11-12T23:05:00.000Z",
    session: KEY,
    event: "listen-end",
    cause: "the server stopped",
  });
  assert.equal(parseEventLine("2026-11-12T23:05:00.000Z [hilight] WARNING: x"), null);
});

test("previousServerExit names the last stop, or says the server left without one", () => {
  const at = "2026-11-12T23:05:00.000Z";
  assert.deepEqual(
    previousServerExit([
      { at, session: "", event: "server-start", cause: "" },
      { at, session: "", event: "server-stop", cause: "SIGTERM: stopped by its supervisor or a kill" },
    ]),
    { at, why: "SIGTERM: stopped by its supervisor or a kill" },
  );
  assert.match(
    String(previousServerExit([{ at, session: "", event: "server-start", cause: "" }])?.why),
    /exited without logging why/,
  );
  assert.equal(previousServerExit([]), null);
});

test("the page reads each event as a plain sentence", () => {
  const at = "2026-11-12T23:05:00.000Z";
  assert.equal(
    pageEventText({ at, session: KEY, event: "delivered", cause: "2 comments (c1, page)" }),
    "Agent got 2 comments (c1, page)",
  );
  assert.equal(
    pageEventText({ at, session: "", event: "server-stop", cause: "SIGTERM: stopped by a kill, pid 4, up 2h" }),
    "Hilight server stopped: SIGTERM: stopped by a kill",
  );
  assert.equal(
    pageEventText({ at, session: KEY, event: "listen", cause: "reconnected after the server went away" }),
    "Agent listening again after the server came back",
  );
});

test("--since takes an age, a clock time today, or an ISO time", () => {
  const now = Date.parse("2026-11-12T23:30:00.000Z");
  assert.equal(parseSince("30m", now), now - 30 * 60_000);
  assert.equal(parseSince("2h", now), now - 2 * 3_600_000);
  assert.equal(parseSince("2026-11-12T23:00:00Z", now), Date.parse("2026-11-12T23:00:00Z"));
  const clock = new Date(parseSince("09:15", now));
  assert.equal(clock.getHours(), 9);
  assert.equal(clock.getMinutes(), 15);
  assert.ok(Number.isNaN(parseSince("soon", now)));
  assert.equal(parseSince(undefined, now), 0);
});

test("a traced error renders the SDK's fields plus why and the log lines, as TOON", () => {
  assert.equal(toonString("plain words"), "plain words");
  assert.equal(toonString("a, b"), '"a, b"');
  assert.equal(toonString("-x"), '"-x"');
  assert.equal(
    formatTraceError({
      message: "The Hilight server went away",
      code: "SERVER_ERROR",
      suggestions: ["Re-run it"],
      why: "the server stopped at 23:05: SIGTERM",
      log: ["2026-11-12T23:05:00.000Z - server-stop SIGTERM"],
    }),
    [
      "error: The Hilight server went away",
      'why: "the server stopped at 23:05: SIGTERM"',
      "code: SERVER_ERROR",
      "help[1]: Re-run it",
      "log[1]:",
      '  - "2026-11-12T23:05:00.000Z - server-stop SIGTERM"',
      "",
    ].join("\n"),
  );
  assert.equal(
    formatTraceError({ message: "File not found: /x.html", code: "NOT_FOUND", suggestions: ["Create it, then run"] }),
    'error: "File not found: /x.html"\ncode: NOT_FOUND\nhelp[1]: "Create it, then run"\n',
  );
});
