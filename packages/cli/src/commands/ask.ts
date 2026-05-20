import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import kleur from "kleur";
import { appendQuestion } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface AskOpts extends RootOption {
  question: string;
  askedBy?: string;
  json?: boolean;
}

/**
 * Record an unresolved question against a symbol. Used by both humans (mid-thought)
 * and agents (when they hit ambiguity they can't resolve from context alone).
 */
export function registerAsk(program: Command): void {
  addRootOption(
    program
      .command("ask <symbol>")
      .description("Record an open question against a symbol")
      .requiredOption("--question <text>", "The unresolved question")
      .option("--asked-by <who>", "Who asked it (defaults to git user.name if set)")
      .option("--json", "Emit JSON"),
  ).action(async (symbol: string, opts: AskOpts) => {
    const root = resolveRoot(opts);
    const session = await readSessionId(root);
    const result = await appendQuestion(root, {
      symbol,
      question: opts.question,
      asked_by: opts.askedBy,
      session,
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `${kleur.green("recorded")} question on ${kleur.bold(symbol)} ${kleur.dim(`(${result.file})`)}`,
    );
  });
}

async function readSessionId(root: string): Promise<string | undefined> {
  try {
    const id = (await readFile(path.join(root, ".gps/session/id"), "utf8")).trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}
