import { beforeAll, describe, expect, it } from "vitest";
import { TOOLS, type ToolName } from "@invariance/gps-schemas";

// Import the server module for its exports without binding stdio.
process.env.GPS_MCP_NO_CONNECT = "1";

let listTools: typeof import("./server.js").listTools;
let dispatch: typeof import("./server.js").dispatch;

beforeAll(async () => {
  const mod = await import("./server.js");
  listTools = mod.listTools;
  dispatch = mod.dispatch;
});

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

  it("has a dispatch arm for every tool in the registry (no 'not implemented')", async () => {
    // Calling dispatch with empty args may error for many reasons (missing
    // index, validation), but it must never report a missing dispatch case —
    // that would mean a tool was added to TOOLS without wiring its handler.
    for (const name of Object.keys(TOOLS) as ToolName[]) {
      try {
        await dispatch(name, {});
      } catch (e) {
        expect((e as Error).message).not.toMatch(/dispatch not implemented/i);
      }
    }
  });
});
