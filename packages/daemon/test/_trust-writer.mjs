// Child-process worker for trust-lock.mjs: set CLAUDE_CONFIG_DIR, wait for the shared
// start instant (so all N children hit the read-modify-write window at once → maximal
// contention), then ensureTrustedResilient(dir). Exits 0 on success, 1 on throw.
//
// Card a295432b: this used to call bare `ensureTrusted`, which has no retry beyond
// writeJsonAtomic/withTrustLock's own small inner budget — the shape that genuinely exhausts under
// 12-concurrent-writer load (trust-lock.mjs's own (a) iter3 specimen). Production never calls bare
// ensureTrusted on the spawn path at all; `host.ts`'s `ensureTrustedAndReportDegrade` always goes
// through `ensureTrustedResilient` (card f024f21b), which wraps it with ONE bounded whole-call retry
// specifically for this exhaustion shape. Per decisions 53e64114/f024f21b, the fix for a repeat of this
// is that outer whole-call retry, never a wider inner budget — so this aligns the test with
// production's only call site instead of widening transientFsRetryLimit()'s default.
import { ensureTrustedResilient } from "../dist/pty/claude-config.js";

const [, , configDir, dir, startAt] = process.argv;
process.env.CLAUDE_CONFIG_DIR = configDir;

const t = Number(startAt);
const wait = t - Date.now();
if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);

try {
  ensureTrustedResilient(dir);
  process.exit(0);
} catch (err) {
  console.error(`writer ${dir} threw:`, err);
  process.exit(1);
}
