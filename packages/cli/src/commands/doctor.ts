import type { Command } from "commander";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import kleur from "kleur";
import {
  indexPath,
  readIndex,
  staleFiles,
  loadInbox,
  loadInvariants,
  loadPreferences,
  loadAllNotes,
  loadAllFileNotes,
  loadAllFeatureNotes,
  loadAllAreaNotes,
  loadAllDecisions,
  findStale,
  loadConfig,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  json?: boolean;
}

export interface Check {
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

async function readText(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

function mentionsGps(text: string | null): boolean {
  return !!text && /gps\s+(prepare|context|brief|serve)|mcp__gps__prepare_edit|prepare_edit/.test(text);
}

export async function runChecks(root: string): Promise<Check[]> {
  const checks: Check[] = [];

  const gpsDir = path.join(root, ".gps");
  const hasGpsDir = await exists(gpsDir);
  checks.push({
    name: ".gps/ directory",
    ok: hasGpsDir,
    detail: hasGpsDir ? gpsDir : "missing",
    hint: hasGpsDir ? undefined : "run `gps setup --yes --with-claude` (or --with-codex)",
  });

  const cfg = path.join(root, ".gps/config.yml");
  const hasCfg = await exists(cfg);
  checks.push({
    name: "config (.gps/config.yml)",
    ok: hasCfg,
    detail: hasCfg ? "present" : "missing",
    hint: hasCfg ? undefined : "run `gps setup --yes --with-claude` (or --with-codex)",
  });

  const inv = path.join(root, ".gps/invariants.yml");
  const hasInv = await exists(inv);
  checks.push({
    name: "invariants (.gps/invariants.yml)",
    ok: hasInv,
    detail: hasInv ? "present" : "missing",
    hint: hasInv ? undefined : "run `gps setup --yes --with-claude` (or --with-codex)",
  });

  try {
    const cfg = await loadConfig(root);
    const risky = cfg.promote === "all";
    checks.push({
      name: "capture policy",
      ok: !risky,
      detail: `capture=${cfg.capture}, promote=${cfg.promote}, auto_suggest=${cfg.auto_suggest}`,
      hint: risky ? "use `gps install <agent> --promote=safe` unless you intentionally bypass review gates" : undefined,
    });
    checks.push({
      name: "experimental features",
      ok: true,
      detail: `live_docs=${cfg.experimental.live_docs}`,
      hint: cfg.experimental.live_docs
        ? "live docs are experimental; keep them local/private for launch usage"
        : "enable live docs per run with `gps doc --experimental-live-docs --serve`",
    });
  } catch (err) {
    checks.push({
      name: "capture policy",
      ok: false,
      detail: `unreadable: ${(err as Error).message}`,
      hint: "run `gps install <agent>` to rewrite policy fields",
    });
  }

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
  const claudeSkill = path.join(root, ".claude/skills/gps/SKILL.md");
  const claudeSettings = path.join(root, ".claude/settings.json");
  const mcpJson = path.join(root, ".mcp.json");
  const codexConfig = path.join(root, ".codex/config.toml");
  const cursorRule = path.join(root, ".cursor/rules/gps.mdc");
  const cursorMcp = path.join(root, ".cursor/mcp.json");
  const hasClaude = await exists(claudeMd);
  const hasAgents = await exists(agentsMd);
  const hasClaudeSkill = await exists(claudeSkill);
  const hasClaudeSettings = await exists(claudeSettings);
  const hasMcpJson = await exists(mcpJson);
  const hasCodexConfig = await exists(codexConfig);
  const hasCursorRule = await exists(cursorRule);
  const hasCursorMcp = await exists(cursorMcp);
  const installed = hasClaude || hasAgents || hasCursorRule;
  checks.push({
    name: "agent install",
    ok: installed,
    detail:
      [hasClaude && "Claude", hasAgents && "Codex", hasCursorRule && "Cursor"]
        .filter(Boolean)
        .join(", ") || "none",
    hint: installed ? undefined : "run `gps setup --yes --with-claude` (or --with-codex / --with-cursor)",
  });

  if (hasClaude) {
    const claudeText = await readText(claudeMd);
    const skillText = await readText(claudeSkill);
    const settingsText = await readText(claudeSettings);
    const mcpText = await readText(mcpJson);
    const wired =
      mentionsGps(claudeText) &&
      mentionsGps(skillText) &&
      !!settingsText &&
      /SessionStart|UserPromptSubmit|PreToolUse|PostToolUse|Stop/.test(settingsText) &&
      !!mcpText &&
      /"gps"/.test(mcpText);
    checks.push({
      name: "Claude wiring",
      ok: wired,
      detail: [
        mentionsGps(claudeText) && "CLAUDE.md",
        mentionsGps(skillText) && "skill",
        hasClaudeSettings && "hooks",
        hasMcpJson && "MCP",
      ].filter(Boolean).join(", ") || "incomplete",
      hint: wired ? undefined : "run `gps setup --yes --with-claude`",
    });
  }

  if (hasAgents || hasCodexConfig) {
    const agentsText = await readText(agentsMd);
    const codexText = await readText(codexConfig);
    const wired =
      mentionsGps(agentsText) &&
      !!codexText &&
      /notify\s*=/.test(codexText) &&
      /\[mcp_servers\.gps\]/.test(codexText);
    checks.push({
      name: "Codex wiring",
      ok: wired,
      detail: [
        mentionsGps(agentsText) && "AGENTS.md",
        codexText && /notify\s*=/.test(codexText) && "notify",
        codexText && /\[mcp_servers\.gps\]/.test(codexText) && "MCP",
      ].filter(Boolean).join(", ") || "incomplete",
      hint: wired ? undefined : "run `gps setup --yes --with-codex`",
    });
  }

  if (hasCursorRule || hasCursorMcp) {
    const ruleText = await readText(cursorRule);
    const mcpText = await readText(cursorMcp);
    const wired = mentionsGps(ruleText) && !!mcpText && /"gps"/.test(mcpText);
    checks.push({
      name: "Cursor wiring",
      ok: wired,
      detail: [mentionsGps(ruleText) && "rule", hasCursorMcp && "MCP"].filter(Boolean).join(", ") || "incomplete",
      hint: wired ? undefined : "run `gps setup --yes --with-cursor`",
    });
  }

  const gitignore = await readText(path.join(root, ".gitignore"));
  const ignoresIndex = !!gitignore && (/^\.gps\/index\//m.test(gitignore) || /^\.gps\/index\.json$/m.test(gitignore));
  const ignoresObservations = !!gitignore && /^\.gps\/observations\.json$/m.test(gitignore);
  checks.push({
    name: "local artifact ignores",
    ok: ignoresIndex && ignoresObservations,
    detail: [
      ignoresIndex ? ".gps/index" : "missing .gps/index",
      ignoresObservations ? ".gps/observations.json" : "missing .gps/observations.json",
    ].join(", "),
    hint: ignoresIndex && ignoresObservations ? undefined : "add `.gps/index/` and `.gps/observations.json` to .gitignore",
  });

  // Informational checks below — they report counts, never fail the run.

  // Inbox: how much captured memory is waiting for human review.
  const inbox = await loadInbox(root);
  const pending = inbox.filter((i) => i.status === "pending");
  const riskyPending = pending.filter((i) => i.risk_topics.length > 0);
  checks.push({
    name: "inbox (pending review)",
    ok: true,
    detail:
      pending.length === 0
        ? "empty"
        : `${pending.length} pending${riskyPending.length ? `, ${riskyPending.length} touch risk topics` : ""}`,
    hint: pending.length > 0 ? "run `gps inbox list`, then `gps inbox approve <id>`" : undefined,
  });

  // Active memory: how much durable knowledge is in play.
  const [allNotes, fileN, featN, areaN, invs, decisions, prefs] = await Promise.all([
    loadAllNotes(root),
    loadAllFileNotes(root),
    loadAllFeatureNotes(root),
    loadAllAreaNotes(root),
    loadInvariants(root),
    loadAllDecisions(root),
    loadPreferences(root),
  ]);
  const noteCount =
    allNotes.length +
    fileN.reduce((s, e) => s + e.notes.length, 0) +
    featN.reduce((s, e) => s + e.notes.length, 0) +
    areaN.reduce((s, e) => s + e.notes.length, 0);
  checks.push({
    name: "active memory",
    ok: true,
    detail: `${noteCount} notes, ${invs.length} invariants, ${decisions.length} decisions, ${prefs.length} preferences`,
  });

  // Stale memory: knowledge older than 90d whose code moved since (best-effort —
  // findStale reads the index + git, so guard against repos without either).
  let staleDetail = "n/a";
  let staleCount = 0;
  try {
    const stale = await findStale(root, { days: 90 });
    staleCount = stale.length;
    staleDetail = staleCount === 0 ? "none >90d on changed code" : `${staleCount} entries >90d on changed code`;
  } catch {
    // informational only — leave as n/a
  }
  checks.push({
    name: "stale memory",
    ok: true,
    detail: staleDetail,
    hint: staleCount > 0 ? "run `gps stale` to review, `gps prune` to clean up" : undefined,
  });

  return checks;
}

function nextAction(checks: Check[]): string {
  const firstFailed = checks.find((c) => !c.ok);
  if (firstFailed?.hint) return firstFailed.hint;
  const index = checks.find((c) => c.name === "symbol index");
  if (index?.ok) return 'run `gps prepare <symbol> --intent "what you are changing"` before a non-trivial edit';
  return "run `gps index`";
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
      console.log(JSON.stringify({ root, ok: failed.length === 0, checks, next_action: nextAction(checks) }, null, 2));
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
    console.log(kleur.bold("Next: ") + nextAction(checks));
  });
}
