import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, type ToolName } from "@invariance/gps-schemas";

// Import the server module for its exports without binding stdio.
process.env.GPS_MCP_NO_CONNECT = "1";

let listTools: typeof import("./server.js").listTools;

beforeAll(async () => {
  const mod = await import("./server.js");
  listTools = mod.listTools;
}, 30_000);

describe("MCP server surface", () => {
  it("boots and lists every registered tool with a usable schema", () => {
    const tools = listTools();
    expect(tools.length).toBe(Object.keys(TOOLS).length);
    expect(tools.length).toBeGreaterThanOrEqual(40);
    for (const t of tools) {
      expect(t.name).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema).toHaveProperty("type");
    }
  });

  it("has a dispatch arm for every tool in the registry", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = await readFile(path.join(here, "server.ts"), "utf8");
    for (const name of Object.keys(TOOLS) as ToolName[]) {
      expect(source).toContain(`case "${name}"`);
    }
  });
});
