import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { Question, type Question as QuestionT, type QuestionStatus } from "@invariance/gps-schemas";

const DIR = ".gps/questions";

function fileFor(root: string, symbol: string): string {
  const safe = symbol.replace(/[/\\:]/g, "__").replace(/\./g, "_");
  return path.join(root, DIR, `${safe}.yml`);
}

export async function loadQuestions(root: string, symbol: string): Promise<QuestionT[]> {
  try {
    const raw = await readFile(fileFor(root, symbol), "utf8");
    const data = parseYaml(raw);
    if (!Array.isArray(data)) return [];
    return data.map((d: unknown) => Question.parse(d));
  } catch {
    return [];
  }
}

export interface AskOpts {
  symbol: string;
  question: string;
  asked_by?: string;
  session?: string;
}

export async function appendQuestion(
  root: string,
  opts: AskOpts,
): Promise<{ question: QuestionT; file: string }> {
  const question: QuestionT = Question.parse({
    id: randomUUID(),
    symbol: opts.symbol,
    question: opts.question,
    asked_by: opts.asked_by,
    session: opts.session,
    status: "unresolved",
    recorded_at: new Date().toISOString(),
  });
  const file = fileFor(root, opts.symbol);
  await mkdir(path.dirname(file), { recursive: true });
  const existing = await loadQuestions(root, opts.symbol);
  const next = [...existing, question];
  await writeFile(file, stringifyYaml(next));
  return { question, file: path.relative(root, file) };
}

export async function setStatus(
  root: string,
  symbol: string,
  id: string,
  status: QuestionStatus,
  resolution?: string,
): Promise<QuestionT | undefined> {
  const existing = await loadQuestions(root, symbol);
  const idx = existing.findIndex((q) => q.id === id);
  if (idx === -1) return undefined;
  const now = new Date().toISOString();
  const updated: QuestionT = {
    ...existing[idx]!,
    status,
    resolution: resolution ?? existing[idx]!.resolution,
    resolved_at: status === "unresolved" ? undefined : now,
  };
  existing[idx] = updated;
  await writeFile(fileFor(root, symbol), stringifyYaml(existing));
  return updated;
}

export async function loadAllQuestions(root: string): Promise<QuestionT[]> {
  try {
    const files = await readdir(path.join(root, DIR));
    const out: QuestionT[] = [];
    for (const f of files) {
      if (!f.endsWith(".yml")) continue;
      const raw = await readFile(path.join(root, DIR, f), "utf8");
      const data = parseYaml(raw);
      if (Array.isArray(data)) {
        for (const d of data) {
          try {
            out.push(Question.parse(d));
          } catch {
            /* skip malformed */
          }
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function filterByStatus(qs: QuestionT[], status?: QuestionStatus): QuestionT[] {
  if (!status) return qs;
  return qs.filter((q) => q.status === status);
}
