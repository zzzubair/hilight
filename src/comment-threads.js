import { normalizePromptId } from "./chat-messages.js";

// Threads are durable conversations, independent of the bounded chat transcript. The original
// prompt is the anchor; a reply never replaces it with the reply box's `message` target.
export function requireThread(threads, id) {
  const normalized = normalizePromptId(id);
  const thread = normalized && threads.find((item) => item.id === normalized);
  if (!thread) throw Object.assign(new Error("Unknown or invalid comment thread"), { status: 400 });
  return thread;
}

export function validateReplyTarget(threads, { threadId = "", revisionId = "" } = {}) {
  if (revisionId && !threadId) {
    throw Object.assign(new Error("A revision reply requires a thread"), { status: 400 });
  }
  if (revisionId && (typeof revisionId !== "string" || revisionId.length > 128 || /\s/.test(revisionId))) {
    throw Object.assign(new Error("Invalid thread revision id"), { status: 400 });
  }
  return threadId ? requireThread(threads, threadId) : null;
}

export function recordThreadPrompts(threads, prompts, entries) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const byPrompt = new Map(entries.map((entry) => [entry.prompt_id, entry]));
  for (const prompt of prompts) {
    const entry = byPrompt.get(prompt.prompt_id);
    if (!entry) continue;
    let thread = prompt.thread_id ? byId.get(prompt.thread_id) : null;
    if (
      !thread &&
      prompt.prompt_id &&
      prompt.selector &&
      !["message", "whiteboard", "layout-warnings"].includes(prompt.tag)
    ) {
      thread = {
        id: prompt.prompt_id,
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
    thread.messages.push({ ...entry });
  }
}
