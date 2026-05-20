import type { Command } from "commander";
import kleur from "kleur";
import {
  loadConfig,
  scanFiles,
  parseFile,
  buildIndex,
  writeIndex,
  reportParserFallbacks,
  loadParseCache,
  saveParseCache,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

export function registerIndex(program: Command): void {
  addRootOption(program
    .command("index")
    .description("Scan repo, build symbol graph, write .gps/index/symbols.json")
    .option("--quiet", "Suppress stdout (for hook usage)"))
    .action(async (opts: RootOption & { quiet?: boolean }) => {
      const root = resolveRoot(opts);
      const t0 = Date.now();
      const config = await loadConfig(root);
      const files = await scanFiles(root, config);
      if (!opts.quiet) process.stdout.write(kleur.dim(`scanning ${files.length} files…`));
      await loadParseCache(root);
      const parsed = await Promise.all(files.map((f) => parseFile(f)));
      const index = await buildIndex(root, parsed);
      await writeIndex(root, index);
      await saveParseCache(root);
      reportParserFallbacks();
      const ms = Date.now() - t0;
      if (opts.quiet) return;
      process.stdout.write("\r" + " ".repeat(40) + "\r");
      console.log(
        kleur.green("indexed") +
          ` ${index.symbols.length} symbols, ${index.edges.length} edges across ${files.length} files in ${ms}ms`,
      );
    });
}
