/**
 * Single source of truth for the agent-facing skill content that `gps install`
 * writes into target repos. Three IDE surfaces consume this:
 *
 *   - Claude Code → `.claude/skills/gps/SKILL.md` + appended block in `CLAUDE.md`
 *   - Codex CLI   → appended block in `AGENTS.md`
 *   - Cursor      → `.cursor/rules/gps.mdc`
 *
 * The shared body lives in `sharedBlock()` so a change to the gps CLI surface
 * only needs to be made once. Each surface supplies its own opening paragraph
 * because the automatic-capture story differs per IDE: Claude Code has the full
 * lifecycle-hook surface, Codex captures only at turn end, and Cursor has no
 * hooks at all. Stating "hooks auto-fire" everywhere was inaccurate for Codex
 * and self-contradictory for Cursor.
 */

/** Claude Code: full lifecycle-hook surface fires gps automatically. */
const CLAUDE_INTRO = `\`gps\` is local repo memory: symbol graph, tests, invariants, lessons, decisions, and personal preferences. Hooks auto-fire gps on session start, on prompts, before/after edits, and on failures — you usually don't need to call gps by hand.`;

/** Codex: a turn-end hook captures + distills; no pre-edit hook, index refreshes lazily. */
const CODEX_INTRO = `\`gps\` is local repo memory: symbol graph, tests, invariants, lessons, decisions, and personal preferences. A turn-end hook captures preferences/directives and distills the session automatically; there is no pre-edit hook, so the index refreshes when you call \`gps prepare\`. Run the loop below yourself before non-trivial edits.`;

/** Cursor: no lifecycle hooks — the agent must run gps and capture memory explicitly. */
const CURSOR_INTRO = `\`gps\` is local repo memory: symbol graph, tests, invariants, lessons, decisions, and personal preferences. Cursor has no lifecycle hooks — run the loop below yourself before non-trivial edits, and capture preferences/directives via the MCP tools described at the bottom of this rule.`;

/**
 * The IDE-agnostic body. Capture sentences are phrased mechanism-neutrally
 * ("via hook where supported, otherwise call the tool") so they stay true on
 * every surface, including Cursor where nothing fires automatically.
 */
function sharedBlock(intro: string): string {
  return `${intro}

## The 30-second loop

For any non-trivial edit, do these three:

1. **\`gps find <keyword>\`** — before writing new code, check if a helper already exists.
2. **\`gps prepare --intent "<what you plan to do>"\`** (or MCP \`prepare_edit\`) — get a decision-ready brief: invariants, callers, tests, prior decisions, notes. \`--intent\` infers the symbol from natural language; you don't need to know the exact name.
3. **\`gps brief\`** (or MCP \`brief\`) — before declaring done. Reports changed symbols, invariants that touch them, notes attached to them, tests likely to run, and warns about changed symbols with no test coverage. Exit code 1 only on blocking invariants.

That loop catches the most expensive failure modes (re-implementing something, breaking an invariant, leaving an untested change) before they leave your machine.

**Before editing a non-trivial symbol, call the MCP tool \`prepare_edit\` first** (it's exposed as \`mcp__gps__prepare_edit\` in Claude Code, or just \`prepare_edit\` in Cursor/Codex). The brief it returns — invariants, callers, tests, prior decisions — is what gps exists for; relying on Glob/Read/Grep alone is what dogfood measured as the +28% output / no quality-win path. Treat \`prepare_edit\` like a code-search call you make *before* exploration, not after.

The MCP tool and the CLI \`gps prepare\` return the **same** brief — pick one, never both: use the MCP tool when your agent exposes it (Claude Code), and the CLI inside Bash otherwise. The only reason to prefer MCP is fewer round-trips, not different data.

Useful manual calls:

\`\`\`bash
gps find "<keyword>"                  # locate existing helpers before writing new ones
gps context <symbol> --markdown       # plan a multi-file change
gps recall "<topic>" --related        # search repo memory by topic, with nearby symbols
gps memory-graph "<topic>" --json     # inspect connected memory + symbol graph
gps memory-health                     # repo memory score + maintenance actions
gps decisions <symbol>                # check prior choices before re-litigating
gps preferences                       # see the user's captured standing rules
gps prepare --intent "<plan>"         # decision-ready brief; symbol inferred from intent
gps prepare <symbol> --intent "<…>"   # same, with explicit symbol
gps brief                             # pre-finalize: changed symbols, invariants, notes, tests, no-test warnings
gps memory-suggestions                # closeout queue: memory gaps/questions/assumptions/TODOs for changed symbols
gps done                              # final self-audit plus memory nudges for changed symbols/search/failure loops
gps suggest                           # authoring queue: hot symbols, repeated lessons, agent-friction candidates
\`\`\`

When the user gives a durable instruction ("from now on…", "always…", "i prefer…", "don't ever…"), gps records it for you — automatically via hook in agents that support them, otherwise call the MCP tool \`record_preference\` (or \`gps prefer "<rule>"\`). Both passive and explicit captures honor the repo's capture policy: under \`capture=auto\` they land in active memory, under \`capture=inbox\` they're queued for review (\`gps inbox approve <id>\`) — so don't assume an explicit call is immediately live. The response says where it went. Treat \`gps preferences\` output as soft constraints in every session.

When you learn something the next agent should know, persist it:
\`\`\`bash
gps lessons record "<one sentence>"          # auto-classified: global → CLAUDE.md; scoped → notes
gps lessons record "<…>" --hint-scope global # bias the classifier when it's wrong
gps lessons reclassify <id> --to <scope>     # move a lesson between tiers
gps learn <symbol> --lesson "<…>"            # legacy: always symbol-scoped
gps decide <symbol> --decision "<choice>" --rejected "<alternative>"
\`\`\`

Save hard-won findings. If you spent real time locating code, tests, config, owners, fixtures,
or a non-obvious workflow, record the answer before you finish. When \`gps done\`,
\`gps suggest\`, or MCP \`memory_suggestions\` returns a memory candidate, run the shown
command unless the fact is obvious or wrong:

\`\`\`bash
gps remember "Refund approval tests live in apps/api/src/refund-approval.test.ts"
gps remember "The Stripe webhook entrypoint is stripeWebhook in apps/api/src/webhooks.ts" --symbol stripeWebhook
\`\`\`

Do this for findings that would save a future agent another search loop. Do not record obvious facts
from the file you are already editing.

If you know something is still left to do, record a reminder instead of relying on chat history:

\`\`\`bash
gps remember "still need to update the payer denial fixture" --reminder --symbol routeToPayer
gps remember "confirm rollback plan before merge" --reminder --for both --symbol runMigration
\`\`\`

Use reminders for unfinished work, follow-up checks, or anything the next agent/human must not miss.

\`gps lessons record\` returns the chosen scope and signals; if the scope looks wrong (e.g. it picked \`symbol\` for something repo-wide), call \`gps lessons reclassify <id> --to global\` to fix it. Global lessons land in the \`<!-- gps:global-lessons -->\` block of CLAUDE.md and are always loaded; scoped lessons live in \`.gps/notes/{symbol,file,feature,area}/\` and are auto-pulled when the prompt mentions the matching target.

**Tag the session early.** When you understand what the user is working on (e.g. "the homepage", "the auth flow"), call \`gps feature use <short-kebab-label>\` once. Use the exact label if the user names a known feature; otherwise pick a short kebab-case label. gps then learns which symbols belong to that feature and surfaces them automatically on future sessions that mention the same label.

**Location-scoped directives.** When the user gives an instruction tied to a *place* rather than a symbol — "don't do X here", "always Y in this folder", "in the home page, avoid Z" — call the MCP tool \`record_directive\` (or \`gps directive add "<text>"\`). gps resolves "here"/"this" to the active area (a directory) and stores it as an \`area\`-scoped note that resurfaces whenever you grep/read/edit files in that directory. In agents with hooks, the capture-directive hook also picks these up from prompts; either way, calling \`record_directive\` yourself is more precise. Pass \`area\` or \`alias\` to target a specific location.

**Aliases tie names to locations.** A human name like "home" can be bound to a directory and a linked feature with \`gps alias set home --file src/pages/home.tsx --feature homepage\` (gps also auto-learns this binding when you edit files after \`gps feature use\`). Once bound, mentioning "home" in a prompt surfaces that directory's directives *and* the linked feature's notes.`;
}

/**
 * Lean block appended to CLAUDE.md (Claude Code only).
 *
 * CLAUDE.md is loaded into *every* session, so it pays a standing token cost on
 * each turn. Claude Code — unlike Codex/Cursor — also gets a separate on-demand
 * `.claude/skills/gps/SKILL.md` plus lifecycle hooks that capture memory
 * automatically. So the always-loaded block stays minimal: what gps is, the
 * core loop, and a pointer. The full surface (lessons, decisions, reminders,
 * features, directives, aliases) lives in the skill and `gps --help`, pulled in
 * on demand rather than carried on every turn.
 *
 * Codex/Cursor keep the fuller `sharedBlock` because that block *is* their only
 * instruction surface — they have no separate skill file to defer detail to.
 */
function leanClaudeBlock(): string {
  return `${CLAUDE_INTRO}

## The 30-second loop

For any non-trivial edit:

1. **\`gps find <keyword>\`** — before writing new code, check whether a helper already exists.
2. **\`mcp__gps__prepare_edit { symbol, intent }\`** (or \`gps prepare <symbol> --intent "<plan>"\`) — a decision-ready brief: invariants, callers, tests, prior decisions, notes. Treat it like a code-search call you make *before* exploration, not after. \`--intent\` alone infers the symbol; pass the symbol when you know it.
3. **\`mcp__gps__brief\`** (or \`gps brief\`) — before declaring done. Flags blocking invariants and changed symbols with no test coverage; exit code 1 only on a blocking invariant.

Respect invariants marked \`block\`. The MCP tool and \`gps prepare\` return the same brief — use the MCP tool in Claude Code, the CLI elsewhere; never both.

## Memory is mostly automatic

Lifecycle hooks capture preferences, directives, decisions, and failures for you, so you rarely call gps by hand. Treat \`gps preferences\` output as soft constraints. When you learn a hard-won fact the next agent would otherwise re-discover (where a test/config/entrypoint lives, a non-obvious workflow), persist it with \`gps remember "<fact>"\`.

The full surface — lessons, decisions, reminders, features, directives, aliases — lives in the gps skill (\`.claude/skills/gps/SKILL.md\`) and \`gps --help\`. Pull it in when you need it.`;
}

/** Wrap a body in the managed CLAUDE.md / AGENTS.md block markers. */
function wrapAgentBlock(body: string): string {
  return `<!-- gps:start -->
## gps

${body}
<!-- gps:end -->
`;
}

/** Block appended to CLAUDE.md (Claude Code). Lean — see leanClaudeBlock. */
export const CLAUDE_AGENT_INSTRUCTIONS = wrapAgentBlock(leanClaudeBlock());

/** Block appended to AGENTS.md (Codex CLI). */
export const CODEX_AGENT_INSTRUCTIONS = wrapAgentBlock(sharedBlock(CODEX_INTRO));

/** Standalone Claude Code skill written to `.claude/skills/gps/SKILL.md`. */
export const CLAUDE_SKILL = `---
name: gps
description: >
  Use this skill when editing code, starting a task, reviewing a symbol, or recording what was learned.
  gps is automatic repo memory: it surfaces symbol-anchored invariants, callers, tests, prior decisions,
  and lessons from past edits — exactly when the relevant code is touched. Run \`gps prepare <symbol>\`
  before any non-trivial edit and \`gps remember\` for hard-won repo facts. Prefer the MCP tool surface
  (\`mcp__gps__prepare_edit\`) for a one-call decision-ready brief; fall back to CLI inside Bash.
---

# gps — plug-in memory layer

gps gives you durable, automatic, symbol-anchored repo memory: notes, decisions, preferences, and
invariants captured by lifecycle hooks and surfaced only when the relevant code is touched.

## Before any non-trivial edit

Prefer the MCP tool (one structured call, no fan-out to Glob/Read/Grep needed):

\`\`\`text
mcp__gps__prepare_edit { "symbol": "<symbol>", "intent": "<short intent>" }
\`\`\`

CLI equivalent:

\`\`\`bash
gps prepare <symbol> --intent "<short intent>"
\`\`\`

The brief it returns — invariants, callers, tests, prior decisions, notes from past edits — is what
gps exists for. Treat it like a code-search call you make *before* exploration, not after.

Respect invariants marked \`block\`. Run tests listed by the prepare output or by:

\`\`\`bash
gps tests <symbol> --json
\`\`\`

## Before declaring an edit done

Run the brief — it catches blocking invariants and untested changes:

\`\`\`text
mcp__gps__brief {}
\`\`\`

CLI equivalent:

\`\`\`bash
gps brief
\`\`\`

## Before creating a new helper

Search for reusable code first:

\`\`\`bash
gps find "<keyword>" --json
\`\`\`

## When you know the topic but not the symbol

Use topic memory before re-deriving conventions from scratch:

\`\`\`text
mcp__gps__recall_memory { "query": "<topic>", "related": true }
mcp__gps__memory_graph { "query": "<topic>" }
mcp__gps__memory_health {}
mcp__gps__memory_suggestions { "base": "HEAD" }
\`\`\`

CLI equivalents:

\`\`\`bash
gps recall "<topic>" --related
gps memory-graph "<topic>" --json
gps memory-health --json
\`\`\`

## Tag the session early

When you understand what the user is working on, tag once so gps learns which symbols belong to
that feature:

\`\`\`bash
gps feature use <short-kebab-label>
\`\`\`

## Record the goal of the work

When you know what this PR/branch is for, set a durable goal once. It is anchored to the branch
and persists across session resets and context compaction, so a later session (yours or another
agent's) can recover the intent instead of guessing from the diff:

\`\`\`bash
gps goal "<what this PR/branch is trying to accomplish>"   # set/replace the branch goal
gps goal todo "<follow-up you don't want to lose>"           # park an open item on the goal
gps goal done                                                # mark it complete before handoff
\`\`\`

After a reset or at the start of a session on an in-progress branch, run \`gps resume\` — it leads
with the goal, then changed files, open TODOs, questions, and recent decisions.

## After a successful edit — record what you learned

\`\`\`bash
gps remember "<hard-won repo fact>"            # simplest path: save durable context
gps remember "<unfinished follow-up>" --reminder --symbol <symbol>
gps lessons record "<one sentence>"          # auto-classified: global → CLAUDE.md; scoped → notes
gps decide <symbol> --decision "<choice>" --rejected "<alternative>"
\`\`\`

\`gps learn <symbol> --lesson "<…>"\` still works but is legacy — always symbol-scoped. Prefer
\`gps lessons record\`.

If you had to search around to find the right file, test, config, fixture, owner, or entrypoint,
save that finding with \`gps remember\` before you finish. If \`gps done\` prints a
\`memory_suggestions\` entry or agent-friction candidate, run its suggested command unless the
fact is obvious or incorrect. Future agents should not repeat the same search.

## Preferences and lessons

Durable user instructions ("from now on…", "always…", "i prefer…", "don't ever…") are captured
by lifecycle hooks automatically; when you need to capture one explicitly, call the MCP tool
\`record_preference\` (or \`gps prefer "<rule>"\`). Captures honor the repo's policy — under
\`capture=inbox\` they queue for \`gps inbox approve <id>\` rather than going live, and the response
says where it landed. \`gps lessons record\` auto-classifies scope (global → CLAUDE.md's managed
block, scoped → \`.gps/notes/\`); if it picks wrong, \`gps lessons reclassify <id> --to global\`.

## Reminders, directives, and aliases

\`\`\`bash
# Unfinished work the next agent/human must not miss:
gps remember "still need to update the payer denial fixture" --reminder --symbol routeToPayer
\`\`\`

- **Location-scoped directives** — an instruction tied to a *place* rather than a symbol
  ("don't do X here", "always Y in this folder"): call the MCP tool \`record_directive\` (or
  \`gps directive add "<text>"\`). gps resolves "here"/"this" to the active directory and resurfaces
  the rule whenever you grep/read/edit files there.
- **Aliases** — bind a human name to a location/feature once:
  \`gps alias set home --file src/pages/home.tsx --feature homepage\`. Mentioning "home" in a prompt
  then surfaces that directory's directives and the linked feature's notes.
`;

/**
 * Cursor project rule. Cursor reads `.cursor/rules/*.mdc` files at session
 * start; `alwaysApply: true` makes this rule attach to every request without
 * the agent having to discover it.
 */
export const CURSOR_RULE = `---
description: gps — local repo memory (symbol graph, tests, invariants, lessons, decisions). Use the CLI before non-trivial edits.
alwaysApply: true
---

# gps

${sharedBlock(CURSOR_INTRO)}

## When to reach for gps in Cursor

Cursor's agent runtime has shell access. Treat \`gps\` like \`rg\`: a local command you run before edits, not a service to call.

\`\`\`bash
gps find "<keyword>" --json                      # reusable helpers before writing new ones
gps prepare --intent "<plan>"                    # decision-ready brief, symbol inferred
gps brief                                        # pre-finalize check: invariants + notes + tests
gps tests <symbol> --json                        # tests that protect a specific symbol
\`\`\`

After a successful edit:

\`\`\`bash
gps done                                        # self-audit plus memory nudges for changed symbols/search/failure loops
gps memory-suggestions                          # memory-only closeout queue without audit exit code
gps memory-health                               # check review/validation/prune debt in repo memory
gps remember "<hard-won repo fact>"             # save findings future agents should not rediscover
gps lessons record "<one sentence>"              # persist what you learned
gps decide <symbol> --decision "<choice>" --rejected "<alternative>"
\`\`\`

## Capturing preferences and directives explicitly (Cursor-specific)

Cursor has no lifecycle hooks, so preference and directive capture must happen via explicit MCP tool calls.

**When the user gives a durable instruction** ("from now on…", "always…", "i prefer…", "don't ever…"):

Call the MCP tool \`record_preference\` immediately:

\`\`\`text
record_preference { "text": "<the user's instruction verbatim or close paraphrase>" }
\`\`\`

**When the user gives a location-scoped instruction** ("don't do X here", "always Y in this folder", "in the home page, avoid Z"):

Call the MCP tool \`record_directive\` immediately:

\`\`\`text
record_directive { "text": "<instruction>", "area": "<directory or alias>" }
\`\`\`

gps stores preferences in a managed CLAUDE.md / AGENTS.md block (global scope) and directives as area-scoped notes that resurface whenever you edit files in that directory. Because Cursor has no hooks to capture these automatically, calling \`record_preference\` and \`record_directive\` yourself is how the memory layer stays current.

\`record_preference\` honors the repo's capture policy: under \`capture=auto\` it writes active memory immediately, under \`capture=inbox\` it queues the preference for review (the tool response's \`placement\` and \`message\` say which, and queued items need \`gps inbox approve <id>\`).

The MCP server registered in \`.cursor/mcp.json\` exposes the same surface as a set of tools — use whichever interface (CLI or MCP) fits the moment.
`;
