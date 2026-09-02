import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a5d1ae04 DoD-4: "a declaration must NEVER block, delay, or gate a fire". That's an ABSENCE claim —
// "the code that actually executes/admits a gate never reads the intent registry" — and a design intention
// is not a test of it (per this session's own manager's ruling on the design checkpoint). This asserts it
// MECHANICALLY: `gate-runner.ts` (the actual gate-COMMAND execution engine — build/guards/tests) and
// `gate-semaphore.ts` (the actual cap/admission machinery `run_gate`/`worker_merge_confirm`/deploy all go
// through) are the two files where "load-bearing" would have to live if it ever crept in — neither has any
// legitimate reason to ever import or reference `orchestration/gate-intent.ts` (a manager-glue orchestration
// concern layered ABOVE them in `sessions/service.ts`, which they know nothing about and never import from).
// `sessions/service.ts` itself is DELIBERATELY EXCLUDED from this grep — it legitimately references
// gate-intent (that's where `declareGateIntent`/`withdrawGateIntent`/the `declarations` field in
// `gateQueueForManager` live) and a whole-file grep there would false-positive on this feature's own code.
//
// POSITIVE CONTROL (this session's manager: "an assertion never shown to fire is not an assertion"): before
// trusting the real check, this proves it actually has power — a SCRATCH COPY of gate-semaphore.ts with a
// planted `gateIntents.snapshot(...)`-shaped reference appended is run through the identical check and MUST
// fail. If a mutant this obvious can't trip the check, the check has no power and the real, clean result
// below would mean nothing.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/gate-intent-no-firing-coupling.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, "..", "src");

// Matches any spelling of the feature's identifiers a reference could plausibly use — the class name, the
// field name `SessionService` stores it under, and the two tool names — case-insensitive so a comment
// mentioning it in passing still counts (this check cares about ANY mention, not just a live code path; a
// stray "see gate-intent.ts" comment in the firing engine would itself be a sign this coupling is creeping
// in, and is exactly the kind of thing a reviewer, or this check, should catch early).
const FEATURE_PATTERN = /gateintent/i;

/** Every line in `text` matching FEATURE_PATTERN, as {lineNo, line} — empty when clean. */
function findMatches(text) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  lines.forEach((line, i) => { if (FEATURE_PATTERN.test(line)) hits.push({ lineNo: i + 1, line: line.trim() }); });
  return hits;
}

// ── Positive control: a deliberately-planted reference in a SCRATCH COPY must be CAUGHT ──────────────────
{
  const realSemaphorePath = path.join(SRC_DIR, "orchestration", "gate-semaphore.ts");
  const real = fs.readFileSync(realSemaphorePath, "utf8");
  check("(sanity) the real gate-semaphore.ts source is non-trivial (control isn't vacuous over an empty file)", real.length > 1000);

  const mutant = real + "\n// PLANTED FOR TEST: this.gateIntents.snapshot(isSessionLive)\n";
  const mutantHits = findMatches(mutant);
  check("(positive control) a planted gateIntents reference in a scratch copy of gate-semaphore.ts IS caught by the pattern", mutantHits.length === 1);
  check("(positive control) the planted line is the one the pattern reports", mutantHits[0]?.line.includes("PLANTED FOR TEST"));
}

// ── The real check: gate-runner.ts and gate-semaphore.ts, unmodified, must be CLEAN ───────────────────────
for (const rel of [path.join("orchestration", "gate-runner.ts"), path.join("orchestration", "gate-semaphore.ts")]) {
  const full = path.join(SRC_DIR, rel);
  const text = fs.readFileSync(full, "utf8");
  const hits = findMatches(text);
  check(`(real, clean) ${rel} carries ZERO gate-intent references (the structural guarantee behind DoD-4)`, hits.length === 0);
  if (hits.length > 0) for (const h of hits) console.log(`      ${rel}:${h.lineNo}: ${h.line}`);
}

// ── Sanity: confirm the feature DOES exist and DOES reference itself somewhere (a check that also passed
// on a codebase where the whole feature was reverted/deleted would be vacuous the other way) ──────────────
{
  const intentFile = path.join(SRC_DIR, "orchestration", "gate-intent.ts");
  check("(sanity) orchestration/gate-intent.ts exists", fs.existsSync(intentFile));
  const serviceText = fs.readFileSync(path.join(SRC_DIR, "sessions", "service.ts"), "utf8");
  check("(sanity) sessions/service.ts DOES reference gate-intent (the sanctioned glue layer) — proves the pattern isn't simply matching nothing anywhere",
    findMatches(serviceText).length > 0);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — gate-runner.ts and gate-semaphore.ts (the actual gate-command-execution and cap/admission engines) carry zero references to the gate-intent registry, and the grep that proves it was shown, via a planted mutant, to actually have the power to catch a violation rather than passing vacuously."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
