import type { Command } from "commander";
import kleur from "kleur";
import { listTodosWithNotes, resolveTodo } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface ListOpts extends RootOption {
  file?: string;
  includeResolved?: boolean;
  json?: boolean;
}

interface ResolveOpts extends RootOption {
  json?: boolean;
}

export function registerTodos(program: Command): void {
  addRootOption(
    program
      .command("todos [symbol]")
      .description("List unresolved GPS TODOs by symbol or file")
      .option("--file <path>", "Restrict to a repo-relative file")
      .option("--include-resolved", "Include resolved TODOs")
      .option("--json", "Emit JSON"),
  ).action(async (symbol: string | undefined, opts: ListOpts) => {
    const root = resolveRoot(opts);
    const todos = await listTodosWithNotes(root, {
      symbol,
      file: opts.file,
      includeResolved: !!opts.includeResolved,
    });
    if (opts.json) {
      console.log(JSON.stringify({ todos }, null, 2));
      return;
    }
    if (todos.length === 0) {
      console.log(kleur.dim("no todos"));
      return;
    }
    for (const t of todos) {
      const loc = t.line !== undefined ? `${t.file}:${t.line}` : t.file;
      const status = t.resolved_at ? kleur.green("✓") : kleur.yellow("?");
      const symbolPart = t.symbol ? ` ${kleur.bold(t.symbol)}` : "";
      console.log(`  ${status}${symbolPart} ${t.text}`);
      console.log(`     ${kleur.dim(`${t.id} · ${loc} · ${t.source}`)}`);
    }
  });

  addRootOption(
    program
      .command("todo-resolve <id>")
      .description("Mark a GPS TODO as resolved")
      .option("--json", "Emit JSON"),
  ).action(async (id: string, opts: ResolveOpts) => {
    const root = resolveRoot(opts);
    const resolved = await resolveTodo(root, id);
    if (opts.json) {
      console.log(JSON.stringify({ id, resolved }, null, 2));
      return;
    }
    if (resolved) console.log(`${kleur.green("resolved")} ${id}`);
    else {
      console.error(kleur.red(`no unresolved todo with id=${id}`));
      process.exitCode = 1;
    }
  });
}
