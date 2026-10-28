import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card d5d705f5 — see the decision record's "Round 2 (M1/M2/M3 follow-up)" section for the narrative;
// this proves: (1) N tokens on one record reaching the gate ⇒ ONE walk, not N (an fs-call-counting seam
// on the real, uninjected fs.readdirSync), (2) each token's own tombstoned/surviving verdict is unchanged
// for a mixed set (one direct-hit tombstone, several gate-reaching survivors) under the memo, (3)
// directPathIdentity's own realpath call is ALSO memoized (an fs.realpathSync.native call-counting seam),
// (4) markedFinalFullyCoveredByClear (one M2 site) shares its memo across its own read + `.every()`, and
// (5) a cached "open" gate verdict from token 1 is what lets token 2+ tombstone via the LITERAL key alone.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-d5d705f5-literal-gate-memo.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqd5d7-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  MERGE_QUARANTINE_DIR, enterMergeQuarantine, clearMergeQuarantineByToken,
  readSurvivingOnDiskTokensTestOnly, markedFinalFullyCoveredByClearTestOnly,
} = await import(mergeQuarantineModuleHref);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });

// A: a RESOLVABLE dummy identity under which t1/t2/t3 are tombstoned (direct+literal attributed to A,
// never to U below) -- real raise+clear, exactly how `clearedTokens` is populated in production.
const identityA = fs.mkdtempSync(path.join(loomHome, "identity-a-"));
// U: the record identity actually under test -- deliberately UNRESOLVABLE (never created on disk), so
// classifyLiteralGateFromFs's rule 1 (realpath succeeds) can never short-circuit before the walk runs.
const identityU = path.join(loomHome, "identity-u-does-not-exist", "nested", "leaf");

function raiseAndClear(identity) {
  const token = enterMergeQuarantine(identity, "branch", "reason");
  clearMergeQuarantineByToken(identity, token);
  return token;
}

const t1 = raiseAndClear(identityA);
const t2 = raiseAndClear(identityA);
const t3 = raiseAndClear(identityA);
// t4: tombstoned directly under U itself -- owners.direct hits U's own identity immediately, so this
// token must NEVER reach classifyLiteralGate at all (same before and after the fix).
const t4 = raiseAndClear(identityU);

// Count real fs.readdirSync(loomHome) calls during the ONE read under test -- isolates the WALK's own
// invocation count from `directPathIdentity`'s separate, per-token realpath probe (a different, already
// pre-existing call site that also touches identityU on every token and is deliberately NOT part of this
// fix; see the decision record). identityU's own nearest-existing ancestor is loomHome itself, and
// classifyLiteralGateFromFs's rule-(i) "present in parent listing" check calls `readdir(loomHome)` exactly
// once per invocation while walking up to it -- nothing else in this call path touches loomHome's listing.
// classifyLiteralGate's real binding looks up fs.* methods fresh on every call (see its own doc comment),
// so wrapping the real method here is observed by the actual, uninjected walk -- this instruments the real
// walk's call count, it does not mock its logic.
let readdirOnLoomHome = 0;
const originalReaddirSync = fs.readdirSync;
// @decision d5d705f5 (N2) — compare via path.resolve on both sides, not raw `===` -- the real callers
// (path.dirname/classifyLiteralGateFromFs's own walk) never guarantee the exact same string spelling
// `loomHome` happens to be held in here, only the same resolved location.
fs.readdirSync = function patchedReaddirSync(p, ...rest) {
  if (path.resolve(p) === path.resolve(loomHome)) readdirOnLoomHome++;
  return originalReaddirSync(p, ...rest);
};

let result;
try {
  result = readSurvivingOnDiskTokensTestOnly({ tokens: [t1, t2, t3, t4] }, identityU);
} finally {
  fs.readdirSync = originalReaddirSync;
}

check("walk ran exactly once for 3 gate-reaching tokens on one record (not 3x)", readdirOnLoomHome === 1);
check("t1 (cleared under A, not U) survives the read under U", result.surviving.includes(t1));
check("t2 (cleared under A, not U) survives the read under U", result.surviving.includes(t2));
check("t3 (cleared under A, not U) survives the read under U", result.surviving.includes(t3));
check("t4 (cleared directly under U) does NOT survive the read under U", !result.surviving.includes(t4));
check("raw carries all 4 tokens unfiltered", result.raw.length === 4 && [t1, t2, t3, t4].every((t) => result.raw.includes(t)));
check("surviving carries exactly the 3 non-U-tombstoned tokens", result.surviving.length === 3);

// M1: directPathIdentity(recordIdentity) must ALSO be memoized -- count real fs.realpathSync.native
// calls across the SAME read (same t1..t4/identityU record as above). Fully memoized: 1 call for
// directPathIdentity's own realpath attempt + 2 for classifyLiteralGate (its rule-1 realpath attempt,
// plus check-(ii)'s realpath of the nearest existing ancestor) = 3, regardless of how many of the 4
// tokens reach either check. Before M1's own fix, directPathIdentity alone cost one call PER TOKEN
// (4, one for each of t1..t4) on top of the already-memoized gate's 2 = 6.
let realpathNativeCallsM1 = 0;
let readdirOnLoomHomeM1 = 0;
const originalRealpathNativeM1 = fs.realpathSync.native;
const originalReaddirSyncM1 = fs.readdirSync;
fs.realpathSync.native = function patchedRealpathNativeM1(p, ...rest) {
  realpathNativeCallsM1++;
  return originalRealpathNativeM1(p, ...rest);
};
fs.readdirSync = function patchedReaddirSyncM1(p, ...rest) {
  if (path.resolve(p) === path.resolve(loomHome)) readdirOnLoomHomeM1++;
  return originalReaddirSyncM1(p, ...rest);
};
let resultM1;
try {
  resultM1 = readSurvivingOnDiskTokensTestOnly({ tokens: [t1, t2, t3, t4] }, identityU);
} finally {
  fs.realpathSync.native = originalRealpathNativeM1;
  fs.readdirSync = originalReaddirSyncM1;
}
check("M1: fs.realpathSync.native called exactly 3 times for 4 tokens on one record (1 directPathIdentity + 2 classifyLiteralGate, not 6)", realpathNativeCallsM1 === 3);
check("M1: walk (readdir(loomHome)) still ran exactly once alongside the realpath memo", readdirOnLoomHomeM1 === 1);
check("M1: surviving set unchanged under the combined memo", resultM1.surviving.length === 3 && [t1, t2, t3].every((t) => resultM1.surviving.includes(t)) && !resultM1.surviving.includes(t4));

// M2: one of the three residual `.every()` sites (markedFinalFullyCoveredByClear) must share its OWN
// readSurvivingOnDiskTokens read's memo cell with its own `.every()` recheck, not recompute a second
// time. `final` holds t1/t2/t3 (tombstoned under A, not U) under recordIdentity=identityU, so every
// token reaches the gate in BOTH the internal read and the subsequent `.every()` -- candidateTokens is
// empty, so coverage is decided purely by the (shared) tombstone check.
const finalPathM2 = path.join(MERGE_QUARANTINE_DIR, "d5d705f5-m2-final.json");
fs.writeFileSync(finalPathM2, JSON.stringify({ repoPath: identityU, branch: "b", reason: "r", tokens: [t1, t2, t3] }));
let realpathNativeCallsM2 = 0;
let readdirOnLoomHomeM2 = 0;
const originalRealpathNativeM2 = fs.realpathSync.native;
const originalReaddirSyncM2 = fs.readdirSync;
fs.realpathSync.native = function patchedRealpathNativeM2(p, ...rest) {
  realpathNativeCallsM2++;
  return originalRealpathNativeM2(p, ...rest);
};
fs.readdirSync = function patchedReaddirSyncM2(p, ...rest) {
  if (path.resolve(p) === path.resolve(loomHome)) readdirOnLoomHomeM2++;
  return originalReaddirSyncM2(p, ...rest);
};
try {
  markedFinalFullyCoveredByClearTestOnly(finalPathM2, []);
} finally {
  fs.realpathSync.native = originalRealpathNativeM2;
  fs.readdirSync = originalReaddirSyncM2;
  fs.rmSync(finalPathM2, { force: true });
}
check("M2 (markedFinalFullyCoveredByClear): fs.realpathSync.native called exactly 3 times across the read + its own .every() recheck for 3 tokens (not 12 unmemoized)", realpathNativeCallsM2 === 3);
check("M2 (markedFinalFullyCoveredByClear): walk (readdir(loomHome)) ran exactly once across both (not 4 unmemoized)", readdirOnLoomHomeM2 === 1);

// M3: a record whose gate resolves "open", with 2+ tokens tombstoned ONLY via the LITERAL key -- never
// direct -- proving token 2+ of a loop over one record's own tokens depends on the CACHED "open" gate
// result, not a fresh per-token recompute. Clear while the identity resolves (via a real directory
// junction) so BOTH direct (realpath-based) and literal (pure lexical) identities get recorded at clear
// time; then remove the junction so the identity is genuinely gone at read time -- direct no longer
// matches (its realpath-failure fallback is a bare lexical resolve, never the junction's old target),
// but literal (unaffected by resolution, since it never resolves anything) still does -- and the gate
// must resolve "open" (genuinely gone, no link anywhere on the walk) for literal to be consulted at all.
const identityULit = path.join(loomHome, "identity-u-literal");
const junctionTargetDir = fs.mkdtempSync(path.join(loomHome, "junction-target-"));
fs.symlinkSync(junctionTargetDir, identityULit, "junction");
const tLit1 = raiseAndClear(identityULit);
const tLit2 = raiseAndClear(identityULit);
fs.rmdirSync(identityULit); // removes the junction stub itself -- never recurses into junctionTargetDir

const resultLit = readSurvivingOnDiskTokensTestOnly({ tokens: [tLit1, tLit2] }, identityULit);
check("M3: tLit1 does NOT survive (tombstoned via the LITERAL key -- direct no longer matches post-removal)", !resultLit.surviving.includes(tLit1));
check("M3: tLit2 does NOT survive either -- depends on the SAME cached 'open' gate result tLit1's own check produced", !resultLit.surviving.includes(tLit2));
check("M3: raw still carries both tokens unfiltered", resultLit.raw.length === 2 && [tLit1, tLit2].every((t) => resultLit.raw.includes(t)));

console.log(failures === 0 ? `\nAll checks passed (readdir(loomHome) calls: ${readdirOnLoomHome})` : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
