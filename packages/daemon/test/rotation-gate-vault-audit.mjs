import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs/child_process
// Tests for card d8062fbb's addition to packages/daemon/scripts/rotation-gate.mjs: the --audit-vault /
// LOOM_ROTATION_GATE_VAULT_PATH drift detector for this script's own hardcoded MARKERS/LIVE_COMMITMENTS_FLOOR
// copy against the vault §ROTATION-GATE section it was copied from.
//
// DECISION RECORD (see rotation-gate.mjs's own file header for the full reasoning): this does NOT make the
// vault authoritative at runtime (that design — a `--markers <path>` flag replacing the hardcoded array —
// was rejected as reintroducing the same class of fragile-prose-parse bug this file has already been bitten
// by twice, on the SIMPLER numbered-list case). Instead the hardcoded copy stays the thing --active/--archive
// are checked against, and this audit is a SEPARATE, on-demand check of that copy against the vault, wired to
// only affect the exit code under --lint (never a real rotation) — DoD-3's "do not regress what works".
//
// DoD-2's requirement — "desync a fixture marker list from a fixture rules section must be DETECTED; resync
// must PASS" — is exercised below both for a marker token (case A/B) and for the LIVE_COMMITMENTS_FLOOR
// number (case C/D), plus the structural boundary (case E, mirroring rotation-gate-heading-anchor.mjs's own
// proof that a mention outside the section doesn't count), the two failure-shape distinctions (case F: no
// §ROTATION-GATE heading at all vs. a found-but-drifted section), the lint-only gating rule (case G), the
// explicit-flag-vs-ambient-env-var read-failure asymmetry (case H), and that behavior is BYTE-IDENTICAL to
// before this card when neither the flag nor the env var is given (case I).
//
// Run: node packages/daemon/test/rotation-gate-vault-audit.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "..", "scripts", "rotation-gate.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-rotgate-va-${process.pid}-`));

function writeFixture(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// The 10 marker tokens rotation-gate.mjs's own MARKERS array currently requires (card a681aed5, 2026-09-02
// — see rotation-gate.mjs's own array; kept as a local literal here, same convention as the sibling test
// files rotation-gate-rules-lint.mjs / rotation-gate-heading-anchor.mjs already use).
const ALL_MARKER_TOKENS = [
  "Orchestrator Rules",
  "THE FOUR-LEG VERIFY",
  "LIVE COMMITMENTS",
  "OWNER-GATED",
  "ROTATE AT 40 KB",
  "THE SAFE-WRITE",
  "MULTI-HARNESS EPIC",
  "NO-CLEARANCE-FROM-SILENCE",
  "QUIET-LANE",
  "MGR122-FLOOR",
];
const CURRENT_FLOOR = 12; // rotation-gate.mjs's own LIVE_COMMITMENTS_FLOOR as of card bcd3f890/a681aed5

function commitmentsList(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`${i}. Commitment number ${i}.`);
  return lines.join("\n");
}

// A well-formed --active doc: all markers present, >= floor commitments. Independent of the vault fixture
// below (the audit never reads --active).
function goodActiveDoc() {
  return [
    "# Loom — Orchestrator Log (fixture)",
    "",
    ALL_MARKER_TOKENS.join(" · "),
    "",
    "## LIVE COMMITMENTS",
    commitmentsList(20),
    "",
  ].join("\n");
}

// A synced vault-rules fixture: a real §ROTATION-GATE heading whose section carries every marker token
// (case-insensitively, mirroring textIncludes) plus the current floor as a standalone number, followed by
// an UNRELATED next section holding content that must never be swept in.
function vaultFixture({ markers = ALL_MARKER_TOKENS, floorMention = String(CURRENT_FLOOR), afterSection = [] } = {}) {
  return [
    "# Orchestrator Rules (fixture)",
    "",
    "## §ROTATION-GATE",
    `Protects: ${markers.join(" · ")}.`,
    floorMention ? `The LIVE COMMITMENTS floor is currently ${floorMention} numbered items.` : "",
    "",
    "## §SOME OTHER SECTION",
    ...afterSection,
    "Unrelated content that must never be swept into the ROTATION-GATE section's own check.",
    "",
  ].join("\n");
}

function runGate(argsArr, env) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...argsArr], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const archivePath = writeFixture("archive.md", "archive contents\n");
const goodActivePath = writeFixture("good-active.md", goodActiveDoc());

// ── Case I: neither --audit-vault nor the env var given — byte-identical to pre-card behavior. ──────────
{
  const r = runGate(["--active", goodActivePath, "--archive", archivePath], { LOOM_ROTATION_GATE_VAULT_PATH: "" });
  check("no --audit-vault, no env var: exits 0", r.status === 0);
  check("no --audit-vault, no env var: no vault-audit line printed at all", !/vault audit/.test(r.stdout) && !/vault audit/.test(r.stderr));
}

// ── Case A/B: DESYNC then RESYNC a single marker token (DoD-2's literal ask). ─────────────────────────────
{
  const syncedPath = writeFixture("vault-synced.md", vaultFixture());
  const desyncedPath = writeFixture(
    "vault-desynced.md",
    vaultFixture({ markers: ALL_MARKER_TOKENS.filter((t) => t !== "QUIET-LANE") })
  );

  // DESYNC, under --lint: must be DETECTED (exit 1, names the missing token).
  const desyncedLint = runGate(["--active", goodActivePath, "--lint", "--audit-vault", desyncedPath]);
  check("A. desynced marker under --lint: exits 1", desyncedLint.status === 1);
  check("A. desynced marker under --lint: names QUIET-LANE as the drifted token", /QUIET-LANE/.test(desyncedLint.stderr) && /vault audit/.test(desyncedLint.stderr));
  check("A. desynced marker under --lint: REFUSED header still fires (same family as every other failure)", /REFUSED/.test(desyncedLint.stderr));

  // RESYNC: restore the token — must PASS.
  const resyncedLint = runGate(["--active", goodActivePath, "--lint", "--audit-vault", syncedPath]);
  check("B. resynced marker under --lint: exits 0", resyncedLint.status === 0);
  check("B. resynced marker under --lint: reports vault audit OK", /vault audit: OK/.test(resyncedLint.stdout));
}

// ── Case C/D: DESYNC then RESYNC the LIVE_COMMITMENTS_FLOOR number. ───────────────────────────────────────
{
  const floorDesyncedPath = writeFixture("vault-floor-desynced.md", vaultFixture({ floorMention: "20" }));
  const floorMissingPath = writeFixture("vault-floor-missing.md", vaultFixture({ floorMention: null }));
  const floorSyncedPath = writeFixture("vault-floor-synced.md", vaultFixture({ floorMention: String(CURRENT_FLOOR) }));

  const desynced = runGate(["--active", goodActivePath, "--lint", "--audit-vault", floorDesyncedPath]);
  check("C. floor stated as a DIFFERENT number (20, not 12) under --lint: exits 1", desynced.status === 1);
  check("C. names LIVE_COMMITMENTS_FLOOR as the drift", /LIVE_COMMITMENTS_FLOOR/.test(desynced.stderr));

  const missing = runGate(["--active", goodActivePath, "--lint", "--audit-vault", floorMissingPath]);
  check("C2. floor not mentioned at all under --lint: exits 1 (honest best-effort signal, not silently passed)", missing.status === 1);

  const resynced = runGate(["--active", goodActivePath, "--lint", "--audit-vault", floorSyncedPath]);
  check("D. floor restored to 12 under --lint: exits 0", resynced.status === 0);
}

// ── Case E: STRUCTURAL boundary — a marker mentioned only in the FOLLOWING section must not count as
// "found", mirroring rotation-gate-heading-anchor.mjs's own proof for the LIVE COMMITMENTS locator. ───────
{
  const boundaryPath = writeFixture(
    "vault-boundary.md",
    vaultFixture({
      markers: ALL_MARKER_TOKENS.filter((t) => t !== "MGR122-FLOOR"),
      afterSection: ["This later, unrelated section happens to mention MGR122-FLOOR, but it must not count."],
    })
  );
  const r = runGate(["--active", goodActivePath, "--lint", "--audit-vault", boundaryPath]);
  check("E. a marker present only AFTER the §ROTATION-GATE section boundary still counts as missing (structural, not a whole-doc scan)", r.status === 1 && /MGR122-FLOOR/.test(r.stderr));
}

// ── Case F: no §ROTATION-GATE heading at all in the given vault file — a distinct failure shape from a
// found-but-drifted section (mirrors countLiveCommitments's own "heading missing" vs "count too low" split). ──
{
  const noHeadingPath = writeFixture("vault-no-heading.md", "# Orchestrator Rules (fixture)\n\nNothing relevant here at all.\n");
  const rLint = runGate(["--active", goodActivePath, "--lint", "--audit-vault", noHeadingPath]);
  check("F. no §ROTATION-GATE heading under --lint: exits 1", rLint.status === 1);
  check("F. names 'COULD NOT VERIFY', distinct from a drift message", /COULD NOT VERIFY/.test(rLint.stderr));

  const rRotation = runGate(["--active", goodActivePath, "--archive", archivePath, "--audit-vault", noHeadingPath]);
  check("F2. same fixture in ROTATION mode (no --lint): still exits 0 — never gates a real rotation", rRotation.status === 0);
  check("F2. the COULD-NOT-VERIFY line is still printed, just non-fatal", /COULD NOT VERIFY/.test(rRotation.stdout));
}

// ── Case G: the lint-only gating rule itself — a genuinely desynced vault fixture must NEVER fail a real
// rotation (--archive given, no --lint), only ever --lint. This is DoD-3's "do not regress what works": the
// pre-existing --active/--archive checks are the only thing that can refuse an actual rotation. ────────────
{
  const desyncedPath = writeFixture("vault-desynced-2.md", vaultFixture({ markers: ALL_MARKER_TOKENS.filter((t) => t !== "OWNER-GATED") }));
  const rotation = runGate(["--active", goodActivePath, "--archive", archivePath, "--audit-vault", desyncedPath]);
  check("G. desynced vault audit in ROTATION mode: still exits 0 (rotation may proceed)", rotation.status === 0);
  check("G. the drift is still surfaced in stdout, not swallowed", /DRIFT SUSPECTED/.test(rotation.stdout) && /OWNER-GATED/.test(rotation.stdout));

  const lint = runGate(["--active", goodActivePath, "--lint", "--audit-vault", desyncedPath]);
  check("G2. the SAME desynced fixture under --lint: exits 1 (the one mode this audit gates)", lint.status === 1);
}

// ── Case H: explicit --audit-vault vs. ambient LOOM_ROTATION_GATE_VAULT_PATH — the read-failure asymmetry. ──
{
  const missingPath = path.join(tmpDir, "does-not-exist-vault.md");

  const explicit = runGate(["--active", goodActivePath, "--archive", archivePath, "--audit-vault", missingPath]);
  check("H. explicit --audit-vault pointing at a nonexistent file: exits 1 (a real error, like --rules/--active)", explicit.status === 1);
  check("H. names the unreadable path", /cannot read --audit-vault/.test(explicit.stderr));

  const ambient = runGate(["--active", goodActivePath, "--archive", archivePath], { LOOM_ROTATION_GATE_VAULT_PATH: missingPath });
  check("H2. SAME nonexistent path via the ambient env var: exits 0 (best-effort, never fatal)", ambient.status === 0);
  check("H2. prints a SKIPPED note rather than failing silently", /vault audit: SKIPPED/.test(ambient.stdout));
}

// ── Case I2: the ambient env var actually drives the audit when no --audit-vault flag is given at all. ───
{
  const syncedPath = writeFixture("vault-synced-env.md", vaultFixture());
  const r = runGate(["--active", goodActivePath, "--archive", archivePath], { LOOM_ROTATION_GATE_VAULT_PATH: syncedPath });
  check("I2. ambient env var alone (no flag) runs the audit and reports OK", /vault audit: OK/.test(r.stdout));
}

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — rotation-gate.mjs's --audit-vault / LOOM_ROTATION_GATE_VAULT_PATH drift detector catches a desynced marker and a desynced LIVE_COMMITMENTS_FLOOR (both directions: desync detected, resync passes), respects the same structural section boundary as the LIVE COMMITMENTS locator, distinguishes 'no heading found' from 'found but drifted', only ever gates --lint's exit code (never a real rotation), and the explicit-flag-vs-ambient-env-var read-failure asymmetry holds."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
