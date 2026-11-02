import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 58a3f730 — a cleared token relocated by the PRE-EXISTING protect/relocate-foreign-occupant
// path (c9114934/d4b25feb) into an ALREADY-PENDING identity's own existing record must still be lifted by
// the SAME clearMergeQuarantineByToken call that caused the relocate, not stranded on it forever.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-mq58a3-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const { canonicalRepoLockKey } = await import(pathToFileURL(path.join(distGitDir, "repo-lock.js")).href);
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq58a3@loom -c user.name=mq58a3";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq58a3-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-58a3f730 (${tag})\n`);
  execSync(`git init -q && git config user.email mq58a3@loom && git config user.name mq58a3`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// Same technique as 25d0d45b's/028837ad's own test files: plant a `.json.tmp-<pid>` residue directly at
// `key`'s own hash — the pid/hex suffix must match boot's own strict `tmpFiles` filter
// (`/\.json\.tmp-\d+(-[0-9a-f]+)?$/`, merge-quarantine.ts ~:8417).
function plantTmpResidue(key, repoPath, branch, reason, tokens, suffix, againstModule, extra = {}) {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
  fs.mkdirSync(againstModule.MERGE_QUARANTINE_DIR, { recursive: true });
  const tmpPath = path.join(againstModule.MERGE_QUARANTINE_DIR, `${hash}.json.tmp-${suffix}`);
  fs.writeFileSync(tmpPath, JSON.stringify({ repoPath, branch, reason, enteredAt: Date.now() - 1000, tokens, ...extra }, null, 2) + "\n");
  return tmpPath;
}

// Mirrors the real module's own private pendingDivertFilenameFor — same technique
// merge-quarantine-3315b08a-replace-not-splice-stale-target.mjs's own helper uses.
function pendingDivertFilenameForTest(repoPath) {
  let real;
  try { real = fs.realpathSync.native(repoPath); } catch { real = path.resolve(repoPath); }
  const identity = process.platform === "win32" ? real.toLowerCase() : real;
  return `pending-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}.json`;
}
const hashKey = (key) => createHash("sha256").update(key).digest("hex").slice(0, 24);

try {
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (STRAND) R: raised and resolvable, single token tR. X: raised INDEPENDENTLY FIRST (its own real
  // token tX) — already genuinely pending at clearMergeQuarantineByToken(R, tR)'s own call start. A tmp
  // residue is then planted AT R's own canonical-key hash, naming X with tokens [tR, tF2] — models a
  // crash-left degraded-collision write sharing R's toplevel key before X's own later raise resolved
  // independently to its own identity hash. The relocate-foreign-occupant path (c9114934/d4b25feb,
  // protectOccupantContentBeforeDelete's own atFilenameSameIdentity branch) discovers this residue and
  // MERGES [tR, tF2] into X's ALREADY-LIVE pending record (confirmed via its own distinct "also relocated
  // ... foreign co-occupant(s)" log line) — pre-fix, the `028837ad` identity-exclusion then wrongly skips
  // X entirely because X was pending before the call, stranding tR on X forever.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const R = makeRepo("r");
    const tR = enterMergeQuarantine(R, "loom/r-branch", "merge in progress for R (58a3f730)");
    const keyR = canonicalRepoLockKey(R);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([R]);
    check("(precondition) R is active+resolvable after boot, holding just tR", (() => {
      const e = booted.activeMergeQuarantineFor(R);
      return !!e && e.tokens.length === 1 && e.tokens[0] === tR;
    })());

    const X = path.join(os.tmpdir(), `loom-mq58a3-x-never-exists-${freshSfx()}`);
    const tX = booted.enterMergeQuarantine(X, "loom/x-branch", "merge in progress for X (58a3f730, independent raise)");
    check("(precondition) X is ALREADY PENDING at its own independent raise, holding just tX", (() => {
      const e = booted.activeMergeQuarantineFor(X);
      return !!e && e.tokens.length === 1 && e.tokens[0] === tX;
    })());

    const tF2 = randomUUID();
    plantTmpResidue(keyR, X, "loom/x-branch", "merge in progress for X (58a3f730, tmp residue at R's hash)", [tR, tF2], "99903-cafe058a", booted);

    // --- IN-PROCESS LEG ---
    booted.clearMergeQuarantineByToken(R, tR);
    const xEntryAfterArm = booted.activeMergeQuarantineFor(X);
    check("*** THE FIX (strand) *** X's pending entry is reduced to [tX, tF2] — tR is gone WITHIN THE SAME call", !!xEntryAfterArm && !xEntryAfterArm.tokens.includes(tR) && [tX, tF2].every((t) => xEntryAfterArm.tokens.includes(t)));
    check("(strand) R itself is fully lifted", booted.assertRepoNotQuarantined(R).ok === true);

    // --- REBOOT LEG (durability) ---
    const freshRightAfter = await freshBootModule();
    freshRightAfter.reenterMergeQuarantinesAtBoot([R, X]);
    const xEntryRightAfterBoot = freshRightAfter.activeMergeQuarantineFor(X);
    check("*** DURABILITY (strand) *** a reboot taken right after R's clear independently agrees tR is gone from disk too", !!xEntryRightAfterBoot && !xEntryRightAfterBoot.tokens.includes(tR));

    // --- NO PERMANENT STRAND: X's OWN later clear(tX) and clear(tF2) must fully lift it ---
    freshRightAfter.clearMergeQuarantineByToken(X, tX);
    freshRightAfter.clearMergeQuarantineByToken(X, tF2);
    check("*** NO STRAND (strand) *** X is fully unblocked once its OWN real tokens (tX, tF2) are cleared", freshRightAfter.assertRepoNotQuarantined(X).ok === true);

    const afterOwnClearsBoot = await freshBootModule();
    afterOwnClearsBoot.reenterMergeQuarantinesAtBoot([R, X]);
    check("*** NO STRAND, DURABILITY (strand) *** X stays unblocked after a further reboot too", afterOwnClearsBoot.assertRepoNotQuarantined(X).ok === true);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (MULTIRECORD) X has TWO independent pending records sharing one identity — a canonical slot (X1) and
  // an untouched twin (X2, same identity, DIFFERENT sourceFile) — constructed via the SAME test-only
  // seam (reenterMergeQuarantinesAtBootTestOnly) card 3315b08a's own S3a scenario uses, since two
  // independent pending records sharing one identity is a boot/crash-recovery-time shape no real
  // in-process raise sequence can construct (a second real raise merges into the SAME existing record).
  // NEITHER record holds tR before the call. The tmp residue at R's hash relocates into X1 ONLY (the
  // canonical slot, the one `protectOccupantContentBeforeDelete`'s own atFilenameIdx lookup matches by
  // physical filename) — X2 must never be touched, spliced, or collapsed into X1's own record.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const R2 = makeRepo("r2-multirecord");
    const tR2 = enterMergeQuarantine(R2, "loom/r2-branch", "merge in progress for R2 (58a3f730 multirecord)");
    const keyR2 = canonicalRepoLockKey(R2);

    const X2id = path.join(os.tmpdir(), `loom-mq58a3-x2id-never-exists-${freshSfx()}`);
    const x2CanonicalName = pendingDivertFilenameForTest(X2id);
    const tX2a = randomUUID();
    const tX2b = randomUUID();
    const x2TwinSourceFile = "pending-58a3f730-mr-x2twin-test.json";

    const booted2 = await freshBootModule();
    booted2.reenterMergeQuarantinesAtBootTestOnly([R2], [
      { entry: { repoPath: X2id, branch: "loom/x2a-branch", reason: "X's own canonical record (58a3f730 multirecord)", enteredAt: Date.now(), tokens: [tX2a] }, sourceFile: x2CanonicalName },
      { entry: { repoPath: X2id, branch: "loom/x2b-twin-branch", reason: "X's own independent twin (58a3f730 multirecord)", enteredAt: Date.now(), tokens: [tX2b] }, sourceFile: x2TwinSourceFile },
    ]);
    check("(precondition, multirecord) R2 active, holding just tR2", (() => { const e = booted2.activeMergeQuarantineFor(R2); return !!e && e.tokens.length === 1 && e.tokens[0] === tR2; })());
    check("(precondition, multirecord) TWO live records for X2id's one identity, neither holding tR2", booted2.listActiveMergeQuarantines().filter((e) => e.repoPath === X2id).length === 2 && !booted2.listActiveMergeQuarantines().some((e) => e.repoPath === X2id && e.tokens.includes(tR2)));
    fs.mkdirSync(booted2.MERGE_QUARANTINE_DIR, { recursive: true });
    fs.writeFileSync(path.join(booted2.MERGE_QUARANTINE_DIR, x2CanonicalName), JSON.stringify({ repoPath: X2id, branch: "loom/x2a-branch", reason: "X's own canonical record (58a3f730 multirecord)", enteredAt: Date.now(), tokens: [tX2a] }));
    fs.writeFileSync(path.join(booted2.MERGE_QUARANTINE_DIR, x2TwinSourceFile), JSON.stringify({ repoPath: X2id, branch: "loom/x2b-twin-branch", reason: "X's own independent twin (58a3f730 multirecord)", enteredAt: Date.now(), tokens: [tX2b] }));

    const tF2b = randomUUID();
    plantTmpResidue(keyR2, X2id, "loom/x2a-branch", "merge in progress for X (58a3f730 multirecord, tmp residue at R2's hash)", [tR2, tF2b], "99904-cafe058b", booted2);

    booted2.clearMergeQuarantineByToken(R2, tR2);

    const x2RecordsAfter = booted2.listActiveMergeQuarantines().filter((e) => e.repoPath === X2id);
    const canonicalOnDisk = (() => { try { return JSON.parse(fs.readFileSync(path.join(booted2.MERGE_QUARANTINE_DIR, x2CanonicalName), "utf8")); } catch { return undefined; } })();
    const twinOnDisk = (() => { try { return JSON.parse(fs.readFileSync(path.join(booted2.MERGE_QUARANTINE_DIR, x2TwinSourceFile), "utf8")); } catch { return undefined; } })();

    check("*** MULTIRECORD *** exactly 2 live X records survive — no merge/collapse of the two", x2RecordsAfter.length === 2);
    check("*** MULTIRECORD (non-regression) *** the twin (X2b) is COMPLETELY untouched on disk — still just [tX2b]", !!twinOnDisk && JSON.stringify(twinOnDisk.tokens) === JSON.stringify([tX2b]));
    check("*** MULTIRECORD *** the canonical record (X2a) had tR2+tF2b relocated in, then tR2 lifted, leaving [tX2a, tF2b]", !!canonicalOnDisk && [tX2a, tF2b].every((t) => canonicalOnDisk.tokens.includes(t)) && !canonicalOnDisk.tokens.includes(tR2));
    check("(multirecord) R2 itself is fully lifted", booted2.assertRepoNotQuarantined(R2).ok === true);
    check("(multirecord) X2id's own real tokens (tX2a, tF2b, tX2b) still block it", booted2.assertRepoNotQuarantined(X2id).ok === false);

    // Durability: a reboot taken right after must independently agree.
    const freshAfterMr = await freshBootModule();
    freshAfterMr.reenterMergeQuarantinesAtBoot([R2, X2id]);
    const x2RecordsAfterBoot = freshAfterMr.listActiveMergeQuarantines().filter((e) => e.repoPath === X2id);
    const twinAfterBoot = x2RecordsAfterBoot.find((e) => e.tokens.includes(tX2b));
    const canonicalAfterBoot = x2RecordsAfterBoot.find((e) => e.tokens.includes(tX2a));
    check("*** MULTIRECORD, DURABILITY *** a reboot agrees — still 2 records, neither holding tR2", x2RecordsAfterBoot.length === 2 && !x2RecordsAfterBoot.some((e) => e.tokens.includes(tR2)));
    check("*** MULTIRECORD (non-regression) *** the twin (X2b) stays untouched after a reboot too — still just [tX2b]", !!twinAfterBoot && JSON.stringify(twinAfterBoot.tokens) === JSON.stringify([tX2b]));
    check("*** MULTIRECORD, DURABILITY *** the canonical (X2a) stays reduced after a reboot too — [tX2a, tF2b], tR2 still gone", !!canonicalAfterBoot && [tX2a, tF2b].every((t) => canonicalAfterBoot.tokens.includes(t)) && !canonicalAfterBoot.tokens.includes(tR2));
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  // (AMBIGUOUS, NO REGRESSION) card 3315b08a's own S3a shape, reproduced here directly: Y's own canonical
  // slot ALREADY HOLDS the token M3's own clear is about to release (a shared token, deliberately —
  // models Y's identity having been entangled with it BEFORE this call, by whatever prior mechanism), and
  // an untouched independent twin (Y_twin, same identity, a DIFFERENT token) also survives. The
  // `58a3f730` narrowing (filter by "already held `token`" rather than bare pending presence) must still
  // protect this ambiguous identity exactly as the pre-058a3f730 code did — Y's canonical slot DID hold
  // the token at call start, so it stays in the (now narrower) exclusion set, and BOTH Y records must
  // survive completely untouched, same as `3315b08a`'s own S3a and `028837ad`'s own TWIN GUARD scenario.
  // This scenario is expected to PASS on BOTH sides of the 58a3f730 fix — it pins what must NOT change.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const sfx = freshSfx();
    const Y = path.join(os.tmpdir(), `loom-mq58a3-amb-y-never-${sfx}`);
    const M3 = path.join(os.tmpdir(), `loom-mq58a3-amb-m3-never-${sfx}`);
    const W3 = path.join(os.tmpdir(), `loom-mq58a3-amb-w3-never-${sfx}`);
    const k3 = `mq58a3-amb-k3-${sfx}`;
    const finalBasenameForK3 = `${hashKey(k3)}.json`;
    const yCanonicalName = pendingDivertFilenameForTest(Y);

    const booted3 = await freshBootModule();
    booted3.reenterMergeQuarantinesAtBootTestOnly([], [
      { entry: { repoPath: Y, branch: "y-branch", reason: "58a3f730 ambiguous: Y's own record, at its own canonical pending-divert name", enteredAt: Date.now(), tokens: ["shared-token-58a3"] }, sourceFile: yCanonicalName },
      { entry: { repoPath: M3, branch: "m3-branch", reason: "58a3f730 ambiguous: real clear target (M3), processed first", enteredAt: Date.now(), tokens: ["shared-token-58a3"], armedKeys: [k3] }, sourceFile: "pending-58a3-amb-m3-test.json" },
      { entry: { repoPath: Y, branch: "y-twin-branch", reason: "58a3f730 ambiguous: untouched independent twin, same identity as Y", enteredAt: Date.now(), tokens: ["y-twin-private-token-58a3"] }, sourceFile: "pending-58a3-amb-ytwin-test.json" },
      { entry: { repoPath: W3, branch: "w3-branch", reason: "58a3f730 ambiguous: bystander, squats k3's own physical file", enteredAt: Date.now(), tokens: ["w3-private-token-58a3"] }, sourceFile: finalBasenameForK3 },
    ]);
    booted3.setActiveQuarantineTestOnly(k3, { repoPath: M3, branch: "occupant-m3-branch", reason: "armed twin-by-identity, not by reference", enteredAt: Date.now(), tokens: ["shared-token-58a3"] });
    fs.writeFileSync(path.join(booted3.MERGE_QUARANTINE_DIR, finalBasenameForK3), JSON.stringify({
      repoPath: Y, branch: "y-disk-branch", reason: "58a3f730 ambiguous: Y's own real on-disk content at k3", enteredAt: Date.now(), tokens: ["shared-token-58a3"],
    }, null, 2) + "\n");

    check("(precondition, ambiguous) Y reads blocked before the clear", !booted3.assertRepoNotQuarantined(Y).ok);
    check("(precondition, ambiguous) M3 reads blocked before the clear", !booted3.assertRepoNotQuarantined(M3).ok);

    let ambiguousLogSeen = false;
    const origConsoleError = console.error;
    console.error = (...args) => { if (String(args[0] ?? "").includes("live same-identity candidate(s)")) ambiguousLogSeen = true; origConsoleError(...args); };
    try {
      booted3.clearMergeQuarantineByToken(M3, "shared-token-58a3");
    } finally {
      console.error = origConsoleError;
    }

    check("*** AMBIGUOUS (non-regression) *** the fail-closed ambiguous-candidate log still fires", ambiguousLogSeen);
    check("*** AMBIGUOUS (non-regression) *** M3 is fully lifted", booted3.assertRepoNotQuarantined(M3).ok);
    check("*** AMBIGUOUS (non-regression) *** Y is STILL blocked — shared-token-58a3 never guessed-cleared on an ambiguous match", !booted3.assertRepoNotQuarantined(Y).ok);
    const yEntriesAfter = booted3.listActiveMergeQuarantines().filter((e) => e.repoPath === Y);
    check("*** AMBIGUOUS (non-regression) *** BOTH of Y's own live candidates survive untouched", yEntriesAfter.length === 2);
    check("*** AMBIGUOUS (non-regression) *** Y's reassigned canonical slot still carries shared-token-58a3, never reduced/removed", yEntriesAfter.some((e) => e.tokens.includes("shared-token-58a3")));
    check("*** AMBIGUOUS (non-regression) *** Y_twin's own private token survives completely untouched", yEntriesAfter.some((e) => e.tokens.includes("y-twin-private-token-58a3")));
  }

  console.log(failures === 0
    ? "\n✅ ALL SCENARIOS PASS — clearMergeQuarantineByToken's post-loop pending pass now also lifts a "
      + "cleared token the pre-existing relocate-foreign-occupant path (c9114934/d4b25feb) merges into an "
      + "ALREADY-PENDING identity's own existing record mid-call, durably and reboot-consistently, "
      + "including the multi-record (canonical + untouched twin) shape — without regressing card "
      + "3315b08a's own ambiguous multi-record identity protection or 028837ad's own TWIN GUARD scenario."
    : `\n❌ ${failures} CHECK(S) FAILED — reproduces (or regresses the fix for) board card 58a3f730.`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}
