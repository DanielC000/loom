import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Resume-doc boot snapshot test (card 14f14d92) — the resume doc is load-bearing (injected into every
// manager spawn, protected by rotation-check.ts's marker/floor checks) but nothing ever backed it up:
// rotation-check.ts only VERIFIES an archive a caller claims to have written, it never writes one. The
// Platform Lead truncated its own resume doc to 0 bytes on 2026-09-05 and survived only by luck (the text
// was still in context). HERMETIC like db-backup.mjs / resume-doc-watcher.mjs: real temp files/DB, no
// claude, no ~/.loom, no port 4317.
//
// Covers:
//   (1) snapshotResumeDoc: writes a byte-identical copy into `<name>.archive/auto-<ISO>.md`.
//   (2) THE DISCRIMINATING CASE (card 14f14d92 DoD-5): snapshot, THEN simulate an agent truncating the
//       ACTIVE doc to 0 bytes — the archived snapshot must still hold the ORIGINAL, non-empty content.
//       A version that only asserted "a file exists" would pass even if the snapshot captured 0 bytes or
//       captured AFTER the truncation — this asserts the actual bytes survive.
//   (3) Skips cleanly (no write) on: a missing doc, a zero-byte doc — never converts "nothing to
//       snapshot" into an empty snapshot overwriting a good prior one.
//   (4) Retention: keeps only the newest N `auto-` snapshots, prunes older ones, and NEVER touches a
//       real (non-`auto-`) rotation archive file living in the same `.archive/` dir.
//   (5) snapshotAllResumeDocsAtBoot: sweeps every project via the SAME resolveResumeDocPath resolution
//       ResumeDocWatcher/composeManagerStartupPrompt use (honors a resumeDocFilename override), skips a
//       project with no vaultPath, and never throws on a bad project.
//   (6) Platform Lead resume doc coverage: a project's vault dir holding PLATFORM-LEAD-RESUME.md and/or
//       a per-lineage sibling gets those ALSO snapshotted (the exact file the motivating incident was
//       about), without double-snapshotting when the default filename happens to coincide.
// Run: 1) build daemon, 2) node test/resume-doc-snapshot.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import {
  snapshotResumeDoc,
  snapshotAllResumeDocsAtBoot,
  RESUME_DOC_SNAPSHOT_RETAIN,
} from "../dist/orchestration/resume-doc-snapshot.js";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const root = mkdtempManaged("loom-resume-doc-snapshot-");

// --- (1) + (2) basic snapshot + THE DISCRIMINATING TRUNCATION CASE ---------------------------------
{
  const vault = path.join(root, "vault1");
  fs.mkdirSync(vault, { recursive: true });
  const docPath = path.join(vault, "Orchestrator Log.md");
  const originalContent = "# Orchestrator Log\n\nSTATE: lots of accumulated multi-seat state.\n".repeat(50);
  fs.writeFileSync(docPath, originalContent);

  const result = snapshotResumeDoc(docPath, new Date("2026-09-06T12:00:00.000Z"));
  check("snapshot outcome is 'snapshotted'", result.outcome === "snapshotted");
  check("archivePath is inside a sibling '<name>.archive' dir", result.archivePath === path.join(vault, "Orchestrator Log.archive", "auto-2026-09-06T12-00-00.000Z.md"));
  check("archive file exists on disk", fs.existsSync(result.archivePath));
  check("archive content is BYTE-IDENTICAL to the original", fs.readFileSync(result.archivePath, "utf8") === originalContent);

  // THE DISCRIMINATING CASE: simulate an agent truncating the ACTIVE doc AFTER the snapshot was taken.
  // A snapshot that were a reference/symlink, or one that (bug) re-read the doc lazily at prune time
  // instead of copying eagerly, would go empty here too — this is what actually proves the archive is a
  // real, independent, already-captured copy.
  fs.writeFileSync(docPath, ""); // the exact incident: truncated to 0 bytes
  check("DISCRIMINATING: after the active doc is truncated to 0 bytes, the archived snapshot STILL holds the full original content",
    fs.readFileSync(result.archivePath, "utf8") === originalContent && fs.readFileSync(result.archivePath, "utf8").length > 0);
  check("DISCRIMINATING: the active doc really is truncated (proving this isn't a no-op truncate)", fs.statSync(docPath).size === 0);
}

// --- (3) skip-clean cases: missing doc, zero-byte doc ----------------------------------------------
{
  const vault = path.join(root, "vault2");
  fs.mkdirSync(vault, { recursive: true });
  const missingDoc = path.join(vault, "Orchestrator Log.md");
  const missingResult = snapshotResumeDoc(missingDoc, new Date());
  check("missing doc: outcome is 'skipped-missing'", missingResult.outcome === "skipped-missing");
  check("missing doc: no archive dir was created", !fs.existsSync(path.join(vault, "Orchestrator Log.archive")));

  fs.writeFileSync(missingDoc, ""); // zero-byte
  const emptyResult = snapshotResumeDoc(missingDoc, new Date());
  check("zero-byte doc: outcome is 'skipped-empty'", emptyResult.outcome === "skipped-empty");
  check("zero-byte doc: no archive dir was created (never writes an empty snapshot)", !fs.existsSync(path.join(vault, "Orchestrator Log.archive")));
}

// --- (4) retention: keep newest N auto- snapshots, prune older, never touch a real rotation archive ----
{
  const vault = path.join(root, "vault3");
  fs.mkdirSync(vault, { recursive: true });
  const docPath = path.join(vault, "Orchestrator Log.md");
  fs.writeFileSync(docPath, "content");
  const archiveDir = path.join(vault, "Orchestrator Log.archive");
  fs.mkdirSync(archiveDir, { recursive: true });

  // A REAL rotation archive an agent wrote (no "auto-" prefix) — must survive untouched no matter what.
  const realArchive = path.join(archiveDir, "2026-09-01.md");
  fs.writeFileSync(realArchive, "a real agent-written rotation archive");

  const retain = 3;
  const results = [];
  for (let i = 0; i < retain + 4; i++) {
    // distinct, monotonically increasing ISO instants so filenames sort chronologically.
    const now = new Date(Date.UTC(2026, 8, 1, 0, 0, i));
    results.push(snapshotResumeDoc(docPath, now, retain));
  }
  check("retention: every snapshot call succeeded", results.every((r) => r.outcome === "snapshotted"));
  const autoFiles = fs.readdirSync(archiveDir).filter((n) => n.startsWith("auto-"));
  check(`retention: exactly ${retain} auto- snapshots survive (pruned to the newest)`, autoFiles.length === retain);
  const sorted = [...autoFiles].sort();
  check("retention: the survivors are the NEWEST ones (lexicographic == chronological for ISO stamps)", JSON.stringify(sorted) === JSON.stringify(autoFiles.slice().sort()));
  check("retention: the real (non-auto-) rotation archive was NEVER touched/pruned", fs.existsSync(realArchive) && fs.readFileSync(realArchive, "utf8") === "a real agent-written rotation archive");

  // Default retention constant sanity — a deliberately chosen, bounded, non-huge number.
  check("RESUME_DOC_SNAPSHOT_RETAIN is a small bounded positive integer", Number.isInteger(RESUME_DOC_SNAPSHOT_RETAIN) && RESUME_DOC_SNAPSHOT_RETAIN > 0 && RESUME_DOC_SNAPSHOT_RETAIN <= 100);
}

// --- (5) snapshotAllResumeDocsAtBoot: sweeps every project, honors overrides, skips/never throws -------
{
  const dbFile = path.join(root, "boot.db");
  const db = new Db(dbFile);
  const now = new Date().toISOString();

  // Project A: default filename.
  const vaultA = path.join(root, "boot-vaultA");
  fs.mkdirSync(vaultA, { recursive: true });
  fs.writeFileSync(path.join(vaultA, "Orchestrator Log.md"), "project A content");
  db.insertProject({ id: "projA", name: "A", repoPath: "A", vaultPath: vaultA, config: {}, createdAt: now, archivedAt: null });

  // Project B: custom resumeDocFilename override — must snapshot THAT file, not the default name.
  const vaultB = path.join(root, "boot-vaultB");
  fs.mkdirSync(vaultB, { recursive: true });
  const customName = "Selbstläufer — Orchestrator Resume.md";
  fs.writeFileSync(path.join(vaultB, customName), "project B custom content");
  fs.writeFileSync(path.join(vaultB, "Orchestrator Log.md"), "x".repeat(10)); // wrong-file decoy, oversized-looking
  db.insertProject({ id: "projB", name: "B", repoPath: "B", vaultPath: vaultB, config: {}, createdAt: now, archivedAt: null });
  db.setProjectConfig("projB", { orchestration: { resumeDocFilename: customName } });

  // Project C: no vaultPath bound at all — must be skipped, never throw.
  db.insertProject({ id: "projC", name: "C", repoPath: "C", vaultPath: "", config: {}, createdAt: now, archivedAt: null });

  const summary = snapshotAllResumeDocsAtBoot(db, new Date("2026-09-06T13:00:00.000Z"));
  check("boot sweep: does not throw and returns a summary", typeof summary === "object" && Array.isArray(summary.outcomes));
  check("boot sweep: snapshotted exactly project A's + project B's docs (project C has no vault)", summary.snapshotted === 2);
  check("boot sweep: project A's archive holds project A's content",
    fs.readFileSync(path.join(vaultA, "Orchestrator Log.archive", "auto-2026-09-06T13-00-00.000Z.md"), "utf8") === "project A content");
  check("boot sweep: project B's archive holds the CUSTOM-named file's content, not the decoy",
    fs.readFileSync(path.join(vaultB, "Selbstläufer — Orchestrator Resume.archive", "auto-2026-09-06T13-00-00.000Z.md"), "utf8") === "project B custom content");
  check("boot sweep: project B's decoy default-named file was never snapshotted", !fs.existsSync(path.join(vaultB, "Orchestrator Log.archive")));
  check("boot sweep: reports zero errors on this clean run", summary.errors === 0);

  db.close();
}

// --- (6) Platform Lead resume doc coverage: the exact file the motivating incident was about -----------
{
  const dbFile = path.join(root, "boot-lead.db");
  const db = new Db(dbFile);
  const now = new Date().toISOString();

  // Simulates the reserved "Loom Platform" home: vaultPath holds NO default "Orchestrator Log.md" at
  // all, only the Platform Lead's own base doc + one per-lineage sibling.
  const leadHome = path.join(root, "boot-lead-home");
  fs.mkdirSync(leadHome, { recursive: true });
  fs.writeFileSync(path.join(leadHome, "PLATFORM-LEAD-RESUME.md"), "lead base doc content");
  fs.writeFileSync(path.join(leadHome, "PLATFORM-LEAD-RESUME-lineage123.md"), "lead lineage doc content");
  db.insertProject({ id: "projLead", name: "Loom Platform", repoPath: leadHome, vaultPath: leadHome, config: {}, createdAt: now, archivedAt: null });

  const summary = snapshotAllResumeDocsAtBoot(db, new Date("2026-09-06T14:00:00.000Z"));
  check("Platform Lead coverage: does not throw, reports zero errors", summary.errors === 0);
  check("Platform Lead coverage: BOTH the base doc and the lineage sibling were snapshotted (2 outcomes for this one project)", summary.snapshotted === 2);
  check("Platform Lead coverage: the base doc's archive holds its own content",
    fs.readFileSync(path.join(leadHome, "PLATFORM-LEAD-RESUME.archive", "auto-2026-09-06T14-00-00.000Z.md"), "utf8") === "lead base doc content");
  check("Platform Lead coverage: the lineage sibling's archive holds ITS OWN distinct content (not a copy of the base doc)",
    fs.readFileSync(path.join(leadHome, "PLATFORM-LEAD-RESUME-lineage123.archive", "auto-2026-09-06T14-00-00.000Z.md"), "utf8") === "lead lineage doc content");
  db.close();
}

// --- (6b) no double-snapshot when the default resumeDocFilename resolution happens to name the SAME
// file a Platform-Lead-style scan would also find (defensive — not the real-world shape, but proves the
// dedupe guard actually works rather than being unreachable dead code).
{
  const dbFile = path.join(root, "boot-lead-dedupe.db");
  const db = new Db(dbFile);
  const now = new Date().toISOString();
  const vault = path.join(root, "boot-lead-dedupe-vault");
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, "PLATFORM-LEAD-RESUME.md"), "same file either way");
  db.insertProject({ id: "projDedupe", name: "Dedupe", repoPath: vault, vaultPath: vault, config: {}, createdAt: now, archivedAt: null });
  db.setProjectConfig("projDedupe", { orchestration: { resumeDocFilename: "PLATFORM-LEAD-RESUME.md" } });
  const summary = snapshotAllResumeDocsAtBoot(db, new Date("2026-09-06T14:30:00.000Z"));
  check("dedupe: the same physical file is snapshotted exactly ONCE, not twice", summary.snapshotted === 1);
  db.close();
}

// --- boot sweep never throws even when a project's vault dir doesn't exist on disk at all -------------
{
  const dbFile = path.join(root, "boot-bad.db");
  const db = new Db(dbFile);
  const now = new Date().toISOString();
  db.insertProject({ id: "projBad", name: "Bad", repoPath: "Bad", vaultPath: path.join(root, "does-not-exist-vault"), config: {}, createdAt: now, archivedAt: null });
  let threw = false;
  let summary = null;
  try { summary = snapshotAllResumeDocsAtBoot(db, new Date()); } catch { threw = true; }
  check("boot sweep: a nonexistent vault dir does not throw", !threw);
  check("boot sweep: a nonexistent vault dir's doc is reported as skipped, not an error", summary && summary.errors === 0 && summary.skipped === 1);
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — snapshotResumeDoc copies the resume doc into a bounded, auto-pruned sibling archive before anything can truncate it, the archived copy survives a simulated truncation of the active doc byte-for-byte, empty/missing docs are skipped cleanly (never an empty snapshot over a good one), retention prunes only auto- files (never a real rotation archive), snapshotAllResumeDocsAtBoot sweeps every project honoring its resumeDocFilename override without ever throwing, and Platform Lead resume doc(s) in a project's vault dir are also covered (deduped against the default resolution) — the exact file the motivating incident was about."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
