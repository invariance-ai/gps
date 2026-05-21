import type { Command } from "commander";
import kleur from "kleur";
import {
  loadPreferences,
  upsertManagedBlock,
  removeManagedBlock,
  PREFS_OPEN,
  PREFS_CLOSE,
} from "@invariance/gps-core";
import type { Preference } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  topic?: string;
  limit: number;
  json?: boolean;
  markdown?: boolean;
  write?: boolean;
}

/** Body (markers excluded) for the standing auto-prefs block. */
function prefsBody(prefs: Preference[]): string {
  const lines = [
    "## gps preferences",
    "",
    "_Standing preferences captured for this repo. Treat as soft constraints. Auto-managed by gps — edit via `gps prefer`._",
    "",
  ];
  for (const p of prefs) {
    const tag = p.topic ? ` [${p.topic}]` : "";
    lines.push(`- ${p.text}${tag}`);
  }
  return lines.join("\n");
}

export function registerPreferences(program: Command): void {
  addRootOption(
    program
      .command("preferences")
      .description("List personal preferences captured for this repo")
      .option("--topic <t>", "Filter by topic")
      .option("--limit <n>", "Max to show", (v) => parseInt(v, 10), 50)
      .option("--json", "Emit JSON")
      .option("--markdown", "Emit gps-auto-prefs markdown block (for hooks)")
      .option(
        "--write",
        "Persist the gps:auto-prefs block into CLAUDE.md (idempotent; regenerated each SessionStart)",
      ),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    let prefs = await loadPreferences(root);
    if (opts.topic) prefs = prefs.filter((p) => p.topic === opts.topic);
    prefs = prefs.slice(0, opts.limit);

    if (opts.write) {
      // Regenerate the standing block from the source of truth. Empty → remove
      // the block entirely so a cleared preferences file leaves no stale rules.
      if (prefs.length === 0) {
        await removeManagedBlock(root, PREFS_OPEN, PREFS_CLOSE);
      } else {
        await upsertManagedBlock(root, PREFS_OPEN, PREFS_CLOSE, prefsBody(prefs));
      }
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify({ preferences: prefs }, null, 2));
      return;
    }
    if (prefs.length === 0) {
      if (opts.markdown) return;
      console.log(kleur.dim("no preferences yet — agents auto-capture them, or run `gps prefer \"...\"`"));
      return;
    }
    if (opts.markdown) {
      console.log(`${PREFS_OPEN}\n${prefsBody(prefs)}\n${PREFS_CLOSE}`);
      return;
    }
    for (const p of prefs) {
      const tag = p.topic ? kleur.cyan(` [${p.topic}]`) : "";
      const src = kleur.dim(`(${p.source}${p.hits ? `, ${p.hits} hits` : ""})`);
      console.log(`  ${p.text}${tag} ${src}`);
    }
  });
}
