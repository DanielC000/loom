import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure git + bounded.ts
// CARD 3a5c5d4a — a worker-plantable `.git/commondir` must never redirect a canonical git call's
// objects/refs/config away from the trusted repo. Investigated empirically on scratch repos (not here —
// see docs/decisions/3a5c5d4a-canonical-git-commondir-trust.md for the measured hijack table); this file
// proves the FIX: `checkCommondirTrust` (git/bounded.ts), wired into `canonicalRaw` — the ONE chokepoint
// shared by `canonicalGit` and `killableCanonicalRaw` (via `spawnCanonicalGitTree`) — before ANY git
// process, including the merge-driver enumeration.
//
// Scenarios: (1) a DIRECTORY `.git` carrying its own `commondir` file, absolute AND relative path →
// refused, nothing spawned (proven via a spy spawnImpl, not inference). (2) a rewritten LINKED WORKTREE
// commondir pointer → refused. (3) a gitdir pointer that resolves OUTSIDE the trusted main's own
// `.git/worktrees/` → refused, even when the commondir VALUE it carries is otherwise correct. (4) a REAL
// `git worktree add` worktree, untouched → ALLOWED (control — a fix here must never break a real
// worktree). (5) an unplanted main checkout → ALLOWED (control). Every scenario runs through BOTH
// `canonicalGit` and `killableCanonicalRaw`.
//
// Run: 1) pnpm build, 2) node packages/daemon/test/canonical-git-commondir-refusal.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { useOwnLoomHome, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

useOwnLoomHome("loom-cgcr-home-");

const { canonicalGit, killableCanonicalRaw, canonicalRaw, spawnCanonicalGitTree, checkCommondirTrust, CanonicalGitRefusal, CanonicalGitCommondirRefusal, CanonicalGitBoundWorktreeRefusal, CanonicalGitUnpinnedRefusal, CanonicalGitPinMismatchRefusal, describeGitFailure, canonicalFailureMessage, resolveGitIdentityFallbackArgs, resolveTrustedToplevel, defaultTrustedMainRoot, registerCommondirTrustPinLookup, prepareCanonicalEnv } = await import("../dist/git/bounded.js");
const { literalRepoPathKey } = await import("../dist/git/repo-lock.js");

// @decision 3a5c5d4a (round 5) — the ONE in-process pin store every test below shares, backing the SAME
// registration production wires at boot. `pinFor` mirrors `Db.pinCommondirTrust`: walk `repoPath` via
// `resolveTrustedToplevel` (a trusted moment, as if at project bind time) and record the result; tests
// that need to simulate tampering AFTER pinning mutate the filesystem, never the pin map directly.
const pinMap = new Map();
registerCommondirTrustPinLookup((repoPath) => pinMap.get(literalRepoPathKey(repoPath)) ?? null);
function pinFor(repoPath, projectId = "cgcr-test-project", repoKey = "primary") {
  const toplevel = resolveTrustedToplevel(repoPath);
  if (!toplevel.ok) throw new Error(`pinFor(${repoPath}): resolveTrustedToplevel failed: ${toplevel.reason}`);
  pinMap.set(literalRepoPathKey(repoPath), { toplevel: toplevel.toplevel, pinnedAt: new Date().toISOString(), source: "bind", projectId, repoKey });
  return toplevel.toplevel;
}
function unpinFor(repoPath) { pinMap.delete(literalRepoPathKey(repoPath)); }

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), `loom-cgcr-${sfx}-`));
registerForCleanup(SCRATCH);
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=cgcr@loom -c user.name=cgcr";

function initRepo(name) {
  const dir = path.join(SCRATCH, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init -q");
  fs.writeFileSync(path.join(dir, "f.txt"), `${name}-content\n`);
  git(dir, `add f.txt`);
  git(dir, `${GIT_ID} commit -q -m "${name}: initial commit"`);
  return dir;
}

// ── Fixtures: A (the trusted main checkout) and B (an unrelated decoy with different history/config).
const A = initRepo("A");
const B = initRepo("B");
git(B, `config loom.cgcr.testkey "FROM-B-DECOY"`);
const aHeadBaseline = git(A, "rev-parse HEAD");
const bHead = git(B, "rev-parse HEAD");
check("(fixture) A and B really do have different HEADs", aHeadBaseline !== bHead);

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (1) DIRECTORY `.git` + its own `commondir` file — the shape resolveGitDirsSync's own blind spot misses.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const commondirFile = path.join(A, ".git", "commondir");

  // (1a) ABSOLUTE path plant.
  fs.writeFileSync(commondirFile, path.join(B, ".git") + "\n");
  const absCheck = checkCommondirTrust(A, A);
  check("(1a) checkCommondirTrust refuses a DIRECTORY .git carrying its own commondir file (absolute path)", absCheck.ok === false && /commondir/i.test(absCheck.reason));

  let absGitErr = null;
  try { await canonicalGit(A, 5_000).raw(["rev-parse", "HEAD"]); } catch (e) { absGitErr = e; }
  check("(1a) canonicalGit.raw() refuses with CanonicalGitCommondirRefusal (absolute plant)", absGitErr instanceof CanonicalGitCommondirRefusal);
  check("(1a) …and it IS a CanonicalGitRefusal too (describeGitFailure.refusal stays true)", describeGitFailure(absGitErr).refusal === true && describeGitFailure(absGitErr).commondirRedirect === true);

  // killableCanonicalRaw entry point, black-box.
  let absKillErr = null;
  try { await killableCanonicalRaw(A, ["rev-parse", "HEAD"], 5_000, "rev-parse (commondir test)"); } catch (e) { absKillErr = e; }
  check("(1a) killableCanonicalRaw also refuses with CanonicalGitCommondirRefusal (absolute plant)", absKillErr instanceof CanonicalGitCommondirRefusal);

  // Spy-based proof that NOTHING actually spawned: mirrors killableCanonicalRaw's own internal
  // construction (spawnCanonicalGitTree -> canonicalRaw), but with an instrumented spawnImpl.
  let spawnCount = 0;
  const realSpawn = (await import("node:child_process")).spawn;
  const spyImpl = (...args) => { spawnCount++; return realSpawn(...args); };
  const controller = new AbortController();
  let spyErr = null;
  try {
    await canonicalRaw(spawnCanonicalGitTree(A, undefined, controller.signal, 5_000, undefined, spyImpl), ["rev-parse", "HEAD"], A, A);
  } catch (e) { spyErr = e; }
  check("(1a) PROOF nothing spawned: a counting spawnImpl handed to spawnCanonicalGitTree sees ZERO calls", spawnCount === 0);
  check("(1a) …and the SAME call still refuses correctly", spyErr instanceof CanonicalGitCommondirRefusal);

  // (1b) RELATIVE path plant (A and B are siblings under SCRATCH: ../B/.git from A/.git).
  const relTarget = path.relative(path.join(A, ".git"), path.join(B, ".git"));
  fs.writeFileSync(commondirFile, `${relTarget}\n`);
  const relCheck = checkCommondirTrust(A, A);
  check("(1b) checkCommondirTrust ALSO refuses a relative-path commondir plant", relCheck.ok === false);
  let relGitErr = null;
  try { await canonicalGit(A, 5_000).raw(["rev-parse", "HEAD"]); } catch (e) { relGitErr = e; }
  check("(1b) canonicalGit.raw() refuses it too (relative plant)", relGitErr instanceof CanonicalGitCommondirRefusal);

  fs.rmSync(commondirFile, { force: true });
  check("(1) cleanup: with the plant removed, checkCommondirTrust allows A again", checkCommondirTrust(A, A).ok === true);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (2) + (4) a REAL linked worktree: untouched → ALLOWED (control); its OWN existing commondir pointer
// rewritten to the decoy → refused. Proves the fix doesn't break real worktrees AND closes the
// "rewrite my own worktree's legitimate pointer" vector (broader than the DIRECTORY-shape case alone).
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const W = path.join(SCRATCH, "A-worktree-1");
  git(A, `worktree add -q "${W}" -b cgcr-wt1-branch`);
  registerForCleanup(W);

  // (4) Control: a real, untouched worktree is ALLOWED when the real main is supplied as trustedMainRoot.
  const wtGitPath = fs.readFileSync(path.join(W, ".git"), "utf8");
  const privateDirMatch = wtGitPath.match(/^gitdir:\s*(.+?)\s*$/m);
  const privateDir = path.resolve(W, privateDirMatch[1]);
  const wtCommondirFile = path.join(privateDir, "commondir");
  const realCommondirContent = fs.readFileSync(wtCommondirFile, "utf8");

  check("(4) control: checkCommondirTrust ALLOWS a real, untouched linked worktree", checkCommondirTrust(W, A).ok === true);
  let allowedHead = null, allowedErr = null;
  try { allowedHead = (await canonicalGit(W, 5_000, undefined, undefined, undefined, A).raw(["rev-parse", "HEAD"])).trim(); } catch (e) { allowedErr = e; }
  check("(4) control: canonicalGit against a real worktree, with the real main as trustedMainRoot, SUCCEEDS", allowedErr === null && allowedHead === aHeadBaseline);
  let allowedKillOut = null, allowedKillErr = null;
  try { allowedKillOut = (await killableCanonicalRaw(W, ["rev-parse", "HEAD"], 5_000, "rev-parse (wt control)", undefined, undefined, undefined, A, undefined, A)).trim(); } catch (e) { allowedKillErr = e; }
  check("(4) control: killableCanonicalRaw against the SAME real worktree also SUCCEEDS", allowedKillErr === null && allowedKillOut === aHeadBaseline);

  // (2) Rewrite the worktree's own EXISTING, legitimate commondir pointer to the decoy.
  fs.writeFileSync(wtCommondirFile, path.join(B, ".git") + "\n");
  check("(2) checkCommondirTrust refuses a rewritten worktree commondir pointer (now pointing at the decoy)", checkCommondirTrust(W, A).ok === false);
  let rewrittenErr = null;
  try { await canonicalGit(W, 5_000, undefined, undefined, undefined, A).raw(["rev-parse", "HEAD"]); } catch (e) { rewrittenErr = e; }
  check("(2) canonicalGit refuses it (rewritten worktree commondir)", rewrittenErr instanceof CanonicalGitCommondirRefusal);
  let rewrittenKillErr = null;
  try { await killableCanonicalRaw(W, ["rev-parse", "HEAD"], 5_000, "rev-parse (wt rewritten)", undefined, undefined, undefined, A, undefined, A); } catch (e) { rewrittenKillErr = e; }
  check("(2) killableCanonicalRaw refuses it too (rewritten worktree commondir)", rewrittenKillErr instanceof CanonicalGitCommondirRefusal);

  // restore the real pointer so the worktree stays valid for anything else (and for symmetry/hygiene).
  fs.writeFileSync(wtCommondirFile, realCommondirContent);
  check("(2) restored: checkCommondirTrust allows the worktree again once its real pointer is restored", checkCommondirTrust(W, A).ok === true);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (3) a gitdir pointer resolving OUTSIDE the trusted main's own `.git/worktrees/` — refused even when the
// commondir VALUE it carries is otherwise byte-correct (the "forged private dir" vector: closes a bypass
// where a correct commondir alone would let HEAD/the private dir be forged from somewhere else entirely).
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const fakeWt = path.join(SCRATCH, "fake-worktree");
  const fakePrivateDir = path.join(SCRATCH, "fake-private-dir-not-under-worktrees");
  fs.mkdirSync(fakeWt, { recursive: true });
  fs.mkdirSync(fakePrivateDir, { recursive: true });
  fs.writeFileSync(path.join(fakeWt, ".git"), `gitdir: ${fakePrivateDir}\n`);
  // The commondir VALUE is otherwise CORRECT — points straight at the real trusted main's own .git.
  fs.writeFileSync(path.join(fakePrivateDir, "commondir"), path.join(A, ".git") + "\n");

  const outsideCheck = checkCommondirTrust(fakeWt, A);
  check("(3) checkCommondirTrust refuses a gitdir pointer OUTSIDE <trusted>/.git/worktrees/, even with a correct commondir value", outsideCheck.ok === false && /worktrees/i.test(outsideCheck.reason));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (5) Control: an unplanted main checkout is ALLOWED — the DIRECTORY-shape check alone must never
// false-refuse the ordinary case.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  check("(5) control: checkCommondirTrust allows an ordinary, unplanted main checkout", checkCommondirTrust(A, A).ok === true);
  check("(5) control: checkCommondirTrust allows it even with no trustedMainRoot at all (DIRECTORY-shape check needs none)", checkCommondirTrust(A, undefined).ok === true);
  const out = (await canonicalGit(A, 5_000).raw(["rev-parse", "HEAD"])).trim();
  check("(5) control: canonicalGit against the unplanted main still works end to end", out === aHeadBaseline);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (6) Code Review round 2, B1 — STRICT FILE-shape parsing. `privateDir6` is a freshly-built (never a real
// `git worktree add`) directory sitting directly under A's own trusted `.git/worktrees/`, with a correct
// `commondir`; `fakeWt6`'s own `.git` pointer file (also freshly-built, never git-created) is what we
// rewrite across malformed shapes. Deliberately NEVER rewrites a REAL git-worktree's own `.git` file —
// measured directly on this host that a real `git worktree add`-created `.git` pointer file refuses a
// second `fs.writeFileSync` with EPERM (environment-specific write protection on git-authored worktree
// metadata — unrelated to this card), while a freshly-created one of our own does not.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const privateDir6 = path.join(A, ".git", "worktrees", "cgcr-strict-parse-fake");
  fs.mkdirSync(privateDir6, { recursive: true });
  fs.writeFileSync(path.join(privateDir6, "commondir"), "../..\n");
  const fakeWt6 = path.join(SCRATCH, "fake-worktree-strict-parse");
  fs.mkdirSync(fakeWt6, { recursive: true });
  const fakeWt6GitFile = path.join(fakeWt6, ".git");
  const writePointer = (raw) => fs.writeFileSync(fakeWt6GitFile, raw);

  // Baseline: a correct, freshly-built pointer (real subdir of the trusted worktrees dir, correct
  // commondir) is allowed — so the malformed cases below are compared against a confirmed-good baseline.
  writePointer(`gitdir: ${privateDir6}\n`);
  check("(6) baseline: a correct, freshly-built gitdir pointer is allowed", checkCommondirTrust(fakeWt6, A).ok === true);

  // (6a) TRAILING WHITESPACE in the gitdir VALUE — the historical bypass shape: a loose regex
  // (`/^gitdir:\s*(.+?)\s*$/m`) silently TRIMS this, so the check would verify a path one byte shorter
  // than what git itself (which does NOT trim interior/trailing non-newline whitespace) actually resolves.
  writePointer(`gitdir: ${privateDir6} \n`);
  check("(6a) refuses a gitdir VALUE with trailing whitespace, rather than silently trimming it", checkCommondirTrust(fakeWt6, A).ok === false);

  // (6b) LEADING WHITESPACE before the path (after the "gitdir: " prefix).
  writePointer(`gitdir:  ${privateDir6}\n`);
  check("(6b) refuses a gitdir VALUE with leading whitespace (an extra space after the prefix)", checkCommondirTrust(fakeWt6, A).ok === false);

  // (6c) MULTI-LINE — a second line after the gitdir line (only ONE trailing line-ending is ever
  // stripped, so this leaves an embedded \n in the parsed value).
  writePointer(`gitdir: ${privateDir6}\nunexpected-second-line\n`);
  check("(6c) refuses a gitdir pointer carrying more than one line", checkCommondirTrust(fakeWt6, A).ok === false);

  // (6d) RELATIVE path value — git worktree add always writes an ABSOLUTE gitdir; a relative one is
  // refused outright rather than resolved against an assumed base.
  writePointer(`gitdir: ../some/relative/path\n`);
  check("(6d) refuses a RELATIVE gitdir pointer value", checkCommondirTrust(fakeWt6, A).ok === false);

  // (6e) EMPTY value.
  writePointer(`gitdir: \n`);
  check("(6e) refuses an EMPTY gitdir pointer value", checkCommondirTrust(fakeWt6, A).ok === false);

  // (6f) CRLF line ending on an otherwise well-formed pointer — git's own grammar strips a trailing \r
  // the same as a trailing \n; a CRLF-terminated (but otherwise correct) pointer must still be ALLOWED —
  // the strictness is about the VALUE's own whitespace, never about which line-ending terminates it.
  writePointer(`gitdir: ${privateDir6}\r\n`);
  check("(6f) ALLOWS an otherwise well-formed gitdir pointer terminated by CRLF (strips exactly one trailing line-ending, nothing more)", checkCommondirTrust(fakeWt6, A).ok === true);

  // (6g) not the "gitdir: " shape at byte 0 at all (leading garbage before the prefix) — not this check's
  // job; git itself will refuse to treat this as a valid gitfile, so no refusal is needed here either.
  writePointer(`not-gitdir: ${privateDir6}\n`);
  check("(6g) a pointer that doesn't start with the literal \"gitdir: \" at byte 0 is left to git itself (not a refusal)", checkCommondirTrust(fakeWt6, A).ok === true);

  writePointer(`gitdir: ${privateDir6}\n`);
  check("(6) cleanup: a correct pointer is allowed again", checkCommondirTrust(fakeWt6, A).ok === true);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (7) Code Review round 2, B1 — the trusted worktree-registry ENTRY itself must be a real directory, not a
// symlink/junction a worker could plant so the realpath match comes out true vacuously. Both the symlink
// entry and its pointing `.git` file are freshly built (never a real `git worktree add`), for the same
// EPERM reason documented at (6) above.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const decoyTarget7 = path.join(SCRATCH, "cgcr-symlink-decoy-target");
  fs.mkdirSync(decoyTarget7, { recursive: true });
  fs.writeFileSync(path.join(decoyTarget7, "commondir"), "../..\n"); // byte-correct — only the ENTRY shape (symlink) should be what's refused

  const privateDir7 = path.join(A, ".git", "worktrees", "cgcr-symlink-fake");
  let symlinkOk = true;
  try {
    fs.symlinkSync(decoyTarget7, privateDir7, process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    symlinkOk = false;
    console.log(`SKIP  (7) could not create a symlink/junction worktree-registry entry (${e.message}) — this host/user may lack the privilege`);
  }
  if (symlinkOk) {
    const fakeWt7 = path.join(SCRATCH, "fake-worktree-symlink-entry");
    fs.mkdirSync(fakeWt7, { recursive: true });
    fs.writeFileSync(path.join(fakeWt7, ".git"), `gitdir: ${privateDir7}\n`);
    const symlinkCheck = checkCommondirTrust(fakeWt7, A);
    check("(7) refuses when the trusted worktree-registry entry is itself a symlink/junction", symlinkCheck.ok === false);

    // Positive control: the SAME structure, but a REAL directory in place of the symlink, is allowed —
    // proves the refusal above is about the symlink shape, not some other accidental mismatch.
    fs.rmSync(privateDir7, { recursive: true, force: true });
    fs.mkdirSync(privateDir7, { recursive: true });
    fs.writeFileSync(path.join(privateDir7, "commondir"), "../..\n");
    check("(7) control: the SAME structure with a REAL directory (no symlink) is allowed", checkCommondirTrust(fakeWt7, A).ok === true);
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (8) POSIX-only, per Code Review round 2, B1: a literal trailing-SPACE directory name is a real,
// distinct, creatable entity on POSIX filesystems (not on Windows, where trailing space/dot path segments
// are rejected/stripped by the Win32 API) — the exact shape the OLD loose regex's trailing `\s*$` trim
// would have silently collapsed onto the real (space-free) entry while git itself resolved the raw,
// untrimmed value to this DIFFERENT, decoy directory. SKIPPED on win32; exercised by ubuntu CI.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
if (process.platform === "win32") {
  console.log("SKIP  (8) literal-trailing-space decoy worktree-dir case — Windows rejects/strips trailing-space path segments; exercised on POSIX (ubuntu CI) only");
} else {
  const W5 = path.join(SCRATCH, "A-worktree-5");
  git(A, `worktree add -q "${W5}" -b cgcr-wt5-branch`);
  registerForCleanup(W5);
  const pointer5 = fs.readFileSync(path.join(W5, ".git"), "utf8");
  const m5 = pointer5.match(/^gitdir:\s*(.+?)\s*$/m);
  const privateDir5 = path.resolve(W5, m5[1]);
  const trustedWorktreesDir5 = path.dirname(privateDir5);
  const decoySpaceDir = path.join(trustedWorktreesDir5, `${path.basename(privateDir5)} `); // real entry's name PLUS one trailing space — a DIFFERENT, real directory on POSIX
  fs.mkdirSync(decoySpaceDir, { recursive: true });
  fs.writeFileSync(path.join(decoySpaceDir, "commondir"), path.join(B, ".git") + "\n"); // decoy redirects to B

  const fakeWt5 = path.join(SCRATCH, "fake-worktree-trailing-space-decoy");
  fs.mkdirSync(fakeWt5, { recursive: true });
  fs.writeFileSync(path.join(fakeWt5, ".git"), `gitdir: ${decoySpaceDir}\n`); // the VALUE itself ends in a space (decoySpaceDir's own name does)

  const decoyCheck = checkCommondirTrust(fakeWt5, A);
  check("(8) POSIX: refuses a gitdir VALUE ending in whitespace that names a REAL, distinct decoy directory — never silently trimmed onto the legitimate same-named entry", decoyCheck.ok === false);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (9) Code Review round 2, S1 — the bound repo is itself a linked worktree (trustedMainRoot resolves to
// the SAME path as repoPath): a DISTINCT, honest refusal — CanonicalGitBoundWorktreeRefusal — never the
// commondir-redirect/escalate-to-the-Platform-Lead wording, which would misdescribe this case.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const W6 = path.join(SCRATCH, "A-worktree-6");
  git(A, `worktree add -q "${W6}" -b cgcr-wt6-branch`);
  registerForCleanup(W6);

  const selfCheck = checkCommondirTrust(W6, W6);
  check("(9) checkCommondirTrust refuses with kind:boundRepoIsWorktree when trustedMainRoot === repoPath", selfCheck.ok === false && selfCheck.kind === "boundRepoIsWorktree");

  let selfGitErr = null;
  try { await canonicalGit(W6, 5_000, undefined, undefined, undefined, W6).raw(["rev-parse", "HEAD"]); } catch (e) { selfGitErr = e; }
  check("(9) canonicalGit throws CanonicalGitBoundWorktreeRefusal, NOT CanonicalGitCommondirRefusal", selfGitErr instanceof CanonicalGitBoundWorktreeRefusal && !(selfGitErr instanceof CanonicalGitCommondirRefusal));
  check("(9) …and it IS a CanonicalGitRefusal too (describeGitFailure.refusal stays true)", describeGitFailure(selfGitErr).refusal === true && describeGitFailure(selfGitErr).boundRepoIsWorktree === true && describeGitFailure(selfGitErr).commondirRedirect === false);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (10) Code Review round 2, S2 — a FILE-shaped `.git` with NO trustedMainRoot at all now fails closed by
// DEFAULT (the pre-round-2 code returned ok:true here); `commondirCheck:"advisory-read"` restores the old
// permissive behavior for a reviewed, read-only call site only.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const W7 = path.join(SCRATCH, "A-worktree-7");
  git(A, `worktree add -q "${W7}" -b cgcr-wt7-branch`);
  registerForCleanup(W7);

  const noRootCheck = checkCommondirTrust(W7, undefined);
  check("(10) DEFAULT: a FILE-shaped .git with no trustedMainRoot at all now REFUSES (fail closed, was ok:true before round 2)", noRootCheck.ok === false && noRootCheck.kind === "redirect");

  const advisoryCheck = checkCommondirTrust(W7, undefined, { commondirCheck: "advisory-read" });
  check("(10) OPT-OUT: commondirCheck:\"advisory-read\" restores ok:true for a reviewed read-only call site", advisoryCheck.ok === true);

  let noRootGitErr = null;
  try { await canonicalGit(W7, 5_000).raw(["rev-parse", "HEAD"]); } catch (e) { noRootGitErr = e; }
  check("(10) canonicalGit with no trustedMainRoot and no opt-out now REFUSES end to end", noRootGitErr instanceof CanonicalGitCommondirRefusal);

  const advisoryOut = (await canonicalGit(W7, 5_000, undefined, undefined, undefined, undefined, { commondirCheck: "advisory-read" }).raw(["rev-parse", "HEAD"])).trim();
  check("(10) canonicalGit with the advisory-read opt-out still SUCCEEDS end to end", advisoryOut === aHeadBaseline);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (11) Code Review round 3, B2 — a REAL regression this card shipped: resolveGitIdentityFallbackArgs's
// own default probe construction never threaded trustedMainRoot, so a worktree-cwd probe started being
// refused post-round-2, and the refusal was silently read as "resolvable" (skipping fallback-identity
// injection) rather than propagating. Reproduces the exact shape under an identity-less HOME: the probe
// against a WORKTREE cwd, with no trustedMainRoot threaded at all, must now THROW a CanonicalGitRefusal
// (never silently report "resolvable"); threaded with the real trustedMainRoot, it must correctly report
// UNRESOLVABLE and the caller gets the Loom fallback env.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const W9 = path.join(SCRATCH, "A-worktree-9");
  git(A, `worktree add -q "${W9}" -b cgcr-wt9-branch`);
  registerForCleanup(W9);

  const identityEnvKeys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"];
  const savedIdentityEnv = {};
  for (const k of identityEnvKeys) savedIdentityEnv[k] = process.env[k];
  const freshHome = path.join(SCRATCH, "cgcr-identity-fresh-home");
  fs.mkdirSync(freshHome, { recursive: true });
  const emptyGlobalConfig = path.join(freshHome, "empty-gitconfig");
  fs.writeFileSync(emptyGlobalConfig, "");
  try {
    process.env.HOME = freshHome;
    process.env.USERPROFILE = freshHome;
    process.env.XDG_CONFIG_HOME = freshHome;
    process.env.GIT_CONFIG_GLOBAL = emptyGlobalConfig;
    process.env.GIT_CONFIG_SYSTEM = emptyGlobalConfig;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete process.env[k];

    // No trustedMainRoot at all ⇒ the probe's own default construction must REFUSE, and that refusal
    // must PROPAGATE out of resolveGitIdentityFallbackArgs — never be read as "resolvable".
    let noRootErr = null;
    try { await resolveGitIdentityFallbackArgs(W9, 5_000); } catch (e) { noRootErr = e; }
    check("(11) no trustedMainRoot: resolveGitIdentityFallbackArgs PROPAGATES the probe's CanonicalGitRefusal (never silently 'resolvable')", noRootErr instanceof CanonicalGitRefusal);

    // Threaded with the REAL trustedMainRoot (A) ⇒ the probe succeeds, correctly observes an
    // identity-less host, and the fallback env is applied.
    const fallbackEnv = await resolveGitIdentityFallbackArgs(W9, 5_000, undefined, undefined, A);
    check("(11) trustedMainRoot threaded: the worktree-cwd identity probe on a fresh HOME applies the Loom fallback", fallbackEnv.GIT_AUTHOR_NAME === "Loom" && fallbackEnv.GIT_AUTHOR_EMAIL === "loom@localhost" && fallbackEnv.GIT_COMMITTER_NAME === "Loom" && fallbackEnv.GIT_COMMITTER_EMAIL === "loom@localhost");
  } finally {
    for (const k of identityEnvKeys) {
      if (savedIdentityEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedIdentityEnv[k];
    }
  }

  // CONTROL: the SAME worktree, trustedMainRoot threaded, but the AMBIENT (real) host env restored ⇒ no
  // guarantee of a fallback either way — just prove the call itself still resolves cleanly end to end
  // (proves (11)'s own identity-less result above was about the fresh HOME, not a side effect of W9 itself).
  const ambientEnv = await resolveGitIdentityFallbackArgs(W9, 5_000, undefined, undefined, A);
  check("(11) control: the same worktree probe still resolves (no throw) once ambient host env is restored", ambientEnv && typeof ambientEnv === "object");
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (12) Code Review round 3, second review, B1/P4 — a MISSING `.git` must refuse, never fall through to
// `{ok:true}` (the pre-round-3 code let git itself discover a DIFFERENT, planted parent `.git`).
// (12a)/(12b) are the non-bound (worktree-shaped) case — repoPath has NO ancestor `.git` at all.
//
// ROUND 5: the subdir-bound positive control is now PIN-based, never trustedMainRoot-based — round 4's
// own mechanism (re-deriving the walk and comparing it to the CALLER's trustedMainRoot) was vacuous: both
// sides ran the identical walk on the identical input, so the comparison could never fail for ANY path,
// bound or not (the fourth Code Review's own "DECOY-PARENT" finding). (12c) is the genuinely-pinned
// positive control; (12d) is the SAME shape with NO pin at all ("decoy-parent" — an arbitrary, never-
// bound subdir sitting inside a real repo), which round 4's mechanism would have wrongly ALLOWED and
// round 5 now refuses; (12e) is a pin that no longer matches the live toplevel.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const noGitDir = path.join(SCRATCH, "no-git-dir-at-all");
  fs.mkdirSync(noGitDir, { recursive: true });
  const check12a = checkCommondirTrust(noGitDir, A);
  check("(12a) refuses a NON-BOUND repoPath with no ancestor .git at all, with trustedMainRoot given", check12a.ok === false);
  const check12b = checkCommondirTrust(noGitDir, undefined);
  check("(12b) refuses a NON-BOUND repoPath with no ancestor .git at all, even with no trustedMainRoot at all", check12b.ok === false);

  // (12c) a project legitimately BOUND to a subdirectory of its own repo (no .git of its own, but A — the
  // real toplevel — is reachable by walking up), once PINNED, is ALLOWED — trustedMainRoot plays NO role.
  const boundSub = path.join(A, "bound-subproj");
  fs.mkdirSync(boundSub, { recursive: true });
  pinFor(boundSub);
  const check12c = checkCommondirTrust(boundSub, undefined);
  check("(12c) ALLOWS a genuinely subdir-bound project path once it has been PINNED (round 5 — never trustedMainRoot)", check12c.ok === true);
  unpinFor(boundSub);

  // (12d) "decoy-parent" (4th Code Review): the IDENTICAL shape, but NEVER pinned. Round 4's walk-vs-walk
  // comparison could not tell this apart from (12c) — it ALLOWED this too, for ANY repoPath whatsoever,
  // pinned or not. Round 5 refuses it, with the honest kind:"unpinned" (not an attack, just unestablished).
  const check12d = checkCommondirTrust(boundSub, A);
  check("(12d) 'decoy-parent': refuses the SAME subdir shape with NO pin recorded, even with trustedMainRoot given", check12d.ok === false && check12d.kind === "unpinned");
  let decoyThrew;
  try { await canonicalGit(boundSub, 5_000).raw(["rev-parse", "HEAD"]); decoyThrew = null; } catch (e) { decoyThrew = e; }
  check("(12d) canonicalGit throws CanonicalGitUnpinnedRefusal end to end for the unpinned decoy-parent shape", decoyThrew instanceof CanonicalGitUnpinnedRefusal);

  // (12e) a pin exists, and a VALID live walk resolves to a genuinely DIFFERENT toplevel (simulated
  // directly here; (19)/(20)/(21) below reproduce the real tampering shapes that would actually cause
  // this) — card a8bc0404: its OWN distinct kind:"pinMismatch" (never the generic "redirect" wording,
  // which would misdescribe a stale-but-valid anchor as an attack), still a CanonicalGitCommondirRefusal
  // (manager amendment A3 — inheritance, not a sibling) so every pre-existing commondirRedirect-keyed
  // consumer still matches it. Code Review C1/M1: pinnedToplevel/liveToplevel ride as STRUCTURED fields
  // (never truncated), and the human-facing wording never presents re-pinning as the default remedy.
  pinMap.set(literalRepoPathKey(boundSub), { toplevel: B, pinnedAt: new Date().toISOString(), source: "bind", projectId: "x", repoKey: "primary" });
  const check12e = checkCommondirTrust(boundSub, undefined);
  check("(12e) refuses when a pin exists but a VALID live walk resolves elsewhere, with kind:\"pinMismatch\"", check12e.ok === false && check12e.kind === "pinMismatch");
  check("(12e) the returned object carries pinnedToplevel/liveToplevel as structured fields", check12e.pinnedToplevel === B && check12e.liveToplevel === A);
  check("(12e) the raw reason names BOTH the pinned toplevel and the live toplevel it found", check12e.reason.includes(A) && check12e.reason.includes(B));
  let mismatchThrew;
  try { await canonicalGit(boundSub, 5_000).raw(["rev-parse", "HEAD"]); mismatchThrew = null; } catch (e) { mismatchThrew = e; }
  check("(12e) canonicalGit throws CanonicalGitPinMismatchRefusal end to end", mismatchThrew instanceof CanonicalGitPinMismatchRefusal);
  check("(12e) a pinMismatch refusal is ALSO a CanonicalGitCommondirRefusal (A3 — inheritance, not a sibling)", mismatchThrew instanceof CanonicalGitCommondirRefusal);
  check("(12e) the thrown exception itself carries pinnedToplevel/liveToplevel", mismatchThrew.pinnedToplevel === B && mismatchThrew.liveToplevel === A);
  const d12e = describeGitFailure(mismatchThrew);
  check("(12e) describeGitFailure sets BOTH pinMismatch AND commondirRedirect", d12e.pinMismatch === true && d12e.commondirRedirect === true);
  check("(12e) describeGitFailure carries pinnedToplevel/liveToplevel through too", d12e.pinnedToplevel === B && d12e.liveToplevel === A);
  const msg12e = canonicalFailureMessage(d12e, "fallback");
  check("(12e) canonicalFailureMessage LEADS with the live toplevel, naming the repin route, never the generic redirect wording", msg12e.indexOf(A) < msg12e.indexOf("commondir-trust-pin/repin") && !/remove the planted commondir pointer/.test(msg12e));
  check("(12e) the wording tells the human to VERIFY intent first, never presenting re-pin as the default", /verify/i.test(msg12e) && /escalate to the Platform Lead/i.test(msg12e));
  unpinFor(boundSub);

  // (12e-2) Code Review M1 — a LONG (~100+ char) path's full live toplevel must survive
  // describeGitFailure().text's 400-char cap intact: leading with the toplevel CHANGE, not repoPath/pin
  // metadata, is what makes this possible on an ordinary path length.
  const longSegment = "a-very-long-directory-segment-name-that-pads-this-path-out-toward-the-hundred-character-mark-for-M1";
  const longAncestor = initRepo("12e2-" + longSegment.slice(0, 40));
  const longSub = path.join(longAncestor, "bound-subproj-also-long-" + longSegment);
  fs.mkdirSync(longSub, { recursive: true });
  pinFor(longSub); // pins to longAncestor
  const longDecoy = initRepo("12e2-decoy-" + longSegment.slice(0, 40));
  pinMap.set(literalRepoPathKey(longSub), { toplevel: longDecoy, pinnedAt: new Date().toISOString(), source: "bind", projectId: "x", repoKey: "primary" });
  const check12e2 = checkCommondirTrust(longSub, undefined);
  check("(12e-2) sanity: the live toplevel here really is long enough to risk truncation", check12e2.ok === false && check12e2.liveToplevel.length > 60);
  const d12e2 = describeGitFailure(new CanonicalGitPinMismatchRefusal(check12e2.reason, check12e2.pinnedToplevel, check12e2.liveToplevel));
  check("(12e-2) the FULL live toplevel survives describeGitFailure().text intact, not cut by the 400-char cap", d12e2.text.includes(check12e2.liveToplevel));
  unpinFor(longSub);

  // (12f) card a8bc0404, reviewer N-1 — prepareCanonicalEnv's GIT_CEILING_DIRECTORIES, for a subdir-bound
  // repoPath, must use the PIN's own recorded toplevel directly once it matches live, never discard it and
  // re-walk. The two can only be shown to literally diverge on win32: checkCommondirTrust's own match test
  // is CASE-FOLDED, so a pin recorded in a DIFFERENT case than the real OS casing still "matches" — a bare
  // walk (the pre-fix behaviour) always returns the OS's real casing, never the pin's literal value, so
  // the two approaches produce two different STRINGS for the identical directory. SKIP on non-win32:
  // caseFold is a no-op there, so a "matching" pin is already byte-identical to the walk — nothing to tell apart.
  if (process.platform === "win32") {
    const upperA = A.toUpperCase();
    pinMap.set(literalRepoPathKey(boundSub), { toplevel: upperA, pinnedAt: new Date().toISOString(), source: "bind", projectId: "x", repoKey: "primary" });
    const matched12f = checkCommondirTrust(boundSub, undefined);
    check("(12f) sanity: the upper-cased pin still case-fold-matches the live walk", matched12f.ok === true);
    const env12f = prepareCanonicalEnv(undefined, boundSub);
    const ceiling12f = (env12f.GIT_CEILING_DIRECTORIES ?? "").split(path.delimiter);
    check("(12f) the ceiling uses the PIN's own recorded (upper-cased) toplevel, not a re-walk's real-cased result", ceiling12f.includes(path.dirname(upperA)));
    check("(12f) the ceiling does NOT carry the real-cased toplevel's own parent (that would be the pre-fix bare-walk behaviour)", !ceiling12f.includes(path.dirname(A)));
    unpinFor(boundSub);
  } else {
    console.log("SKIP  (12f) win32-only: caseFold is a no-op on POSIX, so there is nothing to distinguish pin.toplevel from a bare walk's own result");
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (13) Code Review round 3, second review, B1/P1+P7 — `.git` ITSELF must never be a symlink/junction
// (either originally-file or originally-directory shape), and a DIRECTORY `.git` is legitimate ONLY for
// the trusted main itself — a worker replacing their OWN worktree's `.git` with a directory (a copy or a
// junction of an unrelated repo) must be refused, not silently trusted as if it were a main checkout.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  // (13a) `.git` itself a junction, pointing at a real decoy DIRECTORY.
  const decoyDir13 = path.join(SCRATCH, "cgcr-p1-decoy-dir");
  fs.mkdirSync(decoyDir13, { recursive: true });
  const fakeWt13a = path.join(SCRATCH, "fake-worktree-dotgit-junction");
  fs.mkdirSync(fakeWt13a, { recursive: true });
  let symlinkOk13a = true;
  try {
    fs.symlinkSync(decoyDir13, path.join(fakeWt13a, ".git"), process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    symlinkOk13a = false;
    console.log(`SKIP  (13a) could not create a .git junction (${e.message})`);
  }
  if (symlinkOk13a) {
    check("(13a) refuses when .git itself is a symlink/junction to a decoy directory", checkCommondirTrust(fakeWt13a, A).ok === false);
  }

  // (13b) a worker's own worktree's `.git` replaced WHOLESALE by a real DIRECTORY (no internal commondir,
  // the shape a plain standalone repo's own top-level .git takes) — must refuse, since repoPath is NOT
  // the trusted main.
  const fakeWt13b = path.join(SCRATCH, "fake-worktree-dotgit-directory");
  fs.mkdirSync(path.join(fakeWt13b, ".git"), { recursive: true });
  check("(13b) refuses a DIRECTORY .git in a worktree whose trustedMainRoot is NOT itself", checkCommondirTrust(fakeWt13b, A).ok === false);

  // (13c) control: the SAME DIRECTORY .git shape is ALLOWED when repoPath genuinely IS the trusted main
  // (trustedMainRoot === repoPath) — this is the ordinary, legitimate case this fix must not break.
  check("(13c) control: a DIRECTORY .git is allowed when repoPath IS the trusted main itself", checkCommondirTrust(A, A).ok === true);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (14) Code Review round 3, second review, B1/P2 — once the gitdir is proven under the trusted main's own
// .git/worktrees/, a MISSING or unreadable commondir must refuse, never fall through to `{ok:true}`.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const privateDir14 = path.join(A, ".git", "worktrees", "cgcr-p2-no-commondir");
  fs.mkdirSync(privateDir14, { recursive: true }); // deliberately NO commondir file inside
  const fakeWt14 = path.join(SCRATCH, "fake-worktree-no-commondir");
  fs.mkdirSync(fakeWt14, { recursive: true });
  fs.writeFileSync(path.join(fakeWt14, ".git"), `gitdir: ${privateDir14}\n`);
  check("(14) refuses a trusted-worktrees registry entry with NO commondir file at all", checkCommondirTrust(fakeWt14, A).ok === false);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (15) Code Review round 3, second review, S1 — git >= 2.48 can write a RELATIVE gitdir pointer
// (worktree.useRelativePaths / --relative-paths); the round-2 code refused every relative value outright,
// a false refusal on a real, current git shape. A relative pointer must resolve against the `.git` FILE's
// own containing directory (git's own read_gitfile_gently behavior), then pass the same verification as
// an absolute one — allowed when it resolves under the trusted worktrees dir, refused when it resolves
// elsewhere.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const privateDir15 = path.join(A, ".git", "worktrees", "cgcr-s1-relative-ok");
  fs.mkdirSync(privateDir15, { recursive: true });
  fs.writeFileSync(path.join(privateDir15, "commondir"), "../..\n");
  const fakeWt15a = path.join(SCRATCH, "fake-worktree-relative-ok");
  fs.mkdirSync(fakeWt15a, { recursive: true });
  const relToTrusted = path.relative(fakeWt15a, privateDir15).split(path.sep).join("/");
  fs.writeFileSync(path.join(fakeWt15a, ".git"), `gitdir: ${relToTrusted}\n`);
  check("(15a) ALLOWS a relative gitdir pointer that resolves under the trusted main's own .git/worktrees/", checkCommondirTrust(fakeWt15a, A).ok === true);

  // (15b) a relative pointer resolving OUTSIDE the trusted worktrees dir — refused, same as an absolute one.
  const decoyDir15 = path.join(SCRATCH, "cgcr-s1-relative-decoy");
  fs.mkdirSync(decoyDir15, { recursive: true });
  fs.writeFileSync(path.join(decoyDir15, "commondir"), path.join(B, ".git") + "\n");
  const fakeWt15b = path.join(SCRATCH, "fake-worktree-relative-elsewhere");
  fs.mkdirSync(fakeWt15b, { recursive: true });
  const relElsewhere = path.relative(fakeWt15b, decoyDir15).split(path.sep).join("/");
  fs.writeFileSync(path.join(fakeWt15b, ".git"), `gitdir: ${relElsewhere}\n`);
  check("(15b) refuses a relative gitdir pointer that resolves OUTSIDE the trusted worktrees dir", checkCommondirTrust(fakeWt15b, A).ok === false);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (16) Code Review round 3, second review, S2 — a win32 drive-less rooted gitdir value ("gitdir: /proj/...")
// resolves against DIFFERENT drives depending on who's asking (Node vs. a spawned git child); refused
// outright on win32 rather than guessed. SKIPPED on POSIX (there is no drive-letter concept to construct).
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
if (process.platform !== "win32") {
  console.log("SKIP  (16) win32 drive-less rooted gitdir pointer case — exercised on win32 only");
} else {
  const fakeWt16 = path.join(SCRATCH, "fake-worktree-drive-less");
  fs.mkdirSync(fakeWt16, { recursive: true });
  // a drive-less rooted path, same shape path.isAbsolute() accepts on win32 (POSIX-style absolute).
  fs.writeFileSync(path.join(fakeWt16, ".git"), "gitdir: /some/drive-less/rooted/path\n");
  const check16 = checkCommondirTrust(fakeWt16, A);
  check("(16) refuses a drive-less rooted gitdir pointer value on win32", check16.ok === false);
}

// ── canonicalFailureMessage: the distinct "escalate to the Platform Lead" wording, never the generic one.
{
  const refusal = new CanonicalGitCommondirRefusal("canonicalGit: refusing — test");
  const d = describeGitFailure(refusal);
  const msg = canonicalFailureMessage(d, "fallback text");
  check("(wording) a commondir refusal renders DISTINCTLY: names escalation, never the generic 'refused, nothing changed' alone", /escalat/i.test(msg) && /platform lead/i.test(msg));
  const ordinaryRefusal = new CanonicalGitRefusal("canonicalGit: refusing — an ordinary merge-driver refusal");
  const d2 = describeGitFailure(ordinaryRefusal);
  const msg2 = canonicalFailureMessage(d2, "fallback text");
  check("(wording) an ORDINARY CanonicalGitRefusal keeps the existing generic wording, not the commondir one", /^refused, nothing changed:/.test(msg2) && !/platform lead/i.test(msg2));
  // (wording, S1/S4) the bound-repo-is-worktree case renders its OWN honest wording — primarily the
  // "re-bind the project" remedy, never the commondir-redirect's UNCONDITIONAL escalation demand alone.
  // (S4, round 3) it ALSO now names the escalation POSSIBILITY, hedged ("if you did not intentionally…"),
  // since a worker could swap the main's own DIRECTORY .git for a FILE specifically to make a real
  // redirect read as this quieter message — so "mentions escalation" alone no longer distinguishes the
  // two; "re-bind"/"possible redirect instead" (this case) vs. an unconditional "needs HUMAN escalation"
  // with no hedge (the commondir-redirect case) is what still does.
  const boundRefusal = new CanonicalGitBoundWorktreeRefusal("canonicalGit: refusing — test (bound repo is a worktree)");
  const d3 = describeGitFailure(boundRefusal);
  const msg3 = canonicalFailureMessage(d3, "fallback text");
  check("(wording, S1) a boundRepoIsWorktree refusal names the re-bind remedy", /not support/i.test(msg3) && /re-bind/i.test(msg3));
  check("(wording, S4) …AND hedges the escalation possibility explicitly (not the commondir-redirect's unconditional demand)", /possible redirect/i.test(msg3) && /platform lead/i.test(msg3));
  check("(wording, S1) …and describeGitFailure flags it distinctly from commondirRedirect", d3.refusal === true && d3.boundRepoIsWorktree === true && d3.commondirRedirect === false);

  // (wording, S4, end to end) a deliberately long (>400 char) raw reason — the exact shape that would
  // cut an APPENDED sentence off mid-word via describeGitFailure's own first-line truncation (measured
  // directly: appending the escalation hedge to a real production-length reason truncates it) — proves
  // the hedge survives in full precisely because it lives in canonicalFailureMessage's fixed template,
  // never appended to the raw (truncatable) reason.
  const longReason = `canonicalGit: refusing — test ${"x".repeat(450)}`;
  check("(wording, S4, precondition) the synthetic reason really exceeds describeGitFailure's 400-char first-line cap", longReason.length > 400);
  const longD = describeGitFailure(new CanonicalGitBoundWorktreeRefusal(longReason));
  check("(wording, S4, precondition) …and describeGitFailure's own text extraction truncated it to 400", longD.text.length === 400);
  const longMsg = canonicalFailureMessage(longD, "fallback text");
  check("(wording, S4, end to end) the escalation hedge still appears in full, appended AFTER the (truncated) d.text — never lost to the truncation", /possible redirect/i.test(longMsg) && /platform lead/i.test(longMsg));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (17) Code Review round 4, B-1 — a REAL regression: a project legitimately bound to a SUBDIRECTORY of
// its own repo (card 7673d096 names a live one) was refused at every site threading the bound path as
// trustedMainRoot — createWorktree threw ".git does not exist", mergeBranch refused the same way. This
// is a full, real mutating end-to-end proof: createWorktree → commit → mergeBranch against the SUBDIR
// itself, never the repo root. RED at 25986e91 (verified by the round-4 reviewer's own probe scripts,
// cited in the decision record); GREEN after resolveTrustedToplevel + its call-site wiring.
// ROUND 5: GREEN now depends on a durable PIN for the bound subdir, established here exactly as
// `Db.insertProject` would at real project-bind time — never on round 4's deleted walk-as-trust default.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const { createWorktree, mergeBranch } = await import("../dist/git/worktrees.js");
  const boundRoot = path.join(SCRATCH, "17-bound-root");
  const boundSub = path.join(boundRoot, "proj");
  fs.mkdirSync(boundSub, { recursive: true });
  git(boundRoot, "init -q -b main");
  fs.writeFileSync(path.join(boundSub, "a.txt"), "a\n");
  git(boundRoot, "add -A");
  git(boundRoot, `${GIT_ID} commit -q -m "17: init"`);
  pinFor(boundSub, "cgcr17-project", "primary");

  const wt = await createWorktree(boundSub, "cgcr17-proj", "cgcr17-task");
  registerForCleanup(wt.worktreePath);
  check("(17) createWorktree against a SUBDIR-bound project path succeeds (RED at 25986e91: '.git does not exist')", !!wt.worktreePath && !!wt.branch);

  const wtDir = fs.existsSync(path.join(wt.worktreePath, "proj")) ? path.join(wt.worktreePath, "proj") : wt.worktreePath;
  fs.writeFileSync(path.join(wtDir, "b.txt"), "b\n");
  git(wt.worktreePath, "add -A");
  git(wt.worktreePath, `${GIT_ID} commit -q -m "17: feat"`);

  const mergeResult = await mergeBranch(boundSub, wt.branch, "feat(cgcr17): subdir merge");
  check("(17) mergeBranch against the SAME subdir-bound project path lands cleanly (RED at 25986e91)", mergeResult.ok === true);
  const landedLog = git(boundRoot, "log --oneline -1");
  check("(17) the squash commit really landed on the real canonical main", /subdir merge/.test(landedLog));
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (18) Code Review round 4, B-2 — POSIX-only: a `path.resolve()`-based lexical collapse of "J/.." differs
// from a real kernel's PHYSICAL resolution through a symlinked `J` component. SKIPPED on win32 (no
// equivalent hazard there — confirmed separately: a win32 junction makes real git itself fail closed,
// so there is nothing for this check to differ from). MEASURED under WSL (round-4 reviewer's own
// probe-posix.mjs): real git opens the DECOY repo through this exact pointer shape.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
if (process.platform !== "win32") {
  const root18 = path.join(SCRATCH, "18-posix-dotdot");
  const decoyRepo = initRepo("18-decoy");
  const legitWtParent = path.join(root18, "legit");
  fs.mkdirSync(legitWtParent, { recursive: true });
  git(legitWtParent, "init -q -b main");
  fs.writeFileSync(path.join(legitWtParent, "f"), "legit\n");
  git(legitWtParent, "add f");
  git(legitWtParent, `${GIT_ID} commit -q -m "18: legit init"`);
  const legitWt = path.join(root18, "legit-wt");
  git(legitWtParent, `worktree add -q "${legitWt}" -b cgcr18-wl`);

  const E = path.join(root18, "E");
  fs.mkdirSync(path.join(E, "sub"), { recursive: true });
  fs.cpSync(path.join(decoyRepo, ".git"), path.join(E, "T"), { recursive: true });

  const D = path.join(root18, "D");
  fs.mkdirSync(D, { recursive: true });
  fs.symlinkSync(path.join(E, "sub"), path.join(D, "J"));
  fs.symlinkSync(path.join(legitWtParent, ".git", "worktrees", "cgcr18-wl"), path.join(D, "T"));
  fs.writeFileSync(path.join(D, ".git"), "gitdir: J/../T\n");

  const check18 = checkCommondirTrust(D, legitWtParent);
  check("(18) POSIX: refuses a gitdir pointer whose symlink-physical resolution differs from its lexical one", check18.ok === false);
} else {
  console.log("SKIP  (18) POSIX symlink-physical-vs-lexical gitdir resolution — win32 has no equivalent hazard (a junction makes real git fail closed instead)");
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (19)/(20) round-5 manager amendment 1 — "consult the pin WHENEVER ONE EXISTS, not only when repoPath
// has no own .git". Without this, a worker could plant a `.git` AT (or at an ancestor BETWEEN the bound
// subdir and) an already-pinned path: `repoPath` would then "have its own .git", skip the missing-.git
// branch entirely, and the pre-amendment code would have fallen into the DIRECTORY-shape branch and
// accepted it (no internal commondir file, no caller-supplied trustedMainRoot to disagree with). Round 5
// closes this by consulting the pin UNCONDITIONALLY, before any shape dispatch — these two cases are the
// amendment's own named test requirement.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  // (19) a .git planted DIRECTLY at the pinned subdir itself.
  const A19 = initRepo("19-root");
  const sub19 = path.join(A19, "sub19");
  fs.mkdirSync(sub19, { recursive: true });
  pinFor(sub19);
  fs.mkdirSync(path.join(sub19, ".git")); // plant: a bare directory, no internal commondir
  const check19 = checkCommondirTrust(sub19, undefined);
  check("(19) refuses when a .git is planted AT an already-pinned subdir (pin now disagrees with the live toplevel)", check19.ok === false && check19.kind === "pinMismatch");
  unpinFor(sub19);

  // (20) a .git planted at an INTERMEDIATE ancestor between the pinned subdir and the real toplevel.
  const A20 = initRepo("20-root");
  const mid20 = path.join(A20, "mid");
  const sub20 = path.join(mid20, "sub20");
  fs.mkdirSync(sub20, { recursive: true });
  pinFor(sub20);
  fs.mkdirSync(path.join(mid20, ".git")); // plant: a bare directory, no internal commondir, BETWEEN sub20 and A20
  const check20 = checkCommondirTrust(sub20, undefined);
  check("(20) refuses when a .git is planted at an INTERMEDIATE ancestor between a pinned subdir and its real toplevel", check20.ok === false && check20.kind === "pinMismatch");
  unpinFor(sub20);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (21) round-5 manager amendment 2 / 4th Code Review S-1 — "resolveTrustedToplevel realpaths startPath
// before walking, so a bound subdir swapped for a symlink to a decoy repo passes." Round 4's mechanism
// compared two walks of the SAME (already-swapped) starting path, so this always passed vacuously. Round
// 5's pin is recorded BEFORE the swap and compared against the POST-swap live walk, so the swap is now
// caught. Exercised on BOTH platforms (a junction physically redirects on win32 too — this is a different
// hazard from (18)'s POSIX-only relative-pointer lexical/physical divergence).
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const A21 = initRepo("21-root");
  const decoy21 = initRepo("21-decoy");
  const decoySubdir21 = path.join(decoy21, "innocuous-subdir"); // no .git of its OWN — forces the walk to climb to decoy21's real toplevel
  fs.mkdirSync(decoySubdir21, { recursive: true });
  const sub21 = path.join(A21, "sub21");
  fs.mkdirSync(sub21, { recursive: true });
  pinFor(sub21); // pinned to A21's own toplevel, BEFORE any swap exists
  fs.rmSync(sub21, { recursive: true, force: true });
  let swapOk21 = true;
  try {
    fs.symlinkSync(decoySubdir21, sub21, process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    swapOk21 = false;
    console.log(`SKIP  (21) could not create a directory symlink/junction (${e.message})`);
  }
  if (swapOk21) {
    const check21 = checkCommondirTrust(sub21, undefined);
    check("(21) refuses when a PINNED subdir is later swapped (symlink/junction) for a decoy repo", check21.ok === false && check21.kind === "pinMismatch");
    const defaulted21 = defaultTrustedMainRoot(sub21);
    check("(21) defaultTrustedMainRoot falls back to the bare path too — never vouches for the decoy via the stale pin", defaulted21 === sub21);
  }
  unpinFor(sub21);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (22) fifth Code Review, S-4(a) — round 5's own "Do not" already states `advisory-read` must not bypass
// a MISMATCH against an existing pin (only the no-pin-at-all case stays permissive under it). The
// reviewer's probe P3 showed the code is already right; this pins it with a real test, since nothing did
// before. Negative-control proof (RED when the guard is removed) is run separately, by hand, immediately
// after this file — see the repair recipe in that script's own output.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const A22 = initRepo("22-root");
  const decoy22 = initRepo("22-decoy");
  const sub22 = path.join(A22, "sub22");
  fs.mkdirSync(sub22, { recursive: true });
  pinFor(sub22); // pinned to A22's own toplevel
  fs.rmSync(sub22, { recursive: true, force: true });
  fs.symlinkSync(decoy22, sub22, process.platform === "win32" ? "junction" : "dir"); // now resolves to an UNRELATED decoy toplevel
  const check22 = checkCommondirTrust(sub22, undefined, { commondirCheck: "advisory-read" });
  check("(22) S-4(a): advisory-read does NOT bypass a mismatch against an EXISTING pin", check22.ok === false && check22.kind === "pinMismatch");
  unpinFor(sub22);
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────────
// (23) fifth Code Review, S-4(c) — production now routes EVERY project through the pin branch
// (`Db.insertProject` pins the primary repoPath, root-bound or not), but most of this test file (and most
// of the daemon's own existing test suite) runs with NO resolver registered at all — so the pin branch is
// a no-op for almost everything this card's own test file has exercised so far. This is the missing
// control: an ORDINARY (root-bound, `.git` directly at repoPath) repo, WITH a resolver registered AND
// this exact repoPath pinned (mirroring real production shape), end to end through createWorktree →
// commit → mergeBranch. Plus: a planted `.git/commondir` (the card's OWN original attack shape, section
// (1) above) must STILL refuse even though this repo is pinned — `resolveTrustedToplevel`'s own internal
// commondir-file check makes the live walk itself fail, so `liveToplevelMatchesPin` returns false and the
// unified pin gate refuses it, the SAME mechanism that catches a planted/intermediate `.git` for a
// subdir-bound repo in (19)/(20) above.
// ────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const { createWorktree, mergeBranch } = await import("../dist/git/worktrees.js");
  const A23 = initRepo("23-root");
  pinFor(A23, "cgcr23-project", "primary"); // mirrors Db.insertProject pinning the project's own primary repoPath

  const wt23 = await createWorktree(A23, "cgcr23-proj", "cgcr23-task");
  registerForCleanup(wt23.worktreePath);
  check("(23) createWorktree on an ORDINARY root-bound repo succeeds with the pin lookup registered + this repo pinned", !!wt23.worktreePath && !!wt23.branch);

  fs.writeFileSync(path.join(wt23.worktreePath, "c23.txt"), "c23\n");
  git(wt23.worktreePath, "add -A");
  git(wt23.worktreePath, `${GIT_ID} commit -q -m "23: feat"`);

  const mergeResult23 = await mergeBranch(A23, wt23.branch, "feat(cgcr23): ordinary root merge");
  check("(23) mergeBranch on the SAME ordinary root-bound repo lands cleanly", mergeResult23.ok === true);
  const landedLog23 = git(A23, "log --oneline -1");
  check("(23) the squash commit really landed on the real canonical main", /ordinary root merge/.test(landedLog23));

  // Extra check (S-4(c)): a planted commondir file inside THIS (pinned, ordinary) repo's own `.git` must
  // still refuse — the pin's existence must never make a worker-planted commondir any more trustworthy.
  // @decision a8bc0404 (Code Review C1) — this is the exact "pinned repo + planted commondir" attack
  // shape the reviewer's C1 finding named: resolveTrustedToplevel's own commondir-file check makes the
  // LIVE WALK ITSELF FAIL (`!live.ok`), so this must be kind:"redirect" with the alarm wording, never
  // "pinMismatch" (which would misdescribe an active attack as a benign re-pin candidate).
  const commondirFile23 = path.join(A23, ".git", "commondir");
  fs.writeFileSync(commondirFile23, path.join(initRepo("23-decoy"), ".git") + "\n");
  const check23b = checkCommondirTrust(A23, undefined);
  check("(23) a planted .git/commondir inside a PINNED ordinary repo is still refused, with the redirect ALARM kind (not pinMismatch — C1)", check23b.ok === false && check23b.kind === "redirect");
  let plantedThrew23;
  try { await canonicalGit(A23, 5_000).raw(["rev-parse", "HEAD"]); plantedThrew23 = null; } catch (e) { plantedThrew23 = e; }
  check("(23) canonicalGit throws the plain CanonicalGitCommondirRefusal end to end (not CanonicalGitPinMismatchRefusal)", plantedThrew23 instanceof CanonicalGitCommondirRefusal && !(plantedThrew23 instanceof CanonicalGitPinMismatchRefusal));
  const msg23 = canonicalFailureMessage(describeGitFailure(plantedThrew23), "fallback");
  check("(23) the human-facing message is the ALARM wording (remove the planted pointer), never the re-pin wording", /remove the planted commondir pointer/.test(msg23) && !/commondir-trust-pin\/repin/.test(msg23));
  fs.rmSync(commondirFile23);
  unpinFor(A23);
}

await finishAndExit(failures === 0 ? 0 : 1);
