import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 4fa36502 — the MAINLINE-MOVE TRIPWIRE. REAL git on temp repos, driven through the REAL solo `confirmWorkerMerge` path (an injected
// always-green gate), so the hook placement (just before the squash, watermark advanced right after a landing) is what is under test.
//
//   (P)  the reflog message texts git really writes (pull / reset / merge / amend / commit) are NOT raw; a bare `update-ref` and a `-m` one ARE
//        (the classifier's whole premise — measured here, with a positive control, not assumed).
//   (U)  the PURE classifier: unchanged / explained / alert (each evidence kind) / rewind / unverifiable.
//   (S0) FIRST SIGHT: the first landing initialises the watermark SILENTLY (no event) and it equals the post-landing tip.
//   (S1) HUMAN moves are silent: a plain `git commit` and Loom's own human-REST `GitWriter.commit` on the canonical checkout.
//   (S1b) an UNCOMMITTED worker (branch tip == a canonical commit, from a human commit before its spawn) never looks like a bypass.
//   (S1d) a NO-COMMIT worker fast-forwarded / rebased (nothing to replay) onto a human commit never looks like a bypass; (S7a) attack D (a real rebase, then a forged write) still alerts;
//        (S7c) more fresh loom branches than the tip-check cap must not swallow the raw-write signal.
//   (S1c) >cap reflog entries BEFORE the watermark do not make a small move "unverifiable" (the cap bounds the window after W).
//   (S2) RED-FIRST: a worker worktree runs a bare `git update-ref refs/heads/<main> <its tip>` ⇒ ONE `mainline_moved_outside_loom` event with
//        BOTH evidences, ONE manager nudge, and the merge STILL lands (never a refusal); the next landing does not re-alert (watermark advanced).
//   (S3) a HUMAN `git reset --hard` (a rewind with a porcelain reflog message) is silent.
//   (S4) `update-ref -m "commit: x"` of a worker tip: the reflog looks porcelain, so ONLY the loom-branch-reachable evidence fires.
//   (S5) THE DOCUMENTED LIMIT: the same forged-message move after the worker's branch is deleted is NOT detected (pinned so nobody reads this as a sandbox).
//   (S6) a worker that also deletes its reflog entry is still caught by branch reachability (and only that).
//   (S7) a raw write onto a commit that is NOT a loom/* tip fires the reflog evidence only.
//   (S7b) TOCTOU: the watermark advances only when the landing sits directly on the tip that was checked.
//   (S8) FAIL-OPEN: a failing reader ⇒ the merge lands exactly as today, NO event, the watermark is NOT advanced past the unverified move — so
//        the very next landing (reader restored) still catches it.
//   (S9) BOUNDED: a >cap first-parent range ⇒ ONE low-severity "unverifiable" event (no nudge) and the watermark advances (no unbounded scan).
//
// NOT COVERED HERE: merge_batch and boot (mainline-watch-batch*.mjs / mainline-watch-boot.mjs); a worker that forges the message AND deletes its branch (S5); a `git -C <canon> commit`
// (byte-identical to a human commit); a bare canonical repo (no reflog).
// Run: 1) build daemon (pnpm build), 2) node test/mainline-watch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-mainline-watch-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { GitWriter } = await import("../dist/git/writer.js");
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
// NOT trimmed: a bare update-ref writes an EMPTY message, and trimming the output would swallow that leading empty line.
const reflogMsgs = (cwd, ref) => execFileSync("git", ["reflog", "show", "--format=%gs", ref], { cwd, encoding: "utf8", env: { ...process.env, ...IDENT } }).replace(/\r?\n$/, "").split(/\r?\n/);

// ============ (P) the reflog texts git really writes ============
{
  const root = mkdtempManaged("loom-mw-clone-");
  const remote = path.join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const up = path.join(root, "up"); fs.mkdirSync(up);
  git(up, "init", "-q", "-b", "main"); git(up, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(up, "a"), "a"); git(up, "add", "a"); git(up, "commit", "-q", "-m", "one");
  git(up, "remote", "add", "origin", remote); git(up, "push", "-q", "origin", "main");
  const cl = path.join(root, "cl"); git(root, "clone", "-q", remote, cl); git(cl, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(up, "b"), "b"); git(up, "add", "b"); git(up, "commit", "-q", "-m", "two"); git(up, "push", "-q", "origin", "main");
  git(cl, "pull", "-q", "--ff-only");
  const pullMsg = reflogMsgs(cl, "refs/heads/main")[0];
  git(cl, "reset", "-q", "--hard", "HEAD~1");
  const resetMsg = reflogMsgs(cl, "refs/heads/main")[0];
  git(cl, "branch", "side"); fs.writeFileSync(path.join(cl, "c"), "c"); git(cl, "add", "c"); git(cl, "commit", "-q", "-m", "three");
  git(cl, "commit", "-q", "--amend", "-m", "three-amended");
  const amendMsg = reflogMsgs(cl, "refs/heads/main")[0];
  git(cl, "branch", "side2", "HEAD~1"); git(cl, "checkout", "-q", "side2"); git(cl, "merge", "-q", "--ff-only", "main");
  const mergeMsg = reflogMsgs(cl, "refs/heads/side2")[0];
  git(cl, "checkout", "-q", "main"); fs.writeFileSync(path.join(cl, "d"), "d"); git(cl, "add", "d"); git(cl, "commit", "-q", "-m", "four");
  const commitMsg = reflogMsgs(cl, "refs/heads/main")[0];
  const fourSha = git(cl, "rev-parse", "HEAD");
  git(cl, "update-ref", "refs/heads/main", git(cl, "rev-parse", "HEAD~1"));
  const bareMsg = reflogMsgs(cl, "refs/heads/main")[0];
  git(cl, "update-ref", "-m", "sneaky", "refs/heads/main", fourSha);
  const forgedMsg = reflogMsgs(cl, "refs/heads/main")[0];
  console.log(`      measured reflog messages: pull=${JSON.stringify(pullMsg)} reset=${JSON.stringify(resetMsg)} amend=${JSON.stringify(amendMsg)} merge=${JSON.stringify(mergeMsg)} commit=${JSON.stringify(commitMsg)} bare=${JSON.stringify(bareMsg)} forged=${JSON.stringify(forgedMsg)}`);
  check("(P) `git pull --ff-only` writes a reflog message that is NOT raw", /^pull/.test(pullMsg) && !MW.isRawReflogMessage(pullMsg));
  check("(P) `git reset --hard` writes `reset: moving to …`, NOT raw", /^reset: moving to/.test(resetMsg) && !MW.isRawReflogMessage(resetMsg));
  check("(P) `git commit --amend` is NOT raw", /^commit \(amend\)/.test(amendMsg) && !MW.isRawReflogMessage(amendMsg));
  check("(P) `git merge --ff-only` is NOT raw", /^merge/.test(mergeMsg) && !MW.isRawReflogMessage(mergeMsg));
  check("(P) a plain `git commit` is NOT raw", /^commit:/.test(commitMsg) && !MW.isRawReflogMessage(commitMsg));
  check("(P) POSITIVE CONTROL: a bare `git update-ref` writes an EMPTY message and IS raw", bareMsg === "" && MW.isRawReflogMessage(bareMsg));
  check("(P) `update-ref -m sneaky` is raw (any non-porcelain text); a forged `commit: x` would NOT be (the documented spoof)", MW.isRawReflogMessage(forgedMsg) && !MW.isRawReflogMessage("commit: x"));
}

// ============ (U) the pure classifier ============
{
  const W = "a".repeat(40), T = "b".repeat(40), X = "c".repeat(40);
  const base = { branch: "main", tip: T, reflog: [{ sha: T, msg: "commit: human" }, { sha: W, msg: "commit: prev" }], forward: true, untrailered: [T], loomTipHits: [], truncated: false, watermarkMissing: false };
  check("(U) tip == W ⇒ unchanged", MW.classifyMainlineMove(W, { ...base, tip: W }).verdict === "unchanged");
  check("(U) a porcelain human commit ⇒ explained (silent)", MW.classifyMainlineMove(W, base).verdict === "explained");
  const raw = MW.classifyMainlineMove(W, { ...base, reflog: [{ sha: T, msg: "" }, { sha: W, msg: "commit: prev" }] });
  check("(U) an empty-message reflog entry over an untrailered commit ⇒ alert reflog-raw-write, suspect = that commit", raw.verdict === "alert" && raw.evidence.join() === "reflog-raw-write" && raw.suspectShas.join() === T);
  check("(U) a raw entry over ONLY Loom-trailered commits (untrailered empty) ⇒ explained", MW.classifyMainlineMove(W, { ...base, untrailered: [], reflog: [{ sha: T, msg: "" }, { sha: W, msg: "x" }] }).verdict === "explained");
  check("(U) a loom/* tip reachable ⇒ alert loom-branch-reachable even with a porcelain message", MW.classifyMainlineMove(W, { ...base, untrailered: [], loomTipHits: [X] }).evidence.join() === "loom-branch-reachable");
  check("(U) a rewind with a raw entry ⇒ alert rewind-raw-write; with a porcelain entry ⇒ explained", MW.classifyMainlineMove(W, { ...base, forward: false, reflog: [{ sha: T, msg: "" }, { sha: W, msg: "x" }] }).evidence.join() === "rewind-raw-write" && MW.classifyMainlineMove(W, { ...base, forward: false, reflog: [{ sha: T, msg: "reset: moving to HEAD~1" }, { sha: W, msg: "x" }] }).verdict === "explained");
  check("(U) W absent from the reflog ⇒ the reflog signal is UNAVAILABLE (older raw entries are never blamed on this move)", MW.classifyMainlineMove(W, { ...base, reflog: [{ sha: T, msg: "" }, { sha: X, msg: "" }] }).verdict === "explained");
  check("(U) reflog unavailable (null) ⇒ only branch reachability can alert", MW.classifyMainlineMove(W, { ...base, reflog: null }).verdict === "explained" && MW.classifyMainlineMove(W, { ...base, reflog: null, loomTipHits: [X] }).verdict === "alert");
  check("(U) truncated / watermarkMissing ⇒ unverifiable", MW.classifyMainlineMove(W, { ...base, truncated: true }).verdict === "unverifiable" && MW.classifyMainlineMove(W, { ...base, watermarkMissing: true }).verdict === "unverifiable");
  check("(U) suspectShas is capped at 10", MW.classifyMainlineMove(W, { ...base, untrailered: Array.from({ length: 30 }, (_, i) => String(i).padStart(40, "0")), reflog: [{ sha: T, msg: "" }, { sha: W, msg: "x" }] }).suspectShas.length === 10);
  check("(U) watermark parse: garbage / short sha ⇒ null, good JSON round-trips", MW.parseMainlineWatermark("nope") === null && MW.parseMainlineWatermark(JSON.stringify({ branch: "m", sha: "abc" })) === null && MW.parseMainlineWatermark(JSON.stringify({ branch: "m", sha: W }))?.sha === W);
  check("(U) isAuthoredBranchReflog: commit / amend / cherry-pick / non-ff merge / a rebase that replayed (tip != onto) AUTHOR a new commit",
    MW.isAuthoredBranchReflog("commit: work", T) && MW.isAuthoredBranchReflog("commit (amend): w", T) && MW.isAuthoredBranchReflog("cherry-pick: w", T)
    && MW.isAuthoredBranchReflog("merge main: Merge made by the 'ort' strategy.", T) && MW.isAuthoredBranchReflog(`rebase (finish): refs/heads/loom/x onto ${W}`, T));
  check("(U) isAuthoredBranchReflog: creation, a fast-forward, a no-op rebase (tip == onto) and a reset do NOT — the ref only moved onto a commit main already had",
    !MW.isAuthoredBranchReflog("branch: Created from HEAD", T) && !MW.isAuthoredBranchReflog(`merge ${T}: Fast-forward`, T) && !MW.isAuthoredBranchReflog(`rebase (finish): refs/heads/loom/x onto ${T}`, T) && !MW.isAuthoredBranchReflog("reset: moving to HEAD~1", T) && !MW.isAuthoredBranchReflog("", T));
}

// ============ fixtures ============
const P = { projId: `mw-proj-${sfx}`, agentId: `mw-agent-${sfx}`, mgrId: `mw-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mw-repo-${sfx}`) };
fs.mkdirSync(P.repo, { recursive: true }); registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# mw\n");
git(P.repo, "init", "-q"); git(P.repo, "config", "core.autocrlf", "false"); git(P.repo, "config", "user.email", "mw@loom"); git(P.repo, "config", "user.name", "mw");
commitAll(P.repo, "init", GIT_ID);
const MAIN = git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const MAINREF = `refs/heads/${MAIN}`;
const db = new Db();
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => ({ passed: true, steps: [] }), reapWorktreeProcesses: noReap });
const nudges = [];
const origEnqueue = sessions.enqueueDurableMessage.bind(sessions);
sessions.enqueueDurableMessage = (target, text, ...rest) => { if (String(text).startsWith("[loom:mainline-moved]")) nudges.push(text); return origEnqueue(target, text, ...rest); };
db.insertProject({ id: P.projId, name: "MW", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
let seq = 0;
async function addWorker(tag) {
  const n = `${tag}${++seq}`;
  const taskId = `mw-${n}-task-${sfx}`, workerId = `mw-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  fs.mkdirSync(path.join(worktreePath, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "src", `${n}.ts`), `export const ${tag}${seq} = ${seq};\n`);
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch, tip: git(worktreePath, "rev-parse", "HEAD") };
}
/** A worker that has been spawned but has committed NOTHING: its branch tip IS the canonical commit it was cut from (createWorktree cuts off current HEAD). */
async function addWorkerUncommitted(tag) {
  const n = `${tag}${++seq}`;
  const taskId = `mw-${n}-task-${sfx}`, workerId = `mw-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch, tip: git(worktreePath, "rev-parse", "HEAD") };
}
const confirm = async (w) => { const r = await sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId); return r.settled && r.ok ? r.value : { __unsettled: r }; };
const evFor = (w) => db.listEventsForWorker(w.workerId).filter((e) => e.kind === "mainline_moved_outside_loom");
const watermark = () => MW.parseMainlineWatermark(db.getMeta(MW.mainlineWatermarkKey(P.projId, "primary")));
const canonHead = () => git(P.repo, "rev-parse", "HEAD");
/** A worker's bare `git update-ref` of the canonical branch, run FROM ITS OWN WORKTREE, then the human-ish `reset --hard` that clears the canonical checkout's now-stale index. */
const bypass = (w, target, opts = {}) => {
  git(w.worktreePath, "update-ref", ...(opts.message ? ["-m", opts.message] : []), MAINREF, target ?? w.tip);
  git(P.repo, "reset", "-q", "--hard");
};

try {
  // ── (S0) first sight is silent ─────────────────────────────────────────────
  const a = await addWorker("a");
  check("(S0) before the first landing there is no watermark", watermark() === null);
  const ra = await confirm(a);
  check("(S0) the first landing merged", ra.merged === true);
  check("(S0) FIRST SIGHT: no event and no nudge", evFor(a).length === 0 && nudges.length === 0);
  check("(S0) the watermark now equals the canonical tip (advanced after the landing) on the canonical branch", watermark()?.sha === canonHead() && watermark()?.branch === MAIN);

  // ── (S1) human moves are silent ────────────────────────────────────────────
  fs.writeFileSync(path.join(P.repo, "human1.txt"), "h1\n"); git(P.repo, "add", "human1.txt"); git(P.repo, "commit", "-q", "-m", "docs: human commit");
  fs.writeFileSync(path.join(P.repo, "human2.txt"), "h2\n");
  const wr = await new GitWriter(P.repo).commit("docs: human REST writer commit");
  check("(S1) the human-REST GitWriter.commit succeeded on the canonical checkout (setup control)", wr.ok === true);
  const b = await addWorker("b");
  const rb = await confirm(b);
  check("(S1) a human `git commit` + a GitWriter commit ⇒ landing merges, NO event, NO nudge", rb.merged === true && evFor(b).length === 0 && nudges.length === 0);
  check("(S1) the watermark advanced over the human commits to the new landing", watermark()?.sha === canonHead());

  // ── (S1b) an UNCOMMITTED worker's branch tip is a canonical commit — must never look like a bypass ──
  fs.writeFileSync(path.join(P.repo, "human3.txt"), "h3\n"); git(P.repo, "add", "human3.txt"); git(P.repo, "commit", "-q", "-m", "docs: human commit before a spawn");
  const u = await addWorkerUncommitted("u");
  check("(S1b) setup control: the uncommitted worker's branch tip IS the canonical head (the shape that used to false-alert)", u.tip === canonHead());
  const x1 = await addWorker("x");
  const rx1 = await confirm(x1);
  check("(S1b) human commit → a fresh UNCOMMITTED worker → another worker lands ⇒ merges, NO event, NO nudge", rx1.merged === true && evFor(x1).length === 0 && nudges.length === 0);

  // ── (S1d) a NO-COMMIT worker that forward-moves onto a human commit must never look like a bypass ──
  {
    const ue = await addWorkerUncommitted("ue"), ue2 = await addWorkerUncommitted("ue");
    fs.writeFileSync(path.join(P.repo, "human4.txt"), "h4\n"); git(P.repo, "add", "human4.txt"); git(P.repo, "commit", "-q", "-m", "docs: human commit after two spawns");
    const h4 = canonHead();
    git(ue.worktreePath, "merge", "--no-edit", h4); // the exact shape of Loom's own mergeMainIntoWorktree: a fast-forward of a no-commit branch
    git(ue2.worktreePath, "rebase", MAIN);            // a rebase with nothing to replay
    const ueMsg = reflogMsgs(P.repo, "refs/heads/" + ue.branch)[0], ue2Msg = reflogMsgs(P.repo, "refs/heads/" + ue2.branch)[0];
    console.log(`      measured no-commit-branch reflog messages: merge-ff=${JSON.stringify(ueMsg)} rebase=${JSON.stringify(ue2Msg)}`);
    check("(S1d) setup controls: both no-commit branches now sit exactly on the human commit, via a `merge …: Fast-forward` and a `rebase (finish)` reflog entry", git(ue.worktreePath, "rev-parse", "HEAD") === h4 && git(ue2.worktreePath, "rev-parse", "HEAD") === h4 && /^merge .*Fast-forward/.test(ueMsg) && /^rebase \(finish\)/.test(ue2Msg));
    const x2 = await addWorker("x");
    const rx2 = await confirm(x2);
    check("(S1d) E/E2: no-commit workers fast-forwarded / rebased onto a human commit ⇒ landing merges, NO event, NO nudge", rx2.merged === true && evFor(x2).length === 0 && nudges.length === 0);
  }

  // ── (S1c) a reflog with >cap entries BEFORE W must not make a small move "unverifiable" ──
  {
    const logFile = path.join(git(P.repo, "rev-parse", "--git-common-dir") === ".git" ? path.join(P.repo, ".git") : git(P.repo, "rev-parse", "--git-common-dir"), "logs", "refs", "heads", MAIN);
    const seedSha = canonHead();
    const seed = Array.from({ length: MW.MAINLINE_RANGE_CAP + 20 }, (_, i) => `${seedSha} ${seedSha} mw <mw@loom> ${1_600_000_000 + i} +0000	commit: seeded history ${i}
`).join("");
    fs.writeFileSync(logFile, seed + fs.readFileSync(logFile, "utf8"));
    check("(S1c) setup control: the main reflog now holds MORE than the cap of entries", reflogMsgs(P.repo, MAINREF).length > MW.MAINLINE_RANGE_CAP);
  }

  // ── (S2) RED-FIRST: a worker's bare update-ref ─────────────────────────────
  const c = await addWorker("c"), d = await addWorker("d");
  bypass(c);
  check("(S2) setup control: the worker's write DID move the canonical branch to its tip", canonHead() === c.tip);
  const rd = await confirm(d);
  const evD = evFor(d);
  check("(S2) the landing STILL merges (a tripwire, never a refusal)", rd.merged === true);
  check("(S2) exactly ONE mainline_moved_outside_loom event, severity high — even with >cap reflog entries BEFORE the watermark", evD.length === 1 && evD[0].detail.severity === "high");
  check("(S2) it carries BOTH evidences", evD[0]?.detail.evidence?.includes("reflog-raw-write") && evD[0]?.detail.evidence?.includes("loom-branch-reachable"));
  check("(S2) it names the worker's tip as a suspect and from/to/branch/repoKey/projectId", evD[0]?.detail.suspectShas?.includes(c.tip) && evD[0]?.detail.to === c.tip && evD[0]?.detail.branch === MAIN && evD[0]?.detail.repoKey === "primary" && evD[0]?.detail.projectId === P.projId);
  check("(S2) exactly ONE manager nudge, tagged and naming the branch", nudges.length === 1 && /\[loom:mainline-moved\]/.test(nudges[0]) && nudges[0].includes(MAIN));
  const e = await addWorker("e");
  await confirm(e);
  check("(S2) DEDUPE: the next landing does not re-alert (watermark advanced past the move)", evFor(e).length === 0 && nudges.length === 1);

  // ── (S3) a human reset is silent ───────────────────────────────────────────
  git(P.repo, "reset", "-q", "--hard", "HEAD~1");
  const f = await addWorker("f");
  const rf = await confirm(f);
  check("(S3) a human `git reset --hard HEAD~1` (rewind, porcelain reflog message) ⇒ merges, NO event", rf.merged === true && evFor(f).length === 0 && nudges.length === 1);

  // ── (S4) forged reflog message: only reachability fires ────────────────────
  const g = await addWorker("g"), h = await addWorker("h");
  bypass(g, g.tip, { message: "commit: x" });
  await confirm(h);
  check("(S4) `update-ref -m \"commit: x\"` of a worker tip ⇒ an event with ONLY loom-branch-reachable", evFor(h).length === 1 && evFor(h)[0].detail.evidence.join() === "loom-branch-reachable");

  // ── (S5) the documented limit: forged message + deleted branch ────────────
  const i = await addWorker("i"), j = await addWorker("j");
  bypass(i, i.tip, { message: "commit: x" });
  git(P.repo, "worktree", "remove", "--force", i.worktreePath);
  git(P.repo, "branch", "-D", i.branch);
  const nudgesBefore = nudges.length;
  const rj = await confirm(j);
  check("(S5) DOCUMENTED LIMIT: forged message + deleted branch is NOT detected (a tripwire, not a sandbox)", rj.merged === true && evFor(j).length === 0 && nudges.length === nudgesBefore);

  // ── (S6) reflog entry deleted, branch kept ─────────────────────────────────
  const k = await addWorker("k"), l = await addWorker("l");
  const rawBefore = reflogMsgs(P.repo, MAINREF).filter((m) => m === "").length;
  git(k.worktreePath, "update-ref", MAINREF, k.tip); // bare (raw message)…
  const rawMid = reflogMsgs(P.repo, MAINREF).filter((m) => m === "").length;
  git(P.repo, "reflog", "delete", `${MAINREF}@{0}`); // …then erased
  git(P.repo, "reset", "-q", "--hard");
  check("(S6) setup control: the bare write really added a raw reflog entry, and the delete really removed it (S2/S7's own raw entries are untouched)", rawMid === rawBefore + 1 && reflogMsgs(P.repo, MAINREF).filter((m) => m === "").length === rawBefore);
  await confirm(l);
  check("(S6) a deleted reflog entry is still caught by branch reachability — and ONLY that signal fires", evFor(l).length === 1 && evFor(l)[0].detail.evidence.join() === "loom-branch-reachable");

  // ── (S7) raw write onto a non-loom commit ──────────────────────────────────
  const m = await addWorker("m"), n = await addWorker("n");
  const orphanCommit = git(m.worktreePath, "commit-tree", "-p", canonHead(), "-m", "sneaky", `${canonHead()}^{tree}`);
  git(m.worktreePath, "update-ref", MAINREF, orphanCommit);
  git(P.repo, "reset", "-q", "--hard");
  await confirm(n);
  check("(S7) a bare update-ref onto a commit no loom/* branch holds ⇒ ONLY reflog-raw-write", evFor(n).length === 1 && evFor(n)[0].detail.evidence.join() === "reflog-raw-write" && evFor(n)[0].detail.suspectShas.includes(orphanCommit));

  // ── (S7a) ATTACK D: rebase onto a human commit (a REAL replay, new commit objects) then a forged-message write ──
  {
    const dw = await addWorker("dw");
    fs.writeFileSync(path.join(P.repo, "human5.txt"), "h5\n"); git(P.repo, "add", "human5.txt"); git(P.repo, "commit", "-q", "-m", "docs: human commit under a worker");
    git(dw.worktreePath, "rebase", MAIN);
    const rebased = git(dw.worktreePath, "rev-parse", "HEAD");
    check("(S7a) setup control: the rebase really replayed the worker's commit onto a NEW object", rebased !== dw.tip && rebased !== canonHead());
    bypass(dw, rebased, { message: "commit: x" });
    const dl = await addWorker("dl");
    await confirm(dl);
    check("(S7a) ATTACK D still alerts (loom-branch-reachable) — a real rebase authors a new commit, unlike a no-op forward", evFor(dl).length === 1 && evFor(dl)[0].detail.evidence.join() === "loom-branch-reachable");
  }

  // ── (S7c) MORE fresh loom branches than the tip-check cap must not swallow the raw-write signal ──
  {
    fs.writeFileSync(path.join(P.repo, "human6.txt"), "h6\n"); git(P.repo, "add", "human6.txt"); git(P.repo, "commit", "-q", "-m", "docs: human commit before many spawns");
    for (let i = 0; i < MW.MAINLINE_LOOM_TIP_CHECK_CAP + 1; i++) git(P.repo, "branch", `loom/fresh-${sfx}-${i}`);
    const cw = await addWorker("cw"), dz = await addWorker("dz");
    bypass(cw);
    await confirm(dz);
    check("(S7c) 21 benign fresh branches + a bare update-ref bypass ⇒ ONE HIGH event with the reflog-raw-write evidence (not 'unverifiable')", evFor(dz).length === 1 && evFor(dz)[0].detail.severity === "high" && evFor(dz)[0].detail.evidence.includes("reflog-raw-write"));
  }

  // ── (S7b) the watermark advance only fires when the landing sat directly on the tip that was checked ──
  {
    const key = MW.mainlineWatermarkKey(P.projId, "primary");
    const before = watermark();
    const headTip = canonHead();
    const parentOfHead = git(P.repo, "rev-parse", "HEAD~1");
    db.setMeta(key, JSON.stringify({ branch: MAIN, sha: before.sha }));
    await sessions.advanceMainlineWatermark(P.projId, "primary", P.repo, "f".repeat(40));
    check("(S7b) TOCTOU: a landing whose first parent is NOT the checked tip leaves the watermark UNCHANGED (a move in the window stays catchable)", watermark()?.sha === before.sha);
    await sessions.advanceMainlineWatermark(P.projId, "primary", P.repo, parentOfHead);
    check("(S7b) …while a landing sitting directly on the checked tip advances it to the new tip", watermark()?.sha === headTip);
  }

  // ── (S8) FAIL-OPEN ─────────────────────────────────────────────────────────
  const o = await addWorker("o"), p = await addWorker("p"), q = await addWorker("q");
  const oc = git(o.worktreePath, "commit-tree", "-p", canonHead(), "-m", "sneaky2", `${canonHead()}^{tree}`);
  git(o.worktreePath, "update-ref", MAINREF, oc);
  git(P.repo, "reset", "-q", "--hard");
  const wBefore = watermark()?.sha;
  const nudgesS8 = nudges.length;
  const realReader = sessions.mainlineFactsReader;
  sessions.mainlineFactsReader = async () => { throw new Error("injected reader failure"); };
  const warn = console.warn; const warned = []; console.warn = (...args) => { warned.push(args.join(" ")); };
  let rp; try { rp = await confirm(p); } finally { console.warn = warn; }
  check("(S8) FAIL-OPEN: a throwing reader ⇒ the merge lands exactly as today", rp.merged === true);
  check("(S8) …with NO event and NO new nudge", evFor(p).length === 0 && nudges.length === nudgesS8);
  check("(S8) …the failure is logged, not swallowed silently", warned.some((w) => /mainline-watch\] check skipped \(fail-open\).*injected reader failure/.test(w)));
  check("(S8) …and the watermark was NOT advanced past the unverified move (so it stays catchable)", watermark()?.sha === wBefore);
  sessions.mainlineFactsReader = realReader;
  await confirm(q);
  check("(S8) once the reader works again, the still-unverified move IS caught (reflog-raw-write)", evFor(q).length === 1 && evFor(q)[0].detail.evidence.includes("reflog-raw-write") && evFor(q)[0].detail.suspectShas.includes(oc));

  // ── (S9) BOUNDED: > cap first-parent range ⇒ one low-severity event ───────
  const r = await addWorker("r"), s = await addWorker("s");
  const total = MW.MAINLINE_RANGE_CAP + 10;
  const stream = []; let parent = canonHead();
  for (let k2 = 0; k2 < total; k2++) {
    const msg = `bulk ${k2}`;
    stream.push(`commit ${MAINREF}\ncommitter mw <mw@loom> ${1_700_000_000 + k2} +0000\ndata ${Buffer.byteLength(msg)}\n${msg}\n${k2 === 0 ? `from ${parent}\n` : ""}M 100644 inline bulk.txt\ndata ${Buffer.byteLength(String(k2))}\n${k2}\n`);
  }
  execFileSync("git", ["fast-import", "--quiet"], { cwd: P.repo, input: stream.join("\n") + "\n", env: { ...process.env, ...IDENT } });
  git(P.repo, "reset", "-q", "--hard");
  const nudgesPre = nudges.length;
  const rs = await confirm(s);
  const evS = evFor(s);
  check("(S9) the landing merges", rs.merged === true);
  check("(S9) BOUNDED: exactly ONE event, severity LOW + unverifiable, naming the reason (asserting what survives the cap, not just that it engaged)", evS.length === 1 && evS[0].detail.severity === "low" && evS[0].detail.unverifiable === true && /cap/.test(evS[0].detail.reason) && evS[0].detail.from && evS[0].detail.to);
  check("(S9) …no nudge for the low-severity case", nudges.length === nudgesPre);
  check("(S9) …and the watermark advanced (no unbounded rescan next time)", watermark()?.sha === canonHead());
  void r;

  // ── negative control: nothing ever alerted for a landing that only had explained moves ──
  check("(control) every alert above was one of the deliberate bypass landings (d,h,l,n,q high; s low) — no stray event on a, b, e, f, j, p", [a, b, e, f, j, p].every((w) => evFor(w).length === 0));
} finally {
  try { db.close(); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the mainline tripwire alerts on a worker's raw ref write, stays silent on human moves and Loom landings, and never blocks the merge."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
