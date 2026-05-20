/**
 * Single source of truth for the agent-facing skill content that `gps install`
 * writes into target repos. Three IDE surfaces consume this:
 *
 *   - Claude Code → `.claude/skills/gps/SKILL.md` + appended block in `CLAUDE.md`
 *   - Codex CLI   → appended block in `AGENTS.md`
 *   - Cursor      → `.cursor/rules/gps.mdc`
 *
 * The shared body lives in SHARED_AGENT_BLOCK so a change to the gps CLI surface
 * only needs to be made once.
 */

const SHARED_AGENT_BLOCK = `\`gps\` is local repo memory: symbol graph, tests, invariants, lessons, decisions, and personal preferences. Hooks auto-fire gps on session start, on prompts, before/after edits, and on failures — you usually don't need to call gps by hand.

## The 30-second loop

For any non-trivial edit, do these three:

1. **\`gps find <keyword>\`** — before writing new code, check if a helper already exists.
2. **\`gps prepare --intent "<what you plan to do>"\`** (or MCP \`prepare_edit\`) — get a decision-ready brief: invariants, callers, tests, prior decisions, notes. \`--intent\` infers the symbol from natural language; you don't need to know the exact name.
3. **\`gps brief\`** (or MCP \`brief\`) — before declaring done. Reports changed symbols, invariants that touch them, notes attached to them, tests likely to run, and warns about changed symbols with no test coverage. Exit code 1 only on blocking invariants.

That loop catches the most expensive failure modes (re-implementing something, breaking an invariant, leaving an untested change) before they leave your machine.

**Before editing a non-trivial symbol, call the MCP tool \`prepare_edit\` first** (it's exposed as \`mcp__gps__prepare_edit\` in Claude Code, or just \`prepare_edit\` in Cursor/Codex). The brief it returns — invariants, callers, tests, prior decisions — is what gps exists for; relying on Glob/Read/Grep alone is what dogfood measured as the +28% output / no quality-win path. Treat \`prepare_edit\` like a code-search call you make *before* exploration, not after.

Useful manual calls:

\`\`\`bash
gps find "<keyword>"                  # locate existing helpers before writing new ones
gps context <symbol> --markdown       # plan a multi-file change
gps decisions <symbol>                # check prior choices before re-litigating
gps preferences                       # see the user's captured standing rules
gps prepare --intent "<plan>"         # decision-ready brief; symbol inferred from intent
gps prepare <symbol> --intent "<…>"   # same, with explicit symbol
gps brief                             # pre-finalize: changed symbols, invariants, notes, tests, no-test warnings
\`\`\`

When the user gives a durable instruction ("from now on…", "always…", "i prefer…", "don't ever…"), the capture-preference hook records it automatically. Treat \`gps preferences\` output as soft constraints in every session.

When you learn something the next agent should know, persist it:
\`\`\`bash
gps lessons record "<one sentence>"          # auto-classified: global → CLAUDE.md; scoped → notes
gps lessons record "<…>" --hint-scope global # bias the classifier when it's wrong
gps lessons reclassify <id> --to <scope>     # move a lesson between tiers
gps learn <symbol> --lesson "<…>"            # legacy: always symbol-scoped
gps decide <symbol> --decision "<choice>" --rejected "<alternative>"
\`\`\`

\`gps lessons record\` returns the chosen scope and signals; if the scope looks wrong (e.g. it picked \`symbol\` for something repo-wide), call \`gps lessons reclassify <id> --to global\` to fix it. Global lessons land in the \`<!-- gps:global-lessons -->\` block of CLAUDE.md and are always loaded; scoped lessons live in \`.gps/notes/{symbol,file,feature,area}/\` and are auto-pulled when the prompt mentions the matching target.

**Tag the session early.** When you understand what the user is working on (e.g. "the homepage", "the auth flow"), call \`gps feature use <short-kebab-label>\` once. Use the exact label if the user names a known feature; otherwise pick a short kebab-case label. gps then learns which symbols belong to that feature and surfaces them automatically on future sessions that mention the same label.

**Location-scoped directives.** When the user gives an instruction tied to a *place* rather than a symbol — "don't do X here", "always Y in this folder", "in the home page, avoid Z" — call the MCP tool \`record_directive\` (or \`gps directive add "<text>"\`). gps resolves "here"/"this" to the active area (a directory) and stores it as an \`area\`-scoped note that resurfaces whenever you grep/read/edit files in that directory. The capture-directive hook also picks these up automatically from prompts, but calling \`record_directive\` yourself is more precise. Pass \`area\` or \`alias\` to target a specific location.

**Aliases tie names to locations.** A human name like "home" can be bound to a directory and a linked feature with \`gps alias set home --file src/pages/home.tsx --feature homepage\` (gps also auto-learns this binding when you edit files after \`gps feature use\`). Once bound, mentioning "home" in a prompt surfaces that directory's directives *and* the linked feature's notes.`;

/** Block appended to CLAUDE.md / AGENTS.md, bracketed by start/end markers. */
export const AGENT_INSTRUCTIONS = `<!-- gps:start -->
## gps

${SHARED_AGENT_BLOCK}
<!-- gps:end -->
`;

/** Standalone Claude Code skill written to `.claude/skills/gps/SKILL.md`. */
export const CLAUDE_SKILL = `---
name: gps
description: Use the gps CLI to fetch repo context, impact, tests, invariants, notes, and decisions before editing code.
---

# gps

Prefer the MCP tool surface in Claude Code: \`mcp__gps__prepare_edit\` returns
a decision-ready brief in one structured call and is cheaper than fanning out
to Glob/Read/Grep first. Fall back to the CLI when you're outside a tool
context (e.g. inside a Bash command):

\`\`\`text
mcp__gps__prepare_edit { "symbol": "<symbol>", "intent": "<short intent>" }
\`\`\`

CLI equivalent:

\`\`\`bash
gps prepare <symbol> --intent "<short intent>"
\`\`\`

Respect invariants marked \`block\`. Run tests listed by the prepare output or by:

\`\`\`bash
gps tests <symbol> --json
\`\`\`

Before declaring an edit done, run the brief — it catches blocking invariants and untested changes:

\`\`\`text
mcp__gps__brief {}
\`\`\`

CLI equivalent:

\`\`\`bash
gps brief
\`\`\`

Before creating a new helper, search for reusable code:

\`\`\`bash
gps find "<keyword>" --json
\`\`\`

When you understand what the user is working on, tag the session once so gps
learns which symbols belong to that feature:

\`\`\`bash
gps feature use <short-kebab-label>
\`\`\`

After a successful edit, persist durable lessons and decisions:

\`\`\`bash
gps lessons record "<one sentence>"          # auto-classified: global → CLAUDE.md; scoped → notes
gps decide <symbol> --decision "<choice>" --rejected "<alternative>"
\`\`\`

\`gps learn <symbol> --lesson "<…>"\` still works but is legacy — always
symbol-scoped. Prefer \`gps lessons record\`.
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

${SHARED_AGENT_BLOCK}

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
gps lessons record "<one sentence>"              # persist what you learned
gps decide <symbol> --decision "<choice>" --rejected "<alternative>"
\`\`\`

The MCP server registered in \`.cursor/mcp.json\` exposes the same surface as a set of tools — use whichever interface (CLI or MCP) fits the moment.
`;
