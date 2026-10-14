import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 500e307a — a follow-up to db0a9db0 (out of that card's scope, filed at re-CR 887b8c5f): a
// BRAND-NEW resolvedKey-bearing entry minted at RUNTIME (enterMergeQuarantine's own fresh-entry branch,
// and consumeMatchedPendingsIntoArmedEntry's own "armed" result) never set `provenanceTracked: true` on
// its OWN in-memory object — only writeMergeQuarantineLatch's own WRITE stamped it, onto the serialized
// bytes, never back onto the in-memory entry. Harmless today (detectUnknownProvenance only runs at
// boot-time parse, never against a live in-memory object), but a latent in-memory/on-disk inconsistency:
// if a FUTURE change ever persists a fresh resolvedKey-bearing entry through a non-stamping writer
// (writeSafetyTmpResidueAtHash, writePendingDivertFile) before that entry is ever written via
// writeMergeQuarantineLatch, the resulting bytes would lack provenanceTracked, and a later boot's
// detectUnknownProvenance could mis-mark a perfectly current-format entry provenanceUnknown (fail-closed,
// but a regression). THE FIX: stamp `provenanceTracked: true` on the in-memory entry at the two TRUE
// runtime origin points — enterMergeQuarantine's brand-new/verified branch (merge-quarantine.ts, the
// `resolvedKey: key, armedKeys: [key]` literal) and consumeMatchedPendingsIntoArmedEntry's own `armed`
// result (shared by enterMergeQuarantine's pending-merge/sibling-absorb branches AND
// activeMergeQuarantineFor's lazy-graduation tail) — so every writer, stamping or not, carries it forward
// naturally from there on. enterMergeQuarantine's OWN existing/sibling-absorb branch is DELIBERATELY left
// unchanged (manager correction, see scenario (e) below): `existing` can be a boot-marked LEGACY
// (provenanceUnknown) entry, and forcing provenanceTracked there risks laundering unknown provenance into
// tracked — scenario (e) proves the spread-inherited status quo already closes that risk via
// detectUnknownProvenance's own check ORDER (provenanceUnknown checked BEFORE provenanceTracked).
//
// NOT re-tested here (already covered elsewhere, confirmed unaffected by this card):
//  - writeSafetyTmpResidueAtHash/writeSafetyTmpResidue: grepped — ZERO runtime callers today (both call
//    sites live inside reenterMergeQuarantinesAtBootImpl; the functions are unexported). Its own
//    provenanceTracked carry-forward is already pinned, boot-seam-only, by
//    merge-quarantine-unknown-provenance.mjs's scenario (h) pins (7)/(8) — no runtime caller exists to
//    "drive a raise through", so it is not re-tested here; re-run that sibling file to confirm no
//    regression instead of duplicating its coverage.
//  - protectDegradedOccupantBeforeDelete's own protect-copy: already pinned for BOTH provenanceUnknown
//    AND provenanceTracked carry-forward by the SAME sibling file's scenario (h) pins (3)/(10), via a REAL
//    runtime protect trigger. Reads `provenanceTracked` from the FINAL file's own on-disk bytes (never
//    from an in-memory entry this card touches) — those bytes are always already correctly stamped by
//    writeMergeQuarantineLatch's own unconditional stamp (db0a9db0 round 2), so this path was never part
//    of the gap this card closes.
//
// EACH SCENARIO RUNS IN ITS OWN CHILD PROCESS WITH ITS OWN FRESH LOOM_HOME — mirrors every sibling
// merge-quarantine*.mjs file.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-runtime-provenance-stamp.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCENARIOS = [
  // (a) enterMergeQuarantine's own brand-new/verified branch — the TRUE runtime origin of a fresh
  // resolvedKey-bearing entry. provenanceTracked must be true on the in-memory object
  // IMMEDIATELY, same process, before any disk round-trip.
  "fresh-raise-stamps-provenance-tracked-in-memory",
  // (b1) enterMergeQuarantine's own pending-merge branch, which arms via
  // consumeMatchedPendingsIntoArmedEntry WITH a fresh `extra` — the entry becomes resolvedKey-bearing for
  // the first time inside that shared helper, not inline.
  "pending-merge-graduation-stamps-provenance-tracked",
  // (b2) activeMergeQuarantineFor's own lazy-graduation tail, which arms via the SAME shared helper
  // WITHOUT a fresh `extra` (a bare query, no new raise) — the other call shape consumeMatchedPendingsIntoArmedEntry
  // supports.
  "lazy-graduation-query-stamps-provenance-tracked",
  // (c) writePendingDivertFile — the one non-stamping writer genuinely reachable from a runtime CLEAR
  // call (clearMergeQuarantineByToken -> clearTokenFromPendingIndices' partial-clear branch) with a
  // resolvedKey-bearing entry whose own armedKeys members are NOT present in activeQuarantines (so the
  // write loop's own writeMergeQuarantineLatch calls are skipped entirely — this write is the ONLY one
  // that touches disk). Proves BOTH directions: an entry that already carries provenanceTracked survives
  // it faithfully, and one that doesn't is NOT silently force-stamped (confirming "non-stamping" is real,
  // which is the premise the fix at (a)/(b) depends on).
  "write-pending-divert-file-passes-through-never-forces",
  // (e) THE MANAGER-MANDATED PRECEDENCE SCENARIO: a boot-marked provenanceUnknown (legacy stray-union)
  // entry, then a GENUINE runtime sibling raise absorbs into it via enterMergeQuarantine's own
  // existing/sibling-absorb branch (left unchanged, never stamping provenanceTracked there) — then a
  // reboot. Must STILL read provenanceUnknown, and clear-by-id must STILL refuse. Also states the
  // precedence rule directly: the written bytes carry BOTH provenanceUnknown:true AND
  // provenanceTracked:true simultaneously (writeMergeQuarantineLatch's own unconditional stamp
  // applies regardless), and detectUnknownProvenance's own check order (provenanceUnknown checked BEFORE
  // provenanceTracked) is what keeps that coexistence from laundering anything.
  "sibling-absorb-into-legacy-unknown-entry-stays-unknown-after-reboot",
];

const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="));

if (!scenarioArg) {
  const { LOOM_HOME: _inherited, ...envWithoutLoomHome } = process.env;
  let failedScenarios = 0;
  for (const name of SCENARIOS) {
    console.log(`\n=== SCENARIO ${name} (own process, own LOOM_HOME) ===`);
    try {
      execFileSync(process.execPath, [__filename, `--scenario=${name}`], {
        env: envWithoutLoomHome, stdio: "inherit",
      });
      console.log(`--- ${name}: PASS ---`);
    } catch {
      console.log(`--- ${name}: FAIL ---`);
      failedScenarios++;
    }
  }
  console.log(failedScenarios === 0
    ? "\n✅ ALL SCENARIOS PASS — a runtime-created resolvedKey-bearing merge-quarantine entry carries "
      + "provenanceTracked on its OWN in-memory object from the instant it is created, not only in "
      + "writeMergeQuarantineLatch's own serialized bytes; a legacy provenanceUnknown entry is never "
      + "laundered by this."
    : `\n❌ ${failedScenarios} SCENARIO(S) FAILED — reproduces board card 500e307a.`);
  process.exit(failedScenarios === 0 ? 0 : 1);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD MODE — below this point, exactly one scenario runs, in its own fresh LOOM_HOME.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
const scenarioName = scenarioArg.slice("--scenario=".length);
useOwnLoomHome(`loom-mqrp-${scenarioName}-`);
requireHermeticEnv();

const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  reenterMergeQuarantinesAtBoot, reenterMergeQuarantinesAtBootTestOnly, activeMergeQuarantineFor,
  enterMergeQuarantine, clearMergeQuarantineLatchFile, clearMergeQuarantineByRecordedPath,
  clearMergeQuarantineByToken, assertRepoNotQuarantined, MERGE_QUARANTINE_DIR,
} = await import(mergeQuarantineModuleHref);
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqrp@loom -c user.name=mqrp";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

let bootReimportCounter = 0;
async function rebootSim() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

function hashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

function makeRealRepo(tag) {
  const dir = path.join(os.tmpdir(), `loom-mqrp-${tag}-${freshSfx()}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, "README.md"), `# ${tag}\n`);
  execSync(`git init -q && git config user.email mqrp@loom && git config user.name mqrp`, { cwd: dir });
  commitAll(dir, "init", GIT_ID);
  return dir;
}

// Mirrors merge-quarantine-unknown-provenance.mjs's own writePreFixLatch — writes a latch JSON with ONLY
// the pre-82032b5c/pre-db0a9db0 persisted fields (no armedKeys, no contributorRepoPaths, no
// provenanceUnknown, no provenanceTracked), at the given target hash.
function writePreFixLatch(targetHash, { repoPath, branch, reason, enteredAt, tokens, resolvedKey }) {
  fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
  const file = path.join(MERGE_QUARANTINE_DIR, `${targetHash}.json`);
  fs.writeFileSync(file, JSON.stringify({ repoPath, branch, reason, enteredAt, tokens, resolvedKey }, null, 2) + "\n");
  return file;
}

try {
  if (scenarioName === "fresh-raise-stamps-provenance-tracked-in-memory") {
    const repo = makeRealRepo("a-repo");
    enterMergeQuarantine(repo, "a-branch", "a's own brand-new, verified raise");
    const entry = activeMergeQuarantineFor(repo);
    check("*** THE FIX *** the brand-new in-memory entry carries provenanceTracked immediately (no reboot, no re-write)", entry?.provenanceTracked === true);
    check("(sanity) it genuinely is resolvedKey-bearing", typeof entry?.resolvedKey === "string" && entry.resolvedKey.length > 0);
    const key = canonicalRepoLockKey(repo);
    const onDisk = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, `${hashForKey(key)}.json`), "utf8"));
    check("(sanity, non-discriminating — writeMergeQuarantineLatch already force-stamps unconditionally) on-disk bytes also carry it", onDisk.provenanceTracked === true);
  } else if (scenarioName === "pending-merge-graduation-stamps-provenance-tracked") {
    const p = path.join(os.tmpdir(), `loom-mqrp-b1-p-${freshSfx()}`);
    tmpDirs.push(p); // not yet created — registered now so cleanup covers it once git-init'd below
    enterMergeQuarantine(p, "p-branch-1", "p's first raise — still unresolvable, diverts to pending");
    check("(precondition) p is pending-only, no active entry carries it yet", activeMergeQuarantineFor(p)?.resolvedKey === undefined);

    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, "README.md"), "# p\n");
    execSync(`git init -q && git config user.email mqrp@loom && git config user.name mqrp`, { cwd: p });
    commitAll(p, "init", GIT_ID);

    // p is now resolvable — this SECOND raise hits enterMergeQuarantine's own "allPendingIndices.length>0
    // && verified" branch, which arms via consumeMatchedPendingsIntoArmedEntry WITH a fresh `extra`.
    enterMergeQuarantine(p, "p-branch-2", "p's second raise — now resolvable, graduates the pending entry");
    const entry = activeMergeQuarantineFor(p);
    check("*** THE FIX *** the graduated (pending-merge) entry carries provenanceTracked immediately", entry?.provenanceTracked === true);
    check("(sanity) it carries both raises' own tokens", (entry?.tokens ?? []).length === 2);
  } else if (scenarioName === "lazy-graduation-query-stamps-provenance-tracked") {
    const q = path.join(os.tmpdir(), `loom-mqrp-b2-q-${freshSfx()}`);
    tmpDirs.push(q);
    enterMergeQuarantine(q, "q-branch", "q's only raise — still unresolvable, diverts to pending");

    fs.mkdirSync(q, { recursive: true });
    fs.writeFileSync(path.join(q, "README.md"), "# q\n");
    execSync(`git init -q && git config user.email mqrp@loom && git config user.name mqrp`, { cwd: q });
    commitAll(q, "init", GIT_ID);

    // A bare QUERY (no new raise) now that q is resolvable — this hits activeMergeQuarantineFor's own
    // lazy-graduation tail, which arms via consumeMatchedPendingsIntoArmedEntry WITHOUT an `extra`.
    const entry = activeMergeQuarantineFor(q);
    check("*** THE FIX *** the lazily-graduated (query-only) entry carries provenanceTracked immediately", entry?.provenanceTracked === true);
  } else if (scenarioName === "write-pending-divert-file-passes-through-never-forces") {
    // Constructed directly via the test-only injection seam (mirrors
    // merge-quarantine-unknown-provenance.mjs's own "pending-tier-refusal-drives-real-clear-by-path-route"
    // scenario) — a SYNTHETIC fixture, not a realistic runtime state: no runtime path ever creates a
    // pending-only entry that already carries resolvedKey/armedKeys (a fresh pending entry — e.g.
    // enterMergeQuarantine's own unresolvable-raise branch — carries neither). This fixture exists purely
    // to PIN writePendingDivertFile's own write behaviour in isolation, by handing it an entry shaped
    // exactly how it would need to be shaped for the write to be resolvedKey-bearing, with NO active
    // counterpart in activeQuarantines at all — so clearTokenFromPendingIndices' own per-key
    // writeMergeQuarantineLatch loop is a no-op for every member of armedKeys
    // (activeQuarantines.get(k) !== updated for all of them), and writePendingDivertFile is the ONLY
    // write that touches disk for this entry.
    const w1 = path.join(os.tmpdir(), `loom-mqrp-c-w1-never-exists-${freshSfx()}`);
    const fakeKeyW1 = path.join(os.tmpdir(), `loom-mqrp-c-fakekey1-${freshSfx()}`);
    const sourceFile1 = `pending-${createHash("sha256").update(`500e307a-w1-${freshSfx()}`).digest("hex").slice(0, 24)}.json`;
    const tok1a = "tok1a-" + freshSfx(), tok1b = "tok1b-" + freshSfx();
    const injectedTracked = {
      entry: {
        repoPath: w1, branch: "w1-branch", reason: "synthetic fixture pinning writePendingDivertFile's own write behaviour — resolvedKey+armedKeys set (no real pending entry ever carries these), provenanceTracked already true",
        enteredAt: Date.now(), tokens: [tok1a, tok1b], resolvedKey: fakeKeyW1, armedKeys: [fakeKeyW1], provenanceTracked: true,
      },
      sourceFile: sourceFile1,
    };

    const w2 = path.join(os.tmpdir(), `loom-mqrp-c-w2-never-exists-${freshSfx()}`);
    const fakeKeyW2 = path.join(os.tmpdir(), `loom-mqrp-c-fakekey2-${freshSfx()}`);
    const sourceFile2 = `pending-${createHash("sha256").update(`500e307a-w2-${freshSfx()}`).digest("hex").slice(0, 24)}.json`;
    const tok2a = "tok2a-" + freshSfx(), tok2b = "tok2b-" + freshSfx();
    const injectedUntracked = {
      entry: {
        repoPath: w2, branch: "w2-branch", reason: "the SAME synthetic fixture shape, with provenanceTracked omitted — pins that writePendingDivertFile never originates the field on its own",
        enteredAt: Date.now(), tokens: [tok2a, tok2b], resolvedKey: fakeKeyW2, armedKeys: [fakeKeyW2],
      },
      sourceFile: sourceFile2,
    };

    reenterMergeQuarantinesAtBootTestOnly([], [injectedTracked, injectedUntracked]);
    check("(precondition) w1 reads quarantined via the pending path (genuinely pending-only, no active match)", assertRepoNotQuarantined(w1).ok === false);
    check("(precondition) w2 likewise reads quarantined via the pending path", assertRepoNotQuarantined(w2).ok === false);

    // Partial clear (tok*a) on each — leaves tok*b outstanding, exercising clearTokenFromPendingIndices'
    // own remaining-tokens rewrite branch, which calls writePendingDivertFile.
    clearMergeQuarantineByToken(w1, tok1a);
    clearMergeQuarantineByToken(w2, tok2a);

    const onDisk1 = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, sourceFile1), "utf8"));
    const onDisk2 = JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, sourceFile2), "utf8"));
    check("*** writePendingDivertFile faithfully PRESERVES provenanceTracked when the entry already carries it", onDisk1.provenanceTracked === true);
    check("*** writePendingDivertFile does NOT force-stamp provenanceTracked onto an entry that lacks it (confirms it is genuinely non-stamping)", onDisk2.provenanceTracked === undefined);
    check("(sanity) both rewrites correctly dropped the cleared token and kept the outstanding one", onDisk1.tokens.join(",") === tok1b && onDisk2.tokens.join(",") === tok2b);
  } else if (scenarioName === "sibling-absorb-into-legacy-unknown-entry-stays-unknown-after-reboot") {
    // Exact fixture technique as merge-quarantine-unknown-provenance.mjs's own scenario (a): X
    // unresolvable, Y a REAL resolvable repo whose own canonicalRepoLockKey IS Ky. Two files matching
    // defect (A) exactly.
    const y = makeRealRepo("e-y");
    const ky = canonicalRepoLockKey(y);
    const x = path.join(os.tmpdir(), `loom-mqrp-e-x-never-exists-${freshSfx()}`);
    const enteredAt = Date.now() - 120_000;
    const kyFile = writePreFixLatch(hashForKey(ky), {
      repoPath: x, branch: "x-branch", reason: "X's manufactured resolvedKey collision with Y",
      enteredAt, tokens: ["x-token"], resolvedKey: ky,
    });
    const strayKey = canonicalRepoLockKey(x);
    const strayFile = writePreFixLatch(hashForKey(strayKey), {
      repoPath: x, branch: "x-branch", reason: "X's manufactured resolvedKey collision with Y",
      enteredAt, tokens: ["x-token", "y-token-preexisting"], resolvedKey: ky,
    });

    reenterMergeQuarantinesAtBoot([x, y]);
    check("(precondition) boot marks the degraded union provenanceUnknown", activeMergeQuarantineFor(x)?.provenanceUnknown === true);
    check("(precondition) Y reads quarantined before any runtime raise (blocked by X's own degraded occupation)", assertRepoNotQuarantined(y).ok === false);

    // THE NEW STEP — a GENUINE runtime sibling raise from Y, absorbing into the degraded occupant via
    // enterMergeQuarantine's own existing/sibling-absorb branch (deliberately unchanged by this card).
    // enterMergeQuarantine mints its OWN token internally and returns it — capture that, never a
    // manufactured string, per this project's own "never write an id you were not handed" rule.
    const runtimeToken = enterMergeQuarantine(y, "y-branch-runtime", "y's own genuine runtime sibling raise");
    const afterAbsorb = activeMergeQuarantineFor(y);
    check("(sanity) the runtime raise's own new token actually landed in the union", (afterAbsorb?.tokens ?? []).includes(runtimeToken));
    check("*** provenanceUnknown survives the runtime absorb (spread-inherited, never cleared) ***", afterAbsorb?.provenanceUnknown === true);

    // THE PRECEDENCE RULE, stated directly: writeMergeQuarantineLatch's own unconditional stamp
    // means the WRITTEN bytes now carry BOTH fields true at once.
    const kyBytesAfter = JSON.parse(fs.readFileSync(kyFile, "utf8"));
    check("*** PRECEDENCE RULE *** the written bytes carry provenanceUnknown:true AND provenanceTracked:true SIMULTANEOUSLY", kyBytesAfter.provenanceUnknown === true && kyBytesAfter.provenanceTracked === true);

    // Reboot — detectUnknownProvenance's own check order (provenanceUnknown checked BEFORE
    // provenanceTracked) must keep this coexistence from laundering anything.
    const reboot = await rebootSim();
    reboot.reenterMergeQuarantinesAtBoot([x, y]);
    check("*** THE PRECEDENCE RULE HOLDS *** a fresh boot STILL reads provenanceUnknown back, despite provenanceTracked ALSO being true on disk", reboot.activeMergeQuarantineFor(x)?.provenanceUnknown === true);
    const clearResult = reboot.clearMergeQuarantineLatchFile(hashForKey(ky));
    check("*** THE PRECEDENCE RULE HOLDS *** clear-by-id STILL refuses after the runtime absorb + reboot", clearResult.ok === false);
    check("(sanity) Y is still reachable/enforced post-reboot — its own runtime raise rode along, never silently dropped", reboot.assertRepoNotQuarantined(y).ok === false);

    const pathClear = reboot.clearMergeQuarantineByRecordedPath(x);
    check("(sanity) clear-by-path still lifts the whole union, Y included", pathClear.wasQuarantined === true);
    check("(sanity) Y reads clear after clear-by-path(X)", reboot.assertRepoNotQuarantined(y).ok === true);
  } else {
    throw new Error(`unknown scenario: ${scenarioName}`);
  }
} finally {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0 ? `\n✅ scenario ${scenarioName}: all checks passed` : `\n❌ scenario ${scenarioName}: ${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
