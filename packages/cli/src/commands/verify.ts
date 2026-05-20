import type { Command } from "commander";
import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import kleur from "kleur";
import { loadAllNotes, updateNoteById } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

const execFile = promisify(_execFile);

interface VerifyListOpts extends RootOption {
  json?: boolean;
  min?: string;
}

interface VerifyOpts extends RootOption {
  by?: string;
}

export function registerVerify(program: Command): void {
  const cmd = program
    .command("verify")
    .description("Review provenance: list unverified notes, or verify a note by id");

  addRootOption(
    cmd
      .command("list", { isDefault: true })
      .description("List unverified notes ranked by severity * (1 - confidence)")
      .option("--json", "Emit JSON")
      .option("--min <n>", "Minimum priority score (default 0.2)", "0.2"),
  ).action(async (opts: VerifyListOpts) => {
    const root = resolveRoot(opts);
    const all = await loadAllNotes(root);
    const min = Number(opts.min ?? "0.2");
    const ranked = all
      .filter((n) => !n.verified_by)
      .map((n) => ({ note: n, score: priority(n) }))
      .filter((x) => x.score >= min)
      .sort((a, b) => b.score - a.score);

    if (opts.json) {
      console.log(JSON.stringify(ranked, null, 2));
      return;
    }
    if (ranked.length === 0) {
      console.log(kleur.green("✓ no unverified notes above threshold"));
      return;
    }
    for (const { note, score } of ranked.slice(0, 50)) {
      console.log(`  ${kleur.cyan(note.id ?? "(no id)")} ${kleur.dim(`prio=${score.toFixed(2)} sev=${note.severity} conf=${note.confidence ?? "?"} src=${note.source}`)}`);
      console.log(`    ${kleur.dim(note.symbol)} — ${note.lesson}`);
      if (note.evidence_link || note.evidence) {
        console.log(kleur.dim(`    evidence: ${note.evidence_link ?? note.evidence}`));
      }
    }
    console.log("");
    console.log(kleur.dim(`verify with: gps verify <id> [--by <email>]`));
  });

  addRootOption(
    cmd
      .argument("[id]", "Note id to verify")
      .option("--by <who>", "Verifier identity (default git user.email)"),
  ).action(async (id: string | undefined, opts: VerifyOpts) => {
    if (!id) return; // list subcommand handles no-arg
    const root = resolveRoot(opts);
    const by = opts.by ?? (await gitUser(root));
    const updated = await updateNoteById(root, id, {
      verified_by: by,
      verified_at: new Date().toISOString(),
      confidence: 1.0,
    });
    if (!updated) {
      console.log(kleur.red(`✗ note ${id} not found`));
      process.exitCode = 1;
      return;
    }
    console.log(kleur.green(`✓ verified ${id} by ${by}`));
    console.log(kleur.dim(`  ${updated.path}`));
  });
}

function priority(n: { severity: "low" | "medium" | "high"; confidence?: number }): number {
  const sevWeight = n.severity === "high" ? 1 : n.severity === "medium" ? 0.6 : 0.3;
  const conf = n.confidence ?? 0.5;
  return sevWeight * (1 - conf);
}

async function gitUser(root: string): Promise<string> {
  try {
    const { stdout } = await execFile("git", ["config", "user.email"], { cwd: root });
    return stdout.trim() || "anonymous";
  } catch {
    return "anonymous";
  }
}
