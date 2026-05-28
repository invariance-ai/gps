import type { Command } from "commander";
import kleur from "kleur";
import {
  fetchPr,
  ghAvailable,
  loadDocConfig,
  buildPrDocModel,
  buildDiffDocModel,
  writeDocStore,
  renderDocMarkdown,
  type LlmAnnotator,
} from "@invariance/gps-core";
import { GpsLlm, annotateDiff } from "@invariance/gps-llm";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

/**
 * `gps doc` — generate a shareable, annotated doc (self-contained HTML + a
 * Markdown sibling) for a PR diff or the local working changes.
 *
 *   gps doc --pr 123     PR diff viewer (notes + LLM-filled annotations)
 *   gps doc --base main  local working-tree diff vs a ref (no gh needed)
 *   gps doc              shorthand for --base HEAD
 *
 * The explicit command runs regardless of the `doc.enabled` toggle (an explicit
 * invocation is intentional); the toggle only gates the attach auto-hook.
 */

interface Opts extends RootOption {
  pr?: string;
  base?: string;
  out?: string;
  diffView?: "unified" | "split";
  llm?: boolean; // commander sets false for --no-llm
  apiKey?: string;
  model?: string;
  json?: boolean;
  printMd?: boolean;
  maxDiffBytes?: string;
}

export function registerDoc(program: Command): void {
  addRootOption(
    program
      .command("doc")
      .description("Generate a shareable HTML + Markdown doc for a PR or local diff")
      .option("--pr <number>", "Document a PR (uses `gh pr view` + `gh pr diff`)")
      .option("--base <ref>", "Document local working changes vs <ref> (default: HEAD)")
      .option("--out <dir>", "Output directory (default: doc.out_dir or .gps/docs)")
      .option("--diff-view <mode>", "Diff layout: unified | split (default: unified)")
      .option("--no-llm", "Skip LLM gap-fill; only overlay captured notes")
      .option("--api-key <key>", "Anthropic API key (default: ANTHROPIC_API_KEY env)")
      .option("--model <id>", "Anthropic model ID (default: claude-opus-4-7)")
      .option("--max-diff-bytes <n>", "Omit per-file bodies when the raw diff exceeds this many bytes")
      .option("--print-md", "Also print the generated Markdown to stdout after writing files")
      .option("--json", "Emit the DocModel as JSON instead of writing files"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    try {
      const cfg = await loadDocConfig(root);
      const llmFill = opts.llm !== false && cfg.llm_fill;

      // Build the annotator. Dry-run (no API call) when LLM fill is off or no
      // key is configured — annotateDiff then returns no annotations and the
      // doc still renders with the notes overlay.
      const haveKey = !!(opts.apiKey ?? process.env.ANTHROPIC_API_KEY);
      const llm = new GpsLlm({
        apiKey: opts.apiKey,
        model: opts.model,
        dryRun: !llmFill || !haveKey,
      });
      const annotate: LlmAnnotator = async (reqs) =>
        (await annotateDiff(llm, reqs)).annotations;

      const buildOpts = {
        annotate,
        llmFill,
        maxDiffBytes: parsePositiveInt(opts.maxDiffBytes, "--max-diff-bytes") ?? cfg.max_diff_bytes,
      };

      let model;
      if (opts.pr) {
        if (!(await ghAvailable())) {
          throw new Error(
            "gh CLI not available — install GitHub CLI, or use `--base <ref>` to document local changes.",
          );
        }
        const snap = await fetchPr(opts.pr);
        if (!snap) throw new Error(`failed to fetch PR #${opts.pr} via gh`);
        model = await buildPrDocModel(root, snap, buildOpts);
      } else {
        const base = opts.base ?? "HEAD";
        model = await buildDiffDocModel(root, base, buildOpts);
        if (model.files.length === 0) {
          console.error(kleur.yellow(`no changes vs ${base} — nothing to document.`));
          return;
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(model, null, 2));
        return;
      }

      const result = await writeDocStore(root, model, { out_dir: opts.out ?? cfg.out_dir });
      console.log(kleur.green(`doc written:`));
      console.log(`  html → ${kleur.bold(result.htmlPath)}`);
      console.log(`  md   → ${result.mdPath}`);
      if (model.stats) {
        console.log(
          `  stats → ${model.stats.files_changed} files, +${model.stats.added_lines}/-${model.stats.deleted_lines}, ` +
            `${model.stats.annotations} annotations, ${model.stats.unannotated_hunks} unannotated hunks`,
        );
      }
      if (!haveKey && llmFill) {
        console.log(
          kleur.dim(
            "  (no ANTHROPIC_API_KEY — annotations are from captured notes only; set a key for LLM gap-fill)",
          ),
        );
      }
      if (opts.printMd) {
        console.log("");
        console.log(renderDocMarkdown(model));
      }
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
}
