import type { Command } from "commander";
import { extractDirectives, recordDirective, resolveActiveArea } from "@invariance/gps-core";
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
      /* fall through */
    }
  }
  return trimmed;
}

export function registerCaptureDirective(program: Command): void {
  addRootOption(
    program
      .command("capture-directive")
      .description("Heuristically capture location-scoped directives from a prompt (UserPromptSubmit hook)")
      .option("--text <t>", "Prompt text (otherwise read from stdin)")
      .option("--emit", "Print captured directives back to stdout (markdown block)")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    const raw = opts.text ?? (await readStdin());
    const prompt = extractPromptFromHookJson(raw);
    if (!prompt) return;

    const directives = extractDirectives(prompt);
    if (directives.length === 0) return;

    // All directives in one prompt share the active area — resolve once. If
    // nothing resolves, stay silent (the hook must never fail).
    const area = await resolveActiveArea(root).catch(() => undefined);
    if (!area) {
      if (opts.emit) {
        console.log(
          [
            "<!-- gps:captured-directive -->",
            `gps noticed ${directives.length} location-scoped instruction${directives.length === 1 ? "" : "s"} but couldn't resolve which area "here" means.`,
            "Run `gps feature use <label>` or pass `gps directive add \"...\" --area <dir>` to record them.",
            "<!-- /gps:captured-directive -->",
          ].join("\n"),
        );
      }
      return;
    }

    const recorded = [];
    for (const d of directives) {
      try {
        const r = await recordDirective(root, {
          directive: d.text,
          polarity: d.polarity,
          area,
        });
        recorded.push({ ...r, text: d.text });
      } catch {
        /* best-effort — never fail the hook */
      }
    }

    if (opts.json) {
      console.log(JSON.stringify({ recorded }, null, 2));
      return;
    }
    if (opts.emit && recorded.length > 0) {
      const lines = ["<!-- gps:captured-directive -->"];
      lines.push(
        `gps captured ${recorded.length} directive${recorded.length === 1 ? "" : "s"} for area \`${area}\`:`,
      );
      for (const r of recorded) lines.push(`- [${r.polarity}] ${r.text}`);
      lines.push("These will resurface when you work in this directory. Run `gps directive list` to review.");
      lines.push("<!-- /gps:captured-directive -->");
      console.log(lines.join("\n"));
    }
  });
}
