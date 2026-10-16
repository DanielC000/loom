import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9a7df0a7 (decision 40b63f1c): boot-reconcile's `handledWorktrees`/`protectedWorktreePaths`/
// `currentGenerationIds` (sessions/service.ts), `reviewBaseShaConsensusByPath` (git/worktrees.ts), and the
// node_modules-reclaim/`commitsAheadOfBase` siblings-lookups all keyed themselves on the RAW `worktreePath`
// string. On a case-insensitive filesystem (win32), two session rows can carry genuinely differently-
// spelled aliases of the SAME on-disk directory — a repoKey re-case between two spawns of the same task,
// or a `LOOM_HOME`/`WORKTREES_DIR` casing/slash difference across daemon restarts (see this card's
// `worker_report` for the full investigation) — and a raw-string key let one row's decision (protect, or
// trust a reviewBaseSha, or treat a stale generation as current) miss the other row's aliased spelling
// entirely. The fix: every one of those Set/Map identity comparisons now routes through the shared
// `worktreeIdentityKey` helper (git/worktrees.ts) instead of the raw string — this file proves it.
//
// Sections (a)/(b)/(d)/(e)/(f) are win32-only: a case/slash "alias" of a real directory is only the SAME
// directory on a case-insensitive filesystem. On POSIX the flipped-case/slash string either doesn't
// resolve at all (case-sensitive FS) or (a literal backslash) isn't a path separator — so the scenario
// those sections exist to prove simply cannot be constructed there; they're skipped with a printed reason,
// same convention as every other win32-only real-mechanism test in this suite (e.g.
// cli-service-windows-real-spawn.mjs). Section (c) is a PURE function test and runs on every platform —
// its win32-style case/slash aliases are exercised on win32, and a POSIX-companion block (trailing-slash
// collapse; case-variants staying DISTINCT, since POSIX is case-sensitive) exercises the same function on
// POSIX, so this file is never a full no-op on a Linux CI runner.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-wpia-home-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, reviewBaseShaConsensusByPath } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=wpia@loom -c user.name=wpia";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

const db = new Db();
const pty = { enqueueStdin: () => ({ delivered: false, deliveryState: "queued" }) };
const sessions = new SessionService(db, pty, new OrchestrationControl());

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const repos = []; // every real tmp repo dir this run creates — removed in the finally block below

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# wpia\n");
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  git(repo, "branch -M main");
  git(repo, "symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main");
}

// Flip a real, existing worktree path to a DIFFERENTLY-SPELLED string that still names the SAME
// directory on a case-insensitive, separator-tolerant filesystem (win32): upper-case every letter
// (drive letter included — win32 drive letters are case-insensitive too) and swap `\` for `/` (win32
// accepts either as a separator). Never touches the real path's own content/casing on disk.
const aliasSpelling = (p) => p.toUpperCase().replace(/\\/g, "/");

try {
  if (process.platform === "win32") {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wpia-repo-"));
    repos.push(repo);
    initRepo(repo);
    const projId = `wpia-proj-${sfx}`, agentId = `wpia-agent-${sfx}`, mgrId = `wpia-mgr-${sfx}`;
    db.insertProject({ id: projId, name: "WPIA", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    // (a) PROTECTED-BY-ALIAS: mirrors decision 40b63f1c's own incident shape exactly — a "successor" row
    // that is PROTECTED via `protectedSessionIds` (about to be resumed; a restart-intent/crash-orphan
    // grant) while STILL `processState: "exited"` in the DB, plus a DANGLING (exited, unprotected) row that
    // carries the REAL, git-registered spelling of the same directory. Both rows are deliberately `exited`
    // (never `live`/`starting`) so the unrelated, already-correct `findLiveSessionClaimingWorktreePath`/
    // `containmentForms` guard inside `gcWorktreeDir` (decisions `a5d9c458`/`623a7a62` — it case-folds too,
    // but only ever consults LIVE/starting rows) cannot itself save this case and mask what THIS fix does.
    // DELIBERATE ROLE ASSIGNMENT: the PROTECTED row carries the ALIAS spelling and the DANGLING row carries
    // the REAL one — not the other way round. Pointing an actual `git worktree remove` at an alias spelling
    // git never registered makes git's OWN admin-record lookup fail on its own (a confound this file's own
    // first draft tripped on: that accidental git-level failure left the directory intact regardless of
    // whether `protectedWorktreePaths` ever engaged, so the check passed for the wrong reason both before
    // and after the fix). Keeping the DESTRUCTIVE attempt on the REAL spelling means a pre-fix run's removal
    // genuinely succeeds — so this check can only pass post-fix because PROTECTION engaged, never because
    // the removal itself happened to fail for an unrelated reason.
    const taskIdA = `wpia-taskA-${sfx}`;
    db.insertTask({ id: taskIdA, projectId: projId, title: "WPIA-A", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath: pathA, branch: branchA } = await createWorktree(repo, projId, taskIdA);
    const aliasPathA = aliasSpelling(pathA);
    check("(a) alias spelling actually differs from the real path (sanity: the alias is a real string transform)", aliasPathA !== pathA);
    check("(a) alias spelling resolves to the SAME dir on disk (sanity: win32 case-insensitive FS)", fs.existsSync(aliasPathA) && fs.statSync(aliasPathA).isDirectory());

    const protectedIdA = `wpia-protectedA-${sfx}`, danglingIdA = `wpia-danglingA-${sfx}`;
    db.insertSession({ id: protectedIdA, projectId: projId, agentId, engineSessionId: null, title: null, cwd: aliasPathA, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskIdA, worktreePath: aliasPathA, branch: branchA });
    db.insertSession({ id: danglingIdA, projectId: projId, agentId, engineSessionId: null, title: null, cwd: pathA, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskIdA, worktreePath: pathA, branch: branchA });

    // (b) NEGATIVE CONTROL: a genuinely DIFFERENT, unprotected, dangling worktree (no live/aliased
    // counterpart at all) must still be reaped normally — proving the fix protects only the actually-
    // aliased case, not every worktree unconditionally.
    const taskIdB = `wpia-taskB-${sfx}`;
    db.insertTask({ id: taskIdB, projectId: projId, title: "WPIA-B", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath: pathB, branch: branchB } = await createWorktree(repo, projId, taskIdB);
    const danglingIdB = `wpia-danglingB-${sfx}`;
    db.insertSession({ id: danglingIdB, projectId: projId, agentId, engineSessionId: null, title: null, cwd: pathB, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskIdB, worktreePath: pathB, branch: branchB });

    // (e) PASS A FULL-FINALIZE PROTECTION VIA ALIAS — a re-task-shaped pair (no recycledFrom link; a
    // recycle successor always COPIES its predecessor's worktreePath verbatim, so aliasing can only ever
    // arise BETWEEN two independent spawns of the same task, never within one recycle chain). The branch's
    // squash is REALLY landed on main (not a simulated `!landedSha` early-out) so Pass A's own protection
    // check at the `protectedSessionIds.has(s.id) || protectedWorktreePaths.has(worktreeIdentityKey(...))`
    // line is actually REACHED and exercised, not bypassed. This fixture isolates THAT ONE lookup from
    // `currentGenerationIds` (a SEPARATE mechanism, further down the SAME try body, that could otherwise
    // "save" this scenario on its own and mask whether the lookup itself is load-bearing): the DANGLING
    // row is deliberately the NEWER generation (`createdAt` +1s) — whichever keying `currentGenerationIds`
    // uses (raw or identity), a row that's the sole/winning head of its own group is always "current", so
    // the dangling row's `staleGeneration` is `false` and its `worktreeOnDisk` is `true` EITHER WAY; only
    // the protection lookup itself can still flip the outcome. Pre-fix (of THAT lookup only), the dangling
    // row's raw spelling misses `protectedWorktreePaths` (built from the protected row's ALIAS spelling)
    // and Pass A proceeds to a FULL finalize through the WRONG (dangling) identity: destroying the shared
    // dir/branch the protected row still needs, moving the task to "done", and recording `merge_done`
    // under the dangling row's own id — exactly decision 40b63f1c's incident, reproduced via aliasing
    // instead of recycling. The `merge_request` (manager-requested coverage) is filed under the PROTECTED
    // row, mirroring decision 9ac3a739's own convention ("the row that actually requested the merge").
    const eNow = Date.now();
    const taskIdE = `wpia-taskE-${sfx}`;
    db.insertTask({ id: taskIdE, projectId: projId, title: "WPIA-E", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath: pathE, branch: branchE } = await createWorktree(repo, projId, taskIdE);
    fs.writeFileSync(path.join(pathE, "change.txt"), "worker change\n");
    commitAll(pathE, "change", GIT_ID);
    execSync(`git ${GIT_ID} merge --squash ${branchE} && git ${GIT_ID} commit -q -m "WPIA-E" -m "Loom-Worker-Branch: ${branchE}"`, { cwd: repo });
    const aliasPathE = aliasSpelling(pathE);
    const protectedIdE = `wpia-protectedE-${sfx}`, danglingIdE = `wpia-danglingE-${sfx}`;
    const protectedCreatedAtE = new Date(eNow).toISOString();
    const danglingCreatedAtE = new Date(eNow + 1_000).toISOString(); // NEWER generation — see header comment above
    db.insertSession({ id: protectedIdE, projectId: projId, agentId, engineSessionId: null, title: null, cwd: aliasPathE, processState: "exited", resumability: "unknown", busy: false, createdAt: protectedCreatedAtE, lastActivity: protectedCreatedAtE, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskIdE, worktreePath: aliasPathE, branch: branchE });
    db.insertSession({ id: danglingIdE, projectId: projId, agentId, engineSessionId: null, title: null, cwd: pathE, processState: "exited", resumability: "unknown", busy: false, createdAt: danglingCreatedAtE, lastActivity: danglingCreatedAtE, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskIdE, worktreePath: pathE, branch: branchE });
    db.appendEvent({ id: randomUUID(), ts: protectedCreatedAtE, managerSessionId: mgrId, workerSessionId: protectedIdE, taskId: taskIdE, kind: "merge_request", detail: { branch: branchE, filesChanged: 1, tip: branchE, repoKey: null } });

    // (f) NODE_MODULES RECLAIM PROTECTION VIA ALIAS — real worktrees (via createWorktree, same `repo`/
    // `projId` as the other fixtures): `reclaimNodeModulesDir`'s own refusal check requires the target be
    // strictly under the worktrees root, so a bare OS-temp dir (this file's first draft) is refused for an
    // unrelated reason that would mask the fix either way. listNodeModulesReclaimCandidates/
    // reclaimNodeModules are called HERE, BEFORE the big (a)/(b)/(e) `reconcileOrchestrationOnBoot` call
    // below — that call's OWN Pass B protection is `protectedSessionIds`/`isLive`-based, a DIFFERENT
    // mechanism from node_modules-reclaim's `resumability`-based one, and would otherwise reap these two
    // worktrees outright (0 commits, clean tree, neither row live/protectedSessionIds-granted) before this
    // fixture's own checks ever ran. A row sharing the SAME real dir, at an alias spelling, with
    // resumability !== "dead" must protect the WHOLE identity's node_modules from reclaim — even though the
    // representative row picked for the identity (the one with the latest lastActivity) is the OTHER,
    // genuinely-dead-looking row.
    const oldHours = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
    const taskIdF = `wpia-taskF-${sfx}`;
    db.insertTask({ id: taskIdF, projectId: projId, title: "WPIA-F", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath: realDirF, branch: branchF } = await createWorktree(repo, projId, taskIdF);
    fs.mkdirSync(path.join(realDirF, "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(realDirF, "node_modules", ".keep"), "x");
    const aliasDirF = aliasSpelling(realDirF);
    const protectedIdF = `wpia-protectedF-${sfx}`, danglingIdF = `wpia-danglingF-${sfx}`;
    db.insertSession({ id: protectedIdF, projectId: projId, agentId, engineSessionId: null, title: null, cwd: aliasDirF, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: oldHours(2000), lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskIdF, worktreePath: aliasDirF, branch: branchF });
    db.insertSession({ id: danglingIdF, projectId: projId, agentId, engineSessionId: null, title: null, cwd: realDirF, processState: "exited", resumability: "dead", busy: false, createdAt: now, lastActivity: oldHours(1000), lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskIdF, worktreePath: realDirF, branch: branchF });

    // (f) negative control: a genuinely different, unaliased, resumability:"dead" dir with no protected
    // counterpart at all — must still surface as a reclaim candidate, proving the fix doesn't over-protect.
    const taskIdFControl = `wpia-taskFctrl-${sfx}`;
    db.insertTask({ id: taskIdFControl, projectId: projId, title: "WPIA-F-CTRL", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const { worktreePath: realDirFControl, branch: branchFControl } = await createWorktree(repo, projId, taskIdFControl);
    fs.mkdirSync(path.join(realDirFControl, "node_modules"), { recursive: true });
    const controlIdF = `wpia-controlF-${sfx}`;
    db.insertSession({ id: controlIdF, projectId: projId, agentId, engineSessionId: null, title: null, cwd: realDirFControl, processState: "exited", resumability: "dead", busy: false, createdAt: now, lastActivity: oldHours(1000), lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskIdFControl, worktreePath: realDirFControl, branch: branchFControl });

    const { entries: fEntries } = await sessions.listNodeModulesReclaimCandidates();
    check("(f) the aliased, still-resumable dir's node_modules is NOT a reclaim candidate", !fEntries.some((e) => e.worktreePath === realDirF));
    check("(f) negative control: the genuinely dead, unaliased dir's node_modules IS a reclaim candidate", fEntries.some((e) => e.worktreePath === realDirFControl));

    // (f2) reclaimNodeModules' own `opts.worktreePaths` narrowing: a caller hands back an ALIAS spelling
    // of a candidate (the TOCTOU shape the GET/POST doc describes — the representative row's own spelling
    // can legitimately differ between the GET and this call) and the narrowing must still find and reclaim
    // it, via `worktreeIdentityKey`, never raw string equality.
    const f2Result = await sessions.reclaimNodeModules({ worktreePaths: [aliasSpelling(realDirFControl)] });
    check("(f2) an aliased opts.worktreePaths entry still matches and reclaims the real candidate", f2Result.removed === 1 && f2Result.noLongerEligible === 0);

    await sessions.reconcileOrchestrationOnBoot(new Set([protectedIdA, protectedIdE]));

    check("(a) the protected row's real worktree dir still exists after reconcile (not reaped via its alias)", fs.existsSync(path.join(pathA, ".git")));
    check("(a) the alias spelling still resolves to that same intact dir", fs.existsSync(path.join(aliasPathA, ".git")));
    check("(b) negative control: the genuinely unprotected, unaliased dir WAS reaped", !fs.existsSync(pathB));
    check("(e) the shared dir survives Pass A (never fully finalized through the dangling alias)", fs.existsSync(path.join(pathE, ".git")));
    check("(e) the dangling row never recorded a merge_done (no finalize ran under its identity)", !db.listEventsForWorker(danglingIdE).some((ev) => ev.kind === "merge_done"));
    check("(e) the task stayed in_progress (never wrongly moved to done via the dangling identity)", db.getTask(taskIdE)?.columnKey === "in_progress");

    // (d) currentGenerationIds (Pass A2) — a re-task pair at ALIASED spellings (no real git/fs needed; A2
    // is DB-event-only). BOTH X (older generation) and Y (newer generation, aliased spelling) have their
    // OWN unresolved `merge_request` and NO `merge_done` at all — X must look exactly like a genuine
    // stale-generation crash-orphan (an existing merge_done on X would make it skip on its OWN merits,
    // never exercising the generation check at all). `lastActivity` is stamped so X sorts BEFORE Y in
    // `listAllSessionsIncludingArchived`'s `ORDER BY last_activity DESC` — the exact ordering the pre-fix
    // bug needs to be observable: pre-fix, X's raw spelling and Y's raw (aliased) spelling each form their
    // OWN trivial one-row "current generation" group, so X (visited first) wrongly reaches Pass A2's
    // reconciling-merge_done emission UNDER ITS OWN (stale) id, carrying `detail.branch` set to the SHARED
    // branch name — exactly what decision e5458ccd's "Do not" forbids — and that emission then (via the
    // live seq map) makes Y's own, genuinely-unresolved merge_request look resolved, so Y's real alert is
    // silently swallowed. Post-fix, X and Y collapse into ONE identity group; Y (the later `createdAt`)
    // wins the head-tiebreak, so X is correctly recognized as STALE and skipped outright — only Y reaches
    // the emission, correctly attributed under Y's own id.
    // ALL FOUR timestamps below are offsets from ONE fresh `Date.now()` read taken HERE, at fixture-(d)
    // time — never from the module-level `now` captured at file load. A prior draft mixed the two: by the
    // time (d) ran (after (a)/(b)/(e)/(f)'s real git/reconcile work), module-load `now` was already >5s
    // stale, so `yLastActivity` (derived from a fresh read) ended up LATER than `xLastActivity` (pinned to
    // the stale `now`) — inverting the intended visit order and making X skip on its own genuine merits
    // (hasTerminal via its own absence of events) with the generation check never actually exercised. A
    // revert of the `currentGenerationIds` fix then had nothing to flip, and the test stayed green for the
    // wrong reason.
    const dNow = Date.now();
    const taskIdD = `wpia-taskD-${sfx}`;
    db.insertTask({ id: taskIdD, projectId: projId, title: "WPIA-D", body: "", columnKey: "done", position: 1, createdAt: now, updatedAt: now });
    const branchD = `loom/wpia-d-${sfx}`;
    const pathD = path.join(repo, "never-on-disk-d-x");
    const aliasPathD = aliasSpelling(pathD);
    const xIdD = `wpia-xD-${sfx}`, yIdD = `wpia-yD-${sfx}`;
    const xCreatedAt = new Date(dNow - 60_000).toISOString(); // X is the OLDER generation
    const yCreatedAt = new Date(dNow).toISOString(); // Y is the NEWER generation — wins the head-tiebreak post-fix
    const xLastActivity = new Date(dNow).toISOString(); // X visited FIRST by ORDER BY last_activity DESC — the shape the bug needs
    const yLastActivity = new Date(dNow - 5_000).toISOString();
    db.insertSession({ id: xIdD, projectId: projId, agentId, engineSessionId: null, title: null, cwd: pathD, processState: "exited", resumability: "unknown", busy: false, createdAt: xCreatedAt, lastActivity: xLastActivity, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskIdD, worktreePath: pathD, branch: branchD });
    db.insertSession({ id: yIdD, projectId: projId, agentId, engineSessionId: null, title: null, cwd: aliasPathD, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAt, lastActivity: yLastActivity, lastError: null, role: "worker", parentSessionId: mgrId, taskId: taskIdD, worktreePath: aliasPathD, branch: branchD });
    db.appendEvent({ id: randomUUID(), ts: xCreatedAt, managerSessionId: mgrId, workerSessionId: xIdD, taskId: taskIdD, kind: "merge_request", detail: { branch: branchD, filesChanged: 1, tip: branchD, repoKey: null } });
    db.appendEvent({ id: randomUUID(), ts: yCreatedAt, managerSessionId: mgrId, workerSessionId: yIdD, taskId: taskIdD, kind: "merge_request", detail: { branch: branchD, filesChanged: 1, tip: branchD, repoKey: null } });

    // Assert the precondition EXPLICITLY, rather than trust the comment above it: X must actually sort
    // before Y in the exact order `reconcileOrchestrationOnBoot` iterates (`listAllSessionsIncludingArchived`,
    // `ORDER BY last_activity DESC`) — this is what makes X the row that reaches Pass A2's emission check
    // first, which is the whole precondition this fixture depends on to be observable at all.
    const dOrderIds = db.listAllSessionsIncludingArchived().map((s) => s.id);
    const xOrderIdx = dOrderIds.indexOf(xIdD), yOrderIdx = dOrderIds.indexOf(yIdD);
    check("(d) precondition: X sorts BEFORE Y in listAllSessionsIncludingArchived (last_activity DESC)", xOrderIdx !== -1 && yOrderIdx !== -1 && xOrderIdx < yOrderIdx);

    // Pass A2 is reached by the SAME reconcileOrchestrationOnBoot call — but the (a)/(b)/(e)/(f) fixtures
    // above have already consumed one boot's worth of Pass A/B/C. Run a SECOND, fresh reconcile pass
    // purely for fixture (d) so A2 evaluates X/Y against a clean `a2MergeDoneSeqMap`/`a2MergeRequestSeqMap`
    // (both rebuilt fresh every call) without interference from the earlier fixtures' own events.
    await sessions.reconcileOrchestrationOnBoot(new Set());
    const xEventsD = db.listEventsForWorker(xIdD);
    const yEventsD = db.listEventsForWorker(yIdD);
    check("(d) X (the stale, older generation) never received a merge_done from Pass A2", !xEventsD.some((ev) => ev.kind === "merge_done"));
    check("(d) Y (the current, newer generation) received its OWN reconciling merge_done", yEventsD.some((ev) => ev.kind === "merge_done" && ev.detail?.branch === branchD));
  } else {
    console.log(`SKIP  worktree-path-identity-alias.mjs sections (a)/(b)/(d)/(e)/(f) — win32-only (case-insensitive-filesystem path aliasing); this host is '${process.platform}'. Running the cross-platform (c) pure-function checks instead.`);
  }

  // (c) reviewBaseShaConsensusByPath: a PURE function — no real git/fs needed, runs on every platform.
  if (process.platform === "win32") {
    // Two TASKLESS rows that are case/slash aliases of ONE path, with CONFLICTING reviewBaseSha values,
    // must collapse to ONE identity and resolve to NO trusted consensus (null) — never two independent
    // "trusted" (and wrongly agreeing-with-itself) single-row groups. `taskId: null` is required for
    // `trustedReviewBaseSha` to consider trusting a group at all (see that function's own doc) — otherwise
    // this test could pass vacuously for a reason unrelated to the identity-key fix.
    const fakePath = path.join(os.tmpdir(), `wpia-fake-review-fork-${sfx}`);
    const fakePathAlias = aliasSpelling(fakePath);
    const conflictingRows = [
      { worktreePath: fakePath, taskId: null, reviewBaseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { worktreePath: fakePathAlias, taskId: null, reviewBaseSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
    ];
    // Read keys off the Map itself rather than re-deriving one via `worktreeIdentityKey` here — this keeps
    // the assertions meaningful (and non-crashing) even run against a pre-fix build that doesn't export it.
    const conflictConsensus = reviewBaseShaConsensusByPath(conflictingRows);
    check("(c) [win32] two case/slash-aliased rows collapse to ONE identity key, not two", conflictConsensus.size === 1);
    check("(c) [win32] conflicting reviewBaseSha across the aliased pair ⇒ no trusted consensus", conflictConsensus.size === 1 && [...conflictConsensus.values()][0] === null);

    // Positive companion: aliased rows that AGREE must still resolve to a trusted, non-null consensus —
    // proving the collapse-to-one-identity fix doesn't also wrongly suppress a genuine agreement.
    const agreeingRows = [
      { worktreePath: fakePath, taskId: null, reviewBaseSha: "cccccccccccccccccccccccccccccccccccccccc" },
      { worktreePath: fakePathAlias, taskId: null, reviewBaseSha: "cccccccccccccccccccccccccccccccccccccccc" },
    ];
    const agreeingConsensus = reviewBaseShaConsensusByPath(agreeingRows);
    check("(c) [win32] two case/slash-aliased rows that AGREE ⇒ one trusted consensus value", agreeingConsensus.size === 1 && [...agreeingConsensus.values()][0] === "cccccccccccccccccccccccccccccccccccccccc");
  } else {
    // POSIX companion: `normForCompare` still collapses a trailing-slash variant (path.resolve strips it
    // on every platform) but never case-folds on POSIX (a case-sensitive filesystem) — so a trailing-slash
    // pair must collapse to ONE identity exactly like win32's case/slash pair does, while a PURE case
    // variant must stay TWO DISTINCT identities (the opposite of win32's own behavior for the same input
    // shape) — this is the real, platform-correct counterpart to the win32 block above, not a weaker copy.
    const posixBase = `/tmp/wpia-fake-review-fork-${sfx}`;
    const trailingSlashRows = [
      { worktreePath: posixBase, taskId: null, reviewBaseSha: "dddddddddddddddddddddddddddddddddddddddd" },
      { worktreePath: `${posixBase}/`, taskId: null, reviewBaseSha: "dddddddddddddddddddddddddddddddddddddddd" },
    ];
    const trailingSlashConsensus = reviewBaseShaConsensusByPath(trailingSlashRows);
    check("(c) [posix] a trailing-slash variant collapses to the SAME identity as its bare form", trailingSlashConsensus.size === 1 && [...trailingSlashConsensus.values()][0] === "dddddddddddddddddddddddddddddddddddddddd");

    const caseVariantRows = [
      { worktreePath: posixBase, taskId: null, reviewBaseSha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
      { worktreePath: posixBase.toUpperCase(), taskId: null, reviewBaseSha: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
    ];
    const caseVariantConsensus = reviewBaseShaConsensusByPath(caseVariantRows);
    check("(c) [posix] a pure case variant stays TWO DISTINCT identities (case-sensitive filesystem)", caseVariantConsensus.size === 2);
  }
} finally {
  db.close();
  for (const r of repos) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
