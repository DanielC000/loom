import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision c7dc99bf — never derive the own-files set from a candidate's own trailer, a live ref, or any
// reconcile-time anchor; read it from the review-time stamped filesChangedPaths directly, and
// content-check candidates against that set only.
//
// This tests `attributeStaleGenerationOwnLanding` (sessions/service.ts, boot-reconcile Pass A2). Six
// rounds each closed a deeper form of the same root cause — read docs/decisions/c7dc99bf-*.md for the
// full history before trusting a shortened version of it.
//
// REAL git on temp repos, NO claude + NO live daemon — drives reconcileOrchestrationOnBoot() directly
// against an isolated LOOM_HOME, same harness shape as worktree-recycle-alias-protection.mjs.
//
// Scenarios, by expected verdict (NOT a uniform "forged+genuine pair" — several are escalate-only or
// attribute-only, see their own setup functions below for the exact shape each covers): FORGED (escalate
// — content-unrelated forgery), GENUINE (attribute — a real union-chain landing), OVERLAP (escalate — an
// ACCEPTED residual, a legitimate content collision with later main history), FB_LANDEDTIP /
// FB_NOLANDEDTIP (escalate — a forged partial landing, one per trailer arm), ZERODELTA (escalate-only — a
// forged zero-delta attempt; the generic reason, never the misleading zero-delta wording), REFMOVE
// (escalate — a ref-move narrowing attempt, now structurally moot but still caught on content mismatch),
// SCOPED_REVIEW_GENUINE (attribute — a genuine landing whose last review was display-scoped still stamps
// the full set), RENAME_PARTIAL (escalate — an incomplete rename), LEGACY (escalate-only — a GENUINE
// landing with no `filesChangedPaths` stamp at all; unknown is never treated as zero), REVERT (escalate —
// a trust-anchored diff would wrongly drop the worker's own revert), LAG (attribute — a genuine landing
// under a would-be-frozen anchor that no longer exists to lag). SPECIAL_NAME_* — four REAL-PRODUCER
// scenarios (through the actual `reviewWorkerMerge`, never a hand-written `filesChangedPaths`), one per
// hazardous name shape (non-ASCII+CJK, a literal `{{x}}/` directory, a space, a leading `-`), each
// escalate-only (a partial landing missing that name) paired with ONE combined attribute-only scenario
// (a genuine landing carrying all four names).
//
// Plus direct unit-style proofs: `machineReadablePathSet`'s own cap/name-reading behavior and its pure
// `parseNameStatusZ` parse (malformed-record + UTF-8 byte accounting); a mutation proof that dropping a
// stamped path from the content check wrongly attributes; a producer-side proof that a SCOPED
// `reviewWorkerMerge` call still stamps the unfiltered set; a repurposed bracket-precision proof (no
// longer about `--literal-pathspecs`, which card 1cf79e64 removed — see below); a `stampedPathsPlausible`
// "backslash net" proof (what the net actually catches, plus its own false-escalation regression fix); a
// `filesChangedPaths` assertion on each SPECIAL_NAME_* partial scenario, so a truncated/absent stamp can't
// satisfy the escalation check by accident.
//
// One named residual (not fixed, not tested — recorded in docs/decisions/c7dc99bf-*.md, do not
// re-derive): "the check is only as strong as the review-time HEAD" — a review that ran against a
// stale/diverted canonical checkout stamps whatever that checkout's diff found, nothing here re-verifies
// it against a later-resolved mainline.
//
// Card `1cf79e64` (docs/decisions/1cf79e64-*.md) FIXED c7dc99bf's own Finding 4/4b — a partial/forged
// landing that omits a real backslash-named file was wrongly attributed, and (wider) an all-backslash
// stamp could attribute against an arbitrary unrelated candidate, both because git's backslash-as-
// separator handling on Windows defeats ANY pathspec. `recordedTipContentLanded` no longer uses a
// pathspec at all — it compares stamped paths' own tree entries (mode+type+sha, via `fullTreeEntries`) by
// exact string equality. Tested below: F4 (a genuine omission now escalates) and F4b (an all-backslash
// stamp against an unrelated candidate now escalates), a non-ASCII name and a case-variant pair (both
// exact-match, no normalization), and `files.length === 0` failing closed rather than vacuously
// attributing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";
import { sleepPast } from "./_wait.mjs"; // card 05915fc7 round 3 (S3): proves the BOUND_AGE wait is a real floor, not a guess
import simpleGit from "simple-git"; // card 05915fc7 round 2: a REAL spawn-level failure via a bogus binary (the gitFactory test seam)

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-c7dc99bf-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, verifyReviewedTipChain, recordedTipContentLanded, stampedPathsPlausible, fullTreeEntries, machineReadablePathSet, parseNameStatusZ, FILES_CHANGED_PATHS_MAX_COUNT, FILES_CHANGED_PATHS_MAX_BYTES } = await import("../dist/git/worktrees.js");
const { mainlineWatermarkKey } = await import("../dist/git/mainline-watch.js");
// Card 05915fc7: CanonicalGitRefusal injection (via the documented test-seam registerCommondirTrustPinLookup)
// and console capture, same idiom as merge-reconcile-wedge.mjs's own warnsMatching/infosMatching.
const { CanonicalGitRefusal, registerCommondirTrustPinLookup } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const warns = [];
const realWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(" ")); realWarn(...a); };
const warnsMatching = (needle) => warns.filter((w) => w.includes(needle));
const GIT_ID = "-c user.email=sglt@loom -c user.name=sglt";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
// Matches worktree-recycle-alias-protection.mjs's own xLastActivityFor/yCreatedAtFor exactly — the
// generation-recency grouping (currentGenerationIds) needs X's own createdAt/lastActivity to predate Y's,
// or X can be wrongly picked as "current" and routed into Pass A's ordinary finalize instead of being
// recognized as the stale generation Pass A2 is supposed to attribute.
const xLastActivityFor = (baseNow) => new Date(Date.parse(baseNow) + 20_000).toISOString();
const yCreatedAtFor = (baseNow) => new Date(Date.parse(baseNow) + 10_000).toISOString();

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# sglt\n");
  // Many lines, so a top-edit and a bottom-edit (OVERLAP scenario) sit far enough apart for git's default
  // merge strategy to combine them cleanly (no textual conflict) while still producing DIFFERENT combined
  // content than either side alone.
  fs.writeFileSync(path.join(repo, "shared.txt"), Array.from({ length: 20 }, (_, i) => `line${i}\n`).join(""));
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  git(repo, "branch -M main");
  git(repo, "symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main");
}

const db = new Db();
const pty = { enqueueStdin: () => ({ delivered: false, deliveryState: "queued" }) };
const sessions = new SessionService(db, pty, new OrchestrationControl());

async function baseSetup(tag, repo) {
  initRepo(repo);
  const projId = `sglt-${tag}-proj-${sfx}`, agentId = `sglt-${tag}-agent-${sfx}`, taskId = `sglt-${tag}-task-${sfx}`;
  const mgrId = `sglt-${tag}-mgr-${sfx}`, workerXId = `sglt-${tag}-workerx-${sfx}`, workerYId = `sglt-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `SGLT-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `SGLT-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const genesisSha = git(repo, "rev-parse HEAD");
  db.setMeta(mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: genesisSha }));
  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  return { projId, taskId, mgrId, workerXId, workerYId, repo, first, genesisSha, tag };
}

async function finishWithRetask(ctx) {
  const { projId, taskId, mgrId, workerYId, repo } = ctx;
  const second = await createWorktree(repo, projId, taskId); // re-task reuses X's exact path/branch
  db.insertSession({ id: workerYId, projectId: projId, agentId: `sglt-${ctx.tag}-agent-${sfx}`, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
  fs.writeFileSync(path.join(second.worktreePath, "y.txt"), "y work\n");
  commitAll(second.worktreePath, "y", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${second.branch} && git ${GIT_ID} commit -q -m "SGLT-${ctx.tag}-y" -m "Loom-Worker-Branch: ${second.branch}"`, { cwd: repo });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch } });
  return { worktreePath: second.worktreePath, branch: second.branch };
}

// --- Scenario FORGED: a garbage, content-unrelated commit forged with Loom-Landed-Tip == reviewedTip ---
async function setupForgedLandedTip(tag, repo) {
  const ctx = await baseSetup(tag, repo);
  const { first, mgrId, workerXId, taskId, repo: repoPath } = ctx;
  fs.writeFileSync(path.join(first.worktreePath, "x.txt"), "x real work, never actually landed\n");
  commitAll(first.worktreePath, "x", GIT_ID);
  const xTip = git(first.worktreePath, "rev-parse HEAD"); // X's own reviewed tip — never merged anywhere

  fs.writeFileSync(path.join(repoPath, "pwned.txt"), "unrelated garbage, nothing to do with X's real work\n");
  commitAll(repoPath, [`chore(unrelated): forged commit`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${xTip}`], GIT_ID);
  const forgedSha = git(repoPath, "rev-parse HEAD");

  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: xTip, filesChangedPaths: ["x.txt"] } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

  const y = await finishWithRetask(ctx);
  return { ...ctx, ...y, xTip, forgedSha };
}

// --- Scenario GENUINE: a real Loom-style union (hops=1), clean, no file overlap with main's advance ---
async function setupGenuineUnionNoOverlap(tag, repo) {
  const ctx = await baseSetup(tag, repo);
  const { first, mgrId, workerXId, taskId, repo: repoPath } = ctx;
  fs.writeFileSync(path.join(first.worktreePath, "x.txt"), "x real work\n");
  commitAll(first.worktreePath, "x", GIT_ID);
  const xTip = git(first.worktreePath, "rev-parse HEAD");

  fs.writeFileSync(path.join(repoPath, "main-advance.txt"), "main moved on\n");
  commitAll(repoPath, "main advances", GIT_ID);
  const mTip = git(repoPath, "rev-parse HEAD");

  execSync(`git ${GIT_ID} merge -q --no-edit ${mTip}`, { cwd: first.worktreePath });
  const unionTip = git(first.worktreePath, "rev-parse HEAD");

  execSync(`git ${GIT_ID} merge --squash ${first.branch}`, { cwd: repoPath });
  commitAll(repoPath, [`SGLT-${tag}-x`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${unionTip}\nLoom-Worker-Base: ${mTip}`], GIT_ID);
  const xLandedSha = git(repoPath, "rev-parse HEAD");

  const chain = await verifyReviewedTipChain(repoPath, xTip, unionTip, {}, [], "HEAD");

  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: xTip, filesChangedPaths: ["x.txt"] } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

  const y = await finishWithRetask(ctx);
  return { ...ctx, ...y, xTip, unionTip, mTip, xLandedSha, chain };
}

// --- Scenario OVERLAP: same shape as GENUINE, but main's advance ALSO touches the worker's own file ---
async function setupGenuineUnionWithOverlap(tag, repo) {
  const ctx = await baseSetup(tag, repo);
  const { first, mgrId, workerXId, taskId, repo: repoPath } = ctx;
  {
    const p = path.join(first.worktreePath, "shared.txt");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/line1\r?\n/, (m) => `${m}x inserted here\n`));
  }
  commitAll(first.worktreePath, "x touches shared.txt (top)", GIT_ID);
  const xTip = git(first.worktreePath, "rev-parse HEAD");

  {
    const p = path.join(repoPath, "shared.txt");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/line18\r?\n/, (m) => `${m}main inserted here\n`));
  }
  commitAll(repoPath, "main also touches shared.txt (bottom)", GIT_ID);
  const mTip = git(repoPath, "rev-parse HEAD");

  execSync(`git ${GIT_ID} merge -q --no-edit ${mTip}`, { cwd: first.worktreePath });
  const unionTip = git(first.worktreePath, "rev-parse HEAD");

  execSync(`git ${GIT_ID} merge --squash ${first.branch}`, { cwd: repoPath });
  commitAll(repoPath, [`SGLT-${tag}-x`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${unionTip}\nLoom-Worker-Base: ${mTip}`], GIT_ID);
  const xLandedSha = git(repoPath, "rev-parse HEAD");

  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: xTip, filesChangedPaths: ["shared.txt"] } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

  const y = await finishWithRetask(ctx);
  return { ...ctx, ...y, xTip, unionTip, mTip, xLandedSha };
}

// --- Scenario LEGACY (repurposed from round 3's LEGACY_NO_TOTAL): a genuine landing whose merge_request
// carries NO filesChangedPaths at all (the pre-round-4 shape). Must ESCALATE — absence is UNKNOWN, not an
// empty set. ---
async function setupLegacyNoFilesChangedPaths(tag, repo) {
  const ctx = await baseSetup(tag, repo);
  const { first, mgrId, workerXId, taskId, repo: repoPath } = ctx;
  fs.writeFileSync(path.join(first.worktreePath, "x.txt"), "x real work\n");
  commitAll(first.worktreePath, "x", GIT_ID);
  const xTip = git(first.worktreePath, "rev-parse HEAD");

  fs.writeFileSync(path.join(repoPath, "main-advance.txt"), "main moved on\n");
  commitAll(repoPath, "main advances", GIT_ID);
  const mTip = git(repoPath, "rev-parse HEAD");

  execSync(`git ${GIT_ID} merge -q --no-edit ${mTip}`, { cwd: first.worktreePath });
  const unionTip = git(first.worktreePath, "rev-parse HEAD");

  execSync(`git ${GIT_ID} merge --squash ${first.branch}`, { cwd: repoPath });
  commitAll(repoPath, [`SGLT-${tag}-x`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${unionTip}`], GIT_ID);
  const xLandedSha = git(repoPath, "rev-parse HEAD");

  // Deliberately NO filesChangedPaths (and no filesChangedTotal either) — the pre-round-4 row shape.
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: xTip } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

  const y = await finishWithRetask(ctx);
  return { ...ctx, ...y, xTip, unionTip, mTip, xLandedSha };
}

// --- Scenario FB_LANDEDTIP: round 2's own repro, landedTip arm — still closed under round 4's stamped set ---
async function setupForgedBaseLandedTip(tag, repo) {
  const ctx = await baseSetup(tag, repo);
  const { first, mgrId, workerXId, taskId, repo: repoPath } = ctx;
  fs.writeFileSync(path.join(first.worktreePath, "A.txt"), "worker A\n");
  commitAll(first.worktreePath, "c1 A", GIT_ID);
  const c1 = git(first.worktreePath, "rev-parse HEAD");
  fs.writeFileSync(path.join(first.worktreePath, "B.txt"), "worker B\n");
  commitAll(first.worktreePath, "c2 B", GIT_ID);
  const c2 = git(first.worktreePath, "rev-parse HEAD");

  fs.writeFileSync(path.join(repoPath, "B.txt"), "worker B\n");
  commitAll(repoPath, [`chore(unrelated): forged partial landing`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${c2}\nLoom-Worker-Base: ${c1}`], GIT_ID);
  const forgedSha = git(repoPath, "rev-parse HEAD");

  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: c2, filesChangedPaths: ["A.txt", "B.txt"] } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

  const y = await finishWithRetask(ctx);
  return { ...ctx, ...y, c1, c2, forgedSha };
}

// --- Scenario FB_NOLANDEDTIP: the sibling arm's own twin ---
async function setupForgedBaseNoLandedTip(tag, repo) {
  const ctx = await baseSetup(tag, repo);
  const { first, mgrId, workerXId, taskId, repo: repoPath } = ctx;
  fs.writeFileSync(path.join(first.worktreePath, "A.txt"), "worker A\n");
  commitAll(first.worktreePath, "c1 A", GIT_ID);
  const c1 = git(first.worktreePath, "rev-parse HEAD");
  fs.writeFileSync(path.join(first.worktreePath, "B.txt"), "worker B\n");
  commitAll(first.worktreePath, "c2 B", GIT_ID);
  const c2 = git(first.worktreePath, "rev-parse HEAD");

  fs.writeFileSync(path.join(repoPath, "B.txt"), "worker B\n");
  commitAll(repoPath, [`chore(unrelated): forged partial landing (no landedTip)`, `Loom-Worker-Branch: ${first.branch}\nLoom-Worker-Base: ${c1}`], GIT_ID);
  const forgedSha = git(repoPath, "rev-parse HEAD");

  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: c2, filesChangedPaths: ["A.txt", "B.txt"] } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

  const y = await finishWithRetask(ctx);
  return { ...ctx, ...y, c1, c2, forgedSha };
}

// --- Scenario ZERODELTA: forged Loom-Worker-Base == reviewedTip, trying (pre-round-4) to force a
// "zero-delta" verdict. Under round 4's design this candidate's content simply doesn't match the stamped
// A.txt/B.txt set at all — it still escalates, but via the ordinary no-match path, not zero-delta. ---
async function setupZeroDeltaForgery(tag, repo) {
  const ctx = await baseSetup(tag, repo);
  const { first, mgrId, workerXId, taskId, repo: repoPath } = ctx;
  fs.writeFileSync(path.join(first.worktreePath, "A.txt"), "worker A\n");
  commitAll(first.worktreePath, "c1 A", GIT_ID);
  const c1 = git(first.worktreePath, "rev-parse HEAD");
  fs.writeFileSync(path.join(first.worktreePath, "B.txt"), "worker B\n");
  commitAll(first.worktreePath, "c2 B", GIT_ID);
  const c2 = git(first.worktreePath, "rev-parse HEAD");

  fs.writeFileSync(path.join(repoPath, "unrelated-garbage.txt"), "nothing to do with A or B\n");
  commitAll(repoPath, [`chore(unrelated): forged zero-delta attempt`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${c2}\nLoom-Worker-Base: ${c2}`], GIT_ID);
  const forgedSha = git(repoPath, "rev-parse HEAD");

  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: c2, filesChangedPaths: ["A.txt", "B.txt"] } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

  const y = await finishWithRetask(ctx);
  return { ...ctx, ...y, c1, c2, forgedSha };
}

// --- Scenario REFMOVE: a ref-writer injects a worker intermediate into main's ancestry with NO content
// change (`git merge -s ours`), then a forged commit copies only PART of the worker's real work. Under
// round 4's design the own-files set never reads the live ref at all (it's the review-time stamped set),
// so this is structurally moot as a narrowing vector — still ESCALATES, on content mismatch. ---
async function setupRefMoveNarrowing(tag, repo) {
  const ctx = await baseSetup(tag, repo);
  const { first, mgrId, workerXId, taskId, repo: repoPath } = ctx;
  fs.writeFileSync(path.join(first.worktreePath, "A.txt"), "worker A\n");
  commitAll(first.worktreePath, "c1 A", GIT_ID);
  const c1 = git(first.worktreePath, "rev-parse HEAD");
  fs.writeFileSync(path.join(first.worktreePath, "B.txt"), "worker B\n");
  commitAll(first.worktreePath, "c2 B", GIT_ID);
  const c2 = git(first.worktreePath, "rev-parse HEAD"); // reviewedTip

  // Ref-writer: fold c1 into main's ancestry via a real merge with NO content change (ours strategy).
  execSync(`git ${GIT_ID} merge -s ours -q --no-edit ${c1}`, { cwd: repoPath });

  // Forger copies ONLY B.txt onto this now-tampered main, claiming a trivial hop-0 Loom-Landed-Tip match.
  fs.writeFileSync(path.join(repoPath, "B.txt"), "worker B\n");
  commitAll(repoPath, [`chore(unrelated): forged partial landing (ref-move)`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${c2}`], GIT_ID);
  const forgedSha = git(repoPath, "rev-parse HEAD");

  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: c2, filesChangedPaths: ["A.txt", "B.txt"] } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

  const y = await finishWithRetask(ctx);
  return { ...ctx, ...y, c1, c2, forgedSha };
}

// --- Scenario SCOPED_REVIEW_GENUINE: a genuine landing whose LAST review was scoped (files/pathGlob
// narrower than the real total) — filesChanged (filtered) = 1, but filesChangedPaths is still the FULL
// unfiltered set. Must still ATTRIBUTE. ---
async function setupScopedReviewGenuine(tag, repo) {
  const ctx = await baseSetup(tag, repo);
  const { first, mgrId, workerXId, taskId, repo: repoPath } = ctx;
  fs.writeFileSync(path.join(first.worktreePath, "A.txt"), "worker A\n");
  commitAll(first.worktreePath, "c1 A", GIT_ID);
  fs.writeFileSync(path.join(first.worktreePath, "B.txt"), "worker B\n");
  commitAll(first.worktreePath, "c2 B", GIT_ID);
  const reviewedTip = git(first.worktreePath, "rev-parse HEAD");

  execSync(`git ${GIT_ID} merge --squash ${first.branch}`, { cwd: repoPath });
  commitAll(repoPath, [`SGLT-${tag}-x`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${reviewedTip}`], GIT_ID);
  const xLandedSha = git(repoPath, "rev-parse HEAD");

  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: reviewedTip, filesChanged: 1, filesChangedPaths: ["A.txt", "B.txt"] } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

  const y = await finishWithRetask(ctx);
  return { ...ctx, ...y, reviewedTip, xLandedSha };
}

// --- Scenario RENAME_PARTIAL: a genuine rename, and a forged candidate that adds the new path but never
// deletes the old one. Must ESCALATE — old.txt's own non-deletion is visible to the content check once
// BOTH sides of the rename are in the stamped pathspec. ---
async function setupRenamePartialLanding(tag, repo) {
  // old.txt must already exist at GENESIS (before the worker's own worktree is even cut) — a rename
  // collapsed entirely within the genesis..reviewedTip range, with no earlier snapshot containing the old
  // path, is indistinguishable from a plain add.
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "old.txt"), "content\n");
  commitAll(repo, "seed old.txt (pre-worker)", GIT_ID);
  const projId = `sglt-${tag}-proj-${sfx}`, agentId = `sglt-${tag}-agent-${sfx}`, taskId = `sglt-${tag}-task-${sfx}`;
  const mgrId = `sglt-${tag}-mgr-${sfx}`, workerXId = `sglt-${tag}-workerx-${sfx}`, workerYId = `sglt-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `SGLT-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `SGLT-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const genesisSha = git(repo, "rev-parse HEAD"); // genesis NOW includes old.txt
  db.setMeta(mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: genesisSha }));
  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  const ctx = { projId, taskId, mgrId, workerXId, workerYId, repo, first, genesisSha, tag };
  const { repo: repoPath } = ctx;

  // The worker's OWN commit is now PURELY the rename — genesis has old.txt, reviewedTip has new.txt only.
  execSync(`git mv old.txt new.txt`, { cwd: first.worktreePath });
  commitAll(first.worktreePath, "rename old.txt to new.txt", GIT_ID);
  const reviewedTip = git(first.worktreePath, "rev-parse HEAD");

  // Forger: adds new.txt (matching content) but ALSO keeps old.txt around — the rename never genuinely
  // completed on main.
  fs.writeFileSync(path.join(repoPath, "old.txt"), "content\n");
  fs.writeFileSync(path.join(repoPath, "new.txt"), "content\n");
  commitAll(repoPath, [`chore(unrelated): forged incomplete rename`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${reviewedTip}`], GIT_ID);
  const forgedSha = git(repoPath, "rev-parse HEAD");

  // A real review would see this as a RENAME row (both sides, per machineReadablePathSet's rename-awareness).
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: reviewedTip, filesChangedPaths: ["new.txt", "old.txt"] } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

  const y = await finishWithRetask(ctx);
  return { ...ctx, ...y, reviewedTip, forgedSha };
}

// --- Scenario REVERT (NEW, round 4 finding 1's own repro, reviewer bc701e99): a Loom-durable trust record
// would be FROZEN at the repo's genesis (an out-of-band main commit between genesis and the worker's fork
// skips advancing it — the "chronic lag" CR3 measured). The worker's own commit REVERTS A.txt back to its
// pre-out-of-band value (a genuine edit, cancelling out when diffed against that frozen anchor) and ADDS
// B.txt. A partial landing lands ONLY B.txt — the worker's own revert of A.txt never lands. A trust-
// anchored diff (round 3's design) would (a) DROP A.txt from the own-files set (nets to no change against
// the frozen anchor) and (b) ADD Z.txt (main's own unrelated out-of-band drift), letting this partial
// landing's missing A.txt slip through unchecked entirely. Round 4's review-time stamped set has neither
// defect: the real review (at the point the worker's commit existed) sees BOTH A.txt and B.txt, and never
// sees Z.txt at all (the worker never touched it). Must ESCALATE. ---
async function setupRevertPartialLanding(tag, repo) {
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "A.txt"), "old\n");
  fs.writeFileSync(path.join(repo, "Z.txt"), "z0\n");
  commitAll(repo, "seed A/Z (pre-worker)", GIT_ID);
  const projId = `sglt-${tag}-proj-${sfx}`, agentId = `sglt-${tag}-agent-${sfx}`, taskId = `sglt-${tag}-task-${sfx}`;
  const mgrId = `sglt-${tag}-mgr-${sfx}`, workerXId = `sglt-${tag}-workerx-${sfx}`, workerYId = `sglt-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `SGLT-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `SGLT-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const genesisSha = git(repo, "rev-parse HEAD"); // A=old, Z=z0 — where round 3's trust record would freeze

  // Out-of-band main commit BEFORE the worker forks: A moves old->mid, Z moves z0->z1.
  fs.writeFileSync(path.join(repo, "A.txt"), "mid\n");
  fs.writeFileSync(path.join(repo, "Z.txt"), "z1\n");
  commitAll(repo, "out-of-band main commit (round 3's trust would freeze at genesis here)", GIT_ID);

  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });

  // Worker REVERTS A back to "old" (its own genuine edit) and adds B — a real review at this point would
  // see BOTH A.txt and B.txt in its diffstat (never Z.txt, which the worker never touched).
  fs.writeFileSync(path.join(first.worktreePath, "A.txt"), "old\n");
  fs.writeFileSync(path.join(first.worktreePath, "B.txt"), "b\n");
  commitAll(first.worktreePath, "worker: revert A, add B", GIT_ID);
  const reviewedTip = git(first.worktreePath, "rev-parse HEAD");

  // A PARTIAL landing: only B.txt lands, A.txt's revert never does.
  fs.writeFileSync(path.join(repo, "B.txt"), "b\n");
  commitAll(repo, [`chore(unrelated): partial landing (B only)`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${reviewedTip}`], GIT_ID);
  const forgedSha = git(repo, "rev-parse HEAD");

  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: reviewedTip, filesChangedPaths: ["A.txt", "B.txt"] } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

  const ctx = { projId, taskId, mgrId, workerXId, workerYId, repo, first, genesisSha, tag };
  const y = await finishWithRetask(ctx);
  return { ...ctx, ...y, reviewedTip, forgedSha };
}

// --- Scenario LAG (NEW, round 4 — CR3's own "lag" repro, reviewer bc701e99): a Loom-durable trust record
// would be FROZEN at genesis (an out-of-band main commit between genesis and the worker's fork skips
// advancing it). The worker adds B.txt only — never touching Z.txt. AFTER the worker's fork, main drifts
// again on Z.txt, then a genuine squash lands B.txt. Must still ATTRIBUTE: the review-time stamped set is
// exactly ["B.txt"] (the worker's own real file, computed against the live mainline HEAD at review time,
// never against any anchor), so main's own later drift on Z.txt never enters the pathspec at all — nothing
// left for a lagging anchor to mishandle. ---
async function setupLagGenuineLanding(tag, repo) {
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "Z.txt"), "z0\n");
  commitAll(repo, "seed Z (pre-worker)", GIT_ID);
  const projId = `sglt-${tag}-proj-${sfx}`, agentId = `sglt-${tag}-agent-${sfx}`, taskId = `sglt-${tag}-task-${sfx}`;
  const mgrId = `sglt-${tag}-mgr-${sfx}`, workerXId = `sglt-${tag}-workerx-${sfx}`, workerYId = `sglt-${tag}-workery-${sfx}`;
  db.insertProject({ id: projId, name: `SGLT-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: `SGLT-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const genesisSha = git(repo, "rev-parse HEAD"); // where round 3's trust record would freeze

  // Out-of-band main commit BEFORE the worker forks.
  fs.writeFileSync(path.join(repo, "Z.txt"), "z1\n");
  commitAll(repo, "out-of-band main commit (round 3's trust would freeze at genesis here)", GIT_ID);

  const first = await createWorktree(repo, projId, taskId);
  db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });

  // Worker adds B.txt only — a real review at this point sees exactly ["B.txt"] (never Z.txt).
  fs.writeFileSync(path.join(first.worktreePath, "B.txt"), "b\n");
  commitAll(first.worktreePath, "worker: add B", GIT_ID);
  const reviewedTip = git(first.worktreePath, "rev-parse HEAD");

  // ANOTHER main commit after the worker's fork, then a genuine squash landing.
  fs.writeFileSync(path.join(repo, "Z.txt"), "z2\n");
  commitAll(repo, "another main commit after fork", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${first.branch}`, { cwd: repo });
  commitAll(repo, [`genuine landing`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${reviewedTip}`], GIT_ID);
  const xLandedSha = git(repo, "rev-parse HEAD");

  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: reviewedTip, filesChangedPaths: ["B.txt"] } });
  db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

  const ctx = { projId, taskId, mgrId, workerXId, workerYId, repo, first, genesisSha, tag };
  const y = await finishWithRetask(ctx);
  return { ...ctx, ...y, reviewedTip, xLandedSha };
}

const R_FORGED = path.join(os.tmpdir(), `loom-sglt-forged-${sfx}`);
const R_GENUINE = path.join(os.tmpdir(), `loom-sglt-genuine-${sfx}`);
const R_OVERLAP = path.join(os.tmpdir(), `loom-sglt-overlap-${sfx}`);
const R_LEGACY = path.join(os.tmpdir(), `loom-sglt-legacy-${sfx}`);
const R_FB_LANDEDTIP = path.join(os.tmpdir(), `loom-sglt-fblt-${sfx}`);
const R_FB_NOLANDEDTIP = path.join(os.tmpdir(), `loom-sglt-fbnlt-${sfx}`);
const R_ZERODELTA = path.join(os.tmpdir(), `loom-sglt-zd-${sfx}`);
const R_REFMOVE = path.join(os.tmpdir(), `loom-sglt-refmove-${sfx}`);
const R_SCOPED = path.join(os.tmpdir(), `loom-sglt-scoped-${sfx}`);
const R_RENAME = path.join(os.tmpdir(), `loom-sglt-rename-${sfx}`);
const R_REVERT = path.join(os.tmpdir(), `loom-sglt-revert-${sfx}`);
const R_LAG = path.join(os.tmpdir(), `loom-sglt-lag-${sfx}`);

let FORGED, GENUINE, OVERLAP, LEGACY, FB_LANDEDTIP, FB_NOLANDEDTIP, ZERODELTA, REFMOVE, SCOPED, RENAME, REVERT, LAG;
try {
  FORGED = await setupForgedLandedTip("forged", R_FORGED);
  GENUINE = await setupGenuineUnionNoOverlap("genuine", R_GENUINE);
  OVERLAP = await setupGenuineUnionWithOverlap("overlap", R_OVERLAP);
  LEGACY = await setupLegacyNoFilesChangedPaths("legacy", R_LEGACY);
  FB_LANDEDTIP = await setupForgedBaseLandedTip("fblt", R_FB_LANDEDTIP);
  FB_NOLANDEDTIP = await setupForgedBaseNoLandedTip("fbnlt", R_FB_NOLANDEDTIP);
  ZERODELTA = await setupZeroDeltaForgery("zd", R_ZERODELTA);
  REFMOVE = await setupRefMoveNarrowing("refmove", R_REFMOVE);
  SCOPED = await setupScopedReviewGenuine("scoped", R_SCOPED);
  RENAME = await setupRenamePartialLanding("rename", R_RENAME);
  REVERT = await setupRevertPartialLanding("revert", R_REVERT);
  LAG = await setupLagGenuineLanding("lag", R_LAG);

  check("(GENUINE) the union IS a genuine hops>0 chain (never the trivial hop-0 cur===reviewed shortcut)",
    GENUINE.chain.ok === true && GENUINE.chain.hops > 0);

  const r = await sessions.reconcileOrchestrationOnBoot(new Set());
  console.log("reconcile result:", JSON.stringify(r));

  // --- FORGED ---
  const forgedMergeDone = db.listEventsForWorker(FORGED.workerXId).find((ev) => ev.kind === "merge_done");
  check("(FORGED) never attributed to the forged, content-unrelated sha", !forgedMergeDone || forgedMergeDone.detail?.attributedLandedSha !== FORGED.forgedSha);
  check("(FORGED) escalated instead", db.listStaleGenerationUnresolved().some((e) => e.sessionId === FORGED.workerXId));
  check("(FORGED) worker Y is still independently finalized, unaffected", db.listEventsForWorker(FORGED.workerYId).some((ev) => ev.kind === "merge_done"));

  // --- GENUINE ---
  const genuineMergeDone = db.listEventsForWorker(GENUINE.workerXId).find((ev) => ev.kind === "merge_done");
  check("(GENUINE) attributed to its OWN genuinely-landed sha", genuineMergeDone?.detail?.staleGenerationAttributed === true && genuineMergeDone?.detail?.attributedLandedSha === GENUINE.xLandedSha);
  check("(GENUINE) never escalated", db.listStaleGenerationUnresolved().every((e) => e.sessionId !== GENUINE.workerXId));
  check("(GENUINE) worker Y is still independently finalized, unaffected", db.listEventsForWorker(GENUINE.workerYId).some((ev) => ev.kind === "merge_done"));

  // --- OVERLAP (accepted residual) ---
  check("(OVERLAP) escalated — the ACCEPTED residual", db.listStaleGenerationUnresolved().some((e) => e.sessionId === OVERLAP.workerXId));
  check("(OVERLAP) never gets a merge_done", db.listEventsForWorker(OVERLAP.workerXId).every((ev) => ev.kind !== "merge_done"));
  check("(OVERLAP) worker Y is still independently finalized, unaffected", db.listEventsForWorker(OVERLAP.workerYId).some((ev) => ev.kind === "merge_done"));

  // --- LEGACY (no filesChangedPaths) ---
  check("(LEGACY) a genuine landing with NO filesChangedPaths escalates (unknown, never attributed)", db.listStaleGenerationUnresolved().some((e) => e.sessionId === LEGACY.workerXId));
  check("(LEGACY) never gets a merge_done", db.listEventsForWorker(LEGACY.workerXId).every((ev) => ev.kind !== "merge_done"));
  check("(LEGACY) worker Y is still independently finalized, unaffected", db.listEventsForWorker(LEGACY.workerYId).some((ev) => ev.kind === "merge_done"));

  // --- FB_LANDEDTIP / FB_NOLANDEDTIP ---
  const fbltMergeDone = db.listEventsForWorker(FB_LANDEDTIP.workerXId).find((ev) => ev.kind === "merge_done");
  check("(FB_LANDEDTIP) never attributed to the partial forgery", !fbltMergeDone || fbltMergeDone.detail?.attributedLandedSha !== FB_LANDEDTIP.forgedSha);
  check("(FB_LANDEDTIP) escalated", db.listStaleGenerationUnresolved().some((e) => e.sessionId === FB_LANDEDTIP.workerXId));
  check("(FB_LANDEDTIP) worker Y is still independently finalized, unaffected", db.listEventsForWorker(FB_LANDEDTIP.workerYId).some((ev) => ev.kind === "merge_done"));

  const fbnltMergeDone = db.listEventsForWorker(FB_NOLANDEDTIP.workerXId).find((ev) => ev.kind === "merge_done");
  check("(FB_NOLANDEDTIP) never attributed to the partial forgery", !fbnltMergeDone || fbnltMergeDone.detail?.attributedLandedSha !== FB_NOLANDEDTIP.forgedSha);
  check("(FB_NOLANDEDTIP) escalated", db.listStaleGenerationUnresolved().some((e) => e.sessionId === FB_NOLANDEDTIP.workerXId));
  check("(FB_NOLANDEDTIP) worker Y is still independently finalized, unaffected", db.listEventsForWorker(FB_NOLANDEDTIP.workerYId).some((ev) => ev.kind === "merge_done"));

  // --- ZERODELTA ---
  const zdMergeDone = db.listEventsForWorker(ZERODELTA.workerXId).find((ev) => ev.kind === "merge_done");
  check("(ZERODELTA) never attributed to the forged sha", !zdMergeDone || zdMergeDone.detail?.attributedLandedSha !== ZERODELTA.forgedSha);
  const zdEntry = db.listStaleGenerationUnresolved().find((e) => e.sessionId === ZERODELTA.workerXId);
  check("(ZERODELTA) escalated", !!zdEntry);
  check("(ZERODELTA) escalation reason is the GENERIC one, never the misleading zero-delta wording",
    !!zdEntry && !zdEntry.reason.includes("recorded no changes") && zdEntry.reason.includes("no landed commit's content could be verified"));
  check("(ZERODELTA) worker Y is still independently finalized, unaffected", db.listEventsForWorker(ZERODELTA.workerYId).some((ev) => ev.kind === "merge_done"));

  // --- REFMOVE ---
  const refmoveMergeDone = db.listEventsForWorker(REFMOVE.workerXId).find((ev) => ev.kind === "merge_done");
  check("(REFMOVE) never attributed to the ref-move-narrowed forgery", !refmoveMergeDone || refmoveMergeDone.detail?.attributedLandedSha !== REFMOVE.forgedSha);
  check("(REFMOVE) escalated — the live ref is never consulted for the own-files set at all now", db.listStaleGenerationUnresolved().some((e) => e.sessionId === REFMOVE.workerXId));
  check("(REFMOVE) worker Y is still independently finalized, unaffected", db.listEventsForWorker(REFMOVE.workerYId).some((ev) => ev.kind === "merge_done"));

  // --- SCOPED ---
  const scopedMergeDone = db.listEventsForWorker(SCOPED.workerXId).find((ev) => ev.kind === "merge_done");
  check("(SCOPED) a genuine landing whose last review was scoped still attributes", scopedMergeDone?.detail?.staleGenerationAttributed === true && scopedMergeDone?.detail?.attributedLandedSha === SCOPED.xLandedSha);
  check("(SCOPED) never escalated", db.listStaleGenerationUnresolved().every((e) => e.sessionId !== SCOPED.workerXId));
  check("(SCOPED) worker Y is still independently finalized, unaffected", db.listEventsForWorker(SCOPED.workerYId).some((ev) => ev.kind === "merge_done"));

  // --- RENAME ---
  const renameMergeDone = db.listEventsForWorker(RENAME.workerXId).find((ev) => ev.kind === "merge_done");
  check("(RENAME) never attributed to the incomplete-rename forgery", !renameMergeDone || renameMergeDone.detail?.attributedLandedSha !== RENAME.forgedSha);
  check("(RENAME) escalated — old.txt's non-deletion is visible once both rename sides are in the pathspec", db.listStaleGenerationUnresolved().some((e) => e.sessionId === RENAME.workerXId));
  check("(RENAME) worker Y is still independently finalized, unaffected", db.listEventsForWorker(RENAME.workerYId).some((ev) => ev.kind === "merge_done"));

  // --- REVERT (NEW) ---
  const revertMergeDone = db.listEventsForWorker(REVERT.workerXId).find((ev) => ev.kind === "merge_done");
  check("(REVERT) never attributed to the partial landing missing its own revert", !revertMergeDone || revertMergeDone.detail?.attributedLandedSha !== REVERT.forgedSha);
  check("(REVERT) escalated — a trust-anchored diff would have dropped A.txt and attributed wrongly", db.listStaleGenerationUnresolved().some((e) => e.sessionId === REVERT.workerXId));
  check("(REVERT) worker Y is still independently finalized, unaffected", db.listEventsForWorker(REVERT.workerYId).some((ev) => ev.kind === "merge_done"));

  // --- LAG (NEW) ---
  const lagMergeDone = db.listEventsForWorker(LAG.workerXId).find((ev) => ev.kind === "merge_done");
  check("(LAG) a genuine landing under frozen trust with later main drift still attributes", lagMergeDone?.detail?.staleGenerationAttributed === true && lagMergeDone?.detail?.attributedLandedSha === LAG.xLandedSha);
  check("(LAG) never escalated", db.listStaleGenerationUnresolved().every((e) => e.sessionId !== LAG.workerXId));
  check("(LAG) worker Y is still independently finalized, unaffected", db.listEventsForWorker(LAG.workerYId).some((ev) => ev.kind === "merge_done"));

  // --- SPECIAL_NAME_* (NEW, round 5 ruling d): REAL-PRODUCER scenarios (through the actual
  // reviewWorkerMerge, never a hand-written filesChangedPaths) for four hazardous name shapes: a non-ASCII
  // name with a CJK char, a name under a literal `{{x}}/` directory, a name with a space, and a name with
  // a leading `-`. Each pairs a PARTIAL landing missing that file (must ESCALATE) with ONE combined
  // GENUINE landing including all four names (must ATTRIBUTE). Own self-contained reconcile pass, same
  // shape as round 3's ADVANCE_SKIP_LAG block. ---
  const SPECIAL_NAMES = {
    nonascii: "café-日本語.txt",
    braces: "{{tpl}}/a.txt",
    space: "my file.txt",
    dash: "-dashfile.txt",
  };
  async function setupSpecialNameBase(tag, repo) {
    initRepo(repo);
    const projId = `sglt-${tag}-proj-${sfx}`, agentId = `sglt-${tag}-agent-${sfx}`, taskId = `sglt-${tag}-task-${sfx}`;
    const mgrId = `sglt-${tag}-mgr-${sfx}`, workerXId = `sglt-${tag}-workerx-${sfx}`, workerYId = `sglt-${tag}-workery-${sfx}`;
    db.insertProject({ id: projId, name: `SGLT-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: `SGLT-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const genesisSha = git(repo, "rev-parse HEAD");
    db.setMeta(mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: genesisSha }));
    const first = await createWorktree(repo, projId, taskId);
    db.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
    return { projId, taskId, mgrId, workerXId, workerYId, repo, first, genesisSha, tag };
  }
  async function setupSpecialNamePartial(tag, repo, specialPath) {
    const ctx = await setupSpecialNameBase(tag, repo);
    const { first, mgrId, workerXId, repo: repoPath } = ctx;
    fs.mkdirSync(path.dirname(path.join(first.worktreePath, specialPath)), { recursive: true });
    fs.writeFileSync(path.join(first.worktreePath, specialPath), "special\n");
    fs.writeFileSync(path.join(first.worktreePath, "B.txt"), "b\n");
    commitAll(first.worktreePath, "add special name and B", GIT_ID);
    const reviewedTip = git(first.worktreePath, "rev-parse HEAD");
    // REAL PRODUCER: the actual reviewWorkerMerge call — filesChangedPaths is whatever it genuinely
    // computes, never hand-written.
    await sessions.reviewWorkerMerge(mgrId, workerXId);
    // PARTIAL landing: only B.txt lands, the special-named file's own addition never does.
    fs.writeFileSync(path.join(repoPath, "B.txt"), "b\n");
    commitAll(repoPath, [`chore(unrelated): partial landing (B only)`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${reviewedTip}`], GIT_ID);
    const forgedSha = git(repoPath, "rev-parse HEAD");
    // ts must be a FRESH real timestamp, never the frozen module-level `now` — events are read in `ts`
    // order, and the real reviewWorkerMerge call above stamps merge_request with the real current time,
    // which is LATER than `now` by the time several real git ops have run. Using `now` here put this
    // event's ts BEFORE merge_request's, flipping the lifecycle order and silently reading as "no-op"
    // (bare merge_request, review-only) instead of "merge_landing_started" (attempt attribution) — a real
    // bug this round's own test authoring hit once.
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrId, workerSessionId: workerXId, taskId: ctx.taskId, kind: "merge_landing_started", detail: {} });
    const y = await finishWithRetask(ctx);
    return { ...ctx, ...y, reviewedTip, forgedSha };
  }
  async function setupSpecialNamesGenuine(tag, repo) {
    const ctx = await setupSpecialNameBase(tag, repo);
    const { first, mgrId, workerXId, repo: repoPath } = ctx;
    for (const p of Object.values(SPECIAL_NAMES)) {
      fs.mkdirSync(path.dirname(path.join(first.worktreePath, p)), { recursive: true });
      fs.writeFileSync(path.join(first.worktreePath, p), "special\n");
    }
    commitAll(first.worktreePath, "add all special names", GIT_ID);
    const reviewedTip = git(first.worktreePath, "rev-parse HEAD");
    await sessions.reviewWorkerMerge(mgrId, workerXId);
    execSync(`git ${GIT_ID} merge --squash ${first.branch}`, { cwd: repoPath });
    commitAll(repoPath, [`SGLT-${tag}-x`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${reviewedTip}`], GIT_ID);
    const xLandedSha = git(repoPath, "rev-parse HEAD");
    // ts must be a FRESH real timestamp — see setupSpecialNamePartial's own comment on this exact trap.
    db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrId, workerSessionId: workerXId, taskId: ctx.taskId, kind: "merge_landing_started", detail: {} });
    const y = await finishWithRetask(ctx);
    return { ...ctx, ...y, reviewedTip, xLandedSha };
  }
  {
    const R_SN_NONASCII = path.join(os.tmpdir(), `loom-sglt-sn-nonascii-${sfx}`);
    const R_SN_BRACES = path.join(os.tmpdir(), `loom-sglt-sn-braces-${sfx}`);
    const R_SN_SPACE = path.join(os.tmpdir(), `loom-sglt-sn-space-${sfx}`);
    const R_SN_DASH = path.join(os.tmpdir(), `loom-sglt-sn-dash-${sfx}`);
    const R_SN_GENUINE = path.join(os.tmpdir(), `loom-sglt-sn-genuine-${sfx}`);
    try {
      const SN_NONASCII = await setupSpecialNamePartial("sn-nonascii", R_SN_NONASCII, SPECIAL_NAMES.nonascii);
      const SN_BRACES = await setupSpecialNamePartial("sn-braces", R_SN_BRACES, SPECIAL_NAMES.braces);
      const SN_SPACE = await setupSpecialNamePartial("sn-space", R_SN_SPACE, SPECIAL_NAMES.space);
      const SN_DASH = await setupSpecialNamePartial("sn-dash", R_SN_DASH, SPECIAL_NAMES.dash);
      const SN_GENUINE = await setupSpecialNamesGenuine("sn-genuine", R_SN_GENUINE);

      const r2 = await sessions.reconcileOrchestrationOnBoot(new Set());
      console.log("SPECIAL_NAME reconcile result:", JSON.stringify(r2));

      for (const [label, S, specialPath] of [
        ["SN_NONASCII", SN_NONASCII, SPECIAL_NAMES.nonascii],
        ["SN_BRACES", SN_BRACES, SPECIAL_NAMES.braces],
        ["SN_SPACE", SN_SPACE, SPECIAL_NAMES.space],
        ["SN_DASH", SN_DASH, SPECIAL_NAMES.dash],
      ]) {
        const md = db.listEventsForWorker(S.workerXId).find((ev) => ev.kind === "merge_done");
        check(`(${label}) never attributed to the partial landing missing its own special-named file`, !md || md.detail?.attributedLandedSha !== S.forgedSha);
        check(`(${label}) escalated`, db.listStaleGenerationUnresolved().some((e) => e.sessionId === S.workerXId));
        // Round 6 (Code Review e319ea92, finding 5, NIT): the escalation above must be because the real
        // mechanism ran on a real stamp — not because the stamp itself was truncated/absent (which would
        // ALSO escalate, trivially, without ever exercising the special-name handling this scenario is
        // for). Assert the merge_request row's own filesChangedPaths genuinely names the special path.
        const mr = db.listEventsForWorker(S.workerXId).find((ev) => ev.kind === "merge_request");
        check(`(${label}) the merge_request row's filesChangedPaths actually names the special path (not a truncated stamp)`,
          Array.isArray(mr?.detail?.filesChangedPaths) && mr.detail.filesChangedPaths.includes(specialPath));
      }
      const genuineMergeDone = db.listEventsForWorker(SN_GENUINE.workerXId).find((ev) => ev.kind === "merge_done");
      check("(SN_GENUINE) a genuine landing including all four special names attributes", genuineMergeDone?.detail?.staleGenerationAttributed === true && genuineMergeDone?.detail?.attributedLandedSha === SN_GENUINE.xLandedSha);
      check("(SN_GENUINE) never escalated", db.listStaleGenerationUnresolved().every((e) => e.sessionId !== SN_GENUINE.workerXId));
    } finally {
      for (const dir of [R_SN_NONASCII, R_SN_BRACES, R_SN_SPACE, R_SN_DASH, R_SN_GENUINE]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  // --- PIPELINE_BACKSLASH / PIPELINE_HOISTED_READ_FAILS (card 1cf79e64 round 2, Code Review minor 3):
  // F4's own repro, but through the REAL reconcileOrchestrationOnBoot pipeline end-to-end (not a direct
  // recordedTipContentLanded call), plus a scenario that exercises the HOISTED fullTreeEntries(reviewedTip)
  // read's own failure path specifically (reviewedTip is a sha that never resolves in the repo at all).
  // Card 05915fc7 round 2 (Code Review B1): a sha that never resolves is now classified DEFINITIVE, not
  // transient — `resolveObjectKind`'s own `cat-file -t` pre-check sees git actually run and exit non-zero
  // for a genuinely missing object, which is deterministic on retry, never a host condition. So this once
  // again asserts "escalates", same as PIPELINE_BACKSLASH — see `docs/decisions/05915fc7-*.md`'s own
  // round-2 section for why round 1's "accepted never-clearing transient residual" framing was wrong. ---
  async function setupPipelineBackslashOmission(tag, repo) {
    const ctx = await baseSetup(tag, repo);
    const { first, mgrId, workerXId, taskId, repo: repoPath } = ctx;
    const REAL_NAME = "pipeline-real.txt";
    const BS_NAME = "back\\slash-pipeline.txt"; // a literal backslash cannot be created via fs on Windows
    fs.writeFileSync(path.join(first.worktreePath, REAL_NAME), "real\n");
    commitAll(first.worktreePath, "c1 real", GIT_ID);
    const c1 = git(first.worktreePath, "rev-parse HEAD");

    // Add the backslash file on top of c1 via plumbing — NEVER checked out anywhere (checking it out
    // would try to materialize a path Windows can't express). Then move the branch ref directly; the
    // worktree's own index/HEAD staying at c1 is harmless, since nothing reads that worktree again below.
    const idxPath = path.join(os.tmpdir(), `loom-sglt-pipebs-idx-${sfx}-${Math.random()}`);
    const env = { ...process.env, GIT_INDEX_FILE: idxPath };
    execFileSync("git", ["read-tree", c1], { cwd: first.worktreePath, env });
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: first.worktreePath, input: "backslash\n" }).toString().trim();
    execFileSync("git", ["-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${blob},${BS_NAME}`], { cwd: first.worktreePath, env });
    const tree = execFileSync("git", ["write-tree"], { cwd: first.worktreePath, env }).toString().trim();
    const c2 = execFileSync("git", [...GIT_ID.split(" "), "commit-tree", tree, "-p", c1, "-m", "c2 backslash (plumbing)"], { cwd: first.worktreePath }).toString().trim();
    execFileSync("git", ["update-ref", `refs/heads/${first.branch}`, c2], { cwd: repoPath });
    try { fs.rmSync(idxPath, { force: true }); } catch { /* best-effort */ }

    // PARTIAL landing on repoPath: lands REAL_NAME only — genuinely OMITS the backslash file.
    fs.writeFileSync(path.join(repoPath, REAL_NAME), "real\n");
    commitAll(repoPath, [`chore(unrelated): partial landing (omits backslash file)`, `Loom-Worker-Branch: ${first.branch}\nLoom-Worker-Base: ${c1}`], GIT_ID);
    const forgedSha = git(repoPath, "rev-parse HEAD");

    db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: c2, filesChangedPaths: [REAL_NAME, BS_NAME] } });
    db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

    const y = await finishWithRetask(ctx);
    return { ...ctx, ...y, c1, c2, forgedSha };
  }
  async function setupPipelineHoistedReadFails(tag, repo) {
    const ctx = await baseSetup(tag, repo);
    const { first, mgrId, workerXId, taskId, repo: repoPath } = ctx;
    // At least one eligible candidate must exist, or the (now-later) hoisted read is never reached at
    // all — its content is irrelevant, since the read must fail before any candidate is examined.
    fs.writeFileSync(path.join(repoPath, "irrelevant.txt"), "irrelevant\n");
    commitAll(repoPath, [`chore(unrelated): any candidate`, `Loom-Worker-Branch: ${first.branch}\nLoom-Worker-Base: ${ctx.genesisSha}`], GIT_ID);
    const anyCandidateSha = git(repoPath, "rev-parse HEAD");

    const bogusTip = "f".repeat(40); // never resolves in this repo — the hoisted tree read must fail
    db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: bogusTip, filesChangedPaths: ["irrelevant.txt"] } });
    db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

    const y = await finishWithRetask(ctx);
    return { ...ctx, ...y, anyCandidateSha, bogusTip };
  }
  {
    const R_PIPE_BS = path.join(os.tmpdir(), `loom-sglt-pipe-bs-${sfx}`);
    const R_PIPE_HRF = path.join(os.tmpdir(), `loom-sglt-pipe-hrf-${sfx}`);
    try {
      const PIPE_BS = await setupPipelineBackslashOmission("pipe-bs", R_PIPE_BS);
      const PIPE_HRF = await setupPipelineHoistedReadFails("pipe-hrf", R_PIPE_HRF);

      const r3 = await sessions.reconcileOrchestrationOnBoot(new Set());
      console.log("PIPELINE reconcile result:", JSON.stringify(r3));

      const pipeBsMergeDone = db.listEventsForWorker(PIPE_BS.workerXId).find((ev) => ev.kind === "merge_done");
      check("(PIPELINE_BACKSLASH) never attributed to the partial landing that omits the real backslash-named file", !pipeBsMergeDone || pipeBsMergeDone.detail?.attributedLandedSha !== PIPE_BS.forgedSha);
      check("(PIPELINE_BACKSLASH) escalated — end-to-end through the real reconcile pipeline, not just the direct recordedTipContentLanded call", db.listStaleGenerationUnresolved().some((e) => e.sessionId === PIPE_BS.workerXId));
      check("(PIPELINE_BACKSLASH) worker Y is still independently finalized, unaffected", db.listEventsForWorker(PIPE_BS.workerYId).some((ev) => ev.kind === "merge_done"));

      const pipeHrfMergeDone = db.listEventsForWorker(PIPE_HRF.workerXId).find((ev) => ev.kind === "merge_done");
      check("(PIPELINE_HOISTED_READ_FAILS) never attributed (the hoisted reviewedTip tree read never resolves)", !pipeHrfMergeDone);
      // Card 05915fc7 round 2: a missing object is DEFINITIVE (git ran cat-file -t and exited non-zero,
      // never a host condition) — escalates exactly like PIPELINE_BACKSLASH, never "transient".
      check("(PIPELINE_HOISTED_READ_FAILS) escalated — a missing reviewedTip object is DEFINITIVE, not transient",
        db.listStaleGenerationUnresolved().some((e) => e.sessionId === PIPE_HRF.workerXId && e.escalated && e.kind === "definitive"));
      check("(PIPELINE_HOISTED_READ_FAILS) worker Y is still independently finalized, unaffected", db.listEventsForWorker(PIPE_HRF.workerYId).some((ev) => ev.kind === "merge_done"));
    } finally {
      for (const dir of [R_PIPE_BS, R_PIPE_HRF]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  // --- PIPELINE_REFUSAL (card 05915fc7): a CanonicalGitRefusal is DEFINITIVE, never transient — it must
  // escalate exactly like a real content mismatch, never retry, and never throw out of
  // attributeStaleGenerationOwnLanding/resolveStaleGenerationOwnLanding. `ls-tree`/`merge-base` can never be
  // made to refuse via the merge-driver path (both are in canRunMergeDriver's PURE_READ_SUBCOMMANDS
  // allowlist — confirmed by reading git/bounded.ts) or via an ordinary unpinned/FILE-shaped-.git commondir
  // mismatch (checkCommondirTrust passes trivially for this test's plain directory-shaped .git with no
  // trustedMainRoot) — so this uses the ONE real lever that DOES refuse unconditionally regardless of
  // subcommand or advisory-read: a durable commondir-trust PIN (checked before any shape dispatch),
  // registered via the documented test-seam `registerCommondirTrustPinLookup` (the same function
  // index.ts calls once at daemon boot in production), returning a `toplevel` that deliberately does not
  // match this repo's real one. ---
  async function setupPipelineRefusal(tag, repo) {
    const ctx = await baseSetup(tag, repo);
    const { first, mgrId, workerXId, taskId, repo: repoPath } = ctx;
    fs.writeFileSync(path.join(first.worktreePath, "refusal-real.txt"), "real\n");
    commitAll(first.worktreePath, "c1 real", GIT_ID);
    const reviewedTip = git(first.worktreePath, "rev-parse HEAD");

    fs.writeFileSync(path.join(repoPath, "refusal-real.txt"), "real\n");
    commitAll(repoPath, [`chore(unrelated): refusal landing`, `Loom-Worker-Branch: ${first.branch}\nLoom-Worker-Base: ${ctx.genesisSha}`], GIT_ID);
    const xLandedSha = git(repoPath, "rev-parse HEAD");

    db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: reviewedTip, filesChangedPaths: ["refusal-real.txt"] } });
    db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

    const y = await finishWithRetask(ctx);
    return { ...ctx, ...y, reviewedTip, xLandedSha };
  }
  {
    const R_PIPE_REFUSAL = path.join(os.tmpdir(), `loom-sglt-pipe-refusal-${sfx}`);
    try {
      const PIPE_REFUSAL = await setupPipelineRefusal("pipe-refusal", R_PIPE_REFUSAL);
      // Register the pin ONLY for this one repoPath, right before the boot that must see it refuse — every
      // OTHER repoPath this file uses returns null, so no other scenario is affected by this registration.
      const bogusToplevel = path.join(os.tmpdir(), `loom-sglt-refusal-bogus-toplevel-${sfx}`);
      registerCommondirTrustPinLookup((p) => p === R_PIPE_REFUSAL
        ? { toplevel: bogusToplevel, pinnedAt: now, source: "bind", projectId: PIPE_REFUSAL.projId, repoKey: "primary" }
        : null);

      let threwOutOfReconcile = null;
      let r4;
      try { r4 = await sessions.reconcileOrchestrationOnBoot(new Set()); } catch (e) { threwOutOfReconcile = e; }
      console.log("PIPELINE_REFUSAL reconcile result:", JSON.stringify(r4));
      check("(PIPELINE_REFUSAL) the CanonicalGitRefusal never escaped reconcileOrchestrationOnBoot as a thrown exception", threwOutOfReconcile === null);

      const pipeRefusalMergeDone = db.listEventsForWorker(PIPE_REFUSAL.workerXId).find((ev) => ev.kind === "merge_done");
      check("(PIPELINE_REFUSAL) never attributed — a refused repo can never verify any candidate's content", !pipeRefusalMergeDone);
      check("(PIPELINE_REFUSAL) escalated — a CanonicalGitRefusal is DEFINITIVE, exactly like a real content mismatch, never transient",
        db.listStaleGenerationUnresolved().some((e) => e.sessionId === PIPE_REFUSAL.workerXId));
      // NOTE: unlike every other scenario in this file, worker Y's OWN independent finalize ALSO routes
      // through canonicalGit against this SAME repoPath, so the pin refuses Y's finalize too while it's
      // registered — that's expected (the pin refuses every canonicalGit call against the repo, not just
      // this card's attribution path), not asserted here; Y's recovery is proven below once the pin clears.

      // Residual-shape control, mirroring PIPELINE_HOISTED_READ_FAILS's own second-boot proof: unlike a
      // transient miss, a refusal's escalation is ONE-SHOT — a second boot with the SAME refusing pin still
      // registered must not re-escalate a second time (the existing one-shot markStaleGenerationEscalated
      // guard, unrelated to this card, but worth confirming the refusal path still respects it).
      const escalatedCountBefore = db.listStaleGenerationUnresolved().filter((e) => e.sessionId === PIPE_REFUSAL.workerXId).length;
      let r4b;
      try { r4b = await sessions.reconcileOrchestrationOnBoot(new Set()); } catch (e) { threwOutOfReconcile = e; }
      console.log("PIPELINE_REFUSAL reconcile result (2nd boot):", JSON.stringify(r4b));
      check("(PIPELINE_REFUSAL) the CanonicalGitRefusal never escaped a second reconcile either", threwOutOfReconcile === null);
      check("(PIPELINE_REFUSAL) the escalation row is NOT duplicated on a second boot (one-shot, unrelated to this card but worth confirming unchanged)",
        db.listStaleGenerationUnresolved().filter((e) => e.sessionId === PIPE_REFUSAL.workerXId).length === escalatedCountBefore);

      // Clear the pin and reconcile a THIRD time: Y's own, independent finalize was only ever blocked by
      // the refusal (never by anything this card changed) and now recovers on its own.
      registerCommondirTrustPinLookup(undefined);
      let r4c;
      try { r4c = await sessions.reconcileOrchestrationOnBoot(new Set()); } catch (e) { threwOutOfReconcile = e; }
      console.log("PIPELINE_REFUSAL reconcile result (3rd boot, pin cleared):", JSON.stringify(r4c));
      check("(PIPELINE_REFUSAL) no throw on the 3rd boot either", threwOutOfReconcile === null);
      check("(PIPELINE_REFUSAL) worker Y finalizes once the refusal clears — Y's own finalize was only ever blocked by the pin, nothing this card changed",
        db.listEventsForWorker(PIPE_REFUSAL.workerYId).some((ev) => ev.kind === "merge_done"));
    } finally {
      registerCommondirTrustPinLookup(undefined);
      try { fs.rmSync(R_PIPE_REFUSAL, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  // --- SAWTRANSIENT ordering (card 05915fc7): a transient miss on one candidate must never stop the scan
  // or count as definitive for THAT candidate — later candidates are still checked, and a later clean
  // attribution always wins. Only when EVERY candidate misses, and at least one of those misses was
  // transient, does the whole attempt report "transient". Both built on a REAL, deterministic (no timing
  // dependency) per-candidate transient trigger: a candidate commit whose own tree references a
  // subdirectory whose loose git object is then deleted from the ODB — `git ls-tree -r` on THAT candidate
  // genuinely fails (a real git error, not a CanonicalGitRefusal), while an untouched candidate is
  // unaffected. The corrupted subdirectory is removed again before the NEXT candidate is committed, so
  // later candidates never reference the deleted object. ---
  // MOVES the object aside (never deletes) and returns the backup path, so a caller that needs the
  // failure to later CLEAR (RETRY_SUCCEEDS, below) can restore it with restoreSubtree(); a caller that
  // never calls that (SAWT_WINS/SAWT_ALLMISS) just leaves it aside — harmless, the whole repo dir is
  // removed in their own `finally` anyway.
  function corruptOneSubtree(repoPath, candidateSha, dirName) {
    const lsTreeOut = execSync(`git ls-tree ${candidateSha}`, { cwd: repoPath }).toString();
    const line = lsTreeOut.split("\n").find((l) => l.endsWith(`\t${dirName}`));
    if (!line) throw new Error(`corruptOneSubtree: no tree entry named "${dirName}" in ${candidateSha}`);
    const subtreeSha = line.trim().split(/\s+/)[2];
    const objPath = path.join(repoPath, ".git", "objects", subtreeSha.slice(0, 2), subtreeSha.slice(2));
    const bakPath = `${objPath}.bak`;
    fs.renameSync(objPath, bakPath); // the ONE thing that makes `git ls-tree -r <candidateSha>` genuinely fail
    return bakPath;
  }
  function restoreSubtree(bakPath) {
    fs.renameSync(bakPath, bakPath.slice(0, -".bak".length));
  }
  // Card 1e7d6956 (Code Review round 2, item 1): same idiom as corruptOneSubtree above, but for the
  // COMMIT object itself rather than one of its tree entries — makes `git log`/`rev-list` genuinely fail
  // ("could not read <sha>") the moment a walk tries to open this exact commit, a REAL git fatal (never
  // a refusal, never a timeout, never a spawn-level failure). Never restored (nothing in this file needs
  // the object back) — the whole repo dir is removed in the caller's own `finally` anyway.
  function corruptCommitObject(repoPath, commitSha) {
    const objPath = path.join(repoPath, ".git", "objects", commitSha.slice(0, 2), commitSha.slice(2));
    fs.renameSync(objPath, `${objPath}.bak`);
  }
  // Card 1e7d6956 (Code Review round 2, item 1): same idiom, but for a commit's own TOP-LEVEL tree object
  // (resolved via `<sha>^{tree}` BEFORE renaming) — makes `git rev-parse --verify <sha>^{tree}` (and
  // anything else that needs to read that tree) genuinely fail with a real git fatal, while the commit
  // object itself (and its own parent links) stays fully readable.
  function corruptCommitTree(repoPath, commitSha) {
    // execFileSync (array argv, no shell) — never a shell-string execSync here: cmd.exe treats `^` as
    // its own escape char on Windows and would silently eat it out of `<sha>^{tree}`.
    const treeSha = execFileSync("git", ["rev-parse", `${commitSha}^{tree}`], { cwd: repoPath }).toString().trim();
    const objPath = path.join(repoPath, ".git", "objects", treeSha.slice(0, 2), treeSha.slice(2));
    fs.renameSync(objPath, `${objPath}.bak`);
  }
  async function setupSawTransientOrdering(tag, repo, { genuineCandidateExists }) {
    const ctx = await baseSetup(tag, repo);
    const { first, mgrId, workerXId, taskId, repo: repoPath } = ctx;
    fs.writeFileSync(path.join(first.worktreePath, "ordering.txt"), "ordering content\n");
    commitAll(first.worktreePath, "c1 real", GIT_ID);
    const reviewedTip = git(first.worktreePath, "rev-parse HEAD");

    // Candidate 1 (OLDEST — checked FIRST): will be corrupted, but ONLY after every later git operation
    // in this repo is done — deleting a tree object git's own HEAD still references breaks EVERY later
    // `git add`/`git commit` in this working copy (git needs to read HEAD's tree to diff against it), so
    // committing candidate1 itself, and candidate2 on top of it, must both happen while it's still intact.
    // Never write "ordering.txt" here at all — it's irrelevant (candidate1 never finishes its own read)
    // and, more importantly, `finishWithRetask`'s own Y-worktree is cut from THIS branch's shared history
    // (the re-task reuses X's branch — see 21b53e6a's own decision record) which already carries
    // "ordering.txt" via `reviewedTip` above; a SECOND, independent add of the same filename on repoPath's
    // own lineage is an add/add merge conflict risk the moment its content ever differs from reviewedTip's.
    fs.mkdirSync(path.join(repoPath, "sub1"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "sub1", "leaf.txt"), `leaf-${tag}-${sfx}\n`); // unique -> unique, deletable subtree object
    commitAll(repoPath, [`chore(unrelated): candidate1 (will be corrupted)`, `Loom-Worker-Branch: ${first.branch}\nLoom-Worker-Base: ${ctx.genesisSha}`], GIT_ID);
    const candidate1Sha = git(repoPath, "rev-parse HEAD");
    fs.rmSync(path.join(repoPath, "sub1"), { recursive: true, force: true }); // candidate2 must never reference "sub1" at all

    // Candidate 2 (SECOND — checked after candidate1): either a genuine landing that matches reviewedTip's
    // own "ordering.txt" BYTE-FOR-BYTE (so Y's later squash-merge of the SAME filename, from the shared
    // branch history above, is a no-op add/add that git auto-resolves since both sides agree — the
    // "transient then attributed" order), or OMITS "ordering.txt" entirely (a definitive miss via absence,
    // never present on repoPath's own lineage at all until Y's later merge cleanly ADDS it with no
    // conflict — the "all-miss-with-a-transient" order, no genuine candidate anywhere in this scan).
    if (genuineCandidateExists) fs.writeFileSync(path.join(repoPath, "ordering.txt"), "ordering content\n");
    commitAll(repoPath, [`chore(unrelated): candidate2 (${genuineCandidateExists ? "genuine" : "definitive miss"})`, `Loom-Worker-Branch: ${first.branch}\nLoom-Worker-Base: ${ctx.genesisSha}`], GIT_ID);
    const candidate2Sha = git(repoPath, "rev-parse HEAD");

    db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: reviewedTip, filesChangedPaths: ["ordering.txt"] } });
    db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

    const y = await finishWithRetask(ctx); // ALSO commits (worker Y's own squash) on top of candidate2 — must run before the corruption too
    corruptOneSubtree(repoPath, candidate1Sha, "sub1"); // the LAST git write this repo ever does in this setup
    return { ...ctx, ...y, reviewedTip, candidate1Sha, candidate2Sha };
  }
  {
    const R_SAWT_WINS = path.join(os.tmpdir(), `loom-sglt-sawt-wins-${sfx}`);
    const R_SAWT_ALLMISS = path.join(os.tmpdir(), `loom-sglt-sawt-allmiss-${sfx}`);
    try {
      const SAWT_WINS = await setupSawTransientOrdering("sawt-wins", R_SAWT_WINS, { genuineCandidateExists: true });
      const SAWT_ALLMISS = await setupSawTransientOrdering("sawt-allmiss", R_SAWT_ALLMISS, { genuineCandidateExists: false });

      const r5 = await sessions.reconcileOrchestrationOnBoot(new Set());
      console.log("SAWTRANSIENT reconcile result:", JSON.stringify(r5));

      // --- transient (candidate1) then attributed (candidate2) ⇒ overall attributed ---
      const sawtWinsMergeDone = db.listEventsForWorker(SAWT_WINS.workerXId).find((ev) => ev.kind === "merge_done");
      check("(SAWT_WINS) a later clean attribution wins over an earlier transient miss",
        sawtWinsMergeDone?.detail?.staleGenerationAttributed === true && sawtWinsMergeDone?.detail?.attributedLandedSha === SAWT_WINS.candidate2Sha);
      check("(SAWT_WINS) never escalated — the transient candidate1 was superseded by a real attribution",
        db.listStaleGenerationUnresolved().every((e) => e.sessionId !== SAWT_WINS.workerXId));
      check("(SAWT_WINS) worker Y is still independently finalized, unaffected", db.listEventsForWorker(SAWT_WINS.workerYId).some((ev) => ev.kind === "merge_done"));

      // --- transient (candidate1) + definitive miss (candidate2), no genuine candidate anywhere ⇒ transient, no escalation ---
      const sawtAllmissMergeDone = db.listEventsForWorker(SAWT_ALLMISS.workerXId).find((ev) => ev.kind === "merge_done");
      check("(SAWT_ALLMISS) never attributed — no genuine candidate exists in this scan", !sawtAllmissMergeDone);
      // Card 05915fc7 round 2 S1: a transient miss is now TRACKED (not escalated below the give-up
      // threshold) — present in the list with escalated:false, kind:"transient", attempts:1.
      check("(SAWT_ALLMISS) never escalated — at least one of the all-miss candidates was transient, so the whole attempt is 'transient', not 'no-match'",
        db.listStaleGenerationUnresolved().some((e) => e.sessionId === SAWT_ALLMISS.workerXId && !e.escalated && e.kind === "transient" && e.attempts === 1));
      check("(SAWT_ALLMISS) the transient no-op names candidate1 (the one that was genuinely transient), logged",
        warnsMatching("stale-generation own-landing").some((w) => w.includes(SAWT_ALLMISS.workerXId.slice(0, 8)) && w.includes(SAWT_ALLMISS.candidate1Sha.slice(0, 8)) && w.includes("transient")));
      check("(SAWT_ALLMISS) worker Y is still independently finalized, unaffected", db.listEventsForWorker(SAWT_ALLMISS.workerYId).some((ev) => ev.kind === "merge_done"));
    } finally {
      for (const dir of [R_SAWT_WINS, R_SAWT_ALLMISS]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  // --- RETRY_SUCCEEDS (card 05915fc7, the original DoD's own requirement): a transient failure on one
  // boot must retry — and genuinely SUCCEED — on a later boot once the transient condition clears, against
  // the EXACT SAME underlying data (unlike PIPELINE_HOISTED_READ_FAILS's own permanently-unresolvable
  // residual). Uses the SAME real, deterministic per-candidate corruption technique as SAWT_WINS/
  // SAWT_ALLMISS above, but MOVES the subtree object aside rather than deleting it — boot 1 sees a
  // genuinely failed `ls-tree -r` on the one candidate; restoring the object before boot 2 clears the
  // condition for real, so boot 2's attribution is a genuine content-check success, not a mock. (An
  // earlier draft of this test forced the failure via a global, instance-wide `gitOpMs=1` timeout instead
  // — rejected: `reconcileOrchestrationOnBoot` reconciles EVERY worker in the shared DB in one pass, so a
  // global timeout also broke candidate DISCOVERY — `findAllLandedTrailerCommits`, which this card's own
  // scope never touched — for unrelated, already-settled scenarios, producing a spurious escalation
  // elsewhere that had nothing to do with this test. Flagged separately as its own finding.) ---
  async function setupRetrySucceeds(tag, repo) {
    const ctx = await baseSetup(tag, repo);
    const { first, mgrId, workerXId, taskId, repo: repoPath } = ctx;
    fs.writeFileSync(path.join(first.worktreePath, "retry.txt"), "retry content\n");
    commitAll(first.worktreePath, "c1 real", GIT_ID);
    const reviewedTip = git(first.worktreePath, "rev-parse HEAD");

    fs.mkdirSync(path.join(repoPath, "sub-retry"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "sub-retry", "leaf.txt"), `leaf-${tag}-${sfx}\n`);
    fs.writeFileSync(path.join(repoPath, "retry.txt"), "retry content\n"); // byte-identical to reviewedTip's own — see SAWT's own note on why this matters for Y's later squash-merge
    commitAll(repoPath, [`chore(unrelated): retry-succeeds landing`, `Loom-Worker-Branch: ${first.branch}\nLoom-Worker-Base: ${ctx.genesisSha}`], GIT_ID);
    const xLandedSha = git(repoPath, "rev-parse HEAD");
    fs.rmSync(path.join(repoPath, "sub-retry"), { recursive: true, force: true });

    db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: reviewedTip, filesChangedPaths: ["retry.txt"] } });
    db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

    const y = await finishWithRetask(ctx); // commits more — must run before the corruption below
    const bakPath = corruptOneSubtree(repoPath, xLandedSha, "sub-retry");
    return { ...ctx, ...y, reviewedTip, xLandedSha, bakPath };
  }
  {
    const R_RETRY_SUCCEEDS = path.join(os.tmpdir(), `loom-sglt-retry-succeeds-${sfx}`);
    try {
      const RETRY_SUCCEEDS = await setupRetrySucceeds("retry-succeeds", R_RETRY_SUCCEEDS);

      const r6 = await sessions.reconcileOrchestrationOnBoot(new Set());
      console.log("RETRY_SUCCEEDS reconcile result (boot 1, candidate tree corrupted):", JSON.stringify(r6));
      check("(RETRY_SUCCEEDS boot 1) never attributed — the candidate's own tree read genuinely fails",
        !db.listEventsForWorker(RETRY_SUCCEEDS.workerXId).find((ev) => ev.kind === "merge_done"));
      // Card 05915fc7 round 2 S1: tracked (present, escalated:false, kind:"transient"), not escalated —
      // the first of up to staleGenerationTransientEscalateAttempts boots before a real give-up.
      check("(RETRY_SUCCEEDS boot 1) never escalated — a failed ls-tree is transient, retried next boot, never a one-shot escalation",
        db.listStaleGenerationUnresolved().some((e) => e.sessionId === RETRY_SUCCEEDS.workerXId && !e.escalated && e.kind === "transient" && e.attempts === 1));
      check("(RETRY_SUCCEEDS boot 1) the transient no-op names this worker and the corrupted candidate sha, logged",
        warnsMatching("stale-generation own-landing").some((w) => w.includes(RETRY_SUCCEEDS.workerXId.slice(0, 8)) && w.includes(RETRY_SUCCEEDS.xLandedSha.slice(0, 8)) && w.includes("transient")));

      // Boot 2: restore the corrupted object — the SAME underlying data now attributes correctly.
      restoreSubtree(RETRY_SUCCEEDS.bakPath);
      const r7 = await sessions.reconcileOrchestrationOnBoot(new Set());
      console.log("RETRY_SUCCEEDS reconcile result (boot 2, candidate tree restored):", JSON.stringify(r7));
      const retrySucceedsMergeDone = db.listEventsForWorker(RETRY_SUCCEEDS.workerXId).find((ev) => ev.kind === "merge_done");
      check("(RETRY_SUCCEEDS boot 2) attributed once the transient condition genuinely clears, against the SAME data as boot 1",
        retrySucceedsMergeDone?.detail?.staleGenerationAttributed === true && retrySucceedsMergeDone?.detail?.attributedLandedSha === RETRY_SUCCEEDS.xLandedSha);
      // The boot-1 tracking row has no "clear on success" mechanism (unchanged, pre-existing) — it just
      // sits unescalated; a successful attribution short-circuits before ever touching it again.
      check("(RETRY_SUCCEEDS boot 2) never escalated", db.listStaleGenerationUnresolved().some((e) => e.sessionId === RETRY_SUCCEEDS.workerXId && !e.escalated));
      check("(RETRY_SUCCEEDS) worker Y is still independently finalized, unaffected", db.listEventsForWorker(RETRY_SUCCEEDS.workerYId).some((ev) => ev.kind === "merge_done"));
    } finally {
      try { fs.rmSync(R_RETRY_SUCCEEDS, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  // --- KINDFLIP (card 05915fc7, round 2, Code Review ruling 3): a row's "kind" is its MOST RECENT boot's
  // own classification, not a history. Two flips, both through the real pipeline:
  // - transient → definitive: a corrupted candidate (transient, boot 1) whose object is then restored
  //   but whose REAL content genuinely mismatches (definitive, boot 2) must escalate on that FIRST
  //   definitive boot, regardless of how few/many prior transient attempts there were (never gated on
  //   staleGenerationTransientEscalateAttempts — that threshold is transient-only).
  // - definitive → transient: a genuine mismatch (definitive, boot 1, escalates immediately) whose
  //   candidate is THEN corrupted (transient, boot 2) must stay escalated — `escalated` is sticky
  //   regardless of kind, and the nudge must not re-fire a second time. ---
  async function setupKindFlipTransientToDefinitive(tag, repo) {
    const ctx = await baseSetup(tag, repo);
    const { first, mgrId, workerXId, taskId, repo: repoPath } = ctx;
    fs.writeFileSync(path.join(first.worktreePath, "kf.txt"), "reviewed content\n");
    commitAll(first.worktreePath, "c1 real", GIT_ID);
    const reviewedTip = git(first.worktreePath, "rev-parse HEAD");

    // "kf.txt" is deliberately OMITTED here (never written on repoPath at all) — a genuine mismatch via
    // ABSENCE, same pattern SAWT_ALLMISS uses above, so Y's LATER squash-merge (which inherits "kf.txt"
    // through X's own branch history) can cleanly ADD it with no add/add conflict against this candidate.
    fs.mkdirSync(path.join(repoPath, "sub-kf"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "sub-kf", "leaf.txt"), `leaf-${tag}-${sfx}\n`);
    commitAll(repoPath, [`chore(unrelated): kindflip t2d candidate`, `Loom-Worker-Branch: ${first.branch}\nLoom-Worker-Base: ${ctx.genesisSha}`], GIT_ID);
    const candidateSha = git(repoPath, "rev-parse HEAD");

    db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: reviewedTip, filesChangedPaths: ["kf.txt"] } });
    db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

    const y = await finishWithRetask(ctx);
    const bakPath = corruptOneSubtree(repoPath, candidateSha, "sub-kf"); // boot 1 sees this as transient
    return { ...ctx, ...y, reviewedTip, candidateSha, bakPath };
  }
  async function setupKindFlipDefinitiveToTransient(tag, repo) {
    const ctx = await baseSetup(tag, repo);
    const { first, mgrId, workerXId, taskId, repo: repoPath } = ctx;
    fs.writeFileSync(path.join(first.worktreePath, "kf2.txt"), "reviewed content\n");
    commitAll(first.worktreePath, "c1 real", GIT_ID);
    const reviewedTip = git(first.worktreePath, "rev-parse HEAD");

    // "kf2.txt" is deliberately OMITTED here too (same collision-avoidance reasoning as T2D above) — a
    // genuine mismatch via absence, readable cleanly on boot 1 (not corrupted yet).
    fs.mkdirSync(path.join(repoPath, "sub-kf2"), { recursive: true });
    fs.writeFileSync(path.join(repoPath, "sub-kf2", "leaf.txt"), `leaf-${tag}-${sfx}\n`);
    commitAll(repoPath, [`chore(unrelated): kindflip d2t candidate`, `Loom-Worker-Branch: ${first.branch}\nLoom-Worker-Base: ${ctx.genesisSha}`], GIT_ID);
    const candidateSha = git(repoPath, "rev-parse HEAD");
    // deliberately NOT corrupted yet — boot 1 reads this cleanly and finds a genuine mismatch (definitive).

    db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: reviewedTip, filesChangedPaths: ["kf2.txt"] } });
    db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

    const y = await finishWithRetask(ctx);
    return { ...ctx, ...y, reviewedTip, candidateSha, repoPath };
  }
  {
    const R_KF_T2D = path.join(os.tmpdir(), `loom-sglt-kf-t2d-${sfx}`);
    const R_KF_D2T = path.join(os.tmpdir(), `loom-sglt-kf-d2t-${sfx}`);
    try {
      const KF_T2D = await setupKindFlipTransientToDefinitive("kf-t2d", R_KF_T2D);
      const KF_D2T = await setupKindFlipDefinitiveToTransient("kf-d2t", R_KF_D2T);

      const r8 = await sessions.reconcileOrchestrationOnBoot(new Set());
      console.log("KINDFLIP reconcile result (boot 1):", JSON.stringify(r8));
      check("(KF_T2D boot 1) tracked as transient, not escalated",
        db.listStaleGenerationUnresolved().some((e) => e.sessionId === KF_T2D.workerXId && !e.escalated && e.kind === "transient"));
      check("(KF_D2T boot 1) a genuine mismatch escalates immediately (definitive, first boot)",
        db.listStaleGenerationUnresolved().some((e) => e.sessionId === KF_D2T.workerXId && e.escalated && e.kind === "definitive" && e.attempts === 1));
      // Full id, never a sliced prefix — KF_T2D and KF_D2T share the SAME "sglt-kf-" prefix at 8 chars.
      const kfD2tEscalationsAfterBoot1 = warnsMatching("escalated [loom:merge-orphaned]").filter((w) => w.includes(KF_D2T.workerXId)).length;

      // T2D: restore the object — the candidate is now readable, and its REAL content genuinely
      // mismatches reviewedTip's. D2T: NOW corrupt the (already-escalated) candidate's own subtree.
      restoreSubtree(KF_T2D.bakPath);
      corruptOneSubtree(KF_D2T.repoPath, KF_D2T.candidateSha, "sub-kf2");

      const r9 = await sessions.reconcileOrchestrationOnBoot(new Set());
      console.log("KINDFLIP reconcile result (boot 2):", JSON.stringify(r9));
      check("(KF_T2D boot 2) transient → definitive: escalates on this FIRST definitive boot, even though only 1 prior transient attempt (well below the give-up threshold)",
        db.listStaleGenerationUnresolved().some((e) => e.sessionId === KF_T2D.workerXId && e.escalated && e.kind === "definitive"));
      check("(KF_T2D) never attributed — it was always a genuine mismatch, not a transient candidate that would eventually match",
        !db.listEventsForWorker(KF_T2D.workerXId).find((ev) => ev.kind === "merge_done"));
      check("(KF_D2T boot 2) definitive → transient: STAYS escalated — a later transient reading never un-escalates",
        db.listStaleGenerationUnresolved().some((e) => e.sessionId === KF_D2T.workerXId && e.escalated && e.kind === "transient"));
      const kfD2tEscalationsAfterBoot2 = warnsMatching("escalated [loom:merge-orphaned]").filter((w) => w.includes(KF_D2T.workerXId)).length;
      check("(KF_D2T) the escalation nudge did NOT re-fire a second time on the later transient boot",
        kfD2tEscalationsAfterBoot2 === kfD2tEscalationsAfterBoot1 && kfD2tEscalationsAfterBoot1 === 1);
    } finally {
      for (const dir of [R_KF_T2D, R_KF_D2T]) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  // Card 1e7d6956: a gitFactory that behaves like real git EXCEPT for a raw() call whose args satisfy
  // `shouldFail` — those instead spawn a REAL simple-git instance pointed at a nonexistent binary, the
  // SAME genuine ENOENT process-level spawn failure (isSpawnLevelFailure) the (spawn-failure) block above
  // proves classifies as transient, never a crafted/synthetic error. `() => true` fails EVERY call through
  // this factory — safe when the factory itself is already scoped to ONE call site (the new
  // staleGenerationDiscoveryGitFactory/staleGenerationChainGitFactory test seams), never a global override.
  function scopedSpawnFailGitFactory(shouldFail) {
    return (repoPath, blockTimeoutMs) => {
      const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
      const bad = simpleGit(repoPath, { binary: "loom-sglt-nonexistent-git-xyz", timeout: { block: blockTimeoutMs } });
      return { raw: (args) => (shouldFail(args) ? bad.raw(args) : real.raw(args)) };
    };
  }

  // Card 1e7d6956 (Code Review round 2, item 2): a gitFactory that behaves like real git EXCEPT for a
  // raw() call whose args satisfy `shouldHang` — that one call returns a promise that NEVER settles, so
  // the OUTER `withTimeout` race (never simple-git's own command-level timeout) is what actually wins,
  // producing the exact "exceeded Nms (hung git child?)" shape `isWithTimeoutExpiry` matches.
  function scopedNeverSettleGitFactory(shouldHang) {
    return (repoPath, blockTimeoutMs) => {
      const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
      return { raw: (args) => (shouldHang(args) ? new Promise(() => { /* never settles */ }) : real.raw(args)) };
    };
  }

  // --- DISCOVERY_SPAWN_FAIL_RETRIES (card 1e7d6956; RENAMED from DISCOVERY_TIMEOUT_ESCALATES — Code
  // Review round 2, item 2: that name was wrong on both halves — this fixture exercises a SPAWN-LEVEL
  // failure (isSpawnLevelFailure), never a timeout, and it does NOT escalate on boot 1; it retries).
  //
  // A discovery-level transient failure reads "transient" and retries, never an immediate definitive
  // escalation; the OLD global-gitOpMs mechanism this fixture used to use never actually proved that, see
  // docs/decisions/05915fc7-*.md round 3 S1 for the full history of why.
  //
  // Isolated into its OWN fresh Db/SessionService pair (never the shared `db`/`sessions`) — the
  // `staleGenerationDiscoveryGitFactory` test seam (card 1e7d6956) fails ONLY worker X's own discovery
  // call (matched by X's own `--grep=Loom-Worker-Branch: <branch>` argv), via a REAL spawn-level ENOENT,
  // never a global `gitOpMs` override — `05915fc7` itself found that bleeds across every row a shared
  // SessionService instance tracks. Worker Y, an ordinary already-landed worker in the SAME boot/DB,
  // proves the fault stays scoped to X: Y still finalizes normally in the same boot. ---
  {
    const R_DISCOVERY_SPAWN_FAIL = path.join(os.tmpdir(), `loom-sglt-spawnfail-disc-${sfx}`);
    const dbDiscoverySpawnFailPath = path.join(os.tmpdir(), `loom-sglt-spawnfail-disc-db-${sfx}.db`);
    let dbDiscoverySpawnFail;
    try {
      initRepo(R_DISCOVERY_SPAWN_FAIL);
      dbDiscoverySpawnFail = new Db(dbDiscoverySpawnFailPath);
      const projId = `sglt-spawnfail-proj-${sfx}`, agentId = `sglt-spawnfail-agent-${sfx}`, taskId = `sglt-spawnfail-task-${sfx}`;
      const mgrId = `sglt-spawnfail-mgr-${sfx}`, workerXId = `sglt-spawnfail-workerx-${sfx}`, workerYId = `sglt-spawnfail-workery-${sfx}`;
      dbDiscoverySpawnFail.insertProject({ id: projId, name: "SGLT-spawnfail", repoPath: R_DISCOVERY_SPAWN_FAIL, vaultPath: R_DISCOVERY_SPAWN_FAIL, config: {}, createdAt: now, archivedAt: null });
      dbDiscoverySpawnFail.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
      dbDiscoverySpawnFail.insertTask({ id: taskId, projectId: projId, title: "SGLT-spawnfail", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      dbDiscoverySpawnFail.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: R_DISCOVERY_SPAWN_FAIL, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
      const genesisSha = git(R_DISCOVERY_SPAWN_FAIL, "rev-parse HEAD");
      dbDiscoverySpawnFail.setMeta(mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: genesisSha }));

      // Worker X: a genuine landing exists (content-match arm, same shape BOUND_ATTEMPTS's own X uses) —
      // so a cleared boot can prove RETRY, THEN SUCCESS, not just "stops escalating".
      const first = await createWorktree(R_DISCOVERY_SPAWN_FAIL, projId, taskId);
      dbDiscoverySpawnFail.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
      fs.writeFileSync(path.join(first.worktreePath, "spawnfail.txt"), "spawnfail content\n");
      commitAll(first.worktreePath, "c1 real", GIT_ID);
      const reviewedTip = git(first.worktreePath, "rev-parse HEAD");
      fs.writeFileSync(path.join(R_DISCOVERY_SPAWN_FAIL, "spawnfail.txt"), "spawnfail content\n"); // byte-identical to reviewedTip's own
      commitAll(R_DISCOVERY_SPAWN_FAIL, [`chore(unrelated): spawnfail landing`, `Loom-Worker-Branch: ${first.branch}\nLoom-Worker-Base: ${genesisSha}`], GIT_ID);

      // A re-task reusing X's own path/branch — the SAME "stale generation" shape every other scenario
      // uses. Y is an ORDINARY already-landed worker (squash-merged directly onto the canonical repo,
      // like BOUND_ATTEMPTS's own Y) — never a stale generation itself, so its own finalize goes through
      // Pass A's ordinary already-landed detection, never `findAllLandedTrailerCommits` at all.
      const second = await createWorktree(R_DISCOVERY_SPAWN_FAIL, projId, taskId);
      dbDiscoverySpawnFail.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
      fs.writeFileSync(path.join(second.worktreePath, "y.txt"), "y work\n");
      commitAll(second.worktreePath, "y", GIT_ID);
      execSync(`git ${GIT_ID} merge --squash ${second.branch} && git ${GIT_ID} commit -q -m "SGLT-spawnfail-y" -m "Loom-Worker-Branch: ${second.branch}"`, { cwd: R_DISCOVERY_SPAWN_FAIL });

      dbDiscoverySpawnFail.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: reviewedTip, filesChangedPaths: ["spawnfail.txt"] } });
      dbDiscoverySpawnFail.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });
      dbDiscoverySpawnFail.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch } });

      // Boot 1: X's own discovery grep args are targeted — a REAL ENOENT spawn failure, scoped to X's own
      // branch name only (never matches Y's own merge, which never reaches discovery at all).
      const discoveryFailFactory = scopedSpawnFailGitFactory((args) => Array.isArray(args) && args.includes(`--grep=Loom-Worker-Branch: ${first.branch}`));
      const sessionsDiscoverySpawnFail = new SessionService(dbDiscoverySpawnFail, pty, new OrchestrationControl(), { staleGenerationDiscoveryGitFactory: discoveryFailFactory });
      const sfResult = await sessionsDiscoverySpawnFail.reconcileOrchestrationOnBoot(new Set());
      console.log("DISCOVERY_SPAWN_FAIL_RETRIES reconcile result (boot 1, discovery fault):", JSON.stringify(sfResult));
      check("(DISCOVERY_SPAWN_FAIL_RETRIES boot 1) a spawn-level failure during candidate DISCOVERY itself reads transient, NOT an immediate definitive escalation",
        dbDiscoverySpawnFail.listStaleGenerationUnresolved().some((e) => e.sessionId === workerXId && !e.escalated && e.kind === "transient" && e.attempts === 1));
      check("(DISCOVERY_SPAWN_FAIL_RETRIES boot 1) never attributed yet", !dbDiscoverySpawnFail.listEventsForWorker(workerXId).find((ev) => ev.kind === "merge_done"));
      check("(DISCOVERY_SPAWN_FAIL_RETRIES boot 1) the boot-summary staleGenerationTransient counter includes this row", sfResult.staleGenerationTransient >= 1);
      check("(DISCOVERY_SPAWN_FAIL_RETRIES boot 1) worker Y (an ordinary already-landed worker) still finalizes normally in the SAME boot — the fault stays scoped to X",
        dbDiscoverySpawnFail.listEventsForWorker(workerYId).some((ev) => ev.kind === "merge_done"));

      // Boot 2 (retry, then success): a FRESH SessionService over the SAME durable DB, this time with NO
      // discovery fault at all (undefined ⇒ real git) — mirrors a real daemon restart after the host
      // condition clears. X's own genuine landing (committed above) is now discoverable and attributes.
      const sessionsDiscoverySpawnFailClean = new SessionService(dbDiscoverySpawnFail, pty, new OrchestrationControl());
      const sfResult2 = await sessionsDiscoverySpawnFailClean.reconcileOrchestrationOnBoot(new Set());
      console.log("DISCOVERY_SPAWN_FAIL_RETRIES reconcile result (boot 2, cleared):", JSON.stringify(sfResult2));
      check("(DISCOVERY_SPAWN_FAIL_RETRIES boot 2) retry succeeds: X is now ATTRIBUTED once discovery can actually run",
        dbDiscoverySpawnFail.listEventsForWorker(workerXId).some((ev) => ev.kind === "merge_done" && ev.detail?.staleGenerationAttributed === true));
    } finally {
      try { dbDiscoverySpawnFail?.close(); } catch { /* best-effort */ }
      for (const p of [R_DISCOVERY_SPAWN_FAIL, dbDiscoverySpawnFailPath]) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  // --- DISCOVERY_TIMEOUT_TRANSIENT (card 1e7d6956, Code Review round 2, item 2): the OTHER transient
  // trigger, isWithTimeoutExpiry, was never exercised by any fixture (confirmed by the reviewer: removing
  // isWithTimeoutExpiry from the classification left every stale-generation test green). The seam
  // factory's own raw() call for X's own discovery grep NEVER settles — so withTimeout's own synthetic
  // "exceeded Nms (hung git child?)" timeout is what actually wins the race, never simple-git's own
  // command-level timeout — producing the EXACT shape isWithTimeoutExpiry matches. A small gitOpMs (the
  // floor, 1000ms) is scoped to this ONE isolated pair only, never a shared/global override. ---
  {
    const R_DISCOVERY_TIMEOUT_TRANSIENT = path.join(os.tmpdir(), `loom-sglt-disc-timeout-t-${sfx}`);
    const dbDiscoveryTimeoutTransientPath = path.join(os.tmpdir(), `loom-sglt-disc-timeout-t-db-${sfx}.db`);
    let dbDiscoveryTimeoutTransient;
    try {
      initRepo(R_DISCOVERY_TIMEOUT_TRANSIENT);
      dbDiscoveryTimeoutTransient = new Db(dbDiscoveryTimeoutTransientPath);
      const projId = `sglt-disc-timeout-t-proj-${sfx}`, agentId = `sglt-disc-timeout-t-agent-${sfx}`, taskId = `sglt-disc-timeout-t-task-${sfx}`;
      const mgrId = `sglt-disc-timeout-t-mgr-${sfx}`, workerXId = `sglt-disc-timeout-t-workerx-${sfx}`;
      dbDiscoveryTimeoutTransient.insertProject({ id: projId, name: "SGLT-disc-timeout-t", repoPath: R_DISCOVERY_TIMEOUT_TRANSIENT, vaultPath: R_DISCOVERY_TIMEOUT_TRANSIENT, config: {}, createdAt: now, archivedAt: null });
      dbDiscoveryTimeoutTransient.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
      dbDiscoveryTimeoutTransient.insertTask({ id: taskId, projectId: projId, title: "SGLT-disc-timeout-t", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      dbDiscoveryTimeoutTransient.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: R_DISCOVERY_TIMEOUT_TRANSIENT, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
      const genesisSha = git(R_DISCOVERY_TIMEOUT_TRANSIENT, "rev-parse HEAD");
      dbDiscoveryTimeoutTransient.setMeta(mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: genesisSha }));

      const first = await createWorktree(R_DISCOVERY_TIMEOUT_TRANSIENT, projId, taskId);
      dbDiscoveryTimeoutTransient.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
      fs.writeFileSync(path.join(first.worktreePath, "disctimeoutt.txt"), "disc timeout transient content\n");
      commitAll(first.worktreePath, "c1 real", GIT_ID);
      const reviewedTip = git(first.worktreePath, "rev-parse HEAD");

      const second = await createWorktree(R_DISCOVERY_TIMEOUT_TRANSIENT, projId, taskId);
      const workerYId = `sglt-disc-timeout-t-workery-${sfx}`;
      dbDiscoveryTimeoutTransient.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });

      dbDiscoveryTimeoutTransient.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: reviewedTip, filesChangedPaths: ["disctimeoutt.txt"] } });
      dbDiscoveryTimeoutTransient.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

      const neverSettleFactory = scopedNeverSettleGitFactory((args) => Array.isArray(args) && args.includes(`--grep=Loom-Worker-Branch: ${first.branch}`));
      // gitOpMs:1000 is the service's own GIT_TIMEOUT_FLOOR_MS (the lowest value it accepts) — scoped to
      // THIS isolated pair only, never a shared/global override across other scenarios' own rows.
      const sessionsDiscoveryTimeoutTransient = new SessionService(dbDiscoveryTimeoutTransient, pty, new OrchestrationControl(), { gitOpMs: 1000, staleGenerationDiscoveryGitFactory: neverSettleFactory });
      const dttResult = await sessionsDiscoveryTimeoutTransient.reconcileOrchestrationOnBoot(new Set());
      console.log("DISCOVERY_TIMEOUT_TRANSIENT reconcile result:", JSON.stringify(dttResult));
      check("(DISCOVERY_TIMEOUT_TRANSIENT) a genuine withTimeout expiry during candidate DISCOVERY itself reads transient, NOT an immediate definitive escalation",
        dbDiscoveryTimeoutTransient.listStaleGenerationUnresolved().some((e) => e.sessionId === workerXId && !e.escalated && e.kind === "transient" && e.attempts === 1));
      check("(DISCOVERY_TIMEOUT_TRANSIENT) never attributed", !dbDiscoveryTimeoutTransient.listEventsForWorker(workerXId).find((ev) => ev.kind === "merge_done"));
    } finally {
      try { dbDiscoveryTimeoutTransient?.close(); } catch { /* best-effort */ }
      for (const p of [R_DISCOVERY_TIMEOUT_TRANSIENT, dbDiscoveryTimeoutTransientPath]) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  // --- DISCOVERY_DEFINITIVE (card 1e7d6956, Code Review round 2, item 1): a REAL git fatal during
  // candidate DISCOVERY (a corrupted ancestor commit object, hit mid-walk — never a refusal, never a
  // timeout, never a spawn-level failure) must classify DEFINITIVE, escalating on the FIRST boot — never
  // folding into the transient give-up bucket. No custom gitFactory needed — a REAL, deterministic
  // object corruption, same idiom as corruptOneSubtree/corruptCommitObject above. ---
  {
    const R_DISCOVERY_DEFINITIVE = path.join(os.tmpdir(), `loom-sglt-discdef-${sfx}`);
    const dbDiscoveryDefinitivePath = path.join(os.tmpdir(), `loom-sglt-discdef-db-${sfx}.db`);
    let dbDiscoveryDefinitive;
    try {
      initRepo(R_DISCOVERY_DEFINITIVE);
      dbDiscoveryDefinitive = new Db(dbDiscoveryDefinitivePath);
      const sessionsDiscoveryDefinitive = new SessionService(dbDiscoveryDefinitive, pty, new OrchestrationControl());
      const projId = `sglt-discdef-proj-${sfx}`, agentId = `sglt-discdef-agent-${sfx}`, taskId = `sglt-discdef-task-${sfx}`;
      const mgrId = `sglt-discdef-mgr-${sfx}`, workerXId = `sglt-discdef-workerx-${sfx}`;
      dbDiscoveryDefinitive.insertProject({ id: projId, name: "SGLT-discdef", repoPath: R_DISCOVERY_DEFINITIVE, vaultPath: R_DISCOVERY_DEFINITIVE, config: {}, createdAt: now, archivedAt: null });
      dbDiscoveryDefinitive.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
      dbDiscoveryDefinitive.insertTask({ id: taskId, projectId: projId, title: "SGLT-discdef", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      dbDiscoveryDefinitive.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: R_DISCOVERY_DEFINITIVE, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

      // Advance main with an intermediate commit (to be corrupted) THEN a final tip the watermark points
      // at — discovery's own unbounded `git log <base>` walk must still traverse the intermediate commit
      // to reach genesis, hitting the corruption mid-walk, even though the watermark's own tip (a plain
      // `rev-parse`, never a history walk) resolves fine.
      fs.writeFileSync(path.join(R_DISCOVERY_DEFINITIVE, "mid.txt"), "mid\n");
      commitAll(R_DISCOVERY_DEFINITIVE, "main advances (mid, to be corrupted)", GIT_ID);
      const midSha = git(R_DISCOVERY_DEFINITIVE, "rev-parse HEAD");
      fs.writeFileSync(path.join(R_DISCOVERY_DEFINITIVE, "final.txt"), "final\n");
      commitAll(R_DISCOVERY_DEFINITIVE, "main advances (final tip)", GIT_ID);
      const finalSha = git(R_DISCOVERY_DEFINITIVE, "rev-parse HEAD");
      dbDiscoveryDefinitive.setMeta(mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: finalSha }));

      const first = await createWorktree(R_DISCOVERY_DEFINITIVE, projId, taskId);
      dbDiscoveryDefinitive.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
      fs.writeFileSync(path.join(first.worktreePath, "discdef.txt"), "discdef content\n");
      commitAll(first.worktreePath, "c1 real", GIT_ID);
      const reviewedTip = git(first.worktreePath, "rev-parse HEAD");

      const second = await createWorktree(R_DISCOVERY_DEFINITIVE, projId, taskId);
      const workerYId = `sglt-discdef-workery-${sfx}`;
      dbDiscoveryDefinitive.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });

      dbDiscoveryDefinitive.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: reviewedTip, filesChangedPaths: ["discdef.txt"] } });
      dbDiscoveryDefinitive.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

      // Corrupt ONLY after every git operation in this repo (both worktree creations) is done — matches
      // corruptOneSubtree's own ordering discipline above.
      corruptCommitObject(R_DISCOVERY_DEFINITIVE, midSha);

      const ddResult = await sessionsDiscoveryDefinitive.reconcileOrchestrationOnBoot(new Set());
      console.log("DISCOVERY_DEFINITIVE reconcile result:", JSON.stringify(ddResult));
      check("(DISCOVERY_DEFINITIVE) a REAL git fatal during candidate DISCOVERY (a corrupted ancestor commit, never a refusal/timeout/spawn failure) classifies DEFINITIVE and escalates on the FIRST boot",
        dbDiscoveryDefinitive.listStaleGenerationUnresolved().some((e) => e.sessionId === workerXId && e.escalated && e.kind === "definitive"));
      check("(DISCOVERY_DEFINITIVE) never attributed", !dbDiscoveryDefinitive.listEventsForWorker(workerXId).find((ev) => ev.kind === "merge_done"));
    } finally {
      try { dbDiscoveryDefinitive?.close(); } catch { /* best-effort */ }
      for (const p of [R_DISCOVERY_DEFINITIVE, dbDiscoveryDefinitivePath]) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  // --- CHAIN_TRANSIENT (card 1e7d6956): a transient failure in the landedTip arm's own
  // verifyReviewedTipChain call now folds into sawTransient (round 3 S2(b)'s own "checked:true" wording
  // was dishonest for exactly this case — closed here as a side effect). Isolated pair + the NEW
  // `staleGenerationChainGitFactory` test seam (card 1e7d6956); it fails UNCONDITIONALLY since it is
  // already scoped to ONE call site by construction, so no args-matching predicate is needed. ---
  {
    const R_CHAIN_TRANSIENT = path.join(os.tmpdir(), `loom-sglt-chaintrans-${sfx}`);
    const dbChainTransientPath = path.join(os.tmpdir(), `loom-sglt-chaintrans-db-${sfx}.db`);
    let dbChainTransient;
    try {
      initRepo(R_CHAIN_TRANSIENT);
      dbChainTransient = new Db(dbChainTransientPath);
      const chainFailFactory = scopedSpawnFailGitFactory(() => true);
      const sessionsChainTransient = new SessionService(dbChainTransient, pty, new OrchestrationControl(), { staleGenerationChainGitFactory: chainFailFactory });
      const projId = `sglt-chaintrans-proj-${sfx}`, agentId = `sglt-chaintrans-agent-${sfx}`, taskId = `sglt-chaintrans-task-${sfx}`;
      const mgrId = `sglt-chaintrans-mgr-${sfx}`, workerXId = `sglt-chaintrans-workerx-${sfx}`;
      dbChainTransient.insertProject({ id: projId, name: "SGLT-chaintrans", repoPath: R_CHAIN_TRANSIENT, vaultPath: R_CHAIN_TRANSIENT, config: {}, createdAt: now, archivedAt: null });
      dbChainTransient.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
      dbChainTransient.insertTask({ id: taskId, projectId: projId, title: "SGLT-chaintrans", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      dbChainTransient.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: R_CHAIN_TRANSIENT, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
      const genesisSha = git(R_CHAIN_TRANSIENT, "rev-parse HEAD");
      dbChainTransient.setMeta(mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: genesisSha }));

      const first = await createWorktree(R_CHAIN_TRANSIENT, projId, taskId);
      dbChainTransient.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
      fs.writeFileSync(path.join(first.worktreePath, "chaintrans.txt"), "chaintrans content\n");
      commitAll(first.worktreePath, "c1 real", GIT_ID);
      const reviewedTip = git(first.worktreePath, "rev-parse HEAD");

      // A candidate carrying Loom-Landed-Tip (the landedTip arm) — its own content/validity doesn't
      // matter: staleGenerationChainGitFactory fails EVERY verifyReviewedTipChain call unconditionally,
      // before any real content is ever read.
      fs.writeFileSync(path.join(R_CHAIN_TRANSIENT, "chaintrans.txt"), "chaintrans content\n");
      commitAll(R_CHAIN_TRANSIENT, [`chore(unrelated): chaintrans landing`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${reviewedTip}`], GIT_ID);

      const second = await createWorktree(R_CHAIN_TRANSIENT, projId, taskId);
      const workerYId = `sglt-chaintrans-workery-${sfx}`;
      dbChainTransient.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });

      dbChainTransient.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: reviewedTip, filesChangedPaths: ["chaintrans.txt"] } });
      dbChainTransient.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

      const ctResult = await sessionsChainTransient.reconcileOrchestrationOnBoot(new Set());
      console.log("CHAIN_TRANSIENT reconcile result:", JSON.stringify(ctResult));
      check("(CHAIN_TRANSIENT) a spawn-level failure inside the landedTip arm's own verifyReviewedTipChain call reads transient, folded into sawTransient — never an immediate definitive escalation",
        dbChainTransient.listStaleGenerationUnresolved().some((e) => e.sessionId === workerXId && !e.escalated && e.kind === "transient" && e.attempts === 1));
      check("(CHAIN_TRANSIENT) never attributed", !dbChainTransient.listEventsForWorker(workerXId).find((ev) => ev.kind === "merge_done"));
    } finally {
      try { dbChainTransient?.close(); } catch { /* best-effort */ }
      for (const p of [R_CHAIN_TRANSIENT, dbChainTransientPath]) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  // --- CHAIN_DEFINITIVE (card 1e7d6956, Code Review round 2, item 1): a REAL git fatal inside the
  // landedTip arm's own verifyReviewedTipChain walk (a corrupted tree object on the union commit itself,
  // never a refusal/timeout/spawn failure) must classify DEFINITIVE — chain.transient stays unset, so
  // this candidate contributes neither an attribution nor a transient miss; the loop finishes with
  // sawTransient:false, escalating definitively on the FIRST boot. No custom gitFactory needed — a REAL,
  // deterministic object corruption, same idiom as corruptCommitTree above. ---
  {
    const R_CHAIN_DEFINITIVE = path.join(os.tmpdir(), `loom-sglt-chaindef-${sfx}`);
    const dbChainDefinitivePath = path.join(os.tmpdir(), `loom-sglt-chaindef-db-${sfx}.db`);
    let dbChainDefinitive;
    try {
      initRepo(R_CHAIN_DEFINITIVE);
      dbChainDefinitive = new Db(dbChainDefinitivePath);
      const sessionsChainDefinitive = new SessionService(dbChainDefinitive, pty, new OrchestrationControl());
      const projId = `sglt-chaindef-proj-${sfx}`, agentId = `sglt-chaindef-agent-${sfx}`, taskId = `sglt-chaindef-task-${sfx}`;
      const mgrId = `sglt-chaindef-mgr-${sfx}`, workerXId = `sglt-chaindef-workerx-${sfx}`;
      dbChainDefinitive.insertProject({ id: projId, name: "SGLT-chaindef", repoPath: R_CHAIN_DEFINITIVE, vaultPath: R_CHAIN_DEFINITIVE, config: {}, createdAt: now, archivedAt: null });
      dbChainDefinitive.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
      dbChainDefinitive.insertTask({ id: taskId, projectId: projId, title: "SGLT-chaindef", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      dbChainDefinitive.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: R_CHAIN_DEFINITIVE, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
      const genesisSha = git(R_CHAIN_DEFINITIVE, "rev-parse HEAD");
      dbChainDefinitive.setMeta(mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: genesisSha }));

      const first = await createWorktree(R_CHAIN_DEFINITIVE, projId, taskId);
      dbChainDefinitive.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
      fs.writeFileSync(path.join(first.worktreePath, "x.txt"), "x real work\n");
      commitAll(first.worktreePath, "x", GIT_ID);
      const xTip = git(first.worktreePath, "rev-parse HEAD");

      fs.writeFileSync(path.join(R_CHAIN_DEFINITIVE, "main-advance.txt"), "main moved on\n");
      commitAll(R_CHAIN_DEFINITIVE, "main advances", GIT_ID);
      const mTip = git(R_CHAIN_DEFINITIVE, "rev-parse HEAD");

      // A genuine worktree-side union (same shape GENUINE/setupGenuineUnionNoOverlap uses) — unionTip
      // lives only on first.branch's own ref, never on main's own ancestry, so corrupting ITS tree later
      // never touches anything discovery's own history walk needs to read.
      execSync(`git ${GIT_ID} merge -q --no-edit ${mTip}`, { cwd: first.worktreePath });
      const unionTip = git(first.worktreePath, "rev-parse HEAD");

      execSync(`git ${GIT_ID} merge --squash ${first.branch}`, { cwd: R_CHAIN_DEFINITIVE });
      commitAll(R_CHAIN_DEFINITIVE, [`chore(unrelated): chaindef landing`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${unionTip}\nLoom-Worker-Base: ${mTip}`], GIT_ID);

      const second = await createWorktree(R_CHAIN_DEFINITIVE, projId, taskId);
      const workerYId = `sglt-chaindef-workery-${sfx}`;
      dbChainDefinitive.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });

      dbChainDefinitive.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: xTip, filesChangedPaths: ["x.txt"] } });
      dbChainDefinitive.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

      // Corrupt only after every other git operation in this repo (including the re-task's own second
      // worktree creation) is done — matches corruptOneSubtree's own ordering discipline above.
      corruptCommitTree(R_CHAIN_DEFINITIVE, unionTip);

      const cdResult = await sessionsChainDefinitive.reconcileOrchestrationOnBoot(new Set());
      console.log("CHAIN_DEFINITIVE reconcile result:", JSON.stringify(cdResult));
      check("(CHAIN_DEFINITIVE) a REAL git fatal inside the landedTip arm's own chain walk (a corrupted tree, never a refusal/timeout/spawn failure) classifies DEFINITIVE and escalates on the FIRST boot",
        dbChainDefinitive.listStaleGenerationUnresolved().some((e) => e.sessionId === workerXId && e.escalated && e.kind === "definitive"));
      check("(CHAIN_DEFINITIVE) never attributed", !dbChainDefinitive.listEventsForWorker(workerXId).find((ev) => ev.kind === "merge_done"));
    } finally {
      try { dbChainDefinitive?.close(); } catch { /* best-effort */ }
      for (const p of [R_CHAIN_DEFINITIVE, dbChainDefinitivePath]) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  // --- DISCOVERY_BOUND_ATTEMPTS (card 1e7d6956, mirroring 05915fc7 round 3's own BOUND_ATTEMPTS shape
  // below): a PERSISTENT discovery-level transient (the SAME staleGenerationDiscoveryGitFactory fault,
  // never cleared across boots) still escalates once attempts crosses the threshold, through the EXISTING
  // bounded-escalation machinery — no parallel path. Isolated into its OWN fresh Db/SessionService pair
  // with a LOW override, same reason BOUND_ATTEMPTS itself is isolated. ---
  {
    const R_DBOUND = path.join(os.tmpdir(), `loom-sglt-dbound-${sfx}`);
    const dbDBoundPath = path.join(os.tmpdir(), `loom-sglt-dbound-db-${sfx}.db`);
    let dbDBound;
    try {
      initRepo(R_DBOUND);
      dbDBound = new Db(dbDBoundPath);
      const projId = `sglt-dbound-proj-${sfx}`, agentId = `sglt-dbound-agent-${sfx}`, taskId = `sglt-dbound-task-${sfx}`;
      const mgrId = `sglt-dbound-mgr-${sfx}`, workerXId = `sglt-dbound-workerx-${sfx}`;
      dbDBound.insertProject({ id: projId, name: "SGLT-dbound", repoPath: R_DBOUND, vaultPath: R_DBOUND, config: {}, createdAt: now, archivedAt: null });
      dbDBound.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
      dbDBound.insertTask({ id: taskId, projectId: projId, title: "SGLT-dbound", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      dbDBound.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: R_DBOUND, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
      const genesisSha = git(R_DBOUND, "rev-parse HEAD");
      dbDBound.setMeta(mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: genesisSha }));
      const first = await createWorktree(R_DBOUND, projId, taskId);
      dbDBound.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
      fs.writeFileSync(path.join(first.worktreePath, "dbound.txt"), "dbound content\n");
      commitAll(first.worktreePath, "c1 real", GIT_ID);
      const reviewedTip = git(first.worktreePath, "rev-parse HEAD");

      const second = await createWorktree(R_DBOUND, projId, taskId);
      const workerYId = `sglt-dbound-workery-${sfx}`;
      dbDBound.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });

      dbDBound.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: reviewedTip, filesChangedPaths: ["dbound.txt"] } });
      dbDBound.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

      const DBOUND_ATTEMPTS = 2; // low, so a 3-boot run proves the full bound/no-rebound shape fast
      const discoveryFailFactory = scopedSpawnFailGitFactory((args) => Array.isArray(args) && args.includes(`--grep=Loom-Worker-Branch: ${first.branch}`));
      const sessionsDBound = new SessionService(dbDBound, pty, new OrchestrationControl(), { staleGenerationTransientEscalateAttempts: DBOUND_ATTEMPTS, staleGenerationDiscoveryGitFactory: discoveryFailFactory });

      const d1 = await sessionsDBound.reconcileOrchestrationOnBoot(new Set());
      console.log("DISCOVERY_BOUND_ATTEMPTS reconcile result (boot 1):", JSON.stringify(d1));
      check(`(DISCOVERY_BOUND_ATTEMPTS boot 1) tracked as transient, not yet escalated (attempt 1 of ${DBOUND_ATTEMPTS})`,
        dbDBound.listStaleGenerationUnresolved().some((e) => e.sessionId === workerXId && !e.escalated && e.kind === "transient" && e.attempts === 1));

      const d2 = await sessionsDBound.reconcileOrchestrationOnBoot(new Set());
      console.log("DISCOVERY_BOUND_ATTEMPTS reconcile result (boot 2, crosses threshold):", JSON.stringify(d2));
      check("(DISCOVERY_BOUND_ATTEMPTS boot 2) escalates on crossing the attempts threshold",
        dbDBound.listStaleGenerationUnresolved().some((e) => e.sessionId === workerXId && e.escalated && e.kind === "transient" && e.attempts === DBOUND_ATTEMPTS));
      check("(DISCOVERY_BOUND_ATTEMPTS boot 2) the one-shot escalation nudge fired exactly once",
        warnsMatching("escalated [loom:merge-orphaned]").filter((w) => w.includes(workerXId.slice(0, 8)) && w.includes("past the transient give-up threshold (one-shot)")).length === 1);

      const d3 = await sessionsDBound.reconcileOrchestrationOnBoot(new Set());
      console.log("DISCOVERY_BOUND_ATTEMPTS reconcile result (boot 3, no re-nudge):", JSON.stringify(d3));
      check("(DISCOVERY_BOUND_ATTEMPTS boot 3) stays escalated, sticky",
        dbDBound.listStaleGenerationUnresolved().some((e) => e.sessionId === workerXId && e.escalated));
      check("(DISCOVERY_BOUND_ATTEMPTS boot 3) the one-shot nudge did NOT re-fire a second time",
        warnsMatching("escalated [loom:merge-orphaned]").filter((w) => w.includes(workerXId.slice(0, 8)) && w.includes("past the transient give-up threshold (one-shot)")).length === 1);
    } finally {
      try { dbDBound?.close(); } catch { /* best-effort */ }
      for (const p of [R_DBOUND, dbDBoundPath]) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  // --- UPGRADE_LEGACY_BLOB (card 05915fc7, round 3, B1 — BLOCKING, reproduced): a row written by
  // pre-card `main` carries NO `kind` field at all. Round 2's own type guard on
  // listStaleGenerationUnresolved REQUIRED kind ∈ {"definitive","transient"}, so every such legacy row
  // was filtered out as corrupt on the first boot after upgrade — recordStaleGenerationUnresolved's own
  // upsert (`list.find(...)` against the now-empty list) then re-created an already-escalated worker's
  // row FRESH (`escalated:false`), firing a DUPLICATE [loom:merge-orphaned] nudge, while a second,
  // unrelated legacy row (no live session to ever touch it again) was silently dropped from the blob
  // entirely. The literal meta key below MUST match STALE_GENERATION_UNRESOLVED_KEY in db.ts exactly —
  // it is not exported (module-private), so this is a deliberate, hand-kept duplicate, not an import. ---
  {
    // NB: "legacy" is already a taken tag/prefix in this file (the LEGACY/setupLegacyNoFilesChangedPaths
    // scenario, R_LEGACY, above) — this block uses "ul" (UPGRADE_LEGACY_BLOB) throughout to avoid
    // colliding on the SAME temp directory path (same `sfx` for the whole file).
    const R_UL = path.join(os.tmpdir(), `loom-sglt-ul-${sfx}`);
    const dbUlPath = path.join(os.tmpdir(), `loom-sglt-ul-db-${sfx}.db`);
    let dbUl;
    try {
      initRepo(R_UL);
      dbUl = new Db(dbUlPath);
      const sessionsUl = new SessionService(dbUl, pty, new OrchestrationControl());
      const projId = `sglt-ul-proj-${sfx}`, agentId = `sglt-ul-agent-${sfx}`, taskId = `sglt-ul-task-${sfx}`;
      const mgrId = `sglt-ul-mgr-${sfx}`, workerXId = `sglt-ul-workerx-${sfx}`, workerYId = `sglt-ul-workery-${sfx}`;
      const orphanSessionId = `sglt-ul-orphan-${sfx}`; // deliberately never inserted as a real session row
      dbUl.insertProject({ id: projId, name: "SGLT-ul", repoPath: R_UL, vaultPath: R_UL, config: {}, createdAt: now, archivedAt: null });
      dbUl.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
      dbUl.insertTask({ id: taskId, projectId: projId, title: "SGLT-ul", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      dbUl.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: R_UL, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
      const genesisSha = git(R_UL, "rev-parse HEAD");
      dbUl.setMeta(mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: genesisSha }));
      const first = await createWorktree(R_UL, projId, taskId);
      dbUl.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
      fs.writeFileSync(path.join(first.worktreePath, "x.txt"), "x real work, never actually landed\n");
      commitAll(first.worktreePath, "x", GIT_ID);
      const xTip = git(first.worktreePath, "rev-parse HEAD"); // X's own reviewed tip — never merged anywhere

      // A deterministic, DEFINITIVE miss every boot (the same shape FORGED uses above): a forged commit
      // whose Loom-Landed-Tip equals xTip (so the trailer-value chain check trivially succeeds) but whose
      // own content never actually carries "x.txt" — recordedTipContentLanded always reads "no-match".
      fs.writeFileSync(path.join(R_UL, "pwned.txt"), "unrelated garbage, nothing to do with X's real work\n");
      commitAll(R_UL, [`chore(unrelated): forged commit`, `Loom-Worker-Branch: ${first.branch}\nLoom-Landed-Tip: ${xTip}`], GIT_ID);

      dbUl.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: xTip, filesChangedPaths: ["x.txt"] } });
      dbUl.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

      // Re-task Y (same pattern as finishWithRetask, inlined for this isolated db) — needed only so X
      // registers as a "stale generation" at all (currentGenerationIds keys on path/branch reuse).
      const second = await createWorktree(R_UL, projId, taskId);
      dbUl.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
      fs.writeFileSync(path.join(second.worktreePath, "y.txt"), "y work\n");
      commitAll(second.worktreePath, "y", GIT_ID);
      execSync(`git ${GIT_ID} merge --squash ${second.branch} && git ${GIT_ID} commit -q -m "SGLT-ul-y" -m "Loom-Worker-Branch: ${second.branch}"`, { cwd: R_UL });
      dbUl.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch } });

      // Seed the MAIN-shaped (pre-card) blob DIRECTLY — no `kind` field on either row, exactly what a
      // real pre-upgrade `app_meta` row looks like.
      const earlierIso = new Date(Date.parse(now) - 86_400_000).toISOString();
      const legacyBlob = [
        { sessionId: workerXId, branch: first.branch, taskId, projectId: projId, reason: "legacy pre-upgrade reason A", firstDetectedAt: earlierIso, lastAttemptAt: earlierIso, attempts: 5, escalated: true },
        { sessionId: orphanSessionId, branch: null, taskId: null, projectId: projId, reason: "legacy pre-upgrade reason B (orphaned, no live session)", firstDetectedAt: earlierIso, lastAttemptAt: earlierIso, attempts: 3, escalated: false },
      ];
      dbUl.setMeta("stale_generation_merge_unresolved", JSON.stringify(legacyBlob));

      const ulResult = await sessionsUl.reconcileOrchestrationOnBoot(new Set());
      console.log("UPGRADE_LEGACY_BLOB reconcile result:", JSON.stringify(ulResult));

      const postBoot = dbUl.listStaleGenerationUnresolved();
      check("(UPGRADE_LEGACY_BLOB) every pre-upgrade row survives the boot — none dropped for lacking a `kind` field",
        postBoot.length === 2 && postBoot.some((e) => e.sessionId === workerXId) && postBoot.some((e) => e.sessionId === orphanSessionId));
      const xEntry = postBoot.find((e) => e.sessionId === workerXId);
      check("(UPGRADE_LEGACY_BLOB) the already-escalated worker STAYS escalated (never resets to false)",
        xEntry?.escalated === true);
      check("(UPGRADE_LEGACY_BLOB) its attempts count is PRESERVED and incremented from the legacy value, never reset to 1",
        xEntry?.attempts === 6);
      check("(UPGRADE_LEGACY_BLOB) its kind now reads 'definitive' (the only kind that ever existed pre-card)",
        xEntry?.kind === "definitive");
      const orphanEntry = postBoot.find((e) => e.sessionId === orphanSessionId);
      check("(UPGRADE_LEGACY_BLOB) the orphaned row (no live session) is left completely UNTOUCHED",
        orphanEntry?.escalated === false && orphanEntry?.attempts === 3 && orphanEntry?.reason === "legacy pre-upgrade reason B (orphaned, no live session)");
      check("(UPGRADE_LEGACY_BLOB) no DUPLICATE nudge fires for the already-escalated worker this boot",
        warnsMatching("escalated [loom:merge-orphaned]").filter((w) => w.includes(workerXId.slice(0, 8))).length === 0);
      check("(UPGRADE_LEGACY_BLOB) never (re-)attributed", !dbUl.listEventsForWorker(workerXId).find((ev) => ev.kind === "merge_done"));
      check("(UPGRADE_LEGACY_BLOB) worker Y is still independently finalized, unaffected", dbUl.listEventsForWorker(workerYId).some((ev) => ev.kind === "merge_done"));
    } finally {
      try { dbUl?.close(); } catch { /* best-effort */ }
      for (const p of [R_UL, dbUlPath]) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  // --- BOUND_ATTEMPTS (card 05915fc7, round 3, S3): the transient give-up THRESHOLD itself, driven
  // through real boots — no escalation through attempts 1..N-1, EXACTLY one nudge at boot N (crossing
  // staleGenerationTransientEscalateAttempts), and no re-nudge at boot N+1. Isolated into its OWN fresh
  // Db/SessionService pair (never the shared `db`/`sessions`) so the LOW override here never affects any
  // other scenario's own attempt counting. Reuses the SAME real, deterministic per-candidate move-aside
  // corruption as RETRY_SUCCEEDS above, but — unlike that scenario — never restores the object at all:
  // this one needs the SAME transient condition to persist across every boot it drives. ---
  {
    const R_BOUND = path.join(os.tmpdir(), `loom-sglt-bound-${sfx}`);
    const dbBoundPath = path.join(os.tmpdir(), `loom-sglt-bound-db-${sfx}.db`);
    let dbBound;
    try {
      initRepo(R_BOUND);
      dbBound = new Db(dbBoundPath);
      const BOUND_ATTEMPTS = 2; // low, so a 3-boot run proves the full bound/no-rebound shape fast
      const sessionsBound = new SessionService(dbBound, pty, new OrchestrationControl(), { staleGenerationTransientEscalateAttempts: BOUND_ATTEMPTS });
      const projId = `sglt-bound-proj-${sfx}`, agentId = `sglt-bound-agent-${sfx}`, taskId = `sglt-bound-task-${sfx}`;
      const mgrId = `sglt-bound-mgr-${sfx}`, workerXId = `sglt-bound-workerx-${sfx}`, workerYId = `sglt-bound-workery-${sfx}`;
      dbBound.insertProject({ id: projId, name: "SGLT-bound", repoPath: R_BOUND, vaultPath: R_BOUND, config: {}, createdAt: now, archivedAt: null });
      dbBound.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
      dbBound.insertTask({ id: taskId, projectId: projId, title: "SGLT-bound", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      dbBound.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: R_BOUND, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
      const genesisSha = git(R_BOUND, "rev-parse HEAD");
      dbBound.setMeta(mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: genesisSha }));
      const first = await createWorktree(R_BOUND, projId, taskId);
      dbBound.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
      fs.writeFileSync(path.join(first.worktreePath, "bound.txt"), "bound content\n");
      commitAll(first.worktreePath, "c1 real", GIT_ID);
      const reviewedTip = git(first.worktreePath, "rev-parse HEAD");

      fs.mkdirSync(path.join(R_BOUND, "sub-bound"), { recursive: true });
      fs.writeFileSync(path.join(R_BOUND, "sub-bound", "leaf.txt"), `leaf-bound-${sfx}\n`);
      fs.writeFileSync(path.join(R_BOUND, "bound.txt"), "bound content\n"); // byte-identical to reviewedTip's own
      commitAll(R_BOUND, [`chore(unrelated): bound landing`, `Loom-Worker-Branch: ${first.branch}\nLoom-Worker-Base: ${genesisSha}`], GIT_ID);
      const xLandedSha = git(R_BOUND, "rev-parse HEAD");
      fs.rmSync(path.join(R_BOUND, "sub-bound"), { recursive: true, force: true });

      dbBound.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: reviewedTip, filesChangedPaths: ["bound.txt"] } });
      dbBound.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

      const second = await createWorktree(R_BOUND, projId, taskId);
      dbBound.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
      fs.writeFileSync(path.join(second.worktreePath, "y.txt"), "y work\n");
      commitAll(second.worktreePath, "y", GIT_ID);
      execSync(`git ${GIT_ID} merge --squash ${second.branch} && git ${GIT_ID} commit -q -m "SGLT-bound-y" -m "Loom-Worker-Branch: ${second.branch}"`, { cwd: R_BOUND });
      dbBound.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch } });

      corruptOneSubtree(R_BOUND, xLandedSha, "sub-bound"); // never restored — persists across every boot below

      // Boot 1 of BOUND_ATTEMPTS: tracked, transient, not yet escalated.
      const b1 = await sessionsBound.reconcileOrchestrationOnBoot(new Set());
      console.log("BOUND_ATTEMPTS reconcile result (boot 1):", JSON.stringify(b1));
      check(`(BOUND_ATTEMPTS boot 1) tracked as transient, not yet escalated (attempt 1 of ${BOUND_ATTEMPTS})`,
        dbBound.listStaleGenerationUnresolved().some((e) => e.sessionId === workerXId && !e.escalated && e.kind === "transient" && e.attempts === 1));
      check("(BOUND_ATTEMPTS boot 1) the boot-summary staleGenerationTransient counter includes this row", b1.staleGenerationTransient >= 1);
      check("(BOUND_ATTEMPTS boot 1) the boot-summary staleGenerationUnresolvedEscalated counter does NOT include this row yet", b1.staleGenerationUnresolvedEscalated === 0);

      // Boot 2: attempts reaches BOUND_ATTEMPTS — crosses the threshold, escalates exactly once.
      const b2 = await sessionsBound.reconcileOrchestrationOnBoot(new Set());
      console.log("BOUND_ATTEMPTS reconcile result (boot 2, crosses threshold):", JSON.stringify(b2));
      check("(BOUND_ATTEMPTS boot 2) escalates on crossing the attempts threshold",
        dbBound.listStaleGenerationUnresolved().some((e) => e.sessionId === workerXId && e.escalated && e.kind === "transient" && e.attempts === BOUND_ATTEMPTS));
      check("(BOUND_ATTEMPTS boot 2) the boot-summary staleGenerationUnresolvedEscalated counter now includes this row", b2.staleGenerationUnresolvedEscalated >= 1);
      check("(BOUND_ATTEMPTS boot 2) the one-shot escalation nudge fired exactly once",
        warnsMatching("escalated [loom:merge-orphaned]").filter((w) => w.includes(workerXId.slice(0, 8)) && w.includes("past the transient give-up threshold (one-shot)")).length === 1);

      // Boot 3 (N+1): still escalated, sticky — the nudge does NOT re-fire a second time.
      const b3 = await sessionsBound.reconcileOrchestrationOnBoot(new Set());
      console.log("BOUND_ATTEMPTS reconcile result (boot 3, no re-nudge):", JSON.stringify(b3));
      check("(BOUND_ATTEMPTS boot 3) stays escalated, sticky",
        dbBound.listStaleGenerationUnresolved().some((e) => e.sessionId === workerXId && e.escalated));
      check("(BOUND_ATTEMPTS boot 3) the one-shot nudge did NOT re-fire a second time",
        warnsMatching("escalated [loom:merge-orphaned]").filter((w) => w.includes(workerXId.slice(0, 8)) && w.includes("past the transient give-up threshold (one-shot)")).length === 1);
      check("(BOUND_ATTEMPTS) worker Y is still independently finalized, unaffected", dbBound.listEventsForWorker(workerYId).some((ev) => ev.kind === "merge_done"));
    } finally {
      try { dbBound?.close(); } catch { /* best-effort */ }
      for (const p of [R_BOUND, dbBoundPath]) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  // --- BOUND_AGE (card 05915fc7, round 3, S3): the AGE leg of the give-up threshold
  // (ageMs >= staleGenerationTransientEscalateMs) fires independently of the attempts leg — the attempts
  // threshold is set deliberately UNREACHABLE in 2 boots here, so only the age leg can possibly cross it.
  // sleepPast proves the real wait genuinely outlasts the Ms threshold rather than trusting a comment
  // (see fixed-wait-witness-guard.mjs / _wait.mjs's own doc). ---
  {
    const R_BOUND_AGE = path.join(os.tmpdir(), `loom-sglt-bound-age-${sfx}`);
    const dbBoundAgePath = path.join(os.tmpdir(), `loom-sglt-bound-age-db-${sfx}.db`);
    let dbBoundAge;
    try {
      initRepo(R_BOUND_AGE);
      dbBoundAge = new Db(dbBoundAgePath);
      const AGE_MS = 50;
      const sessionsBoundAge = new SessionService(dbBoundAge, pty, new OrchestrationControl(), {
        staleGenerationTransientEscalateAttempts: 1000, // deliberately unreachable in 2 boots
        staleGenerationTransientEscalateMs: AGE_MS,
      });
      const projId = `sglt-boundage-proj-${sfx}`, agentId = `sglt-boundage-agent-${sfx}`, taskId = `sglt-boundage-task-${sfx}`;
      const mgrId = `sglt-boundage-mgr-${sfx}`, workerXId = `sglt-boundage-workerx-${sfx}`, workerYId = `sglt-boundage-workery-${sfx}`;
      dbBoundAge.insertProject({ id: projId, name: "SGLT-boundage", repoPath: R_BOUND_AGE, vaultPath: R_BOUND_AGE, config: {}, createdAt: now, archivedAt: null });
      dbBoundAge.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
      dbBoundAge.insertTask({ id: taskId, projectId: projId, title: "SGLT-boundage", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
      dbBoundAge.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: R_BOUND_AGE, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
      const genesisSha = git(R_BOUND_AGE, "rev-parse HEAD");
      dbBoundAge.setMeta(mainlineWatermarkKey(projId, "primary"), JSON.stringify({ branch: "main", sha: genesisSha }));
      const first = await createWorktree(R_BOUND_AGE, projId, taskId);
      dbBoundAge.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
      fs.writeFileSync(path.join(first.worktreePath, "age.txt"), "age content\n");
      commitAll(first.worktreePath, "c1 real", GIT_ID);
      const reviewedTip = git(first.worktreePath, "rev-parse HEAD");

      fs.mkdirSync(path.join(R_BOUND_AGE, "sub-age"), { recursive: true });
      fs.writeFileSync(path.join(R_BOUND_AGE, "sub-age", "leaf.txt"), `leaf-boundage-${sfx}\n`);
      fs.writeFileSync(path.join(R_BOUND_AGE, "age.txt"), "age content\n");
      commitAll(R_BOUND_AGE, [`chore(unrelated): boundage landing`, `Loom-Worker-Branch: ${first.branch}\nLoom-Worker-Base: ${genesisSha}`], GIT_ID);
      const xLandedSha = git(R_BOUND_AGE, "rev-parse HEAD");
      fs.rmSync(path.join(R_BOUND_AGE, "sub-age"), { recursive: true, force: true });

      dbBoundAge.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: reviewedTip, filesChangedPaths: ["age.txt"] } });
      dbBoundAge.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });

      const second = await createWorktree(R_BOUND_AGE, projId, taskId);
      dbBoundAge.insertSession({ id: workerYId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
      fs.writeFileSync(path.join(second.worktreePath, "y.txt"), "y work\n");
      commitAll(second.worktreePath, "y", GIT_ID);
      execSync(`git ${GIT_ID} merge --squash ${second.branch} && git ${GIT_ID} commit -q -m "SGLT-boundage-y" -m "Loom-Worker-Branch: ${second.branch}"`, { cwd: R_BOUND_AGE });
      dbBoundAge.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch } });

      corruptOneSubtree(R_BOUND_AGE, xLandedSha, "sub-age"); // never restored — persists for both boots below

      const a1 = await sessionsBoundAge.reconcileOrchestrationOnBoot(new Set());
      console.log("BOUND_AGE reconcile result (boot 1):", JSON.stringify(a1));
      check("(BOUND_AGE boot 1) tracked as transient, not yet escalated (age not yet past the Ms threshold)",
        dbBoundAge.listStaleGenerationUnresolved().some((e) => e.sessionId === workerXId && !e.escalated && e.kind === "transient"));

      await sleepPast(AGE_MS + 100, AGE_MS, "past staleGenerationTransientEscalateMs"); // proves elapsed > AGE_MS, not a guess

      const a2 = await sessionsBoundAge.reconcileOrchestrationOnBoot(new Set());
      console.log("BOUND_AGE reconcile result (boot 2, age threshold crossed):", JSON.stringify(a2));
      const ageEntry = dbBoundAge.listStaleGenerationUnresolved().find((e) => e.sessionId === workerXId);
      check("(BOUND_AGE boot 2) escalates via the AGE leg alone — attempts is still far below its own (deliberately unreachable) threshold",
        ageEntry?.escalated === true && ageEntry?.kind === "transient" && ageEntry.attempts < 1000);
      check("(BOUND_AGE) worker Y is still independently finalized, unaffected", dbBoundAge.listEventsForWorker(workerYId).some((ev) => ev.kind === "merge_done"));
    } finally {
      try { dbBoundAge?.close(); } catch { /* best-effort */ }
      for (const p of [R_BOUND_AGE, dbBoundAgePath]) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    }
  }

  // --- Mutation proof (round 4): the content check's pathspec is LOAD-BEARING, not merely present. Drop
  // A.txt from REVERT's own stamped pathspec and confirm the partial landing's missing revert becomes
  // INVISIBLE — recordedTipContentLanded flips from "no-match" (what the full pipeline above already
  // proved) to "attributed" when A.txt is left out. ---
  {
    const full = await recordedTipContentLanded(REVERT.repo, REVERT.reviewedTip, REVERT.forgedSha, ["A.txt", "B.txt"]);
    check("(REVERT mutation proof) the FULL stamped pathspec correctly refuses the partial landing", full === "no-match");
    const dropped = await recordedTipContentLanded(REVERT.repo, REVERT.reviewedTip, REVERT.forgedSha, ["B.txt"]);
    check("(REVERT mutation proof) dropping A.txt from the pathspec wrongly ATTRIBUTES — proves the check is load-bearing", dropped === "attributed");
  }

  // --- Direct proof: machineReadablePathSet's own cap (round 5's bound) truncates rather than stamping a
  // partial (and therefore misleading) list, and it reads a non-ASCII+CJK name and a literal `{{x}}/` name
  // RAW — never through --stat's C-quoting or normalizeDiffstatPath's rename-collapse syntax. ---
  {
    const capRepo = path.join(os.tmpdir(), `loom-sglt-cap-${sfx}`);
    initRepo(capRepo);
    const capBase = git(capRepo, "rev-parse HEAD");
    fs.writeFileSync(path.join(capRepo, "f0.txt"), "0\n");
    fs.writeFileSync(path.join(capRepo, "f1.txt"), "1\n");
    fs.writeFileSync(path.join(capRepo, "f2.txt"), "2\n");
    commitAll(capRepo, "3 files", GIT_ID);
    const underCap = await machineReadablePathSet(capRepo, `${capBase}...HEAD`);
    check("(cap proof) a small file set resolves ok, not truncated", "paths" in underCap && underCap.paths.length === 3);

    const overCapRepo = path.join(os.tmpdir(), `loom-sglt-overcap-${sfx}`);
    initRepo(overCapRepo);
    const overCapBase = git(overCapRepo, "rev-parse HEAD");
    fs.mkdirSync(path.join(overCapRepo, "m"), { recursive: true });
    for (let i = 0; i < FILES_CHANGED_PATHS_MAX_COUNT + 1; i++) fs.writeFileSync(path.join(overCapRepo, `m/f${i}.txt`), `${i}\n`);
    commitAll(overCapRepo, "over cap", GIT_ID);
    const overCap = await machineReadablePathSet(overCapRepo, `${overCapBase}...HEAD`);
    check("(cap proof) over FILES_CHANGED_PATHS_MAX_COUNT truncates instead of stamping a partial list", "truncated" in overCap && overCap.truncated === true);

    const nameRepo = path.join(os.tmpdir(), `loom-sglt-names-${sfx}`);
    initRepo(nameRepo);
    const nameBase = git(nameRepo, "rev-parse HEAD");
    fs.mkdirSync(path.join(nameRepo, "{{tpl}}"), { recursive: true });
    fs.writeFileSync(path.join(nameRepo, "{{tpl}}", "a.txt"), "t\n");
    fs.writeFileSync(path.join(nameRepo, "café-日本語.txt"), "c\n");
    commitAll(nameRepo, "brace + nonascii/cjk", GIT_ID);
    const names = await machineReadablePathSet(nameRepo, `${nameBase}...HEAD`);
    check("(cap proof) a non-ASCII+CJK name comes through RAW, never --stat's C-quoting",
      "paths" in names && names.paths.includes("café-日本語.txt"));
    check("(cap proof) a literal {{x}}/ name is never mis-rewritten by normalizeDiffstatPath's rename-collapse syntax",
      "paths" in names && names.paths.includes("{{tpl}}/a.txt"));

    for (const dir of [capRepo, overCapRepo, nameRepo]) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }

  // --- Producer-side proof (round 4 DoD item 3): a REAL reviewWorkerMerge call, scoped (files), still
  // stamps the UNFILTERED path set. Mutation: stamping the filtered set instead would make this RED. ---
  {
    const pRepo = path.join(os.tmpdir(), `loom-sglt-producer-${sfx}`);
    initRepo(pRepo);
    const pProjId = `sglt-producer-proj-${sfx}`, pAgentId = `sglt-producer-agent-${sfx}`, pTaskId = `sglt-producer-task-${sfx}`;
    const pMgrId = `sglt-producer-mgr-${sfx}`, pWorkerId = `sglt-producer-worker-${sfx}`;
    db.insertProject({ id: pProjId, name: "SGLT-producer", repoPath: pRepo, vaultPath: pRepo, config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: pAgentId, projectId: pProjId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: pTaskId, projectId: pProjId, title: "SGLT-producer", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: pMgrId, projectId: pProjId, agentId: pAgentId, engineSessionId: null, title: null, cwd: pRepo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const pWt = await createWorktree(pRepo, pProjId, pTaskId);
    db.insertSession({ id: pWorkerId, projectId: pProjId, agentId: pAgentId, engineSessionId: null, title: null, cwd: pWt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: pMgrId, taskId: pTaskId, worktreePath: pWt.worktreePath, branch: pWt.branch });
    fs.writeFileSync(path.join(pWt.worktreePath, "A.txt"), "a\n");
    fs.writeFileSync(path.join(pWt.worktreePath, "B.txt"), "b\n");
    commitAll(pWt.worktreePath, "add A and B", GIT_ID);
    // A SCOPED review (files: ["A.txt"]) — the DISPLAY narrows to A.txt only, but the stamped
    // filesChangedPaths must still name BOTH files.
    await sessions.reviewWorkerMerge(pMgrId, pWorkerId, { files: ["A.txt"], includePatch: false });
    const producerEvent = db.listEventsForWorker(pWorkerId).find((ev) => ev.kind === "merge_request");
    check("(producer proof) a SCOPED review (files:['A.txt']) still stamps the UNFILTERED path set",
      JSON.stringify([...(producerEvent?.detail?.filesChangedPaths ?? [])].sort()) === JSON.stringify(["A.txt", "B.txt"]));
    check("(producer proof) the DISPLAY-facing filesChanged stays narrowed to the scoped count", producerEvent?.detail?.filesChanged === 1);
    try { fs.rmSync(pRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // --- Direct proof (round 6, Code Review e319ea92 finding 3, minor): parseNameStatusZ fails CLOSED on a
  // malformed/short -z record (an R/C row missing its 2nd declared path, or a status with no path field
  // at all) rather than silently dropping just that one field and returning a PARTIAL set that reads as a
  // complete-but-smaller one. Also proves byte accounting now uses UTF-8 bytes (Buffer.byteLength), not
  // UTF-16 code units (.length) — a non-ASCII name whose UTF-8 encoding alone crosses the byte cap must
  // truncate even though its JS .length would not. ---
  {
    const wellFormed = parseNameStatusZ("A\0a.txt\0R100\0old.txt\0new.txt\0");
    check("(parse proof) a well-formed -z stream parses all paths, both sides of a rename",
      "paths" in wellFormed && JSON.stringify(wellFormed.paths) === JSON.stringify(["a.txt", "old.txt", "new.txt"]));

    const shortRename = parseNameStatusZ("A\0a.txt\0R100\0old.txt"); // 2nd rename path missing entirely
    check("(parse proof) a short R/C record (missing its 2nd path) fails CLOSED to truncated, never a partial list",
      "truncated" in shortRename && shortRename.truncated === true);

    const noPath = parseNameStatusZ("A\0a.txt\0M"); // a status with no path field at all
    check("(parse proof) a status token with no path field fails CLOSED to truncated",
      "truncated" in noPath && noPath.truncated === true);

    // 日 is 3 bytes in UTF-8, 1 UTF-16 code unit — a name whose UTF-8 byte length alone crosses the cap
    // but whose JS .length does not. Old code (`bytes += p.length`) would NOT truncate this; the fix
    // (`Buffer.byteLength`) must.
    const wideName = "日".repeat(Math.ceil(FILES_CHANGED_PATHS_MAX_BYTES / 3) + 10);
    const wideResult = parseNameStatusZ(`A\0${wideName}\0`);
    check("(parse proof) UTF-8 byte accounting (Buffer.byteLength, not .length) truncates a wide-char name correctly",
      "truncated" in wideResult && wideResult.truncated === true);
  }

  // --- Direct proof (round 6, Code Review e319ea92 finding 1b — REPURPOSED by card 1cf79e64 now that
  // recordedTipContentLanded no longer uses a pathspec at all; see docs/decisions/1cf79e64-*.md). This
  // used to prove `--literal-pathspecs` was load-bearing against a bracket-shaped name glob-matching an
  // unrelated, independently-drifting file. That flag and the pathspec it guarded are both gone now — the
  // SAME scenario (a genuine landing whose own bracket-named file matches exactly, sitting next to an
  // unrelated coincidentally-bracket-matching file that drifted) is kept to prove the new tree-entry
  // comparison still attributes correctly via plain Map-key equality, with no flag or pathspec involved at
  // all. The second assertion below is now purely illustrative — it demonstrates the pathspec hazard class
  // this redesign structurally avoids, not a risk `recordedTipContentLanded` itself still runs. ---
  {
    const bnRepo = path.join(os.tmpdir(), `loom-sglt-bracket-${sfx}`);
    initRepo(bnRepo);
    fs.mkdirSync(path.join(bnRepo, "pages"), { recursive: true });
    fs.writeFileSync(path.join(bnRepo, "pages", "i.tsx"), "0\n");
    commitAll(bnRepo, "seed pages/i.tsx (pre-worker, coincidentally glob-matching)", GIT_ID);
    const bnBase = git(bnRepo, "rev-parse HEAD");

    // The worker's own real tip: adds pages/[i].tsx (literal brackets). pages/i.tsx stays untouched here.
    fs.writeFileSync(path.join(bnRepo, "pages", "[i].tsx"), "the worker's real file\n");
    commitAll(bnRepo, "worker adds pages/[i].tsx", GIT_ID);
    const bnReviewedTip = git(bnRepo, "rev-parse HEAD");

    // A GENUINE candidate, branching from bnBase (not bnReviewedTip): matches the worker's own
    // pages/[i].tsx EXACTLY, but pages/i.tsx independently drifted (0 -> 1) — unrelated main churn the
    // worker never touched, same shape as the already-accepted LAG scenario above.
    execSync("git checkout -q " + bnBase, { cwd: bnRepo });
    fs.writeFileSync(path.join(bnRepo, "pages", "i.tsx"), "1\n");
    fs.writeFileSync(path.join(bnRepo, "pages", "[i].tsx"), "the worker's real file\n");
    commitAll(bnRepo, "genuine landing: worker's file matches, unrelated pages/i.tsx drifted", GIT_ID);
    const bnCandidate = git(bnRepo, "rev-parse HEAD");

    const bnStamp = ["pages/[i].tsx"]; // what a real review would stamp for the worker's own commit

    const treeEntryResult = await recordedTipContentLanded(bnRepo, bnReviewedTip, bnCandidate, bnStamp);
    check("(bracket precision) recordedTipContentLanded correctly attributes via exact tree-entry comparison — the unrelated drift is never consulted at all (it isn't in the stamped set)",
      treeEntryResult === "attributed");

    // Illustrative only: a NAIVE pathspec-based diff (the OLD design) sweeps in the unrelated pages/i.tsx
    // drift because it glob-matches the bracket-shaped pathspec — this is the hazard class the tree-entry
    // redesign avoids structurally (no pathspec is ever passed to git by the real function anymore).
    const naivePathspecDiff = git(bnRepo, `diff --name-only ${bnCandidate} ${bnReviewedTip} -- "pages/[i].tsx"`); // git() trims trailing newline
    check("(bracket precision) a NAIVE pathspec diff (illustrative, not what the real function runs) wrongly sweeps in the unrelated drift — the hazard this redesign avoids",
      naivePathspecDiff === "pages/i.tsx");

    try { fs.rmSync(bnRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // --- Direct proof (card 1cf79e64 round 2, Code Review minor 1): `git.raw()` (simple-git) returns a
  // UTF-8-DECODED string, never raw bytes — a genuinely non-UTF-8 path decodes LOSSILY (Node substitutes
  // U+FFFD for each invalid byte sequence), so two DIFFERENT raw paths can collide as one decoded key.
  // `git mktree` (fed raw bytes on STDIN, never argv — argv would force Node to re-encode as valid UTF-8)
  // is the one plumbing primitive available on this host that can put a genuinely non-UTF-8 byte sequence
  // into a real tree object at all. ---
  {
    const futf8Repo = path.join(os.tmpdir(), `loom-sglt-badutf8-${sfx}`);
    fs.mkdirSync(futf8Repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: futf8Repo });
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: futf8Repo, input: "x\n" }).toString().trim();
    // 0xC0 and 0xC1 are both invalid UTF-8 lead bytes in isolation (they can only ever introduce an
    // OVERLONG encoding, which is itself illegal) — two GENUINELY DIFFERENT single-byte names, each
    // decoding (lossily) to the SAME one-character string "�" when read as UTF-8.
    const mktreeInput = Buffer.concat([
      Buffer.from(`100644 blob ${blob}\t`), Buffer.from([0xc0]), Buffer.from("\n"),
      Buffer.from(`100644 blob ${blob}\t`), Buffer.from([0xc1]), Buffer.from("\n"),
    ]);
    const badTree = execFileSync("git", ["mktree"], { cwd: futf8Repo, input: mktreeInput }).toString().trim();
    const badCommit = execFileSync("git", [...GIT_ID.split(" "), "commit-tree", badTree, "-m", "bad-utf8"], { cwd: futf8Repo }).toString().trim();

    const badResult = await fullTreeEntries(futf8Repo, badCommit);
    // Honest scope note: the per-entry U+FFFD check already fails this closed on the FIRST such entry,
    // before the duplicate-key check ever runs — the duplicate check is additional defense-in-depth for a
    // decode COLLISION that doesn't itself contain U+FFFD, which isn't reachable through real UTF-8
    // decoding (two distinct VALID UTF-8 byte sequences can never decode to the identical string), so this
    // one test cannot isolate the duplicate-key branch from the U+FFFD branch on this host.
    check("(UTF-8 decode safety) a tree with two genuinely different invalid-UTF-8 names (which decode lossily to the identical U+FFFD string) makes fullTreeEntries fail closed to null",
      badResult === null);

    // Control: an ordinary valid-UTF-8 non-ASCII name is unaffected by either new check.
    const goodBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: futf8Repo, input: "y\n" }).toString().trim();
    const goodTree = execFileSync("git", ["mktree"], { cwd: futf8Repo, input: `100644 blob ${goodBlob}\tcafé.txt\n` }).toString().trim();
    const goodCommit = execFileSync("git", [...GIT_ID.split(" "), "commit-tree", goodTree, "-m", "good-utf8"], { cwd: futf8Repo }).toString().trim();
    const goodResult = await fullTreeEntries(futf8Repo, goodCommit);
    check("(UTF-8 decode safety control) an ordinary valid-UTF-8 non-ASCII name is read normally, not rejected",
      goodResult !== null && goodResult.has("café.txt"));

    try { fs.rmSync(futf8Repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // --- Direct proof (round 6, finding 4). Built via plumbing (hash-object/update-index/write-tree/
  // commit-tree) because a literal backslash in a filename cannot be created through the real filesystem
  // on Windows.
  // @decision c7dc99bf — stampedPathsPlausible only rejects a path NEVER real at either reference point
  // (a forgery); it cannot detect a candidate merely omitting a real added file — that stays the content
  // check's job alone. ---
  {
    const bsRepo = path.join(os.tmpdir(), `loom-sglt-bslash-${sfx}`);
    fs.mkdirSync(bsRepo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: bsRepo });
    const BS_ID = ["-c", "user.email=sglt@loom", "-c", "user.name=sglt"];
    const bsRaw = (args, input) => execFileSync("git", args, { cwd: bsRepo, input }).toString();
    const bsBlob = (content) => bsRaw(["hash-object", "-w", "--stdin"], content).trim();
    const bsTree = (entries) => {
      const env = { ...process.env, GIT_INDEX_FILE: path.join(os.tmpdir(), `loom-sglt-bslash-idx-${sfx}-${Math.random()}`) };
      for (const [p, content] of entries) {
        execFileSync("git", ["-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${bsBlob(content)},${p}`], { cwd: bsRepo, env });
      }
      return execFileSync("git", ["write-tree"], { cwd: bsRepo, env }).toString().trim();
    };
    const bsCommit = (tree, parent, msg) => bsRaw([...BS_ID, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", msg]).trim();

    const BS_BOGUS_NAME = "back\\slash-never-real.txt"; // NEVER actually tracked anywhere in this repo
    const REAL_NAME = "real.txt";
    const bsBase = bsCommit(bsTree([["keep.txt", "k\n"]]), null, "base");
    const bsReviewedTip = bsCommit(bsTree([["keep.txt", "k\n"], [REAL_NAME, "r\n"]]), bsBase, "reviewedTip"); // adds a real file; never touches BS_BOGUS_NAME
    const bsCandidate = bsCommit(bsTree([["keep.txt", "k\n"], [REAL_NAME, "r\n"]]), bsBase, "candidate"); // matches reviewedTip's real work exactly
    // A FORGED stamp: claims the review also saw a change to BS_BOGUS_NAME, which never existed anywhere.
    const forgedStamp = [REAL_NAME, BS_BOGUS_NAME];

    const forgedContentAlone = await recordedTipContentLanded(bsRepo, bsReviewedTip, bsCandidate, forgedStamp);
    check("(backslash net) content check ALONE wrongly reads the forged bogus-path stamp as attributed — no pathspec exists anymore, but BS_BOGUS_NAME is absent from BOTH sides' tree-entry maps, so it vacuously matches in isolation from REAL_NAME's own (correctly-compared) entry",
      forgedContentAlone === "attributed");

    const forgedPlausible = await stampedPathsPlausible(bsRepo, bsReviewedTip, bsCandidate, forgedStamp);
    check("(backslash net) stampedPathsPlausible correctly rejects the forged bogus-path stamp the content check alone missed — if this net were deleted, that wrong attribution would go uncaught",
      forgedPlausible === false);

    // Control: a GENUINE stamp (the real file only) still attributes correctly through both checks.
    const genuineStamp = [REAL_NAME];
    const genuinePlausible = await stampedPathsPlausible(bsRepo, bsReviewedTip, bsCandidate, genuineStamp);
    check("(backslash net) a genuine (non-bogus) stamp is still plausible",
      genuinePlausible === true);
    const genuineContent = await recordedTipContentLanded(bsRepo, bsReviewedTip, bsCandidate, genuineStamp);
    check("(backslash net) a genuine (non-bogus) stamp still attributes",
      genuineContent === "attributed");

    // THE ACTUAL ROUND-6 REGRESSION FIX (distinct from the forged-path proof above): round 5's own
    // per-path `ls-tree --literal-pathspecs -- <path>` design used the SAME backslash-defeated pathspec
    // mechanism for checking recordedTip's OWN tree, not just the candidate's — so a path that GENUINELY
    // existed in recordedTip (a real backslash-named file the worker actually added) still read as
    // implausible, even in a trivial self-comparison. Measured directly against round 5's build
    // (4f7bab44/a8506a3c/9a4f574b): plausible(tip, tip, [backslashPath]) read `false`. The round-6
    // full-tree-listing redesign has no pathspec left to defeat, so this must now read `true`.
    const BS_REAL_NAME = "back\\slash-genuine.txt"; // a GENUINE backslash-named file the worker actually adds
    const bsGenuine = bsCommit(bsTree([["keep.txt", "k\n"], [BS_REAL_NAME, "worker\n"]]), bsBase, "bsGenuine");
    const bsReviewedTip2 = bsCommit(bsTree([["keep.txt", "k\n"], [BS_REAL_NAME, "worker\n"]]), bsBase, "bsReviewedTip2");
    const bsPlausibleGenuineBackslash = await stampedPathsPlausible(bsRepo, bsReviewedTip2, bsGenuine, [BS_REAL_NAME]);
    check("(backslash net regression) a GENUINE backslash-named landing no longer false-escalates (round 5's per-path design read this implausible even for an exact self-match)",
      bsPlausibleGenuineBackslash === true);
    const bsContentGenuineBackslash = await recordedTipContentLanded(bsRepo, bsReviewedTip2, bsGenuine, [BS_REAL_NAME]);
    check("(backslash net regression) the content check also correctly attributes the genuine backslash-named landing",
      bsContentGenuineBackslash === "attributed");

    try { fs.rmSync(bsRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // (LANDEDTIP-REF-NAME-SHAPE, card b8122303) — a trailer-derived `Loom-Landed-Tip` is shape-validated at
  // parse time (/^[0-9a-f]{40,64}$/, which also admits a 41-64-char string — never itself a valid SHA-1
  // object-id SHAPE, only ever resolvable as a REF NAME) but that alone does not prove it resolves to
  // ITSELF: a same-named ref (planted by anyone with write access to the shared .git) resolves to the
  // ref's TARGET instead of the literal text — the identical class c0d0eac9 round 7 closed for
  // `Loom-Worker-Base` (same 50-hex-char construction as that card's own REF-NAME-BASE-SHAPE fixture, in
  // tolerant-loom-trailer-discovery.mjs). `verifyReviewedTipChain`'s `live` param must reject this at
  // entry, before the chain walk (and even before the trivial `cur === reviewed` string-equality fast
  // path) ever runs.
  {
    const rtRepo = path.join(os.tmpdir(), `loom-sglt-reftip-${sfx}`);
    fs.mkdirSync(rtRepo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: rtRepo });
    const RT_ID = ["-c", "user.email=sglt@loom", "-c", "user.name=sglt"];
    fs.writeFileSync(path.join(rtRepo, "a.txt"), "a\n");
    execFileSync("git", ["add", "-A"], { cwd: rtRepo });
    execFileSync("git", [...RT_ID, "commit", "-q", "-m", "genesis"], { cwd: rtRepo });
    const rtDecoyTarget = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rtRepo }).toString().trim(); // what the planted ref will ACTUALLY point at
    // A 50-hex-char string — too long to be a SHA-1 object id, so git resolves it ONLY as a REF NAME.
    const rtRefNameHex = "4".repeat(50);
    execFileSync("git", [...RT_ID, "tag", rtRefNameHex, rtDecoyTarget], { cwd: rtRepo });

    const rtResolved = execFileSync("git", ["rev-parse", "--verify", "--quiet", `${rtRefNameHex}^{object}`], { cwd: rtRepo }).toString().trim();
    check("(LANDEDTIP-REF-NAME-SHAPE) setup control: rtRefNameHex resolves (via the planted ref) to the DECOY target, proving it is NOT itself a raw object id",
      rtResolved === rtDecoyTarget && rtResolved !== rtRefNameHex);

    // `reviewed === live` (both rtRefNameHex's literal text) — proves the entry validation runs BEFORE the
    // old trivial `cur === reviewed` string-equality fast path, not just somewhere later in the walk.
    const rtChain = await verifyReviewedTipChain(rtRepo, rtRefNameHex, rtRefNameHex, {}, [], "HEAD");
    check("(LANDEDTIP-REF-NAME-SHAPE) THE FIX: a ref-name-shaped live tip is a DEFINITIVE refusal, never chain-ok",
      rtChain.ok === false);

    // card b8122303 Code Review (reviewer 201f0fa5), THE REALISTIC SHAPE: `reviewed` is a REAL, DIFFERENT
    // commit (rtDecoyTarget), and `live` is the ref-name-shaped forgery that happens to resolve (via the
    // planted ref) to that SAME commit — reviewed !== live as LITERAL TEXT, so the old `cur === reviewed`
    // fast path never fires; the old code instead fell through into `reachable(cur, mainRef)` /
    // `reachable(reviewed, cur)`, where `cur` (interpolated raw into git argv) resolved via the ref to
    // rtDecoyTarget, making BOTH reachability checks trivially true against reviewed === rtDecoyTarget —
    // a forged chain-ok, pre-fix. Must now be a definitive refusal.
    const rtRealisticChain = await verifyReviewedTipChain(rtRepo, rtDecoyTarget, rtRefNameHex, {}, [], "HEAD");
    check("(LANDEDTIP-REF-NAME-SHAPE) THE FIX, realistic shape (reviewed=real commit, live=ref-name-shaped forgery resolving to it): a DEFINITIVE refusal, never chain-ok",
      rtRealisticChain.ok === false);

    // Control: a genuine, real commit sha (no decoy ref involved) still resolves chain-ok.
    const rtCleanChain = await verifyReviewedTipChain(rtRepo, rtDecoyTarget, rtDecoyTarget, {}, [], "HEAD");
    check("(LANDEDTIP-REF-NAME-SHAPE) control: a genuine raw commit sha (no ref-name ambiguity) still resolves chain-ok (the fix is not a blanket refusal)",
      rtCleanChain.ok === true);

    try { fs.rmSync(rtRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // --- Direct proof (card 1cf79e64, F4/F4b): a genuine omission of a real backslash-named file, and an
  // all-backslash stamp against a wholly unrelated candidate, both now escalate instead of wrongly
  // attributing. Built via the same plumbing technique as the backslash-net block above (a literal
  // backslash cannot be created through the real filesystem on Windows). See docs/decisions/1cf79e64-*.md
  // for the full repro this mirrors and the design that fixes it. ---
  {
    const f4Repo = path.join(os.tmpdir(), `loom-sglt-f4-${sfx}`);
    fs.mkdirSync(f4Repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: f4Repo });
    const F4_ID = ["-c", "user.email=sglt@loom", "-c", "user.name=sglt"];
    const f4Raw = (args, input) => execFileSync("git", args, { cwd: f4Repo, input }).toString();
    const f4Blob = (content) => f4Raw(["hash-object", "-w", "--stdin"], content).trim();
    const f4Tree = (entries) => {
      const env = { ...process.env, GIT_INDEX_FILE: path.join(os.tmpdir(), `loom-sglt-f4-idx-${sfx}-${Math.random()}`) };
      for (const [p, content] of entries) {
        execFileSync("git", ["-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${f4Blob(content)},${p}`], { cwd: f4Repo, env });
      }
      return execFileSync("git", ["write-tree"], { cwd: f4Repo, env }).toString().trim();
    };
    const f4Commit = (tree, parent, msg) => f4Raw([...F4_ID, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", msg]).trim();

    const F4_BS_NAME = "back\\slash-f4.txt"; // a GENUINE backslash-named file the worker actually added
    const F4_REAL_NAME = "real-f4.txt";
    const f4Base = f4Commit(f4Tree([["keep.txt", "k\n"]]), null, "base");
    // reviewedTip: the worker's REAL tip — genuinely adds BOTH files.
    const f4ReviewedTip = f4Commit(f4Tree([["keep.txt", "k\n"], [F4_REAL_NAME, "r\n"], [F4_BS_NAME, "b\n"]]), f4Base, "reviewedTip");
    // F4: a partial candidate that OMITS the backslash file — never actually landed it.
    const f4PartialCandidate = f4Commit(f4Tree([["keep.txt", "k\n"], [F4_REAL_NAME, "r\n"]]), f4Base, "partial");
    const f4Stamp = [F4_REAL_NAME, F4_BS_NAME]; // what a real review of reviewedTip would have stamped

    const f4Content = await recordedTipContentLanded(f4Repo, f4ReviewedTip, f4PartialCandidate, f4Stamp);
    check("(F4) a genuine omission of a real backslash-named file now escalates — tree-entry comparison is not defeated by git's backslash-as-separator handling",
      f4Content === "no-match");
    const f4Plausible = await stampedPathsPlausible(f4Repo, f4ReviewedTip, f4PartialCandidate, f4Stamp);
    check("(F4) stampedPathsPlausible still reads plausible for this candidate (the backslash file IS genuinely present in reviewedTip's own tree) — confirms the fix is in the content check, not a side effect of the net",
      f4Plausible === true);

    // F4b (wider): EVERY stamped path is backslash-shaped; candidate has ZERO shared history/content.
    const f4bUnrelatedCandidate = f4Commit(f4Tree([["totally-different.txt", "nothing shared\n"]]), null, "unrelated");
    const f4bAllBackslashStamp = [F4_BS_NAME];
    const f4bContent = await recordedTipContentLanded(f4Repo, f4ReviewedTip, f4bUnrelatedCandidate, f4bAllBackslashStamp);
    check("(F4b) an all-backslash stamp against a wholly unrelated candidate now escalates, instead of vacuously attributing",
      f4bContent === "no-match");

    // Positive control: a genuine backslash-named landing (candidate matches reviewedTip exactly) still
    // attributes — the fix escalates a real omission, it does not blanket-refuse every backslash name.
    const f4GenuineCandidate = f4Commit(f4Tree([["keep.txt", "k\n"], [F4_REAL_NAME, "r\n"], [F4_BS_NAME, "b\n"]]), f4Base, "genuine");
    const f4GenuineContent = await recordedTipContentLanded(f4Repo, f4ReviewedTip, f4GenuineCandidate, f4Stamp);
    check("(F4 control) a genuine backslash-named landing (no omission) still attributes",
      f4GenuineContent === "attributed");

    try { fs.rmSync(f4Repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // --- Direct proof (card 1cf79e64, manager condition 3): path keys are the RAW -z bytes exactly as git
  // emits them, with NO normalization — a non-ASCII name, and a case-variant pair (A.txt vs a.txt) built
  // via plumbing so the host filesystem's own case-folding can't interfere. ---
  {
    const nkRepo = path.join(os.tmpdir(), `loom-sglt-namekeys-${sfx}`);
    fs.mkdirSync(nkRepo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: nkRepo });
    const NK_ID = ["-c", "user.email=sglt@loom", "-c", "user.name=sglt"];
    const nkRaw = (args, input) => execFileSync("git", args, { cwd: nkRepo, input }).toString();
    const nkBlob = (content) => nkRaw(["hash-object", "-w", "--stdin"], content).trim();
    const nkTree = (entries) => {
      const env = { ...process.env, GIT_INDEX_FILE: path.join(os.tmpdir(), `loom-sglt-namekeys-idx-${sfx}-${Math.random()}`) };
      for (const [p, content] of entries) {
        execFileSync("git", ["-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${nkBlob(content)},${p}`], { cwd: nkRepo, env });
      }
      return execFileSync("git", ["write-tree"], { cwd: nkRepo, env }).toString().trim();
    };
    const nkCommit = (tree, parent, msg) => nkRaw([...NK_ID, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", msg]).trim();

    // Non-ASCII name: a genuine landing must still attribute (the -z stream carries raw UTF-8 bytes).
    const NONASCII_NAME = "café-1cf79e64.txt"; // café
    const nkBase = nkCommit(nkTree([["keep.txt", "k\n"]]), null, "base");
    const nkNonAsciiTip = nkCommit(nkTree([["keep.txt", "k\n"], [NONASCII_NAME, "n\n"]]), nkBase, "reviewedTip-nonascii");
    const nkNonAsciiGenuine = nkCommit(nkTree([["keep.txt", "k\n"], [NONASCII_NAME, "n\n"]]), nkBase, "genuine-nonascii");
    const nonAsciiResult = await recordedTipContentLanded(nkRepo, nkNonAsciiTip, nkNonAsciiGenuine, [NONASCII_NAME]);
    check("(path-key exactness) a non-ASCII stamped name attributes correctly — the raw UTF-8 bytes are the key, no quoting/escaping involved",
      nonAsciiResult === "attributed");
    const nkNonAsciiPartial = nkCommit(nkTree([["keep.txt", "k\n"]]), nkBase, "partial-nonascii"); // omits the non-ASCII file
    const nonAsciiOmissionResult = await recordedTipContentLanded(nkRepo, nkNonAsciiTip, nkNonAsciiPartial, [NONASCII_NAME]);
    check("(path-key exactness) a non-ASCII stamped name's genuine omission still escalates",
      nonAsciiOmissionResult === "no-match");

    // Case-variant pair: A.txt and a.txt as TWO DISTINCT tree entries (via plumbing — the real filesystem
    // on this host may be case-insensitive and would silently collapse them into one file on disk).
    const caseBase = nkCommit(nkTree([["keep.txt", "k\n"]]), null, "case-base");
    const caseReviewedTip = nkCommit(nkTree([["keep.txt", "k\n"], ["A.txt", "upper\n"], ["a.txt", "lower\n"]]), caseBase, "case-reviewedTip");
    // A genuine landing of BOTH distinct entries must attribute.
    const caseGenuine = nkCommit(nkTree([["keep.txt", "k\n"], ["A.txt", "upper\n"], ["a.txt", "lower\n"]]), caseBase, "case-genuine");
    const caseGenuineResult = await recordedTipContentLanded(nkRepo, caseReviewedTip, caseGenuine, ["A.txt", "a.txt"]);
    check("(path-key exactness) a case-variant pair (A.txt + a.txt) genuinely landing both attributes",
      caseGenuineResult === "attributed");
    // A candidate that only landed "a.txt" (the OTHER case) must NOT be mistaken for landing "A.txt" too —
    // if case were folded, this would wrongly read as a match for A.txt's own stamp entry.
    const caseOnlyLower = nkCommit(nkTree([["keep.txt", "k\n"], ["a.txt", "lower\n"]]), caseBase, "case-only-lower");
    const caseOnlyLowerResult = await recordedTipContentLanded(nkRepo, caseReviewedTip, caseOnlyLower, ["A.txt", "a.txt"]);
    check("(path-key exactness) a candidate landing only the lowercase variant does NOT satisfy the uppercase variant's own stamp entry — case is never folded",
      caseOnlyLowerResult === "no-match");

    try { fs.rmSync(nkRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // --- Direct proof (card 1cf79e64, manager condition 2): an empty stamp fails CLOSED, never a vacuous
  // "attributed" — the whole-stamp-vacuous shape is exactly F4b's class, just via an empty array instead
  // of an all-backslash one. ---
  {
    const efRepo = path.join(os.tmpdir(), `loom-sglt-emptyfiles-${sfx}`);
    fs.mkdirSync(efRepo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: efRepo });
    fs.writeFileSync(path.join(efRepo, "a.txt"), "a\n");
    commitAll(efRepo, "base", GIT_ID);
    const efTip = git(efRepo, "rev-parse HEAD");
    fs.writeFileSync(path.join(efRepo, "unrelated.txt"), "unrelated\n");
    commitAll(efRepo, "unrelated candidate", GIT_ID);
    const efUnrelatedCandidate = git(efRepo, "rev-parse HEAD");
    const emptyFilesResult = await recordedTipContentLanded(efRepo, efTip, efUnrelatedCandidate, []);
    check("(empty stamp) recordedTipContentLanded with files.length===0 fails closed to 'no-match', never a vacuous 'attributed'",
      emptyFilesResult === "no-match");
    try { fs.rmSync(efRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // --- Direct proof (card 05915fc7, round 2, Code Review B1 — adapted from the reviewer's own fixture at
  // C:\Users\danie\.loom\tmp\scratch\7b1fc7f6-e627-4eff-a7c9-e341be6e77f8\fx.mjs): every DEFINITIVE shape
  // the round-1 classification wrongly read as "transient" must now read as a definitive miss instead —
  // (a)/(b) a non-UTF-8 path anywhere in a candidate's tree, (c) a missing reviewedTip, (d1) a missing
  // candidate, (d2) a blob sha given where a tree-ish was expected — while (e) a genuine timeout against a
  // REAL, EXISTING, tree-ish object still reads "transient". ---
  {
    const bu2Repo = path.join(os.tmpdir(), `loom-sglt-b1-definitive-${sfx}`);
    fs.mkdirSync(bu2Repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: bu2Repo });
    fs.writeFileSync(path.join(bu2Repo, "a.txt"), "a\n");
    commitAll(bu2Repo, "base", GIT_ID);
    const bu2Base = git(bu2Repo, "rev-parse HEAD");
    fs.writeFileSync(path.join(bu2Repo, "a.txt"), "a2\n");
    commitAll(bu2Repo, "reviewed", GIT_ID);
    const bu2Reviewed = git(bu2Repo, "rev-parse HEAD");
    // (a)/(b): candidate matches reviewed's a.txt exactly, PLUS a non-UTF-8-named file planted via
    // plumbing (a worker can land exactly this) — `cand`'s own tree is poisoned WHOLE, not just at a.txt.
    const bu2Blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: bu2Repo, input: "x\n" }).toString().trim();
    execFileSync("git", ["update-index", "--index-info"], {
      cwd: bu2Repo,
      input: Buffer.concat([Buffer.from(`100644 ${bu2Blob}\t`), Buffer.from([0x63, 0x61, 0x66, 0xe9]), Buffer.from(".txt\n")]),
    });
    execFileSync("git", [...GIT_ID.split(" "), "commit", "-qm", "candidate with latin-1 name"], { cwd: bu2Repo });
    const bu2Cand = git(bu2Repo, "rev-parse HEAD");

    const bu2FteCand = await fullTreeEntries(bu2Repo, bu2Cand);
    check("(B1 a/b setup) fullTreeEntries(candidate) is STILL null — the poisoned-content mechanism itself is unchanged by this round",
      bu2FteCand === null);
    const bu2Content = await recordedTipContentLanded(bu2Repo, bu2Reviewed, bu2Cand, ["a.txt"]);
    check("(B1 a/b) recordedTipContentLanded against a candidate with a non-UTF-8-named file ANYWHERE in its tree is 'no-match' (DEFINITIVE), never 'transient' — the object itself exists and is tree-ish, cat-file -t confirms it",
      bu2Content === "no-match");

    // (c): reviewedTip is a sha that never resolves in this repo at all.
    const bu2MissingTip = "1".repeat(40);
    const bu2MissingTipContent = await recordedTipContentLanded(bu2Repo, bu2MissingTip, bu2Cand, ["a.txt"]);
    check("(B1 c) recordedTipContentLanded against a MISSING reviewedTip is 'no-match' (DEFINITIVE) — cat-file -t genuinely ran and reported it doesn't exist",
      bu2MissingTipContent === "no-match");

    // (d1): candidateSha is a sha that never resolves in this repo at all.
    const bu2MissingCand = "2".repeat(40);
    const bu2MissingCandContent = await recordedTipContentLanded(bu2Repo, bu2Reviewed, bu2MissingCand, ["a.txt"]);
    check("(B1 d1) recordedTipContentLanded against a MISSING candidate is 'no-match' (DEFINITIVE)",
      bu2MissingCandContent === "no-match");
    const bu2MissingCandPlausible = await stampedPathsPlausible(bu2Repo, bu2Reviewed, bu2MissingCand, ["a.txt"]);
    check("(B1 d1) stampedPathsPlausible against a MISSING otherSha is false (DEFINITIVE), never 'transient' — pre-checked before merge-base ever runs",
      bu2MissingCandPlausible === false);

    // (d2): a BLOB sha given where a tree-ish (commit) was expected — cat-file -t succeeds with type
    // "blob", which is deliberately NOT in TREE_ISH_TYPES.
    const bu2BlobContent = await recordedTipContentLanded(bu2Repo, bu2Reviewed, bu2Blob, ["a.txt"]);
    check("(B1 d2) recordedTipContentLanded against a BLOB sha (not tree-ish) is 'no-match' (DEFINITIVE)",
      bu2BlobContent === "no-match");
    const bu2BlobPlausible = await stampedPathsPlausible(bu2Repo, bu2Reviewed, bu2Blob, ["a.txt"]);
    check("(B1 d2) stampedPathsPlausible against a BLOB sha is false (DEFINITIVE)", bu2BlobPlausible === false);

    // (e) control: a genuine timeout against a REAL, EXISTING, tree-ish object still reads "transient" —
    // the pre-check succeeds (the object genuinely exists and is tree-ish), so the SUBSEQUENT failure is
    // anomalous, not a fact about the object. 1ms is far below what a real git ls-tree spawn can complete in.
    const bu2TimeoutContent = await recordedTipContentLanded(bu2Repo, bu2Reviewed, bu2Cand, ["a.txt"], { timeoutMs: 1 });
    check("(B1 e control) a genuine timeout against a real, existing, tree-ish object still reads 'transient', never 'no-match'",
      bu2TimeoutContent === "transient");

    try { fs.rmSync(bu2Repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // --- Direct proof (card 05915fc7, round 2, Code Review ruling 2): a PROCESS-LEVEL spawn failure (no
  // git exit code at all — ENOENT on the git binary) must read as TRANSIENT, never DEFINITIVE, even
  // against a real, existing, tree-ish object. Injected via the real `deps.gitFactory` seam with a real
  // simple-git instance pointed at a nonexistent binary — a REAL spawn failure, not a crafted message. ---
  {
    const spRepo = path.join(os.tmpdir(), `loom-sglt-spawnfail-${sfx}`);
    fs.mkdirSync(spRepo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: spRepo });
    fs.writeFileSync(path.join(spRepo, "a.txt"), "a\n");
    commitAll(spRepo, "base", GIT_ID);
    const spTip = git(spRepo, "rev-parse HEAD");
    fs.writeFileSync(path.join(spRepo, "a.txt"), "a2\n");
    commitAll(spRepo, "candidate", GIT_ID);
    const spCand = git(spRepo, "rev-parse HEAD");
    const badGitFactory = (repoPath, blockTimeoutMs) => simpleGit(repoPath, { binary: "loom-sglt-nonexistent-git-xyz", timeout: { block: blockTimeoutMs } });

    const spContent = await recordedTipContentLanded(spRepo, spTip, spCand, ["a.txt"], { gitFactory: badGitFactory, timeoutMs: 5000 });
    check("(spawn-failure) recordedTipContentLanded under a nonexistent git binary (a real ENOENT spawn failure) reads 'transient', never 'no-match'",
      spContent === "transient");
    const spPlausible = await stampedPathsPlausible(spRepo, spTip, spCand, ["a.txt"], { gitFactory: badGitFactory, timeoutMs: 5000 });
    check("(spawn-failure) stampedPathsPlausible under the same nonexistent git binary reads 'transient', never false",
      spPlausible === "transient");

    try { fs.rmSync(spRepo, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
} finally {
  console.warn = realWarn;
  registerCommondirTrustPinLookup(undefined); // never leave a test pin registered past this file's own run
  for (const dir of [R_FORGED, R_GENUINE, R_OVERLAP, R_LEGACY, R_FB_LANDEDTIP, R_FB_NOLANDEDTIP, R_ZERODELTA, R_REFMOVE, R_SCOPED, R_RENAME, R_REVERT, R_LAG]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS"
  : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
