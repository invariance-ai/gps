import { describe, it, expect } from "vitest";
import { splitDiffByFile } from "./diff_split.js";

describe("splitDiffByFile", () => {
  it("returns [] for an empty diff", () => {
    expect(splitDiffByFile("")).toEqual([]);
    expect(splitDiffByFile("   \n  ")).toEqual([]);
  });

  it("splits a multi-file diff and classifies status", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      " keep",
      "+added",
      " keep",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+line one",
      "+line two",
    ].join("\n");
    const segs = splitDiffByFile(diff);
    expect(segs.map((s) => [s.path, s.status])).toEqual([
      ["src/a.ts", "modified"],
      ["src/new.ts", "added"],
    ]);
    expect(segs[0]!.hunks).toEqual([{ file: "src/a.ts", start_line: 1, end_line: 3 }]);
  });

  it("detects deletions via +++ /dev/null", () => {
    const diff = [
      "diff --git a/src/gone.ts b/src/gone.ts",
      "deleted file mode 100644",
      "--- a/src/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-was here",
      "-and here",
    ].join("\n");
    const [seg] = splitDiffByFile(diff);
    expect(seg!.status).toBe("deleted");
    expect(seg!.path).toBe("src/gone.ts");
    expect(seg!.binary).toBe(false);
  });

  it("detects binary files and emits no hunks", () => {
    const diff = [
      "diff --git a/img.png b/img.png",
      "index 0000..1111 100644",
      "Binary files a/img.png and b/img.png differ",
    ].join("\n");
    const [seg] = splitDiffByFile(diff);
    expect(seg!.binary).toBe(true);
    expect(seg!.path).toBe("img.png");
    expect(seg!.hunks).toEqual([]);
  });

  it("detects renames", () => {
    const diff = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 95%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1 +1,2 @@",
      " keep",
      "+added",
    ].join("\n");
    const [seg] = splitDiffByFile(diff);
    expect(seg!.status).toBe("renamed");
    expect(seg!.path).toBe("new.ts");
    expect(seg!.old_path).toBe("old.ts");
  });
});
