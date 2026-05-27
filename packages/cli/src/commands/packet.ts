import type { Command } from "commander";
import kleur from "kleur";
import { buildTaskPacket } from "@invariance/gps-core";
import { addRootOption, resolveRoot, type RootOption } from "../root.js";

interface Opts extends RootOption {
  json?: boolean;
}

export function registerPacket(program: Command): void {
  addRootOption(
    program
      .command("packet <symbol>")
      .description("Emit a compact subagent-readable packet for a symbol")
      .option("--json", "Emit JSON instead of markdown"),
  ).action(async (symbol: string, opts: Opts) => {
    const root = resolveRoot(opts);
    try {
      const packet = await buildTaskPacket(root, symbol);
      if (opts.json) {
        console.log(JSON.stringify(packet, null, 2));
        return;
      }
      console.log(`# packet: ${packet.symbol}`);
      if (packet.file) console.log(`file: \`${packet.file}\``);
      if (packet.tests.length > 0) {
        console.log("\n## Learned test commands");
        for (const t of packet.tests) {
          console.log(`- \`${t.command}\` ${kleur.dim(`(${t.pass_count} pass, last ${t.last_passed_at.slice(0, 10)})`)}`);
        }
      }
      if (packet.invariants.length > 0) {
        console.log("\n## Invariants");
        for (const i of packet.invariants) console.log(`- ${i}`);
      }
      if (packet.notes.length > 0) {
        console.log("\n## Notes");
        for (const n of packet.notes.slice(0, 12)) {
          const stale = n.stale ? " stale memory" : "";
          console.log(`- [${n.scope}${stale}] ${n.lesson}`);
        }
      }
      if (packet.mistake_patterns.length > 0) {
        console.log("\n## Recent mistake patterns");
        for (const p of packet.mistake_patterns.slice(0, 5)) {
          console.log(`- ${p.message} ${kleur.dim(`(${p.count}x)`)}`);
        }
      }
      if (packet.recent_failures.length > 0) {
        console.log("\n## Recent failures");
        for (const f of packet.recent_failures.slice(0, 5)) {
          console.log(`- \`${f.command}\` exited ${f.exit} on ${f.at.slice(0, 10)}`);
        }
      }
      console.log("\n## Prepare brief");
      console.log(packet.markdown);
    } catch (e) {
      console.error(kleur.red(`error: ${(e as Error).message}`));
      process.exitCode = 1;
    }
  });
}
