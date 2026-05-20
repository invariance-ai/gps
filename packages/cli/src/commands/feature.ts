import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Command } from "commander";
import kleur from "kleur";
import {
  attributeFiles,
  clearActive,
  featureDiff,
  gcFeature,
  getActive,
  loadFeatures,
  mergeFeatures,
  normalizeLabel,
  overlapFeatures,
  isolateFeature,
  readLastAttribution,
  renameFeature,
  setActive,
  switchActive,
  topSymbols,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

const execFile = promisify(_execFile);

interface UseOpts extends RootOption {
  json?: boolean;
}

interface ListOpts extends RootOption {
  json?: boolean;
}

interface ShowOpts extends RootOption {
  limit: number;
  json?: boolean;
}

interface AttributeOpts extends RootOption {
  gitDiff?: boolean;
  files?: string[];
  action: string;
  feature?: string;
  json?: boolean;
}

interface RenameOpts extends RootOption {
  json?: boolean;
}

interface MergeOpts extends RootOption {
  json?: boolean;
}

interface ClearActiveOpts extends RootOption {
  json?: boolean;
}

export function registerFeature(program: Command): void {
  const feature = program
    .command("feature")
    .description("Named bags of symbols, learned by observing what the agent touches");

  addRootOption(
    feature
      .command("use <label...>")
      .description("Set the active feature for this session (the agent calls this once when it understands the user's intent)")
      .option("--json", "Emit JSON"),
  ).action(async (label: string[], opts: UseOpts) => {
    const root = resolveRoot(opts);
    const raw = label.join(" ");
    const result = await setActive(root, raw);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const verb = result.created ? "created" : "resumed";
    console.log(`${kleur.green(verb)} feature ${kleur.bold(result.label)}`);
  });

  addRootOption(
    feature
      .command("list")
      .description("List known features")
      .option("--json", "Emit JSON"),
  ).action(async (opts: ListOpts) => {
    const root = resolveRoot(opts);
    const features = await loadFeatures(root);
    const entries = Object.values(features.features).sort((a, b) =>
      a.last_active < b.last_active ? 1 : -1,
    );
    if (opts.json) {
      console.log(JSON.stringify({ features: entries }, null, 2));
      return;
    }
    if (entries.length === 0) {
      console.log(kleur.dim("no features yet — agents tag a session with `gps feature use <label>`"));
      return;
    }
    for (const f of entries) {
      console.log(
        `  ${kleur.bold(f.label)}  ${kleur.dim(`${f.symbols.length} symbols · ${f.sessions} sessions · last ${f.last_active.slice(0, 10)}`)}`,
      );
    }
  });

  addRootOption(
    feature
      .command("show <label>")
      .description("Top symbols for a feature")
      .option("--limit <n>", "Max symbols", (v) => parseInt(v, 10), 10)
      .option("--json", "Emit JSON"),
  ).action(async (label: string, opts: ShowOpts) => {
    const root = resolveRoot(opts);
    const top = await topSymbols(root, label, opts.limit);
    if (opts.json) {
      console.log(JSON.stringify({ label: normalizeLabel(label), symbols: top }, null, 2));
      return;
    }
    if (top.length === 0) {
      console.log(kleur.dim(`no symbols tracked yet for ${normalizeLabel(label)}`));
      return;
    }
    console.log(kleur.bold(normalizeLabel(label)));
    for (const s of top) {
      const w = s.weight.toFixed(2);
      console.log(`  ${kleur.dim(w)}  ${s.id}  ${kleur.dim(`(e${s.edits}/r${s.reads})`)}`);
    }
  });

  addRootOption(
    feature
      .command("attribute")
      .description("Bump symbol weights for touched files under the active feature (called by Stop hook)")
      .option("--git-diff", "Use `git diff --name-only HEAD` to determine touched files")
      .option("--files <files...>", "Explicit file list (overrides --git-diff)")
      .option("--action <a>", "edit | read", "edit")
      .option("--feature <label>", "Target feature (defaults to active)")
      .option("--json", "Emit JSON"),
  ).action(async (opts: AttributeOpts) => {
    const root = resolveRoot(opts);
    const action = opts.action === "read" ? "read" : "edit";

    let files: string[] = opts.files ?? [];
    if (files.length === 0 && opts.gitDiff) {
      files = await touchedFilesFromGit(root);
    }
    if (files.length === 0) {
      if (opts.json) console.log(JSON.stringify({ skipped: true, reason: "no files" }));
      return;
    }

    const result = await attributeFiles(root, files, action, opts.feature);
    if (!result) {
      if (opts.json) console.log(JSON.stringify({ skipped: true, reason: "no active feature" }));
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `${kleur.green("attributed")} ${result.touched_symbols} symbols to ${kleur.bold(result.label)} ${kleur.dim(`(${result.matched_files.length} files matched, ${result.unmatched_files.length} unmatched)`)}`,
    );
  });

  addRootOption(
    feature
      .command("rename <from> <to>")
      .description("Rename a feature (merges into destination if it already exists)")
      .option("--json", "Emit JSON"),
  ).action(async (from: string, to: string, opts: RenameOpts) => {
    const root = resolveRoot(opts);
    const ok = await renameFeature(root, from, to);
    if (opts.json) {
      console.log(JSON.stringify({ ok, from: normalizeLabel(from), to: normalizeLabel(to) }));
      return;
    }
    if (!ok) {
      console.log(kleur.yellow(`could not rename ${from} → ${to} (missing source or invalid)`));
      return;
    }
    console.log(`${kleur.green("renamed")} ${normalizeLabel(from)} → ${kleur.bold(normalizeLabel(to))}`);
  });

  addRootOption(
    feature
      .command("merge <from> <into>")
      .description("Merge one feature into another")
      .option("--json", "Emit JSON"),
  ).action(async (from: string, into: string, opts: MergeOpts) => {
    const root = resolveRoot(opts);
    const ok = await mergeFeatures(root, from, into);
    if (opts.json) {
      console.log(JSON.stringify({ ok, from: normalizeLabel(from), into: normalizeLabel(into) }));
      return;
    }
    if (!ok) {
      console.log(kleur.yellow(`could not merge ${from} → ${into}`));
      return;
    }
    console.log(`${kleur.green("merged")} ${normalizeLabel(from)} → ${kleur.bold(normalizeLabel(into))}`);
  });

  addRootOption(
    feature
      .command("overlap <a> <b>")
      .description("Symbols shared between two features (signals coupling)")
      .option("--threshold <n>", "Minimum min(weight_a, weight_b)", "0.2")
      .option("--json", "Emit JSON"),
  ).action(
    async (
      a: string,
      b: string,
      opts: RootOption & { threshold: string; json?: boolean },
    ) => {
      const root = resolveRoot(opts);
      const threshold = Number(opts.threshold);
      const entries = await overlapFeatures(root, a, b, threshold);
      if (opts.json) {
        console.log(JSON.stringify({ a: normalizeLabel(a), b: normalizeLabel(b), threshold, entries }, null, 2));
        return;
      }
      if (entries.length === 0) {
        console.log(kleur.dim(`no overlap between ${a} and ${b} at threshold ${threshold}`));
        return;
      }
      console.log(
        `${kleur.bold(normalizeLabel(a))} ∩ ${kleur.bold(normalizeLabel(b))} ${kleur.dim(`(threshold ${threshold})`)}`,
      );
      for (const e of entries) {
        console.log(
          `  ${e.id} ${kleur.dim(`a=${e.weight_a.toFixed(2)} b=${e.weight_b.toFixed(2)} min=${e.min.toFixed(2)}`)}`,
        );
      }
    },
  );

  addRootOption(
    feature
      .command("isolate <label>")
      .description("Symbols exclusive to this feature (its true core)")
      .option("--threshold <n>", "Other-feature weight to count as shared", "0.1")
      .option("--json", "Emit JSON"),
  ).action(
    async (label: string, opts: RootOption & { threshold: string; json?: boolean }) => {
      const root = resolveRoot(opts);
      const threshold = Number(opts.threshold);
      const entries = await isolateFeature(root, label, threshold);
      if (opts.json) {
        console.log(JSON.stringify({ label: normalizeLabel(label), threshold, entries }, null, 2));
        return;
      }
      if (entries.length === 0) {
        console.log(kleur.dim(`no exclusive symbols for ${normalizeLabel(label)}`));
        return;
      }
      console.log(
        `${kleur.bold(normalizeLabel(label))} exclusive symbols ${kleur.dim(`(others ≥ ${threshold} excluded)`)}`,
      );
      for (const e of entries) {
        console.log(`  ${e.id} ${kleur.dim(`weight=${e.weight.toFixed(2)}`)}`);
      }
    },
  );

  addRootOption(
    feature
      .command("clear-active")
      .description("Clear the active-feature pointer (called by SessionStart hook)")
      .option("--json", "Emit JSON"),
  ).action(async (opts: ClearActiveOpts) => {
    const root = resolveRoot(opts);
    await clearActive(root);
    if (opts.json) console.log(JSON.stringify({ ok: true }));
  });

  addRootOption(
    feature
      .command("active")
      .description("Print the active feature label, if any")
      .option("--json", "Emit JSON"),
  ).action(async (opts: ClearActiveOpts) => {
    const root = resolveRoot(opts);
    const label = await getActive(root);
    if (opts.json) {
      console.log(JSON.stringify({ active: label ?? null }));
      return;
    }
    if (label) console.log(label);
  });

  addRootOption(
    feature
      .command("switch <label...>")
      .description("Mid-session swap: flush dirty-file attribution to the prev feature, then aim at <label>")
      .option("--json", "Emit JSON"),
  ).action(async (label: string[], opts: UseOpts) => {
    const root = resolveRoot(opts);
    const raw = label.join(" ");
    const dirty = await touchedFilesFromGit(root);
    const result = await switchActive(root, raw, dirty);
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.flushed_attribution) {
      const a = result.flushed_attribution;
      console.log(
        kleur.dim(
          `flushed ${a.touched_symbols} symbols to ${a.label} before switch (${a.matched_files.length} files)`,
        ),
      );
    }
    const verb = result.created ? "created" : "switched to";
    console.log(`${kleur.green(verb)} feature ${kleur.bold(result.label)}`);
  });

  addRootOption(
    feature
      .command("gc [label]")
      .description("Prune low-weight symbols from a feature bag (or all if omitted)")
      .option("--threshold <n>", "Weight below which symbols are pruned", (v) => parseFloat(v), 0.05)
      .option("--dry-run", "Show what would be pruned without writing")
      .option("--json", "Emit JSON"),
  ).action(
    async (
      label: string | undefined,
      opts: RootOption & { threshold: number; dryRun?: boolean; json?: boolean },
    ) => {
      const root = resolveRoot(opts);
      const labels: string[] = label
        ? [label]
        : Object.keys((await loadFeatures(root)).features);
      const results = [];
      for (const l of labels) {
        const r = await gcFeature(root, l, {
          threshold: opts.threshold,
          dryRun: opts.dryRun,
        });
        if (r) results.push(r);
      }
      if (opts.json) {
        console.log(JSON.stringify({ results }, null, 2));
        return;
      }
      if (results.length === 0) {
        console.log(kleur.dim("no features to gc"));
        return;
      }
      for (const r of results) {
        const verb = opts.dryRun ? "would prune" : "pruned";
        console.log(
          `${kleur.bold(r.label)}: ${verb} ${r.pruned.length} below ${r.threshold} ${kleur.dim(`(${r.remaining} remain)`)}`,
        );
        for (const p of r.pruned.slice(0, 10)) {
          console.log(`  ${kleur.dim(p.weight.toFixed(3))}  ${p.id}`);
        }
        if (r.pruned.length > 10) {
          console.log(kleur.dim(`  … ${r.pruned.length - 10} more`));
        }
      }
    },
  );

  const attribution = feature
    .command("attribution")
    .description("Inspect the last attribution write");
  addRootOption(
    attribution
      .command("last", { isDefault: true })
      .description("Print the last attribution result with per-symbol confidence")
      .option("--json", "Emit JSON"),
  ).action(async (opts: RootOption & { json?: boolean }) => {
    const root = resolveRoot(opts);
    const last = await readLastAttribution(root);
    if (opts.json) {
      console.log(JSON.stringify(last ?? null, null, 2));
      return;
    }
    if (!last) {
      console.log(kleur.dim("no attribution recorded yet"));
      return;
    }
    console.log(
      `${kleur.bold(last.label)}: ${last.touched_symbols} symbols attributed ${kleur.dim(`(${last.matched_files.length} files matched)`)}`,
    );
    const sorted = [...last.details].sort((a, b) => b.confidence - a.confidence);
    for (const d of sorted) {
      const c = d.confidence;
      const marker = c >= 0.5 ? kleur.green("✓") : c >= 0.3 ? kleur.yellow("?") : kleur.red("✗");
      console.log(`  ${marker} ${d.id} ${kleur.dim(`(${c.toFixed(2)} confidence, weight ${d.weight.toFixed(2)})`)}`);
    }
  });

  addRootOption(
    feature
      .command("diff <label>")
      .description("Show how a feature's top-N symbols have shifted since a date")
      .requiredOption("--since <iso>", "Baseline date (ISO-8601)")
      .option("--json", "Emit JSON"),
  ).action(async (label: string, opts: RootOption & { since: string; json?: boolean }) => {
    const root = resolveRoot(opts);
    const result = await featureDiff(root, label, opts.since);
    if (opts.json) {
      console.log(JSON.stringify(result ?? null, null, 2));
      return;
    }
    if (!result) {
      console.log(kleur.yellow(`no feature named ${label}`));
      return;
    }
    if (result.entries.length === 0) {
      console.log(kleur.dim(`no drift in ${result.label} since ${opts.since}`));
      return;
    }
    console.log(
      kleur.bold(`drift in ${result.label} since ${opts.since}`) +
        (result.baseline_ts ? kleur.dim(` (baseline ${result.baseline_ts})`) : kleur.dim(" (no baseline — first run)")),
    );
    for (const e of result.entries) {
      if (e.change === "entered") {
        console.log(`  ${kleur.green("+")} ${e.id} ${kleur.dim(`weight ${e.weight_now?.toFixed(2)}`)}`);
      } else if (e.change === "left") {
        console.log(`  ${kleur.red("-")} ${e.id} ${kleur.dim(`was ${e.weight_then?.toFixed(2)}`)}`);
      } else {
        const arrow = (e.weight_now ?? 0) > (e.weight_then ?? 0) ? "↑" : "↓";
        console.log(
          `  ${kleur.yellow(arrow)} ${e.id} ${kleur.dim(`${e.weight_then?.toFixed(2)} → ${e.weight_now?.toFixed(2)}`)}`,
        );
      }
    }
  });
}

async function touchedFilesFromGit(root: string): Promise<string[]> {
  const files = new Set<string>();
  for (const args of [
    ["diff", "--name-only", "HEAD"],
    ["diff", "--name-only", "--cached"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    try {
      const { stdout } = await execFile("git", args, { cwd: root, maxBuffer: 1024 * 1024 });
      for (const line of stdout.split("\n")) {
        const f = line.trim();
        if (f) files.add(f);
      }
    } catch {
      /* not a git repo or git unavailable — skip */
    }
  }
  return Array.from(files);
}

