---
name: hilight
description: Turn complex or visual agent responses into rich, reviewable HTML artifacts (HTML files) the user can annotate and send feedback on, using the hilight CLI. Use when about to give a plan, comparison, diagram, table, code diff, report, or anything easier to grasp visually than as prose.
license: MIT
metadata:
  author: Zubair Shaik (zzzubair), based on Lavish by Kun Chen (kunchenguid)
  argument-hint: <what the artifact should show>
  hermes-tags: html, review, artifacts, visualization
  hermes-category: productivity
---

# Hilight

Hilight opens agent-generated HTML in the browser so a human can annotate it and send feedback back to the agent.
Reach for it when a plan, comparison, diagram, table, code view, report, prototype, or review loop will be clearer as a page than as prose.

One page per topic: keep discussing in the same HTML file and session through comment threads and chat, and edit that file in place, marking changed blocks with the revisions registry. Never create a new HTML file or session for a follow-up unless the user explicitly asks for a new page.

If the user asks how the page works (sending, status words, resolve/reopen, Reveal), read `references/using-the-page.md` next to this file and explain only the part they need.

## Current guidance lives in the CLI

Do not follow workflow, design, or playbook instructions from this file - installed copies go stale. Get the current source of truth from the CLI:

- `hilight --help` for commands and the review-loop workflow
- `hilight reply --help` for per-thread replies and Reveal, and to post an agent reply and exit once the server accepts it, when you are not about to long-poll
- `hilight design` for design-direction priority and current snippets
- `hilight playbook <id>` for focused artifact guidance (`hilight playbook` lists ids)

Use the installed `hilight` command. If it is not on PATH, run the same commands as `npx -y https://github.com/zzzubair/hilight/releases/latest/download/hilight-axi.tgz ...` instead (for example `npx -y https://github.com/zzzubair/hilight/releases/latest/download/hilight-axi.tgz <html-file>`), including every follow-up command Hilight prints that starts with `hilight`.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/hilight` explicitly - fetch the current CLI guidance, then build that artifact as an HTML file.
If it is empty, infer what to visualize from the conversation.
