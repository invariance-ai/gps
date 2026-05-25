import type { Command } from "commander";
import { extractPreferences, recordPreference } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  text?: string;
  json?: boolean;
  emit?: boolean;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function extractPromptFromHookJson(stdin: string): string {
  // Claude Code UserPromptSubmit hook passes a JSON object on stdin.
  // Field: user_message / prompt / message — be lenient.
  const trimmed = stdin.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      for (const key of ["user_message", "prompt", "message", "text"]) {
        const v = obj[key];
        if (typeof v === "string" && v.length > 0) return v;
      }
    } catch {
      // fall through, treat as raw text
    }
  }
  return trimmed;
}

export function registerCapturePreference(program: Command): void {
  addRootOption(
    program
      .command("capture-preference")
      .description("Heuristically extract preferences from a prompt (UserPromptSubmit hook)")
      .option("--text <t>", "Prompt text (otherwise read from stdin)")
      .option("--emit", "Print captured preferences back to stdout (markdown block)")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    const raw = opts.text ?? (await readStdin());
    const prompt = extractPromptFromHookJson(raw);
    if (!prompt) return;

    const extracted = extractPreferences(prompt);
    if (extracted.length === 0) return;

    // Route every extraction through the shared capture gate so passive and
    // explicit captures obey the same policy. recordPreference queues to the
    // inbox under capture=inbox and writes active under capture=auto.
    const queued = [];
    const recorded = [];
    for (const e of extracted) {
      const r = await recordPreference(root, {
        text: e.text,
        source: "auto",
        evidence: `cue:${e.cue}`,
      });
      if (r.deduped) continue;
      if (r.placement === "inbox") queued.push(r.inbox!.item);
      else recorded.push(r.preference!.preference);
    }

    if (queued.length > 0) {
      if (opts.json) {
        console.log(JSON.stringify({ queued }, null, 2));
        return;
      }
      if (opts.emit) {
        const lines = ["<!-- gps:captured-prefs -->"];
        lines.push(`gps queued ${queued.length} preference${queued.length === 1 ? "" : "s"} to the inbox for review (capture=inbox):`);
        for (const p of queued) lines.push(`- ${p.text}`);
        lines.push("Run `gps inbox` to review, then `gps inbox approve <id>`.");
        lines.push("<!-- /gps:captured-prefs -->");
        console.log(lines.join("\n"));
      }
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify({ recorded }, null, 2));
      return;
    }
    if (opts.emit && recorded.length > 0) {
      const lines = ["<!-- gps:captured-prefs -->"];
      lines.push(`gps captured ${recorded.length} preference${recorded.length === 1 ? "" : "s"} from this prompt:`);
      for (const p of recorded) lines.push(`- ${p.text}`);
      lines.push("Run `gps preferences` to review or `gps prefer --remove <id>` to drop.");
      lines.push("<!-- /gps:captured-prefs -->");
      console.log(lines.join("\n"));
    }
  });
}
