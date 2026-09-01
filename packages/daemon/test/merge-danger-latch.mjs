import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Board card 5a7692a4 DoD-2/DoD-3: REAL exercise of the DURABLE merge-danger latch
// (git/merge-danger-latch.ts) — the crash-safe counterpart to the in-memory tracker exercised in
// test/merge-danger-window.mjs. That tracker cannot survive a hard death (SIGKILL, power loss, a crash
// that never runs gracefulShutdown); this module's whole reason to exist is to answer, at the NEXT boot,
// "did the PRIOR process die inside a merge squash" — an EVENT question `scanCanonicalReposForMergeResidue`
// (a STATE probe: "is the tree dirty right now") cannot answer on its own (see that scan's own doc, quoted
// in merge-danger-latch.ts: "can't tell a dead squash's leftover stage apart from a human's own WIP").
//
// A hermetic unit test that only asserts a mock was called would prove the wiring, not the behavior — this
// drives the ACTUAL exported functions against REAL files under a REAL (isolated, temp) LOOM_HOME, and for
// the cross-reference classifier, against a REAL git repo scanned by the REAL
// scanCanonicalReposForMergeResidue. merge-danger-latch.ts resolves its file path from LOOM_HOME at IMPORT
// TIME (same caching shape as shutdown-marker.ts) — every scenario below that touches it runs in its OWN
// freshly-spawned child process with its OWN LOOM_HOME, never a re-import in this long-lived parent.
//
// Covers:
//   (A) A latch written then NEVER cleared (simulating a hard death) — persists across a process boundary
//       (two SEPARATE child processes sharing one LOOM_HOME: writer, then reader) and a subsequent read
//       finds it, correctly attributed (repo/branch/opId).
//   (B) Consume-on-read: the SAME read that finds it also deletes it — a later read in a THIRD child finds
//       nothing.
//   (C) A latch written THEN cleared (simulating a normal exit, mirroring mergeBranchLocked's own
//       try/finally) leaves NOTHING for a later boot to find.
//   (D) The write is atomic: no stray .tmp-* file is left behind after a normal write.
//   (E) Never throws: a corrupt latch file is skipped (and still removed), an unwritable directory is
//       swallowed — both round-trip through a real child process exiting 0.
//   (F) describeMergeDangerLatchAtBoot, the boot-time classifier, exercised against a REAL
//       scanCanonicalReposForMergeResidue result on a REAL repo: staged residue present ⇒ the
//       "very likely that dead squash, not WIP" attribution; clean tree ⇒ DoD-2.5's required
//       "tree looks clean" sentence — the case that is silent WITHOUT a latch; and (card b272d215)
//       a repo ABSENT from the scanned-repo-paths input (e.g. a secondary registry repo the boot
//       caller forgot to include) ⇒ the distinct "not scanned" sentence, never the clean-tree one —
//       closed by mutation: drop the repo from `scannedRepoPaths` and the message must flip.
//   (G) END-TO-END through the real production call path: a REAL mergeBranch() success/conflict both leave
//       NO latch file behind afterward (extends merge-danger-window.mjs's in-memory assertion to the
//       durable side of the SAME enter/exit calls).
// Run: 1) build daemon (pnpm build), 2) node test/merge-danger-latch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";

const __filename = fileURLToPath(import.meta.url);

// ───────────────────────── CHILD MODE ─────────────────────────
const scenario = process.env.MDL_SCENARIO;
if (scenario) {
  if (scenario === "write-only") {
    const { writeMergeDangerLatch } = await import("../dist/git/merge-danger-latch.js");
    writeMergeDangerLatch("/tmp/loom-mdl-repo", "loom/mdl-branch", "op-mdl-1");
    process.exit(0); // simulates a hard death — never calls clearMergeDangerLatch
  } else if (scenario === "read-and-report") {
    const { readAndClearMergeDangerLatches } = await import("../dist/git/merge-danger-latch.js");
    const found = readAndClearMergeDangerLatches();
    console.log(`RESULT:${JSON.stringify({ found })}`);
    process.exit(0);
  } else if (scenario === "write-then-clear") {
    const { writeMergeDangerLatch, clearMergeDangerLatch } = await import("../dist/git/merge-danger-latch.js");
    writeMergeDangerLatch("/tmp/loom-mdl-repo-2", "loom/mdl-branch-2", "op-mdl-2");
    clearMergeDangerLatch("/tmp/loom-mdl-repo-2"); // simulates a normal exit from the try/finally
    process.exit(0);
  } else if (scenario === "atomic-write-check") {
    const { writeMergeDangerLatch, MERGE_DANGER_LATCH_DIR } = await import("../dist/git/merge-danger-latch.js");
    writeMergeDangerLatch("/tmp/loom-mdl-repo-3", "loom/mdl-branch-3", "op-mdl-3");
    const files = fs.readdirSync(MERGE_DANGER_LATCH_DIR);
    console.log(`RESULT:${JSON.stringify({ files })}`);
    process.exit(0);
  } else if (scenario === "corrupt-file") {
    // PARENT pre-wrote a malformed .json into this child's LOOM_HOME/merge-danger-latches/ before spawning.
    const { readAndClearMergeDangerLatches, MERGE_DANGER_LATCH_DIR } = await import("../dist/git/merge-danger-latch.js");
    let threw = false;
    let found;
    try { found = readAndClearMergeDangerLatches(); } catch { threw = true; }
    const stillThere = fs.existsSync(path.join(MERGE_DANGER_LATCH_DIR, "corrupt.json"));
    console.log(`RESULT:${JSON.stringify({ threw, found, stillThere })}`);
    process.exit(0);
  } else if (scenario === "unwritable") {
    // LOOM_HOME (env, set by the parent) points under a FILE, not a dir — mkdirSync(recursive) must fail;
    // the writer must swallow it, and this child must still exit 0 (never throw/crash).
    const { writeMergeDangerLatch } = await import("../dist/git/merge-danger-latch.js");
    writeMergeDangerLatch("/tmp/loom-mdl-unwritable", "loom/mdl-branch-u", "op-mdl-u");
    process.exit(0);
  } else if (scenario === "e2e-merge") {
    // END-TO-END through the REAL production call path (DoD-3): a genuine mergeBranch() success against a
    // real temp repo, then check what the durable latch dir looks like afterward — extends
    // merge-danger-window.mjs's in-memory-only assertion to the durable side of the SAME enter/exit calls.
    const { mergeBranch } = await import("../dist/git/worktrees.js");
    const { MERGE_DANGER_LATCH_DIR } = await import("../dist/git/merge-danger-latch.js");
    const GIT_ID = "-c user.email=mdle2e@loom -c user.name=mdle2e";
    const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const repo = path.join(os.tmpdir(), `loom-mdl-e2e-repo-${sfx}`);
    fs.mkdirSync(repo, { recursive: true });
    execSync(`git init -q && git config user.email mdle2e@loom && git config user.name mdle2e && git add -A && git ${GIT_ID} commit -q -m init --allow-empty`, { cwd: repo });
    const wt = path.join(os.tmpdir(), `loom-mdl-e2e-wt-${sfx}`);
    execSync(`git worktree add -q -b loom/mdl-e2e "${wt}" HEAD`, { cwd: repo });
    fs.writeFileSync(path.join(wt, "f.txt"), "e2e\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m work`, { cwd: wt });
    const res = await mergeBranch(repo, "loom/mdl-e2e", "E2E title", {}, undefined, undefined, "op-e2e");
    const latchFiles = fs.existsSync(MERGE_DANGER_LATCH_DIR) ? fs.readdirSync(MERGE_DANGER_LATCH_DIR) : [];
    console.log(`RESULT:${JSON.stringify({ ok: res.ok, latchFiles })}`);
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* best-effort */ }
    process.exit(0);
  }
}

// ───────────────────────── PARENT MODE ─────────────────────────
// Section F below imports dist/git/worktrees.js and dist/git/merge-danger-latch.js directly IN this
// long-lived parent (both are pure/read-only with respect to LOOM_HOME for the functions actually called
// there — no writeMergeDangerLatch call happens in this process) — but isolate LOOM_HOME here anyway
// rather than relying on that distinction staying true forever; every other scenario spawns its own child
// with its own LOOM_HOME regardless.
useOwnLoomHome("loom-mdl-parent-");
requireHermeticEnv();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const freshHome = (tag) => mkdtempManaged(`loom-mdl-${tag}-`);
const runChild = (sc, home, extraEnv) => {
  const r = spawnSync(process.execPath, [__filename], {
    env: { ...process.env, MDL_SCENARIO: sc, LOOM_HOME: home, ...extraEnv },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status, stderr: r.stderr || "", stdout: r.stdout || "" };
};
const parseResult = (stdout) => {
  const line = stdout.split("\n").find((l) => l.startsWith("RESULT:"));
  return line ? JSON.parse(line.slice("RESULT:".length)) : null;
};

try {
  // ── A/B: a latch written in one process and NEVER cleared (simulated hard death) persists across the
  //         process boundary; the SAME read that finds it also consumes it (a later read finds nothing) ──
  {
    const home = freshHome("crash-persist");
    const w = runChild("write-only", home);
    check("[A] writer child exited cleanly (0)", w.code === 0);

    const r1 = runChild("read-and-report", home);
    const res1 = parseResult(r1.stdout);
    check("[A] a SEPARATE reader process (simulating the NEXT boot) finds the latch", res1?.found?.length === 1);
    check("[A] the found latch names the correct repo", res1?.found?.[0]?.repoPath === "/tmp/loom-mdl-repo");
    check("[A] the found latch names the correct branch", res1?.found?.[0]?.branch === "loom/mdl-branch");
    check("[A] the found latch names the correct opId", res1?.found?.[0]?.opId === "op-mdl-1");
    check("[A] the found latch carries a valid ISO timestamp", typeof res1?.found?.[0]?.enteredAt === "string" && !Number.isNaN(Date.parse(res1.found[0].enteredAt)));

    const r2 = runChild("read-and-report", home);
    const res2 = parseResult(r2.stdout);
    check("[B] consume-on-read: a THIRD process reading the SAME home finds NOTHING (already consumed)", res2?.found?.length === 0);
  }

  // ── C: a latch written THEN cleared (normal exit) leaves nothing for a later boot to find ─────────────
  {
    const home = freshHome("graceful-exit");
    const w = runChild("write-then-clear", home);
    check("[C] writer-then-clearer child exited cleanly (0)", w.code === 0);
    const r = runChild("read-and-report", home);
    const res = parseResult(r.stdout);
    check("[C] a normal exit (write immediately followed by clear) leaves NOTHING to find at the next boot", res?.found?.length === 0);
  }

  // ── D: the write is atomic — no stray .tmp-* file left behind after a normal write ──────────────────
  {
    const home = freshHome("atomic");
    const w = runChild("atomic-write-check", home);
    const res = parseResult(w.stdout);
    check("[D] writer child exited cleanly (0)", w.code === 0);
    check("[D] exactly one file exists after the write (the final .json, no leftover .tmp-*)", Array.isArray(res?.files) && res.files.length === 1);
    check("[D] the one file is the real latch (.json), not a tmp artifact", res?.files?.[0]?.endsWith(".json") && !res.files[0].includes(".tmp-"));
  }

  // ── E: never throws — a corrupt latch file is skipped (and removed), an unwritable dir is swallowed ──
  {
    const home = freshHome("corrupt");
    const latchDir = path.join(home, "merge-danger-latches");
    fs.mkdirSync(latchDir, { recursive: true });
    fs.writeFileSync(path.join(latchDir, "corrupt.json"), "{ not valid json");
    const r = runChild("corrupt-file", home);
    const res = parseResult(r.stdout);
    check("[E] corrupt-file child exited cleanly (0) — never throws on malformed JSON", r.code === 0);
    check("[E] readAndClearMergeDangerLatches() itself didn't throw", res?.threw === false);
    check("[E] a corrupt entry is skipped (not returned) rather than crashing the whole read", res?.found?.length === 0);
    check("[E] the corrupt file is still removed (consume-on-read applies even to unreadable entries)", res?.stillThere === false);
  }
  {
    const outerHome = freshHome("unwritable-outer");
    const blockerFile = path.join(outerHome, "blocker");
    fs.writeFileSync(blockerFile, "not a directory");
    const badHome = path.join(blockerFile, "loom-home-under-a-file");
    const r = runChild("unwritable", badHome);
    check("[E] unwritable: child still exits cleanly (0) — writeMergeDangerLatch swallowed the mkdir failure", r.code === 0);
    check("[E] unwritable: no uncaught exception surfaced on stderr", !r.stderr.includes("Error"));
  }

  // ── F: describeMergeDangerLatchAtBoot, exercised against a REAL scanCanonicalReposForMergeResidue result
  {
    const { describeMergeDangerLatchAtBoot } = await import(pathToFileURL(path.join(process.cwd(), "dist", "git", "merge-danger-latch.js")).href);
    const { scanCanonicalReposForMergeResidue } = await import(pathToFileURL(path.join(process.cwd(), "dist", "git", "worktrees.js")).href);
    const GIT_ID = "-c user.email=mdl@loom -c user.name=mdl";
    const repo = path.join(os.tmpdir(), `loom-mdl-classify-repo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(repo, { recursive: true });
    execSync(`git init -q && git config user.email mdl@loom && git config user.name mdl && git add -A && git ${GIT_ID} commit -q -m init --allow-empty`, { cwd: repo });
    try {
      const latch = { repoPath: repo, branch: "loom/mdl-classify", opId: "op-classify", enteredAt: new Date(Date.now() - 12_000).toISOString() };

      // (F1) CLEAN tree — the case that is SILENT today without a latch. `repo` IS in scannedRepoPaths.
      const cleanDirty = await scanCanonicalReposForMergeResidue([repo]);
      check("[F1] sanity: the fixture repo is genuinely clean per the real scan", cleanDirty.every((d) => d.repoPath !== repo));
      const cleanMsg = describeMergeDangerLatchAtBoot(latch, cleanDirty, [repo]);
      check("[F1] clean tree ⇒ the required DoD-2.5 sentence", cleanMsg.includes("tree looks clean"));
      check("[F1] clean-tree message still names the repo/branch/op", cleanMsg.includes(repo) && cleanMsg.includes("loom/mdl-classify") && cleanMsg.includes("op-classify"));
      check("[F1] clean-tree message does NOT falsely claim residue", !cleanMsg.includes("staged residue"));
      check("[F1] clean-tree message does NOT use the not-scanned wording", !cleanMsg.includes("NOT scanned"));

      // (F2) STAGED-dirty tree — real residue, via the REAL scan. `repo` IS in scannedRepoPaths.
      fs.writeFileSync(path.join(repo, "leftover.txt"), "dead-squash-leftover\n");
      execSync("git add -A", { cwd: repo });
      const dirtyDirty = await scanCanonicalReposForMergeResidue([repo]);
      check("[F2] sanity: the fixture repo is genuinely staged-dirty per the real scan", dirtyDirty.some((d) => d.repoPath === repo && d.staged === true));
      const dirtyMsg = describeMergeDangerLatchAtBoot(latch, dirtyDirty, [repo]);
      check("[F2] staged residue ⇒ the attribution sentence (not the generic scan wording)", dirtyMsg.includes("VERY LIKELY that dead squash") && dirtyMsg.includes("not WIP"));
      check("[F2] staged-residue message names the repo/branch/op", dirtyMsg.includes(repo) && dirtyMsg.includes("loom/mdl-classify") && dirtyMsg.includes("op-classify"));
      check("[F2] staged-residue message does NOT use the clean-tree wording", !dirtyMsg.includes("tree looks clean"));

      // (F3) card b272d215 — repo ABSENT from scannedRepoPaths (e.g. a secondary registry repo the boot
      // caller's input list forgot to include) must NOT collapse into the clean-tree message, even though
      // `dirty` (computed against the SAME repo, real scan, genuinely clean) looks identical to F1's. Only
      // the third argument differs from F1 — closed by mutation below.
      const notScannedMsg = describeMergeDangerLatchAtBoot(latch, cleanDirty, []);
      check("[F3] repo absent from scannedRepoPaths ⇒ the distinct not-scanned sentence", notScannedMsg.includes("NOT scanned"));
      check("[F3] not-scanned message does NOT use the clean-tree wording", !notScannedMsg.includes("tree looks clean"));
      check("[F3] not-scanned message does NOT falsely claim residue", !notScannedMsg.includes("staged residue"));
      check("[F3] not-scanned message still names the repo/branch/op", notScannedMsg.includes(repo) && notScannedMsg.includes("loom/mdl-classify") && notScannedMsg.includes("op-classify"));
      // Close by mutation: restoring `repo` to scannedRepoPaths (identical to F1's call) must flip it BACK
      // to the clean-tree wording — proves F3's distinct message is driven by scannedRepoPaths membership,
      // not some other accidental difference from F1.
      const restoredMsg = describeMergeDangerLatchAtBoot(latch, cleanDirty, [repo]);
      check("[F3] restoring the repo to scannedRepoPaths flips the message back to clean-tree (mutation check)", restoredMsg.includes("tree looks clean") && !restoredMsg.includes("NOT scanned"));

      // (F4) card b272d215 DoD-4 — canonicalRepoLockKey keying survives a case/separator-differing spelling
      // of the SAME physical directory (the Windows false-all-clear the reviewer's control demonstrated).
      // Only meaningful on win32 (canonicalRepoLockKey lowercases there; POSIX paths are case-sensitive by
      // filesystem convention, so an artificially-cased path there is a genuinely different, nonexistent
      // path and would correctly fall through to "not scanned").
      if (process.platform === "win32") {
        const upperSpelling = repo.toUpperCase();
        const upperMsg = describeMergeDangerLatchAtBoot(latch, cleanDirty, [upperSpelling]);
        check("[F4] a differently-cased spelling of the SAME repo in scannedRepoPaths still counts as scanned", upperMsg.includes("tree looks clean") && !upperMsg.includes("NOT scanned"));
      }
    } finally {
      try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  }

  // ── G: end-to-end through the REAL production call path — a real successful mergeBranch() leaves NO
  //      durable latch behind afterward, extending merge-danger-window.mjs's in-memory-only assertion to
  //      the durable side of the SAME enter/exit calls ────────────────────────────────────────────────────
  {
    const home = freshHome("e2e");
    const r = runChild("e2e-merge", home);
    const res = parseResult(r.stdout);
    check("[G] e2e child exited cleanly (0)", r.code === 0);
    check("[G] the real merge succeeded (sanity check on the fixture)", res?.ok === true);
    check("[G] NO durable latch file left behind after a real successful mergeBranch()", Array.isArray(res?.latchFiles) && res.latchFiles.length === 0);
  }
} finally {
  // freshHome()-created dirs are registered via mkdtempManaged — swept by the exit backstop below.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the durable merge-danger latch survives a simulated hard death across a process boundary, consumes itself on read, stays clean on a graceful exit, writes atomically, never throws, and its boot-time classifier correctly attributes both a dirty and a clean tree against a REAL residue scan."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
