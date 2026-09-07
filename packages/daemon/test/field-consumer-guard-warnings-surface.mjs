import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 10787759 — DoD-2 acceptance evidence. profile-field-consumer-guard.mjs's own header says a carded
// gap "must NEVER read as an ordinary silent green... print loudly... regardless of pass/fail." Before this
// card it PASSED and its declared-gap block was printed, but scripts/test-daemon.mjs only ever echoes a
// FAILING file's captured stdout — so on a real, green gate run the gap text reached nobody (this card's
// own measurement: running the guard directly finds 23 case-insensitive "gap" hits; running it through the
// runner found ZERO mentions of the tracking card, `0770d916`). This file proves the fix the same way card
// 22d995ca's own warn-marker-surfaces-on-pass.mjs proved the underlying mechanism — reused directly, not
// re-invented — across the SAME two channels:
//   (tier 1) the runner's OWN aggregate stdout (test-daemon.mjs's `declaredWarnings`/`WARN_LINE_RE` scan).
//   (tier 2) the SAME bounded `outputTail` ring + persisted spill file `runGateStep` (the REAL function
//            every worker self-check and merge gate calls, compiled dist) hands back for a PASSING step —
//            the channel a manager's `gate_status(opId)` actually reads.
//
// Deliberately drives the REAL guard against the REAL PROFILE_FIELD_CONSUMERS registry (not a synthetic
// fixture) — this is the actual specimen the card was filed about, and card `0770d916`'s currently-open
// gaps are exactly what must reach both channels. If a future change closes every one of card 0770d916's
// gaps, this file's positive-path checks will start failing — that is the CORRECT outcome (it means the
// registry that fed this test changed shape and the assertions need updating alongside it), not a flake to
// work around.
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/field-consumer-guard-warnings-surface.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = path.join(__dirname, "..");
const SCRIPT_REL = "scripts/test-daemon.mjs";
const TRACKING_CARD_ID = "0770d916";

const { runGateStep } = await import("../dist/orchestration/gate-runner.js");

let failures = 0;
const check = (label, cond, diagnostic) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (diagnostic) console.log(`  actual: ${diagnostic()}`); }
};

// [prerequisite, not itself a channel check] confirm the real guard, run directly, still declares gaps
// tracked by TRACKING_CARD_ID today — if this is false the two channel checks below would pass vacuously
// (nothing to surface), so this is the positive control the rest of the file depends on.
{
  const direct = spawn(process.execPath, ["test/profile-field-consumer-guard.mjs"], { cwd: DAEMON_ROOT });
  let stdout = "";
  direct.stdout.on("data", (d) => { stdout += d; });
  const status = await new Promise((resolve) => direct.on("close", resolve));
  check("[prerequisite] the real guard, run directly, still exits 0 (a declared gap is non-blocking)", status === 0);
  check(
    `[prerequisite] the real guard, run directly, still declares a gap tracked by card ${TRACKING_CARD_ID}`,
    stdout.includes(`WARN  card ${TRACKING_CARD_ID}:`),
    () => `direct stdout tail: ${JSON.stringify(stdout.slice(-800))}`,
  );
}

// ── TIER 1 — the runner's own aggregate stdout ─────────────────────────────────────────────────────────

function runEntryPoint() {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(process.execPath, [SCRIPT_REL, "--only=profile-field-consumer-guard"], { cwd: DAEMON_ROOT });
    child.stdout.on("data", (d) => { stdout += d; });
    // "close" (not "exit"): waits for this test's OWN stdio pipe to finish delivering whatever bytes the
    // child sent — same sound instrument warn-marker-surfaces-on-pass.mjs already uses.
    child.on("close", (status) => resolve({ status, stdout }));
  });
}

{
  const r = await runEntryPoint();
  check("[tier 1] entry point exits 0 — a declared gap is non-blocking through the runner too", r.status === 0);
  check("[tier 1] the runner's own aggregate stdout contains a WARNINGS: block", r.stdout.includes("WARNINGS:"));
  check(
    `[tier 1, THE CARD] the WARNINGS: block names the tracking card (${TRACKING_CARD_ID}) — dark before this fix`,
    r.stdout.includes(TRACKING_CARD_ID),
    () => `stdout tail: ${JSON.stringify(r.stdout.slice(-1500))}`,
  );
}

// [negative control] a card id that was never declared must be reported absent — so the `includes` checks
// above aren't vacuously true (this WOULD pass on any stdout, including a broken/empty one).
{
  const r = await runEntryPoint();
  check("[negative control] a card id that was never declared is correctly absent", !r.stdout.includes("CARDIDNEVERDECLAREDXYZ"));
}

// ── TIER 2 — the channel a manager's gate_status(opId) actually reads for a PASSING gate step ─────────────

{
  const outDir = mkdtempManaged("loom-field-consumer-guard-warn-spill-");
  const spillFile = path.join(outDir, "field-consumer-guard-warnings.log");
  const res = await runGateStep(
    `node ${SCRIPT_REL} --only=profile-field-consumer-guard`,
    DAEMON_ROOT,
    60_000,
    undefined,
    true, undefined, undefined,
    spillFile,
  );
  check("[tier 2] the step passed (status 0) — a declared gap never fails the gate", res.status === 0);
  check(
    "[tier 2, THE CARD] outputTail (the SAME bounded ring gate_status(opId) returns for a PASSING step) contains the tracking card id",
    typeof res.outputTail === "string" && res.outputTail.includes(TRACKING_CARD_ID),
    () => `outputTail length=${res.outputTail?.length}, tail: ${JSON.stringify(res.outputTail)}`,
  );
  check("[tier 2] res.outputFile names the exact spillFile path passed in", res.outputFile === spillFile);
  if (res.outputFile) {
    const spilled = fs.readFileSync(res.outputFile, "utf8");
    check(
      "[tier 2] the persisted full-output spill file also contains the tracking card id",
      spilled.includes(TRACKING_CARD_ID),
    );
  }
}

console.log(`\n${failures === 0 ? "✅" : "❌"} field-consumer-guard-warnings-surface: ${failures} check(s) failed.`);
await finishAndExit(failures === 0 ? 0 : 1);
