import type { Command } from "commander";
import { access, stat, readFile } from "node:fs/promises";
import path from "node:path";
import kleur from "kleur";
import { indexPath, readIndex, staleFiles } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  json?: boolean;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function runChecks(root: string): Promise<Check[]> {
  const checks: Check[] = [];

  const gpsDir = path.join(root, ".gps");
  const hasGpsDir = await exists(gpsDir);
  checks.push({
    name: ".gps/ directory",
    ok: hasGpsDir,
    detail: hasGpsDir ? gpsDir : "missing",
    hint: hasGpsDir ? undefined : "run `gps init`",
  });

  const cfg = path.join(root, ".gps/config.yml");
  const hasCfg = await exists(cfg);
  checks.push({
    name: "config (.gps/config.yml)",
    ok: hasCfg,
    detail: hasCfg ? "present" : "missing",
    hint: hasCfg ? undefined : "run `gps init`",
  });

  const inv = path.join(root, ".gps/invariants.yml");
  const hasInv = await exists(inv);
  checks.push({
    name: "invariants (.gps/invariants.yml)",
    ok: hasInv,
    detail: hasInv ? "present" : "missing",
    hint: hasInv ? undefined : "run `gps init`",
  });

  const idx = indexPath(root);
  const hasIdx = await exists(idx);
  if (!hasIdx) {
    checks.push({
      name: "symbol index",
      ok: false,
      detail: "not built",
      hint: "run `gps index`",
    });
  } else {
    try {
      const index = await readIndex(root);
      const report = await staleFiles(root, index);
      const fresh = report.stale_files.length === 0 && report.missing_files.length === 0;
      checks.push({
        name: "symbol index",
        ok: fresh,
        detail: fresh
          ? `${index.symbols.length} symbols, ${index.files.length} files, built ${index.built_at}`
          : `${report.stale_files.length} stale, ${report.missing_files.length} missing`,
        hint: fresh ? undefined : "run `gps index` to rebuild",
      });
    } catch (err) {
      checks.push({
        name: "symbol index",
        ok: false,
        detail: `unreadable: ${(err as Error).message}`,
        hint: "delete .gps/index/ and run `gps index`",
      });
    }
  }

  // Surface cached verify-index report if present.
  const verifyPath = path.join(root, ".gps/cache/verify-index.json");
  if (await exists(verifyPath)) {
    try {
      const raw = await readFile(verifyPath, "utf8");
      const v = JSON.parse(raw) as {
        precision: number;
        recall: number;
        coverage: number;
        thresholds?: { precision: number; recall: number; coverage: number };
        generated_at?: string;
      };
      const t = v.thresholds ?? { precision: 0.95, recall: 0.9, coverage: 0.85 };
      const ok = v.precision >= t.precision && v.recall >= t.recall && v.coverage >= t.coverage;
      const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
      checks.push({
        name: "graph quality (verify-index)",
        ok,
        detail: `precision ${pct(v.precision)}, recall ${pct(v.recall)}, coverage ${pct(v.coverage)}${v.generated_at ? ` (${v.generated_at})` : ""}`,
        hint: ok ? undefined : "re-run `gps verify-index` after `gps index`",
      });
    } catch {
      // ignore
    }
  }

  const claudeMd = path.join(root, "CLAUDE.md");
  const agentsMd = path.join(root, "AGENTS.md");
  const hasClaude = await exists(claudeMd);
  const hasAgents = await exists(agentsMd);
  const installed = hasClaude || hasAgents;
  checks.push({
    name: "agent install (CLAUDE.md / AGENTS.md)",
    ok: installed,
    detail: [hasClaude && "CLAUDE.md", hasAgents && "AGENTS.md"].filter(Boolean).join(", ") || "none",
    hint: installed ? undefined : "run `gps install claude` or `gps install codex`",
  });

  if (hasClaude) {
    try {
      const text = await readFile(claudeMd, "utf8");
      const wired = /gps\s+prepare|gps\s+context/.test(text);
      checks.push({
        name: "CLAUDE.md mentions gps",
        ok: wired,
        detail: wired ? "yes" : "no gps usage instructions found",
        hint: wired ? undefined : "re-run `gps install claude`",
      });
    } catch {
      // ignore
    }
  }

  return checks;
}

export function registerDoctor(program: Command): void {
  addRootOption(
    program
      .command("doctor")
      .description("Check that gps is installed, indexed, and wired into your agent")
      .option("--json", "Emit JSON"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    const checks = await runChecks(root);
    const failed = checks.filter((c) => !c.ok);

    if (opts.json) {
      console.log(
        JSON.stringify({ root, ok: failed.length === 0, checks }, null, 2),
      );
      process.exitCode = failed.length === 0 ? 0 : 1;
      return;
    }

    console.log(kleur.bold(`gps doctor`) + kleur.dim(`  ${root}`));
    console.log();
    for (const c of checks) {
      const mark = c.ok ? kleur.green("✓") : kleur.red("✗");
      console.log(`  ${mark} ${c.name.padEnd(40)} ${kleur.dim(c.detail)}`);
      if (!c.ok && c.hint) console.log(`     ${kleur.yellow("→")} ${c.hint}`);
    }
    console.log();
    if (failed.length === 0) {
      console.log(kleur.green("All checks passed."));
    } else {
      console.log(kleur.red(`${failed.length} check(s) failed.`));
      process.exitCode = 1;
    }
  });
}
