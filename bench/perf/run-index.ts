import {
  loadConfig,
  scanFiles,
  parseFile,
  buildIndex,
  writeIndex,
  loadParseCache,
  saveParseCache,
} from "@invariance/gps-core";
import { timeIt } from "./measure.js";

export interface IndexResult {
  root: string;
  files: number;
  symbols: number;
  edges: number;
  scan_ms: number;
  parse_ms: number;
  build_ms: number;
  write_ms: number;
  total_ms: number;
}

export async function indexCorpus(root: string): Promise<IndexResult> {
  const config = await loadConfig(root);
  const { ms: scan_ms, result: files } = await timeIt(() => scanFiles(root, config));
  await loadParseCache(root);
  const { ms: parse_ms, result: parsed } = await timeIt(() => Promise.all(files.map((f) => parseFile(f))));
  const { ms: build_ms, result: index } = await timeIt(async () => buildIndex(root, parsed));
  const { ms: write_ms } = await timeIt(() => writeIndex(root, index));
  await saveParseCache(root);
  return {
    root,
    files: files.length,
    symbols: index.symbols.length,
    edges: index.edges.length,
    scan_ms,
    parse_ms,
    build_ms,
    write_ms,
    total_ms: scan_ms + parse_ms + build_ms + write_ms,
  };
}
