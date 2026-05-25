import type { Command } from "commander";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import kleur from "kleur";
import { stringify as stringifyYaml } from "yaml";
import {
  appendDecision,
  appendQuestion,
  appendNote,
  addPreference,
  extractPreferences,
  extractDirectives,
  recordDirective,
  resolveActiveArea,
  redact,
} from "@invariance/gps-core";
import { GpsLlm, extractDecisions } from "@invariance/gps-llm";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

/**
 * `gps attach --transcript <path>` — distill a conversation transcript into
 * structured Decision records anchored to symbols. The transcript is read
 * once; only the distilled records are persisted. Raw text never lands on
 * disk under .gps/.
 *
 * `gps attach --hook-stdin` — the Claude Code Stop-hook entrypoint. Reads the
 * hook's JSON payload from stdin, resolves `transcript_path`, distills the
 * conversation, and auto-persists Decisions/Questions. When no API key is
 * configured it degrades to writing the native-agent prompt under
 * `.gps/pending-distill/` so the loop is never silently dropped. Always exits
 * 0 — a Stop hook must never fail the session.
 *
 * Native --session <id> integration (Claude Code / Codex session IDs) lands
 * once those formats stabilize; for now use --transcript with a dumped file.
 */

interface Opts extends RootOption {
  transcript?: string;
  hookStdin?: boolean;
  session?: string;
  symbol?: string[];
  dryRun?: boolean;
  callApi?: boolean;
  saveWithoutConfirm?: boolean;
  apiKey?: string;
  model?: string;
  json?: boolean;
  capturePrefs?: boolean;
}

/** Read all of stdin (used for the Claude Code Stop-hook JSON payload). */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Flatten a Claude Code transcript (JSONL of message objects) into a clean
 * role-tagged plaintext transcript for distillation. Tool calls/results are
 * dropped — decisions live in the prose. Keeps the most recent `maxChars`.
 * Falls back to the raw text if the file isn't recognizable JSONL.
 */
export function claudeTranscriptToText(raw: string, maxChars = 60000): string {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj: { message?: { role?: string; content?: unknown } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = obj?.message;
    if (!msg?.role) continue;
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter(
          (b): b is { type: string; text: string } =>
            !!b && typeof b === "object" && (b as { type?: string }).type === "text" &&
            typeof (b as { text?: unknown }).text === "string",
        )
        .map((b) => b.text)
        .join("\n");
    }
    text = text.trim();
    if (text) out.push(`${msg.role}: ${text}`);
  }
  const joined = out.join("\n\n");
  const text = joined || raw;
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

/**
 * Extract only the user-turn bodies from a role-tagged transcript.
 * Lines prefixed "user: " are included (prefix stripped); all other lines dropped.
 * Used so preference extraction can't be influenced by assistant prose.
 */
export function userTurnsFromTranscript(text: string): string {
  const lines: string[] = [];
  for (const para of text.split(/\n\n+/)) {
    const trimmed = para.trim();
    if (trimmed.startsWith("user: ")) {
      lines.push(trimmed.slice("user: ".length));
    }
  }
  return lines.join("\n\n");
}

/**
 * Capture preferences and directives from user turns of the transcript.
 * Always silent, never throws, exits cleanly.
 */
async function capturePrefsFromText(root: string, transcriptText: string): Promise<void> {
  try {
    const userText = userTurnsFromTranscript(transcriptText);
    if (!userText.trim()) return;

    // Extract and store preferences from user turns only.
    const extracted = extractPreferences(userText);
    for (const e of extracted) {
      try {
        await addPreference(root, {
          text: redact(e.text).text,
          source: "auto",
          evidence: `cue:${e.cue}`,
        });
      } catch {
        /* best-effort */
      }
    }

    // Extract directives from user turns (resolve active area once).
    const area = await resolveActiveArea(root).catch(() => undefined);
    if (area) {
      const directives = extractDirectives(userText);
      for (const d of directives) {
        try {
          await recordDirective(root, {
            directive: redact(d.text).text,
            polarity: d.polarity,
            area,
          });
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    /* never throw from capture path */
  }
}

export function registerAttach(program: Command): void {
  addRootOption(
    program
      .command("attach")
      .description(
        "Distill a conversation transcript into Decision records anchored to symbols",
      )
      .option("--transcript <path>", "Path to the conversation transcript file (use - for stdin)")
      .option(
        "--hook-stdin",
        "Claude Code Stop-hook mode: read the hook JSON from stdin, resolve transcript_path, and auto-persist (never fails)",
      )
      .option(
        "--session <id>",
        "Logical session/PR/conversation ID to tag decisions with",
        "transcript",
      )
      .option(
        "--symbol <name>",
        "Constrain extraction to these symbols; repeatable",
        (v, prev: string[] = []) => prev.concat(v),
        [],
      )
      .option("--dry-run", "Render the prompt for a native agent (default)")
      .option("--call-api", "Call the bundled Anthropic client instead of printing a prompt")
      .option(
        "--save-without-confirm",
        "Write extracted decisions to .gps/decisions/ without interactive prompt",
      )
      .option("--api-key <key>", "Anthropic API key (default: ANTHROPIC_API_KEY env)")
      .option("--model <id>", "Anthropic model ID (default: claude-opus-4-7)")
      .option("--json", "Emit JSON")
      .option(
        "--capture-prefs",
        "Also extract preferences and directives from user turns of the transcript",
      ),
  ).action(async (opts: Opts) => {
    if (opts.hookStdin) {
      await runHookStdin(opts);
      return;
    }
    const root = resolveRoot(opts);
    try {
      if (!opts.transcript) {
        throw new Error("--transcript <path> required (--session-id integration is v0.5)");
      }

      // Fix: when transcript is "-", read from stdin instead of readFile("-")
      let rawTranscript: string;
      if (opts.transcript === "-") {
        rawTranscript = await readStdin();
      } else {
        rawTranscript = await readFile(opts.transcript, "utf8");
      }

      const transcript = claudeTranscriptToText(rawTranscript);

      // Capture preferences from user turns if requested.
      if (opts.capturePrefs) {
        await capturePrefsFromText(root, transcript);
      }

      const llm = new GpsLlm({
        apiKey: opts.apiKey,
        model: opts.model,
        dryRun: !opts.callApi || !!opts.dryRun,
      });
      const result = await extractDecisions(llm, {
        transcript,
        symbols_in_scope: opts.symbol && opts.symbol.length > 0 ? opts.symbol : undefined,
        session_id: opts.session ?? "transcript",
      });

      if (!opts.callApi || opts.dryRun) {
        console.log(kleur.bold("Prompt for native Claude/Codex:"));
        console.log("");
        console.log(kleur.dim("--- system ---"));
        console.log(result.dry_run_prompt!.system);
        console.log(kleur.dim("--- user ---"));
        console.log(result.dry_run_prompt!.user);
        console.log("");
        console.log(kleur.dim("Have the native agent return YAML, then persist decisions with `gps decide`."));
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (
        result.decisions.length === 0 &&
        result.questions.length === 0 &&
        result.auto_lessons.length === 0 &&
        result.user_corrections.length === 0
      ) {
        console.log(kleur.dim("no decisions, questions, or lessons extracted from this transcript"));
        return;
      }

      if (result.decisions.length > 0) {
        console.log(kleur.bold(`${result.decisions.length} decision(s) extracted:`));
        console.log("");
        console.log("```yaml");
        console.log(stringifyYaml(result.decisions).trimEnd());
        console.log("```");
        console.log("");
      }
      if (result.questions.length > 0) {
        console.log(kleur.bold(`${result.questions.length} open question(s) extracted:`));
        console.log("");
        console.log("```yaml");
        console.log(stringifyYaml(result.questions).trimEnd());
        console.log("```");
        console.log("");
      }
      if (result.auto_lessons.length > 0) {
        console.log(kleur.bold(`${result.auto_lessons.length} auto-lesson(s) extracted:`));
        console.log("");
        console.log("```yaml");
        console.log(stringifyYaml(result.auto_lessons).trimEnd());
        console.log("```");
        console.log("");
      }
      if (result.user_corrections.length > 0) {
        console.log(kleur.bold(`${result.user_corrections.length} user-correction(s) extracted:`));
        console.log("");
        console.log("```yaml");
        console.log(stringifyYaml(result.user_corrections).trimEnd());
        console.log("```");
        console.log("");
      }

      if (opts.saveWithoutConfirm) {
        for (const d of result.decisions) {
          await appendDecision(root, d);
        }
        for (const q of result.questions) {
          await appendQuestion(root, {
            symbol: q.symbol,
            question: q.question,
            asked_by: q.asked_by,
            session: q.session,
          });
        }
        for (const l of result.auto_lessons) {
          await appendNote(root, {
            symbol: l.symbol,
            lesson: redact(l.lesson).text,
            source: "auto-lesson",
            evidence: l.evidence ? redact(l.evidence).text : undefined,
          });
        }
        for (const c of result.user_corrections) {
          await appendNote(root, {
            symbol: c.symbol,
            lesson: redact(c.lesson).text,
            source: "user-correction",
            evidence: c.evidence ? redact(c.evidence).text : undefined,
          });
        }
        console.log(
          kleur.green(
            `wrote ${result.decisions.length} decision(s), ${result.questions.length} question(s), ` +
            `${result.auto_lessons.length} auto-lesson(s), ${result.user_corrections.length} user-correction(s) to .gps/`,
          ),
        );
      } else {
        console.log(
          kleur.dim(
            "Run again with --save-without-confirm to persist to .gps/, or copy YAML manually.",
          ),
        );
      }
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}

/**
 * Stop-hook entrypoint. Reads Claude Code's hook JSON from stdin, distills the
 * referenced transcript, and persists Decisions/Questions/auto-lessons/user-corrections.
 * Swallows every error and exits 0 — a Stop hook must never break the session.
 */
async function runHookStdin(opts: Opts): Promise<void> {
  try {
    const payloadRaw = await readStdin();
    if (!payloadRaw.trim()) return;
    let payload: { transcript_path?: string; session_id?: string; cwd?: string };
    try {
      payload = JSON.parse(payloadRaw);
    } catch {
      return; // not a hook JSON payload — nothing to do
    }
    const transcriptPath = payload.transcript_path;
    if (!transcriptPath) return;

    const root = path.resolve(opts.root ?? payload.cwd ?? process.cwd());
    const sessionId = payload.session_id ?? opts.session ?? "session";

    let raw: string;
    try {
      raw = await readFile(transcriptPath, "utf8");
    } catch {
      return; // transcript gone or unreadable — silent no-op
    }
    const transcript = claudeTranscriptToText(raw);
    if (!transcript.trim()) return;

    const haveApiKey = !!(opts.apiKey ?? process.env.ANTHROPIC_API_KEY);

    // Degraded mode: no key configured. Stash the native-agent prompt so the
    // loop is recorded rather than dropped — the next session can process it.
    if (!opts.callApi && !haveApiKey) {
      const dryLlm = new GpsLlm({ model: opts.model, dryRun: true });
      const dry = await extractDecisions(dryLlm, {
        transcript,
        symbols_in_scope: opts.symbol?.length ? opts.symbol : undefined,
        session_id: sessionId,
      });
      const prompt = dry.dry_run_prompt;
      if (!prompt) return;
      const dir = path.join(root, ".gps", "pending-distill");
      await mkdir(dir, { recursive: true });
      const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
      const file = path.join(dir, `${safe}.md`);
      await writeFile(
        file,
        `<!-- gps:pending-distill session=${sessionId} -->\n` +
          `Set ANTHROPIC_API_KEY (or rerun \`gps attach --transcript <file> --call-api --save-without-confirm\`)\n` +
          `to auto-persist. Or answer the prompt below and run \`gps decide\`.\n\n` +
          `## system\n\n${prompt.system}\n\n## user\n\n${prompt.user}\n`,
      );
      return;
    }

    const llm = new GpsLlm({ apiKey: opts.apiKey, model: opts.model, dryRun: false });
    const result = await extractDecisions(llm, {
      transcript,
      symbols_in_scope: opts.symbol?.length ? opts.symbol : undefined,
      session_id: sessionId,
    });
    for (const d of result.decisions) {
      await appendDecision(root, d);
    }
    for (const q of result.questions) {
      await appendQuestion(root, {
        symbol: q.symbol,
        question: q.question,
        asked_by: q.asked_by,
        session: q.session,
      });
    }
    for (const l of result.auto_lessons) {
      try {
        await appendNote(root, {
          symbol: l.symbol,
          lesson: redact(l.lesson).text,
          source: "auto-lesson",
          evidence: l.evidence ? redact(l.evidence).text : undefined,
        });
      } catch {
        /* best-effort */
      }
    }
    for (const c of result.user_corrections) {
      try {
        await appendNote(root, {
          symbol: c.symbol,
          lesson: redact(c.lesson).text,
          source: "user-correction",
          evidence: c.evidence ? redact(c.evidence).text : undefined,
        });
      } catch {
        /* best-effort */
      }
    }
    if (
      result.decisions.length ||
      result.questions.length ||
      result.auto_lessons.length ||
      result.user_corrections.length
    ) {
      // stderr keeps it visible in the transcript without altering the result.
      console.error(
        kleur.dim(
          `gps: distilled ${result.decisions.length} decision(s), ${result.questions.length} question(s), ` +
          `${result.auto_lessons.length} auto-lesson(s), ${result.user_corrections.length} user-correction(s) from this session`,
        ),
      );
    }
  } catch {
    // Never fail the Stop hook.
  }
}
