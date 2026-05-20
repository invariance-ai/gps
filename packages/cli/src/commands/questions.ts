import type { Command } from "commander";
import kleur from "kleur";
import {
  filterByStatus,
  loadAllQuestions,
  loadQuestions,
  setStatus,
  topSymbols,
} from "@invariance/gps-core";
import type { Question, QuestionStatus } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface ListOpts extends RootOption {
  feature?: string;
  status?: string;
  limit: number;
  json?: boolean;
}

interface ResolveOpts extends RootOption {
  id: string;
  resolution?: string;
  status?: string;
  json?: boolean;
}

export function registerQuestions(program: Command): void {
  addRootOption(
    program
      .command("questions [symbol]")
      .description("List open questions (by symbol, by feature, or globally)")
      .option("--feature <label>", "Scope to a feature's weight bag")
      .option("--status <s>", "unresolved | resolved | wontfix")
      .option("--limit <n>", "Max questions to print", (v) => parseInt(v, 10), 50)
      .option("--json", "Emit JSON"),
  ).action(async (symbol: string | undefined, opts: ListOpts) => {
    const root = resolveRoot(opts);
    const status = parseStatus(opts.status);

    let questions: Question[];
    if (symbol) {
      questions = await loadQuestions(root, symbol);
    } else if (opts.feature) {
      const top = await topSymbols(root, opts.feature, 100);
      const all = await loadAllQuestions(root);
      const symbolsInBag = new Set(top.map((s) => s.id));
      const weightById = new Map(top.map((s) => [s.id, s.weight]));
      // A question's symbol field is the un-normalized symbol name; weight bags
      // store ids. Surface both: any question whose symbol matches an id in the
      // bag OR is a suffix of one.
      questions = all
        .map((q) => ({ q, weight: matchWeight(q.symbol, symbolsInBag, weightById) }))
        .filter((x) => x.weight !== undefined)
        .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
        .map((x) => x.q);
    } else {
      questions = await loadAllQuestions(root);
    }
    questions = filterByStatus(questions, status);
    const truncated = questions.slice(0, opts.limit);

    if (opts.json) {
      console.log(JSON.stringify({ count: questions.length, questions: truncated }, null, 2));
      return;
    }
    if (truncated.length === 0) {
      console.log(kleur.dim("no questions"));
      return;
    }
    for (const q of truncated) {
      const tag =
        q.status === "unresolved"
          ? kleur.yellow("?")
          : q.status === "resolved"
            ? kleur.green("✓")
            : kleur.dim("✗");
      const meta = [q.asked_by, q.recorded_at.slice(0, 10)].filter(Boolean).join(" · ");
      console.log(`  ${tag} ${kleur.bold(q.symbol)}  ${q.question}`);
      if (meta) console.log(`     ${kleur.dim(meta)}`);
      if (q.resolution) console.log(`     ${kleur.dim("→ " + q.resolution)}`);
    }
    if (questions.length > truncated.length) {
      console.log(kleur.dim(`  … ${questions.length - truncated.length} more (use --limit)`));
    }
  });

  addRootOption(
    program
      .command("question-resolve <symbol>")
      .description("Resolve (or wontfix) an open question by id")
      .requiredOption("--id <id>", "Question id")
      .option("--resolution <text>", "Short answer to record")
      .option("--status <s>", "resolved | wontfix | unresolved", "resolved")
      .option("--json", "Emit JSON"),
  ).action(async (symbol: string, opts: ResolveOpts) => {
    const root = resolveRoot(opts);
    const status = parseStatus(opts.status) ?? "resolved";
    const updated = await setStatus(root, symbol, opts.id, status, opts.resolution);
    if (opts.json) {
      console.log(JSON.stringify({ ok: !!updated, question: updated ?? null }, null, 2));
      return;
    }
    if (!updated) {
      console.log(kleur.yellow(`no question with id ${opts.id} on ${symbol}`));
      return;
    }
    console.log(`${kleur.green(status)} question on ${kleur.bold(symbol)}`);
  });
}

function parseStatus(s?: string): QuestionStatus | undefined {
  if (!s) return undefined;
  if (s === "unresolved" || s === "resolved" || s === "wontfix") return s;
  return undefined;
}

function matchWeight(
  symbol: string,
  bag: Set<string>,
  weightById: Map<string, number>,
): number | undefined {
  // direct id hit
  if (bag.has(symbol)) return weightById.get(symbol);
  // symbol-name-only match against any id in the bag
  let best: number | undefined;
  for (const id of bag) {
    if (
      id === symbol ||
      id.endsWith(`#${symbol}`) ||
      id.endsWith(`.${symbol}`) ||
      id.endsWith(`/${symbol}`) ||
      id.includes(`#${symbol}:`)
    ) {
      const w = weightById.get(id) ?? 0;
      if (best === undefined || w > best) best = w;
    }
  }
  return best;
}
