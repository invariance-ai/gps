import type { Command } from "commander";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import kleur from "kleur";
import YAML from "yaml";
import type { Invariant } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";
import { PACKS, STACK_NAMES, type StackName } from "../install/invariant-packs.js";

interface InitOpts extends RootOption {
  stack?: string;
  dryRun?: boolean;
}

/**
 * `gps invariant init --stack <name>` — merge a starter pack of declarative
 * invariants into `.gps/invariants.yml`. Existing entries with the same `name`
 * are preserved (the file is the source of truth once authored).
 */
export function registerInvariant(program: Command): void {
  const invariant = program
    .command("invariant")
    .description("Author invariants — starter packs and (future) interactive flows");

  addRootOption(
    invariant
      .command("init")
      .description("Append a starter pack of invariants to .gps/invariants.yml")
      .option(
        "--stack <name>",
        `Pack to install: ${STACK_NAMES.join(" | ")}`,
      )
      .option("--dry-run", "Print the merged file without writing"),
  ).action(async (opts: InitOpts) => {
    if (!opts.stack) {
      console.error(kleur.red("--stack is required"));
      console.error(kleur.dim(`available: ${STACK_NAMES.join(", ")}`));
      process.exitCode = 1;
      return;
    }
    if (!(STACK_NAMES as readonly string[]).includes(opts.stack)) {
      console.error(kleur.red(`unknown stack: ${opts.stack}`));
      console.error(kleur.dim(`available: ${STACK_NAMES.join(", ")}`));
      process.exitCode = 1;
      return;
    }
    const root = resolveRoot(opts);
    const file = path.join(root, ".gps/invariants.yml");
    const pack = PACKS[opts.stack as StackName];

    let existing: Invariant[] = [];
    try {
      const raw = await readFile(file, "utf8");
      const parsed = YAML.parse(raw);
      if (Array.isArray(parsed)) existing = parsed as Invariant[];
    } catch {
      // file doesn't exist or is empty — start fresh
    }

    const existingNames = new Set(existing.map((i) => i.name));
    const toAdd = pack.filter((inv) => !existingNames.has(inv.name));
    const merged = [...existing, ...toAdd];

    const yaml = YAML.stringify(merged);
    if (opts.dryRun) {
      console.log(yaml);
      console.error(
        kleur.dim(
          `would add ${toAdd.length} invariant(s); ${pack.length - toAdd.length} already present`,
        ),
      );
      return;
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, yaml);
    console.log(
      kleur.green(`wrote   ${path.relative(root, file)}`) +
        kleur.dim(
          `  (+${toAdd.length} from ${opts.stack}, ${existing.length} preserved)`,
        ),
    );
    if (toAdd.length === 0) {
      console.log(
        kleur.dim(
          `pack already installed — edit ${path.relative(root, file)} to tune the rules to your repo`,
        ),
      );
    }
  });
}
