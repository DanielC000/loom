// Card e26f3199 RED-proof: scripts/test-daemon.mjs's runOne used to discard the child's real exit status
// on a timeout, so "completed successfully but 'close' arrived late" (mechanism A — a grandchild inherited
// the stdio pipe and kept it open) was indistinguishable from "genuinely wedged, killed, never exited"
// (mechanism B). This drives the exported `spawnWithTimeout` + `describeTimeoutDetail` directly against
// two purpose-built fixtures that deterministically reproduce each shape, plus pure unit checks of every
// describeTimeoutDetail branch.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnWithTimeout, describeTimeoutDetail } from "../scripts/test-daemon.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const LATE_CLOSE_PARENT = path.join(FIXTURES_DIR, "_late-close-parent.mjs");
const LATE_CLOSE_GRANDCHILD = path.join(FIXTURES_DIR, "_late-close-grandchild.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Pure unit checks of describeTimeoutDetail, every branch, independent of any real spawn/timing ---
{
  const alreadyExited = describeTimeoutDetail({ exitAt: 100, exitStatus: 0, exitSignal: null, timeoutFiredAt: 300 });
  check("[positive control] exitAt before timeoutFiredAt, code 0 -> 'child had already exited 0'", alreadyExited === "child had already exited 0");
}
{
  const alreadyExitedSignal = describeTimeoutDetail({ exitAt: 100, exitStatus: null, exitSignal: "SIGTERM", timeoutFiredAt: 300 });
  check("exitAt before timeoutFiredAt via signal -> names the signal, not a fabricated code", alreadyExitedSignal === "child had already exited via signal SIGTERM");
}
{
  const killedThenExited = describeTimeoutDetail({ exitAt: 350, exitStatus: 1, exitSignal: null, timeoutFiredAt: 300 });
  check(
    "exitAt AFTER timeoutFiredAt -> the kill is implicated, worded distinctly from 'already exited'",
    killedThenExited === "killed (exited 1 after kill)" && !killedThenExited.includes("already exited"),
  );
}
{
  const neverExited = describeTimeoutDetail({ exitAt: null, exitStatus: null, exitSignal: null, timeoutFiredAt: 300 });
  check("[negative control] exit never observed -> 'killed, never exited', not a fabricated exit", neverExited === "killed, never exited");
}
{
  const equalTimes = describeTimeoutDetail({ exitAt: 300, exitStatus: 0, exitSignal: null, timeoutFiredAt: 300 });
  check(
    "exitAt === timeoutFiredAt (tie) counts as already-exited, not killed — the child was gone by the time the timer looked",
    equalTimes === "child had already exited 0",
  );
}

// --- REAL spawn, mechanism (A): a fixture that exits 0 almost instantly, whose GRANDCHILD inherits its
// stdio and outlives it — reproduces "printed ALL PASS, close still didn't fire" hermetically.
{
  const grandchildDelayMs = 900; // must clear timeoutMs comfortably so the race isn't tight
  const timeoutMs = 250; // must clear the parent's own near-instant exit comfortably
  const r = await spawnWithTimeout(process.execPath, [LATE_CLOSE_PARENT, String(grandchildDelayMs)], { timeoutMs });
  check(
    "[positive control] the parent-exits-fast/grandchild-holds-pipe fixture DOES trigger the harness timeout (close really was late)",
    r.timedOut === true && r.status === "timeout",
  );
  check("the child's real exit code (0) survived — this is the DEFECT this card fixes: it used to be discarded", r.exitStatus === 0);
  check(
    "exitAt was captured, and it precedes timeoutFiredAt — MEASURED, not argued: mechanism (A)",
    r.exitAt !== null && r.timeoutFiredAt !== null && r.exitAt <= r.timeoutFiredAt,
  );
  check("the exit->close gap is large — this IS mechanism (A), not noise", r.exitToCloseGapMs !== null && r.exitToCloseGapMs > 300);
  check("timeoutDetail reports 'child had already exited 0', not a generic timeout label", r.timeoutDetail === "child had already exited 0");
}

// --- [contrast case] mechanism (B): a fixture that is genuinely still running when the timer fires — no
// grandchild involved, so 'close' should follow the kill promptly, not lag behind it.
{
  const timeoutMs = 250;
  const r = await spawnWithTimeout(process.execPath, [LATE_CLOSE_GRANDCHILD, "5000"], { timeoutMs });
  check("[contrast case] a genuinely still-running child also times out", r.timedOut === true && r.status === "timeout");
  check(
    "[contrast case] its timeoutDetail is NOT the 'already exited' wording — the two mechanisms must not print identically",
    !r.timeoutDetail?.startsWith("child had already exited"),
  );
  check(
    "[contrast case] the exit->close gap is small (no grandchild holding the pipe) — the discriminator actually discriminates",
    r.exitToCloseGapMs === null || r.exitToCloseGapMs < 300,
  );
}

console.log(`\n${failures === 0 ? "✅" : "❌"} exit-close-gap: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
