import { parse as parseYaml } from "yaml";
import type { Invariant } from "@invariance/gps-schemas";
import { Invariant as InvariantSchema } from "@invariance/gps-schemas";
import { GpsLlm } from "./client.js";

/**
 * Given the artifacts of a regression (PR diff, test output, surrounding
 * symbols), propose one Invariant that, had it existed and been enforced,
 * would have prevented the regression.
 *
 * The LLM returns a YAML block that must validate as Invariant. We parse and
 * zod-validate before returning — the caller writes to .gps/invariants.yml.
 */

const SYSTEM = `You analyze code regressions and propose declarative invariants.

An invariant is a rule about a symbol (function/class/method) that must always
hold. It is short, actionable, and tied to a specific failure mode that
recurred or was missed.

Output ONLY one YAML object inside a single fenced code block (\`\`\`yaml ... \`\`\`)
with exactly these fields:

  name:        # one-sentence label
  applies_to:  # array of symbol names (use the names from the diff)
  rule:        # one sentence; what must be true
  evidence:    # array of strings (PR IDs, doc paths)
  severity:    # "info" | "warn" | "block"

Choose severity:
  - "block": data loss, money, security, customer-visible breakage
  - "warn":  performance, reliability, code quality
  - "info":  conventions, style

Do not propose vague or overbroad rules. The rule must be testable in code
review by reading the symbol's body — not "be careful", but a specific
condition that can be checked.`;

export interface PostmortemInput {
  pr_number: number | string;
  pr_title: string;
  pr_body: string;
  diff: string;
  failing_tests?: string;
  symbols_touched: string[];
}

export interface PostmortemResult {
  invariant: Invariant;
  raw_yaml: string;
  dry_run_prompt?: { system: string; user: string };
}

export async function proposeInvariant(
  llm: GpsLlm,
  input: PostmortemInput,
): Promise<PostmortemResult> {
  const user = renderUserPrompt(input);
  const completion = await llm.complete({
    system: SYSTEM,
    user,
    maxTokens: 4000,
  });

  if (completion.dry_run_prompt) {
    return {
      invariant: {
        name: "[dry-run]",
        applies_to: input.symbols_touched,
        rule: "(dry-run; no API call made)",
        evidence: [`PR-${input.pr_number}`],
        severity: "warn",
      },
      raw_yaml: "[dry-run]",
      dry_run_prompt: completion.dry_run_prompt,
    };
  }

  const yamlBlock = extractYamlBlock(completion.text);
  const parsed = parseYaml(yamlBlock);
  const invariant = InvariantSchema.parse(parsed);
  return { invariant, raw_yaml: yamlBlock };
}

function renderUserPrompt(input: PostmortemInput): string {
  const parts: string[] = [];
  parts.push(`PR #${input.pr_number}: ${input.pr_title}`);
  parts.push("");
  if (input.pr_body) {
    parts.push("## PR description");
    parts.push(input.pr_body);
    parts.push("");
  }
  parts.push("## Symbols touched");
  parts.push(input.symbols_touched.map((s) => `- \`${s}\``).join("\n"));
  parts.push("");
  if (input.failing_tests) {
    parts.push("## Failing test output");
    parts.push("```");
    parts.push(input.failing_tests);
    parts.push("```");
    parts.push("");
  }
  parts.push("## Diff");
  parts.push("```diff");
  parts.push(input.diff);
  parts.push("```");
  parts.push("");
  parts.push(
    "Propose ONE invariant that would have prevented this regression. Return only the YAML block.",
  );
  return parts.join("\n");
}

function extractYamlBlock(text: string): string {
  const match = text.match(/```(?:yaml|yml)?\s*\n([\s\S]*?)```/);
  if (!match || !match[1]) {
    throw new Error(
      "LLM did not return a fenced YAML block. Re-run with --dry-run to see the raw response.",
    );
  }
  return match[1].trim();
}
