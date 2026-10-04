import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8c3d6c04 — `mergeMainIntoWorktree`'s failure returns carried no structured signal distinguishing a
// TRANSIENT git-child condition (a confirmed-kill timeout, or an EAGAIN/EMFILE/ENFILE/EBUSY spawn error)
// from a DETERMINISTIC one (a real content conflict, a `CanonicalGitRefusal`, ENOENT/EACCES, or an
// ordinary non-zero exit) — every non-conflict failure fell into the same generic `{ok:false, reason}`
// shape. `sessions/service.ts`'s `classifyOutcome` then had nothing to key on but `conflict`/`quarantined`,
// so a transient failure classified as plain "rejected" and WAS cacheable via `retainVerdictUntilSuperseded`
// (see merge-confirm-verdict-cache-union-merge-transient.mjs for the service-layer caching proof this file
// is the companion of).
//
// This file proves the NEW `transient` field on `mergeMainIntoWorktree`'s return value is set for exactly
// the shapes card 8c3d6c04's manager ruling named transient, and withheld for everything else — using the
// `deps.gitFactory` test seam (no real spawn/kill involved: `killableCanonicalRaw` takes the fast
// `withTimeout(gitFactory(...).raw(args), ...)` path when a factory is supplied) so every scenario settles
// in milliseconds. The underlying classification logic this reads from (`TIMEOUT_SHAPED_RE` matching a
// non-refusal error after a confirmed kill) is ALREADY proven correct under REAL kill conditions by
// union-merge-kill-confirm.mjs; this file does not re-prove that, only that the NEW field is threaded
// correctly off the SAME structural signals.
//
// ROUND 2 (same card, Code Review 47c5815f of 5045a6ed): also covers (a) the three "landed" returns inside
// `isConfirmedKillTimeout && verifyUnionLanded()` — which must NEVER set `transient` (the union already
// landed; the branch tip moved), (b) a worktree ALREADY dirty before the merge was attempted, classified
// via the structural `dirtyWorktree` field (never by sniffing ort's "would be overwritten" stderr text),
// plus a negative control proving it's read from the pre-check, not from the error text merely matching,
// and (c) the owed-landing branch's own two transient sites (a bare-reads timeout/spawn-error, and a REAL,
// proxied `--ff-only` retry-exhaustion — computeOwedLanding's merge-tree/commit-tree math only means
// something against real git objects, so that one scenario proxies a real `canonicalGit` rather than a
// full hand-rolled fake).
//
// ROUND 3 (same card, delta Code Review of 21ee1ef7): `preMergeDirty`/`preOwedDirty` must NOT win over a
// confirmed-kill timeout — a timeout on an already-dirty tree falls through to the ordinary residue/
// transient handling (never `dirtyWorktree`, never advising "commit", since the interrupted merge may have
// folded residue into that same dirt). Covers this at BOTH the plain-union site and the owed-landing
// `--ff-only` site (which gained its own pre-attempt dirt check, `makeOwedFixture`'s main-advance now
// modifies the SHARED `base.txt` rather than adding a new file, so a dirty copy of it can actually collide
// with a real fast-forward). Also fixes a round-2 test comment that wrongly claimed a real on-disk edit
// drove the dirt signal in the fake-gitFactory scenario (it's the fake's own hardcoded `status` response
// that does), and adds a genuinely REAL-git dirty-worktree case (no factory at all) for both the plain-union
// and owed-landing paths.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/union-merge-transient-classification.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distGitDir = path.join(__dirname, "..", "dist", "git");
const { mergeMainIntoWorktree } = await import(pathToFileURL(path.join(distGitDir, "worktrees.js")).href);
const { CanonicalGitRefusal, canonicalGit } = await import(pathToFileURL(path.join(distGitDir, "bounded.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GIT_ID_ARGV = ["-c", "user.email=unionxc@loom", "-c", "user.name=unionxc"];
const HEAD_SHA = "a".repeat(40);

function makeRepoAndWorktree(tag) {
  const repo = mkdtempManaged(`loom-unionxc-${tag}-`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "unionxc@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "unionxc"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "f.txt"), "f\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", [...GIT_ID_ARGV, "commit", "-q", "-m", "init"], { cwd: repo });
  const wt = mkdtempManaged(`loom-unionxc-wt-${tag}-`);
  execFileSync("git", ["worktree", "add", "-q", "-b", `loom/unionxc-${tag}`, wt, "HEAD"], { cwd: repo });
  return { repo, wt };
}

// A REAL, coherent owed/HELD-branch fixture: a base commit, a worktree with ONE owed commit (a new file
// `owed.txt`), and main independently advancing on a DIFFERENT file — a trivial, non-conflicting 3-way
// merge `computeOwedLanding` can actually compute (its merge-tree/commit-tree math only means something
// against real git objects, never a hand-rolled fake). Shared by every owed `--ff-only` scenario below.
function makeOwedFixture(tag) {
  const repo = mkdtempManaged(`loom-unionxc-${tag}-`);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "unionxc@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "unionxc"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", [...GIT_ID_ARGV, "commit", "-q", "-m", "base"], { cwd: repo });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
  const wt = mkdtempManaged(`loom-unionxc-${tag}-wt-`);
  execFileSync("git", ["worktree", "add", "-q", "-b", `loom/${tag}`, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, "owed.txt"), "owed\n");
  execFileSync("git", ["add", "-A"], { cwd: wt });
  execFileSync("git", [...GIT_ID_ARGV, "commit", "-q", "-m", "owed commit"], { cwd: wt });
  // Main's advance MODIFIES the shared `base.txt` (never a brand-new file): the union's fast-forward must
  // then actually touch `base.txt` in the worktree, which is what lets a dirty copy of it trigger a REAL
  // "local changes would be overwritten" refusal in the dirty-worktree scenarios below — a brand-new file
  // main adds wouldn't collide with dirt on any file the worker's own owed commit already tracks.
  fs.writeFileSync(path.join(repo, "base.txt"), "base\nmain advance\n");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", [...GIT_ID_ARGV, "commit", "-q", "-m", "main advance"], { cwd: repo });
  return { repo, wt, base, branch: `loom/${tag}` };
}

// A minimal fake `gitFactory`: handles every read `mergeMainIntoWorktree`'s plain-union path issues, and
// lets the caller control exactly how the merge call itself resolves. ALWAYS rejects `merge-base` (so
// neither the "already caught up" shortcut nor `verifyUnionLanded` ever reports a landed merge — every
// scenario here is "the merge genuinely did not land"), and ALWAYS reports a clean, conflict-free worktree
// unless `conflicted` says otherwise.
function makeFakeGit({ mergeError, conflicted = false }) {
  return (_repoPathArg, _ms) => ({
    async raw(args) {
      const a = Array.isArray(args) ? args : [args];
      if (a[0] === "rev-parse" && a.includes("HEAD") && !a.includes("-q")) return `${HEAD_SHA}\n`;
      if (a[0] === "rev-parse" && a.includes("-q")) throw new Error("fatal: needed a single revision"); // MERGE_HEAD/HEAD^2: always "absent"
      if (a[0] === "merge-base") throw new Error("fake: no merge-base (never landed)");
      if (a[0] === "config") throw new Error("fake: no identity configured");
      // `includes`, not `a[0] ===`: computeWorktreeGateStamp's own status read is prefixed with
      // `-c core.quotePath=false`, unlike verifyWorktreeCleanAt's bare `status --porcelain ...`.
      if (a.includes("status")) return "";
      if (a[0] === "ls-files") return conflicted ? "f.txt\n" : "";
      if (a.includes("merge") && a.includes("--no-edit")) { if (mergeError) throw mergeError; return ""; }
      if (a.includes("merge") && a.includes("--abort")) return "";
      throw new Error(`fake git: unhandled args ${JSON.stringify(a)}`);
    },
  });
}

async function run(tag, { mergeError, conflicted }) {
  const { repo, wt } = makeRepoAndWorktree(tag);
  return mergeMainIntoWorktree(repo, wt, { timeoutMs: 50, gitFactory: makeFakeGit({ mergeError, conflicted }) });
}

// ── TRANSIENT shapes ─────────────────────────────────────────────────────────────────────────────────────
{
  const r = await run("timeout", { mergeError: new Error("git merge main into worktree exceeded 50ms (hung git child?)") });
  check("(timeout-shaped, confirmed) ok:false", r.ok === false);
  check("(timeout-shaped, confirmed) transient:true", r.ok === false && r.transient === true);
  check("(timeout-shaped, confirmed) not a conflict", r.ok === false && r.conflict !== true);
}
for (const code of ["EAGAIN", "EMFILE", "ENFILE", "EBUSY"]) {
  const e = Object.assign(new Error(`spawn git ${code}`), { code });
  const r = await run(`spawn-${code}`, { mergeError: e });
  check(`(spawn error ${code}) transient:true`, r.ok === false && r.transient === true);
}

// ── DETERMINISTIC shapes ─────────────────────────────────────────────────────────────────────────────────
for (const code of ["ENOENT", "EACCES"]) {
  const e = Object.assign(new Error(`spawn git ${code}`), { code });
  const r = await run(`spawn-${code}`, { mergeError: e });
  check(`(spawn error ${code}) transient is NOT set (deterministic)`, r.ok === false && !r.transient);
}
{
  // An unknown/unlisted code must fail CLOSED toward deterministic, per the manager's ruling.
  const e = Object.assign(new Error("spawn git EPERM"), { code: "EPERM" });
  const r = await run("spawn-unknown", { mergeError: e });
  check("(unlisted spawn code EPERM) transient is NOT set (fails closed)", r.ok === false && !r.transient);
}
{
  const r = await run("generic-exit", { mergeError: new Error("git merge --no-edit exited with code 1\nerror: some unrelated failure") });
  check("(generic non-zero exit, not conflict/timeout/spawn) transient is NOT set", r.ok === false && !r.transient);
}
{
  const r = await run("conflict", { mergeError: new Error("git merge --no-edit exited with code 1"), conflicted: true });
  check("(real conflict) conflict:true", r.ok === false && r.conflict === true);
  check("(real conflict) transient is NOT set, even though the merge error text could otherwise be ambiguous", r.ok === false && !r.transient);
}
{
  const refusal = new CanonicalGitRefusal("canonicalGit: refusing to run \"git merge\" — test refusal");
  const r = await run("refusal", { mergeError: refusal });
  check("(CanonicalGitRefusal) transient is NOT set (a policy refusal, not timing)", r.ok === false && !r.transient);
}

// ── LANDED shapes (round 2, item 1): the union genuinely LANDED (HEAD moved onto main), but cleanup
// couldn't be confirmed. `transient` must NOT be set here — that word means "nothing changed, retry is
// safe", which is false: the branch tip DID move, so a re-confirm needs the NEW identity, never a blind
// replay. The wording must say the merge landed, not hint at a no-op retry.
function makeLandedFakeGit(mergeHeadSequence) {
  let callIndex = 0;
  let mergeBaseCalls = 0;
  return (_p, _ms) => ({
    async raw(args) {
      const a = Array.isArray(args) ? args : [args];
      if (a[0] === "rev-parse" && a.includes("HEAD") && !a.includes("-q")) return `${HEAD_SHA}\n`;
      if (a[0] === "merge-base") {
        mergeBaseCalls++;
        // 1st call is the PRE-ATTEMPT "already caught up" shortcut — must NOT match, or the merge is
        // never even attempted. Every call AFTER the (failed) merge attempt is `verifyUnionLanded`,
        // which must report landed (merge-base(HEAD, mainSha) === mainSha).
        return mergeBaseCalls === 1 ? "not-yet-caught-up\n" : `${HEAD_SHA}\n`;
      }
      if (a[0] === "rev-parse" && a.includes("-q") && a.includes("MERGE_HEAD")) {
        const outcome = mergeHeadSequence[callIndex++];
        if (outcome.state === "unreadable") throw new Error("fake: MERGE_HEAD read failed");
        return outcome.state === "present" ? `${outcome.sha}\n` : "";
      }
      if (a.includes("status")) return "";
      if (a[0] === "config") throw new Error("fake: no identity configured");
      if (a.includes("merge") && a.includes("--no-edit")) throw new Error("git merge main into worktree exceeded 50ms (hung git child?)");
      if (a.includes("merge") && a.includes("--quit")) return "";
      throw new Error(`fake git: unhandled args ${JSON.stringify(a)}`);
    },
  });
}
async function runLanded(tag, mergeHeadSequence) {
  const { repo, wt } = makeRepoAndWorktree(tag);
  return mergeMainIntoWorktree(repo, wt, { timeoutMs: 50, gitFactory: makeLandedFakeGit(mergeHeadSequence) });
}
{
  const r = await runLanded("landed-a", [{ state: "unreadable" }]);
  check("(landed, MERGE_HEAD unreadable) ok:false", r.ok === false);
  check("(landed, MERGE_HEAD unreadable) transient is NOT set (the branch tip moved — not a no-op retry)", r.ok === false && !r.transient);
  check("(landed, MERGE_HEAD unreadable) reason says the merge LANDED", r.ok === false && /landed/.test(r.reason ?? ""));
}
{
  const r = await runLanded("landed-b", [{ state: "present", sha: "c".repeat(40) }, { state: "unreadable" }]);
  check("(landed, re-check unreadable) ok:false", r.ok === false);
  check("(landed, re-check unreadable) transient is NOT set", r.ok === false && !r.transient);
  check("(landed, re-check unreadable) reason says the merge LANDED", r.ok === false && /landed/.test(r.reason ?? ""));
}
{
  const r = await runLanded("landed-c", [{ state: "present", sha: "c".repeat(40) }, { state: "present", sha: "d".repeat(40) }]);
  check("(landed, MERGE_HEAD still present) ok:false", r.ok === false);
  check("(landed, MERGE_HEAD still present) transient is NOT set", r.ok === false && !r.transient);
  check("(landed, MERGE_HEAD still present) reason says the merge LANDED and names the leftover", r.ok === false && /landed/.test(r.reason ?? "") && /dddddddd/.test(r.reason ?? ""));
}

// ── DIRTY WORKTREE shape (round 2, item 4): a worktree already dirty BEFORE the merge was attempted —
// detected structurally (computeWorktreeGateStamp's own dirt check, read before the attempt), never by
// sniffing ort's "Your local changes … would be overwritten" stderr text. Never cached (reuses the
// existing `gateWorktreeDirty`/"worktree-dirty" outcome at the service.ts layer — see the companion e2e
// test for that proof); this file only proves the structural `dirtyWorktree` field itself.
{
  const { repo, wt } = makeRepoAndWorktree("dirty");
  // Round 3 fix: the dirt SIGNAL `computeWorktreeGateStamp` reads comes from this fake's own hardcoded
  // `status` response below (" M f.txt\0"), never from disk — `g` is a full fake, not a real-git proxy, so
  // it intercepts every call regardless of the worktree's actual on-disk state. See the REAL-GIT case
  // further below for an end-to-end proof against an actual `ort` "local changes" refusal.
  const g = (_p, _ms) => ({
    async raw(args) {
      const a = Array.isArray(args) ? args : [args];
      if (a[0] === "rev-parse" && a.includes("HEAD") && !a.includes("-q")) return `${HEAD_SHA}\n`;
      if (a[0] === "rev-parse" && a.includes("-q")) throw new Error("fatal: needed a single revision");
      if (a[0] === "merge-base") throw new Error("fake: no merge-base (never landed)");
      if (a[0] === "config") throw new Error("fake: no identity configured");
      if (a.includes("status")) return " M f.txt\0"; // real-shaped porcelain -z: one modified, tracked file
      if (a[0] === "ls-files") return ""; // not a content conflict — git refused before ever touching the index
      if (a.includes("merge") && a.includes("--no-edit")) throw new Error("error: Your local changes to the following files would be overwritten by merge:\n\tf.txt\nPlease commit your changes or stash them before you merge.");
      if (a.includes("merge") && a.includes("--abort")) return "";
      if (a.includes("diff")) return ""; // computeWorktreeGateStamp's own diff-for-hash read, best-effort
      throw new Error(`fake git: unhandled args ${JSON.stringify(a)}`);
    },
  });
  const r = await mergeMainIntoWorktree(repo, wt, { timeoutMs: 50, gitFactory: g });
  check("(dirty worktree) ok:false", r.ok === false);
  check("(dirty worktree) dirtyWorktree:true", r.ok === false && r.dirtyWorktree === true);
  check("(dirty worktree) transient is NOT set (dirt is its own distinct classification)", r.ok === false && !r.transient);
  check("(dirty worktree) conflict is NOT set (git refused before touching the index, never produced unmerged paths)", r.ok === false && !r.conflict);
}
{
  // NEGATIVE CONTROL: the identical merge error, but the worktree was NOT dirty beforehand — the generic
  // (non-dirty) classification applies, proving `dirtyWorktree` is read from the structural pre-check, not
  // merely sniffed from this exact error text appearing.
  const { repo, wt } = makeRepoAndWorktree("not-dirty-control");
  const g = (_p, _ms) => ({
    async raw(args) {
      const a = Array.isArray(args) ? args : [args];
      if (a[0] === "rev-parse" && a.includes("HEAD") && !a.includes("-q")) return `${HEAD_SHA}\n`;
      if (a[0] === "rev-parse" && a.includes("-q")) throw new Error("fatal: needed a single revision");
      if (a[0] === "merge-base") throw new Error("fake: no merge-base (never landed)");
      if (a[0] === "config") throw new Error("fake: no identity configured");
      if (a.includes("status")) return ""; // CLEAN this time — the only thing that differs from the scenario above
      if (a[0] === "ls-files") return "";
      if (a.includes("merge") && a.includes("--no-edit")) throw new Error("error: Your local changes to the following files would be overwritten by merge:\n\tf.txt\nPlease commit your changes or stash them before you merge.");
      if (a.includes("merge") && a.includes("--abort")) return "";
      throw new Error(`fake git: unhandled args ${JSON.stringify(a)}`);
    },
  });
  const r = await mergeMainIntoWorktree(repo, wt, { timeoutMs: 50, gitFactory: g });
  check("(negative control) dirtyWorktree is NOT set when the pre-check found the worktree clean", r.ok === false && !r.dirtyWorktree);
}

// ── REAL-GIT dirty worktree (round 3, item 3, optional-but-welcome): no gitFactory override at all — a
// genuinely uncommitted local edit to a tracked file, with main independently advancing on that SAME file,
// drives a REAL `ort` "Your local changes … would be overwritten by merge" refusal end to end.
{
  const { repo, wt } = makeRepoAndWorktree("dirty-real"); // base commit already has f.txt = "f\n"
  fs.writeFileSync(path.join(wt, "f.txt"), "locally modified, never committed\n"); // dirty — never git-added
  fs.writeFileSync(path.join(repo, "f.txt"), "main advance\n"); // main touches the SAME file independently
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", [...GIT_ID_ARGV, "commit", "-q", "-m", "main advance on f.txt"], { cwd: repo });
  const r = await mergeMainIntoWorktree(repo, wt);
  check("(dirty worktree, REAL git) ok:false", r.ok === false);
  check("(dirty worktree, REAL git) dirtyWorktree:true", r.ok === false && r.dirtyWorktree === true);
  check("(dirty worktree, REAL git) transient is NOT set", r.ok === false && !r.transient);
}

// ── DIRTY + CONFIRMED-KILL TIMEOUT (round 3, item 1): the SAME pre-existing dirt, but the merge call
// itself fails with a confirmed-kill-timeout-shaped error instead of the ort overwrite refusal. Must NOT
// classify dirtyWorktree (a plain "commit" is wrong advice when the interrupted merge may have folded
// partial residue into that same dirt) — falls through to the ordinary residue/transient handling, which
// must never mention "commit" either.
{
  const { repo, wt } = makeRepoAndWorktree("dirty-timeout");
  const g = (_p, _ms) => ({
    async raw(args) {
      const a = Array.isArray(args) ? args : [args];
      if (a[0] === "rev-parse" && a.includes("HEAD") && !a.includes("-q")) return `${HEAD_SHA}\n`;
      if (a[0] === "rev-parse" && a.includes("-q")) throw new Error("fatal: needed a single revision");
      if (a[0] === "merge-base") throw new Error("fake: no merge-base (never landed)");
      if (a[0] === "config") throw new Error("fake: no identity configured");
      if (a.includes("status")) return " M f.txt\0"; // dirty BEFORE the attempt, same as the plain dirty scenario
      if (a[0] === "ls-files") return "";
      if (a.includes("diff")) return "";
      if (a.includes("merge") && a.includes("--no-edit")) throw new Error("git merge main into worktree exceeded 50ms (hung git child?)");
      if (a.includes("merge") && a.includes("--abort")) return "";
      throw new Error(`fake git: unhandled args ${JSON.stringify(a)}`);
    },
  });
  const r = await mergeMainIntoWorktree(repo, wt, { timeoutMs: 50, gitFactory: g });
  check("(dirty + confirmed-kill timeout) ok:false", r.ok === false);
  check("(dirty + confirmed-kill timeout) dirtyWorktree is NOT set (round 3: timeout wins over pre-existing dirt)", r.ok === false && !r.dirtyWorktree);
  check("(dirty + confirmed-kill timeout) transient:true (falls through to the ordinary confirmed-kill handling)", r.ok === false && r.transient === true);
  check("(dirty + confirmed-kill timeout) residuePossible:true (the usual confirmed-kill residue note)", r.ok === false && r.residuePossible === true);
  // Word-boundary, not a bare substring match: "uncommitted" legitimately contains "commit" and must not
  // false-positive this check.
  check("(dirty + confirmed-kill timeout) reason never advises 'commit' — residue may need more than that", r.ok === false && !/\bcommit\b/i.test(r.reason ?? ""));
}

// ── OWED-LANDING transient sites (round 2, item 3) — the HELD-branch path's own two failure returns.
// (i) worktrees.ts ~6280: the bare-reads catch (rev-parse/computeOwedLanding/commit-tree) wrapping the
// landing computation — nothing lands from any of these reads, so the SAME "bare withTimeout, retry
// always safe" reasoning as the main-tip resolve applies.
{
  const { repo, wt } = makeRepoAndWorktree("owed-reads");
  const g = (_p, _ms) => ({
    async raw(args) {
      const a = Array.isArray(args) ? args : [args];
      if (a[0] === "rev-parse" && a.includes("HEAD") && !a.includes("-q") && !a.includes("--verify")) return `${HEAD_SHA}\n`; // main tip
      if (a[0] === "rev-parse" && a.includes("--verify") && a.includes("HEAD")) throw new Error("git rev-parse --verify HEAD (owed landing) exceeded 50ms (hung git child?)");
      throw new Error(`fake git: unhandled args ${JSON.stringify(a)}`);
    },
  });
  const r = await mergeMainIntoWorktree(repo, wt, { timeoutMs: 50, gitFactory: g }, "c".repeat(40), "loom/owed-test");
  check("(owed-landing, bare read timeout) ok:false, nothing lands", r.ok === false);
  check("(owed-landing, bare read timeout) transient:true", r.ok === false && r.transient === true);
}
{
  const e = Object.assign(new Error("spawn git EAGAIN"), { code: "EAGAIN" });
  const { repo, wt } = makeRepoAndWorktree("owed-reads-spawn");
  const g = (_p, _ms) => ({
    async raw(args) {
      const a = Array.isArray(args) ? args : [args];
      if (a[0] === "rev-parse" && a.includes("HEAD") && !a.includes("-q") && !a.includes("--verify")) return `${HEAD_SHA}\n`;
      if (a[0] === "rev-parse" && a.includes("--verify") && a.includes("HEAD")) throw e;
      throw new Error(`fake git: unhandled args ${JSON.stringify(a)}`);
    },
  });
  const r = await mergeMainIntoWorktree(repo, wt, { timeoutMs: 50, gitFactory: g }, "c".repeat(40), "loom/owed-test-spawn");
  check("(owed-landing, bare read spawn-transient) transient:true", r.ok === false && r.transient === true);
}
// (ii) worktrees.ts ~6326: the `--ff-only` retry-exhausted site — needs a REAL, coherent owed scenario
// (computeOwedLanding's merge-tree/commit-tree math only means something against real git objects), so
// this proxies a REAL canonicalGit and intercepts ONLY the `--ff-only` call, every attempt, with a
// confirmed-kill-timeout-shaped error — proving the retry fires and is genuinely exhausted (never a
// single-attempt shortcut), landing on the SAME classification as the plain-union path.
{
  const { repo, wt, base, branch } = makeOwedFixture("owedff");
  const proxyAlwaysFailFfOnly = (p, ms) => {
    const real = canonicalGit(p, ms);
    return {
      async raw(args) {
        const a = Array.isArray(args) ? args : [args];
        if (a.includes("merge") && a.includes("--ff-only")) throw new Error("git merge --ff-only (owed landing) exceeded 50ms (hung git child?)");
        return real.raw(args);
      },
    };
  };
  // Real git subprocess spawns (computeOwedLanding's own reads) need real wall-clock budget — unlike the
  // fake-gitFactory scenarios above (which reject synchronously regardless of timeoutMs), this one runs
  // REAL git underneath via the proxy, so 50ms is too tight a bound even on an idle host.
  const r = await mergeMainIntoWorktree(repo, wt, { timeoutMs: 5000, gitFactory: proxyAlwaysFailFfOnly }, base, branch);
  check("(owed-landing, --ff-only retry-exhausted) ok:false", r.ok === false);
  check("(owed-landing, --ff-only retry-exhausted) transient:true (a confirmed-kill timeout, not branch/main content)", r.ok === false && r.transient === true);
  // Precondition sanity: the SAME scenario with the failure removed actually lands (proves the fixture
  // itself is a genuinely coherent owed scenario, not one that would have failed for an unrelated reason).
  const rOk = await mergeMainIntoWorktree(repo, wt, { timeoutMs: 5000 }, base, branch);
  check("(owed-landing, --ff-only precondition) the SAME fixture lands for real with no injected failure", rOk.ok === true && rOk.merged === true);
}

// (iii) round 3, item 2: the owed-landing `--ff-only` path's own pre-attempt dirt check (worktrees.ts
// ~6298-6301) must match the plain-union path — dirtyWorktree:true on a NON-timeout failure against an
// already-dirty tree, but NEVER on a confirmed-kill timeout (falls through to the ordinary transient path).
{
  // A REAL dirty tree: an uncommitted local edit to the SAME file the owed commit's fast-forward would
  // need to update — a real `git merge --ff-only` refuses this for real ("local changes … overwritten").
  const { repo, wt, base, branch } = makeOwedFixture("owedff-dirty");
  fs.writeFileSync(path.join(wt, "base.txt"), "locally modified, never committed\n");
  const r = await mergeMainIntoWorktree(repo, wt, { timeoutMs: 5000 }, base, branch);
  check("(owed-landing, dirty + REAL non-timeout failure) ok:false", r.ok === false);
  check("(owed-landing, dirty + REAL non-timeout failure) dirtyWorktree:true", r.ok === false && r.dirtyWorktree === true);
  check("(owed-landing, dirty + REAL non-timeout failure) transient is NOT set", r.ok === false && !r.transient);
}
{
  // SAME dirty precondition, but the `--ff-only` call itself is forced to fail with a confirmed-kill
  // timeout instead — round 3's own point: a confirmed-kill timeout on an already-dirty tree must NOT be
  // relabeled dirtyWorktree (residue from the interrupted attempt could be folded in by a plain "commit").
  const { repo, wt, base, branch } = makeOwedFixture("owedff-dirty-timeout");
  fs.writeFileSync(path.join(wt, "base.txt"), "locally modified, never committed\n");
  const proxyAlwaysFailFfOnly = (p, ms) => {
    const real = canonicalGit(p, ms);
    return {
      async raw(args) {
        const a = Array.isArray(args) ? args : [args];
        if (a.includes("merge") && a.includes("--ff-only")) throw new Error("git merge --ff-only (owed landing) exceeded 50ms (hung git child?)");
        return real.raw(args);
      },
    };
  };
  const r = await mergeMainIntoWorktree(repo, wt, { timeoutMs: 5000, gitFactory: proxyAlwaysFailFfOnly }, base, branch);
  check("(owed-landing, dirty + confirmed-kill timeout) ok:false", r.ok === false);
  check("(owed-landing, dirty + confirmed-kill timeout) dirtyWorktree is NOT set (round 3: timeout wins)", r.ok === false && !r.dirtyWorktree);
  check("(owed-landing, dirty + confirmed-kill timeout) transient:true", r.ok === false && r.transient === true);
}

// ── "failed to resolve main tip" read-site (manager ruling: mark a TIMEOUT here transient too) ─────────────
{
  const wt = mkdtempManaged("loom-unionxc-maintip-wt-");
  const badRepoGit = (_p, _ms) => ({
    async raw(args) {
      const a = Array.isArray(args) ? args : [args];
      if (a[0] === "rev-parse" && a.includes("HEAD")) throw new Error("git rev-parse HEAD (main) exceeded 50ms (hung git child?)");
      throw new Error(`fake git: unhandled args ${JSON.stringify(a)}`);
    },
  });
  const r = await mergeMainIntoWorktree("fake-repo-path", wt, { timeoutMs: 50, gitFactory: badRepoGit });
  check("(main-tip resolve timeout) ok:false, nothing lands", r.ok === false);
  check("(main-tip resolve timeout) transient:true (manager ruling: nothing lands on this path, retry always safe)", r.ok === false && r.transient === true);
}
{
  const wt = mkdtempManaged("loom-unionxc-maintip-wt2-");
  const e = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
  const badRepoGit = (_p, _ms) => ({ async raw() { throw e; } });
  const r = await mergeMainIntoWorktree("fake-repo-path", wt, { timeoutMs: 50, gitFactory: badRepoGit });
  check("(main-tip resolve ENOENT) transient is NOT set (deterministic)", r.ok === false && !r.transient);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — mergeMainIntoWorktree's `transient` field correctly discriminates a momentary git-child " +
    "condition (confirmed-kill timeout, EAGAIN/EMFILE/ENFILE/EBUSY) from everything deterministic (a real " +
    "conflict, a CanonicalGitRefusal, ENOENT/EACCES, an unlisted spawn code, and an ordinary non-zero exit), " +
    "including at the bare-withTimeout main-tip-resolve read site. Round 2: the three LANDED returns never " +
    "set transient and say so honestly; a worktree dirty BEFORE the attempt classifies as dirtyWorktree, " +
    "never transient (with a negative control proving it's read from the structural pre-check); and the " +
    "owed-landing branch's own two transient sites (bare reads, and a real proxied --ff-only exhaustion) " +
    "match the plain-union path."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
