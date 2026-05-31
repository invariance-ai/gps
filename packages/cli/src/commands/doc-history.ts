import type { Command } from "commander";
import kleur from "kleur";
import {
  captureDocHistory,
  fetchPr,
  ghAvailable,
  loadDocConfig,
  loadDocHistory,
  resolveDefaultBase,
  type LlmAnnotator,
} from "@invariance/gps-core";
import { GpsLlm, annotateDiff } from "@invariance/gps-llm";
import type { DocSnapshotEvent } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  pr?: string;
  branch?: string;
  base?: string;
  event?: string;
  out?: string;
  llm?: boolean;
  apiKey?: string;
  model?: string;
  maxDiffBytes?: string;
  fullSnapshots?: string;
  json?: boolean;
}

export function registerDocHistory(program: Command): void {
  addRootOption(
    program
      .command("doc-history")
      .description(
        "Capture a time-scrubbable history doc: a snapshot of code + annotations + " +
          "PR comments/labels at each commit, PR regen, and PR merge",
      )
      .option("--pr <number>", "Document a PR's history (pulls comments + labels via gh)")
      .option("--branch <name>", "Tip ref of the commit walk (default: current branch / HEAD)")
      .option("--base <ref>", "Base ref the walk starts from (default: merge-base with origin/HEAD)")
      .option(
        "--event <kind>",
        "Tag the tip snapshot: commit | pr-regen | pr-merge (default: commit)",
      )
      .option("--out <path>", "Output directory (default: doc out_dir, .gps/docs)")
      .option("--no-llm", "Skip LLM gap-fill (only the tip snapshot is ever gap-filled)")
      .option("--api-key <key>", "Anthropic API key (default: ANTHROPIC_API_KEY env)")
      .option("--model <id>", "Anthropic model ID")
      .option("--max-diff-bytes <n>", "Omit per-file bodies when a snapshot diff exceeds this")
      .option("--full-snapshots <k>", "Keep full diff bodies for only the latest K snapshots")
      .option("--json", "Emit the resulting DocHistory as JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    try {
      const event = parseEvent(opts.event);
      const head = opts.branch ?? "HEAD";

      let prNumber: number | undefined;
      let prTitle: string | undefined;
      if (opts.pr) {
        if (!(await ghAvailable())) {
          throw new Error("gh CLI not available. Install GitHub CLI, or omit --pr.");
        }
        prNumber = parsePositiveInt(opts.pr, "--pr");
        const snap = await fetchPr(prNumber!);
        prTitle = snap?.title;
      }

      const base = opts.base ?? (await resolveDefaultBase(root, head));
      if (!base) {
        throw new Error(
          "could not determine a base ref. Pass --base <ref> (e.g. --base origin/main).",
        );
      }

      const cfg = await loadDocConfig(root);
      const llmFill = opts.llm !== false && cfg.llm_fill;
      const haveKey = !!(opts.apiKey ?? process.env.ANTHROPIC_API_KEY);
      const llm = new GpsLlm({ apiKey: opts.apiKey, model: opts.model, dryRun: !llmFill || !haveKey });
      const annotate: LlmAnnotator = async (reqs) => (await annotateDiff(llm, reqs)).annotations;

      const result = await captureDocHistory(root, {
        out_dir: opts.out ?? cfg.out_dir,
        base,
        head,
        pr: prNumber,
        prTitle,
        event,
        annotate,
        llmFill,
        maxDiffBytes: parsePositiveInt(opts.maxDiffBytes, "--max-diff-bytes"),
        fullSnapshots: parsePositiveInt(opts.fullSnapshots, "--full-snapshots"),
      });

      if (opts.json) {
        console.log(JSON.stringify(await loadDocHistory(root, result.id, opts.out ?? cfg.out_dir), null, 2));
        return;
      }

      console.log(kleur.green("doc history written:"));
      console.log(`  html:      ${kleur.bold(result.htmlPath)}`);
      console.log(`  snapshots: ${result.total} (+${result.added} this run)`);
      console.log(`  data:      ${result.historyDir}/`);
      if (!haveKey && llmFill) {
        console.log(
          kleur.dim("  (no ANTHROPIC_API_KEY: tip annotations are from captured notes only)"),
        );
      }
    } catch (err) {
      console.error(kleur.red(`error: ${(err as Error).message}`));
      process.exitCode = 1;
    }
  });
}

function parseEvent(value: string | undefined): DocSnapshotEvent {
  if (value === undefined) return "commit";
  if (value === "commit" || value === "pr-regen" || value === "pr-merge") return value;
  throw new Error("--event must be one of: commit, pr-regen, pr-merge");
}

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
}
