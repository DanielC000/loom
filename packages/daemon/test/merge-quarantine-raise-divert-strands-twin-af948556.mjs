import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card af948556 (Code Review bfa97ca3) -- `consumeMatchedPendingsIntoArmedEntry`'s own raise-divert
// branch (reached when `skipDegradedOccupantGuard` is true AND the fold-in read of the raiser's own
// fresh key's final returns "unreadable") splices every matched pending index out of
// `pendingUnresolvedQuarantines` UNCONDITIONALLY, then unions the raiser's own identity group
// ("ownGroup") BY VALUE into `raiserUnion` and diverts it. Pre-fix, no `replaceEntryEverywhere` call
// ever re-pointed whatever slot an `ownGroup` member's own object reference already occupied in
// `activeQuarantines`.
//
// An `ownGroup` member CAN already be an 883e29bc/64283e06 boot twin -- the SAME reference armed under
// a DIFFERENT (degraded, walked-up) key from an earlier boot, while this identity was still
// unresolvable. Pre-fix, that old slot was left holding a STALE, pre-raise snapshot -- missing the
// raise's own fresh token -- while a SECOND, distinct object (holding the fresh token) existed only in
// `pendingUnresolvedQuarantines`: a genuine, REAL FAIL-OPEN, not merely an invariant-violation curiosity
// -- see SCENARIO 2 below. THE FIX: `for (const p of ownGroup) replaceEntryEverywhere(activeQuarantines,
// p.entry, raiserUnion);`, added right before `divertRaiseEntry(raiserUnion)`.
//
// This scenario lives in its OWN file (not folded into merge-quarantine-raise-protect-failure.mjs,
// a 4700+-line shared-state file whose dozens of earlier scenarios leave unrelated, pre-existing
// `assertQuarantineIdentityInvariantTestOnly` violations for OTHER identities) specifically so the two
// checks that matter most can assert the GLOBAL invariant `.ok` flag directly, with no D-scoped
// substring filtering needed.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-raise-divert-strands-twin-af948556.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqrdst-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqrdst@loom -c user.name=mqrdst";
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqrdst-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-raise-divert-strands-twin (${tag})\n`);
  execSync(`git init -q && git config user.email mqrdst@loom && git config user.name mqrdst`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

// Mirrors merge-quarantine.ts's own (unexported) `pendingDivertFilenameFor`.
function pendingDivertFilenameForTest(repoPath) {
  let real;
  try { real = fs.realpathSync.native(repoPath); } catch { real = path.resolve(repoPath); }
  const identity = process.platform === "win32" ? real.toLowerCase() : real;
  return `pending-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.json`;
}

// Fails the read(s) of `targetPath` whose 1-based call-index is IN `indices`; every other call to that
// path succeeds normally; calls to any OTHER path are untouched.
function injectReadFailureAtCalls(targetPath, indices, code = "EACCES") {
  const real = fs.readFileSync;
  const idxSet = new Set(indices);
  let callCount = 0;
  fs.readFileSync = (p, ...rest) => {
    if (typeof p === "string" && p === targetPath) {
      callCount++;
      if (idxSet.has(callCount)) throw Object.assign(new Error(`${code}: simulated read failure (call #${callCount})`), { code });
    }
    return real(p, ...rest);
  };
  return { restore: () => { fs.readFileSync = real; }, count: () => callCount };
}

let moduleImportCounter = 0;
async function freshMergeQuarantineModule() {
  moduleImportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${moduleImportCounter}`);
}
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // Shared setup for both scenarios below: S is a real, resolvable repo providing a fallback ancestor
  // key Ks. D does not exist yet, so its own latch content's hardcoded `resolvedKey: Ks` (an
  // 883e29bc-style legacy walked-up value) is what PASS 1 trusts at boot -- two on-disk files for D's
  // identity (both carrying resolvedKey: Ks) union into ONE object, armed in activeQuarantines[Ks] AND
  // present in pendingUnresolvedQuarantines TWICE -- this IS the twin. D then becomes real on disk (its
  // own fresh key Kd now differs from Ks), and a third, resolvable identity E occupies Kd's own final
  // right now. D then raises again, with two precisely-targeted injected read failures landing the
  // raise squarely in the branch under test (`ownGroup` = D's own two twin pending slots).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  async function setupAndRaise(mod, tag) {
    const {
      activeMergeQuarantineFor, reenterMergeQuarantinesAtBoot, MERGE_QUARANTINE_DIR, enterMergeQuarantine,
    } = mod;
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const s = makeToplevelRepo(`${tag}-s`);
    const Ks = canonicalRepoLockKey(s);
    const Kshash = createHash("sha256").update(Ks).digest("hex").slice(0, 24);
    const d = path.join(os.tmpdir(), `loom-mqrdst-${tag}-d-nonexistent-${freshSfx()}`);

    const KsFinalPath = path.join(MERGE_QUARANTINE_DIR, `${Kshash}.json`);
    fs.writeFileSync(KsFinalPath, JSON.stringify({
      repoPath: d, branch: "d-branch-boot-a", reason: `${tag}: D degraded, walked up to S's own key (A)`,
      enteredAt: Date.now(), tokens: [`${tag}-tok-b`], resolvedKey: Ks,
    }, null, 2) + "\n");
    const dPendingPath = path.join(MERGE_QUARANTINE_DIR, pendingDivertFilenameForTest(d));
    fs.writeFileSync(dPendingPath, JSON.stringify({
      repoPath: d, branch: "d-branch-boot-b", reason: `${tag}: D's own earlier record, also resolvedKey=S's key (B)`,
      enteredAt: Date.now() - 100000, tokens: [`${tag}-tok-c`], resolvedKey: Ks,
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([]);

    check(`(${tag} precondition) the TWIN exists: D armed at S's own key with both boot tokens unioned`,
      (() => {
        const direct = activeMergeQuarantineFor(s);
        return !!direct && direct.repoPath === d && new Set(direct.tokens).has(`${tag}-tok-b`) && new Set(direct.tokens).has(`${tag}-tok-c`);
      })());

    fs.mkdirSync(d, { recursive: true });
    execSync(`git init -q && git config user.email mqrdst@loom && git config user.name mqrdst`, { cwd: d });
    fs.writeFileSync(path.join(d, "README.md"), `# ${tag} d (now real)\n`);
    commitAll(d, "init", GIT_ID);
    const Kd = canonicalRepoLockKey(d);
    check(`(${tag} setup) D's own fresh key differs from S's key`, Kd !== Ks);
    const Kdhash = createHash("sha256").update(Kd).digest("hex").slice(0, 24);
    const KdFinalPath = path.join(MERGE_QUARANTINE_DIR, `${Kdhash}.json`);

    const e = makeToplevelRepo(`${tag}-e`);
    const eBytes = JSON.stringify({
      repoPath: e, branch: "e-branch", reason: `${tag}: E, a resolvable third party, occupies D's own fresh key right now`,
      enteredAt: Date.now(), tokens: [`${tag}-tok-e`],
    }, null, 2) + "\n";
    fs.writeFileSync(KdFinalPath, eBytes);

    // Call #1: the early protect-before-write gate's own detector read of Kd's final -- injected to fail
    // (non-ENOENT), marking `keptUnreadableLatchFiles` without ever determining E's own identity.
    // Call #2 (left to succeed): `resolveRaiseOverwrite`'s own independent re-read -- reads E's real,
    // resolvable, non-overlapping-token record and returns "proceed" (the mark from call #1 survives
    // this success -- a documented staleness residual).
    // Call #3: the fold-in read inside `consumeMatchedPendingsIntoArmedEntry` itself -- injected to fail
    // too, returning the literal "unreadable" and landing in the raise-divert branch under test.
    const inject = injectReadFailureAtCalls(KdFinalPath, [1, 3]);
    const dNewToken = enterMergeQuarantine(d, "d-branch-after-raise", `${tag}: D raises again now that it is resolvable, absorbing its own boot twin`);
    inject.restore();
    check(`(${tag} precondition) exactly 3 reads of Kd's own final were observed (matches the injection plan)`,
      inject.count() === 3);

    // *** WITNESSES (prove the raise-divert branch was actually reached, not some other path, so
    // injection-numbering drift can never silently exercise a different branch and pass vacuously). ***
    check(`*** WITNESS (${tag}) *** E's own bytes at Kd's final are byte-identical to what was written -- the raise never touched Kd's final at all (it diverted instead)`,
      (() => { try { return fs.readFileSync(KdFinalPath, "utf8") === eBytes; } catch { return false; } })());
    check(`*** WITNESS (${tag}) *** a pending record for D exists on disk at its own deterministic pending-divert filename, carrying D's own repoPath and fresh token`,
      (() => {
        try {
          const raw = fs.readFileSync(dPendingPath, "utf8");
          const parsed = JSON.parse(raw);
          return parsed.repoPath === d && new Set(parsed.tokens ?? []).has(dNewToken);
        } catch { return false; }
      })());

    return { s, d, Ks, Kd, dNewToken };
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 1 -- the identity-invariant / stale-object shape, checked strictly MID-WINDOW: directly
  // after `inject.restore()`, before ANY query (even `activeMergeQuarantineFor`) that could itself
  // trigger ordinary lazy graduation and self-heal the pre-fix duplicate before these checks run. Its
  // own freshly-imported module instance (never shared with SCENARIO 2) so the GLOBAL invariant `.ok`
  // flag is meaningful with zero cross-scenario residue.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const mod1 = await freshMergeQuarantineModule();
  const { s, d, dNewToken } = await setupAndRaise(mod1, "af948556-s1");

  // *** THE FIX, mid-window (GLOBAL invariant -- nothing else has ever touched this module instance's
  // state, so .ok is directly meaningful here, unlike a shared, 4700-line, many-scenario file). ***
  check("*** THE FIX (SCENARIO 1, mid-window) *** the GLOBAL identity invariant holds -- no stray duplicate object",
    mod1.assertQuarantineIdentityInvariantTestOnly().ok);
  check("*** THE FIX (SCENARIO 1, mid-window) *** exactly one D-repoPath object exists",
    mod1.listActiveMergeQuarantines().filter((en) => en.repoPath === d).length === 1);
  check("*** THE FIX (SCENARIO 1, mid-window) *** S's own slot already includes D's fresh token -- no later query of D's own key needed to see it",
    (() => { const at = mod1.activeMergeQuarantineFor(s); return !!at && new Set(at.tokens ?? []).has(dNewToken); })());
  check("(SCENARIO 1, mid-window) it also still carries both of D's pre-existing boot tokens",
    (() => { const at = mod1.activeMergeQuarantineFor(s); return !!at && new Set(at.tokens ?? []).has("af948556-s1-tok-b") && new Set(at.tokens ?? []).has("af948556-s1-tok-c"); })());
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 -- THE FAIL-OPEN (Code Review bfa97ca3). Pre-fix, right after the raise and BEFORE any
  // query, clearing D's two ORIGINAL (pre-raise, stale-slot) tokens one at a time -- clearMergeQuarantineByToken(d,
  // tok-b) then (d, tok-c) -- empties the STALE Ks object down to zero tokens. Likely mechanism: the
  // by-key clear sweep that fires once an active entry empties also reaches into D's own SEPARATE
  // pending `raiserUnion` record (same identity) and lifts it too -- even though `raiserUnion` still
  // carries D's own FRESH, never-cleared token. Result pre-fix: S and D both report OPEN (not
  // quarantined) while D's fresh token is still outstanding -- a genuine, in-process FAIL-OPEN, not
  // merely a bookkeeping inconsistency. Its own freshly-imported module instance, same reason as
  // SCENARIO 1.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
  const mod2 = await freshMergeQuarantineModule();
  const { s, d, dNewToken } = await setupAndRaise(mod2, "af948556-s2");

  mod2.clearMergeQuarantineByToken(d, "af948556-s2-tok-b");
  mod2.clearMergeQuarantineByToken(d, "af948556-s2-tok-c");

  check("*** THE FIX (SCENARIO 2, fail-open) *** S stays BLOCKED after clearing only D's two stale tokens -- D's fresh token is still outstanding",
    !!mod2.activeMergeQuarantineFor(s));
  check("*** THE FIX (SCENARIO 2, fail-open) *** D stays BLOCKED after clearing only D's two stale tokens -- D's fresh token is still outstanding",
    !!mod2.activeMergeQuarantineFor(d));
  check("(SCENARIO 2, fail-open) D's fresh token is still the one actually enforcing the block",
    (() => {
      const atS = mod2.activeMergeQuarantineFor(s);
      const atD = mod2.activeMergeQuarantineFor(d);
      return (!!atS && new Set(atS.tokens ?? []).has(dNewToken)) || (!!atD && new Set(atD.tokens ?? []).has(dNewToken));
    })());

  // Sanity: clearing the fresh token too now genuinely lifts both.
  mod2.clearMergeQuarantineByToken(d, dNewToken);
  check("(SCENARIO 2, sanity) D is fully lifted once its fresh token is ALSO released",
    !mod2.activeMergeQuarantineFor(s) && !mod2.activeMergeQuarantineFor(d));
  }
} catch (e) {
  console.error("UNCAUGHT:", e);
  failures++;
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
