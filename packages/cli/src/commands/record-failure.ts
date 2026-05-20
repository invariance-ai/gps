import type { Command } from "commander";
import kleur from "kleur";
import { recordFailure } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  symbol?: string;
  kind: string;
  message?: string;
  json?: boolean;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function registerRecordFailure(program: Command): void {
  addRootOption(
    program
      .command("record-failure")
      .description("Record a tool/test failure against a symbol (fed into `gps suggest`)")
      .option("--symbol <name>", "Symbol to attribute (defaults to last-prepared)")
      .option("--kind <kind>", "test|typecheck|lint|bash|other", "other")
      .option("--message <m>", "Short failure message (or pipe via stdin)")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    let message = opts.message;
    if (!message) {
      const stdin = (await readStdin()).trim();
      if (stdin) message = stdin.slice(0, 500);
    }
    const target = await recordFailure(root, opts.symbol, {
      at: new Date().toISOString(),
      kind: opts.kind,
      ...(message ? { message } : {}),
    });
    if (opts.json) {
      console.log(JSON.stringify({ recorded: !!target, symbol: target }, null, 2));
      return;
    }
    if (!target) {
      // Silent no-op when no symbol context exists — keeps PostToolUse hooks quiet.
      return;
    }
    console.log(kleur.yellow(`recorded ${opts.kind} failure against ${target}`));
  });
}
