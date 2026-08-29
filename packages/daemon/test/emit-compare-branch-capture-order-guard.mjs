import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure fs below, no daemon/Db used
// EMIT-COMPARE PRE-CLASSIFICATION BRANCH CAPTURE ORDERING GUARD (card 88ac0d05, extending
// `inert-skip-branch-capture-order-guard.mjs`'s coverage — card 60926911/712f4c0a — to the SIBLING call
// site card 7183540f/877fc958 introduced). `SessionService`'s emit-compare reduced-gate path
// (packages/daemon/src/sessions/service.ts) captures `emitComparePreWaitBranchHead` via `resolveGitRef`
// BEFORE calling `computeEmitCompareGate` — because that function resolves `branch` BY NAME internally,
// so classifying first and capturing the branch tip afterward (even a line later) opens a window where a
// commit landing between the two reads is invisible to the later admission-time
// `postWaitBranchHead !== emitComparePreWaitBranchHead` movement check, letting a stale
// `emitCompareSkip:true` ride through undetected — the exact shape of the incident `db413510`/`fa04f92c`
// caught on the INERT-skip path, one call site over.
//
// THIS GAP: `712f4c0a` pinned that ordering only for the inert-skip pair. `877fc958` then introduced this
// SECOND capture/classify pair with the identical ordering requirement, and the existing guard does not
// match it — so re-scoping this capture inside `if (emitCompare.eligible)` (i.e. re-doing `fa04f92c` at
// this call site) would go undetected. See card `88ac0d05` for the full incident history.
//
// ⚠ WHY THE CAPTURE-SIDE REGEX IS VARIABLE-NAME-SPECIFIC, NOT JUST `resolveGitRef\(`: at the time this
// guard was written, card `91d8e343` (landed hours before this guard) had ALREADY introduced a SECOND,
// UNRELATED `resolveGitRef(...)` capture a few lines below this one — `emitCompareAdmissionMainHead =
// await resolveGitRef(repoPath, "HEAD", ...)`, in the post-wait reclassification block. A bare
// `resolveGitRef\(` regex would match BOTH and trip this guard's own duplicate-match fail-closed leg,
// FAILING on a currently-correct tree. Anchoring on the specific assignment target
// (`emitComparePreWaitBranchHead\s*=`) avoids that near-collision. If you're tempted to simplify this
// regex later, re-check whether a second `resolveGitRef` capture still exists nearby before you do.
//
// ⚠ SAME REASON THE CLASSIFY-SIDE REGEX ANCHORS ON THE ASSIGNMENT, NOT JUST `computeEmitCompareGate\(`:
// `91d8e343` also added a SECOND `computeEmitCompareGate(...)` call site — the post-wait reclassification
// call, `? await computeEmitCompareGate(repoPath, worktreePath, emitCompareAdmissionMainHead, branch,
// ...)`, assigned to `reclassified`, not `emitCompare`. A bare `computeEmitCompareGate\(` regex returns
// 2 matches against the real tree TODAY and would trip the duplicate-match fail-closed leg into a false
// failure. Anchoring on `const\s+emitCompare\s*=\s*await\s+computeEmitCompareGate\(` — the ORIGINAL,
// pre-wait classification call this guard actually cares about — returns exactly 1 match and excludes the
// post-wait reclassification call cleanly, since that one is a ternary (`?  await ...`) assigned to a
// different name.
//
// ⭐ POSITIVE CONTROL (DoD-3): this guard asserts a property that is CURRENTLY TRUE (this pair was born
// correctly ordered at `877fc958` — there is no real historical bad commit for it, unlike the inert-skip
// pair's `fa04f92c`), so a matcher that is simply broken and matches nothing would return exactly the same
// green as a correct one. (B) below runs the same matcher against a SYNTHETIC inverted arrangement —
// `computeEmitCompareGate` running first, with the branch-head capture moved after it, inside
// `if (emitCompare.eligible)` — exactly the re-scoping shape this card names as the realistic regression —
// and requires it to go RED, proving the matcher can actually fail before trusting it to pass.
//
// ⚠ KEPT NARROW (card 88ac0d05 DoD-2, per card df88c1b2's own record of a broad static scanner exhausting
// itself after 5 independent scope defects, and `712f4c0a`'s own precedent): this guard checks exactly ONE
// named pair of lines in ONE file — it does NOT generalize into "every resolveGitRef call must precede
// every classification call." Its fail-closed checks are also independent of
// `inert-skip-branch-capture-order-guard.mjs`'s own — a sibling file, not a shared helper — so one pair's
// coverage going missing can never mask the other's.
//
// Run: node packages/daemon/test/emit-compare-branch-capture-order-guard.mjs (no build needed — pure fs/regex)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const SERVICE_TS = path.join(repoRoot, "packages", "daemon", "src", "sessions", "service.ts");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// The two lines this guard pins, verbatim (as of card 7183540f / 877fc958, unmoved by 91d8e343):
//   emitComparePreWaitBranchHead = await resolveGitRef(repoPath, branch, { timeoutMs: this.gitOpMs }) ?? undefined;
//   const emitCompare = await computeEmitCompareGate(repoPath, worktreePath, gateBaseMainHead, branch, { timeoutMs: this.gitOpMs });
const CAPTURE_RE = /emitComparePreWaitBranchHead\s*=\s*await\s+resolveGitRef\(/;
const CLASSIFY_RE = /const\s+emitCompare\s*=\s*await\s+computeEmitCompareGate\(/;

/**
 * Scan `text` line-by-line for exactly one `emitComparePreWaitBranchHead` capture and exactly one
 * `const emitCompare = computeEmitCompareGate(...)` classification call, and assert the capture precedes
 * the call. FAILS CLOSED (returns ok:false) on zero matches, more than one match of either, or wrong
 * order — never silently passes on a target it couldn't unambiguously find (DoD-4, mirroring
 * `712f4c0a`'s own discipline).
 */
function checkOrdering(text) {
  const lines = text.split("\n");
  const captureLines = [];
  const classifyLines = [];
  lines.forEach((line, i) => {
    if (CAPTURE_RE.test(line)) captureLines.push(i);
    if (CLASSIFY_RE.test(line)) classifyLines.push(i);
  });
  if (captureLines.length !== 1) {
    return { ok: false, reason: `expected exactly 1 emitComparePreWaitBranchHead capture line, found ${captureLines.length}` };
  }
  if (classifyLines.length !== 1) {
    return { ok: false, reason: `expected exactly 1 'const emitCompare = await computeEmitCompareGate(...)' line, found ${classifyLines.length}` };
  }
  if (captureLines[0] >= classifyLines[0]) {
    return {
      ok: false,
      reason: `emitComparePreWaitBranchHead capture (line ${captureLines[0] + 1}) does not precede the computeEmitCompareGate classification call (line ${classifyLines[0] + 1})`,
    };
  }
  return { ok: true };
}

// ── (A) REAL REPO — the ordering must hold TODAY, or the fix this guards against has regressed ─────────
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
      `(A) emitComparePreWaitBranchHead is captured before the computeEmitCompareGate classification call in sessions/service.ts${result.ok ? "" : ` — ${result.reason}`}`,
      result.ok,
    );
  }
}

// ── (B) POSITIVE CONTROL — a SYNTHETIC inversion of the real pair: `computeEmitCompareGate` runs FIRST,
//        and `emitComparePreWaitBranchHead` is captured afterward, inside `if (emitCompare.eligible)` —
//        exactly the re-scoping shape card 88ac0d05 names as "fa04f92c all over again" at this call site.
//        There is no real historical bad commit for THIS pair (born correctly ordered at 877fc958), so
//        this fixture is hand-constructed, not `git show`n. The matcher MUST go RED against it — a guard
//        that has never fired against its own named regression shape proves nothing. ──────────────────────
{
  const syntheticInverted = [
    "        const emitCompare = await computeEmitCompareGate(repoPath, worktreePath, gateBaseMainHead, branch, { timeoutMs: this.gitOpMs });",
    "        if (emitCompare.eligible) {",
    "          emitComparePreWaitBranchHead = await resolveGitRef(repoPath, branch, { timeoutMs: this.gitOpMs }) ?? undefined;",
    "          emitCompareSkip = true;",
  ].join("\n");
  const result = checkOrdering(syntheticInverted);
  check("(B) the matcher goes RED against the synthetic re-scoped-inside-if(eligible) inversion (positive control)", !result.ok);
}

// ── (C) FAIL-CLOSED CONTROLS — zero matches and duplicate matches must both fail, never silently pass
//        (DoD-4: a guard that passes when it cannot unambiguously find its target is worse than none) ────
{
  const noMatches = "const somethingUnrelated = 1;\n";
  check("(C1) zero matches of either target line fails closed", !checkOrdering(noMatches).ok);

  const duplicateCapture = [
    "emitComparePreWaitBranchHead = await resolveGitRef(repoPath, branch, { timeoutMs: this.gitOpMs }) ?? undefined;",
    "emitComparePreWaitBranchHead = await resolveGitRef(repoPath, branch, { timeoutMs: this.gitOpMs }) ?? undefined;",
    "const emitCompare = await computeEmitCompareGate(repoPath, worktreePath, gateBaseMainHead, branch, { timeoutMs: this.gitOpMs });",
  ].join("\n");
  check("(C2) a duplicate emitComparePreWaitBranchHead capture line fails closed (ambiguous target)", !checkOrdering(duplicateCapture).ok);

  const duplicateClassify = [
    "emitComparePreWaitBranchHead = await resolveGitRef(repoPath, branch, { timeoutMs: this.gitOpMs }) ?? undefined;",
    "const emitCompare = await computeEmitCompareGate(repoPath, worktreePath, gateBaseMainHead, branch, { timeoutMs: this.gitOpMs });",
    "const emitCompare = await computeEmitCompareGate(repoPath, worktreePath, gateBaseMainHead, branch, { timeoutMs: this.gitOpMs });",
  ].join("\n");
  check("(C3) a duplicate 'const emitCompare = computeEmitCompareGate(...)' line fails closed (ambiguous target)", !checkOrdering(duplicateClassify).ok);

  const missingClassify = "emitComparePreWaitBranchHead = await resolveGitRef(repoPath, branch, { timeoutMs: this.gitOpMs }) ?? undefined;\n";
  check("(C4) a missing computeEmitCompareGate classification line fails closed", !checkOrdering(missingClassify).ok);

  // The near-collision guarded against above (see the header doc): a second, differently-named
  // resolveGitRef capture and computeEmitCompareGate call — mirroring 91d8e343's real additions — must
  // NOT be mistaken for a second match of THIS pair's own targets.
  const withRealNearCollisions = [
    "emitComparePreWaitBranchHead = await resolveGitRef(repoPath, branch, { timeoutMs: this.gitOpMs }) ?? undefined;",
    "const emitCompare = await computeEmitCompareGate(repoPath, worktreePath, gateBaseMainHead, branch, { timeoutMs: this.gitOpMs });",
    "const emitCompareAdmissionMainHead = await resolveGitRef(repoPath, \"HEAD\", { timeoutMs: this.gitOpMs }) ?? undefined;",
    "const reclassified = (postWaitBranchHead && emitCompareAdmissionMainHead) ? await computeEmitCompareGate(repoPath, worktreePath, emitCompareAdmissionMainHead, branch, { timeoutMs: this.gitOpMs }) : undefined;",
  ].join("\n");
  check("(C5) the near-collision siblings (emitCompareAdmissionMainHead capture + reclassified call) do not trip the duplicate-match fail-closed leg", checkOrdering(withRealNearCollisions).ok);
}

// ── (D) SANITY — the correctly-ordered fixture DOES pass, proving (A)/(B) aren't vacuously identical
//        outcomes (i.e. the matcher isn't simply always-red or always-green) ────────────────────────────
{
  const postFix = [
    "emitComparePreWaitBranchHead = await resolveGitRef(repoPath, branch, { timeoutMs: this.gitOpMs }) ?? undefined;",
    "const emitCompare = await computeEmitCompareGate(repoPath, worktreePath, gateBaseMainHead, branch, { timeoutMs: this.gitOpMs });",
  ].join("\n");
  check("(D) a correctly-ordered fixture passes (sanity: the matcher can distinguish the two arrangements)", checkOrdering(postFix).ok);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — sessions/service.ts still captures emitComparePreWaitBranchHead before classifying via computeEmitCompareGate, the matcher is proven to go RED against the synthetic re-scoped-inside-if(eligible) inversion, it survives 91d8e343's real near-collision siblings without a false duplicate-match failure, and it fails closed on an unreadable file or an ambiguous (zero/duplicate) match."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
