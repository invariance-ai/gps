import type { Command } from "commander";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import kleur from "kleur";
import { parse as parseYaml } from "yaml";
import {
  readIndex,
  verifyIndex,
  verifyIndexPython,
  type VerifyReport,
  type PyVerifyReport,
} from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  sample?: string;
  seed?: string;
  lang?: string;
  json?: boolean;
  noCache?: boolean;
}

interface Thresholds {
  precision: number;
  recall: number;
  coverage: number;
}

const DEFAULTS: Thresholds = { precision: 0.95, recall: 0.9, coverage: 0.85 };

async function loadThresholds(root: string): Promise<Thresholds> {
  try {
    const raw = await readFile(path.join(root, ".gps/config.yml"), "utf8");
    const data = parseYaml(raw) ?? {};
    const t = data?.quality?.thresholds ?? {};
    return {
      precision: t.precision ?? DEFAULTS.precision,
      recall: t.recall ?? DEFAULTS.recall,
      coverage: t.coverage ?? DEFAULTS.coverage,
    };
  } catch {
    return DEFAULTS;
  }
}

export function registerVerifyIndex(program: Command): void {
  addRootOption(
    program
      .command("verify-index")
      .description("Score GPS's symbol graph against a type checker (precision/recall/coverage)")
      .option("--sample <n>", "Sampled edges & callsites (default 200)")
      .option("--seed <n>", "Deterministic sampling seed (also honored via GPS_VERIFY_SEED)")
      .option("--lang <lang>", "Language: typescript | python | auto (default auto)")
      .option("--no-cache", "Don't write the cached report")
      .option("--json", "Emit JSON instead of text"),
  ).action(async (opts: Opts) => {
    try {
      const root = resolveRoot(opts);
      const sample = opts.sample ? Number(opts.sample) : undefined;
      if (sample !== undefined && (!Number.isInteger(sample) || sample <= 0)) {
        throw new Error("--sample must be a positive integer");
      }
      const seed = opts.seed !== undefined ? Number(opts.seed) : undefined;
      if (seed !== undefined && !Number.isFinite(seed)) {
        throw new Error("--seed must be a finite number");
      }
      const lang = (opts.lang ?? "auto").toLowerCase();
      if (!["auto", "typescript", "ts", "python", "py"].includes(lang)) {
        throw new Error("--lang must be one of: auto, typescript, python");
      }
      const index = await readIndex(root);
      const thresholds = await loadThresholds(root);

      // Auto: pick python if there are more .py files than TS files in the index.
      const pyFileCount = index.files.filter((f) => f.endsWith(".py")).length;
      const tsFileCount = index.files.filter(
        (f) => f.endsWith(".ts") || f.endsWith(".tsx") || f.endsWith(".js") || f.endsWith(".jsx"),
      ).length;
      const useLang =
        lang === "python" || lang === "py"
          ? "python"
          : lang === "typescript" || lang === "ts"
          ? "typescript"
          : pyFileCount > tsFileCount
          ? "python"
          : "typescript";

      const report: VerifyReport | PyVerifyReport =
        useLang === "python"
          ? await verifyIndexPython(index, { root, sample, seed })
          : await verifyIndex(index, { root, sample, seed });

      if (!opts.noCache) {
        const cacheDir = path.join(root, ".gps/cache");
        await mkdir(cacheDir, { recursive: true });
        await writeFile(
          path.join(cacheDir, "verify-index.json"),
          JSON.stringify({ ...report, generated_at: new Date().toISOString(), thresholds }, null, 2),
        );
      }

      if (opts.json) {
        console.log(JSON.stringify({ ...report, thresholds }, null, 2));
      } else {
        renderReport(report, thresholds);
      }

      const passes =
        report.precision >= thresholds.precision &&
        report.recall >= thresholds.recall &&
        report.coverage >= thresholds.coverage;
      process.exitCode = passes ? 0 : 1;
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}

function renderReport(r: VerifyReport | PyVerifyReport, t: Thresholds): void {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const ci = (lo: number, hi: number): string => `[${pct(lo)}–${pct(hi)}]`;
  const badge = (ok: boolean): string => (ok ? kleur.green("✓") : kleur.red("✗"));
  if ("skipped_reason" in r && r.skipped_reason) {
    console.log(kleur.yellow(`verify-index skipped (${r.language}): ${r.skipped_reason}`));
    return;
  }
  console.log(kleur.bold(`graph quality [${r.language}]`) + kleur.dim(`  (sample=${r.sample_size}/${r.total_edges} edges)`));
  console.log(
    `  ${badge(r.precision >= t.precision)} precision  ${pct(r.precision)}  ${kleur.dim(`95% CI ${ci(r.precision_ci.low, r.precision_ci.high)}  (≥${pct(t.precision)})`)}`,
  );
  console.log(
    `      ${kleur.dim(`confirmed=${r.precision_confirmed}  contradicted=${r.precision_contradicted}  inconclusive=${r.precision_inconclusive}`)}`,
  );
  console.log(
    `  ${badge(r.recall    >= t.recall)}    recall     ${pct(r.recall)}     ${kleur.dim(`95% CI ${ci(r.recall_ci.low, r.recall_ci.high)}  (≥${pct(t.recall)})`)}`,
  );
  console.log(
    `      ${kleur.dim(`hit=${r.recall_hit}/${r.recall_seen}`)}`,
  );
  console.log(`  ${badge(r.coverage  >= t.coverage)}  coverage   ${pct(r.coverage)}   ${kleur.dim(`(≥${pct(t.coverage)})`)}`);
  if (r.worst.length > 0) {
    console.log("\n" + kleur.bold("worst offenders"));
    for (const w of r.worst) {
      console.log(`  ${kleur.dim(w.from_file + ":" + w.from_line)}  ${w.callee}  ${kleur.yellow(w.issue)}`);
      if (w.gps_resolved_to) console.log(`    gps → ${kleur.dim(w.gps_resolved_to)}`);
      const tw = w as { ts_resolved_to?: string; pyright_resolved_to?: string };
      if (tw.ts_resolved_to) console.log(`    ts  → ${kleur.dim(tw.ts_resolved_to)}`);
      if (tw.pyright_resolved_to) console.log(`    py  → ${kleur.dim(tw.pyright_resolved_to)}`);
    }
  }
}
