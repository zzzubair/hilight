# Using a Hilight page (for walking the user through it)

Read this only when the user asks how the page works or seems stuck. Explain the one part they need, not all of it.

- **Comment:** click any heading, paragraph, card, table cell or diagram node, or select some text, then type. Enter saves it as a draft, Shift+Enter adds a line, Esc closes and keeps the text. The "Whole page" thread at the top is for comments about the page as a whole.
- **Send to agent:** drafts are not sent one by one. Leave as many as you like, then press **Send to agent (N)** at the bottom of the comments column once. Drafts survive a reload in the same tab.
- **Status word** in each comment's header: **Not sent** (draft) → **Sent** (server has it) → **Seen** (agent picked it up) → **Working** (agent is changing the page) → **Replied**. **Not delivered · Retry** means the send failed; press Retry.
- **Replies:** the agent answers inside each comment's own thread. Reply in that thread to keep going; one topic stays on one page.
- **Jump to a thread:** click a passage that already has a comment; the page and its thread line up and the cursor goes into the reply box.
- **Reveal change:** when the agent changed the page because of a comment, its reply has a **Reveal change** button that scrolls to and flashes the changed part.
- **Resolve:** hides a finished thread. **Undo** appears for a few seconds. Later, the **N resolved** button in the top bar lists resolved threads; pick one to reopen it.
- **Annotate switch** (top bar, or Ctrl+I / Cmd+I): off means clicks just read the page and follow links; on means clicks start comments.
- **Agent status** in the top bar: **Listening** means the agent will get what you send; **Not listening** means ask the agent to start listening again (re-run `hilight poll`); it says since when and why when Hilight knows (for example, the server restarted). **Activity** in the overflow menu lists what happened, with times: when the agent listened, what reached it, and when it replied.
