// Trigger string Claude Code (and other agents) match against to auto-load the skill.
// Kept terse and outcome-focused so it fires on "about to show something visual" intents.
export const SKILL_DESCRIPTION =
  "Turn complex or visual agent responses into rich, reviewable HTML artifacts (HTML files) the user can " +
  "annotate and send feedback on, using the hilight CLI. Use when about to give a plan, " +
  "comparison, diagram, table, code diff, report, or anything easier to grasp visually than as prose.";

// Hard cap so a future regeneration cannot silently re-inflate the stub with CLI-owned
// instructions. The CLI (`hilight --help`, `design`, `playbook`) is the source of truth.
// Hilight ships as a GitHub release asset, not an npm registry package. This URL always
// resolves to the newest release, so it works for npm install -g and npx alike.
export const HILIGHT_TARBALL_URL = "https://github.com/zzzubair/hilight/releases/latest/download/hilight-axi.tgz";

export const MAX_SKILL_MARKDOWN_CHARS = 1500;

// Agent Skills allows only these top-level frontmatter keys; the reference validator
// (skills-ref) rejects anything else outright, and an Agent Plugins client skips a skill
// it cannot validate. Everything else we want to publish has to live under `metadata`.
export const ALLOWED_SKILL_FRONTMATTER_KEYS = Object.freeze([
  "allowed-tools",
  "compatibility",
  "description",
  "license",
  "metadata",
  "name",
]);

/**
 * Render the installable SKILL.md for the hilight skill.
 *
 * This is a discovery stub, not a copy of CLI guidance. Installed skills go stale;
 * `hilight --help` does not, and it routes to every other command. Keep the body to when to
 * reach for Hilight, that pointer, the npx fallback, and slash-command request handling.
 *
 * The frontmatter is deliberately plain: block-style YAML only (the reference
 * validator rejects `[a, b]` flow collections) and string-valued `metadata`,
 * which is why the Hermes fields are flattened rather than nested.
 *
 * @returns {string} full SKILL.md contents including YAML frontmatter
 */
export function createSkillMarkdown() {
  const markdown = `---
name: hilight
description: ${SKILL_DESCRIPTION}
license: MIT
metadata:
  argument-hint: <what the artifact should show>
  hermes-tags: html, review, artifacts, visualization
  hermes-category: productivity
---

# Hilight

Use Hilight when a plan, comparison, diagram, table, code view, or report is clearer as a page the user can comment on than as prose.

Run \`hilight --help\` first: the CLI is the source of truth, and this file goes stale.
Use the installed \`hilight\` command; if it is not on PATH, run \`npx -y ${HILIGHT_TARBALL_URL} <html-file>\` and the same prefix for every follow-up command Hilight prints that starts with \`hilight\`.

## Request

$ARGUMENTS

If the request above is non-empty, the user invoked \`/hilight\` explicitly: build that artifact as an HTML file. If it is empty, infer what to visualize from the conversation.
`;

  if (markdown.length > MAX_SKILL_MARKDOWN_CHARS) {
    throw new Error(
      `generated SKILL.md is ${markdown.length} chars; keep it a stub under ${MAX_SKILL_MARKDOWN_CHARS} and defer guidance to the CLI`,
    );
  }

  return markdown;
}

/**
 * Parse SKILL.md frontmatter into a normalized model.
 *
 * Deliberately tiny and strict: it accepts only the block-style shapes Agent Skills
 * permits - flat `key: value` entries plus a single level of indented entries under
 * `metadata:` - and reports anything else rather than guessing. That strictness is the
 * point: a shape this parser rejects is a shape the reference validator rejects too.
 *
 * @param {string} markdown full SKILL.md contents
 * @returns {{ frontmatter: Record<string, string | Record<string, string>>, errors: string[] }}
 */
export function parseSkillFrontmatter(markdown) {
  /** @type {Record<string, string | Record<string, string>>} */
  const frontmatter = {};
  const errors = [];

  if (!markdown.startsWith("---\n")) {
    return { frontmatter, errors: ["frontmatter does not open with `---`"] };
  }
  const end = markdown.indexOf("\n---\n", 3);
  if (end < 0) {
    return { frontmatter, errors: ["frontmatter is not closed with `---`"] };
  }

  let parentKey = null;
  for (const line of markdown.slice(4, end + 1).split("\n")) {
    if (line.trim() === "") continue;

    const indented = /^ {2}\S/.test(line);
    if (!indented && /^\s/.test(line)) {
      errors.push(`unsupported indentation: ${line}`);
      continue;
    }

    const separator = line.indexOf(":");
    if (separator < 0) {
      errors.push(`not a \`key: value\` entry: ${line.trim()}`);
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (value.startsWith("[") || value.startsWith("{")) {
      errors.push(`\`${key}\` uses a YAML flow collection, which the reference validator rejects`);
      continue;
    }

    if (indented) {
      if (parentKey === null) {
        errors.push(`\`${key}\` is indented under no parent key`);
        continue;
      }
      if (value === "") {
        errors.push(`\`${parentKey}.${key}\` nests deeper than one level`);
        continue;
      }
      const parent = frontmatter[parentKey];
      if (typeof parent === "object") parent[key] = value;
      continue;
    }

    if (value === "") {
      frontmatter[key] = {};
      parentKey = key;
      continue;
    }
    frontmatter[key] = value;
    parentKey = null;
  }

  return { frontmatter, errors };
}

/**
 * Check a generated SKILL.md against the Agent Skills frontmatter rules that the
 * reference validator enforces. Agent Plugins delegates skill validity wholesale to
 * that spec and silently skips skills that fail it, so this doubles as the plugin's
 * skills-component check.
 *
 * @param {string} markdown full SKILL.md contents
 * @param {{ directoryName?: string }} [options] directory the skill is published under
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateSkillMarkdown(markdown, { directoryName } = {}) {
  const { frontmatter, errors } = parseSkillFrontmatter(markdown);

  for (const key of Object.keys(frontmatter)) {
    if (!ALLOWED_SKILL_FRONTMATTER_KEYS.includes(key)) {
      errors.push(`unexpected frontmatter field \`${key}\`; allowed: ${ALLOWED_SKILL_FRONTMATTER_KEYS.join(", ")}`);
    }
  }

  const name = frontmatter.name;
  if (typeof name !== "string" || name === "") {
    errors.push("`name` is required");
  } else {
    if (name.length > 64) errors.push("`name` exceeds 64 characters");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      errors.push("`name` must be lowercase alphanumeric with single separating hyphens");
    }
    if (directoryName !== undefined && name !== directoryName) {
      errors.push(`directory name \`${directoryName}\` must match skill name \`${name}\``);
    }
  }

  const description = frontmatter.description;
  if (typeof description !== "string" || description === "") {
    errors.push("`description` is required");
  } else if (description.length > 1024) {
    errors.push("`description` exceeds 1024 characters");
  }

  const metadata = frontmatter.metadata;
  if (metadata !== undefined) {
    if (typeof metadata !== "object") {
      errors.push("`metadata` must be a map");
    } else {
      for (const [key, value] of Object.entries(metadata)) {
        if (typeof value !== "string" || value === "") {
          errors.push(`\`metadata.${key}\` must be a non-empty string value`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
