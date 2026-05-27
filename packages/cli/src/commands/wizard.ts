import type { Command } from "commander";
import { access, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import kleur from "kleur";
import {
  addPreference,
  loadConfig,
  scanFiles,
  parseFile,
  buildIndex,
  writeIndex,
  extractTodos,
  appendNote,
  loadNotes,
  suggest,
  writePolicy,
} from "@invariance/gps-core";
import { readFile } from "node:fs/promises";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";
import { runInitCore } from "./init.js";
import { runInstallClaude, runInstallCodex, runInstallCursor, resolveCmd, resolvePolicy } from "./install.js";

interface Opts extends RootOption {
  yes?: boolean;
  withClaude?: boolean;
  withCodex?: boolean;
  withCursor?: boolean;
  capture?: string;
  promote?: string;
  autoSuggest?: boolean;
  skipIndex?: boolean;
  skipTodos?: boolean;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function header(s: string): void {
  console.log("");
  console.log(kleur.bold().cyan(s));
}

function step(label: string, detail?: string): void {
  console.log(`  ${kleur.green("✓")} ${label}${detail ? kleur.dim(` — ${detail}`) : ""}`);
}

function skipped(label: string, reason: string): void {
  console.log(`  ${kleur.dim("·")} ${kleur.dim(label)} ${kleur.dim(`(${reason})`)}`);
}

export function registerWizard(program: Command): void {
  addRootOption(
    program
      .command("setup")
      .alias("wizard")
      .description("Interactive setup: init + agent hooks + first index + preferences seed")
      .option("--yes", "Non-interactive; accept defaults (detect Claude/Codex, do everything)")
      .option("--with-claude", "Install Claude Code hooks")
      .option("--with-codex", "Install Codex MCP + AGENTS.md block")
      .option("--with-cursor", "Install Cursor rules + MCP")
      .option("--capture <mode>", "Capture mode: inbox | auto (default: auto)")
      .option(
        "--promote <mode>",
        "Auto-promotion: never | safe | all (default: safe with --capture=auto; requires --capture=auto)",
      )
      .option("--auto-suggest", "Let supported hooks print `gps suggest` authoring-queue nudges")
      .option("--skip-index", "Skip building the initial symbol graph")
      .option("--skip-todos", "Skip lifting TODOs into notes"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    const policy = resolvePolicy(opts);
    const rl = opts.yes
      ? null
      : readline.createInterface({ input, output });
    const ask = async (q: string, def = true): Promise<boolean> => {
      if (!rl) return def;
      const hint = def ? "[Y/n]" : "[y/N]";
      const ans = (await rl.question(`${q} ${kleur.dim(hint)} `)).trim().toLowerCase();
      if (!ans) return def;
      return ans.startsWith("y");
    };

    try {
      console.log("");
      console.log(kleur.bold("gps setup") + kleur.dim(" — set up codebase context for coding agents"));
      console.log(kleur.dim(`root: ${root}`));

      const claudeDetected = await isDir(path.join(root, ".claude"));
      const codexDetected = (await isDir(path.join(root, ".codex"))) || (await exists(path.join(root, "AGENTS.md")));

      // 1. init
      header("1. initialize .gps/");
      const initResult = await runInitCore(root, { force: false });
      for (const w of initResult.writes) step(w.action, w.relPath);
      await writePolicy(root, policy);
      step("policy", `capture=${policy.capture}, promote=${policy.promote}, auto_suggest=${policy.auto_suggest}`);

      // 2. index
      if (!opts.skipIndex) {
        header("2. build symbol graph");
        const config = await loadConfig(root);
        const files = await scanFiles(root, config);
        const parsed = await Promise.all(files.map((f) => parseFile(f)));
        const index = await buildIndex(root, parsed);
        await writeIndex(root, index);
        step("indexed", `${index.symbols.length} symbols, ${index.edges.length} edges, ${files.length} files`);
      } else {
        skipped("symbol graph", "--skip-index");
      }

      // 3. learn TODOs
      if (!opts.skipTodos) {
        header("3. lift TODO(symbol): comments into notes");
        const config = await loadConfig(root);
        const files = await scanFiles(root, config);
        let lifted = 0;
        for (const f of files) {
          try {
            const src = await readFile(f, "utf8");
            const rel = path.relative(root, f);
            for (const t of extractTodos(src, rel)) {
              const existing = await loadNotes(root, t.symbol);
              if (existing.some((n) => n.lesson === t.lesson && n.source === "todo")) continue;
              await appendNote(root, {
                symbol: t.symbol,
                lesson: t.lesson,
                evidence: t.evidence,
                source: "todo",
              });
              lifted++;
            }
          } catch {
            // unreadable / non-text — skip
          }
        }
        step("lifted", `${lifted} TODO/FIXME → notes`);
      } else {
        skipped("TODO lift", "--skip-todos");
      }

      // 4. agent hooks
      header("4. wire coding agents");
      const wantClaude =
        opts.withClaude ??
        (opts.yes
          ? claudeDetected || !codexDetected
          : await ask(
              claudeDetected
                ? "Claude Code detected. Install hooks?"
                : "Install Claude Code hooks?",
              claudeDetected,
            ));
      const spec = resolveCmd({});
      if (wantClaude) {
        await runInstallClaude(root, {
          force: false,
          skipClaudeMd: false,
          spec,
          autoSuggest: policy.auto_suggest,
        });
        step("Claude Code", "hooks + skill + CLAUDE.md block written to .claude/");
      } else {
        skipped("Claude Code", "declined");
      }

      const wantCodex =
        opts.withCodex ??
        (opts.yes
          ? codexDetected
          : await ask(
              codexDetected
                ? "Codex detected. Install MCP + AGENTS.md?"
                : "Install Codex (MCP + AGENTS.md)?",
              codexDetected,
            ));
      if (wantCodex) {
        await runInstallCodex(root, {
          force: false,
          skipAgentsMd: false,
          spec,
          autoSuggest: policy.auto_suggest,
        });
        step("Codex", "MCP server registered + AGENTS.md block written");
      } else {
        skipped("Codex", "declined");
      }

      const cursorDetected = await isDir(path.join(root, ".cursor"));
      const wantCursor =
        opts.withCursor ??
        (opts.yes
          ? cursorDetected
          : await ask(
              cursorDetected
                ? "Cursor detected. Install rules + MCP?"
                : "Install Cursor rules + MCP?",
              cursorDetected,
            ));
      if (wantCursor) {
        await runInstallCursor(root, {
          force: false,
          skipMcp: false,
          spec,
          autoSuggest: policy.auto_suggest,
        });
        step("Cursor", "always-attached rule + MCP server registered");
      } else {
        skipped("Cursor", "declined");
      }

      // 5. seed a preference so the user can see the loop
      header("5. preferences (auto-captured from your prompts)");
      const seedWanted = opts.yes
        ? true
        : await ask("Seed an example preference (\"keep PRs focused and small\")?", true);
      if (seedWanted) {
        const r = await addPreference(root, {
          text: "Keep PRs focused and small (under ~300 lines when possible).",
          source: "wizard",
          topic: "pr",
        });
        step(r.deduped ? "preference exists" : "seeded preference", r.preference.id);
      } else {
        skipped("seed preference", "declined");
      }

      // 6. show what's next
      header("done");
      const sug = await suggest(root, { min_count: 1, limit: 3 }).catch(() => []);
      if (sug.length > 0) {
        console.log(kleur.dim("Symbols already worth documenting:"));
        for (const s of sug) console.log(`  ${kleur.bold(s.symbol)}  ${kleur.dim(`(${s.count} queries)`)}`);
        console.log("");
      }
      console.log("Next:");
      console.log(`  ${kleur.cyan("gps prefer \"<rule>\"")}        record a personal preference manually`);
      console.log(`  ${kleur.cyan("gps preferences")}             list captured preferences`);
      console.log(`  ${kleur.cyan("gps suggest")}                 see authoring queue (high-traffic symbols)`);
      console.log(`  ${kleur.cyan("gps prepare <symbol>")}        decision-ready brief before editing`);
      console.log("");
      if (wantClaude || wantCodex || wantCursor) {
        console.log(
          kleur.dim(
            "Agents will now get gps instructions, context hooks where supported, and MCP tools.",
          ),
        );
      }
    } finally {
      rl?.close();
    }
  });
}
