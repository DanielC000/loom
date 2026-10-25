import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c13666c6 — the branch-gone trailer-only arm (verifyGoneBranchLanding, git/worktrees.ts) is gated
// against Loom's own mainline_landed_commits ledger via a DURABLE, branch-independent boundary (set once,
// write-if-absent, never updated — Db.resolveGoneBranchLedgerBoundary) plus a per-sha lookup, never a
// recency window over a pruned table (round 1's own defect — see
// docs/decisions/c13666c6-branch-gone-ledger-cutover-gate.md for the full design across all four rounds).
// Round 4: the PRE-LEDGER leg is a bare, unbounded ancestor check against the fixed boundary; the
// RECORDED leg matches sha against a candidate ledger row's OWN first-parent range (never refTip's),
// found via a bounded ancestry-path walk — so a genuinely Loom-landed commit later merged into the
// mainline via a real merge commit (MERGEIN-A/B/C, MERGEIN-BATCH, the extended NONLINEAR) still resolves,
// while a forged commit landed as a merge's second parent (MERGEFORGE) still does not.
//
// Run: 1) build daemon (pnpm build), 2) node test/branch-gone-ledger-cutover-gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { simpleGit } from "simple-git";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), `loom-no-such-codex-bin-${process.pid}`);
useOwnLoomHome("loom-gbl-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, findLandedSquashCommit, findLandedSquashCommitViaMap, GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP } = await import("../dist/git/worktrees.js");
const MW = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "gbl", GIT_AUTHOR_EMAIL: "gbl@loom", GIT_COMMITTER_NAME: "gbl", GIT_COMMITTER_EMAIL: "gbl@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=gbl@loom -c user.name=gbl";
const now = new Date().toISOString();
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

function makeRepo(sfx) {
  const repo = mkdtempManaged(`loom-gbl-repo-${sfx}-`);
  fs.writeFileSync(path.join(repo, "README.md"), "# gbl\n");
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.email", "gbl@loom"); git(repo, "config", "user.name", "gbl");
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function newProject(tag, repo) {
  const sfx = `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const projId = `gbl-proj-${sfx}`, agentId = `gbl-agent-${sfx}`, mgrId = `gbl-mgr-${sfx}`;
  const db = new Db();
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => ({ passed: true, steps: [] }), reapWorktreeProcesses: noReap });
  db.insertProject({ id: projId, name: `GBL-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
  return { db, sessions, projId, mgrId, agentId, sfx, repo };
}

let seq = 0;
async function addWorker(ctx, tag) {
  const n = `${tag}${++seq}`;
  const taskId = `gbl-${n}-task-${ctx.sfx}`, workerId = `gbl-${n}-wkr-${ctx.sfx}`;
  ctx.db.insertTask({ id: taskId, projectId: ctx.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(ctx.repo, ctx.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${n}.ts`), `export const ${n} = 1;\n`);
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  ctx.db.insertSession({ id: workerId, projectId: ctx.projId, agentId: ctx.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: ctx.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
const confirm = async (ctx, w) => ctx.sessions.confirmWorkerMergeTracked(ctx.mgrId, w.workerId);
// `expectedMainlineBranch` (confirmWorkerMerge's own watermark-branch resolution) is captured ONCE at the
// START of a confirm call, BEFORE that same call's own advanceMainlineWatermark establishes a watermark
// on true first sight — so the VERY FIRST landing for any (project, repoKey) never writes a
// mainline_landed_commits row (recordMainlineLedgerEntryIfRepoUnchanged's own gate requires expectedMainlineBranch
// truthy). Every scenario below that uses the real confirm flow needs a throwaway warm-up landing first.
async function warmup(ctx, tag) {
  const w = await addWorker(ctx, tag);
  const r = await confirm(ctx, w);
  check(`(${tag}) warm-up landing establishes the watermark (no ledger row expected from this one)`, r.settled === true && r.ok === true);
  return w;
}

// Forges a commit with a well-formed Loom-Worker-Branch trailer naming `branch` (no PathSet trailer — the
// weakest, trailer-presence-only tier), via raw `commit-tree`/`update-ref` — exactly the shape a racer
// with shared-.git write access (decision 356538ef) could produce, with NO real squash ever involved.
function forgeGoneBranchCommit(repo, parentSha, branch) {
  const tree = git(repo, "rev-parse", `${parentSha}^{tree}`);
  const forged = git(repo, "commit-tree", tree, "-p", parentSha, "-m", "feat(x): innocuous", "-m", `Loom-Worker-Branch: ${branch}`);
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", forged);
  return forged;
}

// Card c13666c6 round 3: builds a candidate commit (carrying `branch`'s trailer, parented on `rowBase`)
// plus `fillerCount` linear filler commits on top of it, landing `refs/heads/main` at the final tip — in
// ONE `git fast-import` call, never one git process per commit. A plain execFileSync loop over
// GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP+1 (20001) commit-tree spawns was measured on this host to cost
// multiple MINUTES; fast-import builds the identical linear chain (each filler reusing its parent's tree
// — no `M`/`deleteall` command, per git-fast-import(1)) in well under a second.
function buildChainCapFixture(repo, rowBase, branch, fillerCount) {
  const lines = [];
  const push = (ref, mark, msg, from) => {
    lines.push(`commit ${ref}`, `mark :${mark}`, `author fi <fi@loom> 1700000000 +0000`, `committer fi <fi@loom> 1700000000 +0000`,
      `data ${Buffer.byteLength(msg, "utf8")}`, msg, `from ${from}`, "");
  };
  push("refs/heads/main", 1, `feat(x): candidate\n\nLoom-Worker-Branch: ${branch}`, rowBase);
  for (let i = 0; i < fillerCount; i++) push("refs/heads/main", i + 2, `chore(x): filler ${i}`, `:${i + 1}`);
  execFileSync("git", ["fast-import", "--quiet"], { cwd: repo, input: lines.join("\n") + "\n", env: { ...process.env, ...IDENT }, stdio: ["pipe", "ignore", "pipe"] });
  return { candidate: git(repo, "rev-parse", `refs/heads/main~${fillerCount}`), refTip: git(repo, "rev-parse", "refs/heads/main") };
}

// Card c13666c6 round 3: appends `count` linear, trailer-less filler commits onto `onto`, landing
// `refs/heads/main` at the final tip — same ONE-`fast-import`-call shape as {@link buildChainCapFixture}.
function fastImportFillerChain(repo, onto, count, prefix) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    const msg = `${prefix} ${i}`;
    lines.push("commit refs/heads/main", `mark :${i + 1}`, "author fi <fi@loom> 1700000000 +0000", "committer fi <fi@loom> 1700000000 +0000",
      `data ${Buffer.byteLength(msg, "utf8")}`, msg, `from ${i === 0 ? onto : `:${i}`}`, "");
  }
  execFileSync("git", ["fast-import", "--quiet"], { cwd: repo, input: lines.join("\n") + "\n", env: { ...process.env, ...IDENT }, stdio: ["pipe", "ignore", "pipe"] });
  return git(repo, "rev-parse", "refs/heads/main");
}

const ledgerFor = (ctx) => ctx.db.getGoneBranchLedgerFacts(ctx.projId, "primary");

// @decision 6cf10d10 — mirrors the REAL writer's ledger chokepoint (Db.recordMainlineLandedCommit,
// db.ts ~4025), called from service.ts's recordMainlineLedgerEntryIfRepoUnchanged (service.ts ~24129) at
// exactly two real call sites: the solo squash (service.ts ~21386 — base=merge.landedBase, the VERIFIED
// pre-landing tip; tip=merge.sha, the VERIFIED squash commit) and the batch fast-forward (service.ts
// ~23006 — base=baseMainSha, the branch's pre-batch tip; tip=result.batchHeadSha, the chain's final
// landed commit). In BOTH real cases `base` is simply whatever tip was live before this landing, and
// `tip` is the real commit(s) chained on top of it by ordinary first-parent commits. This helper
// reproduces exactly that shape: builds `trailerBranches.length` real `git commit-tree` commits chained
// onto `onto` (one per candidate — a single-entry array is a solo landing; 2+ is a batch intermediate
// spanning several candidates). Round 2 CR (minor): this one-commit-per-candidate shape is a REACHABLE
// SUBSET of the real batch writer, never the general case — `landBranchCommitsIndividually` (batch-
// merge.ts ~706) trailers only each candidate's OWN LAST commit, and a single candidate can land SEVERAL
// commits (e.g. a multi-commit worker branch cherry-picked whole). This helper's shape matches the common
// case (one commit per candidate) exactly, but a scenario that needs a multi-commit-per-candidate row
// must build that chain by hand, not via this helper. Each commit carries its own well-formed `Loom-Worker-Branch: <name>` trailer
// (deliberately NO PathSet trailer — the WEAKER, pathset-absent tier; see the EQUIVALENCE CHECK scenario
// below for why that's sound: the ledger-gate code under test is tier-agnostic to PathSet, and the
// stronger pathset-present tier already has independent coverage elsewhere — merge-pathset-deleted-
// branch.mjs, merge-precommit-trailer-stamp.mjs, merge-trailer-shadowing.mjs, batch-merge.mjs,
// batch-merge-robustness.mjs), then calls `Db.recordMainlineLandedCommit` with that SAME (tip, base)
// semantics and moves `refs/heads/<refBranch>` to the resulting tip, exactly as a real landing's own ref
// update does. Returns each candidate's own sha plus the final tip, so a caller can reference an
// intra-batch candidate specifically (its own non-tip position), never just the batch's final tip.
function seedLedgerLanding(ctx, { onto, trailerBranches, refBranch = "main", repoKey = "primary" }) {
  const currentRefTip = git(ctx.repo, "rev-parse", `refs/heads/${refBranch}`);
  if (currentRefTip !== onto) throw new Error(`seedLedgerLanding: onto (${onto}) is not refs/heads/${refBranch}'s current tip (${currentRefTip}) — a caller passed a stale base`);
  const tree = git(ctx.repo, "rev-parse", `${onto}^{tree}`);
  const tips = [];
  let cur = onto;
  for (const branch of trailerBranches) {
    cur = git(ctx.repo, "commit-tree", tree, "-p", cur, "-m", "feat(x): synthetic landing", "-m", `Loom-Worker-Branch: ${branch}`);
    tips.push(cur);
  }
  ctx.db.recordMainlineLandedCommit(ctx.projId, repoKey, refBranch, cur, onto);
  git(ctx.repo, "update-ref", "-m", "commit: x", `refs/heads/${refBranch}`, cur);
  return { tips, finalTip: cur };
}

// Card 6cf10d10 — mirrors the real writer's own FIRST-ever-landing quirk (service.ts's
// recordMainlineLedgerEntryIfRepoUnchanged gates on `expectedMainlineBranch`, resolved BEFORE that same
// confirm call's own advanceMainlineWatermark establishes it — see `warmup`'s own comment above): moves
// `refs/heads/main` forward by ONE ordinary commit, deliberately WITHOUT a ledger row. Used wherever a
// converted scenario below previously called `warmup()` purely to reproduce this no-row-yet shape.
function seedWarmupAnalog(repo, onto, refBranch = "main") {
  const tip = git(repo, "commit-tree", git(repo, "rev-parse", `${onto}^{tree}`), "-p", onto, "-m", "chore(x): warmup (no ledger row)");
  git(repo, "update-ref", "-m", "commit: x", `refs/heads/${refBranch}`, tip);
  return tip;
}

// Card 6cf10d10 — same ONE-`fast-import`-call shape as {@link fastImportFillerChain}/
// {@link buildChainCapFixture} below, but each of the `count` commits carries its OWN
// `Loom-Worker-Branch: <branchFor(i)>` trailer (1-indexed) instead of being trailer-less filler — for a
// scenario that needs N individually grep-able landed commits (DEPTH, M2-REGRESSION, SPAWN-COUNT,
// MANY-UNRELATED-ROWS) without N separate `git commit-tree` spawns. Resolves every intermediate commit's
// own sha via ONE bounded `git rev-list --first-parent`, never N separate `rev-parse` spawns either.
function fastImportTrailerChain(repo, onto, count, branchFor) {
  const lines = [];
  for (let i = 1; i <= count; i++) {
    const msg = `feat(x): synthetic landing ${i}\n\nLoom-Worker-Branch: ${branchFor(i)}`;
    lines.push("commit refs/heads/main", `mark :${i}`, "author fi <fi@loom> 1700000000 +0000", "committer fi <fi@loom> 1700000000 +0000",
      `data ${Buffer.byteLength(msg, "utf8")}`, msg, `from ${i === 1 ? onto : `:${i - 1}`}`, "");
  }
  execFileSync("git", ["fast-import", "--quiet"], { cwd: repo, input: lines.join("\n") + "\n", env: { ...process.env, ...IDENT }, stdio: ["pipe", "ignore", "pipe"] });
  const finalTip = git(repo, "rev-parse", "refs/heads/main");
  const shas = git(repo, "rev-list", "--first-parent", `${onto}..${finalTip}`).split("\n").map((s) => s.trim()).filter(Boolean).reverse();
  if (shas.length !== count) throw new Error(`fastImportTrailerChain: built ${count} commits but rev-list resolved ${shas.length} — the walk is out of sync with what fast-import actually wrote`);
  return { tipAt: [onto, ...shas], finalTip };
}

// Card c13666c6 round 2, finding 7: a test-local implementation of the REJECTED "any-tip-ancestor" rule
// (never port this into real code) — real git, real logic, not just a bare merge-base assertion: is `sha`
// an ancestor of (or equal to) ANY row this scope has ever recorded? This is exactly what round 1's first
// draft proposed and the manager's round-1 ruling rejected, because it reopens the laundering case.
function rejectedAnyTipAncestorRule(repo, sha, rows) {
  return rows.some((r) => git(repo, "merge-base", sha, r.tip) === sha);
}

// ===================== PRE-LEDGER: a commit older than the first ledger row still reads merged ========
{
  const repo = makeRepo("preledger");
  // A "legacy" landing that predates the ledger entirely: a forged-shaped commit (no PathSet trailer,
  // same as pre-f621f185/pre-ledger history) naming a branch that is already gone. It sits BEFORE any
  // real ledger row, standing in for genuine pre-card history (this card's own fix cannot and must not
  // distinguish "truly legitimate old history" from "a forged commit planted before Loom ever recorded
  // anything" — see this card's decision record's named bootstrap residual).
  const c0 = git(repo, "rev-parse", "HEAD");
  const legacyTip = forgeGoneBranchCommit(repo, c0, "loom/legacy0000");
  const ctx = newProject("preledger", repo);

  const warmupTip = seedWarmupAnalog(repo, legacyTip); // establishes a later tip; writes no row of its own
  seedLedgerLanding(ctx, { onto: warmupTip, trailerBranches: ["loom/preledger-seed0000"] });
  const boundary = ledgerFor(ctx).resolveBoundary();
  check("(PRE-LEDGER) setup: the seeded landing establishes the durable boundary", boundary !== null);
  check("(PRE-LEDGER) setup: the legacy (pre-ledger) commit is an ancestor of (or equal to) the boundary", git(repo, "merge-base", legacyTip, boundary) === legacyTip);

  const found = await findLandedSquashCommit(repo, "loom/legacy0000", "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(PRE-LEDGER) a commit older than the first ledger row still reads merged (grandfathered)", found === legacyTip);
}

// ===================== POST-CUTOVER RECORDED: a genuinely-recorded commit still reads merged ===========
{
  const repo = makeRepo("recorded");
  const ctx = newProject("recorded", repo);
  await warmup(ctx, "RECORDED");
  const w0 = await addWorker(ctx, "b");
  const r0 = await confirm(ctx, w0);
  check("(RECORDED) setup: the landing succeeds", r0.settled === true && r0.ok === true);
  check("(RECORDED) setup: it genuinely established the boundary", ledgerFor(ctx).resolveBoundary() !== null);
  const t0 = git(repo, "rev-parse", "HEAD");
  check("(RECORDED) setup: w0's own worker branch is now gone (finalize deleted it)", git(repo, "branch", "--list", w0.branch) === "");

  const found = await findLandedSquashCommit(repo, w0.branch, "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(RECORDED) a genuinely-recorded landing's own tip still reads merged", found === t0);
}

// ===================== EQUIVALENCE CHECK (card 6cf10d10): seedLedgerLanding — used by every converted
//                        scenario below — writes through the SAME Db.recordMainlineLandedCommit entry
//                        point a real landing's own chokepoint calls (see that function's own doc for the
//                        file:line citations), with the SAME (tip, base, branch) semantics — `branch` is
//                        the MAINLINE branch landed onto ("main" here), never the individual worker's own
//                        branch name (measured directly: a real confirm's own row names "main", not the
//                        worker's branch — the worker's branch lives only in the commit's OWN trailer
//                        text, which `findLandedSquashCommit` greps for separately). A real confirm
//                        landing and the helper landing a parallel candidate on the SAME history produce
//                        rows EQUAL on project_id/repo_key/branch (same scope, same mainline branch) and
//                        DIFFERENT on tip/base/id (distinct commit shas + autoincrement, by construction
//                        — deterministically guaranteed, asserted below) — `landed_at` (wall-clock ms at
//                        insert) is named but left unasserted in EITHER direction: it is not guaranteed
//                        to differ for two inserts this close together, and is never meaningfully
//                        comparable regardless. Independently of row equality, BOTH rows are verified —
//                        via real git, never assumed — to satisfy the SAME writer invariant the ledger-
//                        gate's own soundness rests on (c13666c6's own "Do not" section): `base` is
//                        `tip`'s own first-parent ancestor. ===========================================
{
  const repo = makeRepo("equivcheck");
  const ctx = newProject("equivcheck", repo);

  await warmup(ctx, "EQUIV-CHECK");
  const wReal = await addWorker(ctx, "eqreal");
  const rReal = await confirm(ctx, wReal);
  check("(EQUIVALENCE CHECK) setup: the real landing succeeds", rReal.settled === true && rReal.ok === true);
  const rowSql = "SELECT id, project_id, repo_key, branch, tip, base, landed_at FROM mainline_landed_commits WHERE project_id = ? AND repo_key = ? ORDER BY id DESC LIMIT 1";
  const realRow = ctx.db.db.prepare(rowSql).get(ctx.projId, "primary");
  check("(EQUIVALENCE CHECK) setup: the real landing's own row was read back", realRow !== undefined);

  const SEEDED_BRANCH = "loom/equivcheck-seeded0000";
  const seeded = seedLedgerLanding(ctx, { onto: realRow.tip, trailerBranches: [SEEDED_BRANCH] });
  const seededRow = ctx.db.db.prepare(rowSql).get(ctx.projId, "primary");
  check("(EQUIVALENCE CHECK) setup: the seeded landing's own row was read back, and is a DIFFERENT row", seededRow !== undefined && seededRow.id !== realRow.id);

  check("(EQUIVALENCE CHECK) EQUAL: project_id is field-for-field equal between the real and seeded rows", seededRow.project_id === realRow.project_id);
  check("(EQUIVALENCE CHECK) EQUAL: repo_key is field-for-field equal between the real and seeded rows", seededRow.repo_key === realRow.repo_key);
  check("(EQUIVALENCE CHECK) EQUAL: branch (the MAINLINE branch landed onto, not the worker's own branch) is field-for-field equal", seededRow.branch === realRow.branch);

  // NAMED-DIFFERENT, never asserted equal (round 2 CR: the equality would be trivially true by
  // construction — the seeded row is a NEW row chained onto the real row's own tip, so tip/base/id differ
  // whether the writer is sound or not; dropped the check, kept the naming): tip/base/id are distinct
  // per-landing identifiers (commit shas, autoincrement). `landed_at` (wall-clock ms at insert) is also
  // never asserted equal, for the opposite reason — it is NOT guaranteed to differ for two inserts this
  // close together, and is never meaningfully comparable either way.

  check("(EQUIVALENCE CHECK) THE WRITER INVARIANT: the real row's base is its tip's own first-parent, verified via real git", git(repo, "rev-parse", `${realRow.tip}^`) === realRow.base);
  check("(EQUIVALENCE CHECK) THE WRITER INVARIANT: the seeded row satisfies the SAME invariant, verified via real git", git(repo, "rev-parse", `${seededRow.tip}^`) === seededRow.base);

  const found = await findLandedSquashCommit(repo, SEEDED_BRANCH, "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(EQUIVALENCE CHECK) READER EQUIVALENCE: the real reader resolves the seeded landing exactly like a real one", found === seeded.finalTip);
}

// ===================== LAUNDERING: a commit planted as a LATER row's own base reads NOT landed, even
//                        though it IS an ancestor of that row's (real, recorded) tip ====================
{
  const repo = makeRepo("launder");
  const ctx = newProject("launder", repo);
  await warmup(ctx, "LAUNDER");
  const w0 = await addWorker(ctx, "c");
  const r0 = await confirm(ctx, w0);
  check("(LAUNDER) setup: row0 lands", r0.settled === true && r0.ok === true && ledgerFor(ctx).resolveBoundary() !== null);
  const t0 = git(repo, "rev-parse", "HEAD");

  // A racer plants F directly on main, naming a gone branch. The VERY NEXT real landing then unavoidably
  // uses F as its own `base` — exactly the laundering shape this card's ranged rule closes.
  const forged = forgeGoneBranchCommit(repo, t0, "loom/forged0000");
  const w1 = await addWorker(ctx, "d");
  const r1 = await confirm(ctx, w1);
  check("(LAUNDER) setup: a real landing lands on top of the forged commit", r1.settled === true && r1.ok === true);
  const t1 = git(repo, "rev-parse", "HEAD");

  check("(LAUNDER) NEGATIVE CONTROL: the forged commit IS an ancestor of the real recorded tip — proving the REJECTED 'any-tip-ancestor' rule would have wrongly accepted it", git(repo, "merge-base", forged, t1) === forged);
  const rawRows = ctx.db.db.prepare("SELECT base, tip FROM mainline_landed_commits WHERE project_id = ? AND repo_key = ?").all(ctx.projId, "primary");
  check("(LAUNDER) FINDING 7: the REJECTED any-tip-ancestor rule's own REAL logic (test-local helper, real git) WOULD accept the forged commit", rejectedAnyTipAncestorRule(repo, forged, rawRows) === true);

  const found = await findLandedSquashCommit(repo, "loom/forged0000", "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(LAUNDER) THE FIX: the forged commit reads NOT landed under the actual half-open-range rule", found === null);
}

// ===================== WEDGED: a commit sitting in the GAP between two non-adjacent real rows (never
//                        itself a row's base) also reads NOT landed =====================================
{
  const repo = makeRepo("wedged");
  const ctx = newProject("wedged", repo);
  const warmupTip = seedWarmupAnalog(repo, git(repo, "rev-parse", "HEAD"));
  const seed0 = seedLedgerLanding(ctx, { onto: warmupTip, trailerBranches: ["loom/wedged-row0-0000"] });
  check("(WEDGED) setup: row0 lands", ledgerFor(ctx).resolveBoundary() !== null);
  const t0 = seed0.finalTip;

  forgeGoneBranchCommit(repo, t0, "loom/wedged0000");
  // An ordinary, non-Loom commit sits between the forged one and the NEXT real landing, so the forged
  // commit is neither row0's nor row1's own base — it is strictly INSIDE the gap between them.
  fs.writeFileSync(path.join(repo, "human.txt"), "x\n");
  commitAll(repo, "chore(x): an ordinary human commit", GIT_ID);
  const humanTip = git(repo, "rev-parse", "HEAD");
  const seed1 = seedLedgerLanding(ctx, { onto: humanTip, trailerBranches: ["loom/wedged-row1-0000"] });
  check("(WEDGED) setup: a second landing lands on top of the human commit", git(repo, "rev-parse", "refs/heads/main") === seed1.finalTip);

  const found = await findLandedSquashCommit(repo, "loom/wedged0000", "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(WEDGED) a commit wedged between two rows (never itself a row's base) reads NOT landed", found === null);
}

// ===================== CHAIN CAP: a sha..ref first-parent chain exceeding the scan cap fails closed =====
{
  const repo = makeRepo("chaincap");
  const rowBase = git(repo, "rev-parse", "HEAD");
  const CHAIN_BRANCH = "loom/chaincap0000";
  // GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP + 1 filler commits so the candidate..HEAD first-parent chain
  // exceeds the real, live cap (never a hardcoded copy of it — card c13666c6 round 3, same "point at
  // source, never restate" rule as CLAUDE.md's own). The candidate itself (carrying the trailer) sits at
  // the START of the chain — maximally far from HEAD.
  const { candidate, refTip } = buildChainCapFixture(repo, rowBase, CHAIN_BRANCH, GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP + 1);
  const chainLen = parseInt(git(repo, "rev-list", "--first-parent", "--count", `${candidate}..${refTip}`), 10);
  check("(CHAIN CAP) setup: the candidate..HEAD first-parent chain genuinely exceeds the cap", chainLen > GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP);

  const ctx = newProject("chaincap", repo);
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: refTip }));
  ctx.db.recordMainlineLandedCommit(ctx.projId, "primary", "main", refTip, rowBase);

  const found = await findLandedSquashCommit(repo, CHAIN_BRANCH, "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(CHAIN CAP) a candidate whose own chain to HEAD exceeds the scan cap reads NOT landed — fails closed, never walked", found === null);
}

// ===================== DEPTH: real landings 10/60/150/250 ROWS back all still read landed (no pruning,
//                        no recency window — directly re-proving M1 is closed) ============================
{
  const repo = makeRepo("depth");
  const c0 = git(repo, "rev-parse", "HEAD");
  const ctx = newProject("depth", repo);
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: c0 }));

  // 300 synthetic, SEQUENTIAL landings: each its own real commit (own Loom-Worker-Branch trailer, so
  // findLandedSquashCommit's own --grep lookup can find it by name) AND its own real ledger row — the
  // 300 commits built in ONE fast-import call (card 6cf10d10; was 300 individual `git commit-tree`
  // spawns, the dominant cost of this scenario), the rows still written via Db.recordMainlineLandedCommit
  // directly (no SessionService/confirm needed; round 1's wiring tests already proved the confirm-flow
  // plumbing works, and the EQUIVALENCE CHECK scenario proves this entry point matches it). `recordMainlineLandedCommit`
  // auto-seeds the durable boundary on the very first of these too.
  const N = 300;
  const { tipAt } = fastImportTrailerChain(repo, c0, N, (i) => `loom/depth${i}`);
  for (let i = 1; i <= N; i++) ctx.db.recordMainlineLandedCommit(ctx.projId, "primary", "main", tipAt[i], tipAt[i - 1]);

  for (const depth of [10, 60, 150, 250]) {
    const i = N - depth;
    const found = await findLandedSquashCommit(repo, `loom/depth${i}`, "HEAD", { goneBranchLedger: ledgerFor(ctx) });
    check(`(DEPTH) a real landing ${depth} rows back still reads landed`, found === tipAt[i]);
  }
}

// ===================== M2-REGRESSION: a wedged forgery stays refused even after 300 MORE real landings
//                        pile up on top of it (round 1's own defect, measured: refused at 71, accepted at
//                        260 — the durable boundary + no-pruning fix must never regress this) ============
{
  const repo = makeRepo("m2regress");
  const c0 = git(repo, "rev-parse", "HEAD");
  const tree = git(repo, "rev-parse", "HEAD^{tree}");
  const ctx = newProject("m2regress", repo);
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: c0 }));

  // One genuine early landing to establish the durable boundary BEFORE the wedged forgery, so the forgery
  // itself is never mistaken for pre-ledger history.
  const t1 = git(repo, "commit-tree", tree, "-p", c0, "-m", "feat(x): synthetic landing 1", "-m", "Loom-Worker-Branch: loom/m2-1");
  ctx.db.recordMainlineLandedCommit(ctx.projId, "primary", "main", t1, c0);

  const WEDGED_BRANCH = "loom/m2-wedged0000";
  const wedged = git(repo, "commit-tree", tree, "-p", t1, "-m", "feat(x): innocuous", "-m", `Loom-Worker-Branch: ${WEDGED_BRANCH}`);

  // 300 MORE synthetic landings pile up on top of the wedge — none of them ever cite the wedged commit as
  // their own `base` (each cites the PREVIOUS landing's tip), so the wedge is never itself a row's base,
  // and (unlike round 1) nothing ever prunes the row that anchors the durable boundary. Built in ONE
  // fast-import call (card 6cf10d10; was 299 individual `git commit-tree` spawns).
  const N = 300;
  const { tipAt } = fastImportTrailerChain(repo, wedged, N - 1, (k) => `loom/m2-${k + 1}`);
  for (let k = 1; k <= N - 1; k++) ctx.db.recordMainlineLandedCommit(ctx.projId, "primary", "main", tipAt[k], tipAt[k - 1]);

  const found = await findLandedSquashCommit(repo, WEDGED_BRANCH, "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(M2-REGRESSION) the wedged forgery stays refused after 300 further real landings pile up on top of it", found === null);
}

// ===================== FINDING 5: a branch created via a checkout to a fresh branch still has a gate,
//                        even though the project's mainline-watermark hasn't caught up to it ============
{
  const repo = makeRepo("finding5");
  const ctx = newProject("finding5", repo);
  const warmupTip = seedWarmupAnalog(repo, git(repo, "rev-parse", "HEAD"));
  seedLedgerLanding(ctx, { onto: warmupTip, trailerBranches: ["loom/finding5-seed0000"] });
  check("(FINDING-5) setup: a landing on main establishes the boundary", ledgerFor(ctx).resolveBoundary() !== null);
  const mainTip = git(repo, "rev-parse", "HEAD");
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: mainTip }));

  // A manager's `project_checkout_branch` onto a FRESH branch cut from main — this touches canonical
  // HEAD, but never the watermark (only a real landing's own advanceMainlineWatermark does that).
  git(repo, "checkout", "-q", "-b", "feature-x", mainTip);
  const freshBranchLandedTip = git(repo, "commit-tree", git(repo, "rev-parse", "HEAD^{tree}"), "-p", mainTip, "-m", "feat(x): landed on the fresh branch", "-m", "Loom-Worker-Branch: loom/freshbranch0000");
  ctx.db.recordMainlineLandedCommit(ctx.projId, "primary", "feature-x", freshBranchLandedTip, mainTip);
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/feature-x", freshBranchLandedTip);
  git(repo, "checkout", "-q", "feature-x");

  const watermarkBranch = JSON.parse(ctx.db.getMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"))).branch;
  check("(FINDING-5) setup: the watermark was set to \"main\" (stale by construction — the test never re-points it at feature-x)", watermarkBranch === "main");

  // getTaskMergedInfo-shaped callers always scan bare "HEAD" (now feature-x) — never the watermark branch.
  const found = await findLandedSquashCommit(repo, "loom/freshbranch0000", "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(FINDING-5) a landing on the fresh branch still reads landed, scanned via HEAD, despite the stale watermark naming a different branch", found === freshBranchLandedTip);
}

// ===================== SPAWN COUNT: the per-sha lookup's own git-call cost stays constant regardless of
//                        candidate age (directly re-proving the perf finding is closed, not just fast in
//                        wall-clock terms which a slow host could mask) ===================================
{
  const repo = makeRepo("spawncount");
  const c0 = git(repo, "rev-parse", "HEAD");
  const ctx = newProject("spawncount", repo);
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: c0 }));

  // Built in ONE fast-import call (card 6cf10d10; was 220 individual `git commit-tree` spawns).
  const N = 220;
  const { tipAt } = fastImportTrailerChain(repo, c0, N, (i) => `loom/sc${i}`);
  for (let i = 1; i <= N; i++) ctx.db.recordMainlineLandedCommit(ctx.projId, "primary", "main", tipAt[i], tipAt[i - 1]);

  // A counting-but-delegating gitFactory (every call still hits real git) — same pattern as
  // boot-reconcile-batch-lookup.mjs's own `countingPassthroughFactory`: plain `simpleGit`, never
  // `canonicalGit` (which would apply commondir-trust checks this plain temp repo was never set up for).
  function countingGitFactory(counterRef) {
    return (repoPath, blockTimeoutMs) => {
      const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
      return { raw: (args) => { counterRef.count++; return real.raw(args); } };
    };
  }

  async function spawnCountFor(depth) {
    const i = N - depth;
    const counter = { count: 0 };
    const facts = ledgerFor(ctx); // DB-side only — no git spawns
    const found = await findLandedSquashCommit(repo, `loom/sc${i}`, "HEAD", { goneBranchLedger: facts, gitFactory: countingGitFactory(counter) });
    if (found !== tipAt[i]) throw new Error(`spawnCountFor(${depth}): candidate did not resolve as landed (got ${found}, expected ${tipAt[i]})`);
    return counter.count;
  }

  const shallow = await spawnCountFor(10);
  const deep = await spawnCountFor(200);
  check(`(SPAWN COUNT) a shallow (10-rows-back) lookup costs a small, bounded number of git calls (got ${shallow})`, shallow > 0 && shallow <= 10);
  check(`(SPAWN COUNT) a deep (200-rows-back) lookup costs the SAME order of git calls as the shallow one (shallow=${shallow}, deep=${deep}) — not scaling with age`, Math.abs(deep - shallow) <= 2);
}

// ===================== MERGE-SHAPE FORGERY (round 3, Code Review CRITICAL): a forged commit F landed as
//                        a merge's SECOND parent must be refused, even though it IS an ancestor of the
//                        real tip and its own parent is a genuine past landing's tip ====================
{
  const repo = makeRepo("mergeforge");
  const ctx = newProject("mergeforge", repo);
  const warmupTip = seedWarmupAnalog(repo, git(repo, "rev-parse", "HEAD")); // establishes a later tip; writes no row
  const seed0 = seedLedgerLanding(ctx, { onto: warmupTip, trailerBranches: ["loom/mergeforge-seed0000"] });
  check("(MERGEFORGE) setup: a landing establishes the durable boundary", ledgerFor(ctx).resolveBoundary() !== null);
  const mainTip = seed0.finalTip; // stands in for "a genuine past landing's tip"

  const FORGE_BRANCH = "loom/forgedmerge0000";
  const tree = git(repo, "rev-parse", `${mainTip}^{tree}`);
  // F carries the trailer, parented directly on the genuine past landing's tip (the Code Review's own
  // exploit shape) — forgeGoneBranchCommit's own shape, but WITHOUT the ref move (F stays dangling here).
  const F = git(repo, "commit-tree", tree, "-p", mainTip, "-m", "feat(x): innocuous", "-m", `Loom-Worker-Branch: ${FORGE_BRANCH}`);
  // M: a merge commit whose FIRST parent is mainTip (M itself sits ON main's first-parent line) and whose
  // SECOND parent is F — F is reachable from main ONLY through M, never via a pure first-parent walk.
  const M = git(repo, "commit-tree", tree, "-p", mainTip, "-p", F, "-m", "merge(x): forged merge");
  git(repo, "update-ref", "-m", "merge", "refs/heads/main", M);

  // A landing lands on top of the forged merge, exactly like the Code Review's own reproduction.
  const seed1 = seedLedgerLanding(ctx, { onto: M, trailerBranches: ["loom/mergeforge-row1-0000"] });
  check("(MERGEFORGE) setup: a landing lands on top of the forged merge", git(repo, "merge-base", M, seed1.finalTip) === M);
  const finalTip = seed1.finalTip;

  check("(MERGEFORGE) NEGATIVE CONTROL: F IS an ancestor of the final tip — the pre-round-3 chain walk (which merely prepended sha, never confirming first-parent membership) would have reached it", git(repo, "merge-base", F, finalTip) === F);

  const found = await findLandedSquashCommit(repo, FORGE_BRANCH, "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(MERGEFORGE) THE FIX: F reads NOT landed — it sits off refTip's own first-parent line", found === null);
}

// ===================== HORIZON: a genuine landing followed by 2001 and by 6000 ordinary first-parent
//                        commits still reads landed (round 3's raised, honestly-stated cap) ==============
for (const fillerCount of [2001, 6000]) {
  const repo = makeRepo(`horizon${fillerCount}`);
  const c0 = git(repo, "rev-parse", "HEAD");
  const BRANCH = `loom/horizon${fillerCount}`;
  const tip0 = git(repo, "commit-tree", git(repo, "rev-parse", "HEAD^{tree}"), "-p", c0, "-m", "feat(x): synthetic landing", "-m", `Loom-Worker-Branch: ${BRANCH}`);
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", tip0);
  const ctx = newProject(`horizon${fillerCount}`, repo);
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: tip0 }));
  ctx.db.recordMainlineLandedCommit(ctx.projId, "primary", "main", tip0, c0);

  const buildT0 = Date.now();
  fastImportFillerChain(repo, tip0, fillerCount, "chore(x): ordinary human commit");
  console.log(`  (HORIZON ${fillerCount}) built ${fillerCount} filler commits in ${Date.now() - buildT0}ms`);

  const walkT0 = Date.now();
  const found = await findLandedSquashCommit(repo, BRANCH, "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  console.log(`  (HORIZON ${fillerCount}) the real chain-walk lookup itself took ${Date.now() - walkT0}ms`);
  check(`(HORIZON ${fillerCount}) a genuine landing ${fillerCount} ordinary commits back still reads landed`, found === tip0);
}

// ===================== REBIND: a rebind to an unrelated repo clears the OLD scope's ledger + boundary;
//                        a genuine landing in the NEW repo then reads landed on its own, fresh ledger ====
{
  const repoA = makeRepo("rebindA");
  const ctx = newProject("rebindA", repoA);
  const warmupA = seedWarmupAnalog(repoA, git(repoA, "rev-parse", "HEAD"));
  seedLedgerLanding(ctx, { onto: warmupA, trailerBranches: ["loom/rebindA-seed0000"] });
  check("(REBIND) setup: repoA gets a landing + boundary", ledgerFor(ctx).resolveBoundary() !== null);

  const repoB = makeRepo("rebindB");
  ctx.db.updateProject(ctx.projId, { repoPath: repoB });
  check("(REBIND) THE FIX: the OLD scope's boundary is cleared by the rebind", ledgerFor(ctx).resolveBoundary() === null);
  check("(REBIND) THE FIX: the OLD scope's ledger rows are cleared by the rebind", ledgerFor(ctx).maxRowId() === null);

  ctx.repo = repoB; // subsequent seeding operates on the NEW repo
  const warmupB = seedWarmupAnalog(repoB, git(repoB, "rev-parse", "HEAD")); // first landing in the new repo: a fresh watermark-shaped tip, no row
  const seedB = seedLedgerLanding(ctx, { onto: warmupB, trailerBranches: ["loom/rebindB-seed0000"] });
  check("(REBIND) setup: a second landing in the NEW repo writes a fresh row + boundary", ledgerFor(ctx).resolveBoundary() !== null);

  const found = await findLandedSquashCommit(repoB, "loom/rebindB-seed0000", "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(REBIND) a landing in the rebound repo reads landed against its OWN fresh ledger", found !== null && found === seedB.finalTip);
}

// ===================== BOUNDARY MISSING: a corrupted boundary sha logs distinctly, fails closed, and is
//                        NEVER cached — a later repair is retried, not refused forever =====================
{
  const repo = makeRepo("boundarymissing");
  const ctx = newProject("boundarymissing", repo);
  const BM_BRANCH = "loom/boundarymissing-seed0000";
  const warmupTip = seedWarmupAnalog(repo, git(repo, "rev-parse", "HEAD"));
  const seed0 = seedLedgerLanding(ctx, { onto: warmupTip, trailerBranches: [BM_BRANCH] });
  const realBoundary = ledgerFor(ctx).resolveBoundary();
  check("(BOUNDARY MISSING) setup: a landing establishes the boundary", realBoundary !== null);

  const BAD_SHA = "f".repeat(40);
  let boundaryReallyMissing = false;
  try { execFileSync("git", ["cat-file", "-e", BAD_SHA], { cwd: repo, stdio: "ignore" }); } catch { boundaryReallyMissing = true; }
  check("(BOUNDARY MISSING) setup: the planted sha genuinely does not resolve in this repo", boundaryReallyMissing);
  ctx.db.setMeta(MW.goneBranchLedgerBoundaryKey(ctx.projId, "primary"), BAD_SHA);

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  let found1;
  try {
    found1 = await findLandedSquashCommit(repo, BM_BRANCH, "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  } finally {
    console.warn = origWarn;
  }
  check("(BOUNDARY MISSING) a corrupted boundary fails closed (not landed)", found1 === null);
  check("(BOUNDARY MISSING) a DISTINCT log line names the boundary as the cause", warnings.some((w) => w.includes("no longer resolves in this repo")));

  // Repair, then a SECOND lookup must NOT be poisoned by a cached refusal from the corrupted attempt above.
  ctx.db.setMeta(MW.goneBranchLedgerBoundaryKey(ctx.projId, "primary"), realBoundary);
  const found2 = await findLandedSquashCommit(repo, BM_BRANCH, "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(BOUNDARY MISSING) NOT CACHED: after the repair, the same candidate now reads landed", found2 !== null && found2 === seed0.finalTip);
}

// ===================== TRANSIENT ERROR: an injected one-off merge-base failure fails closed but is
//                        NEVER cached — a second, clean lookup for the SAME candidate still resolves ======
{
  const repo = makeRepo("transient");
  const ctx = newProject("transient", repo);
  const TR_BRANCH = "loom/transient-row1-0000";
  const warmupTip = seedWarmupAnalog(repo, git(repo, "rev-parse", "HEAD"));
  const seed0 = seedLedgerLanding(ctx, { onto: warmupTip, trailerBranches: ["loom/transient-row0-0000"] });
  check("(TRANSIENT) setup: a landing establishes the boundary", ledgerFor(ctx).resolveBoundary() !== null);
  const seed1 = seedLedgerLanding(ctx, { onto: seed0.finalTip, trailerBranches: [TR_BRANCH] });
  check("(TRANSIENT) setup: a second landing writes its own recorded row", git(repo, "rev-parse", "refs/heads/main") === seed1.finalTip);

  function flakyOnceOnMergeBase() {
    let tripped = false;
    return (repoPath, blockTimeoutMs) => {
      const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
      return { raw: (args) => {
        if (!tripped && args[0] === "merge-base") { tripped = true; return Promise.reject(new Error("injected transient failure (test-only)")); }
        return real.raw(args);
      } };
    };
  }

  const found1 = await findLandedSquashCommit(repo, TR_BRANCH, "HEAD", { goneBranchLedger: ledgerFor(ctx), gitFactory: flakyOnceOnMergeBase() });
  check("(TRANSIENT) the injected failure fails closed (not landed) on the first attempt", found1 === null);

  const found2 = await findLandedSquashCommit(repo, TR_BRANCH, "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(TRANSIENT) NOT CACHED: a second, clean lookup for the SAME candidate now reads landed", found2 !== null && found2 === seed1.finalTip);
}

// ===================== PROJECT DELETION: deleting a project sweeps its branch-gone ledger boundary too
//                        (mainline_landed_commits rows were already swept pre-round-3; the boundary
//                        app_meta key was NOT) =============================================================
{
  const repo = makeRepo("deleteproj");
  const ctx = newProject("deleteproj", repo);
  const warmupTip = seedWarmupAnalog(repo, git(repo, "rev-parse", "HEAD"));
  seedLedgerLanding(ctx, { onto: warmupTip, trailerBranches: ["loom/deleteproj-seed0000"] });
  check("(DELETE PROJ) setup: a landing establishes the boundary", ledgerFor(ctx).resolveBoundary() !== null);
  const rowCountBefore = ctx.db.db.prepare("SELECT COUNT(*) as c FROM mainline_landed_commits WHERE project_id = ?").get(ctx.projId).c;
  check("(DELETE PROJ) setup: the scope genuinely has a ledger row", rowCountBefore > 0);

  ctx.db.deleteProject(ctx.projId);

  check("(DELETE PROJ) THE FIX: the boundary app_meta key is gone after deletion", ctx.db.getMeta(MW.goneBranchLedgerBoundaryKey(ctx.projId, "primary")) === undefined);
  const rowCountAfter = ctx.db.db.prepare("SELECT COUNT(*) as c FROM mainline_landed_commits WHERE project_id = ?").get(ctx.projId).c;
  check("(DELETE PROJ) the ledger rows are gone after deletion", rowCountAfter === 0);
}

// ===================== NON-LINEAR HISTORY: a real (non-forged) merge commit on main, with genuine
//                        landings before it, AFTER it, AND ON the merged-in side itself, all still read
//                        correctly (round 4 extends this with the merged-in-side landing) ================
{
  const repo = makeRepo("nonlinear");
  const ctx = newProject("nonlinear", repo);
  const warmupTip = seedWarmupAnalog(repo, git(repo, "rev-parse", "HEAD"));
  const seedA = seedLedgerLanding(ctx, { onto: warmupTip, trailerBranches: ["loom/nonlinear-A-0000"] });
  check("(NONLINEAR) setup: landing A establishes the boundary", ledgerFor(ctx).resolveBoundary() !== null);
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: seedA.finalTip }));

  // A genuine, non-forged merge: branch off, land a candidate ON the topic branch itself (round 4 —
  // mirrors an owner's `project_checkout_branch` onto "topic"), then merge --no-ff back into main.
  // main's first parent through the merge commit is the pre-merge tip (landing A's own tip); the topic
  // tip is the SECOND parent — the exact shape a legitimate, non-forged history merge takes.
  git(repo, "checkout", "-q", "-b", "topic");
  const topicBase = git(repo, "rev-parse", "HEAD");
  ctx.db.repointMainlineWatermark(ctx.projId, "primary", "topic", topicBase, ctx.mgrId);
  const seedTopic = seedLedgerLanding(ctx, { onto: topicBase, trailerBranches: ["loom/nonlinear-topic-0000"], refBranch: "topic" });
  check("(NONLINEAR) setup: a landing lands ON the topic branch before it's merged in", git(repo, "rev-parse", "refs/heads/topic") === seedTopic.finalTip);

  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge(x): integrate topic", "topic");
  const mergeTip = git(repo, "rev-parse", "HEAD");
  ctx.db.repointMainlineWatermark(ctx.projId, "primary", "main", mergeTip, ctx.mgrId);

  const seedB = seedLedgerLanding(ctx, { onto: mergeTip, trailerBranches: ["loom/nonlinear-B-0000"] });
  check("(NONLINEAR) setup: landing B lands on top of the genuine merge commit", git(repo, "rev-parse", "refs/heads/main") === seedB.finalTip);

  const foundA = await findLandedSquashCommit(repo, "loom/nonlinear-A-0000", "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(NONLINEAR) landing A (before the merge) still reads landed", foundA !== null && foundA === seedA.finalTip);
  const foundTopic = await findLandedSquashCommit(repo, "loom/nonlinear-topic-0000", "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(NONLINEAR) the landing that happened ON the merged-in topic branch also reads landed", foundTopic !== null && foundTopic === seedTopic.finalTip);
  const foundB = await findLandedSquashCommit(repo, "loom/nonlinear-B-0000", "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(NONLINEAR) landing B (after the merge) still reads landed", foundB !== null && foundB === seedB.finalTip);
}

// ===================== MERGEIN-A (round 4, Code Review probe4 A): the owner-sanctioned
//                        project_checkout_branch create:true flow — two real landings on a fresh "feat"
//                        branch, later merged into main with a real merge commit, both still read landed
//                        (via findLandedSquashCommit AND the merged map) ==================================
{
  const repo = makeRepo("mergeina");
  const ctx = newProject("mergeina", repo);
  const warmupTip = seedWarmupAnalog(repo, git(repo, "rev-parse", "HEAD"));
  const mainTipBeforeFeat = warmupTip;
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: mainTipBeforeFeat }));

  // Mirrors a manager's `project_checkout_branch create:true`: a fresh branch cut from the trusted tip,
  // the watermark re-pointed at it (Db.repointMainlineWatermark is that tool's own real DB call).
  git(repo, "checkout", "-q", "-b", "feat");
  ctx.db.repointMainlineWatermark(ctx.projId, "primary", "feat", mainTipBeforeFeat, ctx.mgrId);

  const seed1 = seedLedgerLanding(ctx, { onto: mainTipBeforeFeat, trailerBranches: ["loom/mergeinA-s1-0000"], refBranch: "feat" });
  check("(MERGEIN-A) setup: s1 lands on feat", git(repo, "rev-parse", "refs/heads/feat") === seed1.finalTip);
  const seed2 = seedLedgerLanding(ctx, { onto: seed1.finalTip, trailerBranches: ["loom/mergeinA-s2-0000"], refBranch: "feat" });
  check("(MERGEIN-A) setup: s2 lands on feat", git(repo, "rev-parse", "refs/heads/feat") === seed2.finalTip);

  // The owner merges feat into main with a real, non-fast-forward merge commit.
  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge(x): integrate feat", "feat");

  const found1 = await findLandedSquashCommit(repo, "loom/mergeinA-s1-0000", "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(MERGEIN-A) THE FIX: s1 (merged in via feat's second-parent path) reads landed", found1 !== null && found1 === seed1.finalTip);
  const found2 = await findLandedSquashCommit(repo, "loom/mergeinA-s2-0000", "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(MERGEIN-A) THE FIX: s2 (merged in via feat's second-parent path) reads landed", found2 !== null && found2 === seed2.finalTip);

  const viaMap1 = await findLandedSquashCommitViaMap(repo, "loom/mergeinA-s1-0000", "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(MERGEIN-A) merged map: s1 hit:true with a resolved sha", viaMap1.hit === true && viaMap1.sha !== null);
  const viaMap2 = await findLandedSquashCommitViaMap(repo, "loom/mergeinA-s2-0000", "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(MERGEIN-A) merged map: s2 hit:true with a resolved sha", viaMap2.hit === true && viaMap2.sha !== null);
}

// ===================== MERGEIN-BATCH (round 4): a batch landing's own INTERMEDIATE candidate, landed on
//                        a side branch later merged into main, still reads landed ==========================
{
  const repo = makeRepo("mergeinbatch");
  const ctx = newProject("mergeinbatch", repo);
  await warmup(ctx, "MERGEIN-BATCH");
  const mainTipBeforeFeat = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "feat");
  ctx.db.repointMainlineWatermark(ctx.projId, "primary", "feat", mainTipBeforeFeat, ctx.mgrId);

  const wa = await addWorker(ctx, "mba");
  const wb = await addWorker(ctx, "mbb");
  const rBatch = await ctx.sessions.mergeBatchTracked(ctx.mgrId, [wa.workerId, wb.workerId]);
  check("(MERGEIN-BATCH) setup: the batch lands both candidates on feat", rBatch.settled === true && rBatch.ok === true && rBatch.value?.landed?.length === 2);

  // Round 2 CR (minor): pin the REAL batch writer's own row shape — the ONE thing the EQUIVALENCE CHECK
  // scenario never covers (it's solo-only) and that seedLedgerLanding's own multi-candidate shape stands
  // in for elsewhere in this file (GENUINE INTERMEDIATE ABOVE CAP, DUPLICATE ROW OVERFLOW).
  const featTipAfterBatch = git(repo, "rev-parse", "refs/heads/feat");
  const batchRows = ctx.db.db.prepare("SELECT branch, base, tip FROM mainline_landed_commits WHERE project_id = ? AND repo_key = ?").all(ctx.projId, "primary");
  check("(MERGEIN-BATCH) THE BATCH-SHAPE EQUIVALENCE: the real batch writer wrote exactly ONE new ledger row", batchRows.length === 1);
  check("(MERGEIN-BATCH) THE BATCH-SHAPE EQUIVALENCE: that row's branch is \"feat\"", batchRows[0]?.branch === "feat");
  check("(MERGEIN-BATCH) THE BATCH-SHAPE EQUIVALENCE: that row's base is the main tip before feat", batchRows[0]?.base === mainTipBeforeFeat);
  check("(MERGEIN-BATCH) THE BATCH-SHAPE EQUIVALENCE: that row's tip is feat's own landed tip", batchRows[0]?.tip === featTipAfterBatch);
  check("(MERGEIN-BATCH) THE BATCH-SHAPE EQUIVALENCE: the row spans exactly 2 commits (one per candidate) — tip~2 is base", git(repo, "rev-parse", `${featTipAfterBatch}~2`) === mainTipBeforeFeat);

  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge(x): integrate feat", "feat");

  const foundA = await findLandedSquashCommit(repo, wa.branch, "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  const foundB = await findLandedSquashCommit(repo, wb.branch, "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(MERGEIN-BATCH) candidate A (batch intermediate, merged in via feat's second parent) reads landed", foundA !== null);
  check("(MERGEIN-BATCH) candidate B (batch final tip, merged in via feat's second parent) reads landed", foundB !== null);
  check("(MERGEIN-BATCH) the two candidates' own landed commits are genuinely distinct", foundA !== foundB);
}

// ===================== PRE-LEDGER-B (round 4, probe4 B): a genuine pre-ledger trailered commit merged
//                        into main's history via a SECOND parent still reads landed (grandfathered) =======
{
  const repo = makeRepo("pledgerb");
  const c0 = git(repo, "rev-parse", "HEAD");
  const LEGACY_BRANCH = "loom/pledgerb-legacy0000";
  const tree0 = git(repo, "rev-parse", `${c0}^{tree}`);
  const legacyTip = git(repo, "commit-tree", tree0, "-p", c0, "-m", "feat(x): legacy", "-m", `Loom-Worker-Branch: ${LEGACY_BRANCH}`);
  // M: a merge commit whose first parent is c0 (unchanged) and whose SECOND parent is the legacy commit —
  // a genuine pre-Loom history merge, never itself trailered or landed by Loom.
  const M = git(repo, "commit-tree", tree0, "-p", c0, "-p", legacyTip, "-m", "merge(x): integrate legacy history");
  git(repo, "update-ref", "-m", "merge", "refs/heads/main", M);

  const ctx = newProject("pledgerb", repo);
  const warmupTip = seedWarmupAnalog(repo, M); // first sight at M; writes no row
  seedLedgerLanding(ctx, { onto: warmupTip, trailerBranches: ["loom/pledgerb-seed0000"] });
  check("(PLEDGER-B) setup: a landing on top of M establishes the boundary", ledgerFor(ctx).resolveBoundary() !== null);
  const boundary = ledgerFor(ctx).resolveBoundary();
  check("(PLEDGER-B) setup: the legacy commit genuinely predates the boundary (reachable only via M's second parent)", boundary !== null && git(repo, "merge-base", legacyTip, boundary) === legacyTip);

  const found = await findLandedSquashCommit(repo, LEGACY_BRANCH, "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(PLEDGER-B) THE FIX: a genuine pre-ledger commit merged in via a second parent reads landed (grandfathered)", found === legacyTip);
}

// ===================== PRE-LEDGER-C (round 4, probe4 C): the pre-ledger leg is UNBOUNDED — a genuine
//                        pre-ledger commit still reads landed even past the recorded leg's own cap =========
{
  const repo = makeRepo("pledgerc");
  const c0 = git(repo, "rev-parse", "HEAD");
  const LEGACY_BRANCH = "loom/pledgerc-legacy0000";
  const tree0 = git(repo, "rev-parse", `${c0}^{tree}`);
  const legacyTip = git(repo, "commit-tree", tree0, "-p", c0, "-m", "feat(x): legacy", "-m", `Loom-Worker-Branch: ${LEGACY_BRANCH}`);
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", legacyTip);

  const ctx = newProject("pledgerc", repo);
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: legacyTip }));
  const t1 = git(repo, "commit-tree", tree0, "-p", legacyTip, "-m", "feat(x): synthetic landing 1", "-m", "Loom-Worker-Branch: loom/pledgerc-1");
  ctx.db.recordMainlineLandedCommit(ctx.projId, "primary", "main", t1, legacyTip);
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", t1);

  const boundary = ledgerFor(ctx).resolveBoundary();
  check("(PLEDGER-C) setup: the boundary is genuinely the legacy commit", boundary === legacyTip);

  const refTip = fastImportFillerChain(repo, t1, GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP + 1, "chore(x): ordinary human commit");
  const distance = parseInt(git(repo, "rev-list", "--count", `${legacyTip}..${refTip}`), 10);
  check("(PLEDGER-C) setup: the legacy..HEAD distance genuinely exceeds the recorded leg's own cap", distance > GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP);

  const found = await findLandedSquashCommit(repo, LEGACY_BRANCH, "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(PLEDGER-C) THE FIX: a pre-ledger commit beyond the cap still reads landed — the pre-ledger leg is UNBOUNDED", found === legacyTip);
}

// ===================== ERROR LOG RATE LIMIT (round 4): a repeatedly-failing lookup logs the error ONCE
//                        within the rate-limit window, but the VERDICT itself is never cached — a later
//                        clean lookup for the same candidate still resolves correctly =====================
{
  const repo = makeRepo("errorratelimit");
  const ctx = newProject("errorratelimit", repo);
  const ERL_BRANCH = "loom/errorratelimit-row1-0000";
  const warmupTip = seedWarmupAnalog(repo, git(repo, "rev-parse", "HEAD"));
  const seed0 = seedLedgerLanding(ctx, { onto: warmupTip, trailerBranches: ["loom/errorratelimit-row0-0000"] });
  check("(ERROR RATE LIMIT) setup: a landing establishes the boundary", ledgerFor(ctx).resolveBoundary() !== null);
  const seed1 = seedLedgerLanding(ctx, { onto: seed0.finalTip, trailerBranches: [ERL_BRANCH] });
  check("(ERROR RATE LIMIT) setup: a second landing writes its own recorded row", git(repo, "rev-parse", "refs/heads/main") === seed1.finalTip);

  function flakyAlwaysOnMergeBase() {
    return (repoPath, blockTimeoutMs) => {
      const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
      return { raw: (args) => {
        if (args[0] === "merge-base") return Promise.reject(new Error("injected transient failure (test-only, always)"));
        return real.raw(args);
      } };
    };
  }

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  let found1, found2;
  try {
    found1 = await findLandedSquashCommit(repo, ERL_BRANCH, "HEAD", { goneBranchLedger: ledgerFor(ctx), gitFactory: flakyAlwaysOnMergeBase() });
    found2 = await findLandedSquashCommit(repo, ERL_BRANCH, "HEAD", { goneBranchLedger: ledgerFor(ctx), gitFactory: flakyAlwaysOnMergeBase() });
  } finally {
    console.warn = origWarn;
  }
  check("(ERROR RATE LIMIT) both flaky attempts fail closed (not landed)", found1 === null && found2 === null);
  const ledgerWarnings = warnings.filter((w) => w.includes("card c13666c6 round 4"));
  check("(ERROR RATE LIMIT) the error is logged only ONCE across two back-to-back identical failures (rate-limited)", ledgerWarnings.length === 1);

  // NOT CACHED: a third, clean lookup (no flaky factory) must still resolve correctly.
  const found3 = await findLandedSquashCommit(repo, ERL_BRANCH, "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  check("(ERROR RATE LIMIT) NOT CACHED: a third, clean lookup still reads landed", found3 !== null && found3 === seed1.finalTip);
}

// ===================== UNBOUNDED TIP (round 5, minor 3): a solo landing whose OWN row-tip sits PAST the
//                        chain-scan cap still reads landed directly — the trivial tip match now runs
//                        BEFORE the capped ancestry-path walk, so it is no longer subject to that cap at
//                        all (the reviewer measured the pre-round-5 ordering reading a row-tip 20001
//                        commits back as NOT landed) ======================================================
{
  const repo = makeRepo("unboundedtip");
  const c0 = git(repo, "rev-parse", "HEAD");
  const BRANCH = "loom/unboundedtip0000";
  const tip0 = git(repo, "commit-tree", git(repo, "rev-parse", "HEAD^{tree}"), "-p", c0, "-m", "feat(x): synthetic landing", "-m", `Loom-Worker-Branch: ${BRANCH}`);
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", tip0);
  const ctx = newProject("unboundedtip", repo);
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: tip0 }));
  ctx.db.recordMainlineLandedCommit(ctx.projId, "primary", "main", tip0, c0);

  // GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP + 1 ordinary filler commits pile up AFTER tip0 — under the pre-round-5
  // ordering (the direct tip check sat INSIDE the capped walk's own candidate list), this distance alone
  // would have overflowed the cap and returned "unrecorded" before ever checking tip0 directly. Round 5
  // moves the direct check BEFORE the walk, so tip0's own distance from refTip no longer matters at all.
  const refTip = fastImportFillerChain(repo, tip0, GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP + 1, "chore(x): ordinary human commit");
  const distance = parseInt(git(repo, "rev-list", "--count", `${tip0}..${refTip}`), 10);
  check("(UNBOUNDED TIP) setup: tip0's own distance from refTip genuinely exceeds the chain-scan cap", distance > GONE_BRANCH_LEDGER_CHAIN_SCAN_CAP);

  function countingGitFactory(counterRef) {
    return (repoPath, blockTimeoutMs) => {
      const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
      return { raw: (args) => { counterRef.count++; return real.raw(args); } };
    };
  }
  const counter = { count: 0 };
  const found = await findLandedSquashCommit(repo, BRANCH, "HEAD", { goneBranchLedger: ledgerFor(ctx), gitFactory: countingGitFactory(counter) });
  check("(UNBOUNDED TIP) THE FIX: a solo row-tip past the chain-scan cap still reads landed directly", found === tip0);
  check(`(UNBOUNDED TIP) the direct tip match costs a small, bounded number of git calls (got ${counter.count}), never scaling with the cap-exceeding distance`, counter.count > 0 && counter.count <= 10);
}

// ===================== MANY UNRELATED ROWS (round 5, fix 1; RENAMED round 6 — see below): a genuinely
//                        UNRECORDED candidate facing hundreds of candidate ledger rows still resolves
//                        quickly — every one of those rows' own `base` is either the candidate itself or a
//                        descendant of it, so round 5's zero-spawn prune rules ALL of them out before any
//                        per-row git spawn (the old per-row-scan shape measured 11.6s/64.8s at 200/1000
//                        rows for exactly this case).
//                        ⚠️ THIS SCENARIO DOES NOT PROVE THE PRUNE IS LOAD-BEARING (fifth Code Review
//                        finding, round 6): a genuinely unrecorded candidate has ZERO survivors whether or
//                        not the prune runs (every one of these 300 rows ALSO exceeds the row-spawn cap on
//                        its own, via the SAME overflow path, with the prune deleted entirely) — it only
//                        proves a correct, fast `null` answer against many rows. `GENUINE INTERMEDIATE
//                        ABOVE CAP` (below) is the scenario that actually depends on the prune. ===========
{
  const repo = makeRepo("rowprune");
  const c0 = git(repo, "rev-parse", "HEAD");
  const tree = git(repo, "rev-parse", "HEAD^{tree}");
  const ctx = newProject("rowprune", repo);
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: c0 }));

  // One genuine early landing establishes the durable boundary.
  const t1 = git(repo, "commit-tree", tree, "-p", c0, "-m", "feat(x): synthetic landing 1", "-m", "Loom-Worker-Branch: loom/rp-1");
  ctx.db.recordMainlineLandedCommit(ctx.projId, "primary", "main", t1, c0);

  // A wedged, NEVER-recorded candidate (carries a trailer for a branch no row ever names) sitting directly
  // on top of the one real row above.
  const WEDGED_BRANCH = "loom/rp-wedged0000";
  const wedged = git(repo, "commit-tree", tree, "-p", t1, "-m", "feat(x): innocuous", "-m", `Loom-Worker-Branch: ${WEDGED_BRANCH}`);

  // 300 MORE real, sequential landings pile up on top of the wedge. Every one of their own rows has a
  // `base` that is either the wedge itself (the very first of these) or a later landed tip — i.e. a
  // DESCENDANT of the wedge in every case — so round 5's zero-spawn prune should rule out all 300 without
  // a single per-row membership spawn. Built in ONE fast-import call (card 6cf10d10; was 300 individual
  // `git commit-tree` spawns).
  const N = 300;
  const { tipAt } = fastImportTrailerChain(repo, wedged, N, (i) => `loom/rp-${i + 1}`);
  for (let i = 1; i <= N; i++) ctx.db.recordMainlineLandedCommit(ctx.projId, "primary", "main", tipAt[i], tipAt[i - 1]);

  function countingGitFactory(counterRef) {
    return (repoPath, blockTimeoutMs) => {
      const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
      return { raw: (args) => { counterRef.count++; return real.raw(args); } };
    };
  }
  const counter = { count: 0 };
  const found = await findLandedSquashCommit(repo, WEDGED_BRANCH, "HEAD", { goneBranchLedger: ledgerFor(ctx), gitFactory: countingGitFactory(counter) });
  check("(MANY UNRELATED ROWS) the wedged, never-recorded candidate still correctly reads NOT landed", found === null);
  check(`(MANY UNRELATED ROWS) resolving it against ${N} candidate rows costs a small, bounded number of git calls (got ${counter.count}), never one spawn per row`, counter.count > 0 && counter.count <= 15);
}

// ===================== GENUINE INTERMEDIATE ABOVE CAP (round 6, 5th Code Review BLOCKING gap): a genuine
//                        batch-intermediate candidate, with 8 MORE unrelated real rows piled on after it —
//                        including a second genuine merged-in side batch (mirroring the reviewer's own
//                        probe P6 shape, not just ordinary sequential commits) — still reads landed on a
//                        single spawn, because the round-5 prune reduces the 9 candidate rows down to the
//                        ONE that genuinely contains it. This is the scenario that actually depends on the
//                        prune (unlike MANY UNRELATED ROWS above) — proven via a temporary, reverted local
//                        mutation of the prune's own filter (see the worker report for the RED/GREEN proof;
//                        the mutation itself is never part of this committed file) ========================
{
  const repo = makeRepo("intabovecap");
  const ctx = newProject("intabovecap", repo);
  const warmupTip = seedWarmupAnalog(repo, git(repo, "rev-parse", "HEAD"));
  const mainTipBeforeFeat = warmupTip;
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: mainTipBeforeFeat }));

  // The genuine intermediate: the FIRST of a two-candidate batch landed on a fresh "feat" branch — the
  // same shape as MERGEIN-BATCH. Its own ledger row covers [a, b] as ONE row (base=mainTipBeforeFeat,
  // tip=b's own landed tip); the FIRST candidate is never a row.tip, so resolving it needs the full
  // per-row walk.
  const IAC_A = "loom/iac-a-0000";
  git(repo, "checkout", "-q", "-b", "feat");
  ctx.db.repointMainlineWatermark(ctx.projId, "primary", "feat", mainTipBeforeFeat, ctx.mgrId);
  const batch1 = seedLedgerLanding(ctx, { onto: mainTipBeforeFeat, trailerBranches: [IAC_A, "loom/iac-b-0000"], refBranch: "feat" });
  check("(INT ABOVE CAP) setup: the first batch lands both candidates on feat", batch1.tips.length === 2);

  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge(x): integrate feat", "feat");
  const mergeTip1 = git(repo, "rev-parse", "HEAD");
  ctx.db.repointMainlineWatermark(ctx.projId, "primary", "main", mergeTip1, ctx.mgrId);

  // ONE more genuine merged-in side batch (probe P6's own shape) — its own row's `base` (mergeTip1) is
  // itself a descendant of candidate A, so round 5's prune rules it out without a spawn.
  git(repo, "checkout", "-q", "-b", "feat2");
  ctx.db.repointMainlineWatermark(ctx.projId, "primary", "feat2", mergeTip1, ctx.mgrId);
  const batch2 = seedLedgerLanding(ctx, { onto: mergeTip1, trailerBranches: ["loom/iac-c-0000", "loom/iac-d-0000"], refBranch: "feat2" });
  check("(INT ABOVE CAP) setup: the second batch lands both candidates on feat2", batch2.tips.length === 2);

  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge(x): integrate feat2", "feat2");
  const mergeTip2 = git(repo, "rev-parse", "HEAD");
  ctx.db.repointMainlineWatermark(ctx.projId, "primary", "main", mergeTip2, ctx.mgrId);

  // 7 MORE cheap, ordinary sequential landings directly on main — pads the candidate-row count up to
  // 9 total (the one genuine containing row above, plus 8 unrelated ones) without 7 more real merges.
  const tree = git(repo, "rev-parse", "HEAD^{tree}");
  let cur = mergeTip2;
  for (let i = 1; i <= 7; i++) {
    const tip = git(repo, "commit-tree", tree, "-p", cur, "-m", `feat(x): synthetic landing ${i}`, "-m", `Loom-Worker-Branch: loom/iac-seq${i}`);
    ctx.db.recordMainlineLandedCommit(ctx.projId, "primary", "main", tip, cur);
    cur = tip;
  }
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", cur);

  const rowCount = ctx.db.db.prepare("SELECT COUNT(*) as c FROM mainline_landed_commits WHERE project_id = ? AND repo_key = ?").get(ctx.projId, "primary").c;
  check(`(INT ABOVE CAP) setup: exactly 9 real ledger rows exist for this scope (got ${rowCount})`, rowCount === 9);

  function countingGitFactory(counterRef) {
    return (repoPath, blockTimeoutMs) => {
      const real = simpleGit(repoPath, { timeout: { block: blockTimeoutMs } });
      return { raw: (args) => { counterRef.count++; return real.raw(args); } };
    };
  }
  const counter = { count: 0 };
  const found = await findLandedSquashCommit(repo, IAC_A, "HEAD", { goneBranchLedger: ledgerFor(ctx), gitFactory: countingGitFactory(counter) });
  check("(INT ABOVE CAP) THE FIX: the genuine intermediate candidate still reads landed with 8 unrelated rows piled on top of it", found !== null && found === batch1.tips[0]);
  check(`(INT ABOVE CAP) resolving it costs a small, bounded number of git calls (got ${counter.count}) — the prune reduced 9 candidate rows to the ONE genuine survivor`, counter.count > 0 && counter.count <= 15);
}

// ===================== DUPLICATE ROW OVERFLOW (round 6, item 1(b)): the row-spawn cap's OWN pin, on the
//                        pathological ledger shape it actually exists for — the SAME real landing recorded
//                        9 times (a shape no real writer can ever produce; recordMainlineLandedCommit is
//                        called ONCE per confirmed batch) makes a genuinely-landed candidate read NOT
//                        landed. Asserts the overflow logs exactly ONCE across two back-to-back identical
//                        lookups — the second is served from the memoized verdict cache, never
//                        re-invoking the classifier at all — proving BOTH "logged once" and "memoized" in
//                        one assertion ==========================================================================
{
  const repo = makeRepo("duprow");
  const ctx = newProject("duprow", repo);
  const DR_A = "loom/dr-a-0000";
  const warmupTip = seedWarmupAnalog(repo, git(repo, "rev-parse", "HEAD"));
  const mainTipBeforeFeat = warmupTip;
  ctx.db.setMeta(MW.mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: mainTipBeforeFeat }));

  git(repo, "checkout", "-q", "-b", "feat");
  ctx.db.repointMainlineWatermark(ctx.projId, "primary", "feat", mainTipBeforeFeat, ctx.mgrId);
  const batch = seedLedgerLanding(ctx, { onto: mainTipBeforeFeat, trailerBranches: [DR_A, "loom/dr-b-0000"], refBranch: "feat" });
  check("(DUP ROW) setup: the batch lands both candidates on feat", batch.tips.length === 2);

  git(repo, "checkout", "-q", "main");
  git(repo, "merge", "-q", "--no-ff", "-m", "merge(x): integrate feat", "feat");
  const mergeTip = git(repo, "rev-parse", "HEAD");
  ctx.db.repointMainlineWatermark(ctx.projId, "primary", "main", mergeTip, ctx.mgrId);

  // The ONE row the seeded batch just wrote (round 2 CR: not a "real" row — this scenario was converted
  // off confirmWorkerMergeTracked/mergeBatchTracked, see card 6cf10d10's own record), duplicated 8 MORE
  // times — a shape no real writer can ever produce, standing in for a hypothetical writer-invariant
  // violation. All 9 copies genuinely contain candidate A; none is prunable (same base/tip for all 9).
  const seededRow = ctx.db.db.prepare("SELECT base, tip FROM mainline_landed_commits WHERE project_id = ? AND repo_key = ?").get(ctx.projId, "primary");
  check("(DUP ROW) setup: the seeded row's own base/tip were read back", typeof seededRow?.base === "string" && typeof seededRow?.tip === "string");
  for (let i = 0; i < 8; i++) {
    ctx.db.recordMainlineLandedCommit(ctx.projId, "primary", "main", seededRow.tip, seededRow.base);
  }
  const rowCount = ctx.db.db.prepare("SELECT COUNT(*) as c FROM mainline_landed_commits WHERE project_id = ? AND repo_key = ?").get(ctx.projId, "primary").c;
  check(`(DUP ROW) setup: 9 identical rows now exist for this one landing (got ${rowCount})`, rowCount === 9);

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); };
  let found1, found2;
  try {
    found1 = await findLandedSquashCommit(repo, DR_A, "HEAD", { goneBranchLedger: ledgerFor(ctx) });
    found2 = await findLandedSquashCommit(repo, DR_A, "HEAD", { goneBranchLedger: ledgerFor(ctx) });
  } finally {
    console.warn = origWarn;
  }
  check("(DUP ROW) THE CAP: 9 genuinely-containing duplicate rows overflow the spawn cap — a real landing reads NOT landed (the cap's own, accepted availability cost on this pathological shape)", found1 === null && found2 === null);
  const overflowWarnings = warnings.filter((w) => w.includes("row spawn cap"));
  check(`(DUP ROW) the overflow is logged exactly ONCE across two back-to-back identical lookups (got ${overflowWarnings.length}) — proving BOTH "logged once" and "memoized" together`, overflowWarnings.length === 1);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
