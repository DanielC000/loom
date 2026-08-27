import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure fs
// STANDING GUARD (card 36b21c1a) — asserts the two bundled `serve-static.mjs` copies stay byte-identical.
// Nothing enforced this before this guard: `orchestrate/scripts/serve-static.mjs` and
// `web-design/scripts/serve-static.mjs` are two independent files on disk (each ships self-contained to
// end users' projects — see the SCOPE FENCE below), not one shared module, so a fix landing in one silently
// forks them while the other rig's workers keep the bug and everyone believes it's fixed. `cb1101a0`
// (the trigger for this card) changed both copies and carried a manual "change both and diff them"
// instruction in its own DoD; this guard is the structural version of that instruction, so the next change
// doesn't depend on someone remembering.
//
// ⭐ WHY THESE TWO NAMED PATHS, AND NOT A GENERIC "no duplicate basenames across skills" RULE (card
// 36b21c1a's own narrowness argument — re-derive before widening this guard):
//   `git ls-files packages/daemon/assets/skills | xargs -n1 basename | sort | uniq -d` finds THREE
//   duplicated basenames as of this card. Only `serve-static.mjs` is a genuine shared unit:
//     - `SKILL.md` — one per skill by construction. Not duplication at all.
//     - `project-memory.md` (orchestrate/references/ + worker/references/) — DELIBERATELY
//       audience-tailored (manager vs. worker variants) and legitimately divergent. Reconciling these two
//       would destroy an intended difference, not fix a bug.
//   A guard scoped to "any duplicated basename" would fire on both of those on its very first run and need
//   permanent suppression — a guard that must be suppressed on its first two hits is a guard nobody keeps.
//   So this guard names the two `serve-static.mjs` paths explicitly rather than globbing by basename.
//
// 🔴 FAIL CLOSED on either path missing or unreadable (ENOENT, EACCES, or any other read error) — never
// silently pass. A renamed or deleted copy going unnoticed is exactly how this guard would otherwise rot
// into a no-op; a missing file is reported as its own FAIL, not skipped.
//
// ⛔ SCOPE FENCE (card 36b21c1a): this guard DETECTS drift; it does not restructure. Do not de-duplicate
// the file into a shared module — each bundled skill ships self-contained to end users' projects, and
// collapsing that is a distribution change well beyond what this guard is for. Do not change either file's
// behavior here — that belongs to whatever card is fixing the actual bug (e.g. `cb1101a0`).
//
// ⚠️ STATIC_GUARD_REPO_PATHS MEMBERSHIP (card 36b21c1a DoD-5) — DECIDED: NOT ADDED, and this reverses the
// card's own framing, verified against the tree rather than inherited from it. `git/worktrees.ts`'s
// membership criterion (card a1734000): "a guard belongs there only if something OTHER than a behavioural
// .ts edit can invalidate what it asserts" — because a behavioural .ts edit ALREADY fails the emit-compare
// reduced path closed to the full gate, where every guard under packages/daemon/test/ runs anyway via the
// corpus walk (`walkMjsFiles` in scripts/test-daemon.mjs, confirmed to include this file: it excludes only
// `fixtures/`/`census/` subtrees and `_`-prefixed names, neither of which applies here).
//   The card assumed an `assets/**` edit — the only thing that can invalidate THIS guard's assertion — does
//   NOT force a full gate. Read directly against `computeEmitCompareGate` and `isInertMergeDiff`
//   (git/worktrees.ts), that's backwards: `INERT_MERGE_PATH_PREFIXES` is `["docs/"]` only (an assets/**
//   path is never inert-skip-eligible), and `computeEmitCompareGate` classifies ONLY
//   `packages/daemon/src/*.ts` and `packages/daemon/test/*.mjs` paths as eligible for the reduced path,
//   plus (card b97f643d, added AFTER this note was first written — re-verified still true for `assets/**`,
//   not silently inherited) a third class of path already certified inert by `INERT_MERGE_PATH_PREFIXES`,
//   which is SKIPPED from consideration rather than blocking eligibility — any changed path outside all
//   three (assets/** included, since it's on none of them) still hits `notEligible("path outside
//   emit-compare scope")` or the function's empty-set guard, either of which `sessions/service.ts` maps
//   straight to `effectiveGate = gate` (the FULL gate, unreduced).
//   So an edit to either serve-static.mjs copy ALWAYS takes the full gate, exactly like a behavioural .ts
//   edit does — it is never reachable-but-unrun on a reduced path, by the criterion's own terms. Adding this
//   guard to STATIC_GUARD_REPO_PATHS would cost a second hand-maintained list entry (plus the
//   GUARD_BASENAMES mirror in emit-compare-gate.mjs — see that file's own doc for why the omission direction
//   fails silently) to protect against a code path that can't happen. Re-derive this if
//   `EMIT_COMPARE_SRC_PREFIX`/`EMIT_COMPARE_TEST_PREFIX`/`INERT_MERGE_PATH_PREFIXES` ever widen to cover
//   `assets/**`, OR if a new exempt-path class is ever added to `computeEmitCompareGate`'s classification
//   loop (the card b97f643d shape: a new SKIPPED-not-blocking category, distinct from widening an existing
//   allowlist) — either would reopen the question this note just closed, and neither is guaranteed to be
//   caught by re-reading only the three named constants above.
//
// ✅ POSITIVE CONTROL (run manually, not part of this file's own execution — pasted in the task report,
// same convention as clock-path-regression-guard.mjs):
//   1. Perturb ONE byte of either tracked copy on disk (e.g. append a single space to
//      orchestrate/scripts/serve-static.mjs) without staging/committing it.
//   2. `node packages/daemon/test/serve-static-parity-guard.mjs` → must FAIL, reporting the two paths as
//      no longer byte-identical.
//   3. `git checkout -- packages/daemon/assets/skills/orchestrate/scripts/serve-static.mjs` (restores the
//      real, unperturbed file) and confirm `git status`/`git diff` show it byte-identical to HEAD again.
//   4. `node packages/daemon/test/serve-static-parity-guard.mjs` → must PASS again.
//
// Run: node packages/daemon/test/serve-static-parity-guard.mjs (no build needed — pure fs byte-compare)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/daemon/test -> packages/daemon -> packages -> repo root (three levels up).
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Repo-root-relative, named explicitly rather than derived from a glob — see the header's narrowness
// argument for why a basename glob would be the wrong tool here.
const PATH_A = "packages/daemon/assets/skills/orchestrate/scripts/serve-static.mjs";
const PATH_B = "packages/daemon/assets/skills/web-design/scripts/serve-static.mjs";

function readBufferOrNull(repoRelPath) {
  try {
    return fs.readFileSync(path.join(REPO_ROOT, repoRelPath));
  } catch (err) {
    console.log(`  READ-ERROR  ${repoRelPath}: ${err && err.code ? err.code : err}`);
    return null;
  }
}

const bufA = readBufferOrNull(PATH_A);
const bufB = readBufferOrNull(PATH_B);

check(`${PATH_A} is present and readable`, bufA !== null);
check(`${PATH_B} is present and readable`, bufB !== null);

if (bufA !== null && bufB !== null) {
  const identical = bufA.equals(bufB);
  check(`${PATH_A} and ${PATH_B} are byte-identical (${bufA.length} vs ${bufB.length} bytes)`, identical);
  if (!identical) {
    // Report the first differing byte offset — enough to locate the drift without dumping either file's
    // full content into gate output.
    const minLen = Math.min(bufA.length, bufB.length);
    let firstDiff = -1;
    for (let i = 0; i < minLen; i++) {
      if (bufA[i] !== bufB[i]) { firstDiff = i; break; }
    }
    if (firstDiff === -1 && bufA.length !== bufB.length) firstDiff = minLen;
    console.log(`  first differing byte offset: ${firstDiff}`);
  }
} else {
  console.log("  skipping byte-compare — at least one copy could not be read (see READ-ERROR above; this is itself a FAIL, not a skip of the overall guard)");
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the two serve-static.mjs copies (orchestrate + web-design) are present and byte-identical."
  : `\n❌ ${failures} FAILURE(S) — see this file's own header for why these two paths specifically are asserted coupled.`);
process.exit(failures === 0 ? 0 : 1);
