import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { serializeChatSync } from "../src/chat-messages.js";
import { planThreadReply, splitThreadReply } from "../src/comment-threads.js";
import { SessionStore } from "../src/session-store.js";

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-threads-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "page.html");
  await writeFile(file, '<p id="a">Alpha</p><p id="b">Beta</p>');
  const store = new SessionStore(path.join(dir, "state.json"));
  const { key } = await store.upsertSession(file, "http://localhost/test");
  await store.queuePrompts(key, {
    prompts: [
      { prompt_id: "p1", selector: "#a", tag: "p", text: "Alpha", prompt: "Why alpha?" },
      { prompt_id: "p2", selector: "#b", tag: "p", text: "Beta", prompt: "Why beta?" },
      { prompt_id: "p3", tag: "message", text: "", prompt: "General note" },
    ],
  });
  return { store, key, file, dir };
}

test("a reply without thread sections is all chat", () => {
  assert.deepEqual(splitThreadReply("Renamed the step.\n\n## Summary\nDone."), {
    chat: "Renamed the step.\n\n## Summary\nDone.",
    sections: [],
  });
});

test("`## c<n>` lines split a reply into a chat preamble and per-thread answers", () => {
  const reply = [
    "Overall: answered both.",
    "",
    "## c1",
    "Ten teams gives enough variety.",
    "",
    "## c2 reveal=r3",
    "I added an owner column.",
    "```",
    "## c9",
    "```",
    "## c4 model",
    "still part of c2",
  ].join("\n");
  assert.deepEqual(splitThreadReply(reply), {
    chat: "Overall: answered both.",
    sections: [
      { threadId: "c1", revisionId: "", text: "Ten teams gives enough variety." },
      {
        threadId: "c2",
        revisionId: "r3",
        text: "I added an owner column.\n```\n## c9\n```\n## c4 model\nstill part of c2",
      },
    ],
  });
});

test("planning a reply rejects unknown threads and empty sections before anything is written", () => {
  const threads = [{ id: "c1" }, { id: "c2" }];
  assert.throws(() => planThreadReply(threads, "## c7\nLost answer"), /Unknown comment thread c7.*c1, c2/);
  assert.throws(() => planThreadReply([], "## c1\nLost"), /no comment threads yet/);
  assert.throws(() => planThreadReply(threads, "## c1\n\n## c2\nOnly c2 has words"), /c1 is empty/);
  const plan = planThreadReply(threads, "## c2\nYes");
  assert.equal(plan.sections[0].thread, threads[1]);
});

test("anchored notes open short-id threads; composer messages stay in chat", async (t) => {
  const { store, key } = await fixture(t);
  const feedback = await store.takeFeedback(key);
  assert.deepEqual(
    feedback.prompts.map((prompt) => prompt.thread_id),
    ["c1", "c2", undefined],
  );
  assert.equal(feedback.prompts[0].prompt_id, undefined, "settlement ids stay out of poll output");
  const session = await store.findByKey(key);
  assert.deepEqual(
    session.threads.map((thread) => [thread.id, thread.anchor.selector, thread.messages[0].text]),
    [
      ["c1", "#a", "Why alpha?"],
      ["c2", "#b", "Why beta?"],
    ],
  );
});

test("one reply routes each section into its thread and the preamble into chat", async (t) => {
  const { store, key } = await fixture(t);
  await store.takeFeedback(key);
  await store.addAgentReply(key, "Noted the general point.\n\n## c1 reveal=r1\n**Alpha** answer\n\n## c2\nBeta answer");
  const session = await store.findByKey(key);
  assert.deepEqual(
    session.threads.map((thread) => thread.messages.map((message) => [message.role, message.text])),
    [
      [
        ["user", "Why alpha?"],
        ["agent", "**Alpha** answer"],
      ],
      [
        ["user", "Why beta?"],
        ["agent", "Beta answer"],
      ],
    ],
  );
  assert.equal(session.threads[0].messages[1].revision_id, "r1");
  assert.equal(session.threads[1].messages[1].revision_id, undefined);
  const agentChat = session.chat.filter((entry) => entry.role === "agent");
  assert.deepEqual(
    agentChat.map((entry) => entry.text),
    ["Noted the general point."],
  );
  assert.ok(
    session.chat.filter((entry) => entry.role === "user").every((entry) => entry.done_at),
    "a reply still marks every delivered note Done",
  );
  const synced = serializeChatSync(session).threads[0].messages[1];
  assert.match(synced.html, /<strong>Alpha<\/strong>/, "agent thread answers render Markdown");
  assert.equal(serializeChatSync(session).threads[0].messages[0].html, undefined, "user words stay text");
});

test("a sections-only reply adds nothing to chat; a plain reply still goes to chat", async (t) => {
  const { store, key } = await fixture(t);
  await store.addAgentReply(key, "## c1\nOnly the thread");
  let session = await store.findByKey(key);
  assert.equal(session.chat.filter((entry) => entry.role === "agent").length, 0);
  await store.addAgentReply(key, "Plain reply");
  session = await store.findByKey(key);
  assert.equal(session.chat.at(-1).text, "Plain reply");
  assert.equal(session.threads[0].messages.length, 2);
});

test("an unknown thread section rejects the whole reply atomically", async (t) => {
  const { store, key } = await fixture(t);
  const before = await store.findByKey(key);
  await assert.rejects(store.addAgentReply(key, "Chat part\n## c1\nok\n## c9\nlost"), /Unknown comment thread c9/);
  await assert.rejects(store.setThreadResolved(key, "c9", true), /thread/i);
  await assert.rejects(
    store.queuePrompts(key, { prompts: [{ prompt_id: "p9", thread_id: "c9", tag: "message", prompt: "Lost" }] }),
    /thread/i,
  );
  assert.deepEqual(await store.findByKey(key), before);
});

test("replies, resolution and anchors survive retries, restarts and page revisions", async (t) => {
  const { store, key, file, dir } = await fixture(t);
  const reply = { prompt_id: "p4", thread_id: "c1", selector: "#a", tag: "message", prompt: "Go deeper" };
  await store.queuePrompts(key, { prompts: [reply] });
  await store.queuePrompts(key, { prompts: [reply] });
  await store.setThreadResolved(key, "c2", true);
  await writeFile(file, '<p id="a">Alpha revised</p>');
  await store.upsertSession(file, "http://localhost/test");
  const reloaded = new SessionStore(path.join(dir, "state.json"));
  let session = await reloaded.findByKey(key);
  assert.equal(session.threads[1].resolved, true);
  assert.equal(session.threads[0].anchor.selector, "#a");
  assert.deepEqual(
    session.threads[0].messages.map((message) => message.text),
    ["Why alpha?", "Go deeper"],
    "a retried reply is recorded once",
  );
  const delivered = await reloaded.takeFeedback(key);
  assert.equal(delivered.prompts.at(-1).thread_id, "c1");
  await reloaded.queuePrompts(key, { prompts: delivered.prompts }, { restore: true });
  session = await reloaded.findByKey(key);
  assert.equal(session.threads[0].messages.length, 2, "a disconnected-poll restore never re-appends");
  await reloaded.addAgentReply(key, "## c2\nAnswer after resolve");
  session = await reloaded.findByKey(key);
  assert.equal(session.threads[1].resolved, false, "an answer reopens a resolved thread so it is seen");
  await reloaded.setThreadResolved(key, "c2", true);
  await reloaded.queuePrompts(key, {
    prompts: [{ prompt_id: "p5", thread_id: "c2", selector: "#b", tag: "message", prompt: "One more" }],
  });
  assert.equal((await reloaded.findByKey(key)).threads[1].resolved, false, "replying reopens it too");
});
