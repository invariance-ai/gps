/**
 * Lightweight intent classifier for the free-form `--intent` string passed to
 * `gps prepare`. Drives which sections are excluded so the LLM gets a brief
 * shaped for the task. Keyword-based — no model dependency.
 */

export type IntentKind = "pr" | "debug" | "review" | "refactor" | "edit" | "unknown";

const RULES: Array<{ kind: IntentKind; patterns: RegExp[] }> = [
  {
    kind: "pr",
    patterns: [
      /\bpull request\b/i,
      /\bopen(?:ing)? a pr\b/i,
      /\bwrit(?:e|ing) (?:a |the )?pr\b/i,
      /\bdraft (?:a |the )?pr\b/i,
      /\bpr description\b/i,
      /\bship\b/i,
      /\brelease notes?\b/i,
    ],
  },
  {
    kind: "debug",
    patterns: [
      /\bdebug(?:ging)?\b/i,
      /\bfix(?:ing)? (?:a |the )?bug\b/i,
      /\bcrash(?:ing|es)?\b/i,
      /\berror\b/i,
      /\bfailure\b/i,
      /\bnot working\b/i,
      /\binvestigate\b/i,
      /\bregression\b/i,
    ],
  },
  {
    kind: "review",
    patterns: [
      /\bcode review\b/i,
      /\breview(?:ing)?\b/i,
      /\baudit\b/i,
    ],
  },
  {
    kind: "refactor",
    patterns: [
      /\brefactor(?:ing)?\b/i,
      /\brenam(?:e|ing)\b/i,
      /\bextract\b/i,
      /\bclean(?: up| up the| up of)?\b/i,
      /\brestructur(?:e|ing)\b/i,
    ],
  },
  {
    kind: "edit",
    patterns: [/\bchang(?:e|ing)\b/i, /\badd(?:ing)?\b/i, /\bupdat(?:e|ing)\b/i, /\bimplement(?:ing)?\b/i],
  },
];

export function classifyIntent(intent: string): IntentKind {
  if (!intent || intent.trim() === "(unspecified)") return "unknown";
  for (const r of RULES) {
    for (const p of r.patterns) if (p.test(intent)) return r.kind;
  }
  return "unknown";
}

/**
 * Section keys (matching formatPrepareEdit's `add()` calls) to *exclude* for
 * each intent. Anything not excluded falls through to default ordering.
 */
export function excludeForIntent(kind: IntentKind): Set<string> {
  switch (kind) {
    case "pr":
      return new Set(["questions", "notes", "neighbors"]);
    case "debug":
      return new Set(["decisions"]);
    case "review":
      return new Set(["provenance", "notes", "neighbors"]);
    case "refactor":
      return new Set(["provenance"]);
    default:
      return new Set();
  }
}
