import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs/child_process
// Tests for card c7c0a493's addition to packages/daemon/scripts/rotation-gate.mjs:
//   --was <bytes> — an independent, CUT-scoped (not rotation-scoped) byte-shrinkage check. Fails when
//   byteLength(--active) >= --was; passes when strictly smaller. Accepted identically under --lint and
//   under the rotation path. Omitting it is visible (a printed SKIPPED line), never silent. A malformed
//   value (non-numeric, negative, missing) is a usage error (exit 2).
//
// THE FAILURE MODE THIS EXISTS FOR (gen 181 "cut" 9 lines and netted +1,020 B; gen 183 did it again,
// +106 B): a rewrite that removes LINES can still ADD bytes overall (e.g. padding elsewhere, wider
// characters). A line-count "cut" is not proof of an actual cut — only a byte comparison is.
//
// Run: node packages/daemon/test/rotation-gate-was-byte-check.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "rotation-gate.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-rotgate-was-${process.pid}-`));

function writeFixture(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return { path: p, bytes: fs.statSync(p).size };
}

// The exact 14 marker tokens rotation-gate.mjs requires (kept as a local literal — this file is a TEST,
// not the source of truth; rotation-gate.mjs's own MARKERS array is that).
const ALL_MARKER_TOKENS = [
  "Orchestrator Rules",
  "THE FOUR-LEG VERIFY",
  "OWNER-GATED",
  "ROTATE AT 40 KB",
  "THE SAFE-WRITE",
  "MULTI-HARNESS EPIC",
  "ANNOUNCE-CANNOT-CARRY-A-SHA",
  "NO-CLEARANCE-FROM-SILENCE",
  "MGR122-FLOOR",
  "capQueued",
  "in-memory",
  "QUIET-LANE",
];

function commitmentsList(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`${i}. Commitment number ${i}.`);
  return lines.join("\n");
}

// LIVE_COMMITMENTS_FLOOR is 20 as of card 34a6f07e (was a fixed count of 14, now a floor — see
// rotation-gate.mjs's own header). A well-formed doc in this file must carry >= 20 items.
function docWith({ items = 20, titleSuffix = "" } = {}) {
  return [
    `# Loom — Orchestrator Log (fixture)${titleSuffix}`,
    "",
    ALL_MARKER_TOKENS.join(" · "),
    "",
    "## ⛔⛔ §LIVE COMMITMENTS — carried verbatim",
    commitmentsList(items),
    "",
    "## 📮 §MY-PEER-SEND-LEDGER — append every peer_message",
    "Nothing yet.",
    "",
  ].join("\n");
}

// Reproduces the gen 181/183 shape: FEWER lines (one blank line spliced out) but MORE bytes overall
// (multi-byte emoji padding added to the title line more than offsets the single removed newline byte).
function bloatedCutClaim() {
  const lines = docWith({ items: 20 }).split("\n");
  lines.splice(1, 1); // remove the blank line right after the title -> fewer total lines
  lines[0] = lines[0] + " 🔴🔴🔴🔴🔴"; // 5 emoji × 4 bytes (UTF-8) = 20 bytes of padding
  return lines.join("\n");
}

function runGate(argsArr) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...argsArr], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const archive = writeFixture("archive.md", "archive contents\n");
const good = writeFixture("good-active.md", docWith({ items: 20 }));

// ── DoD-2: absence is visible, not silent. A --lint run with no --was still exits 0, but SAYS the byte
// check did not run. ───────────────────────────────────────────────────────────────────────────────────
{
  const r = runGate(["--active", good.path, "--lint"]);
  check("lint, no --was: exits 0 (existing callers unaffected)", r.status === 0);
  check("lint, no --was: says the byte check was SKIPPED", /byte check: SKIPPED — no --was given/.test(r.stdout));
}

// Same visibility check on the rotation path (no --lint) — confirms --was is accepted/handled identically
// there too, per this script's stated design decision (see rotation-gate.mjs's own --was doc comment).
{
  const r = runGate(["--active", good.path, "--archive", archive.path]);
  check("rotation, no --was: exits 0 (existing callers unaffected)", r.status === 0);
  check("rotation, no --was: says the byte check was SKIPPED", /byte check: SKIPPED — no --was given/.test(r.stdout));
}

// ── DoD-4: positive-control BOTH polarities, in the same doc, so a broken/no-op flag can't pass silently. ──
{
  const smaller = runGate(["--active", good.path, "--lint", "--was", String(good.bytes + 1)]);
  check("was > actual size: exits 0 (genuine cut)", smaller.status === 0);
  check("was > actual size: reports byte check passed", /byte check: passed/.test(smaller.stdout));

  const below = runGate(["--active", good.path, "--lint", "--was", String(good.bytes - 1)]);
  check("was < actual size: exits 1 (the check can actually fail)", below.status === 1);
  check("was < actual size: names FAILED with both figures", new RegExp(`FAILED — --active is ${good.bytes} byte`).test(below.stderr));

  const equal = runGate(["--active", good.path, "--lint", "--was", String(good.bytes)]);
  check("was == actual size (>=, not >): exits 1 — a no-op rewrite is not a cut", equal.status === 1);
  check("was == actual size: names FAILED", /byte check: FAILED/.test(equal.stderr));
}

// ── DoD-5: reproduce the real failure mode — fewer lines, more bytes, must be REFUSED. ──────────────────
{
  const bloated = writeFixture("bloated-cut-claim.md", bloatedCutClaim());
  check(
    "fixture sanity: bloated doc genuinely has fewer lines than the baseline",
    bloatedCutClaim().split("\n").length < docWith({ items: 20 }).split("\n").length
  );
  check("fixture sanity: bloated doc genuinely has MORE bytes than the baseline", bloated.bytes > good.bytes);

  const r = runGate(["--active", bloated.path, "--lint", "--was", String(good.bytes)]);
  check("gen 181/183 shape (fewer lines, more bytes) claiming --was=<pre-edit size>: exits 1", r.status === 1);
  check("gen 181/183 shape: FAILED message shows a positive delta", /delta \+\d+/.test(r.stderr));
}

// ── DoD-3: malformed --was is a usage error (exit 2), never a silent pass. ────────────────────────────────
{
  const nonNumeric = runGate(["--active", good.path, "--lint", "--was", "abc"]);
  check("--was abc (non-numeric): exits 2", nonNumeric.status === 2);

  const negative = runGate(["--active", good.path, "--lint", "--was", "-5"]);
  check("--was -5 (negative): exits 2", negative.status === 2);

  const missingValue = runGate(["--active", good.path, "--lint", "--was"]);
  check("--was with no following value: exits 2", missingValue.status === 2);
}

// ── EXPLICIT DECISION (card c7c0a493, manager follow-up): --was 0 is rejected as a usage error, not
// accepted as a degenerate-but-legal "the previous doc was empty" — 0 passes as a plain non-negative
// integer but can never be a genuine caller measurement (a real --active always carries all markers plus
// the LIVE COMMITMENTS section, so it was never 0 bytes pre-edit), and accepting it would silently refuse
// every doc forever (byteLength >= 0 is always true). ─────────────────────────────────────────────────
{
  const zero = runGate(["--active", good.path, "--lint", "--was", "0"]);
  check("--was 0: exits 2 (rejected, not a silently-always-failing '0 bytes' check)", zero.status === 2);
  check("--was 0: names it invalid, not merely non-numeric", /invalid --was value 0/.test(zero.stderr));
}

// ── DoD-1: --was is valid in --lint mode and does not disturb the archive check on the rotation path. ────
{
  const r = runGate(["--active", good.path, "--archive", archive.path, "--was", String(good.bytes + 1)]);
  check("rotation mode + --was (genuine cut): exits 0", r.status === 0);
  check("rotation mode + --was: reports Rotation may proceed", /Rotation may proceed/.test(r.stdout));
  check("rotation mode + --was: reports byte check passed", /byte check: passed/.test(r.stdout));
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — --was checks byteLength(--active) < --was in both --lint and rotation mode, is opt-in and behaviour/exit-code-identical when omitted (with the skip stated explicitly in the added status line), rejects a malformed value — including 0 — as a usage error, and refuses the gen 181/183 shape (fewer lines, more bytes)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
