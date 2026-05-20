import type { Command } from "commander";
import kleur from "kleur";
import { addPreference } from "@invariance/gps-core";
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
    const result = await addPreference(root, {
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
    const verb = result.deduped ? "deduped" : "recorded";
    console.log(
      `${kleur.green(verb)} preference ${kleur.dim(result.preference.id)} → ${kleur.dim(result.file)}`,
    );
  });
}
