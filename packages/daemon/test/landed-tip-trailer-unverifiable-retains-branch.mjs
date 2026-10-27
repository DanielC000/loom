import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision f2b4d684 — pinnedTipForLandedSquash must return `{}` for an UNVERIFIABLE trailer — never
// `legacyTip` (a fresh live read trivially matches finalize's CAS) and never the SOLO_TIP_UNVERIFIABLE
// literal itself (persisting it let a LATER call read it back as a live git revision argument).
//
// END-TO-END proof, through SessionService.confirmWorkerMerge(Tracked), that this holds for every way a
// trailer can go UNVERIFIABLE: `landed-tip-trailer-producer-validation.mjs` tests the PRODUCER's own
// three-way ABSENT/VALID/UNVERIFIABLE split in isolation; this file tests the CALLER.
//
// (b) THE REAL REPRO (gc'd-genuine): land normally, then the worker REWRITES its own landed commit
//     (`commit --amend`, same tree — a real, legitimate operation, not an attack) and adds a late
//     whole-file revert; `git reflog expire --all` + `git gc --prune=now` on the CANONICAL repo then
//     actually DELETES the now-unreachable original commit object the trailer named. Branch must be KEPT.
// (c-i) FORGED: the canonical squash's own trailer is amended post-hoc to a 50-hex ref-name-shaped decoy
//     with a planted same-named tag pointing at an unrelated commit. Branch must be KEPT.
// (c-ii) THROWN VALIDATION: no gc, no forgery — a fault-injected `alreadyLandedGitFactory` throws on the
//     validation call (`cat-file`/`^{object}`) only. Branch must be KEPT.
// (c-iii) OUTER READ FAULT: the `git log -1 --format=%B` read itself throws. Branch must be KEPT.
// (d) TRANSIENT FAULT SELF-HEALS, THROUGH confirmWorkerMergeTracked (round 4, card f2b4d684): a validation
//     throw with NO late commit retains the branch on the first Tracked confirm even though nothing is
//     actually wrong; once the fault clears, a PLAIN re-confirm (same branch head, no forceRemoveWorktree)
//     must genuinely re-derive and finalize — never replay the first call's retain from
//     `retainVerdictUntilSuperseded`'s until-superseded cache forever (the round-4 CR3 finding: classifyOutcome
//     mapped this retain to plain "merged", which is cacheable).
// (d-control) a GENUINE late-commit retain (no fault at all) — the opposite polarity — IS still served
//     from that same cache on an identical plain re-confirm, proving the fix is scoped to the
//     UNVERIFIABLE cause only and does not regress the existing cache for a real, resolved retain.
// (d2) HELD-BRANCH OWED-RANGE REFUSAL, THROUGH confirmWorkerMergeTracked (round 5, CR4, session
//     d5cf586f): a SECOND confirm while the SAME fault still persists reaches a DIFFERENT path than (d)'s
//     own — confirmWorkerMerge's EARLY held-branch check (resolveOwedRange) — and used to carry no
//     distinguishing flag at all, so it was cached as plain "rejected" and replayed forever even once the
//     fault genuinely cleared.
// (d2-control) a genuinely ABSENT recorded tip (no trailer ever written) classifies distinctly —
//     `unverifiable:false` — so it keeps today's ordinary, stably-cached refusal.
// (d3) HELD-BRANCH OWED-RANGE REFUSAL, REAL DI SEAM (round 6, CR5 item 2, session 99b8769a): the SAME
//     resolveOwedRange call path (d2) exercises, but through the REAL `heldProbeGitFactory` DI seam round
//     5 wired into heldRecordedTip — no method monkeypatch. Guards heldRecordedTip's OWN wiring: (d2)'s
//     monkeypatch bypasses the real implementation entirely, so it cannot catch dropping
//     `gitFactory: this.heldProbeGitFactory` from its readLandedTipTrailer call, or mis-mapping
//     TRAILER_TIP_UNVERIFIABLE — this scenario can.
// (e) FINISH-TIME HELD-BRANCH REFUSAL, THROUGH confirmWorkerMergeTracked (round 6, CR5, session
//     99b8769a): a THIRD, independent call site with the identical disease — once a retain event already
//     exists, confirmWorkerMerge's terminal-task/worktree-gone early block reaches
//     finishSoloAlreadyLanded -> finishAlreadyMerged's OWN held-branch refusal (`heldAtFinish`, reached
//     BEFORE any of finishAlreadyMerged's own "already landed" logic) — different from BOTH (d)'s
//     retain-time guard and (d2)'s resolveOwedRange refusal. Unlike (d2), this uses a REAL git-factory DI
//     seam (round 5 already wired `heldProbeGitFactory` into `heldRecordedTip` itself) — no method
//     monkeypatch needed.
// (f) GENUINE LATE COMMIT UNDER A TRANSIENT FAULT (round 7, CR6, session 27f4a167, structural fix): round
//     6 left resolveOwedRange with its OWN SECOND `heldRecordedTip` call, independent of isBranchHeld's
//     own internal read — the two could disagree under a transient fault (CR6's `toctou-owed` repro: read
//     #1 valid, read #2 faulted -> a STABLE, cacheable "records no readable..." refusal despite a genuine
//     late commit). Round 7 makes isBranchHeld read the trailer EXACTLY ONCE and return it verbatim;
//     resolveOwedRange never re-reads. This scenario proves the single read's own fault still refuses
//     transiently (never cached) and, once cleared, the genuine late commit is correctly gated and landed
//     — never silently released.
// (g) FINALIZE'S OWN LATER, SEPARATE isBranchHeld CHECK FAULTS (round 7, CR6's `toctou-finalize` repro):
//     `finalizeMerge` deliberately keeps its OWN fresh isBranchHeld call (real elapsed time passes after
//     heldAtFinish's own check — a genuinely NEW retain must still be caught), but its transient-fault
//     signal used to be discarded entirely, producing a FALSE retain ("now unreadable") with no
//     `landedTipUnverifiable` flag — cached as plain "merged" forever. Round 7 threads it through
//     `onBranchRetained`'s new `causeUnverifiable` param into the SAME `soloFinalizeTipGuard` machinery
//     round 4 already built, so it classifies correctly and is never cached. Uses the SAME ordinal-
//     targeted real git-factory fault CR6's own `repro6.mjs` uses (a plain toggle cannot isolate THIS
//     specific later read from every earlier read in the same confirm).
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/landed-tip-trailer-unverifiable-retains-branch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-ltuv-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-ltuv-nonexistent-codex-${process.pid}`);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, mergeBranch, parseLoomTrailerBlock, readLandedTipTrailer, TRAILER_TIP_UNVERIFIABLE } = await import("../dist/git/worktrees.js");
const { simpleGit: realSimpleGit } = await import("simple-git");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
/** CR round 3, DoD-1(a): a retain event's `detail.landedTip` must be `null` or a real hex sha — NEVER
 *  the `SOLO_TIP_UNVERIFIABLE` literal (round 2's own Major: persisting that string let a LATER call read
 *  it back as a live git revision argument, and the CR planted a ref of that exact name and had it
 *  resolve). */
const landedTipIsNullOrHex = (v) => v === null || /^[0-9a-f]{40,64}$/.test(v);
const GIT_ID = "-c user.email=ltuv@loom -c user.name=ltuv";
const now = new Date().toISOString();
const PASS = { passed: true, steps: [] };
const sfxOf = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const confirm = (sessions, mgrId, workerId) => settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked" });

/** Builds project/task/session rows + a real worktree + a landed squash on `repo`'s HEAD; returns
 *  everything needed to mutate state and re-confirm. `extraServiceOpts` lets a scenario inject its own
 *  `alreadyLandedGitFactory` (the SAME DI seam production threads readLandedTipTrailer's calls through). */
async function landOnce(sfx, extraServiceOpts = {}) {
  const reposDir = path.join(os.tmpdir(), `loom-ltuv-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db();
  const mgrId = `m-${sfx}`, projId = `p-${sfx}`, taskId = `t-${sfx}`, workerId = `w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "x\n");
  execSync("git init -q && git config user.email ltuv@loom && git config user.name ltuv", { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  db.insertProject({ id: projId, name: "LTUV", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `am-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `am-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `aw-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "LTUV-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wt = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(wt.worktreePath, "feature.txt"), "work\n");
  commitAll(wt.worktreePath, "feature", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `aw-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    reapWorktreeProcesses: async () => ({ killedPids: [] }),
    runGate: async () => PASS,
    ...extraServiceOpts,
  });
  const git = (a) => execSync("git " + a, { cwd: repo, encoding: "utf8" }).trim();
  const pre = await mergeBranch(repo, wt.branch, "LTUV-TASK");
  const originalLandedTip = parseLoomTrailerBlock(git(`log -1 --format=%B ${pre.sha}`))?.landedTip;
  const branchExists = () => { try { git(`rev-parse --verify --quiet refs/heads/${wt.branch}`); return true; } catch { return false; } };
  const subjects = () => { try { return git(`log --format=%s ${wt.branch}`).split("\n").map((x) => x.trim()); } catch { return []; } };
  const mergeDone = () => db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_done").length;
  const retained = () => db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_branch_retained");
  return { db, mgrId, workerId, projId, taskId, repo, wt, sessions, git, pre, originalLandedTip, branchExists, subjects, mergeDone, retained };
}

// ── (b) THE REAL REPRO: a genuine Loom-Landed-Tip, since pruned by a real `git gc` ──────────────────────
{
  const t = await landOnce(sfxOf("gc"));
  // The worker rewrites its own landed commit (same tree, legitimate — e.g. a message-only amend) then
  // adds a late whole-file revert.
  execSync(`git ${GIT_ID} commit --amend -q -m feature-amended`, { cwd: t.wt.worktreePath });
  fs.rmSync(path.join(t.wt.worktreePath, "feature.txt"));
  commitAll(t.wt.worktreePath, "revert-whole-file", GIT_ID);
  execSync("git reflog expire --expire=now --expire-unreachable=now --all", { cwd: t.repo });
  execSync("git gc -q --prune=now", { cwd: t.repo });

  const originalResolvable = (() => { try { t.git(`cat-file -t ${t.originalLandedTip}`); return true; } catch { return false; } })();
  check("(b) setup control: the original landed tip is genuinely gone after gc (not merely unreachable)", originalResolvable === false);
  const trailerNow = await readLandedTipTrailer(t.repo, t.pre.sha);
  check("(b) setup control: readLandedTipTrailer now reads UNVERIFIABLE for this genuinely-pruned tip", trailerNow === TRAILER_TIP_UNVERIFIABLE);

  t.db.updateTask(t.taskId, { columnKey: "done" });
  const r = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(b) THE FIX: the branch is KEPT (not deleted) — a gc'd-genuine trailer must retain, never fall back to a live read that trivially matches the CAS",
    t.branchExists());
  check("(b) the late whole-file revert is still reachable on the kept branch", t.subjects().includes("revert-whole-file"));
  check("(b) not finalized: no merge_done filed", t.mergeDone() === 0);
  check("(b) a merge_branch_retained event was filed (source: solo)", t.retained().some((e) => e.detail?.source === "solo"));
  check("(b) THE FIX, DoD-1(a): the retain event's detail.landedTip is null or a real hex sha, never the SOLO_TIP_UNVERIFIABLE literal", t.retained().every((e) => landedTipIsNullOrHex(e.detail?.landedTip ?? null)));
  check("(b) the confirm settled ok (retained is a result, not a thrown error)", r.settled === true && r.ok);
}

// ── (c-i) FORGED: the canonical squash's own trailer is amended to a ref-name-shaped decoy ──────────────
{
  const t = await landOnce(sfxOf("forged"));
  // A late WHOLE-FILE REVERT on the branch (no amend of the branch itself — the forgery is entirely on
  // the CANONICAL squash's own trailer, demonstrating the retain fires regardless of HOW the trailer went
  // bad). A revert, not an added file: `findLandedSquashCommit`'s own content check compares the branch's
  // NET diff from its fork point against the squash — an ADDED late file would genuinely mismatch (and
  // correctly fail that check on its OWN, unrelated-to-this-card merits, same as a real divergent branch
  // would), so this must be a revert to reach the SAME early-finish path scenario (b) exercises.
  fs.rmSync(path.join(t.wt.worktreePath, "feature.txt"));
  commitAll(t.wt.worktreePath, "revert-whole-file", GIT_ID);

  const decoyTarget = t.git("rev-parse HEAD"); // the squash itself — an unrelated-to-the-branch real commit
  const refNameHex = "9".repeat(50);
  execSync(`git ${GIT_ID} tag ${refNameHex} ${decoyTarget}`, { cwd: t.repo });
  const amendedMsg = `feat(x): LTUV-TASK\n\nLoom-Worker-Branch: ${t.wt.branch}\nLoom-Landed-Tip: ${refNameHex}\n`;
  const msgFile = path.join(path.dirname(t.repo), "forged-msg.txt");
  fs.writeFileSync(msgFile, amendedMsg);
  execSync(`git ${GIT_ID} commit --amend -q -F "${msgFile.split("\\").join("/")}"`, { cwd: t.repo });

  const trailerNow = await readLandedTipTrailer(t.repo, t.git("rev-parse HEAD"));
  check("(c-i) setup control: readLandedTipTrailer reads UNVERIFIABLE for the forged ref-name-shaped trailer", trailerNow === TRAILER_TIP_UNVERIFIABLE);

  t.db.updateTask(t.taskId, { columnKey: "done" });
  const r = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(c-i) THE FIX: the branch is KEPT for a FORGED trailer too — never ABSENT's legacy-fallback treatment",
    t.branchExists());
  check("(c-i) the late revert is still reachable on the kept branch", t.subjects().includes("revert-whole-file"));
  check("(c-i) not finalized: no merge_done filed", t.mergeDone() === 0);
  check("(c-i) THE FIX, DoD-1(a): the retain event's detail.landedTip is null or a real hex sha, never the SOLO_TIP_UNVERIFIABLE literal", t.retained().every((e) => landedTipIsNullOrHex(e.detail?.landedTip ?? null)));
  check("(c-i) the confirm settled ok", r.settled === true && r.ok);
}

// ── (c-ii) THROWN VALIDATION: no gc, no forgery — the validation call itself throws ──────────────────────
{
  // resolveExactTrailerObjectId's two calls are both prefixed with `-c core.warnAmbiguousRefs=false`, so
  // `args[0]` is always `"-c"` for them — detect by CONTENT (the `^{object}` suffix / the `cat-file`
  // token), not position. Everything else (the log read, for-each-ref, branch --list, ...) delegates to
  // real git untouched.
  const throwOnValidation = (repoPathArg) => {
    const real = realSimpleGit(repoPathArg);
    return {
      raw: (args) => {
        const isValidationCall = args.includes("cat-file") || args.some((a) => typeof a === "string" && a.includes("^{object}"));
        return isValidationCall ? Promise.reject(new Error("INJECTED FAULT (throw) readLandedTipTrailer validation call")) : real.raw(args);
      },
    };
  };
  const t = await landOnce(sfxOf("throw"), { alreadyLandedGitFactory: throwOnValidation });
  // Same reasoning as (c-i): a revert, not an added file, to reach the early-finish discovery path.
  fs.rmSync(path.join(t.wt.worktreePath, "feature.txt"));
  commitAll(t.wt.worktreePath, "revert-whole-file", GIT_ID);

  const trailerNow = await readLandedTipTrailer(t.repo, t.pre.sha, { gitFactory: throwOnValidation });
  check("(c-ii) setup control: readLandedTipTrailer reads UNVERIFIABLE when the validation call throws", trailerNow === TRAILER_TIP_UNVERIFIABLE);

  t.db.updateTask(t.taskId, { columnKey: "done" });
  const r = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(c-ii) THE FIX: the branch is KEPT when the validation call throws — a thrown error must behave like a present-but-untrusted trailer, not an absent one",
    t.branchExists());
  check("(c-ii) the late revert is still reachable on the kept branch", t.subjects().includes("revert-whole-file"));
  check("(c-ii) not finalized: no merge_done filed", t.mergeDone() === 0);
  check("(c-ii) THE FIX, DoD-1(a): the retain event's detail.landedTip is null or a real hex sha, never the SOLO_TIP_UNVERIFIABLE literal", t.retained().every((e) => landedTipIsNullOrHex(e.detail?.landedTip ?? null)));
  check("(c-ii) the confirm settled ok", r.settled === true && r.ok);
}

// ── (c-iii) OUTER READ FAULT: no gc, no forgery — the OUTER `git log` read itself throws (CR round 3) ──
{
  // CR round 3 reverses the outer-read mapping: an unreadable commit message is UNVERIFIABLE, never
  // ABSENT — so it must retain exactly like the inner-validation-call fault (c-ii), never fall back to
  // legacyTip. The fault targets readLandedTipTrailer's own OUTER call shape exactly — `git log -1
  // --format=%B <sha>` (worktrees.ts: `["log", "-1", "--format=%B", sha]`) — by matching `args[1] ===
  // "-1"` alongside `--format=%B`, never by a specific sha (which isn't known until AFTER `mergeBranch`
  // runs, inside `landOnce`, using this SAME factory). The one other `--format=%B`-shaped use in this
  // codebase (`findLaterBranchSquash`'s batched scan, `--format=%B%x1e`) has no `-1` flag at all, so
  // matching on `args[1] === "-1"` alongside `--format=%B` stays precise — but only among calls that
  // actually route through this injected factory. `landOnce`'s own `mergeBranch(repo, wt.branch, ...)`
  // call (no `deps` argument) takes NO factory at all and always hits real git; batch-merge.ts:712 and
  // :887 share this exact `["log", "-1", "--format=%B", sha]` shape too, on their OWN git handle, never
  // this test's. The matcher is precise only because `alreadyLandedGitFactory` is threaded through
  // exactly three readers — `resolveBranchTip`, `branchExistsInRepo`, `readLandedTipTrailer` — and no
  // other call in this test's own path construction.
  const throwOnOuterRead = (repoPathArg) => {
    const real = realSimpleGit(repoPathArg);
    return {
      raw: (args) => (args[0] === "log" && args[1] === "-1" && args.includes("--format=%B")
        ? Promise.reject(new Error("INJECTED FAULT (throw) readLandedTipTrailer outer log read"))
        : real.raw(args)),
    };
  };
  const t = await landOnce(sfxOf("outerthrow"), { alreadyLandedGitFactory: throwOnOuterRead });
  fs.rmSync(path.join(t.wt.worktreePath, "feature.txt"));
  commitAll(t.wt.worktreePath, "revert-whole-file", GIT_ID);

  const trailerNow = await readLandedTipTrailer(t.repo, t.pre.sha, { gitFactory: throwOnOuterRead });
  check("(c-iii) setup control: readLandedTipTrailer reads UNVERIFIABLE when the OUTER log read throws", trailerNow === TRAILER_TIP_UNVERIFIABLE);

  t.db.updateTask(t.taskId, { columnKey: "done" });
  const r = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(c-iii) THE FIX (CR round 3): the branch is KEPT when the OUTER log read throws — unreadable must never fall back to legacyTip",
    t.branchExists());
  check("(c-iii) the late revert is still reachable on the kept branch", t.subjects().includes("revert-whole-file"));
  check("(c-iii) not finalized: no merge_done filed", t.mergeDone() === 0);
  check("(c-iii) the retain event's detail.landedTip is null or a real hex sha", t.retained().every((e) => landedTipIsNullOrHex(e.detail?.landedTip ?? null)));
  check("(c-iii) the confirm settled ok", r.settled === true && r.ok);
}

// ── (d) TRANSIENT FAULT SELF-HEALS, THROUGH confirmWorkerMergeTracked ────────────────────────────────────
{
  // ROUND 4 (card f2b4d684, CR3 session 8beac71d): `confirmWorkerMergeTracked`'s own
  // `retainVerdictUntilSuperseded` cache is keyed on the branch-head identity — UNCHANGED across these two
  // calls (only the fault toggles; no new commit is ever made) — so a PLAIN re-confirm used to be served
  // the FIRST call's cached retain verdict directly, with NO re-derivation at all: `classifyOutcome`
  // mapped this retain to plain "merged", which `NEVER_CACHED_OUTCOMES` does not exclude. A transient
  // fault that genuinely cleared was replayed as still-retained FOREVER. THE FIX: the retain path now
  // threads `ConfirmMergeResult.landedTipUnverifiable` out of the tip guard, classified into its own
  // "landed-tip-unverifiable" outcome (`NEVER_CACHED_OUTCOMES`), so a plain re-confirm genuinely re-derives.
  let faultActive = true;
  const toggledThrowOnValidation = (repoPathArg) => {
    const real = realSimpleGit(repoPathArg);
    return {
      raw: (args) => {
        const isValidationCall = args.includes("cat-file") || args.some((a) => typeof a === "string" && a.includes("^{object}"));
        return (isValidationCall && faultActive) ? Promise.reject(new Error("INJECTED FAULT (transient) readLandedTipTrailer validation call")) : real.raw(args);
      },
    };
  };
  const t = await landOnce(sfxOf("transient-tracked"), { alreadyLandedGitFactory: toggledThrowOnValidation });
  // NO late commit — the branch's current tip is exactly what mergeBranch squashed.

  t.db.updateTask(t.taskId, { columnKey: "done" });
  const r1 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(d) FIRST confirm under a transient fault: the branch is RETAINED even though nothing is actually wrong (the fault alone is enough)", t.branchExists());
  check("(d) FIRST confirm: not finalized (no merge_done) while the fault is active", t.mergeDone() === 0);
  check("(d) FIRST confirm: a merge_branch_retained event was filed", t.retained().length === 1);
  check("(d) FIRST confirm: the retain event's detail.landedTip is null or a real hex sha", t.retained().every((e) => landedTipIsNullOrHex(e.detail?.landedTip ?? null)));
  check("(d) FIRST confirm settled ok", r1.settled === true && r1.ok);
  check("(d) FIRST confirm's own result carries landedTipUnverifiable:true", r1.value?.landedTipUnverifiable === true);

  faultActive = false; // the transient fault clears — nothing else about the branch changes

  // THE FIX: a PLAIN re-confirm (same branch head, no forceRemoveWorktree) must NOT be served from
  // EITHER verdict cache (the until-superseded map here, or the short TTL'd `retained` map) — both gate
  // on `NEVER_CACHED_OUTCOMES`, which now names "landed-tip-unverifiable". Pre-fix, this is served r1's
  // cached retain verbatim instead: RED (branch stays retained, merge_done never files, r2.cacheHit set).
  const r2 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(d) THE FIX: the SECOND confirm is NOT a cache hit — genuinely re-derived, never replayed", r2.cacheHit == null);
  check("(d) THE FIX: the SECOND confirm minted a genuinely fresh op (not a reuse of the first)", r2.freshMint?.reason === "genuinely-new");
  check("(d) THE FIX, DoD-1(b): the SECOND confirm (fault cleared) finalizes normally (merge_done filed, branch deleted) — the hold was never permanent",
    t.mergeDone() === 1 && !t.branchExists());
  check("(d) SECOND confirm's own result reports merged:true", r2.value?.merged === true);
  check("(d) SECOND confirm's own result does NOT carry landedTipUnverifiable (a clean finalize, not a retain)", !r2.value?.landedTipUnverifiable);
}

// ── (d-control) a GENUINE late-commit retain IS still served from the cache on re-confirm ───────────────
{
  // The OPPOSITE polarity of (d): no fault at all — a REAL late commit after landing. This retain is NOT
  // caused by an UNVERIFIABLE trailer (`landedTipUnverifiable` must stay unset), so it classifies as plain
  // "merged" exactly as before this card — still cacheable. A plain re-confirm at the SAME (unchanged)
  // branch head must be served the cached verdict, proving THE FIX is scoped to the UNVERIFIABLE cause
  // only and does not regress the existing until-superseded cache for a real, resolved retain.
  const t = await landOnce(sfxOf("genuine-late"));
  // A late WHOLE-FILE REVERT, same shape as (c-i)/(c-ii)/(c-iii)'s own late commit (never an ADDED file —
  // `findLandedSquashCommit`'s content-equivalence check compares the branch's NET diff from its fork
  // point against the squash, so an added file would genuinely mismatch and never reach the preLanded
  // shortcut at all). The trailer itself is untouched here (genuine, valid) — this retain is caused
  // SOLELY by the live tip no longer matching the landed one, never an UNVERIFIABLE trailer.
  fs.rmSync(path.join(t.wt.worktreePath, "feature.txt"));
  commitAll(t.wt.worktreePath, "revert-whole-file", GIT_ID);

  t.db.updateTask(t.taskId, { columnKey: "done" });
  const r1 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(d-control) setup: a genuine late commit retains the branch (not an UNVERIFIABLE cause)", t.branchExists() && t.mergeDone() === 0);
  check("(d-control) setup: FIRST confirm's own result does NOT carry landedTipUnverifiable", !r1.value?.landedTipUnverifiable);
  check("(d-control) setup: a merge_branch_retained event was filed", t.retained().length === 1);

  const r2 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(d-control) a genuine retain IS still served from cache on a plain re-confirm (unaffected by THE FIX)", r2.cacheHit != null);
  check("(d-control) still retained, no finalize happened on the cached re-confirm", t.mergeDone() === 0 && t.branchExists());
}

// ── (d2) HELD-BRANCH OWED-RANGE REFUSAL: a SECOND confirm while the fault persists must not cache ───────
{
  // @decision f2b4d684 (round 5) — do not replace this method-monkeypatch with a git-factory seam: a
  // DI-only fault is silently ignored pre-fix, self-releasing the hold and masking the bug entirely.
  const t = await landOnce(sfxOf("heldrange"));
  // NO late commit — exactly (d)'s own shape. Task stays `in_progress` (never set to "done") and the
  // worktree stays on disk: confirmWorkerMerge's own terminal-task/worktree-gone shortcut must NOT fire
  // here, or it reaches finishAlreadyMerged's OWN, DIFFERENT held-branch check instead of resolveOwedRange.
  //
  // Seed a retain event directly (the state a real first confirm's own retain already proved in scenario
  // (d)) — `detail.landedTip: null` mirrors round 3/4's own persisted shape for an UNVERIFIABLE-cause
  // retain exactly.
  t.db.appendEvent({
    id: `seed-retain-${sfxOf("x")}`, ts: new Date().toISOString(), managerSessionId: t.mgrId,
    workerSessionId: t.workerId, taskId: t.taskId, kind: "merge_branch_retained",
    detail: { opId: "seed-op", branch: t.wt.branch, landedTip: null, liveTip: t.pre.sha, phase: "at-finalize", landedSha: t.pre.sha, source: "solo", repoKey: null },
  });

  let faultActive = true;
  const origHeldRecordedTip = t.sessions.heldRecordedTip.bind(t.sessions);
  t.sessions.heldRecordedTip = async (...a) => (faultActive ? { tip: null, unverifiable: true } : origHeldRecordedTip(...a));

  const r1 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(d2) FIRST confirm (held + fault active) REFUSES — a real refusal, not a thrown error", r1.settled === true && r1.ok && r1.value?.merged === false);
  // @decision f2b4d684 (round 6) — the transient wording now also appends a manual-remedy fallback
  // ("inspect the branch by hand..."), so discriminate on the GENUINELY-ABSENT-cause phrase instead.
  check("(d2) FIRST confirm's reason says 'transient git error', never the genuinely-absent-cause wording", /transient git error/.test(r1.value?.reason ?? "") && !/records no readable assembledTip\/landedTip/.test(r1.value?.reason ?? ""));
  check("(d2) THE FIX: FIRST confirm carries heldRangeUnverifiable:true", r1.value?.heldRangeUnverifiable === true);
  check("(d2) nothing landed/finalized yet", t.mergeDone() === 0 && t.branchExists());

  const r2 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(d2) THE FIX: the SECOND confirm (fault STILL active) is NOT a cache hit — genuinely re-derived, never replayed", r2.cacheHit == null);
  check("(d2) THE FIX: the SECOND confirm minted a genuinely fresh op (not a reuse of the first)", r2.freshMint?.reason === "genuinely-new");
  check("(d2) SECOND confirm also refuses, still correctly flagged", r2.value?.merged === false && r2.value?.heldRangeUnverifiable === true);

  faultActive = false; // the transient fault clears — heldRecordedTip's REAL logic now resolves cleanly
  const r3 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(d2) THE FIX: the THIRD confirm (fault cleared) is NOT a cache hit either", r3.cacheHit == null);
  check("(d2) THE FIX: the THIRD confirm (fault cleared) finalizes normally (merge_done filed, branch deleted) — the hold was never permanent",
    r3.value?.merged === true && t.mergeDone() === 1 && !t.branchExists());
}

// ── (d2-control) a genuinely ABSENT recorded tip classifies distinctly (unverifiable:false) ──────────────
{
  // Direct unit check on heldRecordedTip itself (a plain TS `private` method, not JS `#private` — callable
  // from the compiled dist like any other method): CR4's own control, that a genuinely absent recorded tip
  // (no trailer ever written — the pre-cc9bce38 legacy shape) must NOT get the new transient treatment.
  // Exercising this end-to-end would need a held branch whose OWN real squash carries no trailer at all,
  // which this fixture's real mergeBranch call can no longer produce (every landing writes one) — this
  // direct check is the precise, robust way to pin the distinguishing classification itself.
  const t = await landOnce(sfxOf("heldabsent"));
  const legacySha = t.git("rev-list --max-parents=0 HEAD"); // the repo's own genesis commit — genuinely no Loom-Landed-Tip trailer
  check("(d2-control) setup: the legacy sha genuinely carries no Loom-Landed-Tip trailer (ABSENT, not UNVERIFIABLE)", (await readLandedTipTrailer(t.repo, legacySha)) === null);
  const fakeRetain = { id: "x", ts: new Date().toISOString(), managerSessionId: t.mgrId, workerSessionId: t.workerId, taskId: t.taskId, kind: "merge_branch_retained", detail: { opId: "x", branch: t.wt.branch, landedTip: null, liveTip: t.pre.sha, phase: "at-finalize", landedSha: legacySha, source: "solo", repoKey: null } };
  const recorded = await t.sessions.heldRecordedTip(fakeRetain, t.repo);
  check("(d2-control) heldRecordedTip: a genuinely-absent trailer returns {tip:null, unverifiable:false} — keeps today's ordinary, stably-cached refusal shape", recorded.tip === null && recorded.unverifiable === false);
}

// ── (d3) HELD-BRANCH OWED-RANGE REFUSAL, REAL DI SEAM: no heldRecordedTip monkeypatch ─────────────────────
{
  let faultActive = true;
  const toggledThrowOnValidation = (repoPathArg) => {
    const real = realSimpleGit(repoPathArg);
    return {
      raw: (args) => {
        const isValidationCall = args.includes("cat-file") || args.some((a) => typeof a === "string" && a.includes("^{object}"));
        return (isValidationCall && faultActive) ? Promise.reject(new Error("INJECTED FAULT (transient) readLandedTipTrailer validation call")) : real.raw(args);
      },
    };
  };
  const t = await landOnce(sfxOf("owedrange-realseam"), { alreadyLandedGitFactory: toggledThrowOnValidation, heldProbeGitFactory: toggledThrowOnValidation });
  // NO late commit, task STAYS in_progress and the worktree stays on disk (no preset to "done") — the
  // FIRST confirm reaches confirmWorkerMerge's own clean-worktree preLanded shortcut (same shape as (d)'s
  // own R1), and the SECOND confirm reaches resolveOwedRange's own early held-branch check instead of
  // finishAlreadyMerged's heldAtFinish refusal (which (e) below exercises).

  const r1 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(d3) FIRST confirm under a transient fault: the branch is RETAINED (round 4's own fix)", t.branchExists());
  check("(d3) FIRST confirm: a merge_branch_retained event was filed", t.retained().length === 1);
  check("(d3) FIRST confirm's own result carries landedTipUnverifiable:true", r1.value?.landedTipUnverifiable === true);

  const r2 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(d3) SECOND confirm REFUSES through resolveOwedRange (still held, fault still unresolved)", r2.settled === true && r2.ok && r2.value?.merged === false);
  check("(d3) THE WIRING: SECOND confirm's refusal carries heldRangeUnverifiable:true, via the REAL heldProbeGitFactory DI seam (no monkeypatch)", r2.value?.heldRangeUnverifiable === true);
  check("(d3) SECOND confirm's reason says 'could not be verified', never the genuinely-absent-cause wording", /could not be verified/.test(r2.value?.reason ?? "") && !/records no readable assembledTip\/landedTip/.test(r2.value?.reason ?? ""));
  check("(d3) SECOND confirm is NOT a cache hit — genuinely re-derived", r2.cacheHit == null);

  faultActive = false; // the transient fault clears — nothing else about the branch changes
  const r3 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(d3) THIRD confirm (fault cleared) finalizes normally (merge_done filed, branch deleted) — the hold was never permanent",
    r3.value?.merged === true && t.mergeDone() === 1 && !t.branchExists());
}

// ── (e) FINISH-TIME HELD-BRANCH REFUSAL: a SECOND confirm, while a retain already exists ─────────────────
{
  let faultActive = true;
  const toggledThrowOnValidation = (repoPathArg) => {
    const real = realSimpleGit(repoPathArg);
    return {
      raw: (args) => {
        const isValidationCall = args.includes("cat-file") || args.some((a) => typeof a === "string" && a.includes("^{object}"));
        return (isValidationCall && faultActive) ? Promise.reject(new Error("INJECTED FAULT (transient) readLandedTipTrailer validation call")) : real.raw(args);
      },
    };
  };
  const t = await landOnce(sfxOf("finishheld"), { alreadyLandedGitFactory: toggledThrowOnValidation, heldProbeGitFactory: toggledThrowOnValidation });
  // NO late commit — same shape as (d): the branch tip is exactly what mergeBranch squashed.

  t.db.updateTask(t.taskId, { columnKey: "done" }); // terminal-lane shortcut: every confirm reaches finishSoloAlreadyLanded
  const r1 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(e) FIRST confirm under a transient fault: the branch is RETAINED (round 4's own fix, unaffected by this round)", t.branchExists());
  check("(e) FIRST confirm: a merge_branch_retained event was filed", t.retained().length === 1);
  check("(e) FIRST confirm's own result carries landedTipUnverifiable:true", r1.value?.landedTipUnverifiable === true);

  // SECOND confirm: the retain from R1 now exists, so THIS call reaches finishAlreadyMerged's OWN
  // heldAtFinish refusal (never (d)'s retain-time guard again) — fault still active.
  const r2 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(e) SECOND confirm REFUSES (still held, fault still unresolved)", r2.settled === true && r2.ok && r2.value?.merged === false);
  check("(e) THE FIX: SECOND confirm's refusal carries heldRangeUnverifiable:true — never the plain, stably-cached refusal", r2.value?.heldRangeUnverifiable === true);
  check("(e) THE FIX: SECOND confirm's reason names the unverified-trailer cause, never the FALSE 'commit(s) landed on it' wording", /could not be VERIFIED/.test(r2.value?.reason ?? "") && !/commit\(s\) landed on it/.test(r2.value?.reason ?? ""));
  check("(e) THE FIX: SECOND confirm is NOT a cache hit — genuinely re-derived, never replayed", r2.cacheHit == null);
  check("(e) THE FIX: SECOND confirm minted a genuinely fresh op (not a reuse of the first)", r2.freshMint?.reason === "genuinely-new");

  faultActive = false; // the transient fault clears — nothing else about the branch changes
  const r3 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(e) THIRD confirm (fault cleared) is NOT a cache hit either", r3.cacheHit == null);
  check("(e) THE FIX: THIRD confirm (fault cleared) finalizes normally (merge_done filed, branch deleted) — the hold was never permanent",
    r3.value?.merged === true && t.mergeDone() === 1 && !t.branchExists());
}

// ── (f) GENUINE LATE COMMIT, ONLY THE SECOND (NOW-REMOVED) READ FAULTS (round 7: read-once) ──────────────
{
  // Dual-mode fault (same shape as (g) below, and CR6's own repro6.mjs `facHeld`): a PLAIN toggle cannot
  // expose this bug at all — read #1 (isBranchHeld's own) and read #2 (resolveOwedRange's OLD second
  // call) would always share the SAME boolean state, so they could never DISAGREE under a toggle. Only
  // an ordinal lets this scenario fault read #2 while read #1 (the SAME read round 7 now reuses verbatim)
  // stays healthy — exactly CR6's own `toctou-owed` repro shape.
  let armed = null, trailerOrdinal = 0, faultActive = true;
  const dualModeFault = (repoPathArg) => {
    const real = realSimpleGit(repoPathArg);
    let isTrailer = null, ord = 0;
    return {
      raw: (a) => {
        if (isTrailer === null) { isTrailer = a[0] === "log" && a[1] === "-1"; if (isTrailer) ord = ++trailerOrdinal; }
        const isValidationCall = a.includes("cat-file") || a.some((x) => typeof x === "string" && x.includes("^{object}"));
        const fail = isValidationCall && (armed != null ? (isTrailer && armed.has(ord)) : faultActive);
        return fail ? Promise.reject(new Error("INJECTED FAULT (dual-mode) readLandedTipTrailer validation call")) : real.raw(a);
      },
    };
  };
  const t = await landOnce(sfxOf("toctou-owed"), { alreadyLandedGitFactory: dualModeFault, heldProbeGitFactory: dualModeFault });
  // NO late commit yet — same shape as (d)'s own setup: the branch tip is exactly what mergeBranch
  // squashed, so the FIRST confirm's own retain is caused purely by the (plain-mode) fault.

  const r1 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(f) FIRST confirm under a transient fault retains (round 4's own fix)", t.branchExists());
  check("(f) FIRST confirm's own result carries landedTipUnverifiable:true", r1.value?.landedTipUnverifiable === true);

  // NOW add a GENUINE late commit — the actual state Loom must correctly track once the fault clears.
  fs.writeFileSync(path.join(t.wt.worktreePath, "late.txt"), "late\n");
  commitAll(t.wt.worktreePath, "late", GIT_ID);

  // SECOND confirm: switch to ORDINAL mode, arming ONLY ordinal 2 — pre-round-7, this is resolveOwedRange's
  // OWN second, independent heldRecordedTip call; read #1 (ordinal 1, unarmed) must succeed and find the
  // genuine late commit (recorded tip != current tip), so this is a GENUINE, resolvable hold, never an
  // absent one. THE BUG (pre-round-7): read #1 valid (held.tipUnverifiable false) + read #2 faulted
  // (recorded.tip null) -> the STABLE, cacheable "records no readable..." refusal despite the hold being
  // perfectly resolvable. THE FIX: round 7 removed read #2 entirely, so ordinal 2 now faults NOTHING.
  faultActive = false;
  armed = new Set([2]);
  const r2 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(f) SECOND confirm REFUSES transiently if at all, never the stable genuinely-absent-cause wording", r2.value?.merged === false ? (r2.value?.heldRangeUnverifiable === true && !/records no readable assembledTip\/landedTip/.test(r2.value?.reason ?? "")) : true);
  check("(f) SECOND confirm is NOT a cache hit", r2.cacheHit == null);
  check("(f) the late commit was never silently released/deleted — the branch still exists, or it was landed through a real, recorded merge_done", t.branchExists() || t.mergeDone() > 0);

  // THIRD confirm: fault cleared entirely. THE FIX: the genuine late commit is correctly discovered and
  // gated/landed through the owed-range union path — never silently released/deleted by a stale read
  // racing a healthy one.
  armed = null;
  const r3 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(f) THIRD confirm (fault cleared) is NOT a cache hit either", r3.cacheHit == null);
  check("(f) THE FIX: THIRD confirm correctly lands the late commit through the gate (merge_done filed, branch deleted) — the hold was never falsely released before landing it",
    r3.value?.merged === true && t.mergeDone() === 1 && !t.branchExists());
}

// ── (g) FINALIZE'S OWN LATER isBranchHeld CHECK FAULTS (round 7: causeUnverifiable threading) ────────────
{
  // Dual-mode real git-factory fault, mirroring CR6's own repro6.mjs `facHeld`: a PLAIN boolean toggle
  // (R1/R1b below) produces the retain the same way (d)/(d3) do; a per-call ORDINAL (R2 below) is the
  // only way to isolate finalizeMerge's own LATER, separate isBranchHeld call from every earlier read in
  // the SAME confirm (resolveOwedRange's, pinnedTipForLandedSquash's, heldAtFinish's) once a toggle alone
  // can no longer tell them apart (they all run inside one confirm, sharing one boolean window).
  let armed = null, trailerOrdinal = 0, faultActive = true;
  const dualModeFault = (repoPathArg) => {
    const real = realSimpleGit(repoPathArg);
    let isTrailer = null, ord = 0;
    return {
      raw: (a) => {
        if (isTrailer === null) { isTrailer = a[0] === "log" && a[1] === "-1"; if (isTrailer) ord = ++trailerOrdinal; }
        const isValidationCall = a.includes("cat-file") || a.some((x) => typeof x === "string" && x.includes("^{object}"));
        const fail = isValidationCall && (armed != null ? (isTrailer && armed.has(ord)) : faultActive);
        return fail ? Promise.reject(new Error("INJECTED FAULT (dual-mode) readLandedTipTrailer validation call")) : real.raw(a);
      },
    };
  };
  const t = await landOnce(sfxOf("toctou-finalize"), { alreadyLandedGitFactory: dualModeFault, heldProbeGitFactory: dualModeFault });
  // NO late commit — task stays in_progress, worktree stays on disk (matches (d3)/(f)'s own setup).

  // R1: a PLAIN fault (armed=null, faultActive=true) retains the branch exactly like (d)/(f)'s own R1 —
  // the fault alone is enough, no late commit needed.
  const r1 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(g) setup: R1 under a plain fault retains (round 4's own fix)", t.branchExists() && r1.value?.landedTipUnverifiable === true);
  // R1b: fault still on (plain mode) — refuses via resolveOwedRange (matching (d3)) WITHOUT releasing the
  // retain event, so a real retain still exists when the ordinal-targeted confirm below runs (avoiding
  // round 5's own self-release trap by using the SAME real-confirm lead-in CR6's own repro6.mjs uses for
  // this exact scenario — verified empirically: it does NOT self-release here).
  const r1b = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(g) setup: R1b (fault still on) refuses via resolveOwedRange, retain still exists", r1b.value?.merged === false && t.retained().length === 1);

  // R2: switch to ORDINAL mode, arming ONLY the trailer read inside finalizeMerge's own, LATER
  // isBranchHeld call. Every EARLIER read in this same confirm (resolveOwedRange's,
  // pinnedTipForLandedSquash's, heldAtFinish's) must succeed and find the branch's current tip genuinely
  // matching the retain's own recorded tip (no late commit was ever added), releasing the hold at every
  // one of those earlier checks — reaching `finalizeMerge`'s own check is what proves this chain. Ordinal
  // 4 was found by an exhaustive sweep (1-6) against this exact fixture shape, and verified (a REAL
  // mutation of the compiled dist dropping `causeUnverifiable`'s threading at this exact call site, byte-
  // identical restore by sha256) to be the ordinal where this scenario's bug/fix pair actually lives —
  // see docs/decisions/f2b4d684-*.md's round 7 section for why it differs from CR6's own repro6.mjs
  // (a different fixture setup, same underlying read-sequence shape).
  faultActive = false;
  armed = new Set([4]);
  const r2 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(g) R2's own result carries landedTipUnverifiable:true (THE FIX — causeUnverifiable threaded through onBranchRetained)", r2.value?.landedTipUnverifiable === true);
  check("(g) R2's own warning names the unverified cause, never a false 'now unreadable' moved-tip claim treated as a genuine divergence", /could not verify the landed tip/.test(r2.value?.branchRetainedWarning ?? r2.value?.warning ?? ""));
  check("(g) R2 is NOT a cache hit", r2.cacheHit == null);

  // R3: fault cleared entirely. THE FIX: R2's retain was never cached, so a plain re-confirm genuinely
  // re-derives and finalizes — never replaying R2's false retain forever.
  armed = null;
  const r3 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(g) R3 (fault cleared) is NOT a cache hit either", r3.cacheHit == null);
  check("(g) THE FIX: R3 (fault cleared) finalizes normally — the false retain was never permanent (R2's own retain never files a merge_done, so this is R3's first and only one)",
    r3.value?.merged === true && t.mergeDone() === 1 && !t.branchExists());
}

console.log(failures === 0
  ? "\n✅ ALL PASS — an UNVERIFIABLE Loom-Landed-Tip trailer (gc'd-genuine / forged / a thrown validation call) always RETAINS a held branch; it never falls back to a fresh live read that would silently delete a late, ungated commit."
  : `\n❌ ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
