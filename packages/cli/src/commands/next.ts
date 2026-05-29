import type { Command } from "commander";
import kleur from "kleur";
import {
  loadAllAreaNotes,
  loadAllDecisions,
  loadAllFeatureNotes,
  loadAllFileNotes,
  loadAllNotes,
  loadInbox,
  loadInvariants,
  loadPreferences,
  memoryHealth,
  readIndex,
  testFilesIn,
} from "@invariance/gps-core";
import type { SymbolRef } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  limit: number;
  json?: boolean;
}

interface NextResult {
  symbols: number;
  files: number;
  tests: number;
  memory: {
    notes: number;
    invariants: number;
    decisions: number;
    preferences: number;
    inbox_pending: number;
  };
  try: string[];
  actions: string[];
}

function symbolName(symbol: SymbolRef): string {
  return symbol.qualified_name ?? symbol.name;
}

function scoreSymbols(symbols: SymbolRef[]): SymbolRef[] {
  return [...symbols]
    .filter((s) => !/[.]test[.]/.test(s.file) && !/[.]spec[.]/.test(s.file))
    .sort((a, b) => {
      const aName = symbolName(a);
      const bName = symbolName(b);
      const aExport = a.kind === "function" || a.kind === "class" ? 1 : 0;
      const bExport = b.kind === "function" || b.kind === "class" ? 1 : 0;
      return bExport - aExport || a.file.localeCompare(b.file) || aName.localeCompare(bName);
    });
}

async function buildNext(root: string, limit: number): Promise<NextResult> {
  const [index, notes, fileNotes, featureNotes, areaNotes, invariants, decisions, preferences, inbox, health] =
    await Promise.all([
      readIndex(root),
      loadAllNotes(root),
      loadAllFileNotes(root),
      loadAllFeatureNotes(root),
      loadAllAreaNotes(root),
      loadInvariants(root),
      loadAllDecisions(root),
      loadPreferences(root),
      loadInbox(root),
      memoryHealth(root, { limit: 3, includeDiff: false }).catch(() => undefined),
    ]);
  const noteCount =
    notes.length +
    fileNotes.reduce((sum, entry) => sum + entry.notes.length, 0) +
    featureNotes.reduce((sum, entry) => sum + entry.notes.length, 0) +
    areaNotes.reduce((sum, entry) => sum + entry.notes.length, 0);
  const sample = scoreSymbols(index.symbols).slice(0, Math.max(1, limit));
  const tryCommands = sample.map(
    (symbol) => `gps prepare ${JSON.stringify(symbolName(symbol))} --intent "understand this path"`,
  );
  const actions = [
    ...tryCommands,
    "gps remember \"hard-won repo fact\"",
    "gps done",
    ...(health?.recommendations.slice(0, 2).map((rec) => rec.command) ?? []),
  ];
  return {
    symbols: index.symbols.length,
    files: index.files.length,
    tests: testFilesIn(index).length,
    memory: {
      notes: noteCount,
      invariants: invariants.length,
      decisions: decisions.length,
      preferences: preferences.length,
      inbox_pending: inbox.filter((item) => item.status === "pending").length,
    },
    try: tryCommands,
    actions: [...new Set(actions)].slice(0, Math.max(3, limit + 3)),
  };
}

export function registerNext(program: Command): void {
  addRootOption(
    program
      .command("next")
      .description("Show the fastest useful GPS commands for this repo")
      .option("--limit <n>", "How many sample symbols to suggest", (value) => parseInt(value, 10), 3)
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    try {
      const result = await buildNext(root, opts.limit);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(kleur.bold("gps next"));
      console.log(
        kleur.dim(
          `${result.symbols} symbols, ${result.files} files, ${result.tests} test files; ` +
            `${result.memory.notes} notes, ${result.memory.invariants} invariants, ` +
            `${result.memory.decisions} decisions, ${result.memory.preferences} preferences`,
        ),
      );
      if (result.memory.inbox_pending > 0) {
        console.log(kleur.yellow(`${result.memory.inbox_pending} captured memories are waiting in gps inbox`));
      }
      console.log(kleur.cyan("\nTry this now:"));
      for (const command of result.try) console.log(`  ${command}`);
      console.log(kleur.cyan("\nUseful next actions:"));
      for (const command of result.actions) console.log(`  ${command}`);
    } catch (err) {
      console.error(kleur.red(`error: ${(err as Error).message}`));
      process.exitCode = 1;
    }
  });
}
