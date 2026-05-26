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

export function buildProgram(): Command {
  const program = new Command()
    .name("gps")
    .description("Codebase context for coding agents.")
    .version("0.2.0");

  program.addHelpText(
    "beforeAll",
    [
      "Core 5 (the happy path):",
      "  gps init                              write .gps/config.yml + invariants.yml",
      "  gps install <claude|codex|cursor>     wire agent hooks + CLAUDE.md / AGENTS.md / .cursor/",
      "  gps index                             build the symbol graph",
      "  gps prepare <symbol> --intent <...>   decision-ready brief before edits",
      "  gps learn <symbol> --lesson <...>     record what an edit taught you",
      "",
      "Other essentials: gps doctor (health check), gps find, gps context, gps impact, gps tests.",
      "Full surface (40+ commands) is available — see https://github.com/invariance-ai/gps#cli.",
      "",
    ].join("\n"),
  );

  registerAll(program);

  // Curate `gps --help`: only README-documented commands are visible by default.
  // The full surface still runs and is reachable via `gps <name> --help`.
  const PRIMARY = new Set([
    "init",
    "install",
    "index",
    "prepare",
    "context",
    "find",
    "trace",
    "impact",
    "tests",
    "invariants",
    "invariant",
    "learn",
    "remember",
    "notes",
    "learn-todos",
    "decide",
    "decisions",
    "serve",
    "suggest",
    "doctor",
    "pulse",
    "seed",
    "verify",
    "done",
    "sync",
  ]);
  for (const cmd of program.commands) {
    if (!PRIMARY.has(cmd.name())) {
      (cmd as unknown as { _hidden: boolean })._hidden = true;
    }
  }
  program.showHelpAfterError("(use `gps --help` to see available commands)");

  return program;
}

function registerAll(program: Command): void {
  registerInit(program);
registerWizard(program);
registerInstall(program);
registerPrefer(program);
registerPreferences(program);
registerCapturePreference(program);
registerCaptureDirective(program);
registerInbox(program);
registerContextFromPath(program);
registerDirective(program);
registerFeature(program);
registerIndex(program);
registerPrepare(program);
registerContext(program);
registerLearn(program);
registerRemember(program);
registerNotes(program);
registerLearnTodos(program);
registerDecide(program);
registerDecisions(program);
registerSuggest(program);
registerPostmortem(program);
registerPromote(program);
registerAttach(program);
registerPrIntent(program);
registerImpact(program);
registerTests(program);
registerInvariants(program);
registerInvariant(program);
registerFind(program);
registerTrace(program);
registerServe(program);
registerBench(program);
registerContextFromPrompt(program);
registerRecordFailure(program);
registerValidate(program);
registerAsk(program);
registerQuestions(program);
registerSession(program);
registerWhy(program);
registerStale(program);
registerContributors(program);
registerConflicts(program);
registerAssume(program);
registerHealth(program);
registerLessons(program);
registerGate(program);
registerWaive(program);
registerPlan(program);
registerTestRecord(program);
registerRuntime(program);
registerAudit(program);
registerReviewMemory(program);
  registerVerifyContract(program);
  registerCheckProposal(program);
  registerDoctor(program);
  registerVerifyIndex(program);
  registerReviewDiff(program);
  registerBrief(program);
  registerValidateKnowledge(program);
  registerPulse(program);
  registerSeed(program);
  registerVerify(program);
  registerPacket(program);
  registerDone(program);
  registerSync(program);
  registerPrune(program);
  registerResume(program);
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
            ? "gps is not initialized in this directory. Run `gps init` first."
            : "No symbol index found. Run `gps index` first (or `gps init` if this is a new repo).",
        );
        console.error("Run `gps doctor` to see what else is missing.");
        process.exit(1);
      }
      console.error(msg);
      process.exit(1);
    });
}
