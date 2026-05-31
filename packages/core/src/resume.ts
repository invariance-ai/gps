import { type TodoItem as TodoItemT, type Question as QuestionT, type Decision as DecisionT, type Goal as GoalT } from "@invariance/gps-schemas";
import { changedFiles } from "./git_diff.js";
import { activeGoal } from "./goals.js";
import { listTodos } from "./todos.js";
import { loadAllQuestions, filterByStatus } from "./questions.js";
import { loadDecisions, rankDecisions } from "./decisions.js";
import { filterExpiredDecisions } from "./decisions.js";
import { filterExpiredNotes } from "./notes.js";
import { loadNotes } from "./notes.js";
import { symbolsInHunks, changedHunks } from "./diff_to_symbols.js";

export interface ResumeResult {
  goal: GoalT | null;
  todos: TodoItemT[];
  questions: QuestionT[];
  decisions: DecisionT[];
  changed_files: string[];
  markdown: string;
}

/**
 * "Where was I?" — surface TODOs, open questions, and recent decisions for the
 * current working diff/branch.
 *
 * Algorithm:
 *   1. Get changed files from the current git diff (HEAD vs working tree).
 *   2. Map changed hunks → changed symbols via the index.
 *   3. For each changed file, surface open TODOs and unresolved questions tied
 *      to those symbols/files.
 *   4. Surface decisions recorded for changed symbols (most recent 3 per symbol).
 *   5. Return a concise markdown brief.
 */
export async function resume(root: string): Promise<ResumeResult> {
  const { files: changed_files } = await changedFiles(root);

  // The durable goal for this branch — the first thing to re-read after a reset.
  const goal = (await activeGoal(root).catch(() => undefined)) ?? null;

  // Map changed hunks to symbol names.
  let changedSymbolNames: string[] = [];
  try {
    const hunks = await changedHunks(root);
    const hits = await symbolsInHunks(root, hunks);
    changedSymbolNames = [...new Set(hits.map((h) => h.qualified_name))];
  } catch {
    /* index missing or git error — degrade gracefully */
  }

  // TODOs: for all changed files.
  const allTodoPromises = changed_files.map((f) =>
    listTodos(root, { file: f }).catch(() => [] as TodoItemT[]),
  );
  const todoArrays = await Promise.all(allTodoPromises);
  const todos: TodoItemT[] = todoArrays
    .flat()
    .filter((t) => !t.resolved_at);

  // Questions: all unresolved questions for changed symbols.
  const allQuestions = await loadAllQuestions(root).catch(() => [] as QuestionT[]);
  const symbolSet = new Set(changedSymbolNames);
  const questions: QuestionT[] = filterByStatus(allQuestions, "unresolved").filter((q) => {
    // Include if question is tied to a changed symbol.
    return symbolSet.has(q.symbol) || changedSymbolNames.some((s) => q.symbol.includes(s));
  });

  // Decisions: for changed symbols, most recent 3 each.
  const decisionMap = new Map<string, DecisionT[]>();
  for (const sym of changedSymbolNames) {
    const d = await loadDecisions(root, sym).catch(() => [] as DecisionT[]);
    const active = filterExpiredDecisions(d);
    if (active.length > 0) {
      decisionMap.set(sym, rankDecisions(active, 3));
    }
  }
  const decisions: DecisionT[] = [...decisionMap.values()].flat();

  // Build markdown brief.
  const lines: string[] = [];
  lines.push("# Session Resume Brief");
  lines.push("");

  if (goal) {
    lines.push("## Goal");
    lines.push(`**${goal.goal}**`);
    if (goal.detail) lines.push(`\n${goal.detail}`);
    if (goal.todos.length > 0) {
      lines.push("");
      lines.push("Open follow-ups:");
      for (const t of goal.todos) lines.push(`- ${t}`);
    }
    lines.push("");
  }

  if (changed_files.length > 0) {
    lines.push(`## Changed files (${changed_files.length})`);
    for (const f of changed_files.slice(0, 20)) lines.push(`- \`${f}\``);
    if (changed_files.length > 20) lines.push(`- …and ${changed_files.length - 20} more`);
    lines.push("");
  } else {
    lines.push("_No changed files detected (clean working tree)._");
    lines.push("");
  }

  if (todos.length > 0) {
    lines.push(`## Open TODOs (${todos.length})`);
    for (const t of todos) {
      const sym = t.symbol ? ` \`${t.symbol}\`` : "";
      lines.push(`- **${t.file}**${sym}: ${t.text}`);
    }
    lines.push("");
  }

  if (questions.length > 0) {
    lines.push(`## Open questions (${questions.length})`);
    for (const q of questions) {
      lines.push(`- \`${q.symbol}\`: ${q.question}`);
    }
    lines.push("");
  }

  if (decisions.length > 0) {
    lines.push(`## Recent decisions`);
    for (const d of decisions) {
      lines.push(`- **${d.symbol}**: ${d.decision}`);
      if (d.rationale) lines.push(`  - rationale: ${d.rationale}`);
    }
    lines.push("");
  }

  if (!goal && todos.length === 0 && questions.length === 0 && decisions.length === 0) {
    lines.push("_No goal, open TODOs, questions, or decisions found for changed files._");
  }

  const markdown = lines.join("\n");
  return { goal, todos, questions, decisions, changed_files, markdown };
}
