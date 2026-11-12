---
name: hilight
description: Turn complex or visual agent responses into rich, reviewable HTML artifacts (HTML files) the user can annotate and send feedback on, using the hilight CLI. Use when about to give a plan, comparison, diagram, table, code diff, report, or anything easier to grasp visually than as prose.
license: MIT
metadata:
  argument-hint: <what the artifact should show>
  hermes-tags: html, review, artifacts, visualization
  hermes-category: productivity
---

# Hilight

Use Hilight when a plan, comparison, diagram, table, code view, or report is clearer as a page the user can comment on than as prose.

Run `hilight --help` first: the CLI is the source of truth, and this file goes stale.
Use the installed `hilight` command; if it is not on PATH, run `npx -y https://github.com/zzzubair/hilight/releases/latest/download/hilight-axi.tgz <html-file>` and the same prefix for every follow-up command Hilight prints that starts with `hilight`.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked `/hilight` explicitly: build that artifact as an HTML file. If it is empty, infer what to visualize from the conversation.
