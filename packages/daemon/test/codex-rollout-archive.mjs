import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b8124a1f (owner decision, request 15bd0464: "Archive-not-delete: Loom compresses/moves old
// rollouts out of sessions/, never deletes.") — hermetic coverage for pty/codex-rollout-archive.ts +
// its wiring into pty/codex-transcript.ts#resolveTranscriptFile.
//
// DoD-aligned coverage:
//   1. threshold discriminates BOTH polarities — an old rollout is archived, a fresh one is not (proves
//      the age filter is real, not a blanket move);
//   2. the move is LOSSLESS (byte-identical content) and preserves the exact YYYY/MM/DD relative path
//      (so restoring is a plain reverse move, no reconstruction needed);
//   3. resolveTranscriptFile/transcriptExists/readTranscript ALL still work for an ARCHIVED rollout
//      (not just the untouched-corpus path) via the archive-root fallback;
//   4. sessions/transcript.ts's harness-dispatched engineTranscriptExists — the SAME function
//      sessions/scratch-gc.ts's codex resumability check and sessions/liveness.ts's watcher re-check
//      both call by default — also resolves true for an archived rollout, so those two readers are
//      covered via their shared choke point rather than re-implemented here;
//   5. a genuinely nonexistent conversation id still resolves to null even with a populated archive
//      root present (negative control — the fallback doesn't just match anything);
//   6. scanned/archived/failed accounting, and the exact relative path recorded for a move.
//   7. (card 5172fe3a) restoreArchivedCodexRollout: byte-identical restore to the EXACT original
//      relative path; a genuinely unknown id is a no-op; a live file already present is NEVER
//      overwritten (and its archive copy, if any, is left untouched too).
//   8. (card 7306e109 round 2) restoreArchivedCodexRollout's resolvedPathHint is re-verified, not
//      trusted blindly: a hint that no longer exists, sits under neither known root, names a DIFFERENT
//      conversation, or (for an archive-root hint) sits at the wrong YYYY/MM/DD/<file> depth all fall
//      through to the full walk; a stale ARCHIVE hint while a live copy already exists reports
//      alreadyLive and never clobbers the live file.
//
// ⚠️ NOT covered here: the EXDEV (cross-device rename) fallback inside moveFile — reproducing a real
// cross-device rename hermetically would need two distinct filesystems/volumes, not available in this
// sandbox. That branch mirrors codex-transcript.ts#snapshotTranscript's own already-proven
// atomic-copy-then-rename dance; left as a stated, disclosed gap rather than a fabricated cover.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-rollout-archive.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond, diag) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) {
    failures++;
    if (diag) console.log(`      ${diag}`);
  }
};

const tmpCodexHome = mkdtempManaged("loom-codex-rollout-archive-codexhome-");
process.env.CODEX_HOME = tmpCodexHome;
useOwnLoomHome("loom-codex-rollout-archive-loomhome-");

const {
  archiveOldCodexRollouts,
  codexRolloutArchiveRoot,
  CODEX_ROLLOUT_ARCHIVE_AGE_MS,
  restoreArchivedCodexRollout,
} = await import("../dist/pty/codex-rollout-archive.js");
const {
  resolveTranscriptFile,
  transcriptExists,
  readTranscript,
} = await import("../dist/pty/codex-transcript.js");
const { engineTranscriptExists } = await import("../dist/sessions/transcript.js");

function dayDir(home, y, m, d) {
  return path.join(home, "sessions", y, m, d);
}

function writeRollout(dayDirPath, fileName, sessionId, cwd, mtimeMs, extraLines = []) {
  fs.mkdirSync(dayDirPath, { recursive: true });
  const file = path.join(dayDirPath, fileName);
  const lines = [
    JSON.stringify({ type: "session_meta", payload: { session_id: sessionId, cwd, originator: "codex-tui" } }),
    ...extraLines,
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const seconds = mtimeMs / 1000;
  fs.utimesSync(file, seconds, seconds);
  return file;
}

const nowMs = Date.now();
const OLD_MTIME_MS = nowMs - CODEX_ROLLOUT_ARCHIVE_AGE_MS - 60_000; // 1 minute past threshold
const FRESH_MTIME_MS = nowMs - 60_000; // 1 minute old — well inside the live window

// --- Scenario 1: threshold discriminates both polarities ------------------------------------------
const cwdOld = "/fake/codex/rollout-archive/old-session";
const cwdFresh = "/fake/codex/rollout-archive/fresh-session";
const oldId = "old-conversation-id";
const freshId = "fresh-conversation-id";

const oldDir = dayDir(tmpCodexHome, "2026", "09", "01");
const freshDir = dayDir(tmpCodexHome, "2026", "09", "09");
const oldFile = writeRollout(oldDir, `rollout-2026-09-01T00-00-00-${oldId}.jsonl`, oldId, cwdOld, OLD_MTIME_MS);
const oldContent = fs.readFileSync(oldFile);
const freshFile = writeRollout(freshDir, `rollout-2026-09-09T00-00-00-${freshId}.jsonl`, freshId, cwdFresh, FRESH_MTIME_MS);

check(
  "RED CONTROL: before archiving, resolveTranscriptFile finds the old rollout LIVE (proves the fixture is set up correctly)",
  resolveTranscriptFile(cwdOld, oldId) === oldFile,
);

const result1 = archiveOldCodexRollouts();

check("scanned counts both candidates considered", result1.scanned === 2, `scanned=${result1.scanned}`);
check(
  "the OLD rollout (past the age threshold) IS archived",
  result1.archived.includes(path.join("2026", "09", "01", `rollout-2026-09-01T00-00-00-${oldId}.jsonl`)),
  `archived=${JSON.stringify(result1.archived)}`,
);
check(
  "the FRESH rollout (inside the age threshold) is NOT archived",
  !result1.archived.some((p) => p.includes(freshId)),
  `archived=${JSON.stringify(result1.archived)}`,
);
check("no failures reported", result1.failed.length === 0, `failed=${JSON.stringify(result1.failed)}`);
check("the old file no longer exists at its original live path", !fs.existsSync(oldFile));
check("the fresh file is UNTOUCHED at its original live path", fs.existsSync(freshFile));

// --- Scenario 2: the move is lossless + preserves the exact YYYY/MM/DD relative path ---------------
const archivedPath = path.join(codexRolloutArchiveRoot(), "2026", "09", "01", `rollout-2026-09-01T00-00-00-${oldId}.jsonl`);
check("the archived file exists at the EXACT mirrored YYYY/MM/DD relative path", fs.existsSync(archivedPath));
check(
  "the archived file's content is byte-identical to the original (lossless — no compression/transform)",
  fs.existsSync(archivedPath) && Buffer.compare(fs.readFileSync(archivedPath), oldContent) === 0,
);

// --- Scenario 3: resolveTranscriptFile/transcriptExists/readTranscript work for the ARCHIVED rollout,
// not just the untouched corpus -----------------------------------------------------------------------
check(
  "resolveTranscriptFile finds the ARCHIVED rollout via the fallback (byte-identical path)",
  resolveTranscriptFile(cwdOld, oldId) === archivedPath,
  `got=${resolveTranscriptFile(cwdOld, oldId)}`,
);
check("transcriptExists is true for the archived rollout", transcriptExists(cwdOld, oldId) === true);
const turns = readTranscript(cwdOld, oldId);
check(
  "readTranscript still parses the archived rollout (session_meta line alone yields zero turns, but it must not throw/return garbage)",
  Array.isArray(turns) && turns.length === 0,
);

// --- Scenario 4: reversibility — moving the archived file back restores the exact original -----------
fs.mkdirSync(path.dirname(oldFile), { recursive: true });
fs.renameSync(archivedPath, oldFile);
check(
  "moving the archived file back to its original live path is a complete, lossless restore",
  fs.existsSync(oldFile) && Buffer.compare(fs.readFileSync(oldFile), oldContent) === 0,
);
// Put it back in the archive so later scenarios (which assume it's archived) still hold.
fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
fs.renameSync(oldFile, archivedPath);

// --- Scenario 5: sessions/transcript.ts's harness-dispatched engineTranscriptExists — the SAME
// function sessions/scratch-gc.ts's codex resumability check and sessions/liveness.ts's watcher
// re-check both call by default (see their own source) — also resolves true for the archived rollout.
check(
  "engineTranscriptExists(cwd, id, 'codex') — scratch-gc's + liveness's own default resumability check — " +
  "is TRUE for the archived rollout (the reader stays working without any change of its own)",
  engineTranscriptExists(cwdOld, oldId, "codex") === true,
);

// --- Scenario 6: negative control — a genuinely nonexistent conversation id still resolves to null
// even with a populated, real archive root present (the fallback doesn't just match anything) --------
check(
  "NEGATIVE CONTROL: an id that was never written anywhere still resolves to null",
  resolveTranscriptFile(cwdOld, "never-existed-id") === null,
);
check(
  "NEGATIVE CONTROL: engineTranscriptExists is false for that same never-written id",
  engineTranscriptExists(cwdOld, "never-existed-id", "codex") === false,
);

// --- Scenario 7: idempotent re-run — a second sweep with nothing newly eligible archives nothing more
const result2 = archiveOldCodexRollouts();
check(
  "a second sweep with no newly-eligible file archives nothing (fresh file still untouched, old one already moved)",
  result2.archived.length === 0,
  `archived=${JSON.stringify(result2.archived)}`,
);
check("the second sweep still scans the still-live fresh file", result2.scanned === 1, `scanned=${result2.scanned}`);

// --- Scenario 8: an empty/missing sessions root is a silent, zero-result no-op (no codex use yet) -----
{
  const emptyHome = mkdtempManaged("loom-codex-rollout-archive-empty-");
  const result3 = archiveOldCodexRollouts({ sessionsRoot: path.join(emptyHome, "sessions") });
  check("a missing sessions root yields scanned:0, archived:[], failed:[]",
    result3.scanned === 0 && result3.archived.length === 0 && result3.failed.length === 0);
}

// --- Scenario 9 (card 5172fe3a): restoreArchivedCodexRollout — byte-identical restore to the EXACT
// original relative path. `oldId` is still sitting ONLY in the archive at `archivedPath` here (scenario
// 4 restored-then-re-archived it; scenarios 5-8 never touched it again). --------------------------------
{
  check("RED CONTROL: before restoring, the live path genuinely does NOT have this file (proves the fixture is in the expected pre-restore state)", !fs.existsSync(oldFile));
  const restoreResult = restoreArchivedCodexRollout(oldId);
  check("restoreArchivedCodexRollout reports restored:true, alreadyLive:false", restoreResult.restored === true && restoreResult.alreadyLive === false, `got=${JSON.stringify(restoreResult)}`);
  check("the rollout is back at its EXACT original live path", fs.existsSync(oldFile));
  check("the restored file's content is byte-identical to the original", fs.existsSync(oldFile) && Buffer.compare(fs.readFileSync(oldFile), oldContent) === 0);
  check("the archive copy is gone (moved, not copied-and-left)", !fs.existsSync(archivedPath));
  // Put it back in the archive so a later run of this file (or a reader relying on file order) never
  // depends on this scenario's own side effect persisting past it.
  fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
  fs.renameSync(oldFile, archivedPath);
}

// --- Scenario 10: a genuinely unknown conversation id is a complete no-op — nothing created, nothing
// moved, nothing deleted, even with a populated archive root present. -----------------------------------
{
  const unknownId = "restore-unknown-id-never-written-5172fe3a";
  const beforeArchiveExists = fs.existsSync(archivedPath);
  const beforeFreshExists = fs.existsSync(freshFile);
  const restoreResult = restoreArchivedCodexRollout(unknownId);
  check("NEGATIVE CONTROL: restoreArchivedCodexRollout reports restored:false, alreadyLive:false for an unknown id", restoreResult.restored === false && restoreResult.alreadyLive === false, `got=${JSON.stringify(restoreResult)}`);
  check("the real archived file (a DIFFERENT, known id) is untouched", fs.existsSync(archivedPath) === beforeArchiveExists);
  check("the real live fresh file (a DIFFERENT, known id) is untouched", fs.existsSync(freshFile) === beforeFreshExists);
}

// --- Scenario 11: a rollout already present at the LIVE path is NEVER overwritten, and its archive
// copy (if one also exists, under the SAME relative layout) is left completely untouched — no clobber,
// no delete. Distinguishable content on each side proves neither was touched. ----------------------------
{
  const dupId = "restore-already-live-dup-id-5172fe3a";
  const dupRel = path.join("2026", "09", "05", `rollout-2026-09-05T00-00-00-${dupId}.jsonl`);
  const liveContent = "LIVE-CONTENT-MUST-SURVIVE\n";
  const archiveContent = "ARCHIVE-CONTENT-MUST-SURVIVE-UNTOUCHED\n";
  const dupLivePath = path.join(tmpCodexHome, "sessions", dupRel);
  const dupArchivePath = path.join(codexRolloutArchiveRoot(), dupRel);
  fs.mkdirSync(path.dirname(dupLivePath), { recursive: true });
  fs.writeFileSync(dupLivePath, liveContent);
  fs.mkdirSync(path.dirname(dupArchivePath), { recursive: true });
  fs.writeFileSync(dupArchivePath, archiveContent);

  const restoreResult = restoreArchivedCodexRollout(dupId);
  check("restoreArchivedCodexRollout reports alreadyLive:true when the live path already has this id", restoreResult.restored === true && restoreResult.alreadyLive === true, `got=${JSON.stringify(restoreResult)}`);
  check("the LIVE file's content is UNCHANGED (never overwritten)", fs.readFileSync(dupLivePath, "utf8") === liveContent);
  check("the ARCHIVE copy is left completely untouched (never deleted, never modified)", fs.existsSync(dupArchivePath) && fs.readFileSync(dupArchivePath, "utf8") === archiveContent);
}

// --- Scenario 12 (card 7306e109 round 2): restoreArchivedCodexRollout's resolvedPathHint is
// re-verified, never trusted blindly — it must exist, name THIS conversation, and (for an archive-root
// hint) sit at the exact YYYY/MM/DD/<file> depth the destination is reconstructed from. Isolated
// sessionsRoot/archiveRoot (via deps) so these sub-scenarios never interact with the shared fixture state
// exercised above. --------------------------------------------------------------------------------------
{
  const hintSessionsRoot = mkdtempManaged("loom-codex-rollout-archive-hint-sessions-");
  const hintArchiveRoot = mkdtempManaged("loom-codex-rollout-archive-hint-archive-");
  const hintDeps = { sessionsRoot: hintSessionsRoot, archiveRoot: hintArchiveRoot };

  function writeRawRollout(root, y, m, d, fileName, content) {
    const dir = path.join(root, y, m, d);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, fileName);
    fs.writeFileSync(file, content);
    return file;
  }

  // (c) a LIVE hint ⇒ alreadyLive, no restore attempted.
  {
    const id = "hint-live-id";
    const liveFile = writeRawRollout(hintSessionsRoot, "2026", "09", "10", `rollout-2026-09-10T00-00-00-${id}.jsonl`, "LIVE\n");
    const result = restoreArchivedCodexRollout(id, { ...hintDeps, resolvedPathHint: liveFile });
    check("(c) a LIVE hint reports alreadyLive:true, restored:true", result.restored === true && result.alreadyLive === true, `got=${JSON.stringify(result)}`);
    check("(c) the live file is untouched", fs.readFileSync(liveFile, "utf8") === "LIVE\n");
  }

  // (a) a hint that no longer exists on disk ⇒ discarded, full walk engages (the archived copy is found
  // by the id-matching walk instead, proving the fallback actually ran rather than silently no-op'ing).
  {
    const id = "hint-missing-id";
    const archivedFile = writeRawRollout(hintArchiveRoot, "2026", "09", "11", `rollout-2026-09-11T00-00-00-${id}.jsonl`, "ARCHIVED\n");
    const missingHint = path.join(hintSessionsRoot, "2026", "09", "11", `rollout-does-not-exist-${id}.jsonl`);
    check("(a) RED CONTROL: the bogus hint path genuinely does not exist", !fs.existsSync(missingHint));
    const result = restoreArchivedCodexRollout(id, { ...hintDeps, resolvedPathHint: missingHint });
    check("(a) a hint that no longer exists falls through to the full walk and restores correctly", result.restored === true && result.alreadyLive === false, `got=${JSON.stringify(result)}`);
    const dest = path.join(hintSessionsRoot, "2026", "09", "11", `rollout-2026-09-11T00-00-00-${id}.jsonl`);
    check("(a) the real archived file landed at its correct live destination", fs.existsSync(dest) && fs.readFileSync(dest, "utf8") === "ARCHIVED\n");
    check("(a) the archive copy is gone (moved via the full walk, not the discarded hint)", !fs.existsSync(archivedFile));
  }

  // (b) a hint that exists but sits under NEITHER known root ⇒ discarded, full walk engages.
  {
    const id = "hint-foreign-root-id";
    const archivedFile = writeRawRollout(hintArchiveRoot, "2026", "09", "12", `rollout-2026-09-12T00-00-00-${id}.jsonl`, "ARCHIVED\n");
    const foreignRoot = mkdtempManaged("loom-codex-rollout-archive-hint-foreign-");
    const foreignHint = path.join(foreignRoot, `rollout-2026-09-12T00-00-00-${id}.jsonl`);
    fs.writeFileSync(foreignHint, "FOREIGN-COPY\n");
    const result = restoreArchivedCodexRollout(id, { ...hintDeps, resolvedPathHint: foreignHint });
    check("(b) a hint under neither known root falls through to the full walk and restores correctly", result.restored === true && result.alreadyLive === false, `got=${JSON.stringify(result)}`);
    const dest = path.join(hintSessionsRoot, "2026", "09", "12", `rollout-2026-09-12T00-00-00-${id}.jsonl`);
    check("(b) the real archived file (never the foreign-root decoy) landed at the live destination", fs.existsSync(dest) && fs.readFileSync(dest, "utf8") === "ARCHIVED\n");
    check("(b) the foreign-root decoy file is untouched", fs.existsSync(foreignHint) && fs.readFileSync(foreignHint, "utf8") === "FOREIGN-COPY\n");
  }

  // (d) an ARCHIVE hint while a live copy already exists ⇒ live wins, archive left completely untouched
  // (round 2 item 1 — the real bug: a stale archive hint, e.g. from a failed EXDEV unlink, must never
  // clobber a file that is already correctly live). RED under the pre-round-2 code: it trusted the
  // archive hint unconditionally and moved/overwrote straight over the live file.
  {
    const id = "hint-archive-stale-id";
    const y = "2026", m = "09", d = "13";
    const fileName = `rollout-2026-09-13T00-00-00-${id}.jsonl`;
    const liveFile = writeRawRollout(hintSessionsRoot, y, m, d, fileName, "LIVE-MUST-SURVIVE\n");
    const archivedFile = writeRawRollout(hintArchiveRoot, y, m, d, fileName, "ARCHIVE-MUST-SURVIVE\n");
    const result = restoreArchivedCodexRollout(id, { ...hintDeps, resolvedPathHint: archivedFile });
    check("(d) a stale ARCHIVE hint while a live copy exists reports alreadyLive:true (live wins)", result.restored === true && result.alreadyLive === true, `got=${JSON.stringify(result)}`);
    check("(d) the LIVE file's content is UNCHANGED (never overwritten)", fs.readFileSync(liveFile, "utf8") === "LIVE-MUST-SURVIVE\n");
    check("(d) the ARCHIVE copy is left completely untouched (never deleted, never modified)", fs.existsSync(archivedFile) && fs.readFileSync(archivedFile, "utf8") === "ARCHIVE-MUST-SURVIVE\n");
  }

  // (e) a hint that EXISTS and sits under a known root, but names a DIFFERENT conversation ⇒ discarded,
  // full walk engages and restores the correct id instead of falsely reporting the wrong one alreadyLive.
  {
    const id = "hint-wrong-id-target";
    const otherId = "hint-wrong-id-other";
    const archivedFile = writeRawRollout(hintArchiveRoot, "2026", "09", "14", `rollout-2026-09-14T00-00-00-${id}.jsonl`, "TARGET-ARCHIVED\n");
    const otherLiveFile = writeRawRollout(hintSessionsRoot, "2026", "09", "14", `rollout-2026-09-14T00-00-00-${otherId}.jsonl`, "OTHER-LIVE\n");
    const result = restoreArchivedCodexRollout(id, { ...hintDeps, resolvedPathHint: otherLiveFile });
    check("(e) a hint naming a DIFFERENT id falls through to the full walk and restores the correct id", result.restored === true && result.alreadyLive === false, `got=${JSON.stringify(result)}`);
    const dest = path.join(hintSessionsRoot, "2026", "09", "14", `rollout-2026-09-14T00-00-00-${id}.jsonl`);
    check("(e) the TARGET id's rollout landed at its live destination", fs.existsSync(dest) && fs.readFileSync(dest, "utf8") === "TARGET-ARCHIVED\n");
    check("(e) the archive copy for the target id is gone (moved via the full walk)", !fs.existsSync(archivedFile));
    check("(e) the unrelated OTHER id's live file is untouched", fs.readFileSync(otherLiveFile, "utf8") === "OTHER-LIVE\n");
  }

  // (f) an ARCHIVE hint that names this conversation but sits at the WRONG depth (not YYYY/MM/DD/<file>)
  // ⇒ discarded, full walk engages and restores the real, correctly-nested archived copy rather than
  // misreconstructing a destination from the wrong-depth decoy.
  {
    const id = "hint-depth-mismatch-id";
    const realArchivedFile = writeRawRollout(hintArchiveRoot, "2026", "09", "15", `rollout-2026-09-15T00-00-00-${id}.jsonl`, "REAL-ARCHIVED\n");
    const decoyFile = path.join(hintArchiveRoot, `rollout-flat-${id}.jsonl`);
    fs.writeFileSync(decoyFile, "DECOY-WRONG-DEPTH\n");
    const result = restoreArchivedCodexRollout(id, { ...hintDeps, resolvedPathHint: decoyFile });
    check("(f) a wrong-depth archive hint falls through to the full walk and restores the real copy", result.restored === true && result.alreadyLive === false, `got=${JSON.stringify(result)}`);
    const dest = path.join(hintSessionsRoot, "2026", "09", "15", `rollout-2026-09-15T00-00-00-${id}.jsonl`);
    check("(f) the REAL, correctly-nested archived copy landed at its live destination", fs.existsSync(dest) && fs.readFileSync(dest, "utf8") === "REAL-ARCHIVED\n");
    check("(f) the real archive copy is gone (moved via the full walk, not the decoy)", !fs.existsSync(realArchivedFile));
    check("(f) the wrong-depth decoy file is untouched (never used as a move source)", fs.existsSync(decoyFile) && fs.readFileSync(decoyFile, "utf8") === "DECOY-WRONG-DEPTH\n");
  }
}

await finishAndExit(failures === 0 ? 0 : 1);
