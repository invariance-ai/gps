import { describe, expect, it } from "vitest";
import { resolveCmd } from "./install.js";

describe("resolveCmd", () => {
  it("errors when both --use-global and --use-local are passed", () => {
    expect(() => resolveCmd({ useGlobal: true, useLocal: true })).toThrow(
      /mutually exclusive/,
    );
  });

  it("returns the global shape under --use-global", () => {
    const spec = resolveCmd({ useGlobal: true });
    expect(spec.mode).toBe("global");
    expect(spec.shell).toBe("gps");
    expect(spec.command).toBe("gps");
    expect(spec.baseArgs).toEqual([]);
  });

  it("under --use-local in dev (tsx/vitest) throws with a build hint", () => {
    // Tests run against .ts source, so the running script doesn't end in .js
    // and localBinPath() correctly returns null. The error must tell the user
    // what to do — that hint is the whole point of failing fast here.
    expect(() => resolveCmd({ useLocal: true })).toThrow(/pnpm -r build/);
  });

  it("respects CI=1 → default to npx mode regardless of workspace detection", () => {
    const prev = process.env.CI;
    process.env.CI = "1";
    try {
      const spec = resolveCmd({});
      expect(spec.mode).toBe("npx");
      expect(spec.command).toBe("npx");
      expect(spec.baseArgs).toEqual(["-y", "@invariance/gps"]);
      expect(spec.shell).toBe("npx -y @invariance/gps");
    } finally {
      if (prev === undefined) delete process.env.CI;
      else process.env.CI = prev;
    }
  });

  it("falls back to npx in dev (no built dist to detect) when no flags given", () => {
    const prev = process.env.CI;
    delete process.env.CI;
    try {
      // Under vitest the running script is .ts, so workspace auto-detect can't
      // resolve a built bin and we land on the npx default. Once dist exists
      // and is outside node_modules, auto-detect would pick local instead.
      const spec = resolveCmd({});
      expect(spec.mode).toBe("npx");
    } finally {
      if (prev !== undefined) process.env.CI = prev;
    }
  });
});
