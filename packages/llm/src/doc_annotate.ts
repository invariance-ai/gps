import { parse as parseYaml } from "yaml";
import type { DocAnnotation, DocAnnotateRequest } from "@invariance/gps-schemas";
import { GpsLlm } from "./client.js";

/**
 * Generate plain-english "what these changed lines do" annotations for hunks
 * that have no captured gps note. Used by `gps doc` to fill the gaps the
 * notes/decisions overlay leaves behind.
 *
 * All requests are batched into a single completion. The model echoes each
 * request's index so we can map glosses back to file/line ranges reliably.
 * Mirrors the postmortem.ts pattern: SYSTEM prompt → complete → fenced block →
 * validate; dry-run returns the prompt and no annotations.
 */

const SYSTEM = `You write concise documentation annotations for changed code.

You receive a JSON array of code hunks, each with an "id", a file path, a line
range, and the changed code. For each hunk, write ONE or TWO plain-english
sentences explaining what that code does and why it matters to a reader skimming
the change. No fluff, no restating the code line-by-line, no "this code".

Output ONLY a YAML array inside a single fenced code block (\`\`\`yaml ... \`\`\`).
Each element must be an object with exactly:

  id:    # the integer id from the input
  text:  # your one-to-two sentence explanation

Skip hunks that are pure noise (formatting, imports) by omitting them.`;

export interface AnnotateDiffResult {
  annotations: DocAnnotation[];
  dry_run_prompt?: { system: string; user: string };
}

export async function annotateDiff(
  llm: GpsLlm,
  reqs: DocAnnotateRequest[],
): Promise<AnnotateDiffResult> {
  if (reqs.length === 0) return { annotations: [] };

  const user = renderUserPrompt(reqs);
  const completion = await llm.complete({ system: SYSTEM, user, maxTokens: 8000 });

  if (completion.dry_run_prompt) {
    return { annotations: [], dry_run_prompt: completion.dry_run_prompt };
  }

  const parsed = parseGlosses(completion.text);
  const annotations: DocAnnotation[] = [];
  for (const g of parsed) {
    const req = reqs[g.id];
    if (!req || !g.text.trim()) continue;
    annotations.push({
      file: req.file,
      start_line: req.start_line,
      end_line: req.end_line,
      text: g.text.trim(),
      kind: "llm",
      source: "llm",
      symbol: req.symbol,
    });
  }
  return { annotations };
}

function renderUserPrompt(reqs: DocAnnotateRequest[]): string {
  const payload = reqs.map((r, id) => ({
    id,
    file: r.file,
    symbol: r.symbol,
    lines: `${r.start_line}-${r.end_line}`,
    language: r.language,
    code: r.code,
  }));
  return [
    "Annotate these changed hunks. Return only the YAML array.",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
  ].join("\n");
}

interface Gloss {
  id: number;
  text: string;
}

function parseGlosses(text: string): Gloss[] {
  const match = text.match(/```(?:yaml|yml|json)?\s*\n([\s\S]*?)```/);
  const block = match?.[1] ?? text;
  let data: unknown;
  try {
    data = parseYaml(block);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: Gloss[] = [];
  for (const d of data) {
    if (d && typeof d === "object" && typeof (d as Gloss).id === "number" && typeof (d as Gloss).text === "string") {
      out.push({ id: (d as Gloss).id, text: (d as Gloss).text });
    }
  }
  return out;
}
