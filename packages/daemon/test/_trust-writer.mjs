// Child-process worker for trust-lock.mjs: set CLAUDE_CONFIG_DIR, wait for the shared
// start instant (so all N children hit the read-modify-write window at once → maximal
// contention), then ensureTrusted(dir). Exits 0 on success, 1 on throw.
import { ensureTrusted } from "../dist/pty/claude-config.js";

const [, , configDir, dir, startAt] = process.argv;
process.env.CLAUDE_CONFIG_DIR = configDir;

const t = Number(startAt);
const wait = t - Date.now();
if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);

try {
  ensureTrusted(dir);
  process.exit(0);
} catch (err) {
  console.error(`writer ${dir} threw:`, err);
  process.exit(1);
}
