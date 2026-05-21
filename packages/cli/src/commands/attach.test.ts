import { describe, expect, it } from "vitest";
import { claudeTranscriptToText } from "./attach.js";

describe("claudeTranscriptToText", () => {
  it("flattens JSONL into role-tagged prose and drops tool blocks", () => {
    const jsonl = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "validate before conversion" }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "agreed, rejected validate-after" },
            { type: "tool_use", name: "Edit", input: {} },
          ],
        },
      }),
    ].join("\n");
    const out = claudeTranscriptToText(jsonl);
    expect(out).toContain("user: validate before conversion");
    expect(out).toContain("assistant: agreed, rejected validate-after");
    expect(out).not.toContain("tool_use");
    expect(out).not.toContain("Edit");
  });

  it("handles string content and skips empty/unparseable lines", () => {
    const jsonl = [
      "not json",
      JSON.stringify({ message: { role: "user", content: "plain string body" } }),
      JSON.stringify({ message: { role: "assistant", content: [] } }), // empty -> skipped
      "",
    ].join("\n");
    const out = claudeTranscriptToText(jsonl);
    expect(out).toBe("user: plain string body");
  });

  it("falls back to raw text when input is not recognizable JSONL", () => {
    const raw = "just a plain transcript dump\nwith two lines";
    expect(claudeTranscriptToText(raw)).toBe(raw);
  });

  it("keeps the most recent maxChars from the tail", () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      JSON.stringify({ message: { role: "user", content: `msg ${i}` } }),
    ).join("\n");
    const out = claudeTranscriptToText(lines, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).toContain("msg 49"); // tail retained, not the head
    expect(out).not.toContain("msg 0\n");
  });
});
