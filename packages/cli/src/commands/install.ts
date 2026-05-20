import type { Command } from "commander";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import kleur from "kleur";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";
import { AGENT_INSTRUCTIONS, CLAUDE_SKILL, CURSOR_RULE } from "../install/skill-content.js";

interface InstallOpts extends RootOption {
  force?: boolean;
  skipClaudeMd?: boolean;
  useGlobal?: boolean;
  useLocal?: boolean;
  dryRun?: boolean;
}

interface CodexInstallOpts extends RootOption {
  force?: boolean;
  skipAgentsMd?: boolean;
  useGlobal?: boolean;
  useLocal?: boolean;
  dryRun?: boolean;
}

interface CursorInstallOpts extends RootOption {
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

/** Resolve the install-time command mode from user flags + workspace auto-detection. */
export function resolveCmd(opts: { useGlobal?: boolean; useLocal?: boolean }): CmdSpec {
  if (opts.useGlobal && opts.useLocal) {
    throw new Error("--use-global and --use-local are mutually exclusive");
  }
  if (opts.useLocal) {
    const bin = localBinPath();
    if (!bin) {
      throw new Error(
        "--use-local requires a built CLI. Run `pnpm -r build` first, " +
          "or install the published package and drop --use-local.",
      );
    }
    return { shell: `node ${JSON.stringify(bin)}`, command: "node", baseArgs: [bin], mode: "local" };
  }
  if (opts.useGlobal) {
    return { shell: "gps", command: "gps", baseArgs: [], mode: "global" };
  }
  // Auto-detect: when running from a workspace checkout (CLI not inside node_modules)
  // and the user didn't pin a mode, prefer local — hooks built for npx silently no-op
  // until `@invariance/gps` is on npm. CI keeps the npx default for predictability.
  const bin = localBinPath();
  if (bin && !process.env.CI && !bin.includes(`${path.sep}node_modules${path.sep}`)) {
    process.stderr.write(
      kleur.yellow(
        "note: auto-detected workspace install → using local mode (override with --use-global or set CI=1 for npx)\n",
      ),
    );
    return { shell: `node ${JSON.stringify(bin)}`, command: "node", baseArgs: [bin], mode: "local" };
  }
  return {
    shell: "npx -y @invariance/gps",
    command: "npx",
    baseArgs: ["-y", "@invariance/gps"],
    mode: "npx",
  };
}

export function registerInstall(program: Command): void {
  const install = program.command("install").description("Install gps agent integrations");

  addRootOption(
    install
      .command("claude")
      .description("Install Claude Code CLI-first instructions, skill, and hooks")
      .option("--force", "Overwrite existing gps-managed Claude files")
      .option("--skip-claude-md", "Do not append gps instructions to CLAUDE.md")
      .option("--use-global", "Generate hooks that call `gps` directly (requires global install)")
      .option("--use-local", "Generate hooks that call this CLI by absolute path (for dogfood/dev)")
      .option("--dry-run", "Show what would be written without touching disk"),
  ).action(async (opts: InstallOpts) => {
    const root = resolveRoot(opts);
    DRY_RUN = !!opts.dryRun;
    try {
      const spec = resolveCmd(opts);
      await runInstallClaude(root, {
        force: !!opts.force,
        skipClaudeMd: !!opts.skipClaudeMd,
        spec,
      });
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
    install
      .command("codex")
      .description("Install Codex CLI integration: AGENTS.md, .codex/config.toml notify + MCP")
      .option("--force", "Overwrite existing gps-managed Codex files")
      .option("--skip-agents-md", "Do not append gps instructions to AGENTS.md")
      .option("--use-global", "Configure Codex to call `gps` directly (requires global install)")
      .option("--use-local", "Configure Codex to call this CLI by absolute path (for dogfood/dev)")
      .option("--dry-run", "Show what would be written without touching disk"),
  ).action(async (opts: CodexInstallOpts) => {
    const root = resolveRoot(opts);
    DRY_RUN = !!opts.dryRun;
    try {
      const spec = resolveCmd(opts);
      await runInstallCodex(root, {
        force: !!opts.force,
        skipAgentsMd: !!opts.skipAgentsMd,
        spec,
      });
      console.log("");
      console.log((DRY_RUN ? kleur.yellow("dry-run") : kleur.green("installed")) + " Codex CLI gps integration");
      console.log(kleur.dim(`Notify hook + MCP server use: ${spec.shell}`));
      console.log(kleur.dim("Codex CLI has no PreToolUse hook; AGENTS.md teaches it to run `gps prepare` and `gps brief` like `rg`."));
    } finally {
      DRY_RUN = false;
    }
  });

  addRootOption(
    install
      .command("cursor")
      .description("Install Cursor integration: .cursor/rules/gps.mdc + .cursor/mcp.json")
      .option("--force", "Overwrite existing gps-managed Cursor files")
      .option("--skip-mcp", "Do not write .cursor/mcp.json (rule file only)")
      .option("--use-global", "Configure MCP to call `gps` directly (requires global install)")
      .option("--use-local", "Configure MCP to call this CLI by absolute path (for dogfood/dev)")
      .option("--dry-run", "Show what would be written without touching disk"),
  ).action(async (opts: CursorInstallOpts) => {
    const root = resolveRoot(opts);
    DRY_RUN = !!opts.dryRun;
    try {
      const spec = resolveCmd(opts);
      await runInstallCursor(root, {
        force: !!opts.force,
        skipMcp: !!opts.skipMcp,
        spec,
      });
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
  await upsertClaudeMcp(root, opts.spec);
  if (!opts.skipClaudeMd) await upsertAgentMd(root, "CLAUDE.md");
}

export interface RunInstallCodexOpts {
  force: boolean;
  skipAgentsMd: boolean;
  spec: CmdSpec;
}

export async function runInstallCodex(root: string, opts: RunInstallCodexOpts): Promise<void> {
  if (!opts.skipAgentsMd) await upsertAgentMd(root, "AGENTS.md");
  await upsertCodexConfig(root, opts.spec);
}

export interface RunInstallCursorOpts {
  force: boolean;
  skipMcp: boolean;
  spec: CmdSpec;
}

export async function runInstallCursor(root: string, opts: RunInstallCursorOpts): Promise<void> {
  await writeManagedFile(
    root,
    path.join(root, ".cursor/rules/gps.mdc"),
    CURSOR_RULE,
    opts.force,
  );
  if (!opts.skipMcp) await upsertCursorMcp(root, opts.spec);
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

async function upsertAgentMd(root: string, filename: string): Promise<void> {
  const file = path.join(root, filename);
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    // create below
  }
  const next = existing.includes("<!-- gps:start -->")
    ? existing.replace(/<!-- gps:start -->[\s\S]*?<!-- gps:end -->\n?/m, AGENT_INSTRUCTIONS)
    : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${AGENT_INSTRUCTIONS}`;
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
                `${cmd} feature clear-active --root "$PWD"${silent}; ` +
                `${cmd} session start --root "$PWD"${silent}; ` +
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
                `${cmd} attach --transcript -${silent}; ` +
                // Gate attribution on a clean index — a stale graph maps touched
                // files to the wrong symbols and silently pollutes weights.
                `if ${cmd} validate --quiet --root "$PWD" >/dev/null 2>&1; then ` +
                `${cmd} feature attribute --git-diff --root "$PWD"${silent}; ` +
                `fi; ` +
                // Non-blocking pre-finalize brief: prints to stderr so it shows in
                // the agent's transcript without altering the user-visible result.
                // Never fails the hook (|| true), regardless of brief exit code.
                `${cmd} brief --root "$PWD" 1>&2 2>/dev/null || true; ` +
                `${cmd} session end --root "$PWD"${silent}`,
            },
          ],
        },
      ],
    },
  };
}

/**
 * Merge gps entries into .codex/config.toml without parsing TOML. We append a
 * managed block delimited by `# gps:start` / `# gps:end` and rewrite that span
 * on subsequent installs. Anything outside the markers is preserved verbatim.
 */
async function upsertCodexConfig(root: string, spec: CmdSpec): Promise<void> {
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
    `args = ${tomlArr([...spec.baseArgs, "serve"])}\n`;
  const notifyArgs = tomlArr([spec.command, ...spec.baseArgs, "attach", "--transcript", "-"]);

  const block =
    `# gps:start — managed by \`gps install codex\`. Edit outside markers freely.\n` +
    `notify = ${notifyArgs}\n\n` +
    `${mcpEntry}` +
    `# gps:end\n`;

  const next = existing.includes("# gps:start")
    ? existing.replace(/# gps:start[\s\S]*?# gps:end\n?/m, block)
    : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}`;
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
async function upsertClaudeMcp(root: string, spec: CmdSpec): Promise<void> {
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
  servers.gps = { command: spec.command, args: [...spec.baseArgs, "serve"] };
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
async function upsertCursorMcp(root: string, spec: CmdSpec): Promise<void> {
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
  servers.gps = { command: spec.command, args: [...spec.baseArgs, "serve"] };
  const next = { ...existing, mcpServers: servers };
  if (DRY_RUN) {
    console.log(kleur.yellow(`would upsert mcpServers.gps in  `) + path.relative(root, file));
    return;
  }
  await writeFile(file, JSON.stringify(next, null, 2) + "\n");
  console.log(kleur.green(`wrote   ${path.relative(root, file)}`));
}
