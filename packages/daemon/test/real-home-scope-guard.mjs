import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure source scan
// STANDING GUARD (card 7a5948bd) — closes a guard GAP raised at the merge gate for `d1e10795` (Loom lead
// `gen 162`): `d1e10795` added `LOOM_REAL_HOME` to every spawned test child's env (`scripts/test-daemon.mjs`
// › `runOne`), carrying the harness's REAL `LOOM_HOME` through ADDITIVELY so a test file can write durable
// diagnostic telemetry — `LOOM_HOME` itself stays overridden to the per-test throwaway temp dir, hermetic
// isolation untouched (verified in both directions on that card). But `_guard.mjs`'s `requireHermeticEnv`
// only ever asserts `LOOM_HOME` is a temp dir — it structurally CANNOT see `LOOM_REAL_HOME`, so a test file
// that reads that var and writes through it reaches the real `~/.loom` (which holds `loom.db`) with no
// guard firing. This board has had a test wipe a prod DB before (memory: the WAL-checkpoint recovery
// recipe exists because of it) — that incident is why `requireHermeticEnv` exists at all.
//
// ⭐ SEVERITY, STATED HONESTLY: `LOOM_REAL_HOME` grants NO NEW CAPABILITY. Any test could already compute
// `path.join(os.homedir(), ".loom")` itself (that's literally `exit-close-gap.mjs`'s own fallback
// expression) — the real home was always reachable. What changed is DISCOVERABILITY, not reach: the prod
// path now sits in every spawned child's env by default, making casual use likely where it used to be
// deliberate. Filed p3 for exactly that reason — this guard is a tripwire against silent regrowth, not a
// response to a capability that didn't already exist.
//
// WHAT THIS ASSERTS — the STRONGER, checkable property, chosen deliberately over the weak alternative:
// a guard that only checked "only these files may MENTION `LOOM_REAL_HOME`" would PASS a test that reads
// the var and then writes `loom.db` through it, as long as that test happened to be the one allowlisted
// file — worthless, per this card's own acceptance bar. Instead this guard requires EVERY line that reads
// `process.env.LOOM_REAL_HOME` (directly, or via a variable it's assigned to) to resolve into a path that
// is unambiguously TELEMETRY-ONLY: every usage of the value must appear on a line that also names the
// literal `"gate-timing"` — `exit-close-gap.mjs`'s real shape (`path.join(LOOM_HOME, "gate-timing", ...)`)
// is exactly this. A usage line that does NOT carry that literal — e.g. `path.join(LOOM_HOME, "loom.db")`,
// or any other write target — is flagged as a SCOPE-ESCAPE violation regardless of which file it's in,
// including the allowlisted one. This directly answers the card's own test: a fixture that reads
// `LOOM_REAL_HOME` and writes `loom.db` through it FAILS this guard (see the RED-PROOF run recorded in the
// task report — added, shown failing, removed).
//
// SCOPE: `packages/daemon/test/*.mjs` only (source text, not `dist/`) — the same corpus every sibling
// static guard in `STATIC_GUARD_REPO_PATHS` walks. `scripts/test-daemon.mjs` (the harness file that SETS
// `LOOM_REAL_HOME` for spawned children — `env: { ..., LOOM_REAL_HOME: LOOM_HOME, ... }`) is deliberately
// OUT of scope: that's a WRITE of the env var for a child process, not a `process.env.LOOM_REAL_HOME`
// READ, and matched zero times against this guard's own read pattern when checked directly (see the
// population sanity check below, which proves the pattern isn't vacuously narrow).
//
// FAIL-CLOSED ON UNRECOGNIZED SHAPE: a read this guard cannot classify (not inline-with-"gate-timing", and
// not a simple `const/let NAME = ... process.env.LOOM_REAL_HOME ...` declaration it can then trace) is
// itself a violation, not a silent pass — same posture as `onexit-discard-guard.mjs`'s AST-shape guard:
// an unrecognized shape earns a human's attention, not a free pass because the pattern didn't match.
//
// ⭐ BASELINE KEY = basename only (this guard tracks ONE file, not per-line text like its siblings) — a
// genuine new consumer is rare enough that basename-level allowlisting is the right granularity; adding a
// SECOND consumer is exactly the moment a human should be looking at this file's ALLOWLIST array directly,
// not discovering it through a line-text diff.
//
// Run: node packages/daemon/test/real-home-scope-guard.mjs (no build needed — pure source-text scan)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = __dirname;
const SELF = path.basename(__filename);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Re-derived at task time (card explicitly says not to trust its own stated count) by a repo-wide grep for
// `process.env.LOOM_REAL_HOME` — exactly one hit, in this file's basename below.
const ALLOWLIST = ["exit-close-gap.mjs"];

const READ_RE = /process\.env\.LOOM_REAL_HOME\b/;
const TELEMETRY_LITERAL = "gate-timing";
const DECL_RE = /^\s*(?:const|let)\s+(\w+)\s*=.*process\.env\.LOOM_REAL_HOME\b/;

// SELF-EXCLUSION: this file's own header prose and ALLOWLIST/regex literals mention `LOOM_REAL_HOME` and
// `gate-timing` repeatedly — without excluding SELF the scanner would try to classify its own source text.
function walkTestFiles() {
  return fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(".mjs") && f !== SELF);
}

// Per-line comment mask covering BOTH `//` line comments and `/* ... */` block comments (this guard's own
// doc header above, and `_guard.mjs`'s JSDoc, both discuss `process.env.LOOM_REAL_HOME` in prose — a
// naive `.startsWith("//")` check misses a JSDoc `*`-continuation line entirely, which is exactly how this
// guard's first draft mis-flagged `_guard.mjs`'s own doc comment as a NEW-CONSUMER violation. Approximates
// a whole `/* ... */` line (even one that closes mid-line) as fully comment — safe here because no real
// LOOM_REAL_HOME read in this codebase is ever written to share a physical line with a block-comment
// delimiter, so this can only ever suppress a false positive, never hide a real violation.
function computeCommentMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlock) {
      mask[i] = true;
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      mask[i] = true;
      const blockStart = line.indexOf("/*");
      if (blockStart !== -1 && line.indexOf("*/", blockStart + 2) === -1) inBlock = true;
      continue;
    }
  }
  return mask;
}

// Classifies one file's use of LOOM_REAL_HOME. Returns:
//   { reads: 0 }                                              — file never reads the var, nothing to check
//   { reads: N, violations: [] }                               — every read resolves to a gate-timing/ path
//   { reads: N, violations: [{ lineNo, text, reason }, ...] }   — at least one read escapes the allowed shape
function classifyFile(file) {
  const text = fs.readFileSync(path.join(TEST_DIR, file), "utf8");
  const lines = text.split("\n");
  const isComment = computeCommentMask(lines);
  const violations = [];
  let reads = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!READ_RE.test(raw)) continue;
    if (isComment[i]) continue; // a comment mentioning the pattern is not a real read
    reads++;

    // Inline case: the read and its telemetry destination share one line, e.g.
    // `path.join(process.env.LOOM_REAL_HOME || ..., "gate-timing", ...)`.
    if (raw.includes(TELEMETRY_LITERAL)) continue;

    // Variable case: `const NAME = process.env.LOOM_REAL_HOME || ...;` — trace every later use of NAME.
    const m = DECL_RE.exec(raw);
    if (!m) {
      violations.push({ lineNo: i + 1, text: raw.trim(), reason: "unrecognized shape (fails closed)" });
      continue;
    }
    const name = m[1];
    const usageRe = new RegExp(`\\b${name}\\b`);
    let escaped = null;
    for (let j = 0; j < lines.length; j++) {
      if (j === i) continue; // the declaration line itself
      const line = lines[j];
      if (isComment[j]) continue;
      if (!usageRe.test(line)) continue;
      if (!line.includes(TELEMETRY_LITERAL)) { escaped = { lineNo: j + 1, text: line.trim() }; break; }
    }
    if (escaped) {
      violations.push({
        lineNo: i + 1, text: raw.trim(),
        reason: `variable "${name}" used at line ${escaped.lineNo} ("${escaped.text}") without a "${TELEMETRY_LITERAL}" path segment`,
      });
    }
  }
  return { reads, violations };
}

// ── Population sanity (per this card's own DoD, and the guard-authoring precedent throughout this
// directory): prove the pattern isn't silently vacuous BEFORE trusting a clean scan. ──────────────────
const files = walkTestFiles();
const rawMentions = files
  .flatMap((f) => fs.readFileSync(path.join(TEST_DIR, f), "utf8").split("\n").filter((l) => l.includes("LOOM_REAL_HOME")))
  .length;
check(`sanity: the bare token "LOOM_REAL_HOME" appears somewhere in the test/ corpus (found ${rawMentions} line(s) total across comments+code — confirms this isn't a typo'd pattern matching nothing)`,
  rawMentions > 0);

let allowlistSeen = 0;
let newConsumers = [];
let scopeViolations = [];

for (const file of files) {
  const { reads, violations } = classifyFile(file);
  if (reads === 0) continue;
  const allowed = ALLOWLIST.includes(file);
  if (!allowed) {
    newConsumers.push(file);
    continue; // don't also shape-check a file that shouldn't be reading this var at all
  }
  allowlistSeen++;
  for (const v of violations) scopeViolations.push({ file, ...v });
}

// DoD-4 POSITIVE CONTROL: the guard must actually find its one legitimate, allowlisted consumer — proves
// a clean run isn't clean because the allowlist silently emptied out from under the scan.
check(`positive control: every allowlisted file (${ALLOWLIST.join(", ")}) is actually found reading LOOM_REAL_HOME (found ${allowlistSeen}/${ALLOWLIST.length})`,
  allowlistSeen === ALLOWLIST.length);

check(`no NEW file outside the allowlist reads process.env.LOOM_REAL_HOME (found ${newConsumers.length})`,
  newConsumers.length === 0);
for (const f of newConsumers) console.log(`  NEW-CONSUMER  ${f}  — reads LOOM_REAL_HOME but is not in ALLOWLIST`);

check(`every LOOM_REAL_HOME read in an allowlisted file resolves to a "${TELEMETRY_LITERAL}" path (found ${scopeViolations.length} escape(s))`,
  scopeViolations.length === 0);
for (const v of scopeViolations) console.log(`  SCOPE-ESCAPE  ${v.file}:${v.lineNo}  ${v.text}  — ${v.reason}`);

console.log(failures === 0
  ? `\n✅ ALL PASS — LOOM_REAL_HOME is read only by its ${ALLOWLIST.length} allowlisted consumer(s), and every read resolves exclusively to a "${TELEMETRY_LITERAL}" path (telemetry-only, never a data/db write target).`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
