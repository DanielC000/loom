// Drift guard for the ONE trap card 9c8ce2b2 exists to police: there are TWO SEPARATE, DUPLICATE
// rotateCrashlog() implementations — packages/daemon/src/crashlog.ts (inside the daemon process) and
// scripts/daemon-supervisor.mjs (runs BEFORE the daemon process even starts, and on the live
// `daemon:stable` path is the copy that actually determines what's on disk). Patching only one would
// look correct in review and do nothing for the deployment running today.
//
// scripts/daemon-supervisor.mjs is deliberately NOT importable for a live functional test — its own
// top-of-file comment says so: importing it for its exports would also run its top-level
// detach/build/run-loop side effects (spawning a real daemon build). So this test does not execute
// either script's rotateCrashlog() end-to-end; instead it reads BOTH files' source text and asserts the
// two copies stay in lockstep — the exact drift this card's own doc calls out as the risk of keeping
// them duplicated by hand. The end-to-end ROTATION BEHAVIOR (N generations, cold start, no-throw on a
// genuine failure) is covered against the REAL crashlog.ts implementation in test/crashlog.mjs; this
// file's only job is proving the supervisor's copy hasn't silently diverged from it.
//
// RUN (no daemon, no real claude): node test/crashlog-supervisor-rotation-parity.mjs
import "./_guard.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const crashlogTsPath = path.join(__dirname, "..", "src", "crashlog.ts");
const supervisorPath = path.join(__dirname, "..", "..", "..", "scripts", "daemon-supervisor.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const crashlogSrc = fs.readFileSync(crashlogTsPath, "utf8");
const supervisorSrc = fs.readFileSync(supervisorPath, "utf8");

// ── 1: CRASHLOG_MAX_GENERATIONS must be declared, and agree, in both files ─────────────────────────
function extractMaxGenerations(src, label) {
  const m = src.match(/CRASHLOG_MAX_GENERATIONS\s*=\s*(\d+)/);
  if (!m) throw new Error(`${label}: could not find a "CRASHLOG_MAX_GENERATIONS = <N>" declaration`);
  return Number(m[1]);
}
const tsMaxGenerations = extractMaxGenerations(crashlogSrc, "crashlog.ts");
const supervisorMaxGenerations = extractMaxGenerations(supervisorSrc, "daemon-supervisor.mjs");
check("crashlog.ts declares CRASHLOG_MAX_GENERATIONS = 5 (card 9c8ce2b2's accepted N)", tsMaxGenerations === 5);
check("daemon-supervisor.mjs declares CRASHLOG_MAX_GENERATIONS = 5", supervisorMaxGenerations === 5);
check(
  "both copies of CRASHLOG_MAX_GENERATIONS agree — a mismatch here means one path rotates deeper than the other",
  tsMaxGenerations === supervisorMaxGenerations,
);

// ── 2: the rotateCrashlog() function BODIES must express the same rotation algorithm ────────────────
// Brace-depth extraction (not a single-line regex) so this survives ordinary reformatting inside the
// function body — it only cares where the function starts and where its matching closing brace is.
function extractFunctionBody(src, label) {
  const startMatch = src.match(/function rotateCrashlog\([^)]*\)(?::\s*void)?\s*\{/);
  if (!startMatch) throw new Error(`${label}: could not find "function rotateCrashlog(...) {"`);
  const bodyStart = startMatch.index + startMatch[0].length;
  let depth = 1;
  let i = bodyStart;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
  }
  if (depth !== 0) throw new Error(`${label}: unbalanced braces while scanning rotateCrashlog's body`);
  return src.slice(bodyStart, i - 1);
}
function normalize(body) {
  return body
    .replace(/\/\/.*$/gm, "") // strip line comments (the two files' comments legitimately differ in wording)
    .replace(/\/\*[\s\S]*?\*\//g, "") // strip block comments
    .replace(/\s+/g, " ")
    .trim();
}
const tsBody = extractFunctionBody(crashlogSrc, "crashlog.ts");
const supervisorBody = extractFunctionBody(supervisorSrc, "daemon-supervisor.mjs");
check("crashlog.ts's rotateCrashlog() body is non-trivial (extraction actually found real code)", normalize(tsBody).length > 40);
check("daemon-supervisor.mjs's rotateCrashlog() body is non-trivial (extraction actually found real code)", normalize(supervisorBody).length > 40);

// Narrow to the CORE shifting logic (the for-loop over generations plus the final promote-to-generation-1
// rename) — the part that actually encodes N, the shift direction, and the clear-then-rename order this
// card's DoD-2 requires to match. Deliberately EXCLUDES the surrounding guard/return/catch: the two
// functions legitimately differ there BY DESIGN — crashlog.ts's rotateCrashlog returns void and silently
// swallows (its own doc: "a failed rotation must never gate boot"), while the supervisor's returns a
// boolean threaded into LOOM_PRIOR_CRASHLOG (see its own doc) and logs the error. Comparing those verbatim
// would flag an intentional, documented difference as drift and mask the real one this test exists to catch.
function extractRotationCore(body, label) {
  const loopStart = body.indexOf("for (let gen");
  if (loopStart === -1) throw new Error(`${label}: no "for (let gen" shifting loop found in rotateCrashlog's body`);
  const finalRenameMarker = "crashlogGenerationPath(1));";
  const markerIdx = body.indexOf(finalRenameMarker, loopStart);
  if (markerIdx === -1) throw new Error(`${label}: no final promote-to-generation-1 rename found after the loop`);
  return body.slice(loopStart, markerIdx + finalRenameMarker.length);
}

// The ONE deliberate naming difference: crashlog.ts's module-scoped constant is CRASHLOG_PATH,
// scripts/daemon-supervisor.mjs's is CRASHLOG (see each file's own top-of-block constant) — normalize
// that single difference away before comparing, so the comparison is about ALGORITHM, not spelling.
const tsCore = normalize(extractRotationCore(tsBody, "crashlog.ts")).replaceAll("CRASHLOG_PATH", "CRASHLOG");
const supervisorCore = normalize(extractRotationCore(supervisorBody, "daemon-supervisor.mjs"));
check(
  "rotateCrashlog()'s CORE shifting algorithm (N, direction, clear-then-rename order) is IDENTICAL in " +
    "both files (module-local naming aside) — the exact drift this card's DoD-2 exists to prevent",
  tsCore === supervisorCore,
);

// ── 3: negative control — prove this comparison can actually FAIL ──────────────────────────────────
// Without this, a broken extraction that collapses both sides to the same (wrong, e.g. empty) string
// would pass vacuously and this whole file would be dead weight.
const mutated = supervisorCore.replace("gen >= 2", "gen >= 3");
check("(control sanity) the mutation actually changed the string", mutated !== supervisorCore);
check("(negative control) a genuinely mutated core is correctly flagged as NOT matching", tsCore !== mutated);

console.log(failures === 0
  ? "\n✅ ALL PASS — the two duplicate rotateCrashlog() implementations rotate to the same depth with the same algorithm."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
