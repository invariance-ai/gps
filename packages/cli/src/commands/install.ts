import type { Command } from "commander";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import kleur from "kleur";
import { writePolicy } from "@invariance/gps-core";
import { GpsPolicy } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";
import {
  CLAUDE_AGENT_INSTRUCTIONS,
  CLAUDE_SKILL,
  CODEX_AGENT_INSTRUCTIONS,
  CURSOR_RULE,
} from "../install/skill-content.js";

interface PolicyOpts {
  capture?: string;
  promote?: string;
  autoSuggest?: boolean;
}

interface InstallOpts extends RootOption, PolicyOpts {
  force?: boolean;
  skipClaudeMd?: boolean;
  useGlobal?: boolean;
  useLocal?: boolean;
  dryRun?: boolean;
}

interface CodexInstallOpts extends RootOption, PolicyOpts {
  force?: boolean;
  skipAgentsMd?: boolean;
  useGlobal?: boolean;
  useLocal?: boolean;
  dryRun?: boolean;
}

interface CursorInstallOpts extends RootOption, PolicyOpts {
  force?: boolean;
  skipMcp?: boolean;
  useGlobal?: boolean;
  useLocal?: boolean;
  dryRun?: boolean;
}

/**
 * When true, helpers log what they *would* write instead of touching the disk.
 * Module-level rather than threaded through every helper to keep the install
 * surface minimal — set before each install call and cleared after.
 */
let DRY_RUN = false;

export type CmdMode = "npx" | "global" | "local";

export interface CmdSpec {
  /** Single-string form for embedding in shell hook commands. */
  shell: string;
  /** Argv form for MCP `command`+`args` JSON entries (excludes the subcommand). */
  command: string;
  baseArgs: string[];
  mode: CmdMode;
}

/**
 * Resolve the absolute path of the running CLI's built entrypoint.
 * Returns null if we're not running from a built dist (e.g. `tsx` in dev).
 */
function localBinPath(): string | null {
  try {
    const here = fileURLToPath(import.meta.url);
    // install.ts -> dist/commands/install.js -> entry is dist/index.js
    if (!here.endsWith(".js")) return null;
    const entry = path.resolve(path.dirname(here), "..", "index.js");
    return entry;
  } catch {
    return null;
  }
}

/**
 * Build the `--use-local` command spec for dogfood/dev installs.
 *
 * The entrypoint is emitted *relative to the install root* whenever the built
 * CLI lives under that root (the common dogfood case: a repo wiring up its own
 * checkout's build). A repo-relative path keeps the generated
 * `.claude/settings.json` + `.mcp.json` portable — every clone that builds
 * resolves the same path, with no machine-specific absolute baked into committed
 * config. Hooks and MCP servers run with the project root as cwd, so the
 * relative path resolves correctly at runtime.
 *
 * Only when the bin lives *outside* the root (e.g. a sibling checkout
 * dogfooding another repo) do we fall back to an absolute path — and we warn
 * loudly, because that path is not portable and must not be committed.
 */
function localCmdSpec(root: string): CmdSpec {
  const bin = localBinPath();
  if (!bin) {
    throw new Error(
      "--use-local requires a built CLI. Run `pnpm -r build` first, " +
        "or install the published package and drop --use-local.",
    );
  }
  const rel = path.relative(root, bin);
  const underRoot = !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  if (!underRoot) {
    process.stderr.write(
      kleur.yellow(
        "warning: --use-local resolved a CLI outside this repo, so the generated config would " +
          "contain an absolute, machine-specific path. Do not commit it — prefer the default " +
          "(npx) or --use-global for shared config.\n",
      ),
    );
    return { shell: `node ${JSON.stringify(bin)}`, command: "node", baseArgs: [bin], mode: "local" };
  }
  // Posix separators so the committed path is identical across operating systems.
  const relPosix = rel.split(path.sep).join("/");
  return {
    shell: `node ${JSON.stringify(relPosix)}`,
    command: "node",
    baseArgs: [relPosix],
    mode: "local",
  };
}

/**
 * Resolve the install-time command mode from user flags.
 *
 * The default is the published package via `npx -y @invariance/gps`: portable
 * across machines and the only mode safe to commit — no absolute path, no
 * global-install assumption. `--use-global` emits a bare `gps` (requires a
 * global install); `--use-local` emits the local build by a repo-relative path
 * for dogfooding.
 *
 * NOTE: this previously auto-detected a workspace checkout and silently emitted
 * an absolute `node <abs>/dist/index.js`, which broke the instant the committed
 * `.claude/settings.json` / `.mcp.json` landed on another machine (or moved on
 * the same one). The package is published now, so npx is the safe default and
 * dogfooders opt into the local build explicitly with `--use-local` — which
 * stays portable by emitting a repo-relative path. `root` is needed only to
 * compute that relative path.
 */
export function resolveCmd(
  opts: { useGlobal?: boolean; useLocal?: boolean },
  root: string = process.cwd(),
): CmdSpec {
  if (opts.useGlobal && opts.useLocal) {
    throw new Error("--use-global and --use-local are mutually exclusive");
  }
  if (opts.useLocal) {
    return localCmdSpec(root);
  }
  if (opts.useGlobal) {
    return { shell: "gps", command: "gps", baseArgs: [], mode: "global" };
  }
  return {
    shell: "npx -y @invariance/gps",
    command: "npx",
    baseArgs: ["-y", "@invariance/gps"],
    mode: "npx",
  };
}

const CAPTURE_MODES = ["inbox", "auto"] as const;
const PROMOTE_MODES = ["never", "safe", "all"] as const;

/**
 * Validate the governance flags and resolve them into a policy.
 * Pure + exported so it can be unit-tested without Commander.
 *
 * - capture defaults to "auto" (preserve current always-on behavior).
 * - promote defaults to "safe" with capture=auto (useful by default, still risk-gated).
 * - promote defaults to "never" with capture=inbox unless explicitly set, because
 *   an inbox already means humans review memory before activation.
 * - auto_suggest defaults to false (manual `gps suggest` only).
 * - --promote is only meaningful with --capture=auto: an inbox already gates
 *   activation behind human review, so auto-graduation there is contradictory.
 */
export function resolvePolicy(opts: PolicyOpts): GpsPolicy {
  const capture = opts.capture ?? "auto";
  const promote = opts.promote ?? (capture === "auto" ? "safe" : "never");
  if (!CAPTURE_MODES.includes(capture as (typeof CAPTURE_MODES)[number])) {
    throw new Error(`invalid --capture "${capture}" (expected: ${CAPTURE_MODES.join(" | ")})`);
  }
  if (!PROMOTE_MODES.includes(promote as (typeof PROMOTE_MODES)[number])) {
    throw new Error(`invalid --promote "${promote}" (expected: ${PROMOTE_MODES.join(" | ")})`);
  }
  if (opts.promote !== undefined && capture !== "auto") {
    throw new Error("--promote requires --capture=auto (an inbox already gates activation)");
  }
  return GpsPolicy.parse({ capture, promote, auto_suggest: opts.autoSuggest ?? false });
}

/** Add the shared --capture / --promote options to an install subcommand. */
function addPolicyOptions(cmd: Command): Command {
  return cmd
    .option("--capture <mode>", "Capture mode: inbox | auto (default: auto)")
    .option(
      "--promote <mode>",
      "Auto-promotion: never | safe | all (default: safe with --capture=auto; requires --capture=auto)",
    )
    .option(
      "--auto-suggest",
      "Feature flag: let supported hooks print `gps suggest` authoring-queue nudges",
    );
}

/**
 * Persist the resolved policy to .gps/config.yml. Honors DRY_RUN and prints a
 * loud, unmissable warning when auto-promotion is set to "all" — that bypasses
 * the risk gate and writes invariants with zero human review.
 */
async function persistPolicy(root: string, policy: GpsPolicy): Promise<void> {
  if (policy.promote === "all") {
    console.log("");
    console.log(
      kleur.bgRed().white().bold(" DANGER ") +
        " " +
        kleur.red("--promote=all auto-writes EVERY recurring lesson into invariants.yml"),
    );
    console.log(
      kleur.red(
        "  with no human review — including auth, payments, and security rules. It bypasses",
      ),
    );
    console.log(
      kleur.red("  the risk gate entirely. Use --promote=safe unless you really mean this."),
    );
  }
  if (DRY_RUN) {
    console.log(
      kleur.yellow(`would write policy  `) +
        `.gps/config.yml (capture=${policy.capture}, promote=${policy.promote}, auto_suggest=${policy.auto_suggest})`,
    );
    return;
  }
  await writePolicy(root, policy);
  console.log(
    kleur.green(`wrote   `) +
      `.gps/config.yml (capture=${policy.capture}, promote=${policy.promote}, auto_suggest=${policy.auto_suggest})`,
  );
}

export function registerInstall(program: Command): void {
  const install = program.command("install").description("Install gps agent integrations");

  addRootOption(
    addPolicyOptions(
      install
        .command("claude")
        .description("Install Claude Code CLI-first instructions, skill, and hooks")
        .option("--force", "Overwrite existing gps-managed Claude files")
        .option("--skip-claude-md", "Do not append gps instructions to CLAUDE.md")
        .option("--use-global", "Generate hooks that call `gps` directly (requires global install)")
        .option("--use-local", "Generate hooks that call this CLI by repo-relative path (for dogfood/dev)")
        .option("--dry-run", "Show what would be written without touching disk"),
    ),
  ).action(async (opts: InstallOpts) => {
    const root = resolveRoot(opts);
    DRY_RUN = !!opts.dryRun;
    try {
      const policy = resolvePolicy(opts);
      const spec = resolveCmd(opts, root);
      await runInstallClaude(root, {
        force: !!opts.force,
        skipClaudeMd: !!opts.skipClaudeMd,
        spec,
        autoSuggest: policy.auto_suggest,
      });
      await persistPolicy(root, policy);
      console.log("");
      console.log((DRY_RUN ? kleur.yellow("dry-run") : kleur.green("installed")) + " Claude Code CLI-first gps integration");
      console.log(kleur.dim(`Hooks call: ${spec.shell}`));
      console.log(
        kleur.dim("Hooks fire on session start, prompts, edits, failures, brief on stop, and turn end."),
      );
    } finally {
      DRY_RUN = false;
    }
  });

  addRootOption(
    addPolicyOptions(
      install
        .command("codex")
        .description("Install Codex CLI integration: AGENTS.md, .codex/config.toml notify + MCP")
        .option("--force", "Overwrite existing gps-managed Codex files")
        .option("--skip-agents-md", "Do not append gps instructions to AGENTS.md")
        .option("--use-global", "Configure Codex to call `gps` directly (requires global install)")
        .option("--use-local", "Configure Codex to call this CLI by repo-relative path (for dogfood/dev)")
        .option("--dry-run", "Show what would be written without touching disk"),
    ),
  ).action(async (opts: CodexInstallOpts) => {
    const root = resolveRoot(opts);
    DRY_RUN = !!opts.dryRun;
    try {
      const policy = resolvePolicy(opts);
      const spec = resolveCmd(opts, root);
      await runInstallCodex(root, {
        force: !!opts.force,
        skipAgentsMd: !!opts.skipAgentsMd,
        spec,
        autoSuggest: policy.auto_suggest,
      });
      await persistPolicy(root, policy);
      console.log("");
      console.log((DRY_RUN ? kleur.yellow("dry-run") : kleur.green("installed")) + " Codex CLI gps integration");
      console.log(kleur.dim(`Notify hook + MCP server use: ${spec.shell}`));
      console.log(kleur.dim("Codex CLI has no PreToolUse hook; AGENTS.md teaches it to run `gps prepare` and `gps brief` like `rg`."));
    } finally {
      DRY_RUN = false;
    }
  });

  addRootOption(
    addPolicyOptions(
      install
        .command("cursor")
        .description("Install Cursor integration: .cursor/rules/gps.mdc + .cursor/mcp.json")
        .option("--force", "Overwrite existing gps-managed Cursor files")
        .option("--skip-mcp", "Do not write .cursor/mcp.json (rule file only)")
        .option("--use-global", "Configure MCP to call `gps` directly (requires global install)")
        .option("--use-local", "Configure MCP to call this CLI by repo-relative path (for dogfood/dev)")
        .option("--dry-run", "Show what would be written without touching disk"),
    ),
  ).action(async (opts: CursorInstallOpts) => {
    const root = resolveRoot(opts);
    DRY_RUN = !!opts.dryRun;
    try {
      const policy = resolvePolicy(opts);
      const spec = resolveCmd(opts, root);
      await runInstallCursor(root, {
        force: !!opts.force,
        skipMcp: !!opts.skipMcp,
        spec,
        autoSuggest: policy.auto_suggest,
      });
      await persistPolicy(root, policy);
      console.log("");
      console.log((DRY_RUN ? kleur.yellow("dry-run") : kleur.green("installed")) + " Cursor gps integration");
      console.log(kleur.dim(`MCP server uses: ${spec.shell}`));
      console.log(kleur.dim("Cursor has no shell hooks; .cursor/rules/gps.mdc teaches the agent to run `gps prepare` before edits and `gps brief` after."));
    } finally {
      DRY_RUN = false;
    }
  });
}

export interface RunInstallClaudeOpts {
  force: boolean;
  skipClaudeMd: boolean;
  spec: CmdSpec;
  autoSuggest?: boolean;
}

export async function runInstallClaude(root: string, opts: RunInstallClaudeOpts): Promise<void> {
  const writes: Array<[string, string]> = [
    [path.join(root, ".claude/skills/gps/SKILL.md"), CLAUDE_SKILL],
    [
      path.join(root, ".claude/settings.json"),
      JSON.stringify(claudeSettings(opts.spec.shell), null, 2) + "\n",
    ],
  ];
  for (const [file, content] of writes) {
    await writeManagedFile(root, file, content, opts.force);
  }
  await upsertClaudeMcp(root, opts.spec, !!opts.autoSuggest);
  if (!opts.skipClaudeMd) await upsertAgentMd(root, "CLAUDE.md", CLAUDE_AGENT_INSTRUCTIONS);
}

export interface RunInstallCodexOpts {
  force: boolean;
  skipAgentsMd: boolean;
  spec: CmdSpec;
  autoSuggest?: boolean;
}

export async function runInstallCodex(root: string, opts: RunInstallCodexOpts): Promise<void> {
  if (!opts.skipAgentsMd) await upsertAgentMd(root, "AGENTS.md", CODEX_AGENT_INSTRUCTIONS);
  await upsertCodexConfig(root, opts.spec, !!opts.autoSuggest);
}

export interface RunInstallCursorOpts {
  force: boolean;
  skipMcp: boolean;
  spec: CmdSpec;
  autoSuggest?: boolean;
}

export async function runInstallCursor(root: string, opts: RunInstallCursorOpts): Promise<void> {
  await writeManagedFile(
    root,
    path.join(root, ".cursor/rules/gps.mdc"),
    CURSOR_RULE,
    opts.force,
  );
  if (!opts.skipMcp) await upsertCursorMcp(root, opts.spec, !!opts.autoSuggest);
}

async function writeManagedFile(
  root: string,
  file: string,
  content: string,
  force: boolean,
): Promise<void> {
  if (DRY_RUN) {
    let exists = false;
    try { await access(file); exists = true; } catch { /* missing */ }
    const verb = exists && !force ? "would skip (exists)" : exists ? "would overwrite" : "would write";
    console.log(kleur.yellow(`${verb}  `) + path.relative(root, file) + kleur.dim(`  (${content.length} bytes)`));
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  if (!force) {
    try {
      await access(file);
      console.log(kleur.dim(`exists  ${path.relative(root, file)}  (use --force to overwrite)`));
      return;
    } catch {
      // create below
    }
  }
  await writeFile(file, content);
  console.log(kleur.green(`wrote   ${path.relative(root, file)}`));
}

async function upsertAgentMd(root: string, filename: string, block: string): Promise<void> {
  const file = path.join(root, filename);
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    // create below
  }
  const next = existing.includes("<!-- gps:start -->")
    ? existing.replace(/<!-- gps:start -->[\s\S]*?<!-- gps:end -->\n?/m, block)
    : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}`;
  if (DRY_RUN) {
    const verb = existing.includes("<!-- gps:start -->") ? "would refresh gps block in" : existing ? "would append gps block to" : "would create";
    console.log(kleur.yellow(`${verb}  `) + path.relative(root, file));
    return;
  }
  await writeFile(file, next);
  console.log(kleur.green(`wrote   ${path.relative(root, file)}`));
}

/**
 * Hook surface:
 * - SessionStart      → rebuild the index, clear active feature, print preferences
 * - UserPromptSubmit  → auto-load context for symbols named in the prompt
 * - PreToolUse Edit*  → keep the index fresh (cheap, non-blocking)
 * - PostToolUse Bash  → record failures (records nothing if exit code was 0)
 * - Stop              → distill the session transcript into Decisions
 *
 * All commands swallow errors so a hook never breaks the agent.
 */
function claudeSettings(cmd: string): unknown {
  const silent = ` >/dev/null 2>&1 || true`;
  // PostToolUse hooks see $CLAUDE_TOOL_EXIT_CODE; only record on non-zero.
  // Falls back to recording every Bash post-call if the env var isn't set (safe — silent no-op when no prepared symbol).
  const recordFailure =
    `if [ "\${CLAUDE_TOOL_EXIT_CODE:-0}" != "0" ]; then ` +
    `${cmd} record-failure --kind bash --message "exit \${CLAUDE_TOOL_EXIT_CODE:-?}"${silent}; fi`;
  return {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [
            {
              type: "command",
              command:
                `${cmd} index --root "$PWD"${silent}; ` +
                // Continuously sync TODO(symbol): comments into notes and drop
                // any whose comment was removed — prepare surfaces the live set.
                `${cmd} learn-todos --root "$PWD" --prune --quiet${silent}; ` +
                // Periodic memory GC: removes only stale low-confidence agent
                // memories. Throttled by .gps/maintenance/prune.json.
                `${cmd} prune --root "$PWD" --auto --quiet${silent}; ` +
                `${cmd} feature clear-active --root "$PWD"${silent}; ` +
                `${cmd} session start --root "$PWD"${silent}; ` +
                // Persist standing preferences as a managed CLAUDE.md block so
                // they're always loaded, then also echo them into this session.
                `${cmd} preferences --root "$PWD" --write${silent}; ` +
                `${cmd} preferences --root "$PWD" --markdown 2>/dev/null || true`,
            },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command:
                `${cmd} capture-preference --root "$PWD" --emit 2>/dev/null || true; ` +
                `${cmd} capture-directive --root "$PWD" --emit 2>/dev/null || true; ` +
                `${cmd} context-from-prompt --root "$PWD" 2>/dev/null || true`,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "Edit|MultiEdit|Write",
          hooks: [
            {
              type: "command",
              command: `${cmd} index --root "$PWD"${silent}`,
            },
          ],
        },
        {
          matcher: "Grep|Glob|Read",
          hooks: [
            {
              type: "command",
              command: `${cmd} context-from-path --root "$PWD" 2>/dev/null || true`,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              command: recordFailure,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command:
                // Distill this session's transcript into Decisions/Questions.
                // Reads the Stop-hook JSON on stdin, resolves transcript_path,
                // and auto-persists (degrades to .gps/pending-distill/ with no
                // API key). Self-silencing + always exits 0; keep stderr so the
                // one-line distill summary shows in the transcript.
                `${cmd} attach --hook-stdin --root "$PWD" >/dev/null || true; ` +
                // Gate attribution on a clean index — a stale graph maps touched
                // files to the wrong symbols and silently pollutes weights.
                `if ${cmd} validate --quiet --root "$PWD" >/dev/null 2>&1; then ` +
                `${cmd} feature attribute --git-diff --root "$PWD"${silent}; ` +
                `fi; ` +
                // Non-blocking pre-finalize brief: prints to stderr so it shows in
                // the agent's transcript without altering the user-visible result.
                // Never fails the hook (|| true), regardless of brief exit code.
                `${cmd} brief --root "$PWD" 1>&2 2>/dev/null || true; ` +
                // Feature-flagged authoring queue: only prints when .gps/config.yml
                // has auto_suggest: true.
                `${cmd} suggest --auto --root "$PWD" 1>&2 2>/dev/null || true; ` +
                `${cmd} session end --root "$PWD"${silent}`,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Insert/replace the managed gps block in a TOML config. The block contains a
 * top-level key (`notify`), which in TOML must appear before any `[table]`
 * header — otherwise it is silently parsed as a key of the preceding table and
 * Codex never runs the hook. So we strip any prior block, then insert the new
 * one immediately before the first table header (after any leading top-level
 * keys), appending only when the file has no tables. User content is preserved.
 */
export function placeCodexBlock(existing: string, block: string): string {
  const base = existing
    .replace(/# gps:start[\s\S]*?# gps:end\n?/m, "")
    .replace(/\n{3,}/g, "\n\n");
  if (!base.trim()) return block;
  const lines = base.split("\n");
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
  if (firstTable === -1) {
    return `${base.trimEnd()}\n\n${block}`;
  }
  const before = lines.slice(0, firstTable).join("\n").trimEnd();
  const after = lines.slice(firstTable).join("\n").trim();
  return `${before ? `${before}\n\n` : ""}${block}\n${after}\n`;
}

/**
 * Merge gps entries into .codex/config.toml without parsing TOML. We write a
 * managed block delimited by `# gps:start` / `# gps:end` and rewrite that span
 * on subsequent installs. Anything outside the markers is preserved verbatim.
 */
async function upsertCodexConfig(root: string, spec: CmdSpec, observe: boolean): Promise<void> {
  const file = path.join(root, ".codex/config.toml");
  if (!DRY_RUN) await mkdir(path.dirname(file), { recursive: true });
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    // create below
  }

  const tomlArr = (xs: string[]): string => "[" + xs.map((x) => JSON.stringify(x)).join(", ") + "]";
  const mcpEntry =
    `[mcp_servers.gps]\n` +
    `command = ${JSON.stringify(spec.command)}\n` +
    `args = ${tomlArr([...spec.baseArgs, "serve", ...(observe ? ["--observe"] : [])])}\n`;
  const notifyArgs = tomlArr([spec.command, ...spec.baseArgs, "attach", "--transcript", "-", "--capture-prefs"]);

  const block =
    `# gps:start — managed by \`gps install codex\`. Edit outside markers freely.\n` +
    `notify = ${notifyArgs}\n\n` +
    `${mcpEntry}` +
    `# gps:end\n`;

  const next = placeCodexBlock(existing, block);
  if (DRY_RUN) {
    const verb = existing.includes("# gps:start") ? "would refresh gps block in" : existing ? "would append gps block to" : "would create";
    console.log(kleur.yellow(`${verb}  `) + path.relative(root, file));
    return;
  }
  await writeFile(file, next);
  console.log(kleur.green(`wrote   ${path.relative(root, file)}`));
}

/**
 * Merge a `gps` entry into `.mcp.json` at the repo root. Claude Code reads
 * this file at session start; we own only the `mcpServers.gps` key and leave
 * the rest of the JSON intact so users can mix in other MCP servers.
 *
 * This is what makes the SKILL.md `prepare_edit` advice actually callable —
 * without `.mcp.json`, the MCP tools are not exposed to the Claude agent.
 */
async function upsertClaudeMcp(root: string, spec: CmdSpec, observe: boolean): Promise<void> {
  const file = path.join(root, ".mcp.json");
  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(file, "utf8");
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // create below
  }
  const servers =
    (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
  servers.gps = {
    command: spec.command,
    args: [...spec.baseArgs, "serve", ...(observe ? ["--observe"] : [])],
  };
  const next = { ...existing, mcpServers: servers };
  if (DRY_RUN) {
    console.log(kleur.yellow(`would upsert mcpServers.gps in  `) + path.relative(root, file));
    return;
  }
  await writeFile(file, JSON.stringify(next, null, 2) + "\n");
  console.log(kleur.green(`wrote   ${path.relative(root, file)}`));
}

/**
 * Merge a `gps` entry into `.cursor/mcp.json`. Cursor reads this file at
 * session start; we own only the `mcpServers.gps` key and leave the rest
 * of the JSON intact so users can mix in other MCP servers.
 */
async function upsertCursorMcp(root: string, spec: CmdSpec, observe: boolean): Promise<void> {
  const file = path.join(root, ".cursor/mcp.json");
  if (!DRY_RUN) await mkdir(path.dirname(file), { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(file, "utf8");
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // create below
  }
  const servers =
    (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
  servers.gps = {
    command: spec.command,
    args: [...spec.baseArgs, "serve", ...(observe ? ["--observe"] : [])],
  };
  const next = { ...existing, mcpServers: servers };
  if (DRY_RUN) {
    console.log(kleur.yellow(`would upsert mcpServers.gps in  `) + path.relative(root, file));
    return;
  }
  await writeFile(file, JSON.stringify(next, null, 2) + "\n");
  console.log(kleur.green(`wrote   ${path.relative(root, file)}`));
}
