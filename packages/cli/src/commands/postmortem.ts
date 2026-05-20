import type { Command } from "commander";
import { readFile, appendFile, access } from "node:fs/promises";
import path from "node:path";
import kleur from "kleur";
import { stringify as stringifyYaml } from "yaml";
import { fetchPr, ghAvailable } from "@invariance/gps-core";
import { GpsLlm, proposeInvariant } from "@invariance/gps-llm";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

/**
 * `gps postmortem --pr <n>` — given a PR (or a local diff file + symbols),
 * propose an invariant that would have caught the regression.
 *
 * Default is interactive: print the proposed YAML and ask for confirmation
 * before appending to .gps/invariants.yml. --append-without-confirm for CI;
 * --dry-run to see the prompt without burning API tokens.
 */

interface Opts extends RootOption {
  pr?: string;
  diffFile?: string;
  symbol?: string[];
  prTitle?: string;
  prBody?: string;
  testOutput?: string;
  dryRun?: boolean;
  callApi?: boolean;
  appendWithoutConfirm?: boolean;
  apiKey?: string;
  model?: string;
  json?: boolean;
}

export function registerPostmortem(program: Command): void {
  addRootOption(
    program
      .command("postmortem")
      .description(
        "LLM proposes an invariant from a PR or diff that would have caught the regression",
      )
      .option("--pr <number>", "PR number (uses `gh pr view` + `gh pr diff`)")
      .option("--diff-file <path>", "Local diff file (alternative to --pr)")
      .option(
        "--symbol <name>",
        "Symbol that regressed; repeatable",
        (v, prev: string[] = []) => prev.concat(v),
        [],
      )
      .option("--pr-title <text>", "PR title (when using --diff-file)")
      .option("--pr-body <text>", "PR body (when using --diff-file)")
      .option(
        "--test-output <path>",
        "Path to failing test output (optional, improves rule quality)",
      )
      .option("--dry-run", "Render the prompt for a native agent (default)")
      .option("--call-api", "Call the bundled Anthropic client instead of printing a prompt")
      .option(
        "--append-without-confirm",
        "Skip the interactive confirmation and append directly",
      )
      .option("--api-key <key>", "Anthropic API key (default: ANTHROPIC_API_KEY env)")
      .option("--model <id>", "Anthropic model ID (default: claude-opus-4-7)")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    try {
      // 1. Gather PR data
      let prNumber: string | number = "local";
      let title = opts.prTitle ?? "(no title)";
      let body = opts.prBody ?? "";
      let diff = "";
      let filesTouched: string[] = [];

      if (opts.pr) {
        if (!(await ghAvailable())) {
          throw new Error(
            "gh CLI not available — install GitHub CLI or use --diff-file instead.",
          );
        }
        const snap = await fetchPr(opts.pr);
        if (!snap) throw new Error(`failed to fetch PR #${opts.pr} via gh`);
        prNumber = snap.number;
        title = snap.title;
        body = snap.body;
        diff = snap.diff;
        filesTouched = snap.files;
      } else if (opts.diffFile) {
        diff = await readFile(opts.diffFile, "utf8");
      } else {
        throw new Error("--pr or --diff-file required");
      }

      const symbols = opts.symbol && opts.symbol.length > 0
        ? opts.symbol
        : guessSymbolsFromFiles(filesTouched);
      if (symbols.length === 0) {
        throw new Error(
          "no symbols specified; pass --symbol <name> at least once (or --pr with file paths gh can introspect)",
        );
      }

      let failing: string | undefined;
      if (opts.testOutput) failing = await readFile(opts.testOutput, "utf8");

      // 2. Run LLM
      const llm = new GpsLlm({
        apiKey: opts.apiKey,
        model: opts.model,
        dryRun: !opts.callApi || !!opts.dryRun,
      });
      const result = await proposeInvariant(llm, {
        pr_number: prNumber,
        pr_title: title,
        pr_body: body,
        diff,
        failing_tests: failing,
        symbols_touched: symbols,
      });

      if (!opts.callApi || opts.dryRun) {
        console.log(kleur.bold("Prompt for native Claude/Codex:"));
        console.log("");
        console.log(kleur.dim("--- system ---"));
        console.log(result.dry_run_prompt!.system);
        console.log(kleur.dim("--- user ---"));
        console.log(result.dry_run_prompt!.user);
        console.log("");
        console.log(kleur.dim("Have the native agent return YAML, then paste it into .gps/invariants.yml or record it with gps invariants tooling."));
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      // 3. Show proposal
      console.log(kleur.bold("Proposed invariant:"));
      console.log("");
      console.log("```yaml");
      console.log(stringifyYaml([result.invariant]).trimEnd());
      console.log("```");
      console.log("");

      // 4. Append or prompt
      const invPath = path.join(root, ".gps", "invariants.yml");
      if (opts.appendWithoutConfirm) {
        await appendInvariant(invPath, result.invariant);
        console.log(kleur.green(`appended → ${path.relative(root, invPath)}`));
        return;
      }
      console.log(
        kleur.dim(
          `To append: rerun with --append-without-confirm, or paste the YAML into .gps/invariants.yml manually.`,
        ),
      );
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}

function guessSymbolsFromFiles(files: string[]): string[] {
  // Lightweight fallback: derive a single per-file symbol stem.
  // The LLM does most of the lifting from the diff itself.
  return files
    .map((f) => path.basename(f).replace(/\.(ts|tsx|js|jsx|py)$/, ""))
    .filter((s) => s.length > 0);
}

async function appendInvariant(invPath: string, invariant: unknown): Promise<void> {
  let exists = true;
  try {
    await access(invPath);
  } catch {
    exists = false;
  }
  const yaml = stringifyYaml([invariant]);
  if (!exists) {
    await appendFile(invPath, yaml);
  } else {
    await appendFile(invPath, `\n${yaml}`);
  }
}
