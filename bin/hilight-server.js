#!/usr/bin/env node
import { appendEventLine, formatEventLine } from "../src/event-log.js";
import { serverLogFile } from "../src/paths.js";
import { installServerStdioTimestamps } from "../src/server-log.js";

installServerStdioTimestamps();
let fatalExitScheduled = false;
function handleFatalServerError(kind, error) {
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[hilight] ${kind}: ${detail}`);
  if (fatalExitScheduled) return;
  // The one-line event a status or log reader looks for; the stack trace above is for humans.
  const message = error instanceof Error ? error.message : String(error);
  appendEventLine(serverLogFile(), formatEventLine({ event: "server-crash", cause: `${kind}: ${message}` }));
  fatalExitScheduled = true;
  process.exitCode = 1;
  // Let stderr flush before terminating. An uncaught exception handler prevents Node's default
  // exit, so explicitly end the process rather than leaving a possibly corrupted server alive.
  setImmediate(() => process.exit(1));
}

process.on("uncaughtException", (error) => handleFatalServerError("uncaught exception", error));

try {
  await import("./hilight.js");
} catch (error) {
  handleFatalServerError("server startup failed", error);
}
