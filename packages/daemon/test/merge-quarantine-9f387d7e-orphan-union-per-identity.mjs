import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 9f387d7e — see docs/decisions/9f387d7e-orphan-sweep-unions-per-identity-before-arming.md
// for what the test pins and why (the token-set/snapshot shape below is deliberate — see that record's
// "Do not" section before changing it).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

const loomHome = useOwnLoomHome("loom-mq9f387-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const mergeQuarantineModuleHref = pathToFileURL(path.join(distGitDir, "merge-quarantine.js")).href;
const mod = await import(mergeQuarantineModuleHref);
const { enterMergeQuarantine } = mod;

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mq9f387@loom -c user.name=mq9f387";
const tmpDirs = [];
const freshSfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mq9f387-repo-${tag}-${freshSfx()}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "README.md"), `# merge-quarantine-9f387d7e (${tag})\n`);
  execSync(`git init -q && git config user.email mq9f387@loom && git config user.name mq9f387`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function neverExistsPath(tag) {
  return path.join(os.tmpdir(), `loom-mq9f387-${tag}-never-exists-${freshSfx()}`); // never created — unresolvable
}

let bootReimportCounter = 0;
async function freshBootModule() {
  bootReimportCounter++;
  return await import(`${mergeQuarantineModuleHref}?b=${bootReimportCounter}`);
}

// Folds `orphanBasenames` into `repoPath`'s own on-disk final JSON (its own latch file must already exist
// from a real raise in `againstModule`) — APPENDS to any pre-existing `orphanLatchFiles` rather than
// overwriting, since this card's whole point is TWO siblings on one entry. Works for both a plain
// `<hash>.json` final AND a `pending-<24hex>.json` pending-divert file — the scan matches on CONTENT
// (`repoPath`), never on filename shape.
function foldOrphanRefsIntoOwnFinal(repoPath, orphanBasenames, againstModule = mod) {
  const files = fs.readdirSync(againstModule.MERGE_QUARANTINE_DIR).filter((f) => f.endsWith(".json") && (() => {
    try { return JSON.parse(fs.readFileSync(path.join(againstModule.MERGE_QUARANTINE_DIR, f), "utf8")).repoPath === repoPath; } catch { return false; }
  })());
  if (files.length !== 1) throw new Error(`foldOrphanRefsIntoOwnFinal: expected exactly 1 on-disk final for ${repoPath}, found ${files.length}`);
  const finalPath = path.join(againstModule.MERGE_QUARANTINE_DIR, files[0]);
  const record = JSON.parse(fs.readFileSync(finalPath, "utf8"));
  record.orphanLatchFiles = [...new Set([...(record.orphanLatchFiles ?? []), ...orphanBasenames])];
  fs.writeFileSync(finalPath, JSON.stringify(record));
}

function writeOrphanContent(orphanBasename, repoPath, branch, reason, tokens, againstModule = mod) {
  const orphanPath = path.join(againstModule.MERGE_QUARANTINE_DIR, orphanBasename);
  fs.writeFileSync(orphanPath, JSON.stringify({ repoPath, branch, reason, enteredAt: Date.now(), tokens }));
  return orphanPath;
}

// `pendingLatchIdFor`'s own PENDING_DIVERT_RE formula (merge-quarantine.ts ~:8064-8077), replicated here
// ONLY because it is not itself exported — any drift from the real formula would just make the
// `clearMergeQuarantineLatchFile(id)` call below fail to match (an immediately-visible FAIL, not a
// silently-wrong pass).
const pendingDivertIdFor = (sourceFile) => createHash("sha256").update(sourceFile).digest("hex").slice(0, 24);

// Two-orphan fixture, STEP 1: raise `clearer` (via the top-level `mod`, durably — any module instance
// reads the SAME on-disk directory) and fold TWO orphan REFERENCES (`o1`/`o2`, bare basenames — no
// content written yet) into its own on-disk final/pending-divert file. T is NEVER raised at all — T's
// only durable backing will be O1/O2 themselves, exactly the card's own repro shape. Deliberately leaves
// O1.json/O2.json ABSENT from disk until `writeOrphanContentsForFixture` (step 2) runs: PASS 1's own
// directory scan reads every `.json` file unconditionally, so writing T's content before a boot that
// should see only `clearer`'s own reference (not yet a real file) would trip its unrelated
// stale-canonical-key migration — mirroring 1dd00dca's own established two-step fixture shape.
function raiseAndFoldOrphanRefs(clearerPath, tag) {
  const clearerToken = enterMergeQuarantine(clearerPath, `loom/${tag}-branch`, `merge in progress for ${tag} (9f387d7e)`);
  const T = makeRepo(`${tag}-t`);
  const tk1 = randomUUID();
  const tk2 = randomUUID();
  const o1 = `${createHash("sha256").update(`${tag}-o1-${freshSfx()}`).digest("hex")}.json`;
  const o2 = `${createHash("sha256").update(`${tag}-o2-${freshSfx()}`).digest("hex")}.json`;
  foldOrphanRefsIntoOwnFinal(clearerPath, [o1, o2], mod);
  return { clearerToken, T, tk1, tk2, o1, o2 };
}

// Two-orphan fixture, STEP 2: write O1/O2's real content (both naming foreign identity T, with distinct
// tokens tk1/tk2) — call this ONLY after a boot pass that should see `clearer`'s own reference but not
// yet a real O1/O2 file has already run.
function writeOrphanContentsForFixture(fixture, tag) {
  writeOrphanContent(fixture.o1, fixture.T, "loom/t-branch", `foreign raise for T, via O1 (9f387d7e ${tag})`, [fixture.tk1], mod);
  writeOrphanContent(fixture.o2, fixture.T, "loom/t-branch", `foreign raise for T, via O2 (9f387d7e ${tag})`, [fixture.tk2], mod);
}

// Snapshot/restore MERGE_QUARANTINE_DIR's own file contents — used so the reboot leg below derives from
// the SAME pre-clear orphan files as the in-process leg, never from whatever the in-process clear itself
// already rewrote or deleted on disk (a reboot booted from the latter would no longer be an independent
// derivation of the same inputs).
function snapshotQuarantineDir() {
  const dir = mod.MERGE_QUARANTINE_DIR;
  const snapshot = new Map();
  for (const f of fs.readdirSync(dir)) snapshot.set(f, fs.readFileSync(path.join(dir, f)));
  return snapshot;
}

function restoreQuarantineDirFromSnapshot(snapshot) {
  const dir = mod.MERGE_QUARANTINE_DIR;
  for (const f of fs.readdirSync(dir)) {
    if (!snapshot.has(f)) fs.rmSync(path.join(dir, f), { force: true });
  }
  for (const [f, content] of snapshot) fs.writeFileSync(path.join(dir, f), content);
}

// After the clearer's own clear has armed T from both O1 and O2 (the caller's responsibility, before
// calling this), prove the union survives either possible single-token clear — in-process AND across an
// independent reboot derivation from the SAME pre-clear orphan files.
//
// (a) Asserts T's in-process token SET (via the pure `stillBlockedEntryFor`, never the mutating
//     `resolveQuarantineFor`/`activeMergeQuarantineFor`) carries BOTH tk1 and tk2 right after the
//     clearer's own clear — a last-wins mutant (`bucket.record = decision.armable` instead of the union)
//     fails exactly here, regardless of file-processing order, because only ONE of the two tokens ever
//     survives into the armed record.
// (b) Clears tk1 and tk2 as two SYMMETRIC, independent legs (each restored from the same pre-clear
//     snapshot) — each leg asserts the SURVIVING token set, not merely a boolean `.ok`, so a mutant that
//     happens to leave the SAME token set a correct union minus tk1 would leave (coincidentally matching
//     `.ok`) is still caught by the other leg.
// (c) Snapshots MERGE_QUARANTINE_DIR BEFORE either leg touches it, and restores from that snapshot before
//     booting the reboot leg — so the reboot leg is a genuinely independent derivation from the same
//     orphan files, never a boot from state the in-process leg already mutated.
async function assertUnionSurvivesEitherClear(booted, { T, tk1, tk2 }, registeredForReboot, label) {
  const armed = booted.stillBlockedEntryFor(T);
  check(`(${label}) T's in-process token set carries both tk1 and tk2 right after the clearer's own clear`,
    !!armed && armed.tokens.includes(tk1) && armed.tokens.includes(tk2));

  const diskSnapshot = snapshotQuarantineDir();

  // Leg tk1: clear tk1 in-process — tk2 alone must still block T.
  booted.clearMergeQuarantineByToken(T, tk1);
  const leg1InProcessOk = booted.assertRepoNotQuarantined(T).ok;
  const leg1InProcessEntry = booted.stillBlockedEntryFor(T);
  check(`(${label}, leg tk1) in-process: clearing tk1 alone leaves exactly tk2 outstanding`,
    leg1InProcessOk === false && !!leg1InProcessEntry
      && leg1InProcessEntry.tokens.length === 1 && leg1InProcessEntry.tokens[0] === tk2);

  // Leg tk1, independent reboot derivation from the SAME pre-clear disk snapshot.
  restoreQuarantineDirFromSnapshot(diskSnapshot);
  const rebooted1 = await freshBootModule();
  rebooted1.reenterMergeQuarantinesAtBoot(registeredForReboot);
  rebooted1.clearMergeQuarantineByToken(T, tk1);
  const leg1PostRebootOk = rebooted1.assertRepoNotQuarantined(T).ok;
  const leg1PostRebootEntry = rebooted1.stillBlockedEntryFor(T);
  check(`*** THE FIX *** (${label}, leg tk1) in-process ok === post-reboot ok after clearing T by tk1`,
    leg1InProcessOk === leg1PostRebootOk);
  check(`(${label}, leg tk1) ...and the post-reboot token set also leaves exactly tk2`,
    !!leg1PostRebootEntry && leg1PostRebootEntry.tokens.length === 1 && leg1PostRebootEntry.tokens[0] === tk2);

  // Leg tk2 (symmetric): restore the SAME pre-clear snapshot and clear tk2 instead — tk1 alone must still
  // block T. Run post-reboot only (in-process `booted` is already consumed by leg tk1 above).
  restoreQuarantineDirFromSnapshot(diskSnapshot);
  const rebooted2 = await freshBootModule();
  rebooted2.reenterMergeQuarantinesAtBoot(registeredForReboot);
  rebooted2.clearMergeQuarantineByToken(T, tk2);
  const leg2PostRebootOk = rebooted2.assertRepoNotQuarantined(T).ok;
  const leg2PostRebootEntry = rebooted2.stillBlockedEntryFor(T);
  check(`*** THE FIX *** (${label}, leg tk2, symmetric) clearing tk2 alone leaves exactly tk1 outstanding`,
    leg2PostRebootOk === false && !!leg2PostRebootEntry
      && leg2PostRebootEntry.tokens.length === 1 && leg2PostRebootEntry.tokens[0] === tk1);

  return { leg1InProcessOk, leg1PostRebootOk };
}

try {
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (MAIN) call site #2 — clearMergeQuarantineByKey, reached via clearMergeQuarantineByToken's own
  // active-full-lift delegation (clearActiveEntryTokenAtKey ~:5017).
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A = makeRepo("main-a");
    const fixture = raiseAndFoldOrphanRefs(A, "main");
    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);
    check("(MAIN precondition) A is armed after boot, carrying both O1 and O2", (() => {
      const names = booted.stillBlockedEntryFor(A)?.orphanLatchFiles ?? [];
      return names.includes(fixture.o1) && names.includes(fixture.o2);
    })());
    writeOrphanContentsForFixture(fixture, "main");

    booted.clearMergeQuarantineByToken(A, fixture.clearerToken);
    await assertUnionSurvivesEitherClear(booted, fixture, [A], "MAIN, site #2");
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (TABLE) the SAME two-orphan repro driven through call sites #1, #3, #4 — proves the shared helper
  // covers every site, so a future 5th site can't silently skip it.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  const tableSites = [
    {
      label: "site #1 (clearTokenFromPendingIndices, full-lift branch)",
      clear: async (booted, A, fixture) => { booted.clearMergeQuarantineByToken(A, fixture.clearerToken); },
    },
    {
      label: "site #3 (tryClearMergeQuarantineByOwnIdentity, pending branch)",
      clear: async (booted, A) => { booted.clearMergeQuarantine(A); },
    },
    {
      label: "site #4 (clearMergeQuarantineLatchFile, matched-pending branch)",
      clear: async (booted, A) => {
        const pending = booted.listPendingMergeQuarantinesTestOnly().find((p) => p.repoPath === A);
        if (!pending) throw new Error("site #4 table entry: expected A to still be pending before this clear");
        const result = booted.clearMergeQuarantineLatchFile(pendingDivertIdFor(pending.sourceFile));
        if (!result.ok) throw new Error(`site #4 table entry: clearMergeQuarantineLatchFile refused: ${result.reason}`);
      },
    },
  ];
  for (const { label, clear } of tableSites) {
    const A = neverExistsPath("table");
    const fixture = raiseAndFoldOrphanRefs(A, "table");
    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([]);
    check(`(TABLE ${label} precondition) A landed PENDING, carrying both O1 and O2`, (() => {
      const pending = booted.listPendingMergeQuarantinesTestOnly().find((p) => p.repoPath === A);
      if (!pending) return false;
      let record;
      try { record = JSON.parse(fs.readFileSync(path.join(mod.MERGE_QUARANTINE_DIR, pending.sourceFile), "utf8")); } catch { return false; }
      const names = record.orphanLatchFiles ?? [];
      return names.includes(fixture.o1) && names.includes(fixture.o2);
    })());
    writeOrphanContentsForFixture(fixture, "table");

    await clear(booted, A, fixture);
    await assertUnionSurvivesEitherClear(booted, fixture, [], `TABLE ${label}`);
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  // (DIFFERENT-IDENTITY) O1 names foreign identity T, O2 names a DIFFERENT foreign identity U sharing the
  // SAME clearer's orphanLatchFiles — two arms, never merged into one entry.
  // ══════════════════════════════════════════════════════════════════════════════════════════════════
  {
    const A = makeRepo("diff-a");
    const tA = enterMergeQuarantine(A, "loom/diff-a-branch", "merge in progress for A (9f387d7e different-identity control)");
    const T = makeRepo("diff-t");
    const U = makeRepo("diff-u");
    const tkT = randomUUID();
    const tkU = randomUUID();
    const o1 = `${createHash("sha256").update(`diff-o1-${freshSfx()}`).digest("hex")}.json`;
    const o2 = `${createHash("sha256").update(`diff-o2-${freshSfx()}`).digest("hex")}.json`;
    foldOrphanRefsIntoOwnFinal(A, [o1, o2], mod);

    const booted = await freshBootModule();
    booted.reenterMergeQuarantinesAtBoot([A]);
    check("(DIFFERENT-IDENTITY precondition) A is armed after boot, carrying both O1 and O2", (() => {
      const names = booted.stillBlockedEntryFor(A)?.orphanLatchFiles ?? [];
      return names.includes(o1) && names.includes(o2);
    })());
    writeOrphanContent(o1, T, "loom/t-branch", "foreign raise for T (9f387d7e different-identity control)", [tkT], mod);
    writeOrphanContent(o2, U, "loom/u-branch", "foreign raise for U (9f387d7e different-identity control)", [tkU], mod);

    booted.clearMergeQuarantineByToken(A, tA);
    const tEntry = booted.stillBlockedEntryFor(T);
    const uEntry = booted.stillBlockedEntryFor(U);
    check("*** NEGATIVE CONTROL *** (DIFFERENT-IDENTITY) T is armed with ONLY its own token", !!tEntry && tEntry.tokens.length === 1 && tEntry.tokens[0] === tkT);
    check("(DIFFERENT-IDENTITY) ...U is armed with ONLY its own token", !!uEntry && uEntry.tokens.length === 1 && uEntry.tokens[0] === tkU);
    check("(DIFFERENT-IDENTITY) ...T's tokens never absorbed U's", !!tEntry && !tEntry.tokens.includes(tkU));
    check("(DIFFERENT-IDENTITY) ...U's tokens never absorbed T's", !!uEntry && !uEntry.tokens.includes(tkT));
  }
} finally {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 9f387d7e: the orphan sweep now unions a kept foreign orphan's tokens PER IDENTITY " +
    "before arming (mirroring the tmp-residue twin's own 25d0d45b union), so clearing by the first-armed " +
    "token's own in-process verdict agrees with what the next boot would show, on every call site that " +
    "loops over multiple orphan refs."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
