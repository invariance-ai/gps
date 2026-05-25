/**
 * Secret/PII redaction for the capture path.
 *
 * gps memory lands in a committed `.gps/` directory, so anything auto-captured
 * from a prompt or transcript (preferences, directives, distilled lessons) must
 * not carry a credential the user happened to paste. `redact()` is pure and
 * conservative: it targets well-known, high-confidence secret shapes and leaves
 * ordinary prose untouched (no entropy heuristics — those false-positive on real
 * lessons like "the hash 9f3a... identifies the run").
 *
 * Apply it immediately before persisting, never on read.
 */

const PLACEHOLDER = "[REDACTED]";

/** High-confidence secret patterns. Order matters: longer/more-specific first. */
const SECRET_PATTERNS: RegExp[] = [
  // PEM private key blocks (multi-line).
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Anthropic keys (must precede the generic sk- rule).
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  // OpenAI / Stripe-style secret keys: sk-..., sk_live_..., rk_live_...
  /\b(?:sk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}/g,
  // GitHub tokens.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // Slack tokens.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  // AWS access key id.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Google API key.
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  // JWTs (two or three base64url segments).
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?/g,
  // Bearer <token> — keep the keyword, mask the credential.
  /\bBearer\s+[A-Za-z0-9._-]{12,}/g,
  // Authorization / token / api-key assignments — redact the value, keep the label.
  /\b(Authorization|token|api[_-]?key)\b(\s*[:=]\s*)(['"]?)[A-Za-z0-9._-]{12,}\3/gi,
  // .env-style secret assignments: NAME_SECRET=value / PASSWORD="value".
  /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)(\s*[:=]\s*)(['"]?)\S{6,}\3/g,
];

export interface RedactResult {
  /** Text with secrets replaced by the placeholder. */
  text: string;
  /** Number of redactions applied. */
  hits: number;
}

/**
 * Replace high-confidence secrets in `text` with `[REDACTED]`.
 * For labelled patterns (Authorization/env assignments) the label/key is kept
 * and only the credential value is masked, so the lesson stays legible.
 */
export function redact(text: string): RedactResult {
  let out = text;
  let hits = 0;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, ...groups) => {
      hits++;
      // Labelled patterns expose capture groups (label, sep, quote) we preserve.
      const args = groups.slice(0, -2); // drop offset + full string
      if (re.source.includes("Authorization") && args.length >= 2) {
        return `${args[0]}${args[1]}${PLACEHOLDER}`;
      }
      if (re.source.includes("SECRET|TOKEN") && args.length >= 2) {
        return `${args[0]}${args[1]}${PLACEHOLDER}`;
      }
      return PLACEHOLDER;
    });
  }
  return { text: out, hits };
}

/** True when `text` contains at least one high-confidence secret. */
export function hasSecret(text: string): boolean {
  return redact(text).hits > 0;
}
