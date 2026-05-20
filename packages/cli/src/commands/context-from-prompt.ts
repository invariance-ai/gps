import type { Command } from "commander";
import {
  loadNotes,
  loadFileNotes,
  loadFeatureNotes,
  loadAreaNotes,
  loadInvariants,
  invariantsFor,
  readIndex,
  loadFeatures,
  matchFeaturesInPrompt,
  matchAliasesInPrompt,
  readGlobalLessonsBody,
} from "@invariance/gps-core";
import type { SymbolRef } from "@invariance/gps-schemas";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  text?: string;
  limit: number;
  minLen: number;
  json?: boolean;
}

const STOPWORDS = new Set([
  "TODO", "FIXME", "NOTE", "XXX", "HACK",
  "README", "CLAUDE", "PR", "MR", "API", "URL", "HTTP", "HTTPS",
  "JSON", "YAML", "TOML", "HTML", "CSS", "SQL",
]);

const FILEPATH_RE =
  /\b(?:[\w@.-]+\/)*[\w@.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|swift|md|yml|yaml|toml|json)\b/g;

function extractFilePaths(text: string, knownFiles: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(FILEPATH_RE)) {
    const tok = m[0];
    if (knownFiles.has(tok)) {
      out.add(tok);
      continue;
    }
    // Fallback: suffix-match against indexed files. Picks one shortest match.
    let best: string | undefined;
    for (const f of knownFiles) {
      if (f === tok || f.endsWith("/" + tok)) {
        if (!best || f.length < best.length) best = f;
      }
    }
    if (best) out.add(best);
  }
  return Array.from(out);
}

function extractCandidates(text: string): string[] {
  const out = new Set<string>();
  const add = (tok: string | undefined): void => {
    if (tok) out.add(tok);
  };
  // Backticked spans: `foo.bar` / `createRefund`
  for (const m of text.matchAll(/`([^`\n]{2,80})`/g)) {
    const inner = m[1];
    if (!inner) continue;
    for (const tok of inner.split(/[^A-Za-z0-9_.]+/)) add(tok);
  }
  // PascalCase: Foo, FooBar
  for (const m of text.matchAll(/\b([A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*)\b/g)) add(m[1]);
  // camelCase with at least one capital: fooBar, createRefund
  for (const m of text.matchAll(/\b([a-z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b/g)) add(m[1]);
  // Dotted/namespaced: stripe.refunds.create, foo.bar
  for (const m of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){1,4})\b/g)) add(m[1]);
  return Array.from(out).filter((t) => !STOPWORDS.has(t));
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function scoreMatch(candidate: string, sym: SymbolRef): number {
  const cand = candidate.toLowerCase();
  const name = sym.name.toLowerCase();
  const qual = sym.qualified_name?.toLowerCase();
  if (qual === cand) return 100;
  if (name === cand) return 95;
  if (qual && qual.endsWith("." + cand)) return 85;
  if (qual?.startsWith(cand)) return 70;
  if (name.startsWith(cand)) return 65;
  return 0;
}

export function registerContextFromPrompt(program: Command): void {
  addRootOption(
    program
      .command("context-from-prompt")
      .description("Extract symbols from prompt text and surface their context (used by UserPromptSubmit hooks)")
      .option("--text <text>", "Prompt text (otherwise read from stdin)")
      .option("--limit <n>", "Max symbols to surface", (v) => parseInt(v, 10), 3)
      .option("--min-len <n>", "Minimum candidate token length", (v) => parseInt(v, 10), 4)
      .option("--json", "Emit JSON instead of markdown"),
  ).action(async (opts: Opts) => {
    const root = resolveRoot(opts);
    const text = (opts.text ?? (await readStdin())).trim();
    if (!text) return;

    let index;
    try {
      index = await readIndex(root);
    } catch {
      // No index yet — silent. Hook must not fail.
      return;
    }

    // Symbol candidates may be empty (e.g. a plain-English prompt) — that's
    // fine, file/feature/alias pulls below can still surface context.
    const candidates = extractCandidates(text).filter((c) => c.length >= opts.minLen);

    const matches = new Map<string, { sym: SymbolRef; score: number }>();

    // Feature-alias matches: if the prompt mentions a known feature label or
    // alias, hydrate the top symbols of that feature with maximum score so
    // they're prioritised alongside explicit symbol mentions.
    try {
      const featuresFile = await loadFeatures(root);
      const hitLabels = matchFeaturesInPrompt(text, featuresFile.features);
      const symbolsById = new Map<string, SymbolRef>();
      for (const sym of index.symbols) if (sym.id) symbolsById.set(sym.id, sym);
      for (const label of hitLabels) {
        const feature = featuresFile.features[label];
        if (!feature) continue;
        for (const fs of feature.symbols.slice(0, opts.limit)) {
          const sym = symbolsById.get(fs.id);
          if (!sym) continue;
          const key = sym.qualified_name ?? sym.name;
          const score = 90 + Math.round(fs.weight * 10);
          const prev = matches.get(key);
          if (!prev || score > prev.score) matches.set(key, { sym, score });
        }
      }
    } catch {
      /* features unavailable — proceed with prompt-extracted candidates only */
    }

    for (const cand of candidates) {
      let best: { sym: SymbolRef; score: number } | null = null;
      for (const sym of index.symbols) {
        const score = scoreMatch(cand, sym);
        if (score >= 85 && (!best || score > best.score)) best = { sym, score };
      }
      if (best) {
        const key = best.sym.qualified_name ?? best.sym.name;
        const prev = matches.get(key);
        if (!prev || best.score > prev.score) matches.set(key, best);
      }
    }
    // File and feature pulls — separate from symbol matches. They produce
    // their own blocks below and are deduped against the CLAUDE.md global
    // lessons block so we never re-inject content the model already has.
    const filePaths = extractFilePaths(text, new Set(index.files)).slice(0, 3);
    const featureLabels: string[] = [];
    let aliasMap: Awaited<ReturnType<typeof loadFeatures>>["aliases"] = {};
    const aliasHits: string[] = [];
    try {
      const featuresFile = await loadFeatures(root);
      for (const label of matchFeaturesInPrompt(text, featuresFile.features)) {
        if (!featureLabels.includes(label)) featureLabels.push(label);
        if (featureLabels.length >= 2) break;
      }
      aliasMap = featuresFile.aliases ?? {};
      for (const name of matchAliasesInPrompt(text, aliasMap).slice(0, 2)) {
        aliasHits.push(name);
      }
    } catch {
      /* no features file */
    }

    const globalBody = await readGlobalLessonsBody(root).catch(() => "");
    const dedupSkip = (lesson: string): boolean => {
      if (!globalBody) return false;
      return globalBody.includes(lesson.toLowerCase().slice(0, 80));
    };

    if (
      matches.size === 0 &&
      filePaths.length === 0 &&
      featureLabels.length === 0 &&
      aliasHits.length === 0
    )
      return;

    const top = Array.from(matches.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit);

    const invariants = await loadInvariants(root);
    const blocks: Array<{
      symbol: string;
      file: string;
      line: number;
      invariants: ReturnType<typeof invariantsFor>;
      notes: Awaited<ReturnType<typeof loadNotes>>;
    }> = [];
    for (const { sym } of top) {
      const symName = sym.qualified_name ?? sym.name;
      const invs = invariantsFor(symName, invariants);
      const notes = (await loadNotes(root, symName).catch(() => [])).filter(
        (n) => !dedupSkip(n.lesson),
      );
      if (invs.length === 0 && notes.length === 0) continue;
      blocks.push({ symbol: symName, file: sym.file, line: sym.line, invariants: invs, notes });
    }

    const fileBlocks: Array<{ file: string; notes: Awaited<ReturnType<typeof loadFileNotes>> }> = [];
    for (const f of filePaths) {
      const notes = (await loadFileNotes(root, f).catch(() => [])).filter(
        (n) => !dedupSkip(n.lesson),
      );
      if (notes.length > 0) fileBlocks.push({ file: f, notes: notes.slice(0, 3) });
    }

    const featureBlocks: Array<{ label: string; notes: Awaited<ReturnType<typeof loadFeatureNotes>> }> = [];
    for (const l of featureLabels) {
      const notes = (await loadFeatureNotes(root, l).catch(() => [])).filter(
        (n) => !dedupSkip(n.lesson),
      );
      if (notes.length > 0) featureBlocks.push({ label: l, notes: notes.slice(0, 3) });
    }

    // Alias/area pull: a human name like "home" mentioned in the prompt
    // surfaces its area's directives — and, via the alias → feature link, the
    // linked feature's notes too, even when the feature label wasn't named.
    const aliasBlocks: Array<{
      alias: string;
      dir: string;
      notes: Awaited<ReturnType<typeof loadAreaNotes>>;
      feature?: string;
      featureNotes: Awaited<ReturnType<typeof loadFeatureNotes>>;
    }> = [];
    {
      const seenDirs = new Set<string>();
      for (const name of aliasHits) {
        const alias = aliasMap?.[name];
        if (!alias?.dir || seenDirs.has(alias.dir)) continue;
        seenDirs.add(alias.dir);
        const notes = (await loadAreaNotes(root, alias.dir).catch(() => [])).filter(
          (n) => !dedupSkip(n.lesson),
        );
        const featureNotes = alias.feature
          ? (await loadFeatureNotes(root, alias.feature).catch(() => [])).filter(
              (n) => !dedupSkip(n.lesson),
            )
          : [];
        if (notes.length === 0 && featureNotes.length === 0) continue;
        aliasBlocks.push({
          alias: name,
          dir: alias.dir,
          notes: notes.slice(0, 5),
          feature: alias.feature,
          featureNotes: featureNotes.slice(0, 3),
        });
      }
    }

    if (
      blocks.length === 0 &&
      fileBlocks.length === 0 &&
      featureBlocks.length === 0 &&
      aliasBlocks.length === 0
    )
      return;

    if (opts.json) {
      console.log(
        JSON.stringify(
          { matches: blocks, files: fileBlocks, features: featureBlocks, areas: aliasBlocks },
          null,
          2,
        ),
      );
      return;
    }

    const lines: string[] = [];
    lines.push("<!-- gps:auto-context -->");
    lines.push("## gps auto-loaded context");
    lines.push("");
    lines.push("Symbols mentioned in this prompt have prior context. Respect blocking invariants.");
    lines.push("");
    for (const b of blocks) {
      lines.push(`### ${b.symbol}  \`${b.file}:${b.line}\``);
      if (b.invariants.length > 0) {
        lines.push("");
        lines.push("**Invariants:**");
        for (const inv of b.invariants) {
          const sev = inv.severity ?? "info";
          lines.push(`- [${sev}] ${inv.name}: ${inv.rule}`);
        }
      }
      if (b.notes.length > 0) {
        lines.push("");
        lines.push("**Notes from prior edits:**");
        for (const n of b.notes.slice(0, 5)) {
          const sev = n.severity ?? "info";
          lines.push(`- [${sev}] ${n.lesson}`);
        }
      }
      lines.push("");
    }
    for (const fb of fileBlocks) {
      lines.push(`### file: \`${fb.file}\``);
      lines.push("");
      lines.push("**Notes from prior edits to this file:**");
      for (const n of fb.notes) {
        lines.push(`- [${n.severity ?? "info"}] ${n.lesson}`);
      }
      lines.push("");
    }
    for (const fb of featureBlocks) {
      lines.push(`### feature: \`${fb.label}\``);
      lines.push("");
      lines.push("**Notes from prior work in this feature:**");
      for (const n of fb.notes) {
        lines.push(`- [${n.severity ?? "info"}] ${n.lesson}`);
      }
      lines.push("");
    }
    for (const ab of aliasBlocks) {
      lines.push(`### area: \`${ab.dir}\` (alias: ${ab.alias})`);
      if (ab.notes.length > 0) {
        lines.push("");
        lines.push("**Directives for this location:**");
        for (const n of ab.notes) {
          lines.push(`- [${n.severity ?? "info"}] ${n.lesson}`);
        }
      }
      if (ab.feature && ab.featureNotes.length > 0) {
        lines.push("");
        lines.push(`**Linked feature \`${ab.feature}\`:**`);
        for (const n of ab.featureNotes) {
          lines.push(`- [${n.severity ?? "info"}] ${n.lesson}`);
        }
      }
      lines.push("");
    }
    lines.push("<!-- /gps:auto-context -->");
    console.log(lines.join("\n"));
  });
}
