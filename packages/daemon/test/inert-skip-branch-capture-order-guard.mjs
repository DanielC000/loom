import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure fs below, no daemon/Db used
// PRE-WAIT BRANCH CAPTURE ORDERING GUARD (card 60926911, Code Review's own counter-proposal on card
// db413510). `SessionService`'s inert-skip path (packages/daemon/src/sessions/service.ts) captures
// `preWaitBranchHead` via `resolveGitRef` BEFORE calling `isInertMergeDiff` to derive `inertSkip` — because
// `isInertMergeDiff` resolves `branch` BY NAME internally, so classifying first and capturing the branch tip
// afterward (even a line later) opens a window where a commit landing between the two reads is invisible to
// the later `postWaitBranchHead !== preWaitBranchHead` movement check, letting a stale `inertSkip:true` ride
// through undetected.
//
// THE INCIDENT THIS GUARDS AGAINST: card db413510's first commit (fa04f92c) shipped with the capture
// SCOPED INSIDE `if (inertSkip)`, i.e. AFTER `isInertMergeDiff` had already run and already decided
// `inertSkip`. Code Review caught it; the capture was hoisted above the classification call in 875dd61a
// (merged as 339eda11, now live). This is correct-by-construction — two sequential `await`s with no runtime
// input that can flip their order — so there is nothing to reproduce at runtime; the only realistic future
// regression is a reader re-scoping the capture back inside `if (inertSkip)`, i.e. re-doing fa04f92c. A
// static source-text guard catches that mechanically, forever, at zero runtime cost. See card 60926911 for
// the Code Reviewer's own reasoning against building a runtime (shim-`git`) repro instead.
//
// ⭐ POSITIVE CONTROL (DoD-3): this guard asserts a property that is CURRENTLY TRUE, so a matcher that is
// simply broken and matches nothing would return exactly the same green as a correct one. (B) below runs the
// same matcher against fa04f92c's real pre-fix arrangement (reconstructed by hand from `git show
// fa04f92c -- packages/daemon/src/sessions/service.ts`) and requires it to go RED — proving the matcher can
// actually fail before trusting it to pass.
//
// ⚠ KEPT NARROW (card 60926911 DoD-5, per card df88c1b2's own record of a broad static scanner exhausting
// itself after 5 independent scope defects): this guard checks exactly ONE named pair of lines in ONE file —
// it does NOT generalize into "every resolveGitRef call must precede every classification call."
//
// Run: node packages/daemon/test/inert-skip-branch-capture-order-guard.mjs (no build needed — pure fs/regex)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const SERVICE_TS = path.join(repoRoot, "packages", "daemon", "src", "sessions", "service.ts");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// The two lines this guard pins, verbatim (as of card db413510 / 339eda11):
//   const preWaitBranchHead = await resolveGitRef(repoPath, branch, { timeoutMs: this.gitOpMs }) ?? undefined;
//   inertSkip = await isInertMergeDiff(repoPath, gateBaseMainHead, branch, { timeoutMs: this.gitOpMs });
const PRE_WAIT_RE = /const\s+preWaitBranchHead\s*=\s*await\s+resolveGitRef\(/;
const INERT_CALL_RE = /inertSkip\s*=\s*await\s+isInertMergeDiff\(/;

/**
 * Scan `text` line-by-line for exactly one `preWaitBranchHead` capture and exactly one `inertSkip =
 * isInertMergeDiff(...)` classification call, and assert the capture precedes the call.
 * FAILS CLOSED (returns ok:false) on zero matches, more than one match of either, or wrong order — never
 * silently passes on a target it couldn't unambiguously find (DoD-4).
 */
function checkOrdering(text) {
  const lines = text.split("\n");
  const preWaitLines = [];
  const inertLines = [];
  lines.forEach((line, i) => {
    if (PRE_WAIT_RE.test(line)) preWaitLines.push(i);
    if (INERT_CALL_RE.test(line)) inertLines.push(i);
  });
  if (preWaitLines.length !== 1) {
    return { ok: false, reason: `expected exactly 1 preWaitBranchHead capture line, found ${preWaitLines.length}` };
  }
  if (inertLines.length !== 1) {
    return { ok: false, reason: `expected exactly 1 'inertSkip = await isInertMergeDiff(...)' line, found ${inertLines.length}` };
  }
  if (preWaitLines[0] >= inertLines[0]) {
    return {
      ok: false,
      reason: `preWaitBranchHead capture (line ${preWaitLines[0] + 1}) does not precede the isInertMergeDiff classification call (line ${inertLines[0] + 1})`,
    };
  }
  return { ok: true };
}

// ── (A) REAL REPO — the ordering must hold TODAY, or the fix this guards has regressed ─────────────────
{
  let text = null;
  try {
    text = fs.readFileSync(SERVICE_TS, "utf8");
  } catch (err) {
    check(`(A) sessions/service.ts is readable at ${SERVICE_TS} (fail-closed: an unreadable target is a FAIL, not a skip) — ${err.message}`, false);
  }
  if (text != null) {
    const result = checkOrdering(text);
    check(
      `(A) preWaitBranchHead is captured before the isInertMergeDiff classification call in sessions/service.ts${result.ok ? "" : ` — ${result.reason}`}`,
      result.ok,
    );
  }
}

// ── (B) POSITIVE CONTROL — fa04f92c's real pre-fix arrangement, reconstructed by hand from
//        `git show fa04f92c -- packages/daemon/src/sessions/service.ts`: `isInertMergeDiff` ran FIRST, and
//        `preWaitBranchHead` was captured afterward, inside `if (inertSkip) { ... }`. The matcher MUST go
//        RED against this — a guard that has never fired against the real defect proves nothing. ──────────
{
  const preFixFa04f92c = [
    "        inertSkip = await isInertMergeDiff(repoPath, gateBaseMainHead, branch, { timeoutMs: this.gitOpMs });",
    "        if (inertSkip) {",
    "          gateRan = false;",
    "          const preWaitBranchHead = await resolveGitRef(repoPath, branch, { timeoutMs: this.gitOpMs }) ?? undefined;",
    "          try {",
  ].join("\n");
  const result = checkOrdering(preFixFa04f92c);
  check("(B) the matcher goes RED against fa04f92c's real pre-fix ordering (positive control)", !result.ok);
}

// ── (C) FAIL-CLOSED CONTROLS — zero matches and duplicate matches must both fail, never silently pass
//        (DoD-4: a guard that passes when it cannot unambiguously find its target is worse than none) ────
{
  const noMatches = "const somethingUnrelated = 1;\n";
  check("(C1) zero matches of either target line fails closed", !checkOrdering(noMatches).ok);

  const duplicatePreWait = [
    "const preWaitBranchHead = await resolveGitRef(repoPath, branch, { timeoutMs: this.gitOpMs }) ?? undefined;",
    "const preWaitBranchHead = await resolveGitRef(repoPath, branch, { timeoutMs: this.gitOpMs }) ?? undefined;",
    "inertSkip = await isInertMergeDiff(repoPath, gateBaseMainHead, branch, { timeoutMs: this.gitOpMs });",
  ].join("\n");
  check("(C2) a duplicate preWaitBranchHead capture line fails closed (ambiguous target)", !checkOrdering(duplicatePreWait).ok);

  const missingInert = "const preWaitBranchHead = await resolveGitRef(repoPath, branch, { timeoutMs: this.gitOpMs }) ?? undefined;\n";
  check("(C3) a missing isInertMergeDiff classification line fails closed", !checkOrdering(missingInert).ok);
}

// ── (D) SANITY — the correctly-ordered fixture DOES pass, proving (A)/(B) aren't vacuously identical
//        outcomes (i.e. the matcher isn't simply always-red or always-green) ────────────────────────────
{
  const postFix = [
    "const preWaitBranchHead = await resolveGitRef(repoPath, branch, { timeoutMs: this.gitOpMs }) ?? undefined;",
    "inertSkip = await isInertMergeDiff(repoPath, gateBaseMainHead, branch, { timeoutMs: this.gitOpMs });",
  ].join("\n");
  check("(D) a correctly-ordered fixture passes (sanity: the matcher can distinguish the two arrangements)", checkOrdering(postFix).ok);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — sessions/service.ts still captures preWaitBranchHead before classifying inertSkip, the matcher is proven to go RED against fa04f92c's real pre-fix ordering, and it fails closed on an unreadable file or an ambiguous (zero/duplicate) match."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
