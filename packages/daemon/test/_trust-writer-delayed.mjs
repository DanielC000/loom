// Child-process worker for trust-lock-pid-liveness.mjs's late-arrival repro (section 0). Unlike
// _trust-writer.mjs's shared-wall-clock `startAt` (defeated here by real, highly variable node process
// startup jitter — measured 130ms+ on this host, dwarfing the sub-200ms windows this repro needs).
// Instead this waits for an OBSERVABLE signal (the lock file actually existing — i.e. the other writer
// has genuinely acquired) before applying a FIXED, CONTROLLED delay of its own — removing BOTH
// processes' own unpredictable startup time from the critical window entirely.
//
// Exits 0 on success, 1 on throw, 2 if the lock never appeared within the bounded poll (a hang guard,
// never silently waits forever).
import fs from "node:fs";
import path from "node:path";
import { ensureTrusted } from "../dist/pty/claude-config.js";

const [, , configDir, dir, delayMs] = process.argv;
process.env.CLAUDE_CONFIG_DIR = configDir;

const isoJson = path.join(configDir, ".claude.json");
const lockPath = `${isoJson}.loom-lock`;
const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const pollStart = Date.now();
while (!fs.existsSync(lockPath)) {
  if (Date.now() - pollStart > 5000) {
    console.error(`_trust-writer-delayed: lock ${lockPath} never appeared within 5000ms`);
    process.exit(2);
  }
  sleep(2);
}
// Lock confirmed present — NOW apply the controlled delay (possibly zero — see the caller's own doc
// for why even delayMs=0 still lands well after the other writer's acquire, thanks to ensureTrusted's
// own fast-path file read), so our first acquire attempt's timing no longer depends on either
// process's own unpredictable startup time.
sleep(Number(delayMs));

try {
  ensureTrusted(dir);
  process.exit(0);
} catch (err) {
  console.error(`_trust-writer-delayed ${dir} threw:`, err);
  process.exit(1);
}
