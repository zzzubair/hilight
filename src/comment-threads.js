import { normalizePromptId } from "./chat-messages.js";

// Margin comment threads are durable conversations, independent of the bounded chat transcript.
// The root annotation is the anchor. The server mints a short id (`c1`, `c2`, ...) so an agent can
// copy it from poll output into a reply section header without quoting a long token.
export const THREAD_ID_RE = /^c[1-9]\d{0,8}$/;
const REVISION_ID_RE = /^\S{1,128}$/;
// `## c3` or `## c3 reveal=r2` on a line of its own starts a thread section. Anything else on the
// heading line makes it an ordinary Markdown heading, so `## c4 model` stays in chat.
const SECTION_RE = /^##[ \t]+(c[1-9]\d{0,8})(?:[ \t]+reveal=(\S+))?[ \t]*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const NON_THREAD_TAGS = new Set(["message", "whiteboard", "board", "layout-warnings"]);

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, code: "VALIDATION_ERROR" });
}

/**
 * Split an agent reply into its chat part and its per-thread sections. Text before the first
 * section header (or the whole reply when there is none) is the chat part. Headers inside fenced
 * code blocks are ignored.
 * @param {string} text
 * @returns {{ chat: string, sections: { threadId: string, revisionId: string, text: string }[] }}
 */
export function splitThreadReply(text) {
  const lines = String(text || "").split(/\r?\n/);
  const chat = [];
  /** @type {{ threadId: string, revisionId: string, lines: string[] }[]} */
  const sections = [];
  let fence = "";
  for (const line of lines) {
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) fence = fence ? (fenceMatch[1] === fence ? "" : fence) : fenceMatch[1];
    const header = !fence && !fenceMatch ? line.match(SECTION_RE) : null;
    if (header) {
      sections.push({ threadId: header[1], revisionId: header[2] || "", lines: [] });
      continue;
    }
    (sections.at(-1)?.lines || chat).push(line);
  }
  return {
    chat: chat.join("\n").trim(),
    sections: sections.map(({ threadId, revisionId, lines: body }) => ({
      threadId,
      revisionId,
      text: body.join("\n").trim(),
    })),
  };
}

/**
 * Parse a reply and check every section against the session's threads before anything is written.
 * Throws a 400 naming the problem, so a typo never drops an answer into the wrong place.
 * @param {any[]} threads
 * @param {string} text
 */
export function planThreadReply(threads, text) {
  const plan = splitThreadReply(text);
  const known = new Map((Array.isArray(threads) ? threads : []).map((thread) => [thread.id, thread]));
  for (const section of plan.sections) {
    if (!known.has(section.threadId)) {
      const ids = [...known.keys()];
      throw badRequest(
        `Unknown comment thread ${section.threadId}. ` +
          (ids.length ? `Threads in this session: ${ids.join(", ")}.` : "This session has no comment threads yet."),
      );
    }
    if (section.revisionId && !REVISION_ID_RE.test(section.revisionId)) {
      throw badRequest(`Invalid reveal revision id for ${section.threadId}`);
    }
    if (!section.text) throw badRequest(`The section for comment thread ${section.threadId} is empty`);
  }
  return {
    chat: plan.chat,
    sections: plan.sections.map((section) => ({ ...section, thread: known.get(section.threadId) })),
  };
}

export function requireThread(threads, id) {
  const normalized = normalizePromptId(id);
  const thread = normalized && (Array.isArray(threads) ? threads : []).find((item) => item.id === normalized);
  if (!thread) throw badRequest("Unknown or invalid comment thread");
  return thread;
}

function nextThreadId(threads) {
  let max = 0;
  for (const thread of threads) {
    const match = /^c(\d+)$/.exec(String(thread?.id || ""));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `c${max + 1}`;
}

/**
 * Record accepted prompts in their threads. An anchored annotation (element, text, table cell,
 * diagram node) opens a new thread; a prompt carrying `thread_id` is a reply in that thread.
 * Composer messages, whiteboards and layout batches stay chat-only.
 * Mutates `prompts` (adds `thread_id`) and the matching chat `entries`.
 */
export function recordThreadPrompts(threads, prompts, entries) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const byPrompt = new Map(entries.map((entry) => [entry.prompt_id, entry]));
  for (const prompt of prompts) {
    const entry = prompt.prompt_id ? byPrompt.get(prompt.prompt_id) : null;
    if (!entry) continue;
    let thread = prompt.thread_id ? byId.get(prompt.thread_id) : null;
    if (!thread && !prompt.thread_id && prompt.selector && !NON_THREAD_TAGS.has(prompt.tag)) {
      thread = {
        id: nextThreadId(threads),
        anchor: {
          selector: prompt.selector,
          text: prompt.text,
          tag: prompt.tag,
          ...(prompt.target ? { target: prompt.target } : {}),
        },
        resolved: false,
        messages: [],
      };
      threads.push(thread);
      byId.set(thread.id, thread);
    }
    if (!thread) continue;
    prompt.thread_id = thread.id;
    entry.thread_id = thread.id;
    // Replying in a resolved thread reopens it, as in a shared document.
    thread.resolved = false;
    thread.messages.push({ ...entry });
  }
}
