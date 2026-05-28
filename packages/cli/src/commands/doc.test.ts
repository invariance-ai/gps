import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { registerDoc } from "./doc.js";

function docCommand(): Command {
  const program = new Command();
  registerDoc(program);
  const cmd = program.commands.find((c) => c.name() === "doc");
  if (!cmd) throw new Error("doc command not registered");
  return cmd;
}

describe("registerDoc", () => {
  it("registers a `doc` command", () => {
    expect(docCommand().name()).toBe("doc");
  });

  it("exposes the expected options", () => {
    const flags = docCommand().options.map((o) => o.long);
    expect(flags).toEqual(
      expect.arrayContaining([
        "--pr",
        "--base",
        "--out",
        "--diff-view",
        "--no-llm",
        "--api-key",
        "--model",
        "--max-diff-bytes",
        "--print-md",
        "--json",
        "--root",
      ]),
    );
  });
});
