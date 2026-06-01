import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DocManifest, type DocModel, type DocManifest as DocManifestT } from "@invariance/gps-schemas";
import { renderDocHtml, type BrandPalette } from "./html_render.js";
import { renderDocMarkdown } from "./md_render.js";

/**
 * Persist a DocModel's rendered HTML + Markdown under `<out_dir>/`, and keep a
 * `manifest.json` index of every generated doc. Writes are atomic (temp +
 * rename, mirroring claude_md.ts) so a concurrent attach-hook regen can't leave
 * a half-written file.
 */

export interface WriteDocOpts {
  out_dir?: string;
  brand?: BrandPalette;
}

export interface WriteDocResult {
  htmlPath: string;
  mdPath: string;
  manifestPath: string;
  id: string;
}

export async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, content);
  await rename(tmp, file);
}

export function docId(model: DocModel): string {
  if (model.kind === "pr" && model.pr) return `pr-${model.pr.number}`;
  const base = model.base ? slug(model.base) : "head";
  return `repo-${base}`;
}

export function slug(s: string): string {
  const clean = s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "head";
}

export function manifestPath(root: string, outDir: string): string {
  return path.join(root, outDir, "manifest.json");
}

export async function loadManifest(root: string, outDir: string): Promise<DocManifestT> {
  try {
    const raw = await readFile(manifestPath(root, outDir), "utf8");
    return DocManifest.parse(JSON.parse(raw));
  } catch {
    // Missing or corrupt manifest — start fresh (best-effort, like the parse cache).
    return DocManifest.parse({});
  }
}

export async function upsertManifest(
  root: string,
  outDir: string,
  entry: DocManifestT["docs"][number],
): Promise<DocManifestT> {
  const manifest = await loadManifest(root, outDir);
  const next = manifest.docs.filter((d) => d.id !== entry.id);
  next.push(entry);
  next.sort((a, b) => b.generated_at.localeCompare(a.generated_at));
  const updated = DocManifest.parse({ version: 1, docs: next });
  await atomicWrite(manifestPath(root, outDir), JSON.stringify(updated, null, 2));
  return updated;
}

export async function writeDocStore(
  root: string,
  model: DocModel,
  opts: WriteDocOpts = {},
): Promise<WriteDocResult> {
  const outDir = opts.out_dir ?? ".gps/docs";
  const id = docId(model);
  const htmlAbs = path.join(root, outDir, `${id}.html`);
  const mdAbs = path.join(root, outDir, `${id}.md`);

  await atomicWrite(htmlAbs, renderDocHtml(model, opts.brand));
  await atomicWrite(mdAbs, renderDocMarkdown(model));

  await upsertManifest(root, outDir, {
    id,
    kind: model.kind,
    title: model.title,
    html_path: path.relative(root, htmlAbs),
    md_path: path.relative(root, mdAbs),
    generated_at: model.generated_at,
    pr_number: model.pr?.number,
  });

  return {
    htmlPath: path.relative(root, htmlAbs),
    mdPath: path.relative(root, mdAbs),
    manifestPath: path.relative(root, manifestPath(root, outDir)),
    id,
  };
}
