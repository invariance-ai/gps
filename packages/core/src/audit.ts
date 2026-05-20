import { readFile } from "node:fs/promises";
import path from "node:path";
import { gate } from "./gate.js";
import { readTestRuns } from "./test_runs.js";

export interface AuditCheck {
  id: string;
  pass: boolean;
  detail: string;
}

export interface AuditReport {
  session?: string;
  events: number;
  checks: AuditCheck[];
}

interface SessionEvent {
  type: string;
  ts?: string;
  symbol?: string;
  tool?: string;
  label?: string;
}

async function readActiveSessionId(root: string): Promise<string | undefined> {
  try {
    const id = (await readFile(path.join(root, ".gps/session/id"), "utf8")).trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

async function readSessionEvents(root: string, id: string): Promise<SessionEvent[]> {
  try {
    const raw = await readFile(path.join(root, ".gps/sessions", `${id}.jsonl`), "utf8");
    const out: SessionEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as SessionEvent);
      } catch {
        /* skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function auditSession(root: string): Promise<AuditReport> {
  const id = await readActiveSessionId(root);
  const events = id ? await readSessionEvents(root, id) : [];
  const checks: AuditCheck[] = [];

  const preparedSymbols = new Set(
    events.filter((e) => e.type === "prepare").map((e) => e.symbol).filter(Boolean) as string[],
  );
  const attributedLabels = events.filter((e) => e.type === "attribution");
  const editedSymbols = new Set<string>();
  for (const e of attributedLabels) {
    if (e.label) editedSymbols.add(e.label);
  }

  // Check 1: prepare before edits
  if (editedSymbols.size === 0) {
    checks.push({
      id: "prepare-before-edit",
      pass: true,
      detail: "no edits attributed this session",
    });
  } else {
    const missing = [...editedSymbols].filter((s) => !preparedSymbols.has(s));
    checks.push({
      id: "prepare-before-edit",
      pass: missing.length === 0,
      detail:
        missing.length === 0
          ? `${preparedSymbols.size} prepare(s) covered ${editedSymbols.size} edit(s)`
          : `${missing.length} symbol(s) edited without prepare: ${missing.slice(0, 5).join(", ")}`,
    });
  }

  // Check 2: tests run
  const runs = await readTestRuns(root, 100);
  const sessionStart = events[0]?.ts;
  const runsInSession = sessionStart
    ? runs.filter((r) => r.at >= sessionStart)
    : runs;
  checks.push({
    id: "tests-run",
    pass: runsInSession.length > 0,
    detail:
      runsInSession.length > 0
        ? `${runsInSession.length} test run(s) recorded (${runsInSession.filter((r) => r.exit === 0).length} pass / ${runsInSession.filter((r) => r.exit !== 0).length} fail)`
        : "no tests recorded — run `gps test-record` after your test command",
  });

  // Check 3: no unwaived blocking invariants
  const g = await gate(root, {});
  checks.push({
    id: "no-blocking-violations",
    pass: g.blocking.length === 0,
    detail:
      g.blocking.length === 0
        ? `${g.hits.length} invariant(s) apply; none blocking`
        : `${g.blocking.length} blocking invariant(s): ${g.blocking.map((h) => h.invariant.name).join(", ")}`,
  });

  // Check 4: at least one lesson/note/decision recorded if there were edits
  const learnings = events.filter((e) => e.type === "note" || e.type === "lesson" || e.type === "decision");
  if (editedSymbols.size === 0) {
    checks.push({
      id: "durable-lesson",
      pass: true,
      detail: "no edits this session — no learnings expected",
    });
  } else {
    checks.push({
      id: "durable-lesson",
      pass: learnings.length > 0,
      detail:
        learnings.length > 0
          ? `${learnings.length} durable record(s) written`
          : "no notes/decisions/lessons recorded — capture what was learned",
    });
  }

  return { session: id, events: events.length, checks };
}
