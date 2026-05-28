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
  it("registers the experimental live docs command", () => {
    expect(docCommand().name()).toBe("doc");
    expect(docCommand().description()).toMatch(/experimental/i);
  });

  it("requires an explicit experimental feature flag option", () => {
    const flags = docCommand().options.map((o) => o.long);
    expect(flags).toEqual(
      expect.arrayContaining([
        "--experimental-live-docs",
        "--serve",
        "--host",
        "--port",
        "--base",
        "--out",
        "--json",
        "--root",
      ]),
    );
  });
});
