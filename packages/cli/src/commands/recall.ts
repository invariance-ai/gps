import type { Command } from "commander";
import kleur from "kleur";
import {
  recallMemory,
  formatRecallHit,
  packByBudget,
  estimateTokens,
  type RecallKind,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface RecallOpts extends RootOption {
  limit: number;
  budget?: string;
  kind?: string;
  related?: boolean;
  relatedLimit?: number;
  json?: boolean;
  tokens?: boolean;
}

const KINDS: RecallKind[] = ["note", "decision", "invariant", "preference", "lesson", "question", "assumption", "todo"];

function parseKinds(raw?: string): RecallKind[] | undefined {
  if (!raw) return undefined;
  const wanted = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = wanted.filter((k) => !(KINDS as string[]).includes(k));
  if (bad.length) {
    throw new Error(`unknown --kind value(s): ${bad.join(", ")} (valid: ${KINDS.join(", ")})`);
  }
  return wanted.length ? (wanted as RecallKind[]) : undefined;
}

export function registerRecall(program: Command): void {
  addRootOption(
    program
      .command("recall <query>")
      .description(
        "Search all repo memory (notes, decisions, invariants, preferences, lessons) by topic",
      )
      .option("--limit <n>", "Max results", (v) => parseInt(v, 10), 20)
      .option("--budget <tokens>", "Approximate token budget for the rendered output")
      .option("--kind <list>", `Restrict to comma-separated kinds (${KINDS.join(",")})`)
      .option("--related", "Attach one-hop symbol graph context to matching memory")
      .option("--related-limit <n>", "Max related symbols per memory hit", (v) => parseInt(v, 10), 6)
      .option("--tokens", "Print estimated token cost of the output")
      .option("--cost", "Alias for --tokens")
      .option("--json", "Emit JSON instead of markdown"),
  ).action(async (query: string, opts: RecallOpts & { cost?: boolean }) => {
    try {
      const root = resolveRoot(opts);
      if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
        throw new Error("--limit must be a positive integer");
      }
      if (
        opts.relatedLimit !== undefined &&
        (!Number.isInteger(opts.relatedLimit) || opts.relatedLimit <= 0)
      ) {
        throw new Error("--related-limit must be a positive integer");
      }
      const budget = opts.budget ? Number(opts.budget) : undefined;
      if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) {
        throw new Error("--budget must be a positive integer");
      }
      const showTokens = !!(opts.tokens || opts.cost);
      const kinds = parseKinds(opts.kind);
      const hits = await recallMemory(root, query, {
        limit: opts.limit,
        kinds,
        related: !!opts.related,
        relatedLimit: opts.relatedLimit,
      });

      if (opts.json) {
        const out: Record<string, unknown> = { query, hits };
        if (showTokens) {
          const text = hits.map(formatRecallHit).join("\n");
          out.tokens = { estimated: estimateTokens(text), kept: hits.length, dropped: 0 };
        }
        console.log(JSON.stringify(out, null, 2));
        return;
      }

      if (hits.length === 0) {
        console.log(kleur.dim(`no memory matches "${query}"`));
        return;
      }

      // Plain markdown (no ANSI) so the output pipes cleanly into an agent.
      const packed = packByBudget(
        [{ heading: `## Memory: "${query}"`, items: hits.map(formatRecallHit) }],
        budget ?? 0,
      );
      console.log(packed.text.trimEnd());
      if (showTokens) {
        const dropped = packed.dropped.reduce((n, d) => n + d.items, 0);
        const kept = packed.kept.reduce((n, k) => n + k.items, 0);
        console.log(
          kleur.dim(`\n~${estimateTokens(packed.text)} tokens (${kept} kept, ${dropped} dropped)`),
        );
      }
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
