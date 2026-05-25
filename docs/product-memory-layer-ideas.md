# GPS Product Ideas: Repo Memory Layer

This note captures product ideas for GPS as a plug-in memory layer for coding agents. The core positioning is:

> GPS turns a repository into a version-controlled operating manual for AI coding agents.

The strongest wedge is not generic "agent memory." It is repo-scoped, reviewable, committed knowledge that every coding agent can use consistently.

## Core Thesis

GPS should be conservative about trust and aggressive about capture.

- Capture can be automatic.
- Activation should be controlled.
- Risky memory should be reviewed like code.
- Provenance should be visible wherever memory is injected.
- Memory should stay attached to code structure, tests, policies, and PR history.

Developers will forgive missing memory. They will not forgive bad memory silently steering future sessions.

## Memory Types

Use explicit memory types so agents know how strongly to obey each entry.

| Type | Meaning | Default authority |
|---|---|---|
| `observed_pattern` | Inferred from code structure or repeated examples | Low |
| `developer_preference` | Inferred from conversation or explicit correction | Medium |
| `decision` | A choice made during a task, with rejected alternatives | Medium |
| `warning` | A known footgun, failure mode, or incident lesson | High |
| `todo` | Future work captured from comments or sessions | Low |
| `invariant` | A durable rule that must hold | High |
| `review_hint` | PR-specific guidance for touched code paths | Medium |

Separate confidence from authority:

```yaml
confidence: 0.92
authority: inferred | developer_confirmed | codeowner_approved | invariant
```

A repeated inferred pattern can have high confidence but still lower authority than a human-approved invariant.

## Inbox-First Activation

The default v1 behavior should be auto-capture into an inbox, not auto-activation.

Example:

```text
GPS noticed:
- Tests for billing live under apps/api/tests/billing, not next to source.
- Refund approval threshold appears to be $1,000.
- This repo prefers domain errors over generic Error.

Approve / Edit / Reject
```

This makes memory review a trust-building loop instead of an invisible background process.

Recommended defaults:

```yaml
capture: inbox
auto_activate: false
dangerous: quarantine
require_approval_for:
  - auth
  - payments
  - billing
  - security
  - migrations
  - compliance
  - destructive_actions
```

## Risk Flags

Every proposed memory should carry a risk classification:

```yaml
risk: low | medium | high | dangerous
```

Examples of `dangerous`:

- Auth or permission behavior.
- Billing, payments, refunds, invoices, credits.
- Compliance, privacy, data retention, legal assumptions.
- Data deletion or destructive operations.
- Migration ordering and rollback behavior.
- "Skip this test" or "ignore this validation."
- Anything inferred from a workaround after a failed command.
- Anything that weakens a policy, guardrail, or approval path.

Dangerous memories should never auto-activate. They should go to quarantine and require explicit approval.

CLI policy examples:

```bash
gps install codex --capture=inbox
gps install codex --capture=auto --dangerous=inbox
gps install codex --capture=auto --dangerous=quarantine
gps install codex --capture=off

gps inbox --risk dangerous
gps inbox --risk high --path payments/
gps inbox --approve-safe
gps inbox --reject-stale

gps context --include-approved-only
gps context --include-inbox
gps context --exclude-dangerous
```

## Quarantine Mode

Quarantine is stronger than inbox. Quarantined memories are visible for review but are never injected into coding context.

Example:

```text
Quarantined memory:
"Admin users can bypass approval checks."

Reason:
Touches authorization logic and was inferred, not human-approved.
```

Quarantine should be the default destination for inferred memories touching security, payments, auth, compliance, migrations, or destructive actions.

## Code Owner Approval

Borrow from GitHub CODEOWNERS. Memory approval should follow code ownership.

If a proposed memory touches `payments/`, require approval from the payment owners:

```text
Requires approval from:
- @payments-team
```

This makes memory governance match code governance. It also prevents one developer or one agent from approving durable knowledge for a domain they do not own.

## Memory Diff In PRs

Borrow from code review. Changes to `.gps/` should be reviewed as first-class artifacts.

Example PR section:

```diff
.gps/memory/refunds.yaml
+ Refunds over $1,000 require manager approval.
+ Source: session 2026-05-24, PR #203
+ Authority: developer_confirmed
+ Risk: high
```

Reviewers should be able to approve, edit, or reject memory changes alongside code changes.

## PR Reasoning Pack

The PR integration should produce a compact reviewer pack:

- **Reasoning doc:** Why the changes were made, what alternatives were considered, and what tradeoffs were accepted.
- **Assumption log:** What the agent assumed about the codebase that may or may not be true.
- **Invariant delta:** New rules proposed, approved, changed, or rejected.
- **Reviewer hints:** Relevant memories for touched symbols and paths.
- **Risk map:** High-risk files, symbols, migrations, and policy-adjacent changes.

Reviewer hints are the killer distribution feature because reviewers get value even if they never install GPS.

## Session Timeline

Borrow from observability timelines and incident review.

For a PR, reconstruct the agent's knowledge state as it changed:

```text
10:14 Agent assumed refund threshold was $500.
10:18 Test failure showed threshold is $1,000.
10:21 Developer confirmed $1,000 rule.
10:22 GPS proposed invariant.
10:24 Invariant was approved into .gps/memory/refunds.yaml.
```

This makes the PR reasoning doc auditable instead of just a summary of the final state.

## Explainability

`gps explain` should be a core UX surface.

Example:

```text
Showing memory because:
- You are editing src/billing/refunds.ts.
- Symbol RefundProcessor has 3 attached memories.
- This rule was approved by Sarah on 2026-05-12.
- It was last used successfully in PR #184.
- It is validated by tests/refunds/approval.test.ts.
```

The user should always be able to ask why GPS injected a memory and what evidence supports it.

## Staleness Detection

Borrow from dependency scanners and stale issue automation.

GPS should flag memory that may no longer be true:

```text
This memory may be stale:
- It references approveRefund(), but that symbol was deleted.
- Last confirmed 74 days ago.
- Related tests changed in 3 recent commits.
- The owning file was heavily rewritten after the memory was approved.
```

Staleness signals:

- Anchor symbol renamed, deleted, or moved.
- Tests that validate a memory were deleted or rewritten.
- Related files changed frequently since last confirmation.
- A contradictory memory was approved later.
- The memory has not been retrieved or confirmed in a long time.
- Production telemetry contradicts the assumption.

## Memory Tests

Borrow from executable specifications.

A memory can cite tests that validate it:

```yaml
rule: Refunds over $1,000 require approval.
validated_by:
  - tests/refunds/approval.test.ts
```

If those tests fail, disappear, or are rewritten, GPS should mark the memory as needing reconfirmation.

This turns important memories into lightweight, test-backed contracts.

## Policy Engine

Borrow from Kubernetes admission controllers and Open Policy Agent.

GPS can have a policy layer that decides whether a memory can be captured, activated, injected, or pruned.

Example:

```yaml
policies:
  - match:
      risk: dangerous
    require:
      authority: codeowner_approved
    action: quarantine

  - match:
      type: observed_pattern
      paths:
        - "tests/**"
    allow:
      auto_activate: true
```

This makes GPS configurable for conservative teams without hardcoding every rule in the product.

## Memory Health: `gps doctor`

Borrow from package managers and infra CLIs.

`gps doctor` should report memory health:

```text
42 active memories
7 stale symbol anchors
3 conflicting rules
12 inbox candidates awaiting review
5 memories unused in 90 days
2 dangerous memories quarantined
4 memories missing provenance
```

This gives teams confidence that the memory layer is maintained, not just accumulating junk.

## Conflict Resolution

Borrow from merge conflict workflows.

When memories contradict each other, GPS should force explicit resolution.

```text
Conflict detected:
- "Refunds over $1,000 require manager approval."
- "Refunds over $500 require manager approval."

Severity: high
Reason: same domain, different threshold
Action: resolve before either memory is injected.
```

Conflicts should carry severity, affected symbols, proposed resolution, and owner routing.

## Memory Ownership And TTL

Borrow from feature flags and operational runbooks.

Some memories should have owners and expiration dates:

```yaml
owner: "@billing-team"
expires_at: "2026-08-01"
renewal_policy: require_owner_confirmation
```

Use TTLs for temporary launch decisions, migrations, incident workarounds, and rollout assumptions.

Durable invariants should not expire automatically, but they can still need reconfirmation when anchors or tests change.

## Rollout Rings

Borrow from feature flag systems.

Memory activation can roll out by scope:

```yaml
rollout:
  stage: shadow | suggested | active | enforced
  agents:
    - codex
    - claude
  paths:
    - apps/api/src/refunds/**
```

Stages:

- `shadow`: captured and evaluated, never shown to agents.
- `suggested`: shown as low-authority context.
- `active`: injected normally.
- `enforced`: blocks or warns before risky edits.

This lets teams evaluate memory quality before trusting it.

## Shadow Mode Metrics

Borrow from ML evaluation and feature launches.

In shadow mode, GPS should ask:

- Would this memory have been retrieved?
- Would it have changed the agent's plan?
- Did the final diff obey or contradict it?
- Did tests or review validate the memory?

This gives a path from capture to activation based on observed usefulness, not vibes.

## Reputation Scores

Borrow from spam filters and search ranking.

Memory sources should develop reputation over time:

- Human-approved invariant: high reputation.
- Codeowner-approved invariant: highest reputation.
- Repeated correction from same developer: medium-high.
- Agent-inferred pattern: low until confirmed.
- Memory contradicted by tests or later review: reputation decreases.

This should affect retrieval ranking and whether a memory can graduate.

## Capture Budgets

Borrow from error budgets.

Limit how much new memory GPS can propose per session or per PR:

```yaml
capture_budget:
  max_inbox_items_per_session: 8
  max_active_promotions_per_pr: 3
```

This directly attacks the noise problem. A small number of high-quality proposals beats a large pile of weak observations.

## Sensitive Data Redaction

Borrow from logging pipelines.

Before anything lands in `.gps/`, run redaction for:

- API keys and tokens.
- Customer names and emails.
- Internal URLs.
- Stack traces with secrets.
- Proprietary prompts or private incident text.
- Database credentials.

Memory entries should carry redaction metadata:

```yaml
redaction_status: passed
redacted_fields:
  - evidence.raw_stacktrace
```

## Privacy Boundary

GPS should make the privacy line explicit:

- Repo memory is committed to the repo.
- Session summaries are opt-in.
- Raw chat logs should not be committed by default.
- Sensitive evidence should be summarized and redacted.
- Teams should be able to disable capture for paths and commands.

This matters because `.gps/` is durable and reviewable. That is a strength only if the data boundary is clear.

## Runtime Evidence

Borrow from Sentry, Datadog, OpenTelemetry, and incident tools.

Connect memories to production evidence:

```yaml
evidence:
  - type: sentry_issue
    ref: BILLING-1842
  - type: trace
    service: api
    span: RefundApprovalService.create
  - type: runbook
    path: docs/runbooks/refunds.md
```

Runtime-backed memory is more defensible than memory inferred only from code.

Potential features:

- "This symbol appears in 18 production errors this week."
- "This function writes to a high-risk table."
- "This endpoint is on the checkout critical path."
- "This invariant was created after incident INC-2026-041."

## Data Lineage

Borrow from data catalogs.

GPS should know which tables, queues, topics, files, and APIs a symbol touches.

Example:

```text
Editing createRefund touches:
- postgres.refunds
- postgres.refund_approvals
- stripe.refunds.create
- queue.refund-events
```

This improves risk scoring and reviewer hints.

## Blast Radius Forecast

Borrow from deployment systems.

Before an agent edits a symbol, GPS should produce a blast radius forecast:

```text
Likely blast radius:
- 4 direct callers
- 2 public API routes
- 3 tests
- 1 migration-sensitive table
- 1 active invariant
- 2 production incidents in last 90 days
```

This turns context retrieval into a pre-edit safety check.

## Memory-Aware Test Selection

Borrow from test impact analysis.

GPS should select tests from both code graph and memory graph:

- Tests that cover touched symbols.
- Tests referenced by applicable memories.
- Tests that previously caught failures in this area.
- Tests tied to invariants under the touched path.

This is stronger than call graph selection alone.

## Agent Report Card

Borrow from eval dashboards.

Track how well each agent uses GPS:

- Did the agent call `gps prepare` before editing?
- Did it follow active invariants?
- Did it contradict injected memory?
- Did it run recommended tests?
- Did the user correct the same mistake again?

This helps teams debug whether failures are memory quality problems or agent behavior problems.

## Memory Coverage Map

Borrow from test coverage.

Show which important code paths have no memory coverage:

```text
Coverage gaps:
- payments/refunds: 3 invariants, 8 notes, 2 warnings
- auth/session: 0 invariants, 1 warning
- migrations: 0 owners, 0 warnings
```

This can drive authoring work. The goal is not 100 percent coverage. The goal is visible gaps in high-risk areas.

## Starter Packs

Borrow from lint rule presets.

Ship optional invariant packs:

- Stripe and payments.
- Auth and session management.
- Multi-tenant isolation.
- PII and GDPR.
- Background jobs and retries.
- Database migrations.
- React frontend accessibility.
- API compatibility.
- Incident response.

Starter packs should generate proposed rules into inbox, not directly activate them.

## Templates For Common Decisions

Borrow from ADRs.

GPS should support structured decision templates:

```yaml
decision: "Validate refund amount before currency conversion."
status: accepted
context: "JPY and zero-decimal currencies make post-conversion checks unsafe."
rejected:
  - "Validate after conversion."
tradeoffs:
  - "Requires currency metadata earlier in the flow."
```

This makes PR reasoning docs better and avoids vague memory.

## Memory Importers

Borrow from knowledge base migration tools.

GPS can import candidate memory from:

- ADRs.
- Runbooks.
- README files.
- Existing TODO and FIXME comments.
- PR descriptions.
- Issue tracker labels and comments.
- Semgrep and CodeQL rules.
- CODEOWNERS.
- Test names and test descriptions.

All imports should land in inbox with provenance.

## Memory Exporters

Borrow from docs and compliance reporting.

Teams should be able to export:

- Operational rules by domain.
- High-risk invariants.
- Stale memories.
- Decision history for a symbol.
- PR reasoning packs.
- Reviewer hints as markdown.
- Audit trail for compliance-heavy repos.

This makes `.gps/` useful to humans, not only agents.

## Pairing Mode

Borrow from IDE assistant UX.

During a live task, GPS can maintain a small "working memory panel":

- Current intent.
- Touched symbols.
- Applicable invariants.
- Open assumptions.
- Recommended tests.
- Proposed memories waiting for review.

This gives the developer a visible, editable view of what the agent thinks is true.

## Assumption Ledger

Borrow from research notebooks and incident reviews.

Agents should write assumptions explicitly:

```text
Assumption:
The refund threshold is $1,000 because RefundApprovalServiceTest asserts that value.

Status:
Unconfirmed.

How to verify:
Check docs/refund-policy.md or ask billing owner.
```

Unconfirmed assumptions should not become active memory. They can become PR review questions.

## Negative Memory

Borrow from "do not recommend again" systems.

GPS should remember rejected paths:

```yaml
do_not:
  - "Do not replace domain errors with generic Error in billing code."
  - "Do not use snapshot tests for approval threshold behavior."
```

Negative memory is valuable because agent failures are often repeated attempts at the same bad shortcut.

## Memory Linting

Borrow from documentation linters.

Validate memory quality before commit:

- Must have provenance.
- Must have scope.
- Must have authority.
- Dangerous memories cannot be active without approval.
- Invariants need evidence.
- Temporary memories need TTL.
- Broad memories need broad evidence.

This can run in CI:

```bash
gps validate-knowledge
```

## Promotion And Demotion

Borrow from tiered storage and moderation queues.

Promotion path:

```text
observed_pattern -> inbox -> approved note -> repeated note -> invariant candidate -> approved invariant
```

Demotion path:

```text
active memory -> stale -> needs review -> archived or rewritten
```

Promotion should require evidence. Demotion should happen when memories are contradicted, unused, or detached from code.

## Memory Query Language

Borrow from issue search and log search.

Power users should be able to query memory:

```bash
gps memory search "risk:dangerous path:payments/ authority:inferred"
gps memory search "type:warning stale:true"
gps memory search "owner:@billing-team expires:<30d"
```

This makes cleanup and audits practical.

## Branch-Aware Memory

Borrow from Git.

Memory may differ by branch during large refactors. GPS should avoid injecting main-branch memory that is invalid on a feature branch.

Potential behavior:

- Store branch provenance for new memories.
- Detect when an active memory was approved on a different branch.
- Revalidate memory when merging.
- Include memory conflicts in merge conflict output.

## Rename And Refactor Tracking

Borrow from language servers and git history.

Symbol anchoring must survive renames. GPS needs a concrete story:

- Stable symbol IDs based on file, span, AST shape, and call edges.
- Git diff tracking for renames and moves.
- LSP rename events where available.
- Fuzzy reattachment when a symbol moves.
- Review queue when reattachment is uncertain.

Silent anchor breakage is a catastrophic failure mode. Uncertain reattachment should go to inbox.

## Suggested V1 Defaults

For early trust:

```yaml
capture:
  mode: inbox
  max_items_per_session: 8

activation:
  auto_activate: false
  approved_only: true

risk:
  dangerous: quarantine
  high: inbox

approval:
  use_codeowners: true
  require_codeowner_for:
    - auth
    - payments
    - billing
    - security
    - compliance
    - migrations

privacy:
  redact: true
  commit_raw_sessions: false

retrieval:
  include_low_confidence: false
  explainable: true
```

## Golden Path Demo

The best demo should show the full learning loop:

1. Install GPS in an unfamiliar repo.
2. GPS generates a repo map and proposes obvious memories into inbox.
3. Agent makes a small mistake.
4. Developer corrects it.
5. GPS captures the correction and says it will remember it.
6. Developer approves the memory.
7. A new session with a different agent avoids the same mistake.
8. The PR includes reasoning, assumptions, invariant delta, and reviewer hints.

That demonstrates the product better than a benchmark alone.

## Positioning

Avoid leading with generic memory. Lead with repo knowledge and reviewability.

Stronger:

> A version-controlled knowledge layer that helps every coding agent understand your codebase the way your team does.

Also strong:

> The repo gets an operating manual that agents can read, update, and cite.

The durable differentiator is committed, cross-agent, symbol-anchored, reviewable operational knowledge.
