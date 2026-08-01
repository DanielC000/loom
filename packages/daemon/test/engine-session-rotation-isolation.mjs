// Regression guard for card 7d70b27b — HERMETIC, no daemon, no real claude, no build-dist import (this
// spawns the OTHER test file as a child process; it never imports dist/ itself).
//
// engine-session-rotation.mjs used to write FIXED literal engine ids ("engine-session-alpha/beta/gamma/
// delta") into the REAL ~/.claude/projects/ (engineTranscriptPath always resolves under the real
// os.homedir(), never under a test's tmpHome — see sessions/transcript.ts). resolveTranscriptFile's
// cross-project fallback scan then let a LEFTOVER from one run (its own cleanup skipped — e.g. an
// external test-runner SIGKILL, or a swallowed Windows EBUSY/EPERM) silently answer a LATER run's
// lookup for that same literal name. Proven in production against merge gate c3233e27: `gamma` resolved
// to a stale `found-but-no-usage-line` file where the test required `file-not-found`.
//
// The fix (same card) suffixes every engine id with a per-invocation `${Date.now()}-${process.pid}`, so
// a leftover — however it happened to survive — can never again collide with a fresh run's own lookups.
// This test proves that holds two ways:
//  (a) a PRE-EXISTING leftover directory carrying the OLD-style fixed-literal filename (the exact shape
//      a pre-fix crash would have left behind) does not fool a fresh run — DoD-5's discriminating
//      control. (RED-first evidence that this plant genuinely reproduces the bug against pre-fix code
//      was captured manually during development — see the card's worker_report — this file only checks
//      the post-fix state, since flipping production code mid-run is out of scope for a hermetic test.)
//  (b) the rotation test run TWICE IN A ROW, and CONCURRENTLY WITH ITSELF, both pass — DoD-6/7's
//      cheapest regression check, mirroring the exact "run 1 poisons run 2" production shape.
//
// Cleanup is enumerated and shape-checked before removal — NEVER a blanket delete under
// ~/.claude/projects, which holds real session transcripts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROTATION_TEST = path.join(__dirname, "engine-session-rotation.mjs");
const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

/** Run engine-session-rotation.mjs as a child process; resolves with its exit code + captured output. */
function runRotationTest() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ROTATION_TEST], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

// A leftover directory the SUT itself would create — same `loom-rotate-<ts>-<pid>` shape it names in its
// own tmpHome — so this plant is unambiguously a test artifact, safe to enumerate and remove by name.
const PLANT_LEAF = `C--Users-plant-loom-rotate-${Date.now()}-${process.pid}`;
const PLANT_SHAPE_RE = /^C--Users-plant-loom-rotate-\d+-\d+$/;
const plantDir = path.join(PROJECTS_ROOT, PLANT_LEAF);

try {
  // === (a) DoD-5: plant a stale, OLD-style fixed-literal leftover BEFORE running. ===
  fs.mkdirSync(plantDir, { recursive: true });
  fs.writeFileSync(
    path.join(plantDir, "engine-session-gamma.jsonl"),
    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "stale leftover" }] } })}\n`,
  );
  console.log(`planted stale fixed-literal fixture at ${plantDir}`);

  const withPlant = await runRotationTest();
  check("(a) rotation test passes WITH a stale fixed-literal leftover present (discriminating control for card 7d70b27b)", withPlant.code === 0);
  if (withPlant.code !== 0) console.log("--- output ---\n", withPlant.stdout, withPlant.stderr);

  // === (b) DoD-6: run it again immediately — the exact "run 1 poisons run 2" production shape. ===
  const second = await runRotationTest();
  check("(b) a SECOND back-to-back run also passes — no self-poisoning between runs", second.code === 0);
  if (second.code !== 0) console.log("--- output ---\n", second.stdout, second.stderr);

  // === (c) DoD-7: two invocations CONCURRENTLY — unique ids must not collide even while both are live. ===
  const [concA, concB] = await Promise.all([runRotationTest(), runRotationTest()]);
  check("(c) two CONCURRENT invocations both pass — per-invocation ids don't collide while both are live", concA.code === 0 && concB.code === 0);
  if (concA.code !== 0) console.log("--- concurrent A output ---\n", concA.stdout, concA.stderr);
  if (concB.code !== 0) console.log("--- concurrent B output ---\n", concB.stdout, concB.stderr);
} finally {
  // Enumerate + shape-check before removing — never a blanket delete under ~/.claude/projects, which
  // holds real session transcripts alongside this test's own fixtures.
  if (fs.existsSync(plantDir) && PLANT_SHAPE_RE.test(path.basename(plantDir))) {
    console.log(`cleanup: removing planted fixture dir ${plantDir}`);
    fs.rmSync(plantDir, { recursive: true, force: true });
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — engine-session-rotation.mjs is self-isolating: a stale fixed-literal leftover can't " +
    "poison it, and back-to-back / concurrent runs never poison each other."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
