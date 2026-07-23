import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// spillTextIfLarge key/subdir path-segment guard (card 659a7bee, found by manager review of 605988ab).
// HERMETIC, NO daemon, NO claude: sandboxed LOOM_HOME, drives the REAL built spillTextIfLarge directly.
//
// THE BUG: `spillTextIfLarge(sessionId, subdir, key, text, capChars)` joined `subdir`/`key` straight into
// a filesystem path with NO validation: `path.join(sessionScratchDir(sessionId), subdir)` then
// `path.join(dir, key)`. A `key`/`subdir` containing `..` or a path separator escapes the session scratch
// dir and `writeFileSync`s caller-supplied text there. NOT a live vulnerability today (every current call
// site builds key from a server-resolved record id + a fixed suffix/numeric offset), but the primitive is
// brand new and exists to acquire callers (c9046964 already proposes a third), so safety must not depend
// on every future caller remembering to sanitize.
//
// FIX: `spillTextIfLarge` now validates both `subdir` and `key` against the SAME `[A-Za-z0-9._-]+`
// charset convention `repoKey` already uses (`projects/repos.ts`), rejecting `.`/`..` explicitly, and
// THROWS (not sanitizes) on an invalid segment — a silently-rewritten key would make two distinct
// payloads collide on one filename, trading a security bug for a correctness one.
//
// Proves:
//   (RED) The PRE-FIX shape (the exact old join logic, reproduced inline here since the built artifact is
//         already patched) genuinely escapes the session scratch dir given a `..`-laden key, and writes
//         attacker-supplied text there — demonstrated directly, not asserted.
//   (A)   The REAL (post-fix) spillTextIfLarge THROWS on a `key` containing `..`, `/`, or `\`, for BOTH
//         the below-cap and above-cap size paths — and the escape-target file is never created.
//   (B)   Same for `subdir`.
//   (C)   `.`/`..` alone (which pass the bare charset regex) are explicitly rejected too.
//   (D)   Legitimate keys/subdirs (dashes, dots-as-extension, alphanumeric — the real shapes every
//         current caller uses, e.g. `${sessionId}-lastN`, `${sessionId}-0`) are UNCHANGED: inline below
//         the cap, and a real spilled file above it.
// Run: 1) build daemon (pnpm build), 2) node test/spill-path-segment-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-spill-guard-"));
process.env.LOOM_HOME = path.join(sandboxHome, ".loom");
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { spillTextIfLarge } = await import("../dist/spill.js");
const { sessionScratchDir } = await import("../dist/paths.js");

const SESSION_ID = "sess-guard-test";
const scratchDir = sessionScratchDir(SESSION_ID);

// ═══════════════════════════════════ (RED) reproduce the PRE-FIX shape directly ═══════════════════════
// Exact old logic (no validation), so we can demonstrate the escape without needing to check out history.
function preFixSpillTextIfLarge(sessionId, subdir, key, text, capChars) {
  if (text.length <= capChars) return { inline: true };
  const dir = path.join(sessionScratchDir(sessionId), subdir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, key);
  fs.writeFileSync(file, text, "utf8");
  return { inline: false, file, chars: text.length };
}
{
  const bigText = "x".repeat(100);
  const maliciousKey = "../../escaped-payload.txt"; // walks up out of <scratchDir>/some-subdir
  const result = preFixSpillTextIfLarge(SESSION_ID, "some-subdir", maliciousKey, bigText, 10);
  check("(RED) pre-fix: a `..`-laden key resolves OUTSIDE the session scratch dir",
    !result.file.startsWith(scratchDir));
  check("(RED) pre-fix: the escape target was ACTUALLY written to disk, outside the scratch dir",
    fs.existsSync(result.file) && fs.readFileSync(result.file, "utf8") === bigText);
  fs.rmSync(result.file, { force: true });
}

// ═══════════════════════════════════ (A) real fix: malicious `key` throws, nothing written ═════════════
for (const maliciousKey of ["../escape", "../../escaped-payload.txt", "a/b", "a\\b", "/abs/path", "..\\escape"]) {
  const subdirPath = path.join(scratchDir, "fresh-subdir");
  try { fs.rmSync(subdirPath, { recursive: true, force: true }); } catch { /* ignore */ }

  let threwBelowCap = false;
  try { spillTextIfLarge(SESSION_ID, "fresh-subdir", maliciousKey, "small text", 1_000_000); }
  catch { threwBelowCap = true; }
  check(`(A) key="${maliciousKey}": throws even BELOW the cap (validated unconditionally)`, threwBelowCap);

  let threwAboveCap = false;
  try { spillTextIfLarge(SESSION_ID, "fresh-subdir", maliciousKey, "x".repeat(100), 10); }
  catch { threwAboveCap = true; }
  check(`(A) key="${maliciousKey}": throws ABOVE the cap (the actual write path)`, threwAboveCap);
  check(`(A) key="${maliciousKey}": validation ran BEFORE mkdirSync — the subdir was never even created`,
    !fs.existsSync(subdirPath));
}

// ═══════════════════════════════════ (B) same, but for `subdir` ═════════════════════════════════════════
for (const maliciousSubdir of ["../escape", "a/b", "a\\b", ".."]) {
  let threw = false;
  try { spillTextIfLarge(SESSION_ID, maliciousSubdir, "valid-key", "x".repeat(100), 10); }
  catch { threw = true; }
  check(`(B) subdir="${maliciousSubdir}": throws`, threw);
}

// ═══════════════════════════════════ (C) bare "." / ".." pass the charset but must still be rejected ═══
for (const reserved of [".", ".."]) {
  let keyThrew = false;
  try { spillTextIfLarge(SESSION_ID, "some-subdir", reserved, "x".repeat(100), 10); }
  catch { keyThrew = true; }
  check(`(C) key="${reserved}": rejected even though it matches the bare charset regex`, keyThrew);

  let subdirThrew = false;
  try { spillTextIfLarge(SESSION_ID, reserved, "valid-key", "x".repeat(100), 10); }
  catch { subdirThrew = true; }
  check(`(C) subdir="${reserved}": rejected even though it matches the bare charset regex`, subdirThrew);
}

// ═══════════════════════════════════ (D) legitimate callers: unchanged behavior ═════════════════════════
{
  // Below cap — byte-identical no-op, mirrors every real call site's small-payload path.
  const inlineResult = spillTextIfLarge(SESSION_ID, "transcript-spills", "W-ABC123-lastN", "small text", 1_000_000);
  check("(D) legitimate key/subdir below cap: still inline, no throw", inlineResult.inline === true);

  // Above cap — a real spilled file, using the exact shape every current call site produces
  // (`${sessionId}-lastN` / `${sessionId}-0` / `${sessionId}-${offset}`).
  const bigText = "y".repeat(200);
  const spillResult = spillTextIfLarge(SESSION_ID, "transcript-spills", "W-ABC123-0", bigText, 50);
  check("(D) legitimate key/subdir above cap: still spills, no throw", spillResult.inline === false);
  check("(D) spilled file lands INSIDE the session scratch dir", spillResult.file.startsWith(scratchDir));
  check("(D) spilled file content matches", fs.existsSync(spillResult.file) && fs.readFileSync(spillResult.file, "utf8") === bigText);
}

try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — spillTextIfLarge rejects a `..`/separator-laden key or subdir before any mkdirSync/" +
    "writeFileSync, mirroring the repoKey filesystem-path-segment convention; every legitimate caller's " +
    "shape (dashes, numeric offsets) is unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
