import type { Command } from "commander";
import kleur from "kleur";
import { recordPreference } from "@invariance/gps-core";
import type { PreferenceScope, PreferenceSource } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  scope: string;
  topic?: string;
  evidence?: string;
  source: string;
  json?: boolean;
}

export function registerPrefer(program: Command): void {
  addRootOption(
    program
      .command("prefer <text...>")
      .description("Record a personal preference (e.g. \"keep PRs under 300 lines\")")
      .option("--scope <s>", "repo | user | global", "repo")
      .option("--topic <t>", "Tag (e.g. pr, tests, style)")
      .option("--evidence <e>", "Why this preference (link, quote)")
      .option("--source <s>", "manual | auto | wizard", "manual")
      .option("--json", "Emit JSON"),
  ).action(async (text: string[], opts: Opts) => {
    const root = resolveRoot(opts);
    // Routes through the shared capture gate: under capture=inbox this queues
    // for review instead of writing straight to active memory (Fix 4, A).
    const result = await recordPreference(root, {
      text: text.join(" "),
      scope: opts.scope as PreferenceScope,
      topic: opts.topic,
      evidence: opts.evidence,
      source: opts.source as PreferenceSource,
    });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.placement === "inbox") {
      const item = result.inbox!.item;
      const verb = result.deduped ? "already queued" : "queued";
      console.log(
        `${kleur.yellow(verb)} preference ${kleur.dim(item.id)} for review ${kleur.dim("(capture=inbox)")} — run ${kleur.bold("gps inbox")} to approve`,
      );
      return;
    }
    const pref = result.preference!;
    const verb = result.deduped ? "deduped" : "recorded";
    console.log(
      `${kleur.green(verb)} preference ${kleur.dim(pref.preference.id)} → active memory ${kleur.dim(pref.file)}`,
    );
  });
}
