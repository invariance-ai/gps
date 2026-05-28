import { describe, expect, it } from "vitest";
import type { DocAnnotateRequest } from "@invariance/gps-schemas";
import { GpsLlm } from "./client.js";
import { annotateDiff } from "./doc_annotate.js";

const reqs: DocAnnotateRequest[] = [
  { file: "a.ts", start_line: 1, end_line: 3, language: "typescript", code: "const x = 1;" },
  { file: "b.ts", start_line: 5, end_line: 6, language: "typescript", code: "const y = 2;" },
];

describe("annotateDiff", () => {
  it("returns no annotations and no prompt for an empty request list", async () => {
    const res = await annotateDiff(new GpsLlm({ dryRun: true }), []);
    expect(res.annotations).toEqual([]);
    expect(res.dry_run_prompt).toBeUndefined();
  });

  it("surfaces the prompt and persists nothing in dry-run", async () => {
    const res = await annotateDiff(new GpsLlm({ dryRun: true }), reqs);
    expect(res.annotations).toEqual([]);
    expect(res.dry_run_prompt?.system).toMatch(/annotation/i);
    expect(res.dry_run_prompt?.user).toContain("a.ts");
  });

  it("maps a fenced YAML response back to file/line ranges by id", async () => {
    const fake = {
      complete: async () => ({
        text: "```yaml\n- id: 0\n  text: Initializes x.\n- id: 1\n  text: Initializes y.\n```",
      }),
    } as unknown as GpsLlm;
    const res = await annotateDiff(fake, reqs);
    expect(res.annotations).toHaveLength(2);
    expect(res.annotations[0]).toMatchObject({
      file: "a.ts",
      start_line: 1,
      end_line: 3,
      kind: "llm",
      text: "Initializes x.",
    });
    expect(res.annotations[1]!.file).toBe("b.ts");
  });

  it("drops malformed / unknown-id entries", async () => {
    const fake = {
      complete: async () => ({
        text: "```yaml\n- id: 9\n  text: out of range\n- id: 0\n  text: ''\n- nope: true\n```",
      }),
    } as unknown as GpsLlm;
    const res = await annotateDiff(fake, reqs);
    expect(res.annotations).toEqual([]); // id 9 unknown, id 0 empty text, last malformed
  });
});
