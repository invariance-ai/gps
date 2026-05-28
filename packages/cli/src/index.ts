#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { registerContext } from "./commands/context.js";
import { registerImpact } from "./commands/impact.js";
import { registerTests } from "./commands/tests.js";
import { registerInvariants } from "./commands/invariants.js";
import { registerInvariant } from "./commands/invariant.js";
import { registerInit } from "./commands/init.js";
import { registerIndex } from "./commands/index.js";
import { registerFind } from "./commands/find.js";
import { registerRecall } from "./commands/recall.js";
import { registerPrime } from "./commands/prime.js";
import { registerTrace } from "./commands/trace.js";
import { registerServe } from "./commands/serve.js";
import { registerBench } from "./commands/bench.js";
import { registerInstall } from "./commands/install.js";
import { registerPrepare } from "./commands/prepare.js";
import { registerLearn } from "./commands/learn.js";
import { registerNotes } from "./commands/notes.js";
import { registerLearnTodos } from "./commands/learn-todos.js";
import { registerDecide } from "./commands/decide.js";
import { registerDecisions } from "./commands/decisions.js";
import { registerSuggest } from "./commands/suggest.js";
import { registerPostmortem } from "./commands/postmortem.js";
import { registerPromote } from "./commands/promote.js";
import { registerAttach } from "./commands/attach.js";
import { registerPrIntent } from "./commands/pr-intent.js";
import { registerContextFromPrompt } from "./commands/context-from-prompt.js";
import { registerRecordFailure } from "./commands/record-failure.js";
import { registerWizard } from "./commands/wizard.js";
import { registerPrefer } from "./commands/prefer.js";
import { registerPreferences } from "./commands/preferences.js";
import { registerCapturePreference } from "./commands/capture-preference.js";
import { registerInbox } from "./commands/inbox.js";
import { registerCaptureDirective } from "./commands/capture-directive.js";
import { registerContextFromPath } from "./commands/context-from-path.js";
import { registerDirective } from "./commands/directive.js";
import { registerFeature } from "./commands/feature.js";
import { registerValidate } from "./commands/validate.js";
import { registerAsk } from "./commands/ask.js";
import { registerQuestions } from "./commands/questions.js";
import { registerSession } from "./commands/session.js";
import { registerWhy } from "./commands/why.js";
import { registerStale } from "./commands/stale.js";
import { registerContributors } from "./commands/contributors.js";
import { registerConflicts } from "./commands/conflicts.js";
import { registerAssume } from "./commands/assume.js";
import { registerHealth } from "./commands/health.js";
import { registerLessons } from "./commands/lessons.js";
import { registerGate } from "./commands/gate.js";
import { registerWaive } from "./commands/waive.js";
import { registerPlan } from "./commands/plan.js";
import { registerTestRecord } from "./commands/test-record.js";
import { registerRuntime } from "./commands/runtime.js";
import { registerAudit } from "./commands/audit.js";
import { registerReviewMemory } from "./commands/review-memory.js";
import { registerVerifyContract } from "./commands/verify-contract.js";
import { registerCheckProposal } from "./commands/check-proposal.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerVerifyIndex } from "./commands/verify-index.js";
import { registerReviewDiff } from "./commands/review-diff.js";
import { registerBrief } from "./commands/brief.js";
import { registerDoc } from "./commands/doc.js";
import { registerValidateKnowledge } from "./commands/validate-knowledge.js";
import { registerPulse } from "./commands/pulse.js";
import { registerSeed } from "./commands/seed.js";
import { registerVerify } from "./commands/verify.js";
import { registerSync } from "./commands/sync.js";
import { registerPrune } from "./commands/prune.js";
import { registerResume } from "./commands/resume.js";
import { registerRemember } from "./commands/remember.js";
import { registerPacket } from "./commands/packet.js";
import { registerDone } from "./commands/done.js";

type CommandRegistrar = (program: Command) => void;

interface CommandRegistration {
  name: string;
  register: CommandRegistrar;
  primary?: boolean;
}

const COMMANDS: CommandRegistration[] = [
  { name: "init", register: registerInit, primary: true },
  { name: "setup", register: registerWizard, primary: true },
  { name: "install", register: registerInstall, primary: true },
  { name: "prefer", register: registerPrefer },
  { name: "preferences", register: registerPreferences },
  { name: "capture-preference", register: registerCapturePreference },
  { name: "capture-directive", register: registerCaptureDirective },
  { name: "inbox", register: registerInbox },
  { name: "context-from-path", register: registerContextFromPath },
  { name: "directive", register: registerDirective },
  { name: "feature", register: registerFeature },
  { name: "index", register: registerIndex },
  { name: "prepare", register: registerPrepare, primary: true },
  { name: "context", register: registerContext },
  { name: "learn", register: registerLearn },
  { name: "remember", register: registerRemember, primary: true },
  { name: "notes", register: registerNotes },
  { name: "learn-todos", register: registerLearnTodos },
  { name: "decide", register: registerDecide },
  { name: "decisions", register: registerDecisions },
  { name: "suggest", register: registerSuggest },
  { name: "postmortem", register: registerPostmortem },
  { name: "promote", register: registerPromote },
  { name: "attach", register: registerAttach },
  { name: "pr-intent", register: registerPrIntent },
  { name: "impact", register: registerImpact },
  { name: "tests", register: registerTests },
  { name: "invariants", register: registerInvariants },
  { name: "invariant", register: registerInvariant },
  { name: "find", register: registerFind, primary: true },
  { name: "recall", register: registerRecall, primary: true },
  { name: "prime", register: registerPrime, primary: true },
  { name: "trace", register: registerTrace, primary: true },
  { name: "serve", register: registerServe, primary: true },
  { name: "bench", register: registerBench },
  { name: "context-from-prompt", register: registerContextFromPrompt },
  { name: "record-failure", register: registerRecordFailure },
  { name: "validate", register: registerValidate },
  { name: "ask", register: registerAsk },
  { name: "questions", register: registerQuestions },
  { name: "session", register: registerSession },
  { name: "why", register: registerWhy },
  { name: "stale", register: registerStale },
  { name: "contributors", register: registerContributors },
  { name: "conflicts", register: registerConflicts },
  { name: "assume", register: registerAssume },
  { name: "health", register: registerHealth },
  { name: "lessons", register: registerLessons },
  { name: "gate", register: registerGate },
  { name: "waive", register: registerWaive },
  { name: "plan", register: registerPlan },
  { name: "test-record", register: registerTestRecord },
  { name: "runtime", register: registerRuntime },
  { name: "audit", register: registerAudit },
  { name: "review-memory", register: registerReviewMemory },
  { name: "verify-contract", register: registerVerifyContract },
  { name: "check-proposal", register: registerCheckProposal },
  { name: "doctor", register: registerDoctor, primary: true },
  { name: "verify-index", register: registerVerifyIndex },
  { name: "review-diff", register: registerReviewDiff },
  { name: "brief", register: registerBrief },
  { name: "validate-knowledge", register: registerValidateKnowledge },
  { name: "pulse", register: registerPulse },
  { name: "seed", register: registerSeed },
  { name: "verify", register: registerVerify },
  { name: "packet", register: registerPacket },
  { name: "done", register: registerDone, primary: true },
  { name: "sync", register: registerSync },
  { name: "doc", register: registerDoc, primary: true },
  { name: "prune", register: registerPrune },
  { name: "resume", register: registerResume },
];

export function buildProgram(): Command {
  const program = new Command()
    .name("gps")
    .description("Codebase context for coding agents.")
    .version("0.2.0");

  program.addHelpText(
    "beforeAll",
    [
      "Happy path:",
      "  gps setup --yes --with-claude         init .gps, index, lift TODOs, wire Claude Code",
      "  gps setup --yes --with-codex          init .gps, index, lift TODOs, wire Codex CLI",
      "  gps prepare <symbol> --intent <...>   decision-ready brief before edits",
      "  gps remember <fact>                   save a hard-won repo fact",
      "  gps done                              post-edit self-audit",
      "",
      "Also useful: gps doc (PR/local diff doc), gps find (symbol search), gps brief (pre-final check).",
      "Advanced commands still work — run `gps <command> --help` or see https://github.com/invariance-ai/gps#cli.",
      "",
    ].join("\n"),
  );

  registerAll(program);

  // Curate `gps --help`: keep launch focused on the default loop.
  // The full surface still runs and is reachable via `gps <name> --help`.
  const PRIMARY = new Set(COMMANDS.filter((c) => c.primary).map((c) => c.name));
  for (const cmd of program.commands) {
    if (!PRIMARY.has(cmd.name())) {
      (cmd as unknown as { _hidden: boolean })._hidden = true;
    }
  }
  program.showHelpAfterError("(use `gps --help` to see available commands)");

  return program;
}

function registerAll(program: Command): void {
  for (const command of COMMANDS) {
    command.register(program);
  }
}

const isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const entryUrl = pathToFileURL(realpathSync(entry)).href;
    const moduleUrl = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
    return moduleUrl === entryUrl;
  } catch {
    return false;
  }
})();

if (isMain) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((err: Error & { code?: string }) => {
      const msg = err.message ?? String(err);
      if (
        (err.code === "ENOENT" || /ENOENT/.test(msg)) &&
        /\.gps\/(index\/symbols\.json|config\.yml)/.test(msg)
      ) {
        const isConfig = /config\.yml/.test(msg);
        console.error(
          isConfig
            ? "gps is not initialized in this directory. Run `gps setup --yes --with-claude` (or --with-codex) first."
            : "No symbol index found. Run `gps index` first (or `gps setup --yes --with-claude` if this is a new repo).",
        );
        console.error("Run `gps doctor` to see what else is missing.");
        process.exit(1);
      }
      console.error(msg);
      process.exit(1);
    });
}
