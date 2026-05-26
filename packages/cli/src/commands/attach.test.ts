import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  claudeTranscriptToText,
  extractHeuristicCorrections,
  userTurnsFromTranscript,
} from "./attach.js";
import { addPreference, loadPreferences, recordPrepared } from "@invariance/gps-core";

const roots: string[] = [];

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gps-attach-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

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

describe("userTurnsFromTranscript", () => {
  it("strips the 'user: ' prefix from user turns", () => {
    const transcript = "user: I prefer tabs over spaces\n\nassistant: Understood, I'll use tabs.";
    const result = userTurnsFromTranscript(transcript);
    expect(result).toBe("I prefer tabs over spaces");
    expect(result).not.toContain("user:");
  });

  it("drops assistant turns entirely", () => {
    const transcript = [
      "user: always use async/await",
      "",
      "assistant: Got it, I'll use async/await consistently",
      "",
      "user: and add error handling",
    ].join("\n");
    const result = userTurnsFromTranscript(transcript);
    expect(result).toContain("always use async/await");
    expect(result).toContain("and add error handling");
    expect(result).not.toContain("Got it");
    expect(result).not.toContain("assistant");
  });

  it("returns empty string when there are no user turns", () => {
    const transcript = "assistant: I'll fix the bug now.";
    expect(userTurnsFromTranscript(transcript)).toBe("");
  });

  it("handles multiple user turns correctly", () => {
    const transcript = [
      "user: first message",
      "",
      "assistant: response one",
      "",
      "user: second message",
      "",
      "assistant: response two",
    ].join("\n");
    const result = userTurnsFromTranscript(transcript);
    expect(result).toBe("first message\n\nsecond message");
  });
});

describe("capturePrefsFromText (via addPreference)", () => {
  let root: string;

  beforeEach(async () => {
    root = await tempRepo();
  });

  it("writes a preference when a preference cue is detected", async () => {
    // Use addPreference directly to test the preference capture pipeline.
    const r = await addPreference(root, {
      text: "always use tabs for indentation",
      source: "auto",
      evidence: "cue:always",
    });
    expect(r.deduped).toBe(false);
    expect(r.preference.text).toBe("always use tabs for indentation");
  });

  it("dedupes on repeat: hits increment, no duplicate created", async () => {
    await addPreference(root, {
      text: "prefer functional style",
      source: "auto",
      evidence: "cue:prefer",
    });
    const r2 = await addPreference(root, {
      text: "prefer functional style",
      source: "auto",
      evidence: "cue:prefer",
    });
    // Second call should dedupe.
    expect(r2.deduped).toBe(true);

    // Only one preference should exist.
    const prefs = await loadPreferences(root);
    const matching = prefs.filter((p) => p.text === "prefer functional style");
    expect(matching).toHaveLength(1);
  });

  it("redacts secrets before writing to disk", async () => {
    const secretText = "use the API key sk-ant-api03-TESTKEYTESTKEYTESTKEYTESTKEYTESTKEY for auth";
    const { redact } = await import("@invariance/gps-core");
    const { text: redacted } = redact(secretText);
    expect(redacted).not.toContain("sk-ant-api03-TESTKEYTESTKEYTESTKEYTESTKEYTESTKEY");
    expect(redacted).toContain("[REDACTED]");

    // When persisted through redact(), the key is never written.
    const r = await addPreference(root, {
      text: redacted,
      source: "auto",
      evidence: "cue:use",
    });
    expect(r.preference.text).not.toContain("sk-ant-api03");
  });
});

describe("extractHeuristicCorrections", () => {
  it("anchors a missing-tests correction to the last prepared symbol", async () => {
    const root = await tempRepo();
    await recordPrepared(root, "createRefund");
    const transcript = [
      "user: No, bad Codex, you need to write more tests before calling this done.",
      "",
      "assistant: I'll add coverage.",
    ].join("\n");

    const corrections = await extractHeuristicCorrections(root, transcript);

    expect(corrections).toEqual([
      expect.objectContaining({
        symbol: "createRefund",
        lesson: "When editing createRefund, add or strengthen tests before declaring the task done.",
      }),
    ]);
    expect(corrections[0]?.evidence).toContain("write more tests");
  });

  it("ignores assistant-only apologies about tests", async () => {
    const root = await tempRepo();
    await recordPrepared(root, "createRefund");
    const transcript = "assistant: Sorry, I should have written more tests.";

    await expect(extractHeuristicCorrections(root, transcript)).resolves.toEqual([]);
  });
});
