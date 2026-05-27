import { readFile, mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import {
  appendSessionEventIfActive,
  areaForPath,
  loadAreaNotes,
  loadFeatureNotes,
  loadAliases,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  text?: string;
  json?: boolean;
}

const SURFACED_REL = ".gps/session/area-surfaced";
const TOOL_NAME_TO_SEARCH_TOOL: Record<string, string> = {
  Grep: "rg",
  Glob: "find",
  Read: "cat",
};

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Pull the path/pattern a Grep/Glob/Read tool call is about to touch out of
 * the PreToolUse hook JSON. Lenient — field names vary by tool.
 */
function extractPathFromHookJson(stdin: string): { target?: string; tool?: string } {
  const trimmed = stdin.trim();
  if (!trimmed) return {};
  if (!trimmed.startsWith("{")) return { target: trimmed, tool: "query" };
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const input = (obj.tool_input ?? obj.input ?? obj) as Record<string, unknown>;
    const rawTool = typeof obj.tool_name === "string" ? obj.tool_name : undefined;
    for (const key of ["path", "file_path", "glob", "pattern"]) {
      const v = input[key];
      if (typeof v === "string" && v.length > 0) {
        return {
          target: v,
          tool: rawTool ? (TOOL_NAME_TO_SEARCH_TOOL[rawTool] ?? rawTool) : "query",
        };
      }
    }
  } catch {
    /* not JSON */
  }
  return {};
}

async function alreadySurfaced(root: string, area: string): Promise<boolean> {
  try {
    const raw = await readFile(path.join(root, SURFACED_REL), "utf8");
    return raw.split("\n").some((l) => l.trim() === area);
  } catch {
    return false;
  }
}

async function markSurfaced(root: string, area: string): Promise<void> {
  const p = path.join(root, SURFACED_REL);
  try {
    await mkdir(path.dirname(p), { recursive: true });
    await appendFile(p, `${area}\n`);
  } catch {
    /* best-effort */
  }
}

export function registerContextFromPath(program: Command): void {
  addRootOption(
    program
      .command("context-from-path")
      .description("Surface area context for a searched/read path (PreToolUse hook for Grep|Glob|Read)")
      .option("--text <t>", "Path or pattern (otherwise read hook JSON from stdin)")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    const raw = opts.text ?? (await readStdin());
    const extracted = opts.text
      ? { target: opts.text, tool: "query" }
      : extractPathFromHookJson(raw);
    const target = extracted.target;
    if (!target) return;

    // TARS-style structured capture: keep a compact local trace of the agent's
    // search/read path so gps can later suggest durable memory for hard-won finds.
    await appendSessionEventIfActive(root, {
      type: "tool",
      ts: new Date().toISOString(),
      tool: extracted.tool ?? "query",
      path: target,
    }).catch(() => {});

    let area: string | undefined;
    try {
      area = await areaForPath(root, target);
    } catch {
      return; // hook must never fail
    }
    if (!area) return;

    // Throttle: surface each area at most once per session.
    if (await alreadySurfaced(root, area)) return;

    const notes = await loadAreaNotes(root, area).catch(() => []);
    if (notes.length === 0) return;

    // Chain link: if an alias for this area is tied to a feature, pull that
    // feature's notes too so the area → feature link is visible mid-task.
    const aliases = await loadAliases(root).catch(() => ({}));
    const linked = Object.values(aliases).find(
      (a) => a.dir === area && a.feature,
    );
    const featureNotes = linked?.feature
      ? await loadFeatureNotes(root, linked.feature).catch(() => [])
      : [];

    await markSurfaced(root, area);

    if (opts.json) {
      console.log(
        JSON.stringify(
          { area, notes, feature: linked?.feature, feature_notes: featureNotes },
          null,
          2,
        ),
      );
      return;
    }

    const lines: string[] = [];
    lines.push("<!-- gps:auto-context -->");
    lines.push(`## gps auto-loaded context — area \`${area}\``);
    lines.push("");
    lines.push("You're working in an area with prior directives. Respect them.");
    lines.push("");
    lines.push("**Directives for this location:**");
    for (const n of notes.slice(0, 5)) {
      lines.push(`- [${n.severity ?? "info"}] ${n.lesson}`);
    }
    if (linked?.feature && featureNotes.length > 0) {
      lines.push("");
      lines.push(`**Linked feature \`${linked.feature}\`:**`);
      for (const n of featureNotes.slice(0, 3)) {
        lines.push(`- [${n.severity ?? "info"}] ${n.lesson}`);
      }
    }
    lines.push("<!-- /gps:auto-context -->");
    console.log(lines.join("\n"));
  });
}
