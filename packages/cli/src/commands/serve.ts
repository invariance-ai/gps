import type { Command } from "commander";
import kleur from "kleur";

export function registerServe(program: Command): void {
  program
    .command("serve")
    .description("Start the gps MCP server (stdio)")
    .option(
      "--observe",
      "Record per-symbol query counts to .gps/observations.json (metadata only — symbol name, count, timestamp; never tool arguments or results)",
    )
    .action(async (opts: { observe?: boolean }) => {
      if (opts.observe) process.env.GPS_OBSERVE = "1";
      try {
        await import("@invariance/gps-mcp/dist/server.js");
      } catch (e) {
        console.error(kleur.red(`failed to start MCP server: ${(e as Error).message}`));
        console.error(kleur.dim("hint: did the workspace build? run `pnpm build` from the repo root."));
        process.exitCode = 1;
      }
    });
}
