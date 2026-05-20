import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import kleur from "kleur";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

const SESSION_ID_REL = ".gps/session/id";
const SESSIONS_DIR = ".gps/sessions";

interface StartOpts extends RootOption {
  json?: boolean;
  id?: string;
}

interface ReplayOpts extends RootOption {
  json?: boolean;
  limit: number;
}

interface EndOpts extends RootOption {
  json?: boolean;
}

export function registerSession(program: Command): void {
  const session = program
    .command("session")
    .description("Per-session id tracking for replay/audit");

  addRootOption(
    session
      .command("start")
      .description("Generate a new session id (called by SessionStart hook)")
      .option("--id <uuid>", "Use a specific id instead of generating one")
      .option("--json", "Emit JSON"),
  ).action(async (opts: StartOpts) => {
    const root = resolveRoot(opts);
    const id = opts.id ?? randomUUID();
    const file = path.join(root, SESSION_ID_REL);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(path.join(path.dirname(file), ".gitignore"), "*\n");
    await writeFile(file, id);
    if (opts.json) console.log(JSON.stringify({ id }));
    else console.log(id);
  });

  addRootOption(
    session
      .command("end")
      .description("Clear the active session id (called by SessionEnd hook)")
      .option("--json", "Emit JSON"),
  ).action(async (opts: EndOpts) => {
    const root = resolveRoot(opts);
    try {
      await unlink(path.join(root, SESSION_ID_REL));
    } catch {
      /* not present */
    }
    if (opts.json) console.log(JSON.stringify({ ok: true }));
  });

  addRootOption(
    session
      .command("current")
      .description("Print the active session id, if any"),
  ).action(async (opts: RootOption) => {
    const root = resolveRoot(opts);
    try {
      const id = (await readFile(path.join(root, SESSION_ID_REL), "utf8")).trim();
      if (id) console.log(id);
    } catch {
      /* none */
    }
  });

  addRootOption(
    session
      .command("replay <id>")
      .description("Print the event log for a session")
      .option("--limit <n>", "Max events to print", (v) => parseInt(v, 10), 200)
      .option("--json", "Emit JSON"),
  ).action(async (id: string, opts: ReplayOpts) => {
    const root = resolveRoot(opts);
    const file = path.join(root, SESSIONS_DIR, `${id}.jsonl`);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      if (opts.json) console.log(JSON.stringify({ id, events: [] }));
      else console.log(kleur.yellow(`no events for session ${id}`));
      return;
    }
    const events: Array<Record<string, unknown>> = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* skip */
      }
    }
    const limited = events.slice(0, opts.limit);
    if (opts.json) {
      console.log(JSON.stringify({ id, count: events.length, events: limited }, null, 2));
      return;
    }
    console.log(kleur.bold(`session ${id}`) + kleur.dim(` (${events.length} events)`));
    for (const e of limited) {
      const t = String(e.type ?? "?");
      const ts = typeof e.ts === "string" ? e.ts.slice(11, 19) : "";
      const summary = summarize(e);
      console.log(`  ${kleur.dim(ts)}  ${kleur.cyan(t.padEnd(11))} ${summary}`);
    }
    if (events.length > limited.length) {
      console.log(kleur.dim(`  … ${events.length - limited.length} more (use --limit)`));
    }
  });
}

function summarize(e: Record<string, unknown>): string {
  switch (e.type) {
    case "query":
      return `${e.symbol ?? "?"} ${kleur.dim(`(${e.tool ?? "?"})`)}`;
    case "prepare":
      return String(e.symbol ?? "?");
    case "attribution": {
      const lc = (e.low_confidence as number | undefined) ?? 0;
      const tag = lc > 0 ? kleur.yellow(`${lc} low-confidence`) : kleur.dim("clean");
      return `${e.label ?? "?"} ${kleur.dim(`+${e.touched_symbols ?? 0} symbols, ${e.matched_files ?? 0} files`)} ${tag}`;
    }
    default:
      return JSON.stringify(e);
  }
}
