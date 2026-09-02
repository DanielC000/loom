import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Merge-gate CANONICAL-DIRTY-OVERLAP backstop test (board card 4b7ff996). REAL git on temp repos, NO
// claude and NO live daemon — drives SessionService.confirmWorkerMerge() directly, plus unit-level checks
// of detectCanonicalDirtyOverlap/detectCanonicalStagedDirt/mergeBranch (mirrors merge-stranded-backstop.mjs's
// in-process style).
//
// THE STRUCTURAL GAP THIS GUARDS (incident: card dc255ee9, 2026-09-02): a card filed BECAUSE a canonical
// path is dirty is unmergeable by the very worker-branch path prescribed to fix it — `git merge --squash`
// cannot overwrite unstaged local modifications on a path the branch also touches, so the squash was
// failing only AFTER a full ~8-17min build/DoD gate had already run, and the generic rejection nudge told
// the manager to "Re-task a rebase" — advice that cannot help, since the branch's base was never the
// problem.
//
// FIRST-ROUND CODE REVIEW (same card) found the first predicate BROADER than what `git merge --squash`
// actually refuses on — three confirmed false refusals against real git 2.47: (E) already-landed content
// (main independently already carries the branch's content, canonical separately re-dirtied — this card's
// own `46ebf16e` shape), (D) an unstaged DELETE, (G) a submodule gitlink whose checked-out commit is ahead
// of its recorded pointer. All three are now excluded by detectCanonicalDirtyOverlap's narrowing (see its
// own doc) and proven HERE as REAL negative controls — dirt that DOES overlap the branch's changed path,
// where `git merge --squash` NONETHELESS succeeds — not the earlier draft's zero-power "dirt on an
// unrelated path" control, which could never have caught any of these three (the intersection was empty by
// construction).
//
// Proves:
//   (A) OVERLAP — canonical repo has UNSTAGED (never `git add`ed) MODIFIED content on a path the branch's
//       own commits also touch: detectCanonicalDirtyOverlap (unit) names the overlapping path, AND
//       confirmWorkerMerge REFUSES AT ADMISSION — BEFORE the build/DoD gate ever runs (proved by a
//       marker-writing gate command that must NOT have fired) — with a reason/detailText that (i) does
//       NOT say "Re-task a rebase" and (ii) DOES name the canonical dirty path and tell the manager to
//       escalate to the Platform Lead (no rebase, no auto-clean, no new manager git-write grant).
//   (E) ALREADY-LANDED CONTENT (real positive-overlap control) — canonical HEAD already carries the
//       branch's exact content at P (landed out-of-band, WITH the Loom-Worker-Branch trailer, mirroring
//       46ebf16e), then P is dirtied AGAIN with unrelated unstaged content: detectCanonicalDirtyOverlap →
//       overlap:false (despite P being both branch-changed AND canonical-dirty), confirmWorkerMerge
//       reaches the real gate (marker DOES fire) and classifies ALREADY_MERGED (merged:true) — no false
//       refusal, and the fresh unstaged edit on P survives untouched (the squash never touches it).
//   (D) UNSTAGED DELETE (real positive-overlap control) — canonical has an UNSTAGED DELETE on P (never
//       `git rm`'d), branch modifies P: detectCanonicalDirtyOverlap → overlap:false, and a DIRECT
//       mergeBranch() call proves real git actually succeeds (restores + stages P) rather than merely
//       asserting our function's own opinion.
//   (G) SUBMODULE GITLINK (real positive-overlap control) — canonical's submodule pointer is unstaged-
//       ahead of its recorded value, and the BRANCH ITSELF also bumps that same gitlink (to a DIFFERENT
//       commit than canonical's unstaged one — isolating this from the blob-identity narrowing (E) relies
//       on): detectCanonicalDirtyOverlap → overlap:false, and a DIRECT mergeBranch() call proves real git
//       succeeds and correctly lands the branch's own pointer value.
//   (S) STAGED CANONICAL DIRT (admission hoist) — canonical has STAGED, unrelated content (no path
//       overlap needed — this refusal is UNCONDITIONAL, mirroring mergeBranchLocked's own entry check):
//       confirmWorkerMerge REFUSES AT ADMISSION (marker absent — gate never ran), reason
//       `canonical_staged_dirt`, wording matches `stagedCanonicalDirtRefusalMessage`.
//   (U) UNRELATED DIRT (sanity, not a substitute for E/D/G) — canonical dirty on a path the branch never
//       touches at all (empty intersection by construction): confirmWorkerMerge proceeds to the real gate
//       and merges normally.
//   (C) DEFENSE-IN-DEPTH — calling mergeBranch() directly (bypassing confirmWorkerMerge's preflight) with
//       a GENUINE overlapping-dirty setup still fails closed at the squash itself, classified
//       `dirtyOverlap:true` (not the generic "git merge --squash failed"), with git's own diagnostic
//       message preserved in `reason`.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-canonical-dirty-overlap-backstop.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-cdo-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, detectCanonicalDirtyOverlap, mergeBranch } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=cdo@loom -c user.name=cdo";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const readText = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n"); // core.autocrlf may rewrite line endings on checkout
const now = new Date().toISOString();
const tmpDirs = [];

const db = new Db();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

function markerCommand(markerPath) {
  const forJs = markerPath.replace(/\\/g, "/");
  return `node -e "require('fs').writeFileSync('${forJs}','1')"`;
}

function seed(p) {
  db.insertProject({ id: p.projId, name: "CDO", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand: p.gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "CDO-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  fs.writeFileSync(path.join(repo, "shared.txt"), "orig\n");
  fs.writeFileSync(path.join(repo, "unrelated.txt"), "orig-unrelated\n");
  execSync(`git init -q && git config user.email cdo@loom && git config user.name cdo && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// ── (A) OVERLAP: canonical dirty on shared.txt, branch ALSO touches shared.txt ─────────────────────────
const A = {
  projId: `cdo-a-proj-${sfx}`, agentId: `cdo-a-top-${sfx}`, taskId: `cdo-a-task-${sfx}`,
  mgrId: `cdo-a-mgr-${sfx}`, workerId: `cdo-a-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-cdo-a-repo-${sfx}`),
  marker: path.join(os.tmpdir(), `loom-cdo-a-marker-${sfx}.log`),
};
A.gateCommand = markerCommand(A.marker);

// ── (E) ALREADY-LANDED CONTENT: canonical HEAD already carries the branch's content, re-dirtied ────────
const E = {
  projId: `cdo-e-proj-${sfx}`, agentId: `cdo-e-top-${sfx}`, taskId: `cdo-e-task-${sfx}`,
  mgrId: `cdo-e-mgr-${sfx}`, workerId: `cdo-e-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-cdo-e-repo-${sfx}`),
  marker: path.join(os.tmpdir(), `loom-cdo-e-marker-${sfx}.log`),
};
E.gateCommand = markerCommand(E.marker);

// ── (S) STAGED canonical dirt — unconditional admission refusal, no path overlap needed ────────────────
const S = {
  projId: `cdo-s-proj-${sfx}`, agentId: `cdo-s-top-${sfx}`, taskId: `cdo-s-task-${sfx}`,
  mgrId: `cdo-s-mgr-${sfx}`, workerId: `cdo-s-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-cdo-s-repo-${sfx}`),
  marker: path.join(os.tmpdir(), `loom-cdo-s-marker-${sfx}.log`),
};
S.gateCommand = markerCommand(S.marker);

// ── (U) UNRELATED dirt (sanity only — NOT a substitute for E/D/G's real overlap controls) ───────────────
const U = {
  projId: `cdo-u-proj-${sfx}`, agentId: `cdo-u-top-${sfx}`, taskId: `cdo-u-task-${sfx}`,
  mgrId: `cdo-u-mgr-${sfx}`, workerId: `cdo-u-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-cdo-u-repo-${sfx}`),
  marker: path.join(os.tmpdir(), `loom-cdo-u-marker-${sfx}.log`),
};
U.gateCommand = markerCommand(U.marker);

async function setup(p) {
  initRepo(p.repo);
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  tmpDirs.push(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "shared.txt"), "worker-version\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "shared.txt work"`, { cwd: worktreePath });
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
}

try {
  await setup(A);
  await setup(E);
  await setup(S);
  await setup(U);

  // Dirty the canonical repos — UNSTAGED, never `git add`ed (mirrors "live doctrine existing in no
  // commit" from the real incident).
  fs.writeFileSync(path.join(A.repo, "shared.txt"), "LIVE UNCOMMITTED DOCTRINE\n");
  check("(A) setup: shared.txt is unstaged-dirty in canonical A, not staged", git(A.repo, "diff --cached --name-only") === "" && git(A.repo, "diff --name-only") === "shared.txt");

  fs.writeFileSync(path.join(U.repo, "unrelated.txt"), "SOMEONE ELSE'S WIP\n");
  check("(U) setup: unrelated.txt is unstaged-dirty in canonical U, not staged", git(U.repo, "diff --cached --name-only") === "" && git(U.repo, "diff --name-only") === "unrelated.txt");

  // (E) simulate the out-of-band resolution (card 46ebf16e's shape): commit the branch's EXACT content
  // directly to canonical main, WITH the same trailer mergeBranchLocked's own squash stamps, so
  // findLandedSquashCommit can later recognize it as genuinely landed.
  fs.writeFileSync(path.join(E.repo, "shared.txt"), "worker-version\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "manual out-of-band resolve" -m "Loom-Worker-Branch: ${E.branch}"`, { cwd: E.repo });
  check("(E) setup: canonical HEAD now carries the branch's exact content", readText(path.join(E.repo, "shared.txt")) === "worker-version\n");
  // THEN re-dirty the SAME path again — unstaged, unrelated content — mirroring "canonical then dirty on P".
  fs.writeFileSync(path.join(E.repo, "shared.txt"), "a further live edit, unrelated to the branch\n");
  check("(E) setup: shared.txt is unstaged-dirty AGAIN in canonical E, not staged", git(E.repo, "diff --cached --name-only") === "" && git(E.repo, "diff --name-only") === "shared.txt");

  // (S) STAGE unrelated content in canonical S — `git add`ed, never committed.
  fs.writeFileSync(path.join(S.repo, "unrelated.txt"), "STAGED unrelated residue\n");
  execSync(`git add unrelated.txt`, { cwd: S.repo });
  check("(S) setup: unrelated.txt is STAGED in canonical S", git(S.repo, "diff --cached --name-only") === "unrelated.txt");

  // ── (A) unit: detectCanonicalDirtyOverlap names the overlap ────────────────────────────────────────
  const detA = await detectCanonicalDirtyOverlap(A.repo, A.branch);
  check("(A) detectCanonicalDirtyOverlap → overlap:true", detA.overlap === true);
  check("(A) names the overlapping path", Array.isArray(detA.paths) && detA.paths.includes("shared.txt"));

  // ── (A) confirmWorkerMerge refuses AT ADMISSION — before the gate ever runs ────────────────────────
  const mainBeforeA = git(A.repo, "rev-parse HEAD");
  const confirmA = await sessions.confirmWorkerMerge(A.mgrId, A.workerId);
  check("(A) confirmWorkerMerge → merged:false", confirmA.merged === false);
  check("(A) GATE NEVER RAN — marker file absent (admission-time refusal, not a post-gate failure)", !fs.existsSync(A.marker));
  check("(A) canonical HEAD UNCHANGED", git(A.repo, "rev-parse HEAD") === mainBeforeA);
  check("(A) canonical dirty file left UNTOUCHED", readText(path.join(A.repo, "shared.txt")) === "LIVE UNCOMMITTED DOCTRINE\n");
  check("(A) reason names the overlapping path", typeof confirmA.reason === "string" && confirmA.reason.includes("shared.txt"));
  check("(A) reason does NOT say 'Re-task a rebase'", !/re-task a rebase/i.test(confirmA.reason ?? ""));
  check("(A) reason tells the manager to escalate to the Platform Lead", /escalate/i.test(confirmA.reason ?? "") && /Platform Lead/i.test(confirmA.reason ?? ""));
  check("(A) detailText does NOT say 'Re-task a rebase'", !/re-task a rebase/i.test(confirmA.detailText ?? ""));
  check("(A) detailText names the dirty path", (confirmA.detailText ?? "").includes("shared.txt"));
  check("(A) detailText tells the manager to escalate to the Platform Lead", /escalate/i.test(confirmA.detailText ?? "") && /Platform Lead/i.test(confirmA.detailText ?? ""));
  check("(A) assigned branch NOT deleted (worktree retained)", git(A.repo, `branch --list ${A.branch}`) !== "");
  check("(A) task NOT moved to done", db.getTask(A.taskId).columnKey !== "done");
  check("(A) a merge_rejected(reason:canonical_dirty_overlap) event recorded",
    db.listEvents(A.mgrId).some((e) => e.kind === "merge_rejected" && e.detail && e.detail.reason === "canonical_dirty_overlap"));

  // ── (E) unit: NO overlap, despite P being both branch-changed AND canonical-dirty ──────────────────
  const detE = await detectCanonicalDirtyOverlap(E.repo, E.branch);
  check("(E) detectCanonicalDirtyOverlap → overlap:false (HEAD already matches the branch's content)", detE.overlap === false);

  // ── (E) confirmWorkerMerge reaches the real gate and classifies ALREADY_MERGED — no false refusal ──
  const confirmE = await sessions.confirmWorkerMerge(E.mgrId, E.workerId);
  check("(E) GATE DID RUN (marker present) — already-landed content is NOT a false refusal", fs.existsSync(E.marker));
  check("(E) confirmWorkerMerge → merged:true", confirmE.merged === true);
  check("(E) classified ALREADY_MERGED", confirmE.emptyKind === "ALREADY_MERGED");
  check("(E) the fresh unstaged edit on shared.txt survives UNTOUCHED (the squash never writes there)", readText(path.join(E.repo, "shared.txt")) === "a further live edit, unrelated to the branch\n");

  // ── (S) unit + confirmWorkerMerge: STAGED dirt refuses at admission, UNCONDITIONALLY ────────────────
  const mainBeforeS = git(S.repo, "rev-parse HEAD");
  const confirmS = await sessions.confirmWorkerMerge(S.mgrId, S.workerId);
  check("(S) confirmWorkerMerge → merged:false", confirmS.merged === false);
  check("(S) GATE NEVER RAN — marker file absent (staged dirt refuses BEFORE the gate)", !fs.existsSync(S.marker));
  check("(S) canonical HEAD UNCHANGED", git(S.repo, "rev-parse HEAD") === mainBeforeS);
  check("(S) staged content left UNTOUCHED (still staged, not cleared)", git(S.repo, "diff --cached --name-only") === "unrelated.txt");
  check("(S) reason names the STAGED condition", /STAGED/.test(confirmS.detailText ?? ""));
  check("(S) a merge_rejected(reason:canonical_staged_dirt) event recorded",
    db.listEvents(S.mgrId).some((e) => e.kind === "merge_rejected" && e.detail && e.detail.reason === "canonical_staged_dirt"));

  // ── (U) sanity: unrelated dirt never blocks an unrelated merge ─────────────────────────────────────
  const detU = await detectCanonicalDirtyOverlap(U.repo, U.branch);
  check("(U) detectCanonicalDirtyOverlap → overlap:false (dirt is on an unrelated path)", detU.overlap === false);
  const confirmU = await sessions.confirmWorkerMerge(U.mgrId, U.workerId);
  check("(U) GATE DID RUN (marker present) — unrelated dirt never blocks an unrelated merge", fs.existsSync(U.marker));
  check("(U) confirmWorkerMerge → merged:true", confirmU.merged === true);
  check("(U) canonical unrelated.txt edit survives the merge untouched", readText(path.join(U.repo, "unrelated.txt")) === "SOMEONE ELSE'S WIP\n");
  check("(U) branch content landed", readText(path.join(U.repo, "shared.txt")) === "worker-version\n");

  // ── (D) UNSTAGED DELETE: real positive-overlap control — real git succeeds (restores + stages) ──────
  {
    const repo = path.join(os.tmpdir(), `loom-cdo-d-repo-${sfx}`);
    initRepo(repo);
    const wt = await createWorktree(repo, `cdo-d-proj-${sfx}`, `cdo-d-task-${sfx}`);
    tmpDirs.push(wt.worktreePath);
    fs.writeFileSync(path.join(wt.worktreePath, "shared.txt"), "worker-version-d\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "shared.txt work d"`, { cwd: wt.worktreePath });

    fs.rmSync(path.join(repo, "shared.txt")); // UNSTAGED delete — never `git rm`'d
    const statusRaw = execSync("git status --porcelain --untracked-files=no", { cwd: repo }).toString();
    check("(D) setup: shared.txt shows as an UNSTAGED delete ( D shared.txt)", /^ D shared\.txt\r?\n?$/m.test(statusRaw));

    const detD = await detectCanonicalDirtyOverlap(repo, wt.branch);
    check("(D) detectCanonicalDirtyOverlap → overlap:false (an unstaged DELETE, not a modify)", detD.overlap === false);

    const headBeforeD = git(repo, "rev-parse HEAD");
    const resD = await mergeBranch(repo, wt.branch, "Card D title");
    check("(D) mergeBranch() succeeds for real (ok:true) — git restores + stages the branch's content", resD.ok === true && !!resD.sha);
    check("(D) canonical HEAD advanced", git(repo, "rev-parse HEAD") !== headBeforeD);
    check("(D) branch content landed", readText(path.join(repo, "shared.txt")) === "worker-version-d\n");
  }

  // ── (G) SUBMODULE GITLINK: real positive-overlap control — branch ALSO bumps the same gitlink ───────
  {
    const subSrc = path.join(os.tmpdir(), `loom-cdo-g-subsrc-${sfx}`);
    fs.mkdirSync(subSrc, { recursive: true });
    tmpDirs.push(subSrc);
    execSync(`git init -q && git config user.email cdo@loom && git config user.name cdo && git config protocol.file.allow always`, { cwd: subSrc });
    fs.writeFileSync(path.join(subSrc, "s.txt"), "s1\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m s1`, { cwd: subSrc });

    const repo = path.join(os.tmpdir(), `loom-cdo-g-repo-${sfx}`);
    fs.mkdirSync(repo, { recursive: true });
    tmpDirs.push(repo);
    execSync(`git init -q && git config user.email cdo@loom && git config user.name cdo && git config protocol.file.allow always`, { cwd: repo });
    fs.writeFileSync(path.join(repo, "shared.txt"), "orig\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m init`, { cwd: repo });
    // `submodule add` clones subSrc's CURRENT HEAD (s1) — MUST run before s2/s3 exist upstream, or the
    // clone would already land on a later commit and neither bump below would show as dirty (measured:
    // the naive "create s1/s2/s3 first, then submodule add" ordering silently produces a CLEAN status).
    execSync(`git ${GIT_ID} -c protocol.file.allow=always submodule add "${subSrc}" sub`, { cwd: repo });
    execSync(`git add -A && git ${GIT_ID} commit -q -m "add submodule at s1"`, { cwd: repo });

    // NOW advance subSrc to s2 and s3 — ordinary submodule usage, upstream commits landing AFTER the
    // superproject already recorded s1.
    fs.writeFileSync(path.join(subSrc, "s.txt"), "s2\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m s2`, { cwd: subSrc });
    const s2Sha = git(subSrc, "rev-parse HEAD");
    fs.writeFileSync(path.join(subSrc, "s.txt"), "s3\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m s3`, { cwd: subSrc });
    const s3Sha = git(subSrc, "rev-parse HEAD");

    // BRANCH bumps the gitlink to s2 — the wrinkle the reviewer's specimen (b) names: the branch itself
    // touches the SAME gitlink path, so it's a genuine overlap CANDIDATE, not merely a coincidental dirty
    // path elsewhere.
    const wt = await createWorktree(repo, `cdo-g-proj-${sfx}`, `cdo-g-task-${sfx}`);
    tmpDirs.push(wt.worktreePath);
    // `git worktree add` does NOT auto-populate a submodule checkout in the new worktree (unlike
    // `submodule add`, which populates the ORIGINAL repo's checkout immediately) — it must be explicitly
    // initialized here before it can be fetched/checked-out into.
    execSync(`git ${GIT_ID} -c protocol.file.allow=always submodule update --init sub`, { cwd: wt.worktreePath });
    execSync(`git fetch -q origin && git checkout -q ${s2Sha}`, { cwd: path.join(wt.worktreePath, "sub") });
    execSync(`git add sub && git ${GIT_ID} commit -q -m "bump sub to s2"`, { cwd: wt.worktreePath });

    // Canonical's OWN checked-out submodule commit independently advances to s3 — a DIFFERENT commit than
    // the branch's s2 target — WITHOUT staging that bump in the superproject. Deliberately different from
    // s2 so this isolates the gitlink-mode exclusion from the (E) blob-identity narrowing: if the two
    // shas matched, a pass here couldn't tell which mechanism was responsible.
    execSync(`git fetch -q origin && git checkout -q ${s3Sha}`, { cwd: path.join(repo, "sub") });
    const statusRaw = execSync("git status --porcelain --untracked-files=no", { cwd: repo }).toString();
    check("(G) setup: submodule shows as UNSTAGED dirt ( M sub), not staged", /^ M sub\r?\n?$/m.test(statusRaw));
    check("(G) setup: canonical's checked-out submodule commit (s3) differs from the branch's target (s2)", s3Sha !== s2Sha);

    const detG = await detectCanonicalDirtyOverlap(repo, wt.branch);
    check("(G) detectCanonicalDirtyOverlap → overlap:false (a gitlink, not a real content conflict)", detG.overlap === false);

    const headBeforeG = git(repo, "rev-parse HEAD");
    const resG = await mergeBranch(repo, wt.branch, "Card G title");
    check("(G) mergeBranch() succeeds for real (ok:true) — a dirty gitlink never blocks the squash", resG.ok === true && !!resG.sha);
    check("(G) canonical HEAD advanced", git(repo, "rev-parse HEAD") !== headBeforeG);
    check("(G) the branch's OWN gitlink value (s2) landed in the recorded tree",
      git(repo, "ls-files -s -- sub").split(/\s+/)[1] === s2Sha);
  }

  // ── (C) defense-in-depth: mergeBranch() called directly still fails closed, classified ────────────
  const C = { repo: path.join(os.tmpdir(), `loom-cdo-c-repo-${sfx}`) };
  initRepo(C.repo);
  const wtC = await createWorktree(C.repo, `cdo-c-proj-${sfx}`, `cdo-c-task-${sfx}`);
  tmpDirs.push(wtC.worktreePath);
  fs.writeFileSync(path.join(wtC.worktreePath, "shared.txt"), "worker-version-c\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m "shared.txt work c"`, { cwd: wtC.worktreePath });
  fs.writeFileSync(path.join(C.repo, "shared.txt"), "LIVE UNCOMMITTED DOCTRINE C\n");
  const headCBefore = git(C.repo, "rev-parse HEAD");

  const resC = await mergeBranch(C.repo, wtC.branch, "Card C title");
  check("(C) mergeBranch() called directly still refuses (ok:false)", resC.ok === false);
  check("(C) classified dirtyOverlap:true, not the generic failure", resC.dirtyOverlap === true);
  check("(C) reason carries git's own diagnostic ('would be overwritten')", typeof resC.reason === "string" && /would be overwritten/i.test(resC.reason));
  check("(C) canonical HEAD UNCHANGED", git(C.repo, "rev-parse HEAD") === headCBefore);
  check("(C) canonical dirty file left UNTOUCHED", readText(path.join(C.repo, "shared.txt")) === "LIVE UNCOMMITTED DOCTRINE C\n");
} finally {
  db.close();
  for (const p of [A, E, S, U]) {
    try { fs.rmSync(p.marker, { force: true }); } catch { /* ignore */ }
  }
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a canonical path GENUINELY dirty on a branch's own changed path (a real content modification, not merely a coincidental overlap) is refused AT ADMISSION before the gate runs, with a remedy naming the dirty path and pointing at the Platform Lead instead of a useless rebase; STAGED canonical dirt refuses at admission too, unconditionally; three PROVEN-safe overlap shapes (already-landed content, an unstaged delete, a submodule gitlink) do NOT false-refuse, each verified against what real git actually does, not just this function's own opinion; and mergeBranch() itself still fails closed and diagnosably for a genuine overlap if this ever races past the preflight."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
