// Card 89539537 CR follow-up — `PendingOpRegistry.awaitSettleByOpId`'s RUNNING-entry branch used to race
// `Promise.race([e.settle, sleep(timeoutMs)])` with a bare `sleep` (no handle to clear): when `e.settle`
// won (the overwhelmingly common case — the op settles before the timeout), the loser's `setTimeout` was
// left ARMED and not unref'd, keeping the event loop alive for up to `timeoutMs` after the call had
// already resolved. Fixed by switching to `clearableSleep` + a `finally` clear, mirroring `waitBriefly`'s
// own established pattern in the same file.
//
// A logical assertion on the RETURNED VALUE can never see this — the value is correct either way; only
// whether a timer is still armed afterward can. So this spawns a REAL child process (see
// `_settle-by-opid-leak-child.mjs`) that calls `awaitSettleByOpId` and deliberately never calls
// `process.exit()` itself — Node only exits a process on its own once nothing (no timer, no handle) is
// keeping its event loop alive. A leaked timer means the child is STILL ALIVE well past when the real
// work (a ~50ms settle) finished; a cleared one means it exits almost immediately.
//
// Bounded: never waits for the child's own internal 240_000ms budget to actually elapse — races the
// child's `exit` event against a SHORT bound and kills the spawned child (by the pid WE captured at
// spawn, never by name/port) on timeout, so a genuine leak fails this test in ~1s, not ~4 minutes.
//
// Run standalone: 1) build daemon (pnpm build), 2) node packages/daemon/test/settle-by-opid-no-timer-leak.mjs
// RED/GREEN proof: pnpm --filter @loom/daemon negative-control --file packages/daemon/src/orchestration/pending-ops.ts --test packages/daemon/test/settle-by-opid-no-timer-leak.mjs --ref HEAD
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const childScript = path.join(here, "_settle-by-opid-leak-child.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const BOUND_MS = 3_000; // generous vs. the real ~50ms settle, tiny vs. the child's internal 240_000ms budget

const result = await new Promise((resolve) => {
  const t0 = Date.now();
  const child = spawn(process.execPath, [childScript], { stdio: ["ignore", "pipe", "inherit"] });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill(); // scoped to the exact pid we spawned above — never by name/port/pattern
  }, BOUND_MS);
  child.on("exit", (code) => {
    clearTimeout(timer);
    resolve({ elapsedMs: Date.now() - t0, timedOut, code, stdout: stdout.trim() });
  });
});

check("(leak check) the child process exits on its own well within the bound — no armed timer kept it alive", !result.timedOut);
check(`(leak check) elapsed ${result.elapsedMs}ms is close to the real ~50ms settle, not anywhere near the bound (${BOUND_MS}ms) or the child's internal 240_000ms budget`, result.elapsedMs < BOUND_MS);
if (!result.timedOut) {
  check("(leak check) the child's own awaitSettleByOpId call still returned the correct settled value", result.stdout === JSON.stringify({ ok: true, value: { ok: true } }));
}
console.log(`[timing] child process lifetime: ${result.elapsedMs}ms (bound ${BOUND_MS}ms, timedOut=${result.timedOut})`);

console.log(failures === 0
  ? "\n✅ ALL PASS — awaitSettleByOpId's RUNNING-entry race clears its loser timer: the op's own real ~50ms settle leaves the child process free to exit on its own almost immediately, with nothing still keeping its event loop alive up to the 240_000ms budget it was given."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
