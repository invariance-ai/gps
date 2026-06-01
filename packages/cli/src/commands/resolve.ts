import type { Command } from "commander";
import kleur from "kleur";
import {
  buildResolvePacket,
  inferResolveKind,
  formatResolveMarkdown,
  formatResolvePretty,
} from "@invariance/gps-core";
import type { ResolveKind } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface ResolveOpts extends RootOption {
  json?: boolean;
  markdown?: boolean;
  tokens: number;
  budget?: number;
  hops: number;
  depth: number;
  history: number;
  kind?: ResolveKind;
  pr?: string;
  commit?: string;
  diff?: boolean;
  base: string;
}

const KINDS: ResolveKind[] = ["symbol", "file", "commit", "pr", "diff"];

export function registerResolve(program: Command): void {
  addRootOption(
    program
      .command("resolve [target]")
      .description(
        "Bug-resolution packet for a target (symbol | file | commit | PR | working-tree diff): " +
          "blast radius, tests, invariants, prior notes/decisions, and git/PR history in one payload",
      )
      .option("--json", "Emit JSON (best for tool chaining)")
      .option("--markdown", "Emit budgeted markdown (best for piping into an LLM)")
      .option("--tokens <n>", "Markdown token budget (<=0 = unlimited)", (v) => parseInt(v, 10), 6000)
      .option("--budget <n>", "Alias for --tokens", (v) => parseInt(v, 10))
      .option("--hops <n>", "Reverse caller depth", (v) => parseInt(v, 10), 3)
      .option("--depth <n>", "Forward dependency depth", (v) => parseInt(v, 10), 2)
      .option("--history <n>", "Git log entries per affected file", (v) => parseInt(v, 10), 3)
      .option("--kind <k>", `Force target kind: ${KINDS.join("|")}`)
      .option("--pr <n>", "Shortcut: target a PR number")
      .option("--commit <ref>", "Shortcut: target a commit")
      .option("--diff", "Shortcut: target the working-tree change set")
      .option("--base <ref>", "Diff base for --diff (default HEAD)", "HEAD"),
  ).action(async (target: string | undefined, opts: ResolveOpts) => {
    try {
      const root = resolveRoot(opts);

      // Resolve the target + kind: explicit shortcuts win, then --kind, then inference.
      let value = target ?? "";
      let kind: ResolveKind;
      if (opts.diff) {
        kind = "diff";
        value = opts.base === "HEAD" ? "" : opts.base;
      } else if (opts.pr !== undefined) {
        kind = "pr";
        value = opts.pr;
      } else if (opts.commit !== undefined) {
        kind = "commit";
        value = opts.commit;
      } else if (opts.kind) {
        if (!KINDS.includes(opts.kind)) throw new Error(`invalid --kind: ${opts.kind} (use ${KINDS.join("|")})`);
        kind = opts.kind;
      } else {
        kind = inferResolveKind(value);
      }

      const budget = opts.budget ?? opts.tokens;
      const packet = await buildResolvePacket(
        { target: { kind, value }, hops: opts.hops, depth: opts.depth, history: opts.history },
        root,
      );

      if (opts.json) {
        console.log(JSON.stringify(packet, null, 2));
        return;
      }
      if (opts.markdown) {
        console.log(formatResolveMarkdown(packet, budget));
        return;
      }
      console.log(formatResolvePretty(packet));
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
