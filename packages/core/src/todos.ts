import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { TodoItem, type TodoItem as TodoItemT } from "@invariance/gps-schemas";

const REL = ".gps/todos.json";

export function todosPath(root: string): string {
  return path.join(root, REL);
}

function idFor(file: string, text: string, source: string): string {
  return createHash("sha1")
    .update(`${file}|${source}|${text.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 12);
}

export async function loadTodos(root: string): Promise<TodoItemT[]> {
  try {
    const raw = await readFile(todosPath(root), "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.map((d: unknown) => TodoItem.parse(d));
  } catch {
    return [];
  }
}

async function persist(root: string, todos: TodoItemT[]): Promise<void> {
  const file = todosPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, JSON.stringify(todos, null, 2));
  await rename(tmp, file);
}

export interface AddTodoOpts {
  file: string;
  line?: number;
  symbol?: string;
  text: string;
  source: "failure" | "note" | "manual";
}

export interface AddTodoResult {
  todo: TodoItemT;
  deduped: boolean;
}

export async function addTodo(root: string, opts: AddTodoOpts): Promise<AddTodoResult> {
  const id = idFor(opts.file, opts.text, opts.source);
  const existing = await loadTodos(root);
  const dupe = existing.find((t) => t.id === id && !t.resolved_at);
  if (dupe) {
    return { todo: dupe, deduped: true };
  }
  const todo: TodoItemT = TodoItem.parse({
    id,
    file: opts.file,
    line: opts.line,
    symbol: opts.symbol,
    text: opts.text.trim(),
    source: opts.source,
    created_at: new Date().toISOString(),
  });
  const next = [...existing, todo];
  await persist(root, next);
  return { todo, deduped: false };
}

export interface ListTodosFilter {
  file?: string;
  symbol?: string;
  includeResolved?: boolean;
}

export async function listTodos(root: string, filter: ListTodosFilter = {}): Promise<TodoItemT[]> {
  const all = await loadTodos(root);
  return all.filter((t) => {
    if (!filter.includeResolved && t.resolved_at) return false;
    if (filter.file && t.file !== filter.file) return false;
    if (filter.symbol && t.symbol !== filter.symbol) return false;
    return true;
  });
}

export async function resolveTodo(root: string, id: string): Promise<boolean> {
  const all = await loadTodos(root);
  const t = all.find((x) => x.id === id);
  if (!t || t.resolved_at) return false;
  t.resolved_at = new Date().toISOString();
  await persist(root, all);
  return true;
}

