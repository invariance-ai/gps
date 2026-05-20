import type { Command } from "commander";
import kleur from "kleur";
import {
  recordDirective,
  listLessons,
  loadAliases,
  resolveActiveArea,
  upsertAlias,
  normalizeAlias,
} from "@invariance/gps-core";
import type { NoteSeverity } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface AddOpts extends RootOption {
  area?: string;
  alias?: string;
  do?: boolean;
  dont?: boolean;
  severity?: string;
  evidence?: string;
  json?: boolean;
}

interface ListOpts extends RootOption {
  area?: string;
  alias?: string;
  json?: boolean;
}

interface AliasSetOpts extends RootOption {
  file?: string;
  dir?: string;
  feature?: string;
  json?: boolean;
}

interface AliasListOpts extends RootOption {
  json?: boolean;
}

export function registerDirective(program: Command): void {
  const cmd = program
    .command("directive")
    .description("Manage location-scoped directives (area notes) and their aliases");

  addRootOption(
    cmd
      .command("add <text>")
      .description("Record a location-scoped directive (defaults to the active area)")
      .option("--area <dir>", "Directory path the directive applies to")
      .option("--alias <name>", "Bind a human-friendly name to the area (e.g. home)")
      .option("--do", "Force polarity to 'do'")
      .option("--dont", "Force polarity to 'dont'")
      .option("--severity <level>", "low | medium | high", "medium")
      .option("--evidence <ref>", "PR/commit/doc backing this directive")
      .option("--json", "Emit JSON"),
  ).action(async (text: string, opts: AddOpts) => {
    const root = resolveRoot(opts);
    try {
      const polarity = opts.dont ? "dont" : opts.do ? "do" : undefined;
      const result = await recordDirective(root, {
        directive: text,
        polarity,
        // Prefer an explicit --area; fall back to --alias (an existing alias
        // resolves to its dir, otherwise recordDirective uses the active area).
        area: opts.area ?? opts.alias,
        alias: opts.alias,
        evidence: opts.evidence,
        severity: (opts.severity as NoteSeverity) ?? "medium",
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        `${kleur.green("recorded")} [${kleur.cyan("area")}:${kleur.bold(result.area)}] ${kleur.dim(`(${result.polarity}, id ${result.id})`)}`,
      );
      console.log(`   ${kleur.dim(result.path)}`);
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });

  addRootOption(
    cmd
      .command("list")
      .description("List directives for an area (defaults to the active area)")
      .option("--area <dir>", "Directory path")
      .option("--alias <name>", "Alias name")
      .option("--json", "Emit JSON"),
  ).action(async (opts: ListOpts) => {
    const root = resolveRoot(opts);
    const area = await resolveActiveArea(root, opts.alias ?? opts.area);
    if (!area) {
      console.error(
        kleur.red("could not resolve an area — pass --area or --alias, or run `gps feature use <label>`"),
      );
      process.exitCode = 1;
      return;
    }
    const lessons = await listLessons(root, { scope: "area", target: area });
    if (opts.json) {
      console.log(JSON.stringify({ area, lessons }, null, 2));
      return;
    }
    if (lessons.length === 0) {
      console.log(kleur.dim(`no directives for ${area}`));
      return;
    }
    console.log(kleur.bold(`area: ${area}`));
    for (const l of lessons) {
      console.log(`  ${kleur.dim(l.id)} [${l.severity}] ${l.lesson}`);
    }
  });

  /* ---------- alias subtree ---------- */

  const alias = program
    .command("alias")
    .description("Manage location aliases (human names → directories)");

  addRootOption(
    alias
      .command("set <name>")
      .description("Pin an alias to a location (file/dir) and optional feature")
      .option("--file <path>", "File the alias points at")
      .option("--dir <path>", "Directory the alias anchors to")
      .option("--feature <label>", "Feature linked to this location")
      .option("--json", "Emit JSON"),
  ).action(async (name: string, opts: AliasSetOpts) => {
    const root = resolveRoot(opts);
    try {
      const bound = await upsertAlias(root, name, {
        file: opts.file,
        dir: opts.dir,
        feature: opts.feature,
        source: "user",
      });
      if (opts.json) {
        console.log(JSON.stringify(bound, null, 2));
        return;
      }
      console.log(
        `${kleur.green("set")} ${kleur.bold(bound.name)} → ${kleur.cyan(bound.dir ?? "(no dir)")}${bound.file ? kleur.dim(` (${bound.file})`) : ""}${bound.feature ? kleur.dim(` [feature: ${bound.feature}]`) : ""}`,
      );
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });

  addRootOption(
    alias
      .command("list")
      .description("List all location aliases")
      .option("--json", "Emit JSON"),
  ).action(async (opts: AliasListOpts) => {
    const root = resolveRoot(opts);
    const aliases = await loadAliases(root);
    const entries = Object.values(aliases);
    if (opts.json) {
      console.log(JSON.stringify({ aliases: entries }, null, 2));
      return;
    }
    if (entries.length === 0) {
      console.log(kleur.dim("no aliases registered"));
      return;
    }
    for (const a of entries) {
      console.log(
        `${kleur.bold(a.name)} → ${kleur.cyan(a.dir ?? "(unbound)")}${a.file ? kleur.dim(` (${a.file})`) : ""}${a.feature ? kleur.dim(` [feature: ${a.feature}]`) : ""} ${kleur.dim(`(${a.source})`)}`,
      );
    }
  });

  addRootOption(
    alias
      .command("show <name>")
      .description("Show a single alias binding")
      .option("--json", "Emit JSON"),
  ).action(async (name: string, opts: AliasListOpts) => {
    const root = resolveRoot(opts);
    const aliases = await loadAliases(root);
    const binding = aliases[normalizeAlias(name)];
    if (!binding) {
      console.error(kleur.red(`no alias: ${name}`));
      process.exitCode = 1;
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify(binding, null, 2));
      return;
    }
    console.log(kleur.bold(binding.name));
    console.log(`  dir:     ${binding.dir ?? kleur.dim("(unbound)")}`);
    console.log(`  file:    ${binding.file ?? kleur.dim("(unbound)")}`);
    console.log(`  feature: ${binding.feature ?? kleur.dim("(none)")}`);
    console.log(`  source:  ${binding.source}`);
  });
}
