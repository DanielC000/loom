import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 22d995ca — DoD-2 acceptance evidence. Proves the declared-warning signal scripts/test-daemon.mjs
// now prints on a PASSING run (its own `declaredWarnings`/`WARN_LINE_RE` block) reaches TWO channels, not
// just one:
//   (tier 1) the runner's OWN aggregate stdout — proves the emitter (a test's `WARN  ` line) and the
//            runner (test-daemon.mjs's scan) are wired correctly.
//   (tier 2) the SAME bounded `outputTail` ring + persisted spill file `runGateStep` (the REAL function
//            every worker self-check and merge gate calls, compiled dist) hands back for a PASSING step
//            — the channel a manager's `gate_status(opId)` actually reads, and the SAME artifact this
//            card's own investigation grepped directly (`~/.loom/gate-output/`). Tier 1 alone does NOT
//            prove tier 2: gate-output-spill.mjs's own (B) already establishes that a PASSING step's
//            `outputTail` is ALWAYS the plain POSITIONAL trailing ring (never content-selected — that
//            branch is failure-only), so whether the warning survives depends on WHERE in test-daemon.mjs's
//            own output it's printed, not merely that it's printed at all. This file measures both tiers
//            directly instead of assuming tier 1 implies tier 2.
//
// warn-marker-declared-warning-fixture.mjs (this dir) is the deliberately-quiet-unless-armed target: it
// only prints a WARN line when LOOM_TEST_DECLARED_WARNING_MARKER is set, so a normal full-suite run always
// takes its plain-pass branch and none of this file's env-var-gated invocations ever pollute a real gate
// run with a spurious WARNINGS: block (mirrors test-daemon-failures-epilogue-flush.mjs's own
// epilogue-flush-fixture.mjs convention for testing this same runner's epilogue behavior).
//
// Tier 1 drives the REAL entry point (`node scripts/test-daemon.mjs --only=...`, a real child process —
// never by importing test-daemon.mjs's internals directly). Tier 2 drives the REAL `runGateStep` from the
// compiled `dist/orchestration/gate-runner.js`, wrapped around that SAME entry-point command (functionally
// identical to this project's actual gateCommand's second step, `pnpm --filter @loom/daemon test:daemon`
// — the pnpm wrapper adds nothing gate-runner.ts's own capture logic would treat differently, so invoking
// `node scripts/test-daemon.mjs` directly is the cheaper, equally-faithful form).
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/warn-marker-surfaces-on-pass.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = path.join(__dirname, "..");
const SCRIPT_REL = "scripts/test-daemon.mjs";

const { runGateStep } = await import("../dist/orchestration/gate-runner.js");

let failures = 0;
const check = (label, cond, diagnostic) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (diagnostic) console.log(`  actual: ${diagnostic()}`); }
};

const MARKER = "WMD22D995CA";

function runEntryPoint(marker) {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(process.execPath, [SCRIPT_REL, "--only=warn-marker-declared-warning-fixture"], {
      cwd: DAEMON_ROOT,
      env: { ...process.env, ...(marker ? { LOOM_TEST_DECLARED_WARNING_MARKER: marker } : {}) },
    });
    child.stdout.on("data", (d) => { stdout += d; });
    // "close" (not "exit"): waits for this test's OWN stdio pipe to actually finish delivering whatever
    // bytes the child sent — same sound instrument test-daemon-failures-epilogue-flush.mjs already uses.
    child.on("close", (status) => resolve({ status, stdout }));
  });
}

// ── TIER 1 ──────────────────────────────────────────────────────────────────────────────────────────────

// [harness sanity / negative control] unarmed: the fixture's own plain pass, no WARN line, no WARNINGS:
// block — confirms the wiring (spawn, --only= selection) is sound, and that this test's own env var is
// genuinely OFF by default, before the armed case below is trusted either way.
{
  const r = await runEntryPoint(undefined);
  check("[tier 1, unarmed] entry point exits 0", r.status === 0);
  check("[tier 1, unarmed] no WARNINGS: block printed", !r.stdout.includes("WARNINGS:"));
  check("[tier 1, unarmed] no declared-warning line from the fixture", !r.stdout.includes("-DECLARED-WARNING"));
}

// [THE TEST, tier 1] armed: the fixture emits a WARN line and STILL passes; the runner's own aggregate
// stdout must surface it in a WARNINGS: block.
{
  const r = await runEntryPoint(MARKER);
  check("[tier 1, armed] entry point STILL exits 0 — a declared warning is non-blocking", r.status === 0);
  check("[tier 1, armed] the runner's own aggregate stdout contains a WARNINGS: block", r.stdout.includes("WARNINGS:"));
  check(
    "[tier 1, armed] the WARNINGS: block quotes the fixture's exact declared-warning line",
    r.stdout.includes(`${MARKER}-DECLARED-WARNING`),
    () => JSON.stringify(r.stdout.slice(-1500)),
  );
}

// [negative control] a marker that was never sent must be reported absent — so the `includes` checks
// above aren't vacuously true.
{
  const r = await runEntryPoint(MARKER);
  check("[negative control] a marker that was never armed is correctly absent", !r.stdout.includes("MARKER-NEVER-SENT-XYZ"));
}

// ── TIER 2 — the channel a manager's gate_status(opId) actually reads for a PASSING gate step ─────────────

{
  const outDir = mkdtempManaged("loom-warn-marker-spill-");
  const spillFile = path.join(outDir, "warn-marker-armed.log");
  const res = await runGateStep(
    `node ${SCRIPT_REL} --only=warn-marker-declared-warning-fixture`,
    DAEMON_ROOT,
    30_000,
    { LOOM_TEST_DECLARED_WARNING_MARKER: MARKER },
    true, undefined, undefined,
    spillFile,
  );
  check("[tier 2, armed] the step passed (status 0) — a declared warning never fails the gate", res.status === 0);
  check(
    "[tier 2, armed — THE CARD] outputTail (the SAME bounded ring gate_status(opId) returns for a PASSING step) contains the declared-warning line",
    typeof res.outputTail === "string" && res.outputTail.includes(`${MARKER}-DECLARED-WARNING`),
    () => `outputTail length=${res.outputTail?.length}, tail: ${JSON.stringify(res.outputTail)}`,
  );
  check("[tier 2, armed] res.outputFile names the exact spillFile path passed in", res.outputFile === spillFile);
  if (res.outputFile) {
    const spilled = fs.readFileSync(res.outputFile, "utf8");
    check(
      "[tier 2, armed] the persisted full-output spill file (the SAME artifact this card's own investigation grepped in ~/.loom/gate-output/) also contains it",
      spilled.includes(`${MARKER}-DECLARED-WARNING`),
    );
  }
}

// [tier 2, negative control] the UNARMED run through the same real runGateStep: no WARN line was ever
// emitted, so outputTail must NOT contain the marker text either.
{
  const res = await runGateStep(`node ${SCRIPT_REL} --only=warn-marker-declared-warning-fixture`, DAEMON_ROOT, 30_000);
  check("[tier 2, negative control] unarmed run: status 0", res.status === 0);
  check(
    "[tier 2, negative control] unarmed run: outputTail carries no declared-warning line",
    typeof res.outputTail === "string" && !res.outputTail.includes("-DECLARED-WARNING"),
  );
}

console.log(`\n${failures === 0 ? "✅" : "❌"} warn-marker-surfaces-on-pass: ${failures} check(s) failed.`);
await finishAndExit(failures === 0 ? 0 : 1);
