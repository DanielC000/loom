// Card e26f3199 RED-proof: scripts/test-daemon.mjs's runOne used to discard the child's real exit status
// on a timeout, so "completed successfully but 'close' arrived late" (mechanism A — a grandchild inherited
// the stdio pipe and kept it open) was indistinguishable from "genuinely wedged, killed, never exited"
// (mechanism B). This drives the exported `spawnWithTimeout` + `describeTimeoutDetail` directly against
// two purpose-built fixtures that deterministically reproduce each shape, plus pure unit checks of every
// describeTimeoutDetail branch.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnWithTimeout, describeTimeoutDetail, appendGateTimingRow, gateTimingOpId } from "../scripts/test-daemon.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const LATE_CLOSE_PARENT = path.join(FIXTURES_DIR, "_late-close-parent.mjs");
const LATE_CLOSE_GRANDCHILD = path.join(FIXTURES_DIR, "_late-close-grandchild.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Card d1e10795: the card's own findings.md documented this file's INNER upstream margin
// (timeoutFiredAt - exitAt, i.e. how much of the scenario's configured timeoutMs the parent fixture
// actually used before exiting) only from a QUIET, STANDALONE probe run (never committed, never under
// real gate contention). That number is what the promptness-margin population needs a DURATION
// instrument for (this is Shape A — a real numeric elapsed value exists — unlike the Shape B liveness
// sites elsewhere in test/, which have no ceiling to ratio against at all and need this same technique
// applied to a bare elapsed-ms gap instead). Recorded via the SAME best-effort, never-throws,
// LOOM_HOME-relative NDJSON helper the harness's own per-file timing already uses (`appendGateTimingRow`)
// — additive only, never affects `check()`/exit code, so a write failure here can never fail this file or
// the gate that runs it.
//
// ⚠️ Reads `LOOM_REAL_HOME`, NOT `LOOM_HOME`, and this distinction is load-bearing (memory
// `instrument-inside-test-reads-isolated-loom-home` — the bug this fixes, found and initially shipped
// broken on this same card). Under `scripts/test-daemon.mjs`'s harness, every test file is spawned as its
// own child with `LOOM_HOME` DELIBERATELY overridden to a fresh, throwaway per-test temp dir (hermetic
// isolation — unrelated to this instrument, never touch it). A naive `process.env.LOOM_HOME` read here
// would silently capture THAT isolated value and write into a directory the harness deletes right after
// the run — exactly what happened the first time this was written: the file ran clean, the write never
// threw, and the data was just gone. `LOOM_REAL_HOME` is a SEPARATE, ADDITIVE env var `runOne` now sets
// (mirroring how `LOOM_GATE_OP_ID` is already threaded for `gateTimingOpId()` below) carrying the
// harness's own real LOOM_HOME through unchanged. The fallback chain still resolves correctly for a
// direct standalone run (`node test/exit-close-gap.mjs`, no harness): `LOOM_REAL_HOME` is simply unset
// there, so it falls through to the same `LOOM_HOME`-or-homedir default as before.
const LOOM_HOME = process.env.LOOM_REAL_HOME || process.env.LOOM_HOME || path.join(os.homedir(), ".loom");
const PROMPTNESS_MARGIN_NDJSON = path.join(LOOM_HOME, "gate-timing", "d1e10795-promptness-margins.ndjson");
function recordExitCloseMargin(scenario, r, configuredTimeoutMs) {
  appendGateTimingRow(PROMPTNESS_MARGIN_NDJSON, {
    kind: "exit-close-gap-inner",
    scenario,
    opId: gateTimingOpId() ?? null,
    pid: process.pid,
    ts: Date.now(),
    configuredTimeoutMs,
    exitAt: r.exitAt ?? null,
    timeoutFiredAt: r.timeoutFiredAt ?? null,
    exitToCloseGapMs: r.exitToCloseGapMs ?? null,
    // How much of configuredTimeoutMs the parent fixture had left when it exited (timeoutFiredAt - exitAt).
    // Positive and large = mechanism A (exited comfortably before the timer). Negative or near-zero would
    // flip the scenario into mechanism B's shape — see the card's findings.md §3 for why that matters.
    timeoutMinusExitMs: r.exitAt != null && r.timeoutFiredAt != null ? r.timeoutFiredAt - r.exitAt : null,
  });
}

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
  recordExitCloseMargin("mechanismA", r, timeoutMs);
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
  recordExitCloseMargin("contrastB", r, timeoutMs);
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
