import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// THE CANONICAL MERGE PATH MUST NOT TRUST WORKER-WRITABLE SHARED .git STATE (card 356538ef; reviewer scenarios S11/S12).
// A worker's worktree shares the canonical repo's common `.git`: config, `info/attributes`, `refs/replace/*`.
//  - S12: a worker-set `merge.<x>.driver` + `info/attributes` made the DAEMON exec a worker-chosen command during
//    merge / merge-tree / cherry-pick. Proven here by a MARK file the driver would create — it must NOT exist.
//  - S11: `git replace <reviewed-tip> <evil>` left the tip unchanged (every sha-keyed check passed) while the canonical
//    `merge --squash` staged the REPLACEMENT's content. The landed content must be the real tip's.
// Fixtures are REAL git repos/worktrees driven through the real SessionService (solo confirm + merge_batch), the real
// mergeMainIntoWorktree and verifyReviewedTipChain, and the real canonicalGit. Every scenario carries a POSITIVE
// CONTROL: the same fixture through a bare `git` DOES run the driver / DOES see the replacement, so a green here can fail.
// Run: 1) pnpm build, 2) node packages/daemon/test/canonical-git-isolation.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-cgi-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-cgi-no-such-codex-bin");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, mergeMainIntoWorktree, verifyReviewedTipChain } = await import("../dist/git/worktrees.js");
const { assembleBatchBranches } = await import("../dist/git/batch-merge.js");
const { boundedSimpleGit, CANONICAL_GIT_CONFIG, canonicalGit, CANONICAL_GIT_CONFIG_ARGS, gitSubcommand, canRunMergeDriver, assertNoLiveMergeDrivers, describeGitFailure, CanonicalGitRefusal, canonicalRaw } = await import("../dist/git/bounded.js");

const GIT_ID = "-c user.email=cgi@loom -c user.name=cgi";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const dbs = [];
const BASE = "a\nb\nc\nd\ne\n";

// A driver script that records that it RAN by creating `mark`, and exits 0 leaving %A untouched (i.e. it would also
// silently launder content). Invoked as `node "<script>" %A`.
function driverFor(tag) {
  const mark = path.join(os.tmpdir(), `loom-cgi-MARK-${tag}-${sfx}`);
  const script = path.join(os.tmpdir(), `loom-cgi-driver-${tag}-${sfx}.mjs`);
  registerForCleanup(mark); registerForCleanup(script);
  fs.writeFileSync(script, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(mark)}, "ran"); process.exit(0);\n`);
  return { mark, cmd: `node "${script.replace(/\\/g, "/")}" %A` };
}

// kind: "config" (shared repo config) | "include" (via include.path) | "worktree" (config.worktree of `wt`).
function plantDriver(repo, wt, kind, cmd, tag) {
  // "eqname": the driver NAME contains `=` (`merge.a=b.driver`), which a `-c merge.a=b.driver=` blanking would mis-split at the first `=`.
  // "empty": the driver name is "" (`[merge ""]`, attribute `merge=`) — `merge..driver`. "rawbyte": the name is the single non-UTF-8 byte 0xE9, written as RAW BYTES
  // to both .git/config and info/attributes (`git config` can't); simple-git decodes it as U+FFFD, a DIFFERENT key than the one git selects.
  const attrs = path.join(repo, ".git", "info", "attributes");
  const cfgQuoted = `"${cmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (kind === "rawbyte") {
    fs.appendFileSync(attrs, Buffer.concat([Buffer.from("f.txt merge="), Buffer.from([0xe9]), Buffer.from("\n")]));
    fs.appendFileSync(path.join(repo, ".git", "config"), Buffer.concat([Buffer.from('[merge "'), Buffer.from([0xe9]), Buffer.from(`"]\n\tdriver = ${cfgQuoted}\n`)]));
    return;
  }
  if (kind === "empty") {
    fs.appendFileSync(attrs, "f.txt merge=\n");
    fs.appendFileSync(path.join(repo, ".git", "config"), `[merge ""]\n\tdriver = ${cfgQuoted}\n`);
    return;
  }
  fs.appendFileSync(attrs, kind === "eqname" ? "f.txt merge=a=b\n" : "f.txt merge=evil\n");
  if (kind === "config") {
    git(repo, `config merge.evil.driver ${JSON.stringify(cmd)}`);
  } else if (kind === "include") {
    const inc = path.join(os.tmpdir(), `loom-cgi-include-${tag}-${sfx}.inc`);
    registerForCleanup(inc);
    fs.writeFileSync(inc, `[merge "evil"]\n\tdriver = ${cmd}\n`);
    git(repo, `config include.path ${JSON.stringify(inc.replace(/\\/g, "/"))}`);
  } else if (kind === "eqname") {
    git(repo, `config "merge.a=b.driver" ${JSON.stringify(cmd)}`);
  } else if (kind === "worktree") {
    git(repo, "config extensions.worktreeConfig true");
    git(wt, `config --worktree merge.evil.driver ${JSON.stringify(cmd)}`);
  }
}

async function world(tag, opts = {}) {
  const repo = path.join(os.tmpdir(), `loom-cgi-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# cgi\n");
  fs.writeFileSync(path.join(repo, "f.txt"), BASE);
  execSync(`git init -q && git config user.email cgi@loom && git config user.name cgi`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const projId = `cgi-proj-${tag}-${sfx}`, agentId = `cgi-agent-${tag}-${sfx}`, mgrId = `cgi-mgr-${tag}-${sfx}`;
  const script = path.join(os.tmpdir(), `loom-cgi-gate-${tag}-${sfx}.mjs`);
  registerForCleanup(script);
  fs.writeFileSync(script, "process.exit(0);\n");
  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: `CGI-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node "${script}"` } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000 });
  const w = {};
  for (const label of opts.labels ?? ["a"]) {
    const taskId = `cgi-task-${tag}-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    // The worker edits line 2 of f.txt (the file the planted driver is attached to) and adds its own file.
    fs.writeFileSync(path.join(worktreePath, "f.txt"), BASE.replace("b\n", `B-${label}\n`));
    fs.writeFileSync(path.join(worktreePath, `feature-${label}.txt`), `work ${label}\n`);
    commitAll(worktreePath, `feat(test): ${label}`, GIT_ID);
    const sid = `cgi-wkr-${tag}-${label}-${sfx}`;
    db.insertTask({ id: taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: sid, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
    w[label] = { sid, taskId, worktreePath, branch };
  }
  return { repo, db, sessions, mgrId, projId, w };
}
const advanceMainF = (repo) => { fs.writeFileSync(path.join(repo, "f.txt"), BASE.replace("d\n", "D-main\n")); commitAll(repo, "chore(test): main edits f.txt line 4", GIT_ID); };
const settled = async (p) => { const r = await p; return r.settled && r.ok ? r.value : undefined; };
const exists = (p) => fs.existsSync(p);

// ── (S12-solo) driver in shared config: bare git RUNS it (control); the daemon's solo confirm must NOT.
for (const kind of ["config", "include", "worktree", "eqname", "empty", "rawbyte"]) {
  const tag = `solo-${kind}`;
  const W = await world(tag);
  const { mark, cmd } = driverFor(tag);
  advanceMainF(W.repo);
  plantDriver(W.repo, W.w.a.worktreePath, kind, cmd, tag);
  // POSITIVE CONTROL: a bare `git merge` of main into the worker worktree runs the driver on this exact fixture.
  execSync(`git ${GIT_ID} merge --no-edit ${git(W.repo, "rev-parse HEAD")}`, { cwd: W.w.a.worktreePath, stdio: "ignore" });
  const controlRan = exists(mark);
  fs.rmSync(mark, { force: true });
  execSync("git reset -q --hard HEAD~1", { cwd: W.w.a.worktreePath, stdio: "ignore" }); // undo the control merge; the worktree is back at the worker commit
  check(`(S12 solo/${kind}) CONTROL: a bare git merge on this fixture DOES exec the planted driver`, controlRan);
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  const r = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  check(`(S12 solo/${kind}) the planted driver did NOT run anywhere on the daemon's confirm path (marker absent)`, !exists(mark));
  check(`(S12 solo/${kind}) fail-CLOSED: nothing landed (no worker content laundered onto main)`, r?.merged !== true && !fs.existsSync(path.join(W.repo, "feature-a.txt")));
  check(`(S12 solo/${kind}) the refusal is a coherent, non-empty human reason (an ordinary conflict refusal, not a bare git stderr fragment)`,
    typeof r?.reason === "string" && r.reason.length > 20 && (kind === "eqname" ? r.reason.includes("merge.a=b.driver") : kind === "rawbyte" ? /refus/i.test(r.reason) : /conflict/i.test(r.reason)));
  console.log(`      reason(${kind}): ${String(r?.reason).slice(0, 300).replace(/\s+/g, " ")}`);
}

// ── (S12-union) the gate's union-forward runs IN the worker worktree — driver from shared config and from config.worktree.
for (const kind of ["config", "worktree", "eqname", "empty", "rawbyte"]) {
  const tag = `union-${kind}`;
  const W = await world(tag);
  const { mark, cmd } = driverFor(tag);
  advanceMainF(W.repo);
  plantDriver(W.repo, W.w.a.worktreePath, kind, cmd, tag);
  const u = await mergeMainIntoWorktree(W.repo, W.w.a.worktreePath);
  check(`(S12 union/${kind}) the daemon's union-forward did NOT exec the planted driver`, !exists(mark));
  check(`(S12 union/${kind}) fail-closed: the union-forward reports a failure, not a silent ok-merge`, u.ok === false || u.merged === false);
}

// ── (S12-batch) merge_batch cherry-picks each candidate onto a batch worktree cut from main.
for (const kind of ["config", "eqname", "empty", "rawbyte"]) {
  const W = await world(`batch-${kind}`, { labels: ["a", "b"] });
  const { mark, cmd } = driverFor(`batch-${kind}`);
  advanceMainF(W.repo);
  plantDriver(W.repo, W.w.a.worktreePath, kind, cmd, `batch-${kind}`);
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.b.sid);
  const res = await settled(W.sessions.mergeBatchTracked(W.mgrId, [W.w.a.sid, W.w.b.sid]));
  check(`(S12 batch/${kind}) the planted driver did NOT run during assembly/landing`, !exists(mark));
  check(`(S12 batch/${kind}) nothing from the driver-touched candidates landed on main`, !fs.existsSync(path.join(W.repo, "feature-a.txt")) && !fs.existsSync(path.join(W.repo, "feature-b.txt")));
  const reasons = (res?.fallback ?? []).map((f) => f.reason).filter(Boolean);
  check(`(S12 batch/${kind}) each refused candidate carries a coherent reason (non-empty, not a raw stderr fragment)`, reasons.length > 0 && reasons.every((s) => s.length > 20));
  console.log(`      batch result: ok=${res?.ok} fallback reasons: ${JSON.stringify(reasons).slice(0, 400)}`);
}

// ── (S11) `git replace <reviewed-tip> <evil>`: the tip is unchanged so every sha-keyed check passes; the landed CONTENT must be the real tip's.
{
  const W = await world("replace");
  const wt = W.w.a.worktreePath;
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  const tip = git(wt, "rev-parse HEAD");
  const parent = git(wt, "rev-parse HEAD~1");
  // The evil commit: same parent, but feature-a.txt says EVIL.
  const evilWt = path.join(os.tmpdir(), `loom-cgi-evil-${sfx}`);
  registerForCleanup(evilWt);
  git(W.repo, `worktree add -q --detach "${evilWt}" ${parent}`);
  fs.writeFileSync(path.join(evilWt, "feature-a.txt"), "EVIL\n");
  commitAll(evilWt, "evil", GIT_ID);
  const evil = git(evilWt, "rev-parse HEAD");
  git(W.repo, `replace ${tip} ${evil}`);
  // POSITIVE CONTROL: with replace refs honoured, bare git reads the replacement where the real tip is.
  check("(S11) CONTROL: bare git sees the REPLACEMENT's content at the reviewed tip", git(W.repo, `show ${tip}:feature-a.txt`) === "EVIL");
  check("(S11) CONTROL: with core.useReplaceRefs=false the real content shows (the config the helper applies)", git(W.repo, `-c core.useReplaceRefs=false show ${tip}:feature-a.txt`) === "work a");
  const r = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  const landed = (() => { try { return git(W.repo, "show HEAD:feature-a.txt"); } catch { return null; } })();
  check("(S11) OUTCOME: the content that landed on main is the REAL tip's, never the replacement's", landed !== "EVIL");
  check("(S11) the confirm landed the real work (feature-a.txt == 'work a')", r?.merged === true && landed === "work a");
}

// ── (S11-solo, MATERIALISED) the no-reset scenario above is only a LIVENESS check: with replace refs honoured the worker worktree's HEAD reads as the
// evil tree while its files are real, so the worktree looks DIRTY and confirm refuses before any squash — `landed !== "EVIL"` would then hold vacuously.
// Materialise the replacement in the worker worktree (`reset --hard`) so a replace-honouring build DOES squash it: this is the variant that goes RED
// on the RIGHT assertion when the protection regresses.
{
  const W = await world("replace-mat");
  const wt = W.w.a.worktreePath;
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  const tip = git(wt, "rev-parse HEAD");
  const parent = git(wt, "rev-parse HEAD~1");
  const evilWt = path.join(os.tmpdir(), `loom-cgi-evilm-${sfx}`);
  registerForCleanup(evilWt);
  git(W.repo, `worktree add -q --detach "${evilWt}" ${parent}`);
  fs.writeFileSync(path.join(evilWt, "feature-a.txt"), "EVIL\n");
  commitAll(evilWt, "evil", GIT_ID);
  git(W.repo, `replace ${tip} ${git(evilWt, "rev-parse HEAD")}`);
  git(wt, "reset -q --hard HEAD");
  check("(S11 materialised) CONTROL: the replacement is materialised in the worker worktree (its file now says EVIL)", fs.readFileSync(path.join(wt, "feature-a.txt"), "utf8").replace(/\r/g, "") === "EVIL\n");
  const r = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  const landed = (() => { try { return git(W.repo, "show HEAD:feature-a.txt"); } catch { return null; } })();
  check("(S11 materialised) OUTCOME: the replacement's content did NOT land on main", landed !== "EVIL");
  console.log(`      materialised: merged=${r?.merged} landed=${landed} reason=${String(r?.reason).slice(0, 160)}`);
}

// ── (S11-batch) same replace ref through merge_batch's assembly.
{
  const W = await world("replace-batch", { labels: ["a", "b"] });
  const wt = W.w.a.worktreePath;
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.b.sid);
  const tip = git(wt, "rev-parse HEAD");
  const parent = git(wt, "rev-parse HEAD~1");
  const evilWt = path.join(os.tmpdir(), `loom-cgi-evilb-${sfx}`);
  registerForCleanup(evilWt);
  git(W.repo, `worktree add -q --detach "${evilWt}" ${parent}`);
  fs.writeFileSync(path.join(evilWt, "feature-a.txt"), "EVIL\n");
  commitAll(evilWt, "evil", GIT_ID);
  git(W.repo, `replace ${tip} ${git(evilWt, "rev-parse HEAD")}`);
  await settled(W.sessions.mergeBatchTracked(W.mgrId, [W.w.a.sid, W.w.b.sid]));
  const landed = (() => { try { return git(W.repo, "show HEAD:feature-a.txt"); } catch { return null; } })();
  check("(S11 batch) OUTCOME: nothing carrying the replacement's content landed via merge_batch", landed !== "EVIL");
}

// ── (squash-refusal) the canonical `merge --squash` catch: a bad driver key visible ONLY from the CANONICAL checkout (its own `config.worktree` under
// extensions.worktreeConfig) — the worker worktree's union-forward never sees it, so the refusal first fires at the canonical squash. It must read as a plain
// "refused, nothing changed" (the squash never started), NOT as a recovery alarm from a cleanup `reset --hard` that was refused too, and leave canonical untouched.
{
  const W = await world("squashrefuse");
  const wt = W.w.a.worktreePath;
  git(W.repo, "config extensions.worktreeConfig true");
  git(W.repo, `config --worktree "merge.a=b.driver" "true"`); // lands in the canonical checkout's OWN .git/config.worktree
  let workerSees = true; try { git(wt, "config --get-regexp ^merge"); } catch { workerSees = false; }
  check("(squash-refusal) CONTROL: the bad key is NOT visible from the worker worktree (so its union-forward cannot be what refuses)", workerSees === false);
  check("(squash-refusal) CONTROL: the canonical checkout DOES see it", git(W.repo, `config --get-regexp "^merge"`).includes("merge.a=b.driver"));
  await W.sessions.reviewWorkerMerge(W.mgrId, W.w.a.sid);
  const headBefore = git(W.repo, "rev-parse HEAD");
  const r = await settled(W.sessions.confirmWorkerMergeTracked(W.mgrId, W.w.a.sid));
  console.log(`      squash-refusal reason: ${String(r?.reason).slice(0, 320)}`);
  check("(squash-refusal) the confirm is refused (merged:false)", r?.merged === false);
  check("(squash-refusal) the reason STARTS with \"refused, nothing changed\" and names the offending key", typeof r?.reason === "string" && r.reason.startsWith("refused, nothing changed") && r.reason.includes("merge.a=b.driver"));
  check("(squash-refusal) NO recovery-alarm wording (a refused cleanup reset must not read as canonical residue)", typeof r?.reason === "string" && !/residue|needs recovery|reset --hard|cleanup|git merge --squash failed/i.test(r.reason));
  check("(squash-refusal) canonical HEAD is unchanged", git(W.repo, "rev-parse HEAD") === headBefore);
  check("(squash-refusal) canonical index and tracked worktree are clean (no staged residue)", git(W.repo, "diff --cached --name-only") === "" && git(W.repo, "status --porcelain --untracked-files=no") === "");
  check("(squash-refusal) nothing landed", !fs.existsSync(path.join(W.repo, "feature-a.txt")));
}

// ── (rollback) a batch rollback that ITSELF fails must surface (not vanish); a refusal that changed nothing must NOT read as a rollback alarm.
{
  const rbWorld = async (tag) => {
    const repo = path.join(os.tmpdir(), `loom-cgi-rb-${tag}-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    fs.writeFileSync(path.join(repo, "f.txt"), BASE);
    execSync(`git init -q && git config user.email cgi@loom && git config user.name cgi`, { cwd: repo });
    commitAll(repo, "init", GIT_ID);
    const { worktreePath, branch } = await createWorktree(repo, `cgi-rb-proj-${tag}-${sfx}`, `cgi-rb-task-${tag}-${sfx}`);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "f.txt"), BASE.replace("b\n", "B-worker\n"));
    commitAll(worktreePath, "feat(test): worker edits line 2", GIT_ID);
    fs.writeFileSync(path.join(repo, "f.txt"), BASE.replace("b\n", "B-main\n")); // main edits the SAME line ⇒ a real conflict on cherry-pick
    commitAll(repo, "chore(test): main edits line 2", GIT_ID);
    const { worktreePath: batchWt } = await createWorktree(repo, `cgi-rb-proj-${tag}-${sfx}`, `cgi-rb-batch-${tag}-${sfx}`);
    registerForCleanup(batchWt);
    return { repo, batchWt, cand: { workerSessionId: `cgi-rb-w-${tag}-${sfx}`, taskId: `cgi-rb-task-${tag}-${sfx}`, branch, taskTitle: "feat(test): rb" } };
  };
  const failingReset = (p, ms) => { const g = canonicalGit(p, ms); return { raw: (a) => (a[0] === "reset" ? Promise.reject(new Error("reset boom")) : g.raw(a)) }; };
  {
    const W = await rbWorld("ctl");
    const r = await assembleBatchBranches(W.batchWt, [W.cand]);
    const d = r.dropped[0];
    check("(rollback) CONTROL: a real conflict drops the candidate with the ordinary reason and NO rollback alarm", !!d && /conflict cherry-picking/.test(d.reason) && !/ROLLBACK FAILED/.test(d.reason));
  }
  {
    const W = await rbWorld("fail");
    const r = await assembleBatchBranches(W.batchWt, [W.cand], { gitFactory: failingReset });
    const d = r.dropped[0];
    check("(rollback) a FAILED rollback over a dirty batch worktree is surfaced in the drop reason (ROLLBACK FAILED … reset boom), not swallowed", !!d && /ROLLBACK FAILED/.test(d.reason) && /reset boom/.test(d.reason));
  }
  {
    const W = await rbWorld("refuse");
    plantDriver(W.repo, W.batchWt, "rawbyte", driverFor("rb-refuse").cmd, "rb-refuse");
    const r = await assembleBatchBranches(W.batchWt, [W.cand]);
    const d = r.dropped[0];
    check("(rollback) a canonicalGit refusal that changed nothing reads as a plain refusal — no ROLLBACK FAILED alarm — and names the refusal", !!d && /refusing/.test(d.reason) && !/ROLLBACK FAILED/.test(d.reason));
    console.log(`      refuse reason: ${String(d?.reason).slice(0, 200)}`);
  }
}

// ── (helper) unit-level: canonicalGit ignores replace refs on EVERY command (incl. a pure read), blanks includes-defined drivers,
// and the subcommand classifier skips global options.
{
  const repo = path.join(os.tmpdir(), `loom-cgi-unit-${sfx}`);
  fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
  execSync(`git init -q && git config user.email cgi@loom && git config user.name cgi`, { cwd: repo });
  fs.writeFileSync(path.join(repo, "x.txt"), "real\n"); commitAll(repo, "one", GIT_ID);
  const c1 = git(repo, "rev-parse HEAD");
  fs.writeFileSync(path.join(repo, "x.txt"), "fake\n"); commitAll(repo, "two", GIT_ID);
  const c2 = git(repo, "rev-parse HEAD");
  git(repo, `replace ${c1} ${c2}`);
  const g = canonicalGit(repo, 15_000);
  check("(helper) CONTROL: bare git honours the replace ref", git(repo, `show ${c1}:x.txt`) === "fake");
  check("(helper) canonicalGit.raw ignores replace refs on a PURE READ (show)", (await g.raw(["show", `${c1}:x.txt`])).trim() === "real");
  check("(helper) gitSubcommand skips -c pairs and --long options", gitSubcommand(["-c", "user.name=x", "--attr-source=abc", "merge", "--squash", "b"]) === "merge" && gitSubcommand(["-C", "p", "-c", "a=b", "rev-parse"]) === "rev-parse" && gitSubcommand(["-c", "a=b"]) === undefined);
  check("(helper) CANONICAL_GIT_CONFIG_ARGS is the -c form of the replace-refs config", CANONICAL_GIT_CONFIG_ARGS.join(" ") === "-c core.useReplaceRefs=false");
  check("(helper) gitSubcommand skips the VALUE of separate-arg global options (--git-dir/--work-tree/--namespace/-C) so it is never read as the subcommand", gitSubcommand(["--git-dir", "merge", "log"]) === "log" && gitSubcommand(["--work-tree", "x", "--namespace", "y", "merge"]) === "merge");
  check("(helper) a known pure read is NOT exec-capable, an unknown/merge-ish subcommand IS", !canRunMergeDriver(["rev-parse", "HEAD"]) && !canRunMergeDriver(["log", "-1"]) && canRunMergeDriver(["merge", "--squash", "b"]) && canRunMergeDriver(["merge-tree", "--write-tree", "a", "b"]) && canRunMergeDriver(["cherry-pick", "x"]) && canRunMergeDriver(["frobnicate"]));
  check("(helper) a pure read carrying --remerge-diff IS exec-capable (show/log/diff-tree --remerge-diff run merge drivers)", ["show", "log", "diff-tree"].every((c) => canRunMergeDriver([c, "--remerge-diff", "HEAD"])));
  // A driver NAME containing `=` cannot be blanked via `-c` (split at the first `=`): the exec-capable call must THROW naming the key, never run.
  git(repo, `config "merge.a=b.driver" "true"`);
  let eqErr = null; try { await g.raw(["merge-tree", "--write-tree", "HEAD", "HEAD"]); } catch (e) { eqErr = String(e.message); }
  check("(helper) an exec-capable call THROWS when a driver name contains `=`, naming the offending config key", eqErr !== null && eqErr.includes("merge.a=b.driver"));
  check("(helper) …while a pure read is still allowed in that repo", (await g.raw(["rev-parse", "HEAD"])).trim().length === 40);
  git(repo, `config --unset "merge.a=b.driver"`);
  check("(helper) `-m` / `--diff-merges=*` on log/show/diff-tree are exec-capable (a worker-set log.diffMerges=remerge turns them into remerge)", ["log", "show", "diff-tree"].every((c) => canRunMergeDriver([c, "-m", "HEAD"]) && canRunMergeDriver([c, "--diff-merges=r", "HEAD"]) && canRunMergeDriver([c, "--diff-merges=on", "HEAD"])));
  check("(helper) …while ordinary flags on a pure read stay NOT exec-capable (no over-broad match)", !canRunMergeDriver(["log", "-1", "--format=%an", "HEAD"]) && !canRunMergeDriver(["log", "--name-only", "-n1"]) && !canRunMergeDriver(["rev-list", "--merges", "a..b"]));
  check("(helper) `reflog show` (the gate-stamp/tip-moved reads) is a PURE read — a canonicalGit refusal must not fire there — but reflog with --remerge-diff is still exec-capable", !canRunMergeDriver(["reflog", "show", "--format=%H", "HEAD", "--"]) && canRunMergeDriver(["reflog", "show", "--remerge-diff", "HEAD"]));
  // THE INVARIANT: the post-check throws when a driver survives the prefix (a prefix that misses the live key), and passes when it is genuinely blanked.
  git(repo, `config merge.evil.driver "true"`);
  let survived = null; try { await assertNoLiveMergeDrivers(g, [], ["merge"]); } catch (e) { survived = e; }
  check("(helper) assertNoLiveMergeDrivers THROWS a CanonicalGitRefusal naming the key when a driver survives the prefix (stubbed empty prefix)", survived instanceof CanonicalGitRefusal && /merge.evil.driver/.test(survived.message));
  let blankedOk = true; try { await assertNoLiveMergeDrivers(g, ["-c", "merge.evil.driver="], ["merge"]); } catch { blankedOk = false; }
  check("(helper) …and PASSES when the prefix really blanks it (effective last-wins value is empty)", blankedOk);
  let wrongKey = null; try { await assertNoLiveMergeDrivers(g, ["-c", "merge.other.driver="], ["merge"]); } catch (e) { wrongKey = e; }
  check("(helper) …and THROWS when the prefix blanks a DIFFERENT key (the wrong-spelling class)", wrongKey instanceof CanonicalGitRefusal);
  git(repo, `config --unset merge.evil.driver`);
  check("(helper) describeGitFailure: first line only, capped, and flags a CanonicalGitRefusal", (() => { const d = describeGitFailure(new CanonicalGitRefusal("x".repeat(500) + "\nsecond")); const p = describeGitFailure(new Error("real\nmore")); return d.refusal && d.text.length === 400 && !p.refusal && p.text === "real"; })());
  // verifyReviewedTipChain goes through canonicalGit (no per-call flag any more): a replace ref must still not rewrite what it judges.
  const v = await verifyReviewedTipChain(repo, c2, c2);
  check("(helper) verifyReviewedTipChain still works with the per-call --no-replace-objects removed (identity case)", v.ok === true);
}

// ── (round 4) the post-check is the SELF-SUFFICIENT invariant: it reads the config the REAL call sees and fails closed on anything it cannot prove empty.
{
  // A repo where `merge-tree --write-tree main side` needs a content merge of f.txt (so a planted driver would run).
  const mkMergeRepo = (tag) => {
    const repo = path.join(os.tmpdir(), `loom-cgi-r4-${tag}-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    execSync(`git init -q -b main && git config user.email cgi@loom && git config user.name cgi`, { cwd: repo });
    fs.writeFileSync(path.join(repo, "f.txt"), BASE); commitAll(repo, "base", GIT_ID);
    execSync("git checkout -q -b side", { cwd: repo });
    fs.writeFileSync(path.join(repo, "f.txt"), BASE.replace("b\n", "B-side\n")); commitAll(repo, "side", GIT_ID);
    execSync("git checkout -q main", { cwd: repo });
    fs.writeFileSync(path.join(repo, "f.txt"), BASE.replace("d\n", "D-main\n")); commitAll(repo, "main", GIT_ID);
    return repo;
  };
  const mergeTree = ["merge-tree", "--write-tree", "main", "side"];
  const unwrapped = (repo) => boundedSimpleGit(repo, 15_000, undefined, undefined, { allowUnsafeMergeDriver: true }, [...CANONICAL_GIT_CONFIG]);

  // ── MAJOR 3: nothing but the post-check can stop this — a prefix-builder that MISSES the live driver. Goes RED if the assertNoLiveMergeDrivers call is removed.
  {
    const repo = mkMergeRepo("leaky");
    const { mark, cmd } = driverFor("r4-leaky");
    plantDriver(repo, null, "config", cmd, "r4-leaky");
    const g = unwrapped(repo);
    try { execSync(`git ${mergeTree.join(" ")}`, { cwd: repo, stdio: "ignore" }); } catch { /* a conflict exit is fine — only the marker matters */ }
    const controlRan = exists(mark); fs.rmSync(mark, { force: true });
    check("(post-check wired) CONTROL: bare git merge-tree on this fixture DOES exec the planted driver", controlRan);
    let err = null; try { await canonicalRaw(g, mergeTree, () => []); } catch (e) { err = e; }
    check("(post-check wired) a prefix-builder that MISSES the driver is stopped by the POST-CHECK (CanonicalGitRefusal naming the key), enumeration refusals bypassed", err instanceof CanonicalGitRefusal && /merge\.evil\.driver/.test(err.message));
    check("(post-check wired) …and the driver did NOT run", !exists(mark));
    fs.rmSync(mark, { force: true });
    let refused = false; try { await canonicalRaw(g, mergeTree); } catch (e) { if (e instanceof CanonicalGitRefusal) refused = true; /* else: a plain git conflict failure from the blanked driver */ } // the real builder blanks it: the driver "cannot spawn" ⇒ a plain git conflict failure, NOT a refusal
    check("(post-check wired) the DEFAULT builder passes the post-check (the driver is really blanked: no CanonicalGitRefusal) and still never runs it", !refused && !exists(mark));
  }

  // ── MAJOR 1: decode collision — the real 0xE9 key and our `-c merge.<U+FFFD>.driver=` key decode to the SAME string; the post-check alone must still fail closed.
  {
    const repo = mkMergeRepo("collide");
    const { mark, cmd } = driverFor("r4-collide");
    plantDriver(repo, null, "rawbyte", cmd, "r4-collide");
    const g = unwrapped(repo);
    const naive = (names) => names.flatMap((n) => ["-c", `merge.${n}.driver=`]); // no U+FFFD refusal: the enumeration's own guard is out of the picture
    let err = null; try { await canonicalRaw(g, mergeTree, naive); } catch (e) { err = e; }
    check("(collision) with the enumeration's U+FFFD refusal bypassed, the post-check ALONE refuses (a decode collision cannot hide the live driver)", err instanceof CanonicalGitRefusal);
    check("(collision) …and the driver did NOT run", !exists(mark));
    let direct = null; try { await assertNoLiveMergeDrivers(g, ["-c", "merge.�.driver="], ["merge"]); } catch (e) { direct = e; }
    check("(collision) assertNoLiveMergeDrivers itself treats a U+FFFD key as LIVE even when the blanking -c collides with it", direct instanceof CanonicalGitRefusal);
  }

  // ── MAJOR 2: ambient GIT_CONFIG blinds the `git config` reads (only the config builtin honours it) while `git merge` still reads .git/config.
  {
    const repo = mkMergeRepo("gitconfig");
    const { mark, cmd } = driverFor("r4-gitconfig");
    plantDriver(repo, null, "config", cmd, "r4-gitconfig");
    const empty = path.join(os.tmpdir(), `loom-cgi-empty-gitconfig-${sfx}`); registerForCleanup(empty); fs.writeFileSync(empty, "");
    const saved = process.env.GIT_CONFIG;
    process.env.GIT_CONFIG = empty;
    try {
      const seen = (() => { try { return git(repo, "config --get-regexp ^merge"); } catch { return ""; } })();
      check("(GIT_CONFIG) CONTROL: with the ambient GIT_CONFIG a bare `git config` read sees NO driver (the blindness this closes)", !seen.includes("merge.evil.driver"));
      try { execSync(`git ${mergeTree.join(" ")}`, { cwd: repo, stdio: "ignore", env: process.env }); } catch { /* only the marker matters */ }
      check("(GIT_CONFIG) CONTROL: …while a bare `git merge-tree` under the same env DOES exec the driver", exists(mark));
      fs.rmSync(mark, { force: true });
      const g = canonicalGit(repo, 15_000);
      await g.raw(mergeTree).catch(() => {});
      check("(GIT_CONFIG) canonicalGit strips GIT_CONFIG from the child env: the driver does NOT run", !exists(mark));
      const g2 = canonicalGit(repo, 15_000, { ...process.env, GIT_TERMINAL_PROMPT: "0" });
      await g2.raw(mergeTree).catch(() => {});
      check("(GIT_CONFIG) …also when the caller supplies its own env (nonInteractiveEnv-style spreads process.env)", !exists(mark));
    } finally { if (saved === undefined) delete process.env.GIT_CONFIG; else process.env.GIT_CONFIG = saved; }
  }

  // ── MINOR 4: enumeration and post-check use the call's OWN global options, so `-C <path>` / `--git-dir <path>` calls are protected against the config THEY see.
  for (const style of ["-C", "--git-dir", "--git-dir="]) {
    const styleTag = style === "-C" ? "C" : style === "--git-dir" ? "gd-sep" : "gd-eq";
    const repo = mkMergeRepo(`globals${styleTag}`);
    const { mark, cmd } = driverFor(`r4-globals${styleTag}`);
    plantDriver(repo, null, "eqname", cmd, `r4-globals${styleTag}`);
    const elsewhere = path.join(os.tmpdir(), `loom-cgi-r4-elsewhere${styleTag}-${sfx}`);
    fs.mkdirSync(elsewhere, { recursive: true }); registerForCleanup(elsewhere);
    execSync("git init -q", { cwd: elsewhere }); // a clean repo: the instance's OWN cwd sees NO driver at all
    const g = canonicalGit(elsewhere, 15_000);
    const args = style === "-C" ? ["-C", repo, ...mergeTree] : style === "--git-dir" ? ["--git-dir", path.join(repo, ".git"), "--work-tree", repo, ...mergeTree] : [`--git-dir=${path.join(repo, ".git")}`, `--work-tree=${repo}`, ...mergeTree];
    let err = null; try { await g.raw(args); } catch (e) { err = e; }
    check(`(globals ${style}) a call re-pointed at ANOTHER repo is protected against THAT repo's driver config (refused naming the key), not the instance cwd's`, err instanceof CanonicalGitRefusal && /merge\.a=b\.driver/.test(err.message));
    check(`(globals ${style}) …and the driver did NOT run`, !exists(mark));
  }
}

// ── (round 5) locale, ambient-env and globals-wiring pins.
{
  const mkRepo = (tag) => {
    const repo = path.join(os.tmpdir(), `loom-cgi-r5-${tag}-${sfx}`);
    fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
    execSync(`git init -q -b main && git config user.email cgi@loom && git config user.name cgi`, { cwd: repo });
    fs.writeFileSync(path.join(repo, "f.txt"), BASE); commitAll(repo, "base", GIT_ID);
    execSync("git checkout -q -b side", { cwd: repo });
    fs.writeFileSync(path.join(repo, "f.txt"), BASE.replace("b\n", "B-side\n")); commitAll(repo, "side", GIT_ID);
    execSync("git checkout -q main", { cwd: repo });
    fs.writeFileSync(path.join(repo, "f.txt"), BASE.replace("d\n", "D-main\n")); commitAll(repo, "main", GIT_ID);
    return repo;
  };
  const mergeTree = ["merge-tree", "--write-tree", "main", "side"];
  const unwrapped = (repo) => boundedSimpleGit(repo, 15_000, undefined, undefined, { allowUnsafeMergeDriver: true }, [...CANONICAL_GIT_CONFIG]);

  // ── LOCALE: on glibc in a UTF-8 locale a regex `.` does NOT match an invalid byte, so a `--get-regexp '^merge\..*\.driver$'` read returned NOTHING for the
  // raw-0xE9 name and the driver ran. Both reads now list every entry and filter IN JS. A Windows git matches in every locale (this cannot go red there), so
  // FORCE a UTF-8 locale on the canonicalGit env: ubuntu CI exercises it for real.
  {
    const repo = mkRepo("locale");
    const { mark, cmd } = driverFor("r5-locale");
    plantDriver(repo, null, "rawbyte", cmd, "r5-locale");
    const utf8 = { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
    const g = canonicalGit(repo, 15_000, utf8);
    let err = null; try { await g.raw(mergeTree); } catch (e) { err = e; }
    check("(locale) under a forced UTF-8 locale the raw-0xE9 driver name is still SEEN and refused (no locale-dependent regex hides it)", err instanceof CanonicalGitRefusal);
    check("(locale) …and the driver did NOT run", !exists(mark));
    fs.rmSync(mark, { force: true });
    let bare = "";
    try { bare = execSync("git config -z --list", { cwd: repo, env: utf8 }).toString("latin1"); } catch { /* */ }
    check("(locale) CONTROL: the dot-free `--list` read returns the raw-byte key under this locale (the read the fix relies on)", /merge\.[\s\S]*\.driver/.test(bare));
  }

  // ── AMBIENT ENV: canonicalGit must stay env-less when nothing needs stripping. simple-git's blockUnsafeOperationsPlugin only inspects an EXPLICIT env,
  // so an always-explicit env made ambient GIT_ASKPASS (VS Code's terminal sets it) etc. throw "unsafe" on EVERY canonical call.
  {
    const repo = mkRepo("askpass");
    const saved = {};
    const set = { GIT_ASKPASS: "echo", SSH_ASKPASS: "echo", GIT_SSH_COMMAND: "ssh", GIT_PROXY_COMMAND: "cat" };
    for (const [k, v] of Object.entries(set)) { saved[k] = process.env[k]; process.env[k] = v; }
    try {
      const g = canonicalGit(repo, 15_000);
      let head = null, headErr = null; try { head = (await g.raw(["rev-parse", "HEAD"])).trim(); } catch (e) { headErr = e; }
      check("(ambient env) with GIT_ASKPASS/SSH_ASKPASS/GIT_SSH_COMMAND/GIT_PROXY_COMMAND set, a PURE READ through canonicalGit succeeds (not 'unsafe')", head !== null && head.length === 40 && headErr === null);
      let mtErr = null; try { await g.raw(mergeTree); } catch (e) { mtErr = e; }
      check("(ambient env) …and an exec-capable call is not rejected as 'unsafe' either", !mtErr || !/unsafe/i.test(String(mtErr.message)));
      // …and an ambient GIT_CONFIG is STILL stripped (the only case that needs an explicit env).
    } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  }

  // ── GLOBALS wiring, pinned with a plain (blankable) driver so the `=` refusal is out of the picture. `elsewhere` is a clean repo: the instance cwd sees NO driver.
  {
    const repo = mkRepo("g5");
    const { mark, cmd } = driverFor("r5-g5");
    plantDriver(repo, null, "config", cmd, "r5-g5");
    const elsewhere = path.join(os.tmpdir(), `loom-cgi-r5-elsewhere-${sfx}`);
    fs.mkdirSync(elsewhere, { recursive: true }); registerForCleanup(elsewhere);
    execSync("git init -q", { cwd: elsewhere });
    const gE = unwrapped(elsewhere);
    let e1 = null; try { await canonicalRaw(gE, ["-C", repo, ...mergeTree], () => []); } catch (e) { e1 = e; }
    check("(globals wired: post-check) a leaky builder + `-C <repo>` from a clean cwd is refused: the POST-CHECK read carries the call's globals", e1 instanceof CanonicalGitRefusal && /merge\.evil\.driver/.test(e1.message));
    check("(globals wired: post-check) …and the driver did NOT run", !exists(mark));
    let e2 = null; try { await canonicalRaw(gE, ["-C", repo, ...mergeTree]); } catch (e) { e2 = e; }
    check("(globals wired: enumeration) the DEFAULT builder + `-C <repo>` blanks the driver found in THAT repo (no refusal: the ENUMERATION read carries the globals)", !(e2 instanceof CanonicalGitRefusal));
    check("(globals wired: enumeration) …and the driver did NOT run", !exists(mark));
  }
}

for (const db of dbs) { try { db.close?.(); } catch { /* best effort */ } }
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
