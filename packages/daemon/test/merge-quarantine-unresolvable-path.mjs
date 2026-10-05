import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 7673d096, Code Review BLOCKING finding 1 — a subdir-bound path that is MISSING at boot (real
// case: an Obsidian vault on an unmounted or cloud drive) made `reenterMergeQuarantinesAtBoot`'s PASS 1
// FAIL OPEN. `resolveGitToplevelSync`/`canonicalRepoLockKey` computed a DIFFERENT key for a repoPath that
// does not currently resolve on disk (falling back to a literal/degenerate value rather than the real
// toplevel), so a CORRECT, toplevel-keyed latch read back a "stale key" mismatch against that degenerate
// key — and PASS 1 used to migrate unconditionally: it wrote the entry under the WRONG (degenerate) key
// and DELETED the correct, original file. Once the drive remounts, every later check computes the REAL
// toplevel key again, finds NOTHING at that key (the correct file is gone, the entry only lives under the
// wrong key from that one boot), and the quarantine is silently unenforced for the rest of that boot.
//
// THE FIX: PASS 1 now gates migration on `isRepoPathCurrentlyResolvable(entry.repoPath)` — never migrates
// (never deletes the original file) when the registered path itself can't currently be verified. It also
// records `resolvedKey` (the exact key the entry was raised under) in the latch's own content, and arms the
// in-memory map under BOTH the current (possibly degraded) key and `resolvedKey` — so enforcement holds
// before, during, AND after the path becomes resolvable again within the SAME boot.
//
// This file reproduces the real scenario: the registered repo is a SUBDIRECTORY with no `.git` of its own
// (so its latch is genuinely keyed on the TOPLEVEL). The entire physical repo (subdir AND toplevel) is
// temporarily moved away — the one shape that actually produces a degenerate/unverifiable key, since
// `resolveGitToplevelSync`'s own nearest-existing-ancestor walk already tolerates the LEAF alone being
// absent (see test/repo-lock-subdir-toplevel.mjs) — boot re-entry runs while it's gone, the repo is moved
// back, and BOTH the subdir path and the toplevel path must then read as refused.
//
// RED on a4198110 (verified manually during development: reverted repo-lock.ts/merge-quarantine.ts to that
// commit, rebuilt, re-ran this file — the original file was deleted at boot and `assertRepoNotQuarantined`
// for both paths wrongly returned `{ok:true}` once the repo was moved back) — GREEN once gated on
// `isRepoPathCurrentlyResolvable`.
//
// Board card 54054c01 (reviewer 708793d4's residuals from 7673d096's approving re-review) — see
// docs/decisions/54054c01-clear-lifts-every-key-an-entry-was-armed-under.md:
//  - THE ORIGINAL SCENARIO BELOW WAS VACUOUS: it used to raise via the real `enterMergeQuarantine` directly
//    in THIS process, which already leaves `activeQuarantines` keyed correctly as a side effect of the raise
//    itself — so every "(restored) ... refused" check passed whether or not PASS 1's own re-entry logic
//    armed anything at all. Fixed by raising in a genuinely SEPARATE child process (same technique as
//    test/merge-quarantine-boot-hardening.mjs's own SCENARIO NC2) — only the DURABLE FILE, never a residual
//    in-memory entry, feeds this process's own boot re-entry.
//  - SCENARIO E — a clear issued while the repo is STILL absent used to report success but lift nothing
//    durable (only the degraded current-key map slot, never the entry's OTHER key or its real on-disk file).
//  - SCENARIO G — a PRE-upgrade latch (no `resolvedKey` field) that is key-unverifiable at the very boot
//    that introduces this code used to arm under ONLY a degraded fallback key, silently failing open the
//    moment the repo remounts later in the same process.
//
// Round 2 (same card, reviewer 708793d4's follow-up CHANGES-NEEDED on commit e1f3fca2) found TWO more MAJOR
// gaps in round 1's own fix — see the decision record's "Code Review round 2" section:
//  - R1/R2 — a PENDING entry's graduation (`activeMergeQuarantineFor`) wrote the new durable latch under its
//    now-known key but never deleted the STALE source file it was loaded from, so the stale file survived to
//    resurrect the quarantine on a LATER boot even after a human clear. R1 is scenario G's own shape (whole
//    repo absent, the coincidental degraded/legacy hash match); R2 is the SAME bug via a DIFFERENT trigger —
//    only the LEAF missing (toplevel present), which never hits that coincidence at all.
//  - R3 — `clearMergeQuarantine`/`clearMergeQuarantineByToken` used REFERENCE EQUALITY (`v === entry`) to
//    find every key an entry was armed under. That breaks the moment the entry is REBUILT elsewhere —
//    `armQuarantineKey`'s own union, or PASS 2's orphan-filename merge — since the rebuilt object stops
//    being `===` the one still sitting at the entry's OTHER armed key. Fixed by tracking `armedKeys`
//    (an explicit, threaded set) on the entry itself instead of relying on object identity.
//  - RESIDUAL — a fresh `enterMergeQuarantine` raise landing while an old PENDING latch for the same repo
//    was still unresolved used to mint an unrelated second entry, orphaning the pending one.
//    `enterMergeQuarantine` now merges into a matching pending entry instead.
//
// Round 3 (same card, reviewer 708793d4's re-review of commit b7efd2d3) found a CRITICAL regression round
// 2's own fix introduced, plus a minor gap in `armQuarantineKey` itself:
//  - TOPLEVEL-A/TOPLEVEL-B — for a repo bound AT its own git toplevel (no subdir), the OLD legacy key and
//    the CURRENT one are the IDENTICAL value — there's no walk to differ on. Round 2's "delete the pending
//    entry's stale source file" fix never checked whether that source WAS the file it just wrote, so
//    graduation (TOPLEVEL-A) and `enterMergeQuarantine`'s merge-into-pending path (TOPLEVEL-B) both deleted
//    the quarantine they'd just written. The repo stayed enforced only in THIS process's memory; a restart
//    found nothing on disk and silently lifted it, with no clear ever having happened.
//  - UNION-KEYS — `armQuarantineKey`'s own union wrote the merged object to only the ONE key it was called
//    with, so another key the union inherited from an already-dual-armed `prior` kept pointing at the stale
//    pre-union object.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-quarantine-unresolvable-path.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mqup-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleUrl = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const {
  clearMergeQuarantine, activeMergeQuarantineFor, assertRepoNotQuarantined, reenterMergeQuarantinesAtBoot,
  listActiveMergeQuarantines, MERGE_QUARANTINE_DIR,
} = await import(mergeQuarantineModuleUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mqup@loom -c user.name=mqup";
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

function makeRepoWithSubdir(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqup-repo-${tag}-${sfx}`);
  const subdir = path.join(repo, "teamA"); // no .git of its own — a subdir-bound project specimen
  fs.mkdirSync(subdir, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(subdir, "a.txt"), "team a\n");
  execSync(`git init -q && git config user.email mqup@loom && git config user.name mqup`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return { repo, subdir };
}

// A repo bound AT its own git toplevel (no subdir offset) — the shape where the OLD (legacy, direct-path)
// key algorithm and the CURRENT (toplevel-walking) one compute the IDENTICAL value, present OR absent
// (there is no walk to differ on). This is what makes a graduation/merge write able to coincide with a
// pending entry's own stale source filename (card 54054c01, Code Review round 3, CRITICAL).
function makeToplevelRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mqup-top-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "toplevel\n");
  execSync(`git init -q && git config user.email mqup@loom && git config user.name mqup`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

// Raise via a GENUINELY SEPARATE node process — writes the real, toplevel-keyed durable latch (with
// `resolvedKey` set, exactly as the real `enterMergeQuarantine` produces it) without leaving ANY residue in
// THIS process's own `activeQuarantines` map, which is the whole point (see the vacuity note above).
function raiseInChildProcess(repoPath, branch, reason) {
  const childScript = `
    const { enterMergeQuarantine } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    enterMergeQuarantine(${JSON.stringify(repoPath)}, ${JSON.stringify(branch)}, ${JSON.stringify(reason)});
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], {
    env: { ...process.env, LOOM_HOME: loomHome },
  });
}

// A GENUINELY SEPARATE reboot — the strongest form of "stays clear": reads ONLY the durable files on disk
// (a fresh module instance, a fresh empty activeQuarantines map), never any in-process residual state this
// test's own prior calls might have left behind. Returns {foundRepos, refusals: {repoPath: ok}, activeCount}.
function rebootInChildProcess(repoPaths) {
  const childScript = `
    const { reenterMergeQuarantinesAtBoot, assertRepoNotQuarantined, listActiveMergeQuarantines } = await import(${JSON.stringify(mergeQuarantineModuleUrl)});
    const repoPaths = ${JSON.stringify(repoPaths)};
    const found = reenterMergeQuarantinesAtBoot(repoPaths);
    const refusals = Object.fromEntries(repoPaths.map((p) => [p, assertRepoNotQuarantined(p).ok]));
    const activeForThese = listActiveMergeQuarantines().filter((q) => repoPaths.includes(q.repoPath)).length;
    process.stdout.write(JSON.stringify({ foundRepos: found.map((q) => q.repoPath), refusals, activeForThese }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", childScript], {
    env: { ...process.env, LOOM_HOME: loomHome },
  }).toString();
  return JSON.parse(out);
}

function findLatchPathFor(repoPath) {
  return fs.readdirSync(MERGE_QUARANTINE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(MERGE_QUARANTINE_DIR, f))
    .find((p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")).repoPath === repoPath; } catch { return false; } });
}

function countLatchFilesFor(repoPath) {
  return fs.readdirSync(MERGE_QUARANTINE_DIR)
    .filter((f) => f.endsWith(".json"))
    .filter((f) => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === repoPath; } catch { return false; } })
    .length;
}

// Reproduces the OLD (pre-7673d096) key algorithm by hand, exactly as test/merge-quarantine-key-migration.mjs
// does — a latch filed this way has NO `resolvedKey` field at all (that field didn't exist pre-upgrade).
function oldKeyFor(boundPath) {
  const real = fs.realpathSync.native(boundPath);
  return process.platform === "win32" ? real.toLowerCase() : real;
}
function oldHashFor(boundPath) {
  return createHash("sha256").update(oldKeyFor(boundPath)).digest("hex").slice(0, 24);
}

// Mirrors `quarantineHashForKey` (merge-quarantine.ts) — hashes a raw KEY directly, the SAME primitive the
// real code uses to name a latch file. Used to manufacture a fixture under its own PROPER filename, so a
// real `deleteMergeQuarantineLatchByKey(key)` call can actually find and remove it (an arbitrary filename,
// unlike this, is invisible to that lookup — a fixture artifact, never something the real code produces).
function newHashForKey(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // ORIGINAL SCENARIO — a correct, toplevel-keyed latch survives a boot while the WHOLE repo is absent,
  // and enforcement holds before, during, and after a remount within the same boot.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const parkedRoot = path.join(os.tmpdir(), `loom-mqup-parked-${sfx}`);
    const { repo, subdir } = makeRepoWithSubdir("orig");

    // Raise a REAL quarantine via the real entry point, in a CHILD process — this is the "correct,
    // toplevel-keyed latch" the bug destroys. At this moment the repo is fully present, so this writes
    // under the TRUE toplevel key. Nothing in THIS process's own activeQuarantines is touched by this call.
    raiseInChildProcess(subdir, "real-branch", "a genuine unconfirmed-kill raise, filed while the repo is fully present");
    check("(precondition) this process's own in-memory map has NOT seen this repo yet (vacuity fix)", !activeMergeQuarantineFor(subdir));

    const latchPath = findLatchPathFor(subdir);
    check("(precondition) exactly one real latch file exists for the subdir", !!latchPath);
    const originalContent = fs.readFileSync(latchPath, "utf8");
    check("(precondition) the real latch carries a resolvedKey (the toplevel key it was raised under)", !!JSON.parse(originalContent).resolvedKey);

    // Move the ENTIRE physical repo away — simulating an unmounted/disconnected drive. This is the one shape
    // that genuinely produces a degenerate key: the nearest-existing-ancestor walk tolerates the SUBDIR alone
    // being missing (the toplevel's own .git would still be found), but here the toplevel is gone too.
    fs.renameSync(repo, parkedRoot);
    check("(moved away) the subdir no longer resolves on disk", !fs.existsSync(subdir));

    // THE ONLY boot re-entry call in this scenario, against a genuinely EMPTY in-memory map (the raise
    // above ran in a child process) — this is what fixes the original vacuity.
    const found = reenterMergeQuarantinesAtBoot([subdir]);
    check("(moved away) boot re-entry still reports this repo's quarantine", found.some((q) => q.repoPath === subdir));
    check("(moved away) THE BLOCKING BUG: the original latch file is NOT deleted (no destructive migration on an unverifiable key)", fs.existsSync(latchPath));
    check("(moved away) the preserved file's content is UNCHANGED (not rewritten under a degraded key)", fs.readFileSync(latchPath, "utf8") === originalContent);
    check("(moved away) enforcement still holds for the subdir path even while the repo is gone", !assertRepoNotQuarantined(subdir).ok);

    // Restore the repo to its original location — simulating the drive remounting, LATER in the SAME boot.
    fs.renameSync(parkedRoot, repo);
    check("(restored) the subdir resolves on disk again", fs.existsSync(subdir));

    const subdirCheck = assertRepoNotQuarantined(subdir);
    const rootCheck = assertRepoNotQuarantined(repo);
    check("(restored) THE BLOCKING BUG: the SUBDIR path is still refused once the repo is back (not silently unenforced)", !subdirCheck.ok);
    check("(restored) THE BLOCKING BUG: the TOPLEVEL/root path is ALSO refused (same physical repo, same quarantine)", !rootCheck.ok);
    check("(restored) the refusal still names the real reason (not a fabricated boot placeholder)", /genuine unconfirmed-kill raise/i.test(subdirCheck.reason ?? ""));

    clearMergeQuarantine(subdir);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO E (card 54054c01, finding 1) — a human clear issued while the repo is STILL absent must
  // durably lift BOTH the degraded current-key slot AND the entry's real resolvedKey slot/file, or the
  // "cleared" quarantine resurrects on the very next boot.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const parkedRootE = path.join(os.tmpdir(), `loom-mqup-parkedE-${sfx}`);
    const { repo: repoE, subdir: subdirE } = makeRepoWithSubdir("e");

    raiseInChildProcess(subdirE, "e-branch", "scenario E — clear while absent");
    const realLatchPathE = findLatchPathFor(subdirE);
    check("(E precondition) the real toplevel-keyed latch file exists", !!realLatchPathE);

    fs.renameSync(repoE, parkedRootE);
    check("(E precondition) the subdir no longer resolves on disk", !fs.existsSync(subdirE));

    reenterMergeQuarantinesAtBoot([subdirE]);
    check("(E) enforcement holds while absent, pre-clear", !assertRepoNotQuarantined(subdirE).ok);

    // THE HUMAN CLEAR, issued WHILE STILL ABSENT — this is Repro E.
    clearMergeQuarantine(subdirE);
    check("(E) in-memory no longer shows this repo as quarantined immediately after the clear", !activeMergeQuarantineFor(subdirE));
    check("(E) THE BUG: the REAL (resolvedKey-hashed) latch file is actually deleted, not just the degraded-key slot", !fs.existsSync(realLatchPathE));

    // Remount — the clear's own claimed success must actually hold once the repo is reachable again.
    fs.renameSync(parkedRootE, repoE);
    check("(E) the subdir resolves on disk again", fs.existsSync(subdirE));
    check("(E) THE BUG: once remounted, the subdir reads as NOT quarantined (the clear was durable, not misleading)", assertRepoNotQuarantined(subdirE).ok);
    check("(E) the toplevel/root path is ALSO not quarantined", assertRepoNotQuarantined(repoE).ok);

    // THE REGRESSION THIS PREVENTS — a FURTHER boot (simulating a full restart after the clear) must not
    // resurrect the quarantine from a stale never-deleted file.
    const foundAfterClear = reenterMergeQuarantinesAtBoot([subdirE]);
    check("(E) a fresh boot after the clear does NOT re-quarantine this repo", !foundAfterClear.some((q) => q.repoPath === subdirE));
    check("(E) in-memory stays clear after the post-clear boot", !activeMergeQuarantineFor(subdirE));

    // THE STRONGEST FORM — a GENUINELY SEPARATE process (no possible in-process residual state at all)
    // reading only the durable files on disk must also find nothing.
    const rebootE = rebootInChildProcess([subdirE]);
    check("(E) a CHILD-PROCESS reboot after the clear finds nothing for this repo", rebootE.foundRepos.length === 0);
    check("(E) a CHILD-PROCESS reboot after the clear reads this repo as NOT quarantined", rebootE.refusals[subdirE] === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // SCENARIO G (card 54054c01, finding 2) — a PRE-upgrade latch (no `resolvedKey` field at all) that is
  // key-unverifiable at the very boot that introduces this code must NOT silently fail open the moment the
  // repo remounts later in the SAME process.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const parkedRootG = path.join(os.tmpdir(), `loom-mqup-parkedG-${sfx}`);
    const { repo: repoG, subdir: subdirG } = makeRepoWithSubdir("g");

    // Manufacture a PRE-upgrade-shaped latch by hand, filed under the LEGACY (pre-toplevel-walk) hash, with
    // NO resolvedKey field — exactly the shape a latch written before card 7673d096 shipped would have.
    const legacyHash = oldHashFor(subdirG);
    const legacyLatchPathG = path.join(MERGE_QUARANTINE_DIR, `${legacyHash}.json`);
    const manufacturedEntryG = {
      repoPath: subdirG, branch: "pre-upgrade-g-branch", reason: "scenario G — pre-upgrade latch, no resolvedKey, absent at the upgrade boot",
      enteredAt: Date.now(), tokens: ["pre-upgrade-g-token"],
    };
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(legacyLatchPathG, JSON.stringify(manufacturedEntryG, null, 2) + "\n");
    check("(G precondition) the manufactured pre-upgrade (no-resolvedKey) latch exists under the legacy hash", fs.existsSync(legacyLatchPathG));
    check("(G precondition) in-memory does not show this repo yet", !activeMergeQuarantineFor(subdirG));

    // Move the WHOLE repo away — "the upgrade boot" happens while it's absent.
    fs.renameSync(repoG, parkedRootG);
    check("(G precondition) the subdir no longer resolves on disk", !fs.existsSync(subdirG));

    const foundG = reenterMergeQuarantinesAtBoot([subdirG]);
    check("(G) boot re-entry still reports this repo (via the pending list, not a guessed key)", foundG.some((q) => q.repoPath === subdirG));
    check("(G) the original legacy-hash latch file is NOT touched (no destructive migration on an unverifiable, no-resolvedKey key)", fs.existsSync(legacyLatchPathG));
    check("(G) the preserved file's content is unchanged", fs.readFileSync(legacyLatchPathG, "utf8") === JSON.stringify(manufacturedEntryG, null, 2) + "\n");

    // Enforcement must hold WHILE STILL ABSENT — this is the lazy re-resolve's first real query. A naive
    // "graduate on first match" design would pin this to the degraded fallback key here and fail open on
    // the very next check below once the repo remounts; the fix must NOT do that.
    const whileAbsent1 = assertRepoNotQuarantined(subdirG);
    check("(G) enforcement holds for the subdir while still absent (first query)", !whileAbsent1.ok);
    const whileAbsent2 = assertRepoNotQuarantined(subdirG);
    check("(G) enforcement STILL holds on a second query while still absent (not a one-shot fluke)", !whileAbsent2.ok);

    // Restore the repo — simulating a remount LATER in the SAME process, after already having been queried
    // at least once while absent above.
    fs.renameSync(parkedRootG, repoG);
    check("(G) the subdir resolves on disk again", fs.existsSync(subdirG));

    const subdirCheckG = assertRepoNotQuarantined(subdirG);
    const rootCheckG = assertRepoNotQuarantined(repoG);
    check("(G) THE BLOCKING BUG: the subdir is STILL refused once remounted (not silently fail-open)", !subdirCheckG.ok);
    check("(G) THE BLOCKING BUG: the toplevel/root path is ALSO refused (same physical repo)", !rootCheckG.ok);
    check("(G) the refusal still names the real (manufactured) reason", /scenario G/i.test(subdirCheckG.reason ?? ""));

    // A further query after the remount must keep working too (genuinely graduated, not pending anymore).
    check("(G) a further query after the remount is STILL refused", !assertRepoNotQuarantined(subdirG).ok);

    // ROUND 2, FINDING 1 (R1) — graduation must delete the STALE legacy source file, not just write the
    // new one under the now-known key. Pre-fix: the legacy file survived here, and a LATER boot would
    // re-read it (mismatch against the now-current key again) and re-quarantine the repo all over again,
    // even after a human clear below believed it had lifted everything.
    check("(G) R1: graduation deleted the STALE legacy-hash source file (not left behind to resurrect later)", !fs.existsSync(legacyLatchPathG));

    clearMergeQuarantine(subdirG);
    check("(G) clearMergeQuarantine lifts the now-graduated entry cleanly", assertRepoNotQuarantined(subdirG).ok);

    // THE STRONGEST FORM — a CHILD-PROCESS reboot after the clear (reading only durable files) must not
    // resurrect anything, closing the exact R1 regression (a stale legacy file no clear ever touched).
    const rebootG = rebootInChildProcess([subdirG]);
    check("(G) R1: a CHILD-PROCESS reboot after the clear finds nothing for this repo", rebootG.foundRepos.length === 0);
    check("(G) R1: a CHILD-PROCESS reboot after the clear reads this repo as NOT quarantined", rebootG.refusals[subdirG] === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // R2 (card 54054c01, Code Review round 2, finding 1) — THE SAME graduation-leaves-a-stale-source-file
  // bug as scenario G, reached through a DIFFERENT door: only the LEAF (subdir) is missing, the TOPLEVEL
  // (repo/.git) stays present throughout. This never hits the "degraded fallback coincidentally equals the
  // legacy hash" shape G exercises — `canonicalRepoLockKey` finds the real toplevel key immediately, via
  // the existing-ancestor-tolerant walk — so it proves the fix isn't accidentally scoped to that coincidence.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { repo: repoR2, subdir: subdirR2 } = makeRepoWithSubdir("r2");
    const parkedLeafR2 = path.join(os.tmpdir(), `loom-mqup-parkedleafR2-${sfx}`);

    const legacyHashR2 = oldHashFor(subdirR2);
    const legacyLatchPathR2 = path.join(MERGE_QUARANTINE_DIR, `${legacyHashR2}.json`);
    const manufacturedEntryR2 = {
      repoPath: subdirR2, branch: "pre-upgrade-r2-branch", reason: "R2 — pre-upgrade latch, leaf missing but toplevel present",
      enteredAt: Date.now(), tokens: ["pre-upgrade-r2-token"],
    };
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(legacyLatchPathR2, JSON.stringify(manufacturedEntryR2, null, 2) + "\n");

    // Move ONLY the leaf away — the toplevel repo (with its real .git) stays exactly where it is.
    fs.renameSync(subdirR2, parkedLeafR2);
    check("(R2 precondition) only the leaf is gone — the toplevel repo still resolves", !fs.existsSync(subdirR2) && fs.existsSync(path.join(repoR2, ".git")));

    const foundR2 = reenterMergeQuarantinesAtBoot([subdirR2]);
    check("(R2) boot re-entry still reports this repo (via the pending list)", foundR2.some((q) => q.repoPath === subdirR2));
    check("(R2) the legacy-hash file is untouched at this point (not yet graduated — the leaf is still missing)", fs.existsSync(legacyLatchPathR2));
    check("(R2) enforcement holds while the leaf is still missing (not yet graduated, but still refused)", !assertRepoNotQuarantined(subdirR2).ok);

    // Restore the leaf — the toplevel never moved, so THIS is the only change needed to make the repo
    // resolvable again (unlike scenario G, where the WHOLE repo had to come back).
    fs.renameSync(parkedLeafR2, subdirR2);
    check("(R2) the leaf resolves again", fs.existsSync(subdirR2));
    check("(R2) THE BUG: still refused once the leaf is back", !assertRepoNotQuarantined(subdirR2).ok);
    check("(R2) R1-SHAPE-VIA-A-DIFFERENT-DOOR: graduation deleted the stale legacy file here too", !fs.existsSync(legacyLatchPathR2));

    clearMergeQuarantine(subdirR2);
    const rebootR2 = rebootInChildProcess([subdirR2]);
    check("(R2) a CHILD-PROCESS reboot after the clear finds nothing for this repo", rebootR2.foundRepos.length === 0);
    check("(R2) a CHILD-PROCESS reboot after the clear reads this repo as NOT quarantined", rebootR2.refusals[subdirR2] === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // R3 (card 54054c01, Code Review round 2, finding 2) — `clearMergeQuarantine` used REFERENCE EQUALITY to
  // find every key an entry was armed under. An unmatched corrupt ORPHAN latch (PASS 2) REBUILDS a
  // dual-armed entry via `{ ...existing, orphanLatchFiles: ... }` — a NEW object. Pre-fix, only the key PASS
  // 2 happened to iterate with got updated to that new object; the entry's OTHER armed key (its resolvedKey)
  // kept pointing at the STALE pre-merge object. A clear keyed off reference equality then found and lifted
  // only ONE of the two slots, so the repo read as REFUSED again the moment a query used the other key.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { repo: repoR3, subdir: subdirR3 } = makeRepoWithSubdir("r3");
    const parkedRootR3 = path.join(os.tmpdir(), `loom-mqup-parkedR3-${sfx}`);

    // A REAL, post-upgrade raise (resolvedKey set) — via a child process, same vacuity-avoidance as every
    // other scenario here.
    raiseInChildProcess(subdirR3, "r3-branch", "R3 — real raise plus an unmatched corrupt orphan latch");
    const realLatchPathR3 = findLatchPathFor(subdirR3);
    check("(R3 precondition) the real toplevel-keyed latch file exists", !!realLatchPathR3);

    // An UNMATCHED corrupt orphan latch, alongside it — matches no registered repo's hash at all.
    const orphanPathR3 = path.join(MERGE_QUARANTINE_DIR, `orphan-r3-${sfx}.json`);
    fs.writeFileSync(orphanPathR3, "{not valid json");
    check("(R3 precondition) the unmatched corrupt orphan latch exists", fs.existsSync(orphanPathR3));

    fs.renameSync(repoR3, parkedRootR3);
    check("(R3 precondition) the whole repo is absent", !fs.existsSync(subdirR3));

    // PASS 1 dual-arms the real entry (degraded key + resolvedKey); PASS 2 then merges the orphan filename
    // into whichever key it looks up by — REBUILDING the entry. Pre-fix, only that ONE key's slot got the
    // rebuilt object; the OTHER slot kept the stale pre-merge one.
    reenterMergeQuarantinesAtBoot([subdirR3]);
    check("(R3) enforcement holds while absent, pre-clear", !assertRepoNotQuarantined(subdirR3).ok);

    clearMergeQuarantine(subdirR3);
    check("(R3) in-memory shows this repo as cleared via the (possibly single, pre-fix) key clear touched", !activeMergeQuarantineFor(subdirR3));

    // Remount — THE ACTUAL R3 BUG: pre-fix, a query through the OTHER (toplevel/resolvedKey) key still hit
    // the stale, never-cleared object and read as refused again, even though the clear reported success.
    fs.renameSync(parkedRootR3, repoR3);
    check("(R3) THE BUG: once remounted, the subdir reads as NOT quarantined (every armed key was actually lifted)", assertRepoNotQuarantined(subdirR3).ok);
    check("(R3) THE BUG: the toplevel/root path ALSO reads as NOT quarantined", assertRepoNotQuarantined(repoR3).ok);
    check("(R3) listActiveMergeQuarantines no longer carries an entry for this repo (not a leftover stale half)", !listActiveMergeQuarantines().some((q) => q.repoPath === subdirR3));

    const rebootR3 = rebootInChildProcess([subdirR3]);
    check("(R3) a CHILD-PROCESS reboot after the clear finds nothing for this repo", rebootR3.foundRepos.length === 0);
    check("(R3) a CHILD-PROCESS reboot after the clear reads this repo as NOT quarantined", rebootR3.refusals[subdirR3] === true);

    try { fs.unlinkSync(orphanPathR3); } catch { /* best-effort — the clear's own orphan sweep should already have removed it */ }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // RESIDUAL (card 54054c01, Code Review round 2) — a fresh `enterMergeQuarantine` raise landing while an
  // OLD pending (key-unverifiable) latch for the SAME repo is still unresolved must MERGE into it, never
  // mint an unrelated second entry that leaves the pending one's own identity/tokens orphaned.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const { repo: repoResid, subdir: subdirResid } = makeRepoWithSubdir("resid");
    const parkedRootResid = path.join(os.tmpdir(), `loom-mqup-parkedResid-${sfx}`);

    const legacyHashResid = oldHashFor(subdirResid);
    const legacyLatchPathResid = path.join(MERGE_QUARANTINE_DIR, `${legacyHashResid}.json`);
    const olderEnteredAt = Date.now() - 60_000;
    const manufacturedEntryResid = {
      repoPath: subdirResid, branch: "older-pending-branch", reason: "the OLDER, still-pending raise",
      enteredAt: olderEnteredAt, tokens: ["older-pending-token"],
    };
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(legacyLatchPathResid, JSON.stringify(manufacturedEntryResid, null, 2) + "\n");

    fs.renameSync(repoResid, parkedRootResid);
    const foundResid = reenterMergeQuarantinesAtBoot([subdirResid]);
    check("(RESIDUAL precondition) boot re-entry reports the legacy latch (via the pending list)", foundResid.some((q) => q.repoPath === subdirResid));

    // A FRESH raise lands on the SAME (still-absent) repo, via the real in-process entry point — note this
    // test never calls `activeMergeQuarantineFor`/`assertRepoNotQuarantined` before the raise below, since
    // either would itself be a QUERY that could graduate the pending entry (it won't here, since the repo
    // is still absent — see the lazy-resolve's own resolvability gate — but the raise path is what's under
    // test, not the query path scenario G/R2 already cover).
    const { enterMergeQuarantine } = await import(mergeQuarantineModuleUrl);
    const freshToken = enterMergeQuarantine(subdirResid, "newer-fresh-branch", "a fresh, unrelated raise landing on a still-pending repo");

    const merged = activeMergeQuarantineFor(subdirResid);
    check("(RESIDUAL) THE BUG: the fresh raise MERGED into the pending entry (one entry, not two)", !!merged);
    check("(RESIDUAL) the merged entry keeps the OLDER (pending) identity — branch/reason — per the longest-outstanding rule", merged?.branch === "older-pending-branch");
    check("(RESIDUAL) the merged entry's tokens include BOTH the old pending token and the fresh one", !!merged?.tokens?.includes("older-pending-token") && !!merged?.tokens?.includes(freshToken));
    // A subdir-bound repo with the WHOLE physical repo absent hits the SAME "degraded fallback coincides
    // with the legacy hash" shape finding 2 already established — so the merge's own fresh write lands at
    // the EXACT SAME filename as the legacy source (deleteSourceLatchIfSuperseded correctly skips deleting
    // it, since doing so would delete the content it just wrote). The file must therefore still exist, now
    // holding the MERGED content — never vanish, and never be left holding the stale pre-merge content.
    const residFileExists = fs.existsSync(legacyLatchPathResid);
    check("(RESIDUAL) the (coincidentally-same-named) latch file still exists after the merge", residFileExists);
    check("(RESIDUAL) its content now reflects the MERGED tokens, not the stale pre-merge pending content", residFileExists && JSON.parse(fs.readFileSync(legacyLatchPathResid, "utf8")).tokens?.includes(freshToken));
    check("(RESIDUAL) exactly one latch file exists for this repo (no orphaned duplicate)", fs.readdirSync(MERGE_QUARANTINE_DIR).filter((f) => { try { return JSON.parse(fs.readFileSync(path.join(MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === subdirResid; } catch { return false; } }).length === 1);

    clearMergeQuarantine(subdirResid);
    fs.renameSync(parkedRootResid, repoResid);
    const rebootResid = rebootInChildProcess([subdirResid]);
    check("(RESIDUAL) a CHILD-PROCESS reboot after the clear finds nothing for this repo", rebootResid.foundRepos.length === 0);
    check("(RESIDUAL) a CHILD-PROCESS reboot after the clear reads this repo as NOT quarantined", rebootResid.refusals[subdirResid] === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // TOPLEVEL-A (card 54054c01, Code Review round 3, CRITICAL, Path A) — a repo bound AT its own git
  // toplevel (no subdir) has NO distinguishing walk between the OLD legacy key and the CURRENT one, so a
  // graduation's fresh write can land under the EXACT SAME filename as the pending entry's own stale
  // source. Deleting that "stale" file unconditionally deletes the quarantine just written: it survives
  // only in THIS process's memory, and a restart (no clear ever having happened) finds nothing on disk.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repoTA = makeToplevelRepo("tlA");
    const parkedRootTA = path.join(os.tmpdir(), `loom-mqup-parkedTA-${sfx}`);

    const legacyHashTA = oldHashFor(repoTA);
    const legacyLatchPathTA = path.join(MERGE_QUARANTINE_DIR, `${legacyHashTA}.json`);
    const manufacturedEntryTA = {
      repoPath: repoTA, branch: "toplevel-a-branch", reason: "TOPLEVEL-A — graduation must not self-delete",
      enteredAt: Date.now(), tokens: ["toplevel-a-token"],
    };
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(legacyLatchPathTA, JSON.stringify(manufacturedEntryTA, null, 2) + "\n");

    fs.renameSync(repoTA, parkedRootTA);
    reenterMergeQuarantinesAtBoot([repoTA]);
    check("(TOPLEVEL-A precondition) exactly one latch file for this repo before graduation", countLatchFilesFor(repoTA) === 1);

    fs.renameSync(parkedRootTA, repoTA);
    check("(TOPLEVEL-A) the repo resolves again", fs.existsSync(repoTA));

    // THE QUERY THAT GRADUATES — for a toplevel-bound repo, the written filename and the pending entry's
    // own `legacyLatchPathTA` are THE SAME NAME (the whole point of this scenario).
    const taCheck = assertRepoNotQuarantined(repoTA);
    check("(TOPLEVEL-A) enforcement holds in-memory right after graduation", !taCheck.ok);
    check("(TOPLEVEL-A) THE CRITICAL BUG: exactly ONE latch file for this repo survives on disk (not zero — graduation must not delete the file it just wrote)", countLatchFilesFor(repoTA) === 1);
    check("(TOPLEVEL-A) that surviving file is readable and still names this repo", fs.existsSync(legacyLatchPathTA) && JSON.parse(fs.readFileSync(legacyLatchPathTA, "utf8")).repoPath === repoTA);

    // THE REAL-WORLD CONSEQUENCE — a GENUINELY SEPARATE process, reading ONLY the disk, must ALSO see this
    // repo as quarantined. Pre-fix, the self-deleted file left nothing for a reboot to find: fail-open
    // across a restart, with no clear ever having happened.
    const rebootTA = rebootInChildProcess([repoTA]);
    check("(TOPLEVEL-A) THE CRITICAL BUG: a CHILD-PROCESS reboot (no clear issued) still reports this repo quarantined", rebootTA.refusals[repoTA] === false);
    check("(TOPLEVEL-A) the child-process reboot's own re-entry reports this repo too", rebootTA.foundRepos.includes(repoTA));

    clearMergeQuarantine(repoTA);
    const rebootTACleared = rebootInChildProcess([repoTA]);
    check("(TOPLEVEL-A) after an explicit clear, a child-process reboot finds nothing for this repo", rebootTACleared.foundRepos.length === 0);
    check("(TOPLEVEL-A) after an explicit clear, a child-process reboot reads this repo as NOT quarantined", rebootTACleared.refusals[repoTA] === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // TOPLEVEL-B (card 54054c01, Code Review round 3, CRITICAL, Path B) — THE SAME self-deleting-latch bug,
  // reached via `enterMergeQuarantine`'s merge-into-pending path instead of a lazy-query graduation.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repoTB = makeToplevelRepo("tlB");
    const parkedRootTB = path.join(os.tmpdir(), `loom-mqup-parkedTB-${sfx}`);

    const legacyHashTB = oldHashFor(repoTB);
    const legacyLatchPathTB = path.join(MERGE_QUARANTINE_DIR, `${legacyHashTB}.json`);
    const manufacturedEntryTB = {
      repoPath: repoTB, branch: "toplevel-b-branch", reason: "TOPLEVEL-B — merge-into-pending must not self-delete",
      enteredAt: Date.now(), tokens: ["toplevel-b-token"],
    };
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(legacyLatchPathTB, JSON.stringify(manufacturedEntryTB, null, 2) + "\n");

    fs.renameSync(repoTB, parkedRootTB);
    reenterMergeQuarantinesAtBoot([repoTB]);
    check("(TOPLEVEL-B precondition) exactly one latch file for this repo before the merge", countLatchFilesFor(repoTB) === 1);

    // A FRESH raise, WHILE STILL ABSENT — merges into the pending entry (same key, same coincidence).
    const { enterMergeQuarantine } = await import(mergeQuarantineModuleUrl);
    const freshTokenTB = enterMergeQuarantine(repoTB, "toplevel-b-fresh-branch", "a fresh raise merging into a toplevel-bound pending latch");

    check("(TOPLEVEL-B) THE CRITICAL BUG: exactly ONE latch file for this repo survives the merge (not zero)", countLatchFilesFor(repoTB) === 1);
    const mergedTB = activeMergeQuarantineFor(repoTB);
    check("(TOPLEVEL-B) the merged entry carries both tokens", !!mergedTB?.tokens?.includes("toplevel-b-token") && !!mergedTB?.tokens?.includes(freshTokenTB));

    fs.renameSync(parkedRootTB, repoTB);
    const rebootTB = rebootInChildProcess([repoTB]);
    check("(TOPLEVEL-B) THE CRITICAL BUG: a CHILD-PROCESS reboot (no clear issued) still reports this repo quarantined", rebootTB.refusals[repoTB] === false);
    check("(TOPLEVEL-B) the child-process reboot's own re-entry reports this repo too", rebootTB.foundRepos.includes(repoTB));

    clearMergeQuarantine(repoTB);
    const rebootTBCleared = rebootInChildProcess([repoTB]);
    check("(TOPLEVEL-B) after an explicit clear, a child-process reboot finds nothing for this repo", rebootTBCleared.foundRepos.length === 0);
    check("(TOPLEVEL-B) after an explicit clear, a child-process reboot reads this repo as NOT quarantined", rebootTBCleared.refusals[repoTB] === true);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // UNION-KEYS (card 54054c01, Code Review round 3, minor) — `armQuarantineKey`'s union used to write the
  // merged object to only the ONE key it was called with. When the entry it unions with (`prior`) is
  // ALREADY armed under a SECOND key of its own, that other key kept pointing at the STALE pre-union
  // object — a query through it would miss the OTHER entry's tokens, and a clear through it would lift an
  // incomplete picture. Two manufactured latches, each carrying a DIFFERENT `resolvedKey`, deliberately
  // collide at one of them.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const dir1 = makeToplevelRepo("uk1");
    const dir2 = makeToplevelRepo("uk2");
    const parked1 = path.join(os.tmpdir(), `loom-mqup-parkedUK1-${sfx}`);
    const parked2 = path.join(os.tmpdir(), `loom-mqup-parkedUK2-${sfx}`);

    // Compute each repo's OWN key WHILE IT STILL EXISTS (toplevel-bound, so this value is identical to
    // what `canonicalRepoLockKey` would also compute once it's moved away — see makeToplevelRepo's own
    // doc comment) — then move BOTH away: resolvableNow:false preserves a manufactured resolvedKey
    // as-written (PASS 1's migrate branch would otherwise overwrite it the moment the path resolves).
    const keyA = oldKeyFor(dir1);
    const keyB = oldKeyFor(dir2);
    fs.renameSync(dir1, parked1);
    fs.renameSync(dir2, parked2);

    // THE BUG ONLY REPRODUCES WHEN THE DUAL-ARMED ENTRY IS PROCESSED FIRST: `fs.readdirSync`'s own order
    // for two hash-named files is NOT something this test controls (the hashes themselves are effectively
    // random), so determine the ACTUAL read order empirically (via cheap placeholder files) and assign the
    // dual-arm role to whichever one PASS 1 will read first — rather than hardcoding dir1/dir2 and hoping.
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    const pathA = path.join(MERGE_QUARANTINE_DIR, `${newHashForKey(keyA)}.json`);
    const pathB = path.join(MERGE_QUARANTINE_DIR, `${newHashForKey(keyB)}.json`);
    fs.writeFileSync(pathA, "{}");
    fs.writeFileSync(pathB, "{}");
    const readOrder = fs.readdirSync(MERGE_QUARANTINE_DIR);
    const aIsFirst = readOrder.indexOf(path.basename(pathA)) < readOrder.indexOf(path.basename(pathB));
    const [dualDir, dualKey, dualPath, singleDir, singleKey, singlePath] = aIsFirst
      ? [dir1, keyA, pathA, dir2, keyB, pathB]
      : [dir2, keyB, pathB, dir1, keyA, pathA];

    // The DUAL-ARMED latch (processed first): its OWN current key plus a resolvedKey pointing at the
    // SINGLE-armed one's key — exactly the shape that collides with it below. Filed under its OWN proper
    // hash-based name (not an arbitrary one) so a real clear's by-key delete can actually find it.
    fs.writeFileSync(dualPath, JSON.stringify({
      repoPath: dualDir, branch: "older-uk-branch", reason: "UNION-KEYS — older, dual-armed at its own key and the single-armed one's",
      resolvedKey: singleKey, enteredAt: Date.now() - 60_000, tokens: ["token-uk-dual"],
    }, null, 2) + "\n");
    // The SINGLE-armed latch (processed second): its own resolvedKey equals its own current key — no
    // second arm of its own, so nothing re-touches the dual-armed one's OTHER key during ITS processing.
    fs.writeFileSync(singlePath, JSON.stringify({
      repoPath: singleDir, branch: "newer-uk-branch", reason: "UNION-KEYS — newer, single-armed at its own key only",
      resolvedKey: singleKey, enteredAt: Date.now(), tokens: ["token-uk-single"],
    }, null, 2) + "\n");

    reenterMergeQuarantinesAtBoot([dir1, dir2]);

    // THE BUG: querying via the DUAL-armed repo's own key used to see only its OWN token, missing the
    // single-armed one's — the union at the shared key never propagated back to the dual-armed repo's own
    // (first-processed) slot.
    const viaDual = activeMergeQuarantineFor(dualDir);
    const viaSingle = activeMergeQuarantineFor(singleDir);
    check("(UNION-KEYS) querying via the dual-armed repo sees BOTH tokens (not just its own)", !!viaDual?.tokens?.includes("token-uk-dual") && !!viaDual?.tokens?.includes("token-uk-single"));
    check("(UNION-KEYS) querying via the single-armed repo sees BOTH tokens too", !!viaSingle?.tokens?.includes("token-uk-dual") && !!viaSingle?.tokens?.includes("token-uk-single"));
    check("(UNION-KEYS) both queries resolve to the SAME union object (not two different stale copies)", viaDual === viaSingle);

    // A clear (via EITHER repoPath) must lift every armed key — including the one the union inherited.
    clearMergeQuarantine(dualDir);
    fs.renameSync(parked1, dir1);
    fs.renameSync(parked2, dir2);
    check("(UNION-KEYS) a clear via the dual-armed repo ALSO lifts the single-armed one (same underlying union, every armed key cleared)", assertRepoNotQuarantined(dir1).ok && assertRepoNotQuarantined(dir2).ok);
    check("(UNION-KEYS) no latch file survives for either repoPath", countLatchFilesFor(dir1) === 0 && countLatchFilesFor(dir2) === 0);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // R7-SUB-THEN-QUERY-ROOT (card abccee85, round 7) — identity-only pending matching (round 6's own
  // governing rule) itself fails OPEN here: a pending latch raised on a NESTED path (`sub`, no `.git` of
  // its own) that later becomes resolvable must ALSO block a query for the ROOT — even though the root is
  // never queried via sub's own exact stored path, and even though neither path was EVER queried while sub
  // was still absent. RED on 2ad0c7ac (identity-only matching never bridges root<->sub; a root query while
  // sub exists on disk wrongly read ok:true forever, since nothing ever triggers graduation via the root's
  // own different path string) — GREEN once a walked-key fallback (gated on the pending entry's OWN path
  // now resolving) closes it.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const repoR7 = makeToplevelRepo("r7root");
    const subR7 = path.join(repoR7, "sub-r7"); // deliberately never created yet
    check("(R7 precondition) sub does not exist on disk yet", !fs.existsSync(subR7));

    // Hand-write a PENDING (no resolvedKey) latch for subR7 under an arbitrary filename — PASS 1 processes
    // every *.json file regardless of its own filename; only a MISMATCHED-hash already-resolvedKey entry
    // cares about naming. Mirrors the hand-written pending fixtures in merge-quarantine-clear-by-path.mjs's
    // (S)/(T)/(W) sections.
    const sourceFileR7 = `pending-r7-sub-${sfx}.json`;
    const latchPathR7 = path.join(MERGE_QUARANTINE_DIR, sourceFileR7);
    fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(latchPathR7, JSON.stringify({
      repoPath: subR7, branch: "r7-sub-branch", reason: "round-7 R/sub-then-query-R repro",
      enteredAt: Date.now(), tokens: ["t-r7"],
    }, null, 2) + "\n");

    const foundR7 = reenterMergeQuarantinesAtBoot([]);
    check("(R7 precondition) boot re-entry loads this as PENDING (sub still absent)", foundR7.some((q) => q.repoPath === subR7));
    check("(R7 precondition) a direct query for sub itself is refused while absent", !assertRepoNotQuarantined(subR7).ok);
    check("(R7 precondition) a query for the ROOT is NOT yet refused (sub has never resolved, nothing to walk)", assertRepoNotQuarantined(repoR7).ok);

    // Sub now appears on disk — whatever the real-world cause (a further checkout, a branch switch), the
    // key fact is: it NOW resolves. Query the ROOT FIRST, before ever querying sub directly post-creation
    // — querying sub directly would graduate the entry via plain identity alone (it already matches,
    // round-6 behavior, unchanged), which would NOT exercise this round-7 fix at all.
    fs.mkdirSync(subR7, { recursive: true });
    check("(R7) sub now resolves on disk", fs.existsSync(subR7));

    const rootCheckR7 = assertRepoNotQuarantined(repoR7);
    check("(R7) THE ROUND-7 BUG: querying the ROOT — never queried via sub's own exact path — is STILL refused once sub resolves", !rootCheckR7.ok);
    check("(R7) the refusal still names the real (manufactured) reason", /round-7 R\/sub-then-query-R repro/i.test(rootCheckR7.reason ?? ""));

    // The root query above graduates the entry (armed under the key the ROOT's own canonicalRepoLockKey
    // resolves to — the same physical repo) — a direct query for sub must now ALSO hit it immediately.
    check("(R7) a direct query for sub itself is, naturally, also still refused after the root's own graduation", !assertRepoNotQuarantined(subR7).ok);
    check("(R7) exactly ONE entry remains for this repo (genuinely graduated, not duplicated as a leftover pending copy)", listActiveMergeQuarantines().filter((q) => q.repoPath === subR7).length === 1);

    clearMergeQuarantine(repoR7);
    check("(R7 cleanup) cleared via either path", assertRepoNotQuarantined(repoR7).ok && assertRepoNotQuarantined(subR7).ok);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // R7-ANCESTOR-SPELLING (card abccee85, round 7) — a junction/symlink-aliased EXISTING ancestor segment
  // must not defeat pending-entry matching. `directPathIdentity`'s own fallback (plain `path.resolve`, no
  // filesystem lookup) never normalizes an alias on an ancestor it doesn't itself fully resolve, so a
  // pending entry recorded via one spelling of a shared ancestor and queried via a DIFFERENT (but
  // physically identical) spelling of that same ancestor used to find nothing. `ancestorAwarePathIdentity`
  // (new, round 7) realpaths the nearest EXISTING ancestor — resolving the alias — while still carrying any
  // non-existent trailing segment literally, so it matches ONLY the exact same (not-yet-existing) location.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const realOuterR7b = makeToplevelRepo("r7b-real");
    const realSubR7b = path.join(realOuterR7b, "sub-r7b");
    fs.mkdirSync(realSubR7b, { recursive: true }); // the EXISTING ancestor both spellings will share
    const aliasOuterR7b = path.join(os.tmpdir(), `loom-mqup-r7b-alias-${sfx}`);
    tmpDirs.push(aliasOuterR7b);
    let aliasSupported = true;
    try {
      fs.symlinkSync(realOuterR7b, aliasOuterR7b, "junction"); // junction on win32; an ordinary symlink elsewhere
    } catch {
      aliasSupported = false; // e.g. no privilege to create the link on this host — skip loudly, never fake a pass
    }
    if (!aliasSupported) {
      console.warn("[merge-quarantine-unresolvable-path] SKIPPED (R7-ANCESTOR-SPELLING): could not create a junction/symlink on this host — no live alias to test against.");
    } else {
      const aliasSubR7b = path.join(aliasOuterR7b, "sub-r7b");
      check("(R7b precondition) the alias ancestor realpaths to the SAME physical sub as the real path (the hazard this test needs)", fs.realpathSync.native(aliasSubR7b) === fs.realpathSync.native(realSubR7b));
      const realLeafR7b = path.join(realSubR7b, "never-created-leaf-r7b");
      const aliasLeafR7b = path.join(aliasSubR7b, "never-created-leaf-r7b"); // same leaf NAME, different (but equivalent) ancestor spelling
      check("(R7b precondition) neither leaf spelling exists on disk", !fs.existsSync(realLeafR7b) && !fs.existsSync(aliasLeafR7b));

      // Hand-write a PENDING latch for the REAL spelling's leaf.
      const sourceFileR7b = `pending-r7b-leaf-${sfx}.json`;
      fs.mkdirSync(MERGE_QUARANTINE_DIR, { recursive: true });
      fs.writeFileSync(path.join(MERGE_QUARANTINE_DIR, sourceFileR7b), JSON.stringify({
        repoPath: realLeafR7b, branch: "r7b-branch", reason: "round-7 ancestor-spelling repro",
        enteredAt: Date.now(), tokens: ["t-r7b"],
      }, null, 2) + "\n");
      reenterMergeQuarantinesAtBoot([]);
      check("(R7b precondition) loaded as PENDING under the real spelling", listActiveMergeQuarantines().some((q) => q.repoPath === realLeafR7b));

      // Query via the ALIAS spelling's own leaf — a DIFFERENT STRING, never queried before, whose own full
      // path also never resolves (the leaf itself was never created under either spelling).
      const aliasCheckR7b = assertRepoNotQuarantined(aliasLeafR7b);
      check("(R7b) THE JUNCTION/8.3 CASE: querying the ALIAS spelling of the SAME never-created leaf is refused, not silently ok:true", !aliasCheckR7b.ok);

      clearMergeQuarantine(realLeafR7b);
      check("(R7b cleanup) cleared", assertRepoNotQuarantined(realLeafR7b).ok && assertRepoNotQuarantined(aliasLeafR7b).ok);
    }
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a quarantine latch for a repo that is temporarily UNRESOLVABLE at boot (an unmounted " +
    "drive) is neither destroyed nor silently unenforced: the original file survives, and both the subdir " +
    "and the toplevel path read as refused once the repo is reachable again, within the same boot. A clear " +
    "issued while still absent durably lifts every key an entry was armed under (scenario E), and a " +
    "pre-upgrade, key-unverifiable latch with no resolvedKey stays enforced through a remount instead of " +
    "silently failing open (scenario G). Round 2: graduation deletes the pending entry's own stale source " +
    "file instead of leaving it to resurrect the quarantine on a later boot (R1, and R2's different-door " +
    "leaf-missing-toplevel-present shape); clear/partial-clear track an explicit armedKeys set instead of " +
    "relying on reference equality, which an orphan-latch merge can invalidate (R3); and a fresh raise " +
    "merges into a still-pending latch for the same repo instead of orphaning it (RESIDUAL). Round 3: a " +
    "toplevel-bound repo's graduation/merge no longer self-deletes the latch it just wrote, even though " +
    "its old and current keys coincide (TOPLEVEL-A/TOPLEVEL-B); and armQuarantineKey's own union now " +
    "updates EVERY key it's armed under, not just the one it was called with (UNION-KEYS). Round 7: a " +
    "pending latch raised on a nested path also blocks a query for the repo ROOT once that nested path " +
    "resolves again, via a walked-key fallback gated on its own resolvability (R7-SUB-THEN-QUERY-ROOT); " +
    "and a junction/8.3-short-name-aliased existing ancestor no longer defeats pending-entry matching " +
    "(R7-ANCESTOR-SPELLING)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
