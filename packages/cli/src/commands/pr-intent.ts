import type { Command } from "commander";
import kleur from "kleur";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { appendDecision, fetchPrThread, flattenPrThread, ghAvailable } from "@invariance/gps-core";
import { GpsLlm, extractDecisions } from "@invariance/gps-llm";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  pr?: string;
  dryRun?: boolean;
  callApi?: boolean;
  saveWithoutConfirm?: boolean;
  apiKey?: string;
  model?: string;
  json?: boolean;
}

export function registerPrIntent(program: Command): void {
  addRootOption(
    program
      .command("pr-intent")
      .description(
        "Extract Decision records from a PR's description, reviews, and comments (the *why* git blame cannot show)",
      )
      .requiredOption("--pr <number>", "PR number to read")
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
      if (!(await ghAvailable())) {
        throw new Error("gh CLI required — install it and authenticate.");
      }
      const thread = await fetchPrThread(opts.pr!);
      if (!thread) throw new Error(`failed to fetch PR #${opts.pr} via gh`);

      const transcript = flattenPrThread(thread);
      const symbolsInScope = thread.files
        .map((f) => path.basename(f).replace(/\.(ts|tsx|js|jsx|py)$/, ""))
        .filter((s) => s.length > 0);

      const llm = new GpsLlm({
        apiKey: opts.apiKey,
        model: opts.model,
        dryRun: !opts.callApi || !!opts.dryRun,
      });
      const result = await extractDecisions(llm, {
        transcript,
        symbols_in_scope: symbolsInScope,
        session_id: `PR-${thread.number}`,
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

      if (result.decisions.length === 0) {
        console.log(kleur.dim(`no decisions extracted from PR #${thread.number}`));
        return;
      }

      console.log(
        kleur.bold(`${result.decisions.length} decision(s) from PR #${thread.number}:`),
      );
      console.log("");
      console.log("```yaml");
      console.log(stringifyYaml(result.decisions).trimEnd());
      console.log("```");
      console.log("");

      if (opts.saveWithoutConfirm) {
        for (const d of result.decisions) {
          await appendDecision(root, d);
        }
        console.log(
          kleur.green(`wrote ${result.decisions.length} decision(s) to .gps/decisions/`),
        );
      } else {
        console.log(
          kleur.dim(
            "Run again with --save-without-confirm to persist to .gps/decisions/, or copy YAML manually.",
          ),
        );
      }
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
