import { parse as parseYaml } from "yaml";
import { randomUUID } from "node:crypto";
import type { Decision, Question } from "@invariance/gps-schemas";
import { Decision as DecisionSchema, Question as QuestionSchema } from "@invariance/gps-schemas";
import { GpsLlm } from "./client.js";

/**
 * Distill a conversation transcript or PR thread into structured Decision
 * records. The LLM looks for *choices made with rationale and a rejected
 * alternative* — not general lessons (those are notes).
 */

const SYSTEM = `You extract design decisions AND open questions from a conversation or PR thread.

A *decision* is a deliberate choice the team made about how a symbol should
work, with a rejected alternative and a rationale. Examples:
  - "validate amount before currency conversion (rejected: validate after,
    breaks for JPY)"
  - "memoize the index read (rejected: re-read every call, too slow)"

A decision is NOT:
  - a general lesson ("always wrap in withRetry") — that's a note
  - a future TODO — only retain choices that were actually made
  - a status update or progress report

An *open question* is something discussed but explicitly left unresolved —
"what about crypto settlements?", "do we need to handle JPY here?", a TODO that
flags a real ambiguity. Skip rhetorical questions and questions that were
answered in the transcript.

Output ONLY one fenced YAML code block (\`\`\`yaml ... \`\`\`) with this structure:

  decisions:
    - symbol:                  # the symbol the decision applies to
      decision:                # one-sentence: the choice that was made
      rejected_alternative:    # one-sentence (omit if there is none)
      rationale:               # one-sentence (omit if not stated)
      made_by:                 # name/handle if mentioned (omit otherwise)
      session:                 # the session/PR/conversation ID provided

  questions:
    - symbol:                  # the symbol the question applies to
      question:                # one-sentence
      asked_by:                # name/handle if mentioned (omit otherwise)

Either list can be empty. Do not invent items. Decision rationale and question
text must be grounded in the actual transcript.`;

export interface ExtractDecisionsInput {
  transcript: string;
  symbols_in_scope?: string[];
  session_id: string;
}

export interface ExtractDecisionsResult {
  decisions: Decision[];
  questions: Question[];
  raw_yaml: string;
  dry_run_prompt?: { system: string; user: string };
}

export async function extractDecisions(
  llm: GpsLlm,
  input: ExtractDecisionsInput,
): Promise<ExtractDecisionsResult> {
  const user = renderUserPrompt(input);
  const completion = await llm.complete({
    system: SYSTEM,
    user,
    maxTokens: 8000,
  });

  if (completion.dry_run_prompt) {
    return {
      decisions: [],
      questions: [],
      raw_yaml: "[dry-run]",
      dry_run_prompt: completion.dry_run_prompt,
    };
  }

  const yamlBlock = extractYamlBlock(completion.text);
  const parsed = parseYaml(yamlBlock) ?? {};
  // Back-compat: older prompts returned a bare array of decisions.
  const decisionsRaw: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { decisions?: unknown[] }).decisions)
      ? ((parsed as { decisions: unknown[] }).decisions)
      : [];
  const questionsRaw: unknown[] = Array.isArray(parsed)
    ? []
    : Array.isArray((parsed as { questions?: unknown[] }).questions)
      ? ((parsed as { questions: unknown[] }).questions)
      : [];

  const now = new Date().toISOString();
  const decisions: Decision[] = decisionsRaw.map((item) =>
    DecisionSchema.parse({
      ...(item as object),
      recorded_at: now,
      session: (item as { session?: string }).session ?? input.session_id,
    }),
  );
  const questions: Question[] = questionsRaw.map((item) =>
    QuestionSchema.parse({
      id: randomUUID(),
      ...(item as object),
      recorded_at: now,
      status: "unresolved",
      session: (item as { session?: string }).session ?? input.session_id,
    }),
  );

  return { decisions, questions, raw_yaml: yamlBlock };
}

function renderUserPrompt(input: ExtractDecisionsInput): string {
  const parts: string[] = [];
  parts.push(`Session/PR ID: ${input.session_id}`);
  if (input.symbols_in_scope && input.symbols_in_scope.length > 0) {
    parts.push("");
    parts.push("Symbols in scope (prefer these as the `symbol` field when possible):");
    parts.push(input.symbols_in_scope.map((s) => `  - ${s}`).join("\n"));
  }
  parts.push("");
  parts.push("Transcript:");
  parts.push("```");
  parts.push(input.transcript);
  parts.push("```");
  parts.push("");
  parts.push("Extract the decisions. Return only the YAML array.");
  return parts.join("\n");
}

function extractYamlBlock(text: string): string {
  const match = text.match(/```(?:yaml|yml)?\s*\n([\s\S]*?)```/);
  if (!match || !match[1]) {
    // The model may have returned a bare array — accept it as-is.
    const trimmed = text.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("-")) return trimmed;
    throw new Error(
      "LLM did not return a fenced YAML block. Re-run with --dry-run to see the raw response.",
    );
  }
  return match[1].trim();
}
