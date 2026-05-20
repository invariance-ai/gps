import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const REL = ".gps/runtime.json";

export interface RuntimeEvent {
  symbol: string;
  source: "sentry" | "datadog" | "otel" | "logs" | "incident" | "ticket" | "other";
  kind: "error" | "latency" | "incident" | "ticket" | "other";
  message: string;
  at: string;
  count?: number;
  url?: string;
  severity?: "low" | "medium" | "high" | "critical";
}

export interface RuntimeStore {
  imported_at?: string;
  events: RuntimeEvent[];
}

export async function loadRuntime(root: string): Promise<RuntimeStore> {
  try {
    const raw = await readFile(path.join(root, REL), "utf8");
    const data = JSON.parse(raw) as Partial<RuntimeStore>;
    return { imported_at: data.imported_at, events: data.events ?? [] };
  } catch {
    return { events: [] };
  }
}

export async function writeRuntime(root: string, store: RuntimeStore): Promise<void> {
  const p = path.join(root, REL);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(store, null, 2));
}

export async function importRuntimeJSON(root: string, file: string): Promise<RuntimeStore> {
  const raw = await readFile(file, "utf8");
  const data = JSON.parse(raw);
  const events: RuntimeEvent[] = Array.isArray(data) ? data : (data.events ?? []);
  const store: RuntimeStore = { imported_at: new Date().toISOString(), events };
  await writeRuntime(root, store);
  return store;
}

export function runtimeForSymbol(symbol: string, store: RuntimeStore): RuntimeEvent[] {
  return store.events
    .filter((e) => matches(symbol, e.symbol))
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}

function matches(symbol: string, pattern: string): boolean {
  if (pattern === symbol) return true;
  if (pattern.endsWith("*")) return symbol.startsWith(pattern.slice(0, -1));
  return symbol.endsWith("." + pattern) || symbol.endsWith("/" + pattern);
}

function severityRank(s: RuntimeEvent["severity"] | undefined): number {
  if (s === "critical") return 4;
  if (s === "high") return 3;
  if (s === "medium") return 2;
  if (s === "low") return 1;
  return 0;
}
