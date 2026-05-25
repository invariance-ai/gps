import { parse as parseYaml } from "yaml";
import { randomUUID } from "node:crypto";
import type { Decision, Question } from "@invariance/gps-schemas";
import { Decision as DecisionSchema, Question as QuestionSchema } from "@invariance/gps-schemas";
import { GpsLlm } from "./client.js";

/**
 * Distill a conversation transcript or PR thread into structured Decision
 * records anchored to symbols. The LLM looks for *choices made with rationale
 * and a rejected alternative* — not general lessons (those are notes).
 *
 * Also extracts:
 *  - auto-lessons: non-obvious things learned during the session
 *  - user-corrections: when the user corrected/rejected the agent
 */

const SYSTEM = `You extract design decisions, open questions, auto-lessons, and user-corrections from a conversation or PR thread.

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

An *auto-lesson* is a non-obvious, concrete thing learned during the session
that would help a future agent avoid a mistake or understand the codebase
better. Think: subtle invariants, gotchas, non-obvious constraints, things
that broke and why. Do NOT include trivial observations.

A *user-correction* is a case where the user explicitly told the agent it was
wrong, something broke, or corrected it ("no that's wrong", "that broke X",
"don't do that", "undo that", "revert"). Extract only explicit corrections from
the USER turns — never infer corrections from assistant apologies alone.

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

  auto_lessons:
    - symbol:                  # the most relevant symbol (use "general" if none)
      lesson:                  # one-sentence, concrete and actionable
      evidence:                # brief context from transcript (optional)

  user_corrections:
    - symbol:                  # the most relevant symbol (use "general" if none)
      lesson:                  # one-sentence describing what was wrong / what to avoid
      evidence:                # the user's exact words or close paraphrase (optional)

Any list can be empty. Do not invent items. Decision rationale and question
text must be grounded in the actual transcript. Auto-lessons and user-corrections
must be grounded in actual transcript content.`;

export interface ExtractDecisionsInput {
  transcript: string;
  symbols_in_scope?: string[];
  session_id: string;
}

export interface AutoLesson {
  symbol: string;
  lesson: string;
  evidence?: string;
}

export interface UserCorrection {
  symbol: string;
  lesson: string;
  evidence?: string;
}

export interface ExtractDecisionsResult {
  decisions: Decision[];
  questions: Question[];
  auto_lessons: AutoLesson[];
  user_corrections: UserCorrection[];
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
      auto_lessons: [],
      user_corrections: [],
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
  const autoLessonsRaw: unknown[] = Array.isArray(parsed)
    ? []
    : Array.isArray((parsed as { auto_lessons?: unknown[] }).auto_lessons)
      ? ((parsed as { auto_lessons: unknown[] }).auto_lessons)
      : [];
  const userCorrectionsRaw: unknown[] = Array.isArray(parsed)
    ? []
    : Array.isArray((parsed as { user_corrections?: unknown[] }).user_corrections)
      ? ((parsed as { user_corrections: unknown[] }).user_corrections)
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
  const auto_lessons: AutoLesson[] = autoLessonsRaw.map((item) => ({
    symbol: (item as { symbol?: string }).symbol ?? "general",
    lesson: (item as { lesson?: string }).lesson ?? "",
    evidence: (item as { evidence?: string }).evidence,
  })).filter((l) => l.lesson.trim().length > 0);
  const user_corrections: UserCorrection[] = userCorrectionsRaw.map((item) => ({
    symbol: (item as { symbol?: string }).symbol ?? "general",
    lesson: (item as { lesson?: string }).lesson ?? "",
    evidence: (item as { evidence?: string }).evidence,
  })).filter((c) => c.lesson.trim().length > 0);

  return { decisions, questions, auto_lessons, user_corrections, raw_yaml: yamlBlock };
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
  parts.push("Extract the decisions, questions, auto-lessons, and user-corrections. Return only the YAML block.");
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
