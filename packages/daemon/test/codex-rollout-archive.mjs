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

await finishAndExit(failures === 0 ? 0 : 1);
