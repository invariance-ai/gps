import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import kleur from "kleur";
import { stringify as stringifyYaml } from "yaml";
import { appendDecision, appendQuestion } from "@invariance/gps-core";
import { GpsLlm, extractDecisions } from "@invariance/gps-llm";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

/**
 * `gps attach --transcript <path>` — distill a conversation transcript into
 * structured Decision records anchored to symbols. The transcript is read
 * once; only the distilled records are persisted. Raw text never lands on
 * disk under .gps/.
 *
 * Native --session <id> integration (Claude Code / Codex session IDs) lands
 * once those formats stabilize; for now use --transcript with a dumped file.
 */

interface Opts extends RootOption {
  transcript?: string;
  session?: string;
  symbol?: string[];
  dryRun?: boolean;
  callApi?: boolean;
  saveWithoutConfirm?: boolean;
  apiKey?: string;
  model?: string;
  json?: boolean;
}

export function registerAttach(program: Command): void {
  addRootOption(
    program
      .command("attach")
      .description(
        "Distill a conversation transcript into Decision records anchored to symbols",
      )
      .option("--transcript <path>", "Path to the conversation transcript file")
      .option(
        "--session <id>",
        "Logical session/PR/conversation ID to tag decisions with",
        "transcript",
      )
      .option(
        "--symbol <name>",
        "Constrain extraction to these symbols; repeatable",
        (v, prev: string[] = []) => prev.concat(v),
        [],
      )
      .option("--dry-run", "Render the prompt for a native agent (default)")
      .option("--call-api", "Call the bundled Anthropic client instead of printing a prompt")
      .option(
        "--save-without-confirm",
        "Write extracted decisions to .gps/decisions/ without interactive prompt",
      )
      .option("--api-key <key>", "Anthropic API key (default: ANTHROPIC_API_KEY env)")
      .option("--model <id>", "Anthropic model ID (default: claude-opus-4-7)")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    try {
      if (!opts.transcript) {
        throw new Error("--transcript <path> required (--session-id integration is v0.5)");
      }
      const transcript = await readFile(opts.transcript, "utf8");
      const llm = new GpsLlm({
        apiKey: opts.apiKey,
        model: opts.model,
        dryRun: !opts.callApi || !!opts.dryRun,
      });
      const result = await extractDecisions(llm, {
        transcript,
        symbols_in_scope: opts.symbol && opts.symbol.length > 0 ? opts.symbol : undefined,
        session_id: opts.session ?? "transcript",
      });

      if (!opts.callApi || opts.dryRun) {
        console.log(kleur.bold("Prompt for native Claude/Codex:"));
        console.log("");
        console.log(kleur.dim("--- system ---"));
        console.log(result.dry_run_prompt!.system);
        console.log(kleur.dim("--- user ---"));
        console.log(result.dry_run_prompt!.user);
        console.log("");
        console.log(kleur.dim("Have the native agent return YAML, then persist decisions with `gps decide`."));
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (result.decisions.length === 0 && result.questions.length === 0) {
        console.log(kleur.dim("no decisions or questions extracted from this transcript"));
        return;
      }

      if (result.decisions.length > 0) {
        console.log(kleur.bold(`${result.decisions.length} decision(s) extracted:`));
        console.log("");
        console.log("```yaml");
        console.log(stringifyYaml(result.decisions).trimEnd());
        console.log("```");
        console.log("");
      }
      if (result.questions.length > 0) {
        console.log(kleur.bold(`${result.questions.length} open question(s) extracted:`));
        console.log("");
        console.log("```yaml");
        console.log(stringifyYaml(result.questions).trimEnd());
        console.log("```");
        console.log("");
      }

      if (opts.saveWithoutConfirm) {
        for (const d of result.decisions) {
          await appendDecision(root, d);
        }
        for (const q of result.questions) {
          await appendQuestion(root, {
            symbol: q.symbol,
            question: q.question,
            asked_by: q.asked_by,
            session: q.session,
          });
        }
        console.log(
          kleur.green(
            `wrote ${result.decisions.length} decision(s) and ${result.questions.length} question(s) to .gps/`,
          ),
        );
      } else {
        console.log(
          kleur.dim(
            "Run again with --save-without-confirm to persist to .gps/, or copy YAML manually.",
          ),
        );
      }
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
