/**
 * Starter invariant packs surfaced by `gps invariant init --stack <name>`.
 *
 * These are deliberately conservative: each rule is a constraint that a domain
 * expert on the relevant stack would recognise on sight, with an `evidence`
 * pointer the user is expected to swap for their own policy doc. Packs are
 * meant as scaffolding, not as a substitute for repo-specific authoring.
 */
import type { Invariant } from "@invariance/gps-schemas";

export type StackName = "stripe" | "auth" | "gdpr" | "multi-tenant" | "http-api";

export const STACK_NAMES: readonly StackName[] = [
  "stripe",
  "auth",
  "gdpr",
  "multi-tenant",
  "http-api",
] as const;

export const PACKS: Record<StackName, Invariant[]> = {
  stripe: [
    {
      name: "Stripe — refund amount cap requires approval",
      applies_to: ["createRefund", "*.refunds.create", "refundCharge"],
      rule: "Refunds above the configured cap (default 1000) require an approval id; the call site must pass finance_approval_id.",
      evidence: ["docs/payments/refund-policy.md"],
      severity: "block",
    },
    {
      name: "Stripe — webhook signature must be verified",
      applies_to: ["stripeWebhook", "*.webhooks.constructEvent"],
      rule: "All Stripe webhook handlers must verify the signature header against STRIPE_WEBHOOK_SECRET before acting on the payload.",
      evidence: ["https://stripe.com/docs/webhooks/signatures"],
      severity: "block",
    },
    {
      name: "Stripe — idempotency key required on retry-prone POSTs",
      applies_to: ["createCharge", "createPaymentIntent", "*.paymentIntents.create"],
      rule: "POST requests to Stripe must include an idempotency key derived from a stable client identifier to prevent duplicate charges on retry.",
      evidence: ["https://stripe.com/docs/api/idempotent_requests"],
      severity: "warn",
    },
  ],
  auth: [
    {
      name: "Auth — session tokens must be HttpOnly + Secure",
      applies_to: ["setSessionCookie", "signSession", "createSession"],
      rule: "Session cookies must be set with HttpOnly, Secure, and SameSite=Lax (or stricter). Never expose session tokens to JS or non-TLS transport.",
      evidence: ["docs/auth/session-cookies.md"],
      severity: "block",
    },
    {
      name: "Auth — password storage must use a memory-hard KDF",
      applies_to: ["hashPassword", "verifyPassword"],
      rule: "Passwords must be hashed with argon2id (preferred) or bcrypt with cost ≥ 12. SHA family alone is not acceptable.",
      evidence: ["https://owasp.org/www-project-cheat-sheets/cheatsheets/Password_Storage_Cheat_Sheet.html"],
      severity: "block",
    },
    {
      name: "Auth — rate-limit credential endpoints",
      applies_to: ["loginHandler", "passwordResetHandler", "*.login", "*.signin"],
      rule: "Login and password-reset endpoints must be rate-limited per IP and per account to slow credential-stuffing.",
      evidence: ["docs/auth/rate-limits.md"],
      severity: "warn",
    },
  ],
  gdpr: [
    {
      name: "GDPR — user deletion cascades to all PII tables",
      applies_to: ["deleteUser", "purgeAccount", "anonymizeUser"],
      rule: "A deletion request must remove or irreversibly anonymise the user row in every table containing PII (profile, sessions, logs, derived analytics).",
      evidence: ["docs/gdpr/right-to-erasure.md"],
      severity: "block",
    },
    {
      name: "GDPR — exports must include all stored PII",
      applies_to: ["exportUserData", "buildDataExport"],
      rule: "Subject-access exports must include every category of PII the user has supplied or that has been derived about them, not just the profile table.",
      evidence: ["docs/gdpr/data-export.md"],
      severity: "block",
    },
    {
      name: "GDPR — consent timestamp recorded with every consent change",
      applies_to: ["recordConsent", "updateMarketingPreferences"],
      rule: "Any change in consent state must persist the timestamp, version of terms shown, and the user's IP at the time of consent.",
      evidence: ["docs/gdpr/consent-log.md"],
      severity: "warn",
    },
  ],
  "multi-tenant": [
    {
      name: "Multi-tenant — every query filters by tenant_id",
      applies_to: ["*.query", "*.select", "findMany", "findFirst"],
      rule: "Any read against a tenanted table must include tenant_id in the WHERE clause, sourced from the authenticated session — never from request input.",
      evidence: ["docs/multi-tenancy/isolation.md"],
      severity: "block",
    },
    {
      name: "Multi-tenant — cross-tenant writes require explicit privilege check",
      applies_to: ["adminUpdate", "transferRecord"],
      rule: "Writes that touch more than one tenant_id must explicitly assert the actor has cross-tenant privileges (e.g. role === 'platform-admin').",
      evidence: ["docs/multi-tenancy/admin-scope.md"],
      severity: "block",
    },
    {
      name: "Multi-tenant — tenant context propagated to background jobs",
      applies_to: ["enqueueJob", "dispatchTask"],
      rule: "Jobs enqueued from a tenanted request must carry tenant_id in the job payload; workers must re-establish tenant context before executing.",
      evidence: ["docs/multi-tenancy/background-jobs.md"],
      severity: "warn",
    },
  ],
  "http-api": [
    {
      name: "HTTP — authenticated routes verify the session",
      applies_to: ["*.handler", "*.route", "router.post", "router.get"],
      rule: "Any handler that returns user-specific data must verify a session/token; anonymous endpoints must be explicitly allow-listed.",
      evidence: ["docs/api/auth-middleware.md"],
      severity: "block",
    },
    {
      name: "HTTP — CORS allow-list is explicit, not '*'",
      applies_to: ["corsMiddleware", "*.cors"],
      rule: "CORS configuration must list origins explicitly. Wildcard ('*') is only acceptable for genuinely public, credential-free endpoints.",
      evidence: ["docs/api/cors.md"],
      severity: "warn",
    },
    {
      name: "HTTP — request bodies are validated before use",
      applies_to: ["*.handler", "*.route"],
      rule: "Request bodies must be parsed through a schema validator (zod/yup/pydantic) before fields are accessed; do not trust shape from req.body alone.",
      evidence: ["docs/api/validation.md"],
      severity: "block",
    },
  ],
};
