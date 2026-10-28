import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 1dd00dca — see docs/decisions/1dd00dca-arm-foreign-orphan-latch-in-memory.md for the full
// design and history (Rounds 1-3).
//
// THE FIX: `sweepOrphanLatchFileIfUnreferenced`'s own keep branch calls
// `armForeignOrphanContentInMemoryIfUnenforced` — synchronously, inline — which arms T in memory (active
// if resolvable, pending if not) UNLESS `stillBlockedEntryFor(T)` (a PURE peek) already answers
// non-`undefined`. NEVER touches disk. The armed token set is the RAW `surviving` set (Round 3 — see the
// record's own "Round 3" section for why a Round 2 subtraction was reverted; scenario (H) below).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mq1dd00d-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// ⭐ (Round 2, CR finding 2) — the pure peek the real gate uses (`stillBlockedEntryFor`) must agree with
// the mutating lookup `assertRepoNotQuarantined` itself calls (`resolveQuarantineFor`, via its own
// `resolveQuarantineForTestOnly` boolean pass-through) on every scenario shape. Call this AFTER a
// scenario's own arm decision has already happened — a mutating call here can never change what the real
// gate already decided; it only proves the two never disagree.
//
// LIMIT (Round 3): `stillBlockedEntryFor` is a line-for-line PURE MIRROR of `resolveQuarantineFor`'s own
// lookup order, built by construction to match it — the two are the SAME tier chain, one mutating, one
// not. This cross-check therefore guards against the mirror DRIFTING from its source on a future edit to
// either function; it is NOT independent verification that the lookup order itself is correct, and a
// PASS here is never evidence of that.
const crossCheck = (label, booted, repoPath) => {
  check(`(${label}) stillBlockedEntryFor/resolveQuarantineFor agree`, (booted.stillBlockedEntryFor(repoPath) !== undefined) === booted.resolveQuarantineForTestOnly(repoPath));
};
const GIT_ID = "-c user.email=mq1dd00d@loom -c user.name=mq1dd00d";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq1dd00d-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-1dd00dca (${tag})\n`);
  execSync(`git init -q && git config user.email mq1dd00d@loom && git config user.name mq1dd00d`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// Folds `orphanBasename` into `repoPath`'s own on-disk final JSON (its own latch file must already
// exist from a real raise in `mod`) BEFORE `orphanBasename` itself exists — the same "write the referent
// after the reference" technique merge-quarantine-orphan-sweep-content-aware.mjs's own scenario (A) uses,
// standing in for a real production fold whose own durable write landed before the referenced file did.
function foldOrphanRefIntoOwnFinal(repoPath, againstModule = mod) {
  const files = fs.readdirSync(againstModule.MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && (() => {
    try { return JSON.parse(fs.readFileSync(path.join(againstModule.MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === repoPath; } catch { return false; }
  })());
  const finalPath = path.join(againstModule.MERGE_QUARANTINE_DIR, files[0]);
  const orphanBasename = `${randomBytes(12).toString("hex")}.json`;
  const record = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  record.orphanLatchFiles = [orphanBasename];
  fs.writeFileSync(finalPath, JSON.stringify(record));
  return orphanBasename;
}

function writeOrphanContent(orphanBasename, repoPath, branch, reason, tokens, againstModule = mod) {
  const orphanPath = path.join(againstModule.MERGE_QUARANTINE_DIR, orphanBasename);
  fs.writeFileSync(orphanPath, JSON.stringify({ repoPath, branch, reason, enteredAt: Date.now(), tokens }));
  return orphanPath;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// `withDistMutation` — a scoped, in-test mutation of a THROWAWAY COPY of the minimal dist import closure,
// never the real shared `dist/`. Same technique as
// merge-quarantine-4913e721-provenance-unknown-survives-protect.mjs's own `withDistMutation`: used here
// (scenario (I)) to prove that `armForeignOrphanContentInMemoryIfUnenforced`'s own gate is load-bearing —
// bypass it and show the dangerous case (E2) really does overwrite a live entry. The real
// dist/git/merge-quarantine.js is verified byte-identical before and after every call.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
const DIST_ROOT = path.join(__dirname, "..", "dist");
// Enumerated by hand from merge-quarantine.ts's own top-level imports (fs/path/crypto are node builtins,
// never copied): ../paths.js and ./repo-lock.js, plus paths.js's own ./pty/resolve-bin.js and
// ./pty/claude-dirname.js, plus repo-lock.js's own circular import back into merge-quarantine.js itself.
const CLOSURE_RELATIVE_FILES = [
  "paths.js",
  path.join("pty", "resolve-bin.js"),
  path.join("pty", "claude-dirname.js"),
  path.join("git", "repo-lock.js"),
  path.join("git", "merge-quarantine.js"),
];
const REAL_MERGE_QUARANTINE_PATH = path.join(DIST_ROOT, "git", "merge-quarantine.js");
const hashFile = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const REAL_MERGE_QUARANTINE_HASH_BEFORE = hashFile(REAL_MERGE_QUARANTINE_PATH);

/** ONE-SITE DIST MUTATION, on a throwaway COPY of the minimal import closure. Throws if `find` doesn't
 *  occur EXACTLY once in the copy — never silently mutate the wrong (or an extra) site. */
async function withDistMutation(find, replace, fn) {
  const tmpDistDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-1dd00dca-distcopy-"));
  tmpDirs.push(tmpDistDir);
  try {
    for (const rel of CLOSURE_RELATIVE_FILES) {
      const dest = path.join(tmpDistDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(DIST_ROOT, rel), dest);
    }
    const copyMqPath = path.join(tmpDistDir, "git", "merge-quarantine.js");
    const original = fs.readFileSync(copyMqPath, "utf8");
    const occurrences = original.split(find).length - 1;
    if (occurrences !== 1) {
      throw new Error(`withDistMutation: expected EXACTLY 1 occurrence of the given find-text in the merge-quarantine.js COPY, found ${occurrences}`);
    }
    fs.writeFileSync(copyMqPath, original.replace(find, replace));
    const mutatedModule = await import(pathToFileURL(copyMqPath).href);
    return await fn(mutatedModule);
  } finally {
    fs.rmSync(tmpDistDir, { recursive: true, force: true });
    check("(byte-identical guard) the REAL dist/git/merge-quarantine.js was never written", hashFile(REAL_MERGE_QUARANTINE_PATH) === REAL_MERGE_QUARANTINE_HASH_BEFORE);
  }
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (A) THE MAIN FIX — T is enforced IN-PROCESS, right after A's full clear keeps O, asserted at the
  // CONSUMER (assertRepoNotQuarantined), not just a bare activeMergeQuarantineFor peek.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A = makeRepo("a");
    const tA = enterMergeQuarantine(A, "loom/a-branch", "merge in progress for A (1dd00dca main)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);
    check("(A precondition) A is armed after boot, carrying O in its own orphanLatchFiles", (booted.activeMergeQuarantineFor(A)?.orphanLatchFiles ?? []).includes(orphanBasename));

    const T = makeRepo("a-t");
    const tForeign = randomUUID();
    const orphanPath = writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (1dd00dca main)", [tForeign]);
    check("(A precondition) O exists before A's full clear", fs.existsSync(orphanPath));

    booted.clearMergeQuarantineByToken(A, tA);
    check("(A) O (holding T's foreign token) SURVIVES A's full clear", fs.existsSync(orphanPath));

    // ⭐ (lesson 279) assert at the CONSUMER, in THIS SAME process, not just a bare activeMergeQuarantineFor peek.
    const assertT = booted.assertRepoNotQuarantined(T);
    check("*** THE FIX *** (A) assertRepoNotQuarantined(T) now REFUSES in-process, same booted instance, no reboot needed", assertT.ok === false);
    const tEntry = booted.activeMergeQuarantineFor(T);
    check("(A) ...and the armed entry carries T's own real, surviving foreign token", !!tEntry && tEntry.tokens.includes(tForeign));
    check("(A) ...and it still names O in its own orphanLatchFiles (so T's own later clear can sweep it)", !!tEntry && (tEntry.orphanLatchFiles ?? []).includes(orphanBasename));

    crossCheck("A-T", booted, T);
    crossCheck("A-A", booted, A);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (B) NEGATIVE CONTROL — same-identity ("ownContent") content must never be armed from this mechanism:
  // a stale leftover copy of P's OWN data must never resurrect P after P's own legitimate full clear.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const P = makeRepo("b-p");
    const tP = enterMergeQuarantine(P, "loom/p-branch", "merge in progress for P (1dd00dca ownContent control)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(P);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([P]);
    check("(B precondition) P is armed after boot, carrying the orphan reference", (booted.activeMergeQuarantineFor(P)?.orphanLatchFiles ?? []).includes(orphanBasename));

    const tStaleP = randomUUID();
    const orphanPath = writeOrphanContent(orphanBasename, P, "loom/p-branch", "stale leftover copy of P's own data", [tStaleP]);

    booted.clearMergeQuarantineByToken(P, tP);
    check("(B) the orphan is still kept on disk (fail-closed, unattributed — unrelated to this fix)", fs.existsSync(orphanPath));
    check("*** NEGATIVE CONTROL *** (B) P is NOT re-armed from its own stale content", booted.assertRepoNotQuarantined(P).ok === true);

    crossCheck("B-P", booted, P);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (C) NEGATIVE CONTROL — T already has a LIVE, independent entry (its own real raise, tReal) before
  // A3's clear keeps a SEPARATE orphan naming T with a DIFFERENT foreign token. No union, no double-arm:
  // T's entry stays exactly [tReal].
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const T = makeRepo("c-t");
    const tReal = enterMergeQuarantine(T, "loom/t-branch", "T's own REAL, independent raise (1dd00dca already-enforced control)");
    const A3 = makeRepo("c-a3");
    const tA3 = enterMergeQuarantine(A3, "loom/a3-branch", "merge in progress for A3 (1dd00dca already-enforced control)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A3);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A3, T]);
    check("(C precondition) T is armed after boot with its own real token", (booted.activeMergeQuarantineFor(T)?.tokens ?? []).includes(tReal));
    check("(C precondition) A3 is armed after boot, carrying the orphan reference", (booted.activeMergeQuarantineFor(A3)?.orphanLatchFiles ?? []).includes(orphanBasename));

    const tForeignC = randomUUID();
    const orphanPath = writeOrphanContent(orphanBasename, T, "loom/t-branch-foreign", "a DIFFERENT, foreign raise for T's own identity", [tForeignC]);

    booted.clearMergeQuarantineByToken(A3, tA3);
    check("(C) the orphan survives on disk", fs.existsSync(orphanPath));
    const tEntry = booted.activeMergeQuarantineFor(T);
    check("*** NEGATIVE CONTROL *** (C) T's own live entry is UNCHANGED — still exactly [tReal]", !!tEntry && tEntry.tokens.length === 1 && tEntry.tokens[0] === tReal);
    check("(C) ...tForeignC was never unioned in (no double-arm)", !!tEntry && !tEntry.tokens.includes(tForeignC));

    crossCheck("C-T", booted, T);
    crossCheck("C-A3", booted, A3);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (D) UNRESOLVABLE T — lands PENDING, never active; still enforced via the lazy-resolve lookup chain.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A4 = makeRepo("d-a4");
    const tA4 = enterMergeQuarantine(A4, "loom/a4-branch", "merge in progress for A4 (1dd00dca unresolvable control)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A4);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A4]);
    check("(D precondition) A4 is armed after boot, carrying the orphan reference", (booted.activeMergeQuarantineFor(A4)?.orphanLatchFiles ?? []).includes(orphanBasename));

    const T = path.join(os.tmpdir(), `loom-mq1dd00d-d-t-never-exists-${freshSfx()}`); // never created — unresolvable
    const tForeignD = randomUUID();
    const orphanPath = writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (unresolvable)", [tForeignD]);

    booted.clearMergeQuarantineByToken(A4, tA4);
    check("(D) the orphan survives on disk", fs.existsSync(orphanPath));
    const pendingList = booted.listPendingMergeQuarantinesTestOnly();
    check("*** THE FIX (unresolvable) *** (D) T lands in the PENDING tier, never active (its path does not resolve)", pendingList.some((p) => p.repoPath === T && p.sourceFile === orphanBasename));
    const pendingMatch = booted.listActiveMergeQuarantines().find((e) => e.repoPath === T);
    check("(D) ...and IS enforced there, carrying its own real token", !!pendingMatch && pendingMatch.tokens.includes(tForeignD));
    check("*** THE FIX (unresolvable) *** (D) assertRepoNotQuarantined(T) refuses via the lazy-resolve lookup chain", booted.assertRepoNotQuarantined(T).ok === false);

    crossCheck("D-T", booted, T);
    crossCheck("D-A4", booted, A4);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (E) KEY ALREADY OCCUPIED BY A DIFFERENT IDENTITY — T is a never-created "ghost" subdir of an already-
  // quarantined repo R (ancestor-walk collapse: canonicalRepoLockKey(T) === canonicalRepoLockKey(R)).
  // Fail SAFE: do not arm T, do not touch R. R's own entry survives byte-identical.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const R = makeRepo("e-r");
    const tR = enterMergeQuarantine(R, "loom/r-branch", "merge in progress for R (1dd00dca key-occupied control)");
    const T = path.join(R, "ghost-subdir"); // never created — collapses to R's own key via ancestor walk
    check("(E precondition) T's key collides with R's (ancestor walk, T never created)", canonicalRepoLockKey(T) === canonicalRepoLockKey(R));

    const A5 = makeRepo("e-a5");
    const tA5 = enterMergeQuarantine(A5, "loom/a5-branch", "merge in progress for A5 (1dd00dca key-occupied control)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A5);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A5, R]);
    check("(E precondition) R is armed after boot with its own real token", (booted.activeMergeQuarantineFor(R)?.tokens ?? []).includes(tR));
    check("(E precondition) A5 is armed after boot, carrying the orphan reference", (booted.activeMergeQuarantineFor(A5)?.orphanLatchFiles ?? []).includes(orphanBasename));

    const tForeignE = randomUUID();
    const orphanPath = writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (ghost, shares R's key)", [tForeignE]);

    booted.clearMergeQuarantineByToken(A5, tA5);
    check("(E) the orphan survives on disk", fs.existsSync(orphanPath));
    const rEntry = booted.activeMergeQuarantineFor(R);
    check("*** NEGATIVE CONTROL *** (E) R's own entry is UNTOUCHED — still exactly [tR], never unioned with T's foreign token", !!rEntry && rEntry.tokens.length === 1 && rEntry.tokens[0] === tR);
    check("(E) ...T itself still reads as blocked (via R's own occupancy of the shared key), never silently dropped", booted.assertRepoNotQuarantined(T).ok === false);

    crossCheck("E-T", booted, T);
    crossCheck("E-R", booted, R);
    crossCheck("E-A5", booted, A5);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (E2) KEY ALREADY OCCUPIED, BUT T IS RESOLVABLE (a REAL, EXISTING subdir of R — never a "ghost") — the
  // dangerous case E's own unresolvable ghost never exercises: a bypassed gate would hit the ACTIVE
  // `.set()` branch directly (see `armForeignOrphanContentInMemoryIfUnenforced`'s `isRepoPathCurrentlyResolvable`
  // branch), clobbering R's own live entry at the SAME canonical key. Fail SAFE: R's entry survives as the
  // SAME object with the SAME tokens; T is never separately armed. See scenario (I) below for the
  // dist-mutation negative control proving this "dangerous case" label is not just a name.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const R = makeRepo("e2-r");
    const tR = enterMergeQuarantine(R, "loom/r-branch", "merge in progress for R (1dd00dca resolvable key-occupied control)");
    const T = path.join(R, "existing-subdir"); // REAL, EXISTING subdir — resolvable, but no .git of its own
    fs.mkdirSync(T);
    check("(E2 precondition) T is RESOLVABLE (a real, existing subdir)", fs.existsSync(T));
    check("(E2 precondition) T's key collides with R's (no .git boundary at T)", canonicalRepoLockKey(T) === canonicalRepoLockKey(R));

    const A8 = makeRepo("e2-a8");
    const tA8 = enterMergeQuarantine(A8, "loom/a8-branch", "merge in progress for A8 (1dd00dca resolvable key-occupied control)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A8);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A8, R]);
    const rEntryBefore = booted.activeMergeQuarantineFor(R);
    check("(E2 precondition) R is armed after boot with its own real token", (rEntryBefore?.tokens ?? []).includes(tR));
    check("(E2 precondition) A8 is armed after boot, carrying the orphan reference", (booted.activeMergeQuarantineFor(A8)?.orphanLatchFiles ?? []).includes(orphanBasename));

    const tForeignE2 = randomUUID();
    const orphanPath = writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (resolvable, shares R's key)", [tForeignE2]);

    booted.clearMergeQuarantineByToken(A8, tA8);
    check("(E2) the orphan survives on disk", fs.existsSync(orphanPath));
    const rEntryAfter = booted.activeMergeQuarantineFor(R);
    check("*** THE DANGEROUS CASE *** (E2) R's own entry is the SAME OBJECT, never overwritten", rEntryAfter === rEntryBefore);
    check("(E2) ...still exactly [tR], never unioned with T's foreign token", !!rEntryAfter && rEntryAfter.tokens.length === 1 && rEntryAfter.tokens[0] === tR);
    check("(E2) ...T itself still reads as blocked (via R's own occupancy), never silently dropped", booted.assertRepoNotQuarantined(T).ok === false);

    crossCheck("E2-T", booted, T);
    crossCheck("E2-R", booted, R);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (F) T's own clear, right after the in-process arm, LIFTS T AND SWEEPS O (content-aware) — and a
  // subsequent reboot does NOT re-arm T from residue, because there is none left.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A6 = makeRepo("f-a6");
    const tA6 = enterMergeQuarantine(A6, "loom/a6-branch", "merge in progress for A6 (1dd00dca self-clear-sweeps-O)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A6);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A6]);

    const T = makeRepo("f-t");
    const tForeignF = randomUUID();
    const orphanPath = writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (self-clear-sweeps-O)", [tForeignF]);

    booted.clearMergeQuarantineByToken(A6, tA6);
    check("(F precondition) T is armed in-process after A6's clear", !!booted.activeMergeQuarantineFor(T));
    check("(F precondition) O survives on disk", fs.existsSync(orphanPath));

    crossCheck("F-T-after-arm", booted, T);

    booted.clearMergeQuarantineByToken(T, tForeignF);
    check("*** THE FIX (self-clear) *** (F) T's own clear lifts it", booted.assertRepoNotQuarantined(T).ok === true);
    check("*** THE FIX (self-clear) *** (F) ...and sweeps O (content-aware: T's own tokens now fully account for it)", !fs.existsSync(orphanPath));

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([A6, T]);
    check("(F) a subsequent reboot does NOT re-arm T — there is no residue left to re-arm it from", !fresh.activeMergeQuarantineFor(T));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (G) A reboot after the in-process arm, with NO clear of T in between, yields exactly ONE entry for T
  // with an UNCHANGED token count — the in-memory-only arm never contaminates what boot independently
  // re-derives from disk (no double-arm, no double-count).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A7 = makeRepo("g-a7");
    const tA7 = enterMergeQuarantine(A7, "loom/a7-branch", "merge in progress for A7 (1dd00dca no-double-count)");
    const orphanBasename = foldOrphanRefIntoOwnFinal(A7);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A7]);

    const T = makeRepo("g-t");
    const tForeignG = randomUUID();
    writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (no-double-count)", [tForeignG]);

    booted.clearMergeQuarantineByToken(A7, tA7);
    check("(G precondition) T is armed in-process after A7's clear (no clear of T itself)", !!booted.activeMergeQuarantineFor(T));

    crossCheck("G-T-after-arm", booted, T);

    const fresh = await freshBootModule();
    fresh.reenterMergeQuarantinesAtBoot([A7, T]);
    const matches = fresh.listActiveMergeQuarantines().filter((e) => e.repoPath === T);
    check("*** THE FIX (no-double-count) *** (G) a fresh reboot yields EXACTLY ONE entry for T", matches.length === 1);
    check("(G) ...with the SAME, unchanged token set — never duplicated", matches.length === 1 && matches[0].tokens.length === 1 && matches[0].tokens[0] === tForeignG);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (H) DURABILITY — NO IN-PROCESS/ON-DISK SPLIT, ACROSS BOTH CLEAR ROUTES. Orphan O for T carries BOTH
  // the clearer's own token (tA) AND T's own real foreign token (tF). Governing invariant (Round 3): this
  // in-memory arm must mirror what the next boot's own PASS 1 would arm from the SAME on-disk bytes.
  // (H1, token route): asserts T's PRE-reboot and POST-reboot `assertRepoNotQuarantined(T).ok` AGREE after
  // T's own clear — never which value, just that the two never split. (H2, human route): T's own
  // identity-wide clear both reports ok AND durably deletes O. See the decision record's own "Round 3"
  // section for the verified mechanism behind why H1's intermediate token-route state is NOT "blocked by
  // tA" the way a naive read of the boot-equivalent set would suggest.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    // ---- (H1) the TOKEN route: clearMergeQuarantineByToken -------------------------------------------
    const A10 = makeRepo("h1-a10");
    const tA10 = enterMergeQuarantine(A10, "loom/a10-branch", "merge in progress for A10 (1dd00dca durability, token route)");
    const orphanBasename1 = foldOrphanRefIntoOwnFinal(A10);

    const booted1 = await freshBootModule();
    booted1.reenterMergeQuarantinesAtBoot([A10]);

    const T1 = makeRepo("h1-t");
    const tForeignH1 = randomUUID();
    writeOrphanContent(orphanBasename1, T1, "loom/t-branch", "merge in progress for T1 (1dd00dca durability, token route)", [tA10, tForeignH1]);

    booted1.clearMergeQuarantineByToken(A10, tA10);
    check("(H1) T1 is blocked immediately after A10's clear", booted1.assertRepoNotQuarantined(T1).ok === false);
    crossCheck("H1-T1-after-A-clear", booted1, T1);
    const t1EntryAfterArm = booted1.activeMergeQuarantineFor(T1);
    // *** LOAD-BEARING SNAPSHOT-INDEPENDENCE PIN (Round 4) *** — this is the ONLY observation in this
    // scenario that distinguishes "clearMergeQuarantineByToken iterates the LIVE Map" from "it iterates a
    // `[...activeQuarantines]` snapshot taken before T is armed": a snapshot refactor still leaves the H1
    // INVARIANT below green (it causes T to STRAND on the dead token instead of splitting), so that
    // invariant check alone cannot catch a regression to a snapshot. This one can — it fails the moment
    // the live-Map-visits-mid-iteration-inserts behavior (see the guard comment at the real loop in
    // merge-quarantine.ts, card 1dd00dca) is lost.
    check("*** LOAD-BEARING PIN (H1) *** T1's in-memory set is ALREADY reduced to its own token by this point — fails if the clearByToken loop ever iterates a snapshot instead of the live Map", !!t1EntryAfterArm && t1EntryAfterArm.tokens.length === 1 && t1EntryAfterArm.tokens[0] === tForeignH1);

    // T1's own later clear, via the SAME token route, releasing its own remaining token.
    booted1.clearMergeQuarantineByToken(T1, tForeignH1);
    const t1PreRebootOk = booted1.assertRepoNotQuarantined(T1).ok;
    const freshH1 = await freshBootModule();
    freshH1.reenterMergeQuarantinesAtBoot([A10, T1]);
    const t1PostRebootOk = freshH1.assertRepoNotQuarantined(T1).ok;
    check("*** THE INVARIANT (H1, token route) *** T1's in-process state after its own clear AGREES with its post-reboot state — no split", t1PreRebootOk === t1PostRebootOk);

    // ---- (H2) the HUMAN route: clearMergeQuarantineReporting (the /clear REST route's own helper) ------
    const A11 = makeRepo("h2-a11");
    const tA11 = enterMergeQuarantine(A11, "loom/a11-branch", "merge in progress for A11 (1dd00dca durability, human route)");
    const orphanBasename2 = foldOrphanRefIntoOwnFinal(A11);

    const booted2 = await freshBootModule();
    booted2.reenterMergeQuarantinesAtBoot([A11]);

    const T2 = makeRepo("h2-t");
    const tForeignH2 = randomUUID();
    const orphanPath2 = writeOrphanContent(orphanBasename2, T2, "loom/t-branch", "merge in progress for T2 (1dd00dca durability, human route)", [tA11, tForeignH2]);

    booted2.clearMergeQuarantineReporting(A11);
    check("(H2) T2 is blocked immediately after A11's clear", booted2.assertRepoNotQuarantined(T2).ok === false);
    crossCheck("H2-T2-after-A-clear", booted2, T2);
    const t2EntryAfterArm = booted2.activeMergeQuarantineFor(T2);
    check("(H2) ...T2's in-memory set STAYS at the boot-equivalent [tA11, tF2] — the human route has no cross-entry scan to reduce it", !!t2EntryAfterArm && t2EntryAfterArm.tokens.length === 2 && t2EntryAfterArm.tokens.includes(tA11) && t2EntryAfterArm.tokens.includes(tForeignH2));

    // T2's own later clear, identity-wide via the human route — lifts BOTH tokens at once.
    const t2ClearResult = booted2.clearMergeQuarantineReporting(T2);
    check("*** THE FIX (H2, human route) *** T2's own clear reports ok — assertRepoNotQuarantined(T2)", booted2.assertRepoNotQuarantined(T2).ok === true);
    check("(H2) ...AND durably sweeps O — the orphan file is actually gone, not merely kept-and-reported-clear", !fs.existsSync(orphanPath2));
    const freshH2 = await freshBootModule();
    freshH2.reenterMergeQuarantinesAtBoot([A11, T2]);
    check("*** THE INVARIANT (H2, human route) *** a subsequent reboot does NOT re-arm T2 — nothing left on disk to re-arm it from", !freshH2.activeMergeQuarantineFor(T2));
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (I) NEGATIVE CONTROL (scoped in-test mutation) — proves (E2)'s own "dangerous case" label: with
  // `armForeignOrphanContentInMemoryIfUnenforced`'s own gate bypassed, R's live entry at a key T also
  // resolves to (a real, existing, no-.git subdir of R) really is clobbered. Runs against a throwaway
  // COPY of the dist import closure, never the real shared dist/ — verified byte-identical after.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  await withDistMutation(
    "stillBlockedEntryFor(record.repoPath) !== undefined",
    "false /* 1dd00dca negative-control (I): gate bypassed */",
    async (mutated) => {
      const R = makeRepo("i-r");
      const tR = mutated.enterMergeQuarantine(R, "loom/r-branch", "merge in progress for R (1dd00dca gate-removed negative control)");
      const T = path.join(R, "existing-subdir"); // REAL, EXISTING subdir — resolvable, no .git of its own
      fs.mkdirSync(T);
      check("(I precondition) T's key collides with R's", canonicalRepoLockKey(T) === canonicalRepoLockKey(R));

      const A9 = makeRepo("i-a9");
      const tA9 = mutated.enterMergeQuarantine(A9, "loom/a9-branch", "merge in progress for A9 (1dd00dca gate-removed negative control)");
      const orphanBasename = foldOrphanRefIntoOwnFinal(A9, mutated);

      mutated.reenterMergeQuarantinesAtBoot([A9, R]);
      const rEntryBefore = mutated.activeMergeQuarantineFor(R);
      check("(I precondition) R is armed after boot with its own real token", (rEntryBefore?.tokens ?? []).includes(tR));

      const tForeignI = randomUUID();
      writeOrphanContent(orphanBasename, T, "loom/t-branch", "merge in progress for T (gate-removed negative control)", [tForeignI], mutated);

      mutated.clearMergeQuarantineByToken(A9, tA9);
      const rEntryAfter = mutated.activeMergeQuarantineFor(R);
      check("*** NEGATIVE CONTROL *** (I) with the gate bypassed, R's own entry IS clobbered — proving the real gate (E2) is load-bearing, not cosmetic",
        rEntryAfter !== rEntryBefore && (!rEntryAfter || !rEntryAfter.tokens.includes(tR)));
    },
  );
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 1dd00dca: sweepOrphanLatchFileIfUnreferenced now arms a genuinely foreign, " +
    "genuinely uncovered, genuinely unenforced orphan's content IN MEMORY, THIS PROCESS ONLY, the moment " +
    "its own sweep proves it safe to keep rather than waiting for the next boot's PASS 1 (A, asserted at " +
    "the assertRepoNotQuarantined consumer). Never for the clearer's own stale content (B). Never a " +
    "second, competing representation when the identity already has a live entry (C) or its canonical " +
    "key is already occupied by a different identity, whether unresolvable (E) or genuinely resolvable " +
    "(E2) — both fail safe to today's keep-and-wait behavior, verified via the PURE stillBlockedEntryFor " +
    "peek agreeing with the mutating resolveQuarantineFor lookup assertRepoNotQuarantined itself uses, on " +
    "every scenario shape. An unresolvable identity is armed PENDING, not active (D). T's own later clear " +
    "in the SAME process lifts it and content-aware-sweeps its own backing orphan for free (F). A reboot " +
    "with no clear in between never double-arms or double-counts what boot independently re-derives from " +
    "disk (G). The armed token set is the RAW surviving set, never subtracted by the clearer's own " +
    "candidateTokens (Round 3 correction) — this in-memory arm mirrors what the next boot's own PASS 1 " +
    "would arm from the SAME bytes, so T's own later clear never disagrees with what a reboot re-derives, " +
    "on either clear route (H). And a scoped dist-mutation negative control confirms the OTHER fix's gate " +
    "is load-bearing: bypass it and (E2)'s own live entry really is clobbered (I)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
