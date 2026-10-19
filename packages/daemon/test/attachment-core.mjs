import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 432765ab (epic 7d1d66ab phase 1) — the daemon/MCP foundation for question_ask attachments.
// Covers the core resolve/copy primitives in mcp/attachments.ts, independent of the Db/MCP wiring
// (see attachment-migration.mjs / attachment-caps-config.mjs / attachment-read-surfaces.mjs for those).
// Three Code Review rounds have run against this file's own target (mcp/attachments.ts) — this file
// covers every fix from all three:
//   (A) resolveAttachmentPath accepts a file under the repo root, worker worktrees, work dir, vault
//       root, AND a multi-repo `repos[]` entry.
//   (B) resolveAttachmentPath REFUSES: a relative path, a path outside every root, a directory, a
//       nonexistent path, and a junction-escape — needs no elevated privilege (a directory junction is
//       createable unprivileged on every platform, unlike a file symlink).
//   (CRIT1) the structural LOOM_HOME refusal: RED using the REAL Platform-home binding shape
//       (repoPath = vaultPath = LOOM_HOME) AND via a junction planted inside an ORDINARY project's own
//       work dir pointing into LOOM_HOME; GREEN for a file in the Lead's own project work dir (a true
//       LOOM_HOME SIBLING, verified both in code and by this test).
//   (CRIT2) a UNC path, AND an ordinary out-of-root absolute path, are each refused WITHOUT any fs call
//       ever seeing that path (two spies prove it — the LEXICAL pre-filter rejects the latter before any
//       realpath); a nonexistent path outside the roots gives the SAME refusal as an existing one.
//   (MAJ3) a FIFO is refused (POSIX-only — SKIPs on win32) via isAcceptableAttachmentStat, which is also
//       unit-tested directly with a fake stat (works on every platform regardless of mkfifo support).
//   (HARDLINK) a same-volume hardlink into an allowed root is refused (resolve time, nlink>1) — realpath
//       of a hardlink is its own path, so containment/LOOM_HOME checks alone can't see it.
//   (SWAP) a file swapped for a different inode BETWEEN resolve and its own copy is refused by
//       copyAttachmentWithCap's own re-validation — driven deterministically via a test-only hook.
//   (MIN4) sanitizeBasename strips win32-illegal/ADS characters from the stored filename.
//   (MIN5) a junctioned root is matched by its CANONICAL form; addressing via an UNRELATED third alias
//       is refused (a deliberate narrowing, not a regression — see the decision record).
//   (MIN6) the root-equality refusal is reachable BEFORE any filesystem touch (not dead code).
//   (MIN7) an empty repoPath is never pushed as a root.
//   (MIN9) the `attachments` zod shape bounds `path`/`label` length.
//   (C) deriveAttachmentKind / cheapImageDimensions are derived from the file's own bytes.
//   (D) copyAttachmentWithCap enforces the cap on BYTES ACTUALLY TRANSFERRED (TOCTOU-safe) and refuses
//       outright on a deliberately-wrong expected identity.
//   (E) prepareQuestionAttachments: resolve-all-first, count cap, cleanup on a mid-copy failure.
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/attachment-core.mjs
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-attach-core-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { WORKTREES_DIR, PROJECTS_WORK_ROOT, LOOM_HOME, questionAttachmentDir, projectWorkDir } = await import("../dist/paths.js");
const { canonicalizeForContainment, isProperlyUnder } = await import("../dist/projects/vault-path.js");
const { comparisonKey } = await import("../dist/projects/repos.js");
const {
  attachmentAllowedRoots, resolveAttachmentPath, deriveAttachmentKind, cheapImageDimensions,
  copyAttachmentWithCap, prepareQuestionAttachments, isAcceptableAttachmentStat, sanitizeBasename,
} = await import("../dist/mcp/attachments.js");
const { QUESTION_ASK_INPUT_SHAPE } = await import("../dist/mcp/questionTool.js");
const { z } = await import("zod");

// Deliberately a SIBLING of tmpHome (LOOM_HOME), never nested inside it — mirrors the real topology
// (WORKTREES_DIR/PROJECTS_WORK_ROOT are also LOOM_HOME siblings) and avoids every fixture path here
// being spuriously caught by the LOOM_HOME refusal this file is specifically testing elsewhere.
const scratch = path.join(os.tmpdir(), `loom-attach-core-scratch-${Date.now()}-${process.pid}`);
fs.mkdirSync(scratch, { recursive: true });

const projId = "attach-core-proj";
const repoRoot = path.join(scratch, "repo");
const vaultRoot = path.join(scratch, "vault");
const worktreesRoot = path.join(WORKTREES_DIR, projId);
const workDirRoot = path.join(PROJECTS_WORK_ROOT, projId);
const extraRepoRoot = path.join(scratch, "extra-repo");
for (const d of [repoRoot, vaultRoot, worktreesRoot, workDirRoot, extraRepoRoot]) fs.mkdirSync(d, { recursive: true });
const project = { id: projId, repoPath: repoRoot, vaultPath: vaultRoot, repos: [{ key: "extra", path: extraRepoRoot }] };

const outsideDir = path.join(scratch, "outside");
fs.mkdirSync(outsideDir, { recursive: true });

function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

try {
  // ===== (A) every allowed root is accepted, including a multi-repo repos[] entry =====
  {
    const roots = attachmentAllowedRoots(project);
    check("(A0) attachmentAllowedRoots returns 5 roots (repo/worktrees/workdir/vault/one repos[] entry)", roots.length === 5);
    const inRepo = writeFile(repoRoot, "a.txt", "repo file");
    const worktreeTaskDir = path.join(worktreesRoot, "task1");
    fs.mkdirSync(worktreeTaskDir, { recursive: true });
    const inWorktrees = writeFile(worktreeTaskDir, "b.txt", "worktree file");
    const inWorkDir = writeFile(workDirRoot, "c.txt", "work dir file");
    const inVault = writeFile(vaultRoot, "d.txt", "vault file");
    const inExtraRepo = writeFile(extraRepoRoot, "e.txt", "extra repo file");
    const r1 = await resolveAttachmentPath(project, inRepo);
    const r2 = await resolveAttachmentPath(project, inWorktrees);
    const r3 = await resolveAttachmentPath(project, inWorkDir);
    const r4 = await resolveAttachmentPath(project, inVault);
    const r5 = await resolveAttachmentPath(project, inExtraRepo);
    check("(A1) a file under the repo root resolves OK", r1.ok === true);
    check("(A2) a file under the project's worker worktrees resolves OK", r2.ok === true);
    check("(A3) a file under the project's work dir resolves OK", r3.ok === true);
    check("(A4) a file under the project vault root resolves OK", r4.ok === true);
    check("(A5) a file under a multi-repo repos[] entry resolves OK", r5.ok === true);
  }

  // ===== (MIN7) an empty repoPath is never pushed as a root =====
  {
    const noRepoProject = { id: "attach-core-norepo", repoPath: "", vaultPath: "", repos: [] };
    const roots = attachmentAllowedRoots(noRepoProject);
    check("(MIN7) attachmentAllowedRoots never pushes a repo-root entry for an empty repoPath", !roots.some((r) => r.label.includes("repo root")));
  }

  // ===== (B) refusals =====
  {
    const inRepo = writeFile(repoRoot, "rel.txt", "x");
    const relative = path.relative(process.cwd(), inRepo);
    const rRelative = await resolveAttachmentPath(project, relative);
    check("(B1) a RELATIVE path is refused", rRelative.ok === false && /absolute/.test(rRelative.error));

    const outsideFile = writeFile(outsideDir, "secret.txt", "nope");
    const rOutside = await resolveAttachmentPath(project, outsideFile);
    check("(B2) a path outside every allowed root is refused", rOutside.ok === false && /outside every allowed root/.test(rOutside.error));

    const subDir = path.join(repoRoot, "a-subdirectory");
    fs.mkdirSync(subDir, { recursive: true });
    const rDir = await resolveAttachmentPath(project, subDir);
    check("(B3) an ordinary directory (not a root) is refused as a directory", rDir.ok === false && /directory/.test(rDir.error));

    const rMissing = await resolveAttachmentPath(project, path.join(repoRoot, "does-not-exist.txt"));
    check("(B4) a nonexistent path (inside an allowed root) is refused", rMissing.ok === false && /not found/.test(rMissing.error));

    // Junction escape: a reparse point INSIDE the allowed repo root whose real target is OUTSIDE every
    // root. No elevated privilege needed — a directory junction/symlink is createable unprivileged on
    // every platform (unlike a file symlink).
    const junctionPath = path.join(repoRoot, "escape");
    let junctionOk = true;
    try {
      fs.symlinkSync(outsideDir, junctionPath, "junction");
    } catch (err) {
      junctionOk = false;
      console.log(`    (B5) SKIPPED — could not create a junction on this host: ${err.message}`);
    }
    if (junctionOk) {
      const viaJunction = path.join(junctionPath, "secret.txt");
      check("(B5) setup: the file is reachable through the junction", fs.existsSync(viaJunction));
      const rEscape = await resolveAttachmentPath(project, viaJunction);
      check("(B5) a path that LEXICALLY starts inside an allowed root but REAL-resolves outside (via a junction) is refused", rEscape.ok === false && /outside every allowed root/.test(rEscape.error));
    }
  }

  // ===== (MIN6) the root-equality refusal is REACHABLE, and fires BEFORE any filesystem existence/type
  // touch (Code Review: "remove the unreachable branch, or reorder so it's reachable — no dead guards") =====
  {
    const rRootItself = await resolveAttachmentPath(project, repoRoot);
    check("(MIN6) attaching a root's OWN path is refused as 'a root itself', not silently treated as a directory refusal", rRootItself.ok === false && /root itself/.test(rRootItself.error));
  }

  // ===== (MIN5) a junctioned root is matched by its CANONICAL form, both directions =====
  {
    const realJuncRepo = path.join(scratch, "junc-real-repo");
    const aliasJuncRepo = path.join(scratch, "junc-alias-repo");
    fs.mkdirSync(realJuncRepo, { recursive: true });
    let madeJunction = true;
    try {
      fs.symlinkSync(realJuncRepo, aliasJuncRepo, "junction");
    } catch (err) {
      madeJunction = false;
      console.log(`    (MIN5) SKIPPED — could not create a junction on this host: ${err.message}`);
    }
    if (madeJunction) {
      const fileInReal = writeFile(realJuncRepo, "f.txt", "x");
      // Direction 1: project.repoPath is the ALIAS (junction); the file is addressed via its REAL path —
      // the target's lexical form matches the root's CANONICAL key, so both the lexical pre-filter and
      // the precise check accept it.
      const projViaAlias = { id: "attach-core-junc1", repoPath: aliasJuncRepo, vaultPath: "", repos: [] };
      const r1 = await resolveAttachmentPath(projViaAlias, fileInReal);
      check("(MIN5-a) repoPath is a junction alias; the file is addressed via its REAL path — still matches", r1.ok === true);
      // Direction 2 (Code Review round 3, decision record "Narrowing accepted by this design"): repoPath
      // is the REAL path, but the file is addressed via a THIRD, unrelated alias nothing told the system
      // about. The lexical pre-filter only recognizes a root's OWN raw/canonical spellings — it does NOT
      // realpath the target just in case it happens to alias one — so this is correctly refused now,
      // never silently accepted. (Round 1/2 had this backwards; see the decision record.)
      const projViaReal = { id: "attach-core-junc2", repoPath: realJuncRepo, vaultPath: "", repos: [] };
      const fileViaAlias = path.join(aliasJuncRepo, "f.txt");
      const r2 = await resolveAttachmentPath(projViaReal, fileViaAlias);
      check("(MIN5-b) repoPath is the REAL path; a file addressed via an UNRELATED alias is refused (narrowed by design, not accepted)", r2.ok === false);
    }
  }

  // ===== (CRIT1) the structural LOOM_HOME refusal — RED using the REAL Platform-home binding shape,
  // GREEN for the Lead's own project work dir (a true LOOM_HOME sibling) =====
  {
    // Verify the sibling claim itself, in code — not just that attachment resolution happens to work.
    const loomHomeCanon = canonicalizeForContainment(LOOM_HOME);
    const worktreesCanon = canonicalizeForContainment(WORKTREES_DIR);
    const workRootCanon = canonicalizeForContainment(PROJECTS_WORK_ROOT);
    check("(CRIT1-sibling) setup: LOOM_HOME/WORKTREES_DIR/PROJECTS_WORK_ROOT all canonicalize cleanly", loomHomeCanon.ok && worktreesCanon.ok && workRootCanon.ok);
    if (loomHomeCanon.ok && worktreesCanon.ok && workRootCanon.ok) {
      const loomHomeKey = comparisonKey(loomHomeCanon.value);
      const worktreesKey = comparisonKey(worktreesCanon.value);
      const workRootKey = comparisonKey(workRootCanon.value);
      check("(CRIT1-sibling) WORKTREES_DIR is a true sibling of LOOM_HOME — NOT nested inside it", worktreesKey !== loomHomeKey && !isProperlyUnder(worktreesKey, loomHomeKey));
      check("(CRIT1-sibling) PROJECTS_WORK_ROOT is a true sibling of LOOM_HOME — NOT nested inside it", workRootKey !== loomHomeKey && !isProperlyUnder(workRootKey, loomHomeKey));
    }

    // RED: the REAL "Loom Platform" binding shape (platform/seed.ts): repoPath = vaultPath = LOOM_HOME.
    const platformProjId = "attach-core-platform-home";
    const platformProject = { id: platformProjId, repoPath: LOOM_HOME, vaultPath: LOOM_HOME, repos: [] };
    const secretLikeFile = path.join(LOOM_HOME, "secret.key"); // this test's OWN temp LOOM_HOME — never the real one
    fs.writeFileSync(secretLikeFile, "not-a-real-secret-just-a-test-fixture");
    const rSecret = await resolveAttachmentPath(platformProject, secretLikeFile);
    check("(CRIT1) RED: a Lead whose project binds repoPath=vaultPath=LOOM_HOME CANNOT attach a LOOM_HOME-rooted file (e.g. secret.key)", rSecret.ok === false && /LOOM_HOME/.test(rSecret.error));

    // Also covers the attachment STORE itself (no re-attaching a stored file via a second ask) — it's a
    // child of ATTACHMENTS_DIR, itself a child of LOOM_HOME, so the SAME check applies structurally.
    const fakeStoreDir = questionAttachmentDir("some-other-question");
    fs.mkdirSync(fakeStoreDir, { recursive: true });
    const storedLikeFile = writeFile(fakeStoreDir, "0-already-attached.png", "x");
    const rStore = await resolveAttachmentPath(platformProject, storedLikeFile);
    check("(CRIT1) RED: a file already inside the attachment store (LOOM_HOME-rooted) cannot be re-attached", rStore.ok === false && /LOOM_HOME/.test(rStore.error));

    // GREEN: the SAME Lead attaching a file from its OWN project work dir — a true LOOM_HOME sibling,
    // never refused by the LOOM_HOME check.
    const platformWorkDir = projectWorkDir(platformProjId);
    fs.mkdirSync(platformWorkDir, { recursive: true });
    const workDirFile = writeFile(platformWorkDir, "report.txt", "a real, legitimate attachment");
    const rWorkDirFile = await resolveAttachmentPath(platformProject, workDirFile);
    check("(CRIT1) GREEN: the same Lead CAN still attach a file from its own project work dir (outside LOOM_HOME)", rWorkDirFile.ok === true);

    // RED (Code Review round 3, item 4): an ORDINARY (non-platform) project whose work dir contains a
    // JUNCTION pointing INTO LOOM_HOME — canonicalizeForContainment follows the reparse point, so the
    // canonical target lands under LOOM_HOME and the structural refusal fires even though the junction's
    // OWN path is lexically inside an allowed, non-LOOM_HOME root.
    const ordinaryWorkDir = projectWorkDir(projId);
    const juncIntoLoomHome = path.join(ordinaryWorkDir, "junction-into-loom-home");
    let madeLoomHomeJunction = true;
    try {
      fs.symlinkSync(LOOM_HOME, juncIntoLoomHome, "junction");
    } catch (err) {
      madeLoomHomeJunction = false;
      console.log(`    (CRIT1-junction) SKIPPED — could not create a junction on this host: ${err.message}`);
    }
    if (madeLoomHomeJunction) {
      const viaJunctionToSecret = path.join(juncIntoLoomHome, "secret.key");
      check("(CRIT1-junction) setup: secret.key is reachable through the junction", fs.existsSync(viaJunctionToSecret));
      const rViaJunction = await resolveAttachmentPath(project, viaJunctionToSecret);
      check("(CRIT1-junction) a junction INSIDE an ordinary allowed root pointing INTO LOOM_HOME is refused", rViaJunction.ok === false && /LOOM_HOME/.test(rViaJunction.error));
      fs.rmSync(juncIntoLoomHome, { force: true });
    }
  }

  // ===== MAJOR (Code Review round 3): a hard link defeats realpath-based containment (realpath of a
  // hardlink is its OWN path, not the original's) — refused at resolve time via nlink>1 =====
  {
    const hardlinkTargetFile = path.join(LOOM_HOME, "secret.key");
    if (!fs.existsSync(hardlinkTargetFile)) fs.writeFileSync(hardlinkTargetFile, "not-a-real-secret-just-a-test-fixture");
    const hardlinkPath = path.join(repoRoot, "looks-like-a-normal-attachment.key");
    let hardlinkMade = true;
    try {
      fs.linkSync(hardlinkTargetFile, hardlinkPath);
    } catch (err) {
      hardlinkMade = false;
      console.log(`    (HARDLINK) SKIPPED — could not create a same-volume hardlink on this host: ${err.message}`);
    }
    if (hardlinkMade) {
      const rHardlink = await resolveAttachmentPath(project, hardlinkPath);
      check("(HARDLINK) a hard-linked file (even one whose OWN path is inside an allowed, non-LOOM_HOME root) is refused", rHardlink.ok === false && /hard-linked/.test(rHardlink.error));
      fs.rmSync(hardlinkPath, { force: true });
    }
  }

  // ===== (CRIT2) a UNC path is refused WITHOUT any fs call ever seeing the raw string; a nonexistent
  // path outside the roots gives the SAME refusal as an existing one (no existence oracle) =====
  {
    const uncPath = "\\\\127.0.0.1\\c$\\Windows\\win.ini";
    const seenArgs = [];
    const spy = (obj, key) => {
      const orig = obj[key];
      obj[key] = (...args) => {
        seenArgs.push(args);
        return orig.apply(obj, args);
      };
      return () => { obj[key] = orig; };
    };
    const nativeOrig = fs.realpathSync.native;
    const unspies = [
      spy(fs, "statSync"), spy(fs, "realpathSync"), spy(fs, "openSync"),
      spy(fsp, "stat"), spy(fsp, "open"),
    ];
    fs.realpathSync.native = (...args) => { seenArgs.push(args); return nativeOrig(...args); };
    let rUnc;
    try {
      rUnc = await resolveAttachmentPath(project, uncPath);
    } finally {
      for (const un of unspies) un();
      fs.realpathSync.native = nativeOrig;
    }
    check("(CRIT2) a UNC path is refused", rUnc.ok === false);
    check("(CRIT2) NO fs call anywhere ever received the raw UNC string as an argument", !seenArgs.some((args) => args.includes(uncPath)));

    // MINOR (Code Review round 3, item 3): an ORDINARY (non-UNC) absolute path that is lexically outside
    // every allowed root — the "mapped drive / NFS / autofs" concern, generalized portably (a hardcoded
    // Windows drive letter wouldn't even reach this code path on POSIX, since path.isAbsolute("Z:\\...")
    // is false there) — must ALSO make zero fs calls: the LEXICAL pre-filter rejects it before
    // `canonicalizeForContainment` (and its synchronous realpath) is ever reached.
    const lexicallyOutsidePath = path.join(outsideDir, "lexically-outside-probe.txt");
    fs.writeFileSync(lexicallyOutsidePath, "x");
    const seenArgs2 = [];
    const spy2 = (obj, key) => {
      const orig = obj[key];
      obj[key] = (...args) => { seenArgs2.push(args); return orig.apply(obj, args); };
      return () => { obj[key] = orig; };
    };
    const nativeOrig2 = fs.realpathSync.native;
    const unspies2 = [spy2(fs, "statSync"), spy2(fs, "realpathSync"), spy2(fs, "openSync"), spy2(fsp, "stat"), spy2(fsp, "open")];
    fs.realpathSync.native = (...args) => { seenArgs2.push(args); return nativeOrig2(...args); };
    let rLexOutside;
    try {
      rLexOutside = await resolveAttachmentPath(project, lexicallyOutsidePath);
    } finally {
      for (const un of unspies2) un();
      fs.realpathSync.native = nativeOrig2;
    }
    check("(CRIT2-lexical) an ordinary out-of-root absolute path is refused", rLexOutside.ok === false);
    check("(CRIT2-lexical) NO fs call anywhere ever received that out-of-root path — the lexical pre-filter rejected it before any realpath", !seenArgs2.some((args) => args.includes(lexicallyOutsidePath)));

    // Existence-oracle parity: an existing-but-outside-root file and a nonexistent-and-outside-root path
    // must produce the IDENTICAL refusal — existence is never checked until AFTER containment passes.
    const existingOutside = writeFile(outsideDir, "exists-outside.txt", "x");
    const missingOutside = path.join(outsideDir, "does-not-exist-outside.txt");
    const rExistingOutside = await resolveAttachmentPath(project, existingOutside);
    const rMissingOutside = await resolveAttachmentPath(project, missingOutside);
    check("(CRIT2) an EXISTING path outside every root is refused as 'outside', not probed for type", rExistingOutside.ok === false && /outside every allowed root/.test(rExistingOutside.error));
    check("(CRIT2) a MISSING path outside every root gets the IDENTICAL refusal shape — no existence oracle", rMissingOutside.ok === false && /outside every allowed root/.test(rMissingOutside.error));
  }

  // ===== (MAJ3) non-regular files: isAcceptableAttachmentStat unit-tested with a fake stat (every
  // platform), plus a REAL FIFO integration test (POSIX-only — SKIPs on win32) =====
  {
    check("(MAJ3-unit) isAcceptableAttachmentStat accepts a fake stat reporting isFile():true", isAcceptableAttachmentStat({ isFile: () => true }) === true);
    check("(MAJ3-unit) isAcceptableAttachmentStat rejects a fake stat reporting isFile():false (e.g. a FIFO/socket/device)", isAcceptableAttachmentStat({ isFile: () => false }) === false);

    if (process.platform === "win32") {
      console.log("    (MAJ3-fifo) SKIP — win32 has no mkfifo; the FIFO-open-blocks hazard doesn't exist there.");
    } else {
      const fifoPath = path.join(repoRoot, "a-fifo");
      let fifoMade = true;
      try {
        execSync(`mkfifo "${fifoPath}"`);
      } catch (err) {
        fifoMade = false;
        console.log(`    (MAJ3-fifo) SKIP — could not mkfifo on this host: ${err.message}`);
      }
      if (fifoMade) {
        const rFifo = await Promise.race([
          resolveAttachmentPath(project, fifoPath),
          new Promise((_, reject) => setTimeout(() => reject(new Error("resolveAttachmentPath on a FIFO did not return within 5s — it blocked")), 5000)),
        ]);
        check("(MAJ3-fifo) a FIFO is refused as 'not a regular file', and resolveAttachmentPath returns promptly (never blocks on it)", rFifo.ok === false && /not a regular file/.test(rFifo.error));
      }
    }
  }

  // ===== (C) kind + dimension derivation, from the file's own bytes =====
  {
    check("(C1) .png -> image", deriveAttachmentKind("/x/y.png") === "image");
    check("(C2) .PNG (case-insensitive) -> image", deriveAttachmentKind("/x/y.PNG") === "image");
    check("(C3) .jpg -> image", deriveAttachmentKind("/x/y.jpg") === "image");
    check("(C4) .html -> html", deriveAttachmentKind("/x/y.html") === "html");
    check("(C5) .pdf -> other", deriveAttachmentKind("/x/y.pdf") === "other");

    // A minimal, valid 8x4 PNG header: signature + IHDR chunk carrying width=8, height=4 at the fixed
    // offsets readPngDimensions reads (16/20) — the rest of a real PNG (CRC, IDAT, ...) is irrelevant to
    // a header-only probe.
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8); // IHDR length
    Buffer.from("IHDR", "ascii").copy(png, 12);
    png.writeUInt32BE(8, 16); // width
    png.writeUInt32BE(4, 20); // height
    const pngPath = writeFile(scratch, "dim.png", png);
    const pngDims = cheapImageDimensions(pngPath, "image");
    check("(C6) a PNG's width/height are read from its header", pngDims && pngDims.width === 8 && pngDims.height === 4);

    // A minimal JPEG: SOI, then one SOF0 (0xC0) segment carrying height=6/width=9 at the fixed offsets
    // readJpegDimensions reads (+5/+7 from the marker).
    const jpeg = Buffer.from([
      0xff, 0xd8, // SOI
      0xff, 0xc0, 0x00, 0x0b, // SOF0, length 11
      0x08, // precision
      0x00, 0x06, // height = 6
      0x00, 0x09, // width = 9
      0x01, 0x11, 0x00, // one component
    ]);
    const jpegPath = writeFile(scratch, "dim.jpg", jpeg);
    const jpegDims = cheapImageDimensions(jpegPath, "image");
    check("(C7) a JPEG's width/height are read from its first SOF segment", jpegDims && jpegDims.width === 9 && jpegDims.height === 6);

    const notAnImage = writeFile(scratch, "dim-bad.png", "not actually a png");
    check("(C8) a corrupt/unrecognized header returns null, never throws", cheapImageDimensions(notAnImage, "image") === null);
    check("(C9) a non-image kind always returns null", cheapImageDimensions(pngPath, "other") === null);
  }

  // ===== (D) copyAttachmentWithCap: TOCTOU-safe — enforced on bytes transferred, not a pre-copy stat;
  // and (Code Review round 3) re-validates file identity on its OWN re-open, never trusting the caller =====
  {
    // HANDLE-based stat, not a path-based fs.statSync — measured on this host, `dev` is NOT comparable
    // between the two (a path-based stat can report dev:0 while a handle-based fstat on the SAME file
    // reports the real volume serial), and the real resolveAttachmentPath/copyAttachmentWithCap pipeline
    // ALWAYS uses a handle-based stat on both ends — this helper must match that, or it's testing a
    // mismatch this test itself introduced, not a real one.
    const identityOf = async (p) => {
      const handle = await fsp.open(p, "r");
      try {
        const st = await handle.stat();
        return { dev: st.dev, ino: st.ino };
      } finally {
        await handle.close();
      }
    };

    const capBytes = 10;
    const small = writeFile(scratch, "small.bin", Buffer.alloc(5, 1));
    const dest1 = path.join(scratch, "small.copy");
    const okResult = await copyAttachmentWithCap(small, dest1, capBytes, await identityOf(small));
    check("(D1) a file under the cap copies cleanly", okResult.ok === true && okResult.bytes === 5);

    const big = writeFile(scratch, "big.bin", Buffer.alloc(20, 2));
    const dest2 = path.join(scratch, "big.copy");
    const bigResult = await copyAttachmentWithCap(big, dest2, capBytes, await identityOf(big));
    check("(D2) a file already over the cap is refused", bigResult.ok === false && bigResult.error === "too-large");

    // TOCTOU: the source starts at 5 bytes (genuinely under the 10-byte cap), but grows to 15 bytes
    // DURING the copy via the test-only onChunk hook — a pre-copy stat would have said "fine" at 5, but
    // the function must refuse once the bytes it actually transferred exceed the cap. Growing the SAME
    // inode in place (append) never changes its dev/ino, so the identity check is a non-issue here —
    // it's the byte-cap enforcement this sub-case targets, not identity (see (SWAP) below for that).
    const growing = writeFile(scratch, "growing.bin", Buffer.alloc(5, 3));
    const dest3 = path.join(scratch, "growing.copy");
    let grew = false;
    const growResult = await copyAttachmentWithCap(growing, dest3, capBytes, await identityOf(growing), () => {
      if (!grew) {
        grew = true;
        fs.appendFileSync(growing, Buffer.alloc(10, 4));
      }
    });
    check("(D3) setup: the growth hook actually ran", grew);
    check("(D3) TOCTOU: a source that GROWS past the cap during the copy is refused — never trusted an upfront size", growResult.ok === false && growResult.error === "too-large");

    // (D4) identity mismatch: re-opening a DIFFERENT file than the one resolve-time validated (wrong
    // dev/ino passed deliberately here) is refused outright, before any byte is read or any dest file
    // is created — the exact guarantee copyAttachmentWithCap now provides independently of its caller.
    const identityMismatchSrc = writeFile(scratch, "identity-mismatch.bin", "hello");
    const dest4 = path.join(scratch, "identity-mismatch.copy");
    const mismatchResult = await copyAttachmentWithCap(identityMismatchSrc, dest4, 1_000_000, { dev: 999999, ino: 999999 });
    check("(D4) a deliberately WRONG expected identity refuses with 'file changed after validation'", mismatchResult.ok === false && /file changed after validation/.test(mismatchResult.error));
    check("(D4) no destination file was left behind on an identity-mismatch refusal", !fs.existsSync(dest4));
  }

  // ===== (E) prepareQuestionAttachments: resolve-all-first, count cap, cleanup on a mid-copy failure =====
  {
    const qId1 = "attach-core-q1";
    const good1 = writeFile(repoRoot, "good1.txt", "ok");
    const bad = path.join(repoRoot, "nonexistent-for-e.txt");
    const resultMixed = await prepareQuestionAttachments(project, qId1, [{ path: good1 }, { path: bad }], { maxBytes: 1_000_000, maxCount: 10 });
    check("(E1) one bad path among several refuses the WHOLE call", resultMixed.ok === false);
    check("(E2) nothing was copied — the store dir was never created", !fs.existsSync(questionAttachmentDir(qId1)));

    const qId2 = "attach-core-q2";
    const manyInputs = Array.from({ length: 11 }, (_, i) => ({ path: writeFile(repoRoot, `many-${i}.txt`, "x") }));
    const resultCount = await prepareQuestionAttachments(project, qId2, manyInputs, { maxBytes: 1_000_000, maxCount: 10 });
    check("(E3) exceeding the per-request count cap refuses before resolving anything", resultCount.ok === false && /cap of 10/.test(resultCount.error));
    check("(E4) nothing was copied for the over-count request either", !fs.existsSync(questionAttachmentDir(qId2)));

    const qId3 = "attach-core-q3";
    const smallOk = writeFile(repoRoot, "e-ok.txt", Buffer.alloc(3));
    const tooBig = writeFile(repoRoot, "e-toobig.txt", Buffer.alloc(50));
    const resultFail = await prepareQuestionAttachments(project, qId3, [{ path: smallOk }, { path: tooBig }], { maxBytes: 10, maxCount: 10 });
    check("(E5) a mid-sequence cap failure refuses the whole call", resultFail.ok === false && /attachments\[1\]/.test(resultFail.error));
    check("(E6) the WHOLE store dir (including the first, already-copied attachment) is removed on failure", !fs.existsSync(questionAttachmentDir(qId3)));

    const qId4 = "attach-core-q4";
    const f1 = writeFile(repoRoot, "e4-one.txt", Buffer.alloc(4));
    const f2 = writeFile(repoRoot, "e4-two.png", (() => {
      const b = Buffer.alloc(24);
      Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(b, 0);
      b.writeUInt32BE(2, 16);
      b.writeUInt32BE(3, 20);
      return b;
    })());
    const resultOk = await prepareQuestionAttachments(project, qId4, [{ path: f1, label: "First" }, { path: f2 }], { maxBytes: 1_000_000, maxCount: 10 });
    check("(E7) a fully-valid request succeeds", resultOk.ok === true && resultOk.attachments.length === 2);
    if (resultOk.ok) {
      const [a0, a1] = resultOk.attachments;
      check("(E8) attachment ids are stable, index-based strings", a0.id === "0" && a1.id === "1");
      check("(E9) an explicit label is honored", a0.label === "First");
      check("(E10) an omitted label falls back to the source basename", a1.label === "e4-two.png");
      check("(E11) sizeBytes matches the bytes actually copied", a0.sizeBytes === 4);
      check("(E12) kind is derived from the extension", a1.kind === "image");
      check("(E13) image dimensions are populated for an image", a1.imageDimensions && a1.imageDimensions.width === 2 && a1.imageDimensions.height === 3);
      check("(E14) a non-image attachment has null imageDimensions", a0.imageDimensions === null);
      check("(E15) the INTERNAL shape carries the original absolute path (never exposed by toQuestion — see attachment-migration.mjs)", a0.originalPath === f1);
      check("(E16) the copied file actually exists in the store under its storedFilename", fs.existsSync(path.join(questionAttachmentDir(qId4), a0.storedFilename)));
      check("(E17) openedAt starts null (the serving route doesn't exist yet)", a0.openedAt === null);
    }

    // ===== (SWAP) Code Review round 3, item 2: a file swapped (rename-in) between resolve and copy is
    // refused — driven DETERMINISTICALLY via prepareQuestionAttachments's test-only beforeCopy hook,
    // never real concurrency/sleep. attachment[0] resolves+copies normally; attachment[1] is swapped for
    // a DIFFERENT file (a different inode) the instant before ITS OWN copy begins — simulating exactly
    // the "attachment[1] changed while attachment[0] was still copying" window Code Review identified. =====
    const qIdSwap = "attach-core-swap";
    const swapKeep = writeFile(repoRoot, "swap-keep.txt", "unchanged");
    const swapTarget = writeFile(repoRoot, "swap-target.txt", "original-content");
    const swapResult = await prepareQuestionAttachments(
      project, qIdSwap, [{ path: swapKeep }, { path: swapTarget }],
      { maxBytes: 1_000_000, maxCount: 10 },
      {
        beforeCopy: (i) => {
          if (i === 1) {
            const replacement = path.join(scratch, "swap-replacement.txt");
            fs.writeFileSync(replacement, "REPLACED-DIFFERENT-INODE");
            fs.rmSync(swapTarget, { force: true });
            fs.renameSync(replacement, swapTarget); // same PATH, a genuinely DIFFERENT inode
          }
        },
      },
    );
    check("(SWAP) a file swapped for a different inode between resolve and its own copy is refused", swapResult.ok === false && /file changed after validation/.test(swapResult.error));
    check("(SWAP) nothing partial (incl. the FIRST, already-valid attachment) survives — the whole store dir is removed", !fs.existsSync(questionAttachmentDir(qIdSwap)));

    // ===== (MIN4) sanitizeBasename strips win32-illegal/ADS characters — unit-tested directly (a pure
    // string function), so the exact reviewer probe ("in.txt:ads") is reproducible on every platform
    // without depending on whether this host's filesystem even permits a colon in a filename =====
    check("(MIN4) a colon (the NTFS alternate-data-stream separator) is stripped", sanitizeBasename("in.txt:ads") === "in.txt_ads");
    check("(MIN4) every other win32-illegal character is stripped too", sanitizeBasename('a<b>c"d|e?f*g') === "a_b_c_d_e_f_g");
    check("(MIN4) control characters are stripped", sanitizeBasename("a\x00b\x1fc") === "a_b_c");
    check("(MIN4) path separators are still stripped (pre-existing behavior, unchanged)", sanitizeBasename("a/b\\c") === "a_b_c");
    check("(MIN4) leading dots are still stripped (pre-existing behavior, unchanged)", sanitizeBasename("...hidden.txt") === "hidden.txt");
    check("(MIN4) a colon-only name does NOT collapse to empty (replace, not remove) — illegal chars become underscores", sanitizeBasename("::::") === "____");
    check("(MIN4) a name that fully disappears after cleanup (all leading dots) falls back to a fixed placeholder, never an empty string", sanitizeBasename("...") === "attachment");
    check("(MIN4) a literal empty name falls back to the same placeholder", sanitizeBasename("") === "attachment");
  }

  // ===== (MIN9) the `attachments` zod shape bounds path/label length =====
  {
    const schema = z.object({ attachments: QUESTION_ASK_INPUT_SHAPE.attachments });
    const tooLongPath = "/" + "a".repeat(5000);
    const rLongPath = schema.safeParse({ attachments: [{ path: tooLongPath }] });
    check("(MIN9) a path over 4096 chars is rejected by the schema", rLongPath.success === false);
    const tooLongLabel = "a".repeat(500);
    const rLongLabel = schema.safeParse({ attachments: [{ path: "/ok/path.png", label: tooLongLabel }] });
    check("(MIN9) a label over 200 chars is rejected by the schema", rLongLabel.success === false);
    const rOk = schema.safeParse({ attachments: [{ path: "/ok/path.png", label: "fine" }] });
    check("(MIN9) CONTROL: an ordinary path/label still validates", rOk.success === true);
  }
} finally {
  cleanupPathSync(tmpHome);
  cleanupPathSync(scratch);
  // WORKTREES_DIR/PROJECTS_WORK_ROOT are deliberately SIBLINGS of LOOM_HOME (card 5eace211/sha:e1c6ef65),
  // not nested inside it — cleanupPathSync(tmpHome) never reaches them. Both are uniquely named off this
  // run's tmpHome timestamp+pid, so removing them wholesale here is safe (nothing else uses that name).
  try { fs.rmSync(WORKTREES_DIR, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  try { fs.rmSync(PROJECTS_WORK_ROOT, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — attachment path resolution (all roots + refusals incl. LOOM_HOME/UNC/lexical-out-of-root/FIFO/junction/hardlink/resolve-then-copy-swap), kind/dimension derivation, the TOCTOU-safe copy cap with identity re-validation, basename sanitization, schema bounds, and prepareQuestionAttachments's atomicity all hold."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
