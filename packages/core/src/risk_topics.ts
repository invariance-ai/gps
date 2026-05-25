/**
 * Risk topics that must never auto-graduate without a human in the loop.
 *
 * Mirrors the `require_approval_for` list in docs/product-memory-layer-ideas.md.
 * Used by the `--promote=safe` gate: a note cluster whose text matches any of
 * these topics is held back for manual review even when auto-promotion is on.
 */

export const REQUIRE_APPROVAL_FOR = [
  "auth",
  "payments",
  "billing",
  "security",
  "migrations",
  "compliance",
  "destructive_actions",
] as const;

export type RiskTopic = (typeof REQUIRE_APPROVAL_FOR)[number];

/**
 * Keyword expansion per topic. Matching is a cheap, deterministic, lowercased
 * substring scan — no API key, no model. Consistent with the conservative
 * heuristic philosophy of `extractPreferences`/`extractDirectives`.
 *
 * `safe` biases toward caution: any match excludes the cluster from
 * auto-promotion. False positives (over-holding) are cheaper than false
 * negatives (silently auto-promoting an auth/payments rule). An LLM tie-breaker
 * can be layered on later via the `llm` package + `ClassifierMeta`.
 */
export const RISK_TOPIC_KEYWORDS: Record<RiskTopic, string[]> = {
  auth: [
    "auth",
    "authentication",
    "authorization",
    "login",
    "logout",
    "permission",
    "token",
    "session",
    "rbac",
    "oauth",
    "jwt",
    "credential",
  ],
  payments: [
    "payment",
    "charge",
    "refund",
    "invoice",
    "credit card",
    "stripe",
    "checkout",
    "payout",
  ],
  billing: ["billing", "subscription", "plan tier", "quota", "metering", "usage limit"],
  security: [
    "security",
    "secret",
    "encrypt",
    "decrypt",
    "vulnerab",
    "csrf",
    "xss",
    "sql injection",
    "sanitiz",
    "ssrf",
  ],
  migrations: [
    "migration",
    "migrate",
    "schema change",
    "alter table",
    "ddl",
    "backfill",
  ],
  compliance: [
    "compliance",
    "gdpr",
    "hipaa",
    "pii",
    "data retention",
    "legal",
    "privacy",
    "audit log",
  ],
  destructive_actions: [
    "delete",
    "drop table",
    "truncate",
    "destroy",
    "wipe",
    "purge",
    "rm -rf",
    "force push",
    "hard reset",
  ],
};

/**
 * Returns the risk topics matched by `text` (lowercased substring scan).
 * Empty array ⇒ the text touches no governed topic.
 */
export function matchedRiskTopics(text: string): RiskTopic[] {
  const hay = text.toLowerCase();
  const hits: RiskTopic[] = [];
  for (const topic of REQUIRE_APPROVAL_FOR) {
    if (RISK_TOPIC_KEYWORDS[topic].some((kw) => hay.includes(kw))) {
      hits.push(topic);
    }
  }
  return hits;
}
