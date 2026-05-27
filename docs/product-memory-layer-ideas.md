# GPS Product Ideas: Repo Memory Layer

This note captures product ideas for GPS as a plug-in memory layer for coding agents. The core positioning is:

> GPS is repo memory that keeps agents from rediscovering the same facts every session.

The strongest wedge is not generic "agent memory." It is repo-scoped knowledge that Claude, Codex, Cursor, and other coding agents can reuse instead of forcing developers to repeat the same corrections.

Trust is not the billboard. The billboard is speed, fewer repeated mistakes, better test selection, better PRs, and agents that remember how the repo works. Trust mechanics are the plumbing that keeps the memory layer from becoming junk.

> **Implementation status (v0.5).** The capture/promotion governance described below is now partly shipped and configurable per repo via `gps install --capture=<inbox|auto> --promote=<never|safe|all>` (persisted to `.gps/config.yml`):
> - **Inbox capture** — `--capture=inbox` routes captured preferences/directives into `.gps/inbox.yml` for review. Manage with `gps inbox` / `gps inbox approve|reject|edit <id>`. Approving runs the real persist. (`--capture=auto`, the default, persists live as before.)
> - **Auto-promotion** — `--promote=safe` (default with `capture=auto`) auto-graduates recurring note clusters into invariants but holds back any cluster touching a `require_approval_for` risk topic (the gate below); `--promote=all` promotes everything (bypasses the gate, prints a loud warning); `--promote=never` keeps promotion manual. Run via `gps promote --auto`.
> Not yet implemented: quarantine, influence auditing, demotion, and automatic Stop-hook promotion (auto-promotion is currently invoked explicitly).

## MVP Launch Scope

The MVP should prove one loop:

```text
agent asks GPS -> developer corrects agent -> GPS captures candidate -> human approves -> next session reuses it
```

Launch claim:

> GPS is repo memory that keeps agents from rediscovering the same facts every session.

Launch qualifier:

> By default, new memories go to an inbox before they can affect future agent context.

Required for MVP:

- `gps install claude|codex|cursor` writes agent instructions that tell the agent to ask GPS before meaningful edits.
- `gps prepare <symbol-or-path> --intent "<task>"` returns repo structure, relevant memories, warnings, tests, and recent decisions.
- Captured preferences, corrections, TODOs, lessons, and directives can route to inbox.
- `gps inbox` supports list, approve, reject, and edit.
- Approved memory is eligible for retrieval; rejected inbox items do not steer agents.
- `gps install --capture=<inbox|auto> --promote=<never|safe|all>` persists repo policy.
- `--promote=safe` is the default with `capture=auto`.
- `--promote=safe` never promotes auth, billing, payments, security, compliance, migrations, or destructive-action memories.
- `.gps/` artifacts remain readable enough for a developer to inspect or hand-edit.
- `gps doctor` shows basic health: inbox count, active memory count, config policy, stale/conflict warnings if available.
- README demo shows the correction-to-reuse loop, not only graph/token benchmarks.

Explicitly not required for MVP:

- Influence auditing.
- Quarantine implementation.
- Full CODEOWNERS enforcement.
- Zep-style temporal snapshots.
- Runtime/Sentry/Datadog evidence.
- PR reasoning packs and reviewer hints.
- Graphify-style HTML graph exports.
- Branch-aware memory merge semantics.
- Automatic Stop-hook promotion.

MVP success means a solo developer can install GPS in a repo, correct an agent once, approve that lesson, and see a later agent session reuse it without manually pasting the same fact again.

## Core Thesis

GPS should be conservative about trust and aggressive about capture.

- Capture can be automatic.
- Activation should be controlled.
- Risky memory should be reviewed like code.
- Provenance should be visible wherever memory is injected.
- Memory should stay attached to code structure, tests, policies, and PR history.

Developers will forgive missing memory. They will not forgive bad memory silently steering future sessions.

## V1 Trust Contract

V1 should have zero auto-graduation.

GPS can automatically notice, summarize, score, and route memory candidates. It should not automatically promote an inferred candidate into active memory. Every durable memory that can be injected into agent context should pass through `gps inbox` and receive explicit human approval.

This is not a limitation. It is the product being honest about its confidence. The system can automate the judgment layer later, after it has real approval and rejection data from teams.

V1 behavior:

- All captured lessons, inferred patterns, corrections, and session summaries go to inbox.
- Inbox items can be approved, edited, rejected, quarantined, or archived.
- Only approved memory is eligible for default retrieval.
- Dangerous memory can only move from quarantine to active memory with explicit approval.
- GPS records who made the approval decision, when, and from what evidence.
- Auto-graduation experiments run in shadow mode only.

The guiding rule:

```text
Automatic capture is allowed.
Automatic activation is not allowed in v1.
```

## `.gps/` Directory Shape

The `.gps/` directory should be readable, boring, and hand-editable. Developers will inspect it immediately after install. If it looks like an opaque cache or model artifact dump, they will distrust it.

Suggested structure:

```text
.gps/
  config.yml
  inbox/
    2026-05-24-refund-threshold.candidate.yml
    2026-05-24-domain-errors.candidate.yml
  memory/
    invariants/
      refunds.yml
      auth.yml
    notes/
      billing.yml
    decisions/
      refund-validation.yml
    warnings/
      migrations.yml
  index/
    symbols.sqlite
    anchors.json
  review/
    pr-203.md
    pr-203-memory-delta.md
  archive/
    rejected/
    stale/
  observations.json
```

Rules for this directory:

- `memory/` contains reviewed, active, durable knowledge.
- `inbox/` contains proposed knowledge that is not active by default.
- `index/` can be generated and ignored from review if needed.
- `review/` contains human-readable PR artifacts.
- `archive/` preserves rejected and stale decisions for provenance.
- Files should be YAML or markdown unless there is a strong reason otherwise.

The files themselves should be understandable without running GPS.

Example inbox candidate:

```yaml
id: memcand_2026_05_24_refund_threshold
type: invariant_candidate
risk: high
status: inbox
summary: Refunds over $1,000 appear to require manager approval.
scope:
  paths:
    - apps/api/src/refunds/**
  symbols:
    - RefundApprovalService
evidence:
  - type: test
    path: tests/refunds/approval.test.ts
    lines: "18-42"
  - type: session
    id: sess_2026_05_24_1014
source:
  captured_by: codex
  captured_at: "2026-05-24T10:22:00Z"
  trigger: developer_correction
authority: inferred
confidence: 0.74
proposed_action: approve_as_invariant
```

Example approved memory:

```yaml
id: mem_2026_05_24_refund_threshold
type: invariant
risk: high
status: active
rule: Refunds over $1,000 require manager approval.
scope:
  paths:
    - apps/api/src/refunds/**
  symbols:
    - RefundApprovalService
evidence:
  - type: test
    path: tests/refunds/approval.test.ts
    lines: "18-42"
authority: codeowner_approved
approved_by: "@billing-owner"
approved_at: "2026-05-24T11:03:00Z"
source_candidate: memcand_2026_05_24_refund_threshold
validated_by:
  - tests/refunds/approval.test.ts
last_confirmed_at: "2026-05-24T11:03:00Z"
```

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

## Inbox-Only Graduation

The default v1 behavior should be auto-capture into an inbox with no auto-graduation.

Example:

```text
GPS noticed:
- Tests for billing live under apps/api/tests/billing, not next to source.
- Refund approval threshold appears to be $1,000.
- This repo prefers domain errors over generic Error.

Approve / Edit / Reject
```

This makes memory review a trust-building loop instead of an invisible background process.

Concrete graduation states:

```text
captured -> inbox -> approved -> active
captured -> inbox -> edited -> approved -> active
captured -> inbox -> rejected -> archive/rejected
captured -> quarantine -> approved_by_owner -> active
active -> stale -> reconfirmed -> active
active -> stale -> archived
```

Who makes the call:

- Low-risk patterns can be approved by any repo contributor.
- Medium-risk memories should be approved by a maintainer or path owner.
- High-risk memories should be approved by the relevant CODEOWNER.
- Dangerous memories require CODEOWNER approval and should show up as quarantined by default.
- Agents can recommend an action, but they cannot approve their own captured memory in v1.

What triggers a graduation proposal:

- A developer explicitly corrects the agent.
- The same lesson appears in multiple sessions.
- A TODO/FIXME/comment maps cleanly to a symbol.
- A test failure reveals a stable rule.
- A PR review comment establishes a durable preference.
- A human runs `gps remember` or edits an inbox candidate.

What does not trigger activation:

- Repeated retrieval alone.
- High confidence score alone.
- Agent-generated summary alone.
- Passing tests alone.
- Similarity to existing memory alone.

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

## Team Dynamics

The multi-developer case is where GPS becomes valuable and where it can get messy.

When one developer's session creates a memory candidate, other developers need to understand its status before it affects their agents.

Recommended behavior:

- New candidates are visible in `gps inbox` for everyone after they are committed or synced.
- Candidates are not active for other developers until approved.
- The inbox shows author, source session, risk, affected paths, and required approver.
- Rejections are preserved with a reason so the same bad memory is not repeatedly proposed.
- Conflicting candidates block activation and route to the relevant owners.
- Developers can subscribe to inbox changes for owned paths.
- GPS should summarize memory deltas in PRs so team review catches bad additions.

Example team inbox view:

```text
gps inbox

[high] Refunds over $1,000 appear to require manager approval.
  status: needs @billing-team approval
  source: developer correction in sess_2026_05_24_1014
  affects: apps/api/src/refunds/**

[medium] Billing code prefers DomainError over generic Error.
  status: awaiting maintainer review
  source: repeated pattern across 4 files
  affects: apps/api/src/billing/**

[dangerous] Admin users can bypass approval checks.
  status: quarantined
  source: inferred from failed workaround
  affects: apps/api/src/auth/**
```

Team-level permissions should be explicit:

```yaml
approval:
  default: maintainer
  low_risk: contributor
  high_risk: codeowner
  dangerous: codeowner

owners:
  payments:
    paths:
      - apps/api/src/payments/**
    approvers:
      - "@payments-team"
```

This keeps GPS from becoming a shared rumor engine. Memory becomes a reviewed team artifact.

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

## Passive Influence Auditing

Approval does not make memory true forever. A bad invariant can be approved, sit in active memory, and steer several future sessions before anyone notices. GPS needs passive auditing of memory influence, not just up-front review.

Every time active memory is injected, GPS should record a small influence event:

```yaml
id: influence_2026_05_25_0914_001
session: sess_2026_05_25_0914
memory_id: mem_2026_05_24_refund_threshold
shown_at: "2026-05-25T09:16:03Z"
shown_because:
  paths:
    - apps/api/src/refunds/create.ts
  symbols:
    - createRefund
agent: codex
task: "change refund approval flow for enterprise customers"
agent_action:
  touched_paths:
    - apps/api/src/refunds/create.ts
  cited_memory: true
  followed_memory: likely
outcome:
  tests_run:
    - tests/refunds/approval.test.ts
  tests_passed: true
  pr: 218
audit_status: pending
```

This should not store raw chat by default. It should store enough metadata to reconstruct influence:

- Which memory was shown.
- Why it was shown.
- Which session and agent saw it.
- Which files and symbols were changed afterward.
- Whether the agent cited, followed, ignored, or contradicted the memory.
- Which tests or reviews later touched the same behavior.

Then GPS can periodically surface an audit prompt:

```text
Memory audit: mem_2026_05_24_refund_threshold

"Refunds over $1,000 require manager approval."

This memory was active in 3 sessions:
- PR #218 changed createRefund and followed this memory.
- PR #221 changed RefundApprovalService and did not touch the threshold.
- PR #224 changed enterprise refund approval and contradicted this memory.

Does this memory still look correct?

Actions:
Reconfirm / Edit / Mark stale / Quarantine / Archive
```

Audit triggers:

- A memory influenced N sessions or PRs.
- A future diff appears to contradict the memory.
- A reviewer comments on code that was changed after memory injection.
- Tests tied to the memory fail or are edited.
- A high-risk or dangerous memory is used for the first time.
- Multiple agents use the same memory in different ways.
- A memory has high influence but low recent human confirmation.

This closes the trust hole where bad approved memory quietly poisons future context.

## Influence Ledger

Borrow from audit logs and model observability.

GPS should maintain an influence ledger that is reviewable but compact:

```text
.gps/
  audit/
    influence/
      2026-05-25.yml
    memory/
      mem_2026_05_24_refund_threshold.md
```

Memory-level audit view:

```bash
gps memory influence mem_2026_05_24_refund_threshold
```

Example output:

```text
Memory: Refunds over $1,000 require manager approval.
Status: active
Risk: high
Approved by: @billing-owner on 2026-05-24

Influence:
- 3 sessions saw this memory
- 2 PRs changed related code afterward
- 1 contradiction candidate
- 1 validating test edited

Recommended action:
Review before next injection.
```

Session-level audit view:

```bash
gps session influence sess_2026_05_25_0914
```

This answers:

- What memories were active during this session?
- Which ones were injected?
- Which ones appear to have influenced the diff?
- Which assumptions were made from memory rather than code?
- Which memories should be rechecked during PR review?

## Memory Rollback And Containment

When a memory is discovered to be wrong, GPS needs a containment path.

Actions:

- Mark memory `quarantined` immediately.
- Stop injecting it by default.
- Show all sessions and PRs where it was active.
- Create follow-up review tasks for affected PRs.
- Add a rejected-memory tombstone so the same claim is not recaptured immediately.
- Ask whether replacement memory should be created.

Example tombstone:

```yaml
id: tombstone_2026_05_25_refund_threshold
claim: Refunds over $1,000 require manager approval.
reason: Incorrect for enterprise refunds; threshold differs by account tier.
rejected_by: "@billing-owner"
rejected_at: "2026-05-25T16:20:00Z"
blocks_recapture_until: "2026-06-25"
```

Containment is especially important for approved invariants because they have higher authority and are more likely to steer agent behavior.

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
3 high-influence memories due for audit
1 active memory with a contradiction candidate
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
- Which active memories most often influenced diffs?
- Which memories were ignored, contradicted, or later rolled back?

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

For v1, promotion and demotion are human-reviewed state transitions, not autonomous classifier decisions.

Candidate representation before approval:

```yaml
id: memcand_2026_05_24_domain_errors
type: developer_preference_candidate
status: inbox
risk: medium
summary: Billing code should use DomainError instead of generic Error.
scope:
  paths:
    - apps/api/src/billing/**
evidence:
  - type: developer_correction
    session: sess_2026_05_24_1430
  - type: code_pattern
    examples:
      - apps/api/src/billing/refunds.ts:88
      - apps/api/src/billing/invoices.ts:121
authority: inferred
confidence: 0.81
required_approval: maintainer
proposed_active_type: warning
```

Approved representation after graduation:

```yaml
id: mem_2026_05_24_domain_errors
type: warning
status: active
risk: medium
rule: Billing code should use DomainError instead of generic Error.
scope:
  paths:
    - apps/api/src/billing/**
evidence:
  - type: developer_correction
    session: sess_2026_05_24_1430
  - type: code_pattern
    examples:
      - apps/api/src/billing/refunds.ts:88
      - apps/api/src/billing/invoices.ts:121
authority: maintainer_approved
approved_by: "@repo-maintainer"
approved_at: "2026-05-24T15:05:00Z"
source_candidate: memcand_2026_05_24_domain_errors
retrieval:
  default: true
  max_tokens: 120
```

V1 state path:

```text
candidate -> inbox/quarantine -> human decision -> active/archive
```

Future shadow-mode automation can score candidates, but the action remains advisory:

```yaml
graduation_recommendation:
  action: approve_as_warning
  model: gps-classifier-v0
  confidence: 0.81
  reasons:
    - repeated developer correction
    - consistent code examples
    - path-scoped to billing
```

Demotion is also explicit:

```text
active memory -> stale -> needs review -> archived or rewritten
```

Demotion triggers:

- Anchor symbol deleted or uncertain after refactor.
- Validating tests deleted or changed substantially.
- New approved memory contradicts the active memory.
- Human rejects the memory during review.
- Production evidence contradicts the memory.
- Owner lets a temporary memory expire.

Demotion call:

- GPS can mark memory `stale`, `conflicted`, or `needs_review`.
- A human or code owner decides whether to reconfirm, edit, or archive it.
- Agents should not receive stale or conflicted memory by default.

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

## Zep Comparison

Zep is philosophically close to GPS at the reasoning layer because it treats memory as temporal knowledge, not just retrieved text. The important idea to borrow is not their buyer or deployment model. It is the ability to reconstruct what an agent knew at the time a decision was made.

The difference in positioning:

| Dimension | Zep | GPS |
|---|---|---|
| Buyer | App developers building memory into products | Developers using coding agents in repos |
| Scope | Application/user memory | Repository/team/code memory |
| Storage model | Temporal knowledge graph | Version-controlled `.gps/` files plus generated indexes |
| Primary workflow | Product memory retrieval | Pre-edit context, PR review, team knowledge |
| Trust surface | App-level memory policy | Code review, CODEOWNERS, committed diffs |
| Debug question | What did the app know about this user? | What did the agent know about this code when it made this change? |

The architectural lesson from Zep:

- Memory should have temporal edges, not just current facts.
- Retrieval should be able to answer "what was believed then?".
- Facts should track provenance, supersession, and invalidation.
- Decision records should cite the memory state that existed when the decision happened.

GPS should model this in a repo-native way:

```yaml
id: decision_2026_05_24_refund_validation
type: decision
status: active
decision: Validate refund amount before currency conversion.
made_at: "2026-05-24T14:18:00Z"
made_by: codex
approved_by: "@billing-owner"
memory_snapshot:
  active:
    - mem_2026_05_24_refund_threshold
    - mem_2026_05_22_currency_zero_decimal
  inbox:
    - memcand_2026_05_24_domain_errors
assumptions:
  - id: assumption_001
    text: JPY zero-decimal handling is implemented in CurrencyPolicy.
    status: confirmed
```

This supports PR review questions like:

- What active invariants were shown to the agent before it edited this symbol?
- Which assumptions were unconfirmed at decision time?
- Did the agent ignore an active memory?
- Did a later memory invalidate the reasoning behind this change?

GPS does not need to become a hosted temporal graph product to borrow this. The repo can store durable records as YAML/markdown, while generated indexes provide graph and time-travel queries.

## Suggested V1 Defaults

For early trust:

```yaml
capture:
  mode: inbox
  max_items_per_session: 8

activation:
  auto_activate: false
  approved_only: true
  auto_graduation: false

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

graduation:
  mode: human_review_only
  shadow_recommendations: true
  agents_can_approve: false

auditing:
  record_influence_events: true
  raw_chat_capture: false
  audit_after_influences: 3
  audit_high_risk_first_use: true
  quarantine_on_contradiction: true
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

Avoid leading with generic memory or abstract trust. Lead with fewer repeated corrections and agents that stop forgetting the repo.

Primary:

> GPS is repo memory that keeps agents from rediscovering the same facts every session.

Also strong:

> A version-controlled knowledge layer that helps every coding agent understand your codebase the way your team does.

Another option:

> The repo gets an operating manual that agents can read, update, and cite.

What developers actually care about:

- Stop correcting the same agent mistake twice.
- Make agents find the right files faster.
- Make agents run the right tests.
- Avoid reviewer nitpicks based on repo-specific conventions.
- Keep useful context across Claude, Codex, Cursor, and future agents.
- Turn corrections, decisions, warnings, and gotchas into reusable repo knowledge.

The durable differentiator is committed, cross-agent, symbol-anchored operational knowledge with enough review and audit plumbing to stay useful.

## Market Gap

Many tools own ingredients. None clearly package the full GPS shape.

Graphify has persistent graph artifacts, cross-agent installation, confidence tags, suggested questions, rationale extraction, and queryable graph paths. Zep has temporal memory primitives. Cursor rules and Claude memory provide narrower memory surfaces. Semgrep and CodeQL provide enforceable rules. Greptile and Sourcegraph provide review and code intelligence.

The missing bundle:

- Repo-committed memory.
- Cross-agent usage.
- Symbol and path anchoring.
- Captured corrections and session lessons.
- Inbox-first activation.
- Human-approved graduation.
- Invariants, decisions, warnings, preferences, and TODOs.
- PR reasoning and reviewer hints.
- Influence auditing showing where memory steered later sessions.
- Plain `.gps/` files developers can inspect and edit.

The category is not "memory system" in the abstract. The category is repo memory for coding agents.
