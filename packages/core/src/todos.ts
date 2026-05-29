import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { TodoItem, type TodoItem as TodoItemT, type Note as NoteT } from "@invariance/gps-schemas";
import { loadAllNotes } from "./notes.js";

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

/**
 * Convert a `source: todo` note (lifted from a `TODO(symbol):` comment by
 * `learn-todos`) into a TodoItem so `gps todos` surfaces it. Without this the
 * lifted comments only show up via recall/prepare and `gps todos` looks empty.
 */
function todoNoteToItem(note: NoteT): TodoItemT | undefined {
  const [file, lineRaw] = (note.evidence ?? "").split(":");
  if (!file) return undefined;
  const line = lineRaw ? Number.parseInt(lineRaw, 10) : undefined;
  return TodoItem.parse({
    id: idFor(file, note.lesson, "todo"),
    file,
    line: Number.isInteger(line) ? line : undefined,
    symbol: note.symbol,
    text: note.lesson.trim(),
    source: "todo",
    created_at: note.recorded_at,
  });
}

async function loadTodoNotes(root: string): Promise<TodoItemT[]> {
  const notes = await loadAllNotes(root).catch(() => [] as NoteT[]);
  const out: TodoItemT[] = [];
  for (const note of notes) {
    if (note.source !== "todo") continue;
    const item = todoNoteToItem(note);
    if (item) out.push(item);
  }
  return out;
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

/**
 * Like {@link listTodos} but also surfaces `source: todo` notes that
 * `learn-todos` lifted from `TODO(symbol):` / `FIXME(symbol):` comments. This is
 * what the `gps todos` command shows so lifted comments aren't invisible. Recall
 * deliberately keeps using {@link listTodos} (todos.json only) because lifted
 * comments already surface there as `note` hits.
 */
export async function listTodosWithNotes(
  root: string,
  filter: ListTodosFilter = {},
): Promise<TodoItemT[]> {
  const [stored, noteTodos] = await Promise.all([loadTodos(root), loadTodoNotes(root)]);
  const byId = new Map<string, TodoItemT>();
  for (const t of [...stored, ...noteTodos]) {
    if (!byId.has(t.id)) byId.set(t.id, t);
  }
  return [...byId.values()].filter((t) => {
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

