import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore } from "../src/session-store.js";
import { serializeChatSync } from "../src/chat-messages.js";

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-threads-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "page.html");
  await writeFile(file, '<p id="a">Alpha</p><p id="b">Beta</p>');
  const store = new SessionStore(path.join(dir, "state.json"));
  const { key } = await store.upsertSession(file, "http://localhost/test");
  await store.queuePrompts(key, {
    prompts: [
      { prompt_id: "q1", selector: "#a", tag: "p", text: "Alpha", prompt: "Why alpha?" },
      { prompt_id: "q2", selector: "#b", tag: "p", text: "Beta", prompt: "Why beta?" },
    ],
  });
  return { store, key, file, dir };
}

test("poll identifies each annotation thread; targeted replies stay in their own thread", async (t) => {
  const { store, key } = await fixture(t);
  const feedback = await store.takeFeedback(key);
  assert.deepEqual(
    feedback.prompts.map((p) => p.thread_id),
    ["q1", "q2"],
  );
  assert.equal(feedback.prompts[0].prompt_id, undefined);
  await store.addAgentReply(key, "Alpha explanation", { threadId: "q1", revisionId: "r1" });
  const partiallyAnswered = await store.findByKey(key);
  assert.ok(partiallyAnswered.chat[0].done_at);
  assert.equal(partiallyAnswered.chat[1].done_at, undefined, "another thread is not answered yet");
  await store.addAgentReply(key, "Beta explanation", { threadId: "q2" });
  const session = await store.findByKey(key);
  assert.deepEqual(
    session.threads.map((t) => t.messages.map((m) => m.text)),
    [
      ["Why alpha?", "Alpha explanation"],
      ["Why beta?", "Beta explanation"],
    ],
  );
  assert.equal(session.threads[0].messages[1].revision_id, "r1");
  assert.equal(session.chat.filter((m) => m.role === "agent").length, 0);
  assert.ok(session.chat.every((m) => m.done_at || m.role !== "user"));
  await store.addAgentReply(key, "General summary");
  assert.equal((await store.findByKey(key)).chat.at(-1).text, "General summary");
});

test("replies, resolution and anchors survive reopen, restart and revision changes", async (t) => {
  const { store, key, file, dir } = await fixture(t);
  await store.queuePrompts(key, {
    prompts: [{ prompt_id: "q3", thread_id: "q1", tag: "message", prompt: "Go deeper" }],
  });
  await store.queuePrompts(key, {
    prompts: [{ prompt_id: "q3", thread_id: "q1", tag: "message", prompt: "Go deeper" }],
  });
  await store.setThreadResolved(key, "q1", true);
  await writeFile(file, '<p id="a">Alpha revised</p>');
  await store.upsertSession(file, "http://localhost/test");
  const reloaded = new SessionStore(path.join(dir, "state.json"));
  let session = await reloaded.findByKey(key);
  assert.equal(session.threads[0].resolved, true);
  assert.equal(session.threads[0].anchor.selector, "#a");
  assert.deepEqual(
    session.threads[0].messages.map((m) => m.text),
    ["Why alpha?", "Go deeper"],
  );
  await reloaded.setThreadResolved(key, "q1", false);
  session = await reloaded.findByKey(key);
  assert.equal(session.threads[0].resolved, false);
  assert.equal(serializeChatSync(session).threads[0].messages[0].html, undefined);
  await reloaded.addAgentReply(key, "**Answer**", { threadId: "q1" });
  assert.match(
    serializeChatSync(await reloaded.findByKey(key)).threads[0].messages.at(-1).html,
    /<strong>Answer<\/strong>/,
  );
});

test("unknown or malformed reply targets reject atomically instead of falling into chat", async (t) => {
  const { store, key } = await fixture(t);
  const before = await store.findByKey(key);
  for (const threadId of ["missing", "bad id", "__proto__"]) {
    await assert.rejects(store.addAgentReply(key, "Lost answer", { threadId }), /thread/i);
  }
  await assert.rejects(store.addAgentReply(key, "Lost answer", { revisionId: "r1" }), /thread/i);
  await assert.rejects(store.setThreadResolved(key, "missing", true), /thread/i);
  await assert.rejects(
    store.queuePrompts(key, { prompts: [{ prompt_id: "q3", thread_id: "missing", prompt: "Lost question" }] }),
    /thread/i,
  );
  assert.deepEqual(await store.findByKey(key), before);
});
