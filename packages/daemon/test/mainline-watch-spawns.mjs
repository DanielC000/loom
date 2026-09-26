import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0eb7ff27 — the mainline tripwire's authored-tip reflog check is ONE git call (card 4fa36502, docs/decisions/4fa36502-mainline-move-tripwire.md). REAL git on temp repos. (The deadline cases live in mainline-watch-bounds.mjs — split so each file stays well under the harness ceiling.)
//
//   (G)  SPAWNS: the authored-tip reflog check is ONE `git log -g` over every candidate ref, not one `git reflog show` per tip. Counted from git's own trace2 log (top-level
//        processes only), it is the SAME number for 3 candidate tips and for 12 — and it still tells authored tips from moved-onto ones per branch. When the shared read
//        fills its own cap it falls back to the exact per-branch reads (same answer, more spawns).
//   (G2) a suffix-sharing ref (refs/heads/loom/0/loom/a vs refs/heads/loom/a) must not steal the other branch's reflog entries: attribution is by the EXACT full ref (%gD).
// Run: 1) build daemon (pnpm build), 2) node test/mainline-watch-spawns.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-mainline-spawns-home-");
const traceDir = mkdtempManaged("loom-mw-trace-");
const TRACE = path.join(traceDir, "trace2.jsonl");
process.env.GIT_TRACE2_EVENT = TRACE; // every git process (fixture AND daemon) appends its events here

const MW = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "mw", GIT_AUTHOR_EMAIL: "mw@loom", GIT_COMMITTER_NAME: "mw", GIT_COMMITTER_EMAIL: "mw@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=mw@loom -c user.name=mw";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const NEVER = () => new Promise(() => {});
/** Top-level git processes recorded so far (a child process's sid contains a "/"). */
const traceLines = () => (fs.existsSync(TRACE) ? fs.readFileSync(TRACE, "utf8").split("\n").filter(Boolean) : []).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const topStarts = () => traceLines().filter((e) => e.event === "start" && !String(e.sid).includes("/"));
const withWatchdog = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`WATCHDOG: ${what} did not return in ${ms}ms`)), ms))]);

function initRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-mwb-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# mwb\n");
  git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "mw@loom"); git(repo, "config", "user.name", "mw");
  commitAll(repo, "init", GIT_ID);
  return repo;
}
const mainOf = (repo) => git(repo, "rev-parse", "--abbrev-ref", "HEAD");
const treeOf = (repo, c) => git(repo, "rev-parse", `${c}^{tree}`);

/**
 * W = the tip now; then `authored` loom branches each CREATE a commit (`update-ref -m "commit: …"`, the reflog line a real `git commit` writes) that is merged into main
 * by a porcelain-looking merge commit, and `moved` loom branches are cut (a `branch: Created` reflog line) at those merge commits. Only the `authored` tips are bypass evidence.
 */
function scenario(tag, authored, moved) {
  const repo = initRepo(tag), main = mainOf(repo);
  const w = git(repo, "rev-parse", "HEAD");
  let cur = w; const authoredTips = [], movedTips = [];
  for (let i = 0; i < authored; i++) {
    const c = git(repo, "commit-tree", "-p", cur, "-m", `work ${i}`, treeOf(repo, cur));
    git(repo, "update-ref", "-m", "commit: work", `refs/heads/loom/a-${sfx}-${i}`, c);
    authoredTips.push(c);
    const m = git(repo, "commit-tree", "-p", cur, "-p", c, "-m", `merge a${i}`, treeOf(repo, cur));
    git(repo, "update-ref", "-m", `merge loom/a-${i}: Merge made by the 'ort' strategy.`, `refs/heads/${main}`, m);
    cur = m;
    if (i < moved) { git(repo, "branch", `loom/m-${sfx}-${i}`, m); movedTips.push(m); }
  }
  for (let i = authored; i < moved; i++) { git(repo, "branch", `loom/m-${sfx}-${i}`, cur); movedTips.push(cur); }
  git(repo, "reset", "-q", "--hard");
  return { repo, main, w, tip: git(repo, "rev-parse", "HEAD"), authoredTips, movedTips };
}
const readFacts = async (s) => {
  const before = topStarts().length;
  const facts = await MW.readMainlineFacts(s.repo, s.w, { branch: s.main, tip: s.tip }, 5000);
  return { facts, spawns: topStarts().length - before };
};
const setEq = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

// ============ (G) spawns ============
{
  const s3 = scenario("g3", 3, 1), s12 = scenario("g12", 8, 4);
  const r3 = await readFacts(s3), r12 = await readFacts(s12);
  console.log(`      git spawns for one facts read: 3 authored + 1 moved candidate => ${r3.spawns}; 8 authored + 4 moved => ${r12.spawns} (per-tip reflog reads would be 7 + candidates)`);
  check("(G) setup control: trace2 really records the daemon's git processes (the count is not vacuously 0)", r3.spawns >= 6);
  check("(G) authored tips are hits and moved-onto tips are NOT — per-branch discrimination survives the single read (3+1)", setEq(r3.facts.loomTipHits, s3.authoredTips));
  check("(G) …and at 8+4 candidates", setEq(r12.facts.loomTipHits, s12.authoredTips));
  check("(G) the signal was not skipped and the reflog was read", !r12.facts.loomTipsSkipped && r12.facts.reflog !== null);
  check("(G) SPAWNS: the count does NOT grow with the candidate count (4 vs 12 candidate tips ⇒ same number of git processes)", r3.spawns === r12.spawns);
  check("(G) SPAWNS: at most 8 git processes for the whole facts read (rev-parse, merge-base, reflog, log, for-each-ref, rev-list, log --no-walk, ONE log -g)", r12.spawns <= 8);

  // The shared read fills its own cap (a chatty branch could crowd another out) ⇒ exact per-branch fallback: same answer, one more spawn per candidate.
  const f = scenario("gf", 1, 1), gitDir = path.join(f.repo, ".git");
  const root = git(f.repo, "rev-list", "--max-parents=0", "HEAD");
  const seed = (ref) => {
    const file = path.join(gitDir, "logs", "refs", "heads", ...ref.split("/"));
    const lines = Array.from({ length: MW.MAINLINE_RANGE_CAP + 20 }, (_, i) => `${root} ${root} mw <mw@loom> ${1_600_000_000 + i} +0000\tcommit: seeded ${i}\n`).join("");
    fs.writeFileSync(file, lines + fs.readFileSync(file, "utf8"));
  };
  for (const ref of git(f.repo, "for-each-ref", "--format=%(refname)", "refs/heads/loom/").split("\n")) seed(ref.replace(/^refs\/heads\//, ""));
  const rf = await readFacts(f);
  console.log(`      cap-full fallback: 2 candidates with ${MW.MAINLINE_RANGE_CAP + 21} reflog entries each => ${rf.spawns} git processes`);
  check("(G) FALLBACK: when the shared read fills its cap, the per-branch reads run (one extra process per candidate: 2 here) and the answer is unchanged", rf.spawns === r12.spawns + 2 && setEq(rf.facts.loomTipHits, f.authoredTips));
}

// ============ (G2) a suffix-sharing ref must not steal another branch's reflog entries ============
{
  const repo = initRepo("gs"), main = mainOf(repo), w = git(repo, "rev-parse", "HEAD");
  const c = git(repo, "commit-tree", "-p", w, "-m", "work", treeOf(repo, w));
  git(repo, "update-ref", "-m", "commit: work", "refs/heads/loom/a", c); // AUTHORED
  const m = git(repo, "commit-tree", "-p", w, "-p", c, "-m", "merge a", treeOf(repo, w));
  git(repo, "update-ref", "-m", "merge loom/a: Merge made by the 'ort' strategy.", `refs/heads/${main}`, m);
  git(repo, "branch", "loom/0/loom/a", m); // sorts BEFORE loom/a, and its ref ends with "/loom/a" — moved-onto only, never authored
  git(repo, "reset", "-q", "--hard");
  const r = await readFacts({ repo, main, w, tip: m });
  check("(G2) refs/heads/loom/a (authored) is still a hit although refs/heads/loom/0/loom/a (sorted first, same suffix) is a candidate too — reflog entries are attributed by EXACT full ref", setEq(r.facts.loomTipHits, [c]));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the authored-tip reflog check is one git call (spawn count independent of the candidate count) and attributes entries by exact ref."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
