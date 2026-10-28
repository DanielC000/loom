import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 1fae1b98 — a watermark-read failure escalates via its OWN nested `watermark` sub-counter,
// never the top-level content-check fields: do not grow this into the sibling content-check file
// (`stale-generation-landedtip-content-check.mjs`, already ~5 min solo) or fold the two counters.
//
// REAL git on temp repos, NO claude + NO live daemon — drives reconcileOrchestrationOnBoot() directly,
// same harness shape as the sibling file. Scenarios: WATERMARK_CORRUPT, WATERMARK_REF_MISSING,
// WATERMARK_DB_READ_FAIL, LATER_SUCCESS, INTERLEAVING, UPGRADED_STORE, WATERMARK_ONLY_ESCALATE_SURVIVES
// — each scenario's own comment block below states what it proves.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { commitAll } from "./_git-commit.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("sgwu-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { mainlineWatermarkKey } = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const warns = [];
const realWarn = console.warn;
console.warn = (...a) => { warns.push(a.join(" ")); realWarn(...a); };
const warnsMatching = (needle) => warns.filter((w) => w.includes(needle));
const GIT_ID = "-c user.email=sgwu@loom -c user.name=sgwu";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
// Mirrors `stale-generation-landedtip-content-check.mjs`'s own xLastActivityFor/yCreatedAtFor exactly —
// needed so `currentGenerationIds`' recency grouping treats X as the STALE generation, not the current one.
const xLastActivityFor = (baseNow) => new Date(Date.parse(baseNow) + 20_000).toISOString();
const yCreatedAtFor = (baseNow) => new Date(Date.parse(baseNow) + 10_000).toISOString();
// Captures every enqueueDurableMessage's own full text (`warnsMatching` only sees the SHORTER per-boot
// console.warn line — it does NOT carry a nudge's full remedy wording).
const sentMessages = [];
const pty = { enqueueStdin: (recipientId, text) => { sentMessages.push({ recipientId, text }); return { delivered: false, deliveryState: "queued" }; } };
const sentMatching = (needle) => sentMessages.filter((m) => m.text.includes(needle));

function initRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# sgwu\n");
  execSync(`git init -q`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  git(repo, "branch -M main");
}

// Same idiom as the sibling file's own corruptOneSubtree — moves a candidate's subtree object aside so a
// later `git ls-tree -r <candidateSha>` genuinely fails (a real transient git read failure, never a
// crafted error message). Never restored — the whole repo dir is removed in the caller's own `finally`.
function corruptOneSubtree(repoPath, candidateSha, dirName) {
  const lsTreeOut = execSync(`git ls-tree ${candidateSha}`, { cwd: repoPath }).toString();
  const line = lsTreeOut.split("\n").find((l) => l.endsWith(`\t${dirName}`));
  if (!line) throw new Error(`corruptOneSubtree: no tree entry named "${dirName}" in ${candidateSha}`);
  const subtreeSha = line.trim().split(/\s+/)[2];
  const objPath = path.join(repoPath, ".git", "objects", subtreeSha.slice(0, 2), subtreeSha.slice(2));
  fs.renameSync(objPath, `${objPath}.bak`);
}

/**
 * ONE stale-generation worker X (an unresolved own `merge_request`) + a re-task worker Y whose landing
 * goes through normally — mirrors the sibling file's `baseSetup`/`finishWithRetask`, but parameterized
 * on the watermark's OWN stored value so each scenario below can control it directly. `watermarkValue` is
 * written VERBATIM via `setMeta` (a raw string for a corrupt-shape fixture, or `JSON.stringify({branch,
 * sha})` for a normal one) — pass `null` to skip stamping a watermark at all (the "absent" case, not
 * exercised here since it is not a failure — see this card's own decision record).
 */
async function setupStaleWorker(dbInst, tag, repo, watermarkValue) {
  initRepo(repo);
  const projId = `sgwu-${tag}-proj-${sfx}`, agentId = `sgwu-${tag}-agent-${sfx}`, taskId = `sgwu-${tag}-task-${sfx}`;
  const mgrId = `sgwu-${tag}-mgr-${sfx}`, workerXId = `sgwu-${tag}-workerx-${sfx}`, workerYId = `sgwu-${tag}-workery-${sfx}`;
  dbInst.insertProject({ id: projId, name: `SGWU-${tag}`, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  dbInst.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  dbInst.insertTask({ id: taskId, projectId: projId, title: `SGWU-${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  dbInst.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const genesisSha = git(repo, "rev-parse HEAD");
  if (watermarkValue !== null) dbInst.setMeta(mainlineWatermarkKey(projId, "primary"), watermarkValue);
  const first = await createWorktree(repo, projId, taskId);
  dbInst.insertSession({ id: workerXId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: first.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: xLastActivityFor(now), lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: first.worktreePath, branch: first.branch });
  fs.writeFileSync(path.join(first.worktreePath, "x.txt"), "x real work\n");
  commitAll(first.worktreePath, "x", GIT_ID);
  const xTip = git(first.worktreePath, "rev-parse HEAD");
  dbInst.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_request", detail: { branch: first.branch, tip: xTip, filesChangedPaths: ["x.txt"] } });
  dbInst.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerXId, taskId, kind: "merge_landing_started", detail: {} });
  return { projId, taskId, mgrId, workerXId, workerYId, repo, first, genesisSha, xTip, tag };
}

async function finishWithRetask(dbInst, ctx) {
  const { projId, taskId, mgrId, workerYId, repo, tag } = ctx;
  const second = await createWorktree(repo, projId, taskId); // re-task reuses X's exact path/branch
  dbInst.insertSession({ id: workerYId, projectId: projId, agentId: `sgwu-${tag}-agent-${sfx}`, engineSessionId: null, title: null, cwd: second.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: yCreatedAtFor(now), lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: second.worktreePath, branch: second.branch });
  fs.writeFileSync(path.join(second.worktreePath, "y.txt"), "y work\n");
  commitAll(second.worktreePath, "y", GIT_ID);
  execSync(`git ${GIT_ID} merge --squash ${second.branch} && git ${GIT_ID} commit -q -m "SGWU-${tag}-y" -m "Loom-Worker-Branch: ${second.branch}"`, { cwd: repo });
  dbInst.appendEvent({ id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerYId, taskId, kind: "merge_request", detail: { branch: second.branch } });
  return { worktreePath: second.worktreePath, branch: second.branch };
}

// --- WATERMARK_CORRUPT: a watermark row that fails readMainlineWatermarkStrict escalates on boot 1,
// deterministic (no attempts/age grace), sticky, no re-fire on boot 2. ---
{
  const R = path.join(os.tmpdir(), `loom-sgwu-corrupt-${sfx}`);
  const dbPath = path.join(os.tmpdir(), `loom-sgwu-corrupt-db-${sfx}.db`);
  let dbInst;
  try {
    dbInst = new Db(dbPath);
    const sessions = new SessionService(dbInst, pty, new OrchestrationControl());
    const ctx = await setupStaleWorker(dbInst, "corrupt", R, "this is not valid watermark JSON");
    await finishWithRetask(dbInst, ctx);

    const r1 = await sessions.reconcileOrchestrationOnBoot(new Set());
    console.log("WATERMARK_CORRUPT reconcile result (boot 1):", JSON.stringify(r1));
    check("(WATERMARK_CORRUPT boot 1) escalates immediately — deterministic, no attempts/age grace",
      dbInst.listStaleGenerationUnresolved().some((e) => e.sessionId === ctx.workerXId && e.watermark?.escalated && e.watermark.attempts === 1));
    check("(WATERMARK_CORRUPT boot 1) the content-check's own top-level fields are untouched (never reached — the watermark check short-circuits first)",
      dbInst.listStaleGenerationUnresolved().some((e) => e.sessionId === ctx.workerXId && e.kind === undefined && e.attempts === undefined));
    check("(WATERMARK_CORRUPT boot 1) the one-shot nudge fired exactly once, naming the reset route",
      warnsMatching("escalated [loom:merge-orphaned]").filter((w) => w.includes(ctx.workerXId.slice(0, 8)) && w.includes("corrupt mainline watermark")).length === 1);
    check("(WATERMARK_CORRUPT boot 1) the DURABLE nudge text (not just the console.warn line) names the human reset mechanism",
      sentMatching("mainline-watermark/reset").length === 1);
    check("(WATERMARK_CORRUPT boot 1) boot-summary staleGenerationUnresolvedEscalated counts this row", r1.staleGenerationUnresolvedEscalated >= 1);
    // @decision eb58b8bd (pre-existing, unrelated to this card): an unreadable project watermark skips
    // the landed-lookup/finalize for EVERY worker in that project, not just the stale one — so worker Y
    // (an ordinary, CURRENT-generation landing) stays unfinalized too while the watermark stays broken.
    check("(WATERMARK_CORRUPT) worker Y's landing is ALSO withheld while the watermark stays corrupt (not just X's) — a project-wide effect, pre-existing and unrelated to this card",
      !dbInst.listEventsForWorker(ctx.workerYId).some((ev) => ev.kind === "merge_done"));

    const r2 = await sessions.reconcileOrchestrationOnBoot(new Set());
    console.log("WATERMARK_CORRUPT reconcile result (boot 2, no re-nudge):", JSON.stringify(r2));
    check("(WATERMARK_CORRUPT boot 2) stays escalated, sticky",
      dbInst.listStaleGenerationUnresolved().some((e) => e.sessionId === ctx.workerXId && e.watermark?.escalated));
    check("(WATERMARK_CORRUPT boot 2) the one-shot nudge did NOT re-fire a second time",
      warnsMatching("escalated [loom:merge-orphaned]").filter((w) => w.includes(ctx.workerXId.slice(0, 8)) && w.includes("corrupt mainline watermark")).length === 1);
  } finally {
    try { dbInst?.close(); } catch { /* best-effort */ }
    for (const p of [R, dbPath]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

// --- WATERMARK_REF_MISSING: a watermark naming a branch that genuinely never existed — bounded give-up
// (3 boots / 1 day default, overridden low here), same shape as the sibling file's own BOUND_ATTEMPTS. ---
let refMissingCtx, refMissingR, refMissingDbPath, dbRefMissing, sessionsRefMissing;
{
  refMissingR = path.join(os.tmpdir(), `loom-sgwu-refmiss-${sfx}`);
  refMissingDbPath = path.join(os.tmpdir(), `loom-sgwu-refmiss-db-${sfx}.db`);
  try {
    dbRefMissing = new Db(refMissingDbPath);
    const ATTEMPTS = 2; // low, so a 3-boot run proves the full bound/no-rebound shape fast
    sessionsRefMissing = new SessionService(dbRefMissing, pty, new OrchestrationControl(), { staleGenerationTransientEscalateAttempts: ATTEMPTS });
    refMissingCtx = await setupStaleWorker(dbRefMissing, "refmiss", refMissingR, JSON.stringify({ branch: "ghost-branch-never-existed", sha: "0".repeat(40) }));
    await finishWithRetask(dbRefMissing, refMissingCtx);

    const b1 = await sessionsRefMissing.reconcileOrchestrationOnBoot(new Set());
    console.log("WATERMARK_REF_MISSING reconcile result (boot 1):", JSON.stringify(b1));
    check(`(WATERMARK_REF_MISSING boot 1) tracked, not yet escalated (attempt 1 of ${ATTEMPTS})`,
      dbRefMissing.listStaleGenerationUnresolved().some((e) => e.sessionId === refMissingCtx.workerXId && !e.watermark?.escalated && e.watermark?.attempts === 1));
    check("(WATERMARK_REF_MISSING boot 1) boot-summary staleGenerationTransient counts this row", b1.staleGenerationTransient >= 1);
    check("(WATERMARK_REF_MISSING boot 1) boot-summary staleGenerationUnresolvedEscalated does NOT yet count this row", b1.staleGenerationUnresolvedEscalated === 0);

    const b2 = await sessionsRefMissing.reconcileOrchestrationOnBoot(new Set());
    console.log("WATERMARK_REF_MISSING reconcile result (boot 2, crosses threshold):", JSON.stringify(b2));
    check("(WATERMARK_REF_MISSING boot 2) escalates on crossing the attempts threshold",
      dbRefMissing.listStaleGenerationUnresolved().some((e) => e.sessionId === refMissingCtx.workerXId && e.watermark?.escalated && e.watermark.attempts === ATTEMPTS));
    check("(WATERMARK_REF_MISSING boot 2) the one-shot escalation nudge fired exactly once",
      warnsMatching("escalated [loom:merge-orphaned]").filter((w) => w.includes(refMissingCtx.workerXId.slice(0, 8)) && w.includes("watermark transient give-up threshold")).length === 1);
    // Code Review of 1fae1b98, Minor 2: this TRANSIENT-cause nudge must ALSO name the reset remedy
    // (worded conditionally — this cause may self-heal, unlike the corrupt nudge's certain reset).
    check("(WATERMARK_REF_MISSING boot 2) the DURABLE nudge text names the conditional reset remedy for a renamed/deleted branch",
      sentMatching("renamed or deleted").some((m) => m.text.includes("mainline-watermark/reset")));

    const b3 = await sessionsRefMissing.reconcileOrchestrationOnBoot(new Set());
    console.log("WATERMARK_REF_MISSING reconcile result (boot 3, no re-nudge):", JSON.stringify(b3));
    check("(WATERMARK_REF_MISSING boot 3) stays escalated, sticky",
      dbRefMissing.listStaleGenerationUnresolved().some((e) => e.sessionId === refMissingCtx.workerXId && e.watermark?.escalated));
    check("(WATERMARK_REF_MISSING boot 3) the one-shot nudge did NOT re-fire a second time",
      warnsMatching("escalated [loom:merge-orphaned]").filter((w) => w.includes(refMissingCtx.workerXId.slice(0, 8)) && w.includes("watermark transient give-up threshold")).length === 1);
    // @decision eb58b8bd (pre-existing, unrelated to this card): an unresolvable project watermark skips
    // the landed-lookup/finalize for EVERY worker in that project — Y stays unfinalized too, same as the
    // WATERMARK_CORRUPT fixture above.
    check("(WATERMARK_REF_MISSING) worker Y's landing is ALSO withheld while the watermark stays unresolvable (not just X's)",
      !dbRefMissing.listEventsForWorker(refMissingCtx.workerYId).some((ev) => ev.kind === "merge_done"));

    // --- LATER_SUCCESS: repoint the watermark to a resolvable ref on a 4th boot — the watermark
    // sub-counter must stop advancing (the mechanism this card bounds has stopped recurring), even though
    // the content-check itself then takes over (no real candidate exists in this fixture, so it falls
    // into the content-check's OWN, independent escalation — proving the two never conflate). ---
    // Boot 3 (just above) ALSO re-observed the still-broken watermark (sticky-escalated, so it never
    // short-circuits — `recordStaleGenerationWatermarkUnresolved` runs unconditionally every boot this
    // branch is reached, same "recomputes fresh every boot" shape 05915fc7 established for the
    // content-check's own transient bucket), so the watermark sub-counter is at 3 (boot1=1, boot2=2, boot3=3)
    // going into boot 4, never the escalation-threshold constant `ATTEMPTS` (2) itself — capture the REAL
    // value rather than hardcoding either number, so this assertion can't silently drift from whichever
    // is actually true.
    const attemptsBeforeBoot4 = dbRefMissing.listStaleGenerationUnresolved().find((e) => e.sessionId === refMissingCtx.workerXId)?.watermark?.attempts;
    dbRefMissing.setMeta(mainlineWatermarkKey(refMissingCtx.projId, "primary"), JSON.stringify({ branch: "main", sha: refMissingCtx.genesisSha }));
    const b4 = await sessionsRefMissing.reconcileOrchestrationOnBoot(new Set());
    console.log("LATER_SUCCESS reconcile result (boot 4, watermark now resolves):", JSON.stringify(b4));
    check("(LATER_SUCCESS boot 4) the watermark sub-counter stopped advancing (unchanged from immediately before this boot)",
      dbRefMissing.listStaleGenerationUnresolved().some((e) => e.sessionId === refMissingCtx.workerXId && e.watermark?.attempts === attemptsBeforeBoot4));
    check("(LATER_SUCCESS boot 4) no NEW watermark nudge fired (still exactly the one from boot 2)",
      warnsMatching("escalated [loom:merge-orphaned]").filter((w) => w.includes(refMissingCtx.workerXId.slice(0, 8)) && w.includes("watermark transient give-up threshold")).length === 1);
    check("(LATER_SUCCESS boot 4) the content-check now runs its OWN, independent attribution attempt for the first time",
      dbRefMissing.listStaleGenerationUnresolved().some((e) => e.sessionId === refMissingCtx.workerXId && e.kind !== undefined));
  } finally {
    try { dbRefMissing?.close(); } catch { /* best-effort */ }
    for (const p of [refMissingR, refMissingDbPath]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

// --- WATERMARK_DB_READ_FAIL: the OTHER sub-cause of cause:"transient" — db.getMeta throwing — via a
// surgical, key-scoped monkeypatch (no production test seam exists for this). Proves the bound engages
// identically regardless of WHICH sub-cause of "transient" produced it. ---
{
  const R = path.join(os.tmpdir(), `loom-sgwu-dbfail-${sfx}`);
  const dbPath = path.join(os.tmpdir(), `loom-sgwu-dbfail-db-${sfx}.db`);
  let dbInst;
  try {
    dbInst = new Db(dbPath);
    const ATTEMPTS = 2;
    const sessions = new SessionService(dbInst, pty, new OrchestrationControl(), { staleGenerationTransientEscalateAttempts: ATTEMPTS });
    const ctx = await setupStaleWorker(dbInst, "dbfail", R, JSON.stringify({ branch: "main", sha: "0".repeat(40) }));
    await finishWithRetask(dbInst, ctx);

    // Surgical: throws ONLY for this project's own watermark key — every other getMeta call (companion
    // config, boot markers, every other project's own watermark, etc.) reads through to the real method.
    const watermarkKey = mainlineWatermarkKey(ctx.projId, "primary");
    const realGetMeta = dbInst.getMeta.bind(dbInst);
    dbInst.getMeta = (key) => { if (key === watermarkKey) throw new Error("simulated db read failure (test fixture)"); return realGetMeta(key); };

    const b1 = await sessions.reconcileOrchestrationOnBoot(new Set());
    console.log("WATERMARK_DB_READ_FAIL reconcile result (boot 1):", JSON.stringify(b1));
    check(`(WATERMARK_DB_READ_FAIL boot 1) tracked, not yet escalated (attempt 1 of ${ATTEMPTS})`,
      dbInst.listStaleGenerationUnresolved().some((e) => e.sessionId === ctx.workerXId && !e.watermark?.escalated && e.watermark?.attempts === 1));

    const b2 = await sessions.reconcileOrchestrationOnBoot(new Set());
    console.log("WATERMARK_DB_READ_FAIL reconcile result (boot 2, crosses threshold):", JSON.stringify(b2));
    check("(WATERMARK_DB_READ_FAIL boot 2) escalates on crossing the attempts threshold",
      dbInst.listStaleGenerationUnresolved().some((e) => e.sessionId === ctx.workerXId && e.watermark?.escalated && e.watermark.attempts === ATTEMPTS));
    check("(WATERMARK_DB_READ_FAIL boot 2) the one-shot escalation nudge fired exactly once",
      warnsMatching("escalated [loom:merge-orphaned]").filter((w) => w.includes(ctx.workerXId.slice(0, 8)) && w.includes("watermark transient give-up threshold")).length === 1);
    // @decision eb58b8bd (pre-existing, unrelated to this card): same project-wide effect as the other
    // two watermark fixtures above — Y's own ordinary finalize is withheld too while the watermark read
    // keeps failing.
    check("(WATERMARK_DB_READ_FAIL) worker Y's landing is ALSO withheld while the watermark read keeps failing (not just X's)",
      !dbInst.listEventsForWorker(ctx.workerYId).some((ev) => ev.kind === "merge_done"));
  } finally {
    try { dbInst?.close(); } catch { /* best-effort */ }
    for (const p of [R, dbPath]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

// --- INTERLEAVING: watermark fails (boot 1), an UNRELATED content-check transient fails (boot 2), then
// watermark fails again (boot 3) — the nested `watermark` sub-counter and the top-level content-check
// fields must never conflate in either direction. ---
{
  const R = path.join(os.tmpdir(), `loom-sgwu-interleave-${sfx}`);
  const dbPath = path.join(os.tmpdir(), `loom-sgwu-interleave-db-${sfx}.db`);
  let dbInst;
  try {
    dbInst = new Db(dbPath);
    const sessions = new SessionService(dbInst, pty, new OrchestrationControl());
    const ctx = await setupStaleWorker(dbInst, "interleave", R, JSON.stringify({ branch: "ghost-branch-never-existed", sha: "0".repeat(40) }));

    // A GENUINE landing for X on the real repo root, with a subtree that gets corrupted AFTER it lands —
    // same technique as the sibling file's BOUND_ATTEMPTS — so boot 2's content check (once the watermark
    // resolves to "main") hits a real transient git read failure, never a crafted one.
    fs.mkdirSync(path.join(R, "sub-il"), { recursive: true });
    fs.writeFileSync(path.join(R, "sub-il", "leaf.txt"), `leaf-il-${sfx}\n`);
    fs.writeFileSync(path.join(R, "x.txt"), "x real work\n"); // byte-identical to ctx.xTip's own
    commitAll(R, [`chore(unrelated): il landing`, `Loom-Worker-Branch: ${ctx.first.branch}\nLoom-Worker-Base: ${ctx.genesisSha}`], GIT_ID);
    const xLandedSha = git(R, "rev-parse HEAD");
    fs.rmSync(path.join(R, "sub-il"), { recursive: true, force: true });

    await finishWithRetask(dbInst, ctx);
    // Corrupt AFTER Y's own worktree/squash-merge is created (mirrors the sibling file's own
    // BOUND_ATTEMPTS ordering exactly) — never restored, persists for boot 2 and beyond.
    corruptOneSubtree(R, xLandedSha, "sub-il");

    // Boot 1: watermark fails (ghost branch). Content-check never reached at all.
    const r1 = await sessions.reconcileOrchestrationOnBoot(new Set());
    console.log("INTERLEAVING reconcile result (boot 1, watermark fails):", JSON.stringify(r1));
    check("(INTERLEAVING boot 1) watermark sub-counter at attempt 1, not escalated",
      dbInst.listStaleGenerationUnresolved().some((e) => e.sessionId === ctx.workerXId && e.watermark?.attempts === 1 && !e.watermark?.escalated));
    check("(INTERLEAVING boot 1) content-check top-level fields untouched (undefined — never reached)",
      dbInst.listStaleGenerationUnresolved().some((e) => e.sessionId === ctx.workerXId && e.kind === undefined && e.attempts === undefined && e.escalated === undefined));

    // Boot 2: repoint the watermark to "main" (resolves fine) — the content check now runs and hits the
    // corrupted subtree, a genuinely UNRELATED transient failure.
    dbInst.setMeta(mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "main", sha: ctx.genesisSha }));
    const r2 = await sessions.reconcileOrchestrationOnBoot(new Set());
    console.log("INTERLEAVING reconcile result (boot 2, content-check transient):", JSON.stringify(r2));
    check("(INTERLEAVING boot 2) content-check top-level fields now tracked: kind=transient, attempts=1, not escalated",
      dbInst.listStaleGenerationUnresolved().some((e) => e.sessionId === ctx.workerXId && e.kind === "transient" && e.attempts === 1 && !e.escalated));
    check("(INTERLEAVING boot 2) the watermark sub-counter is UNTOUCHED by this boot's content-check activity (still attempt 1 from boot 1)",
      dbInst.listStaleGenerationUnresolved().some((e) => e.sessionId === ctx.workerXId && e.watermark?.attempts === 1 && !e.watermark?.escalated));

    // Boot 3: revert the watermark to the ghost branch — watermark fails again. Its OWN attempts must
    // advance to 2 (continuing from boot 1, never from boot 2's unrelated content-check activity), and
    // the content-check's own fields from boot 2 must stay EXACTLY as they were (never touched — boot 3
    // never reaches the content check at all, since the watermark check short-circuits first).
    dbInst.setMeta(mainlineWatermarkKey(ctx.projId, "primary"), JSON.stringify({ branch: "ghost-branch-never-existed", sha: "0".repeat(40) }));
    const r3 = await sessions.reconcileOrchestrationOnBoot(new Set());
    console.log("INTERLEAVING reconcile result (boot 3, watermark fails again):", JSON.stringify(r3));
    check("(INTERLEAVING boot 3) watermark sub-counter advances to attempt 2 — continuing from boot 1, NOT boot 2",
      dbInst.listStaleGenerationUnresolved().some((e) => e.sessionId === ctx.workerXId && e.watermark?.attempts === 2 && !e.watermark?.escalated));
    check("(INTERLEAVING boot 3) content-check's own fields are byte-identical to what boot 2 left — untouched by this boot's watermark failure",
      dbInst.listStaleGenerationUnresolved().some((e) => e.sessionId === ctx.workerXId && e.kind === "transient" && e.attempts === 1 && !e.escalated));
    check("(INTERLEAVING) worker Y is still independently finalized, unaffected", dbInst.listEventsForWorker(ctx.workerYId).some((ev) => ev.kind === "merge_done"));
  } finally {
    try { dbInst?.close(); } catch { /* best-effort */ }
    for (const p of [R, dbPath]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
}

// --- UPGRADED_STORE: a row hand-seeded with NEITHER `kind` NOR `watermark` (predates 05915fc7 AND this
// card) must survive the extended type guard, not get silently dropped. Pure DB-level unit check — no
// real boot needed. ---
{
  const dbPath = path.join(os.tmpdir(), `loom-sgwu-upgrade-db-${sfx}.db`);
  let dbInst;
  try {
    dbInst = new Db(dbPath);
    const legacySessionId = `sgwu-upgrade-legacy-${sfx}`;
    const legacyRow = {
      sessionId: legacySessionId, branch: "loom/legacy", taskId: `sgwu-upgrade-task-${sfx}`, projectId: `sgwu-upgrade-proj-${sfx}`,
      reason: "pre-05915fc7 escalation, no kind field, no watermark field at all",
      firstDetectedAt: now, lastAttemptAt: now, attempts: 3, escalated: true,
      // deliberately NO `kind`, NO `watermark`
    };
    dbInst.setMeta("stale_generation_merge_unresolved", JSON.stringify([legacyRow]));

    const listed = dbInst.listStaleGenerationUnresolved();
    check("(UPGRADED_STORE) the legacy row survives — not dropped for lacking `kind` or `watermark`",
      listed.some((e) => e.sessionId === legacySessionId));
    check("(UPGRADED_STORE) `kind` defaults to 'definitive' (the only kind that ever existed pre-05915fc7)",
      listed.some((e) => e.sessionId === legacySessionId && e.kind === "definitive"));
    check("(UPGRADED_STORE) `watermark` stays absent (undefined), never fabricated into a default object",
      listed.some((e) => e.sessionId === legacySessionId && e.watermark === undefined));
    check("(UPGRADED_STORE) attempts/escalated/reason are preserved verbatim",
      listed.some((e) => e.sessionId === legacySessionId && e.attempts === 3 && e.escalated === true && e.reason === legacyRow.reason));

    // Now prove recordStaleGenerationWatermarkUnresolved can attach a FRESH watermark sub-entry onto this
    // exact legacy row without disturbing its own (legacy) content-check fields at all.
    const updated = dbInst.recordStaleGenerationWatermarkUnresolved(legacySessionId, { branch: "loom/legacy", taskId: legacyRow.taskId, projectId: legacyRow.projectId }, "a fresh watermark failure on a legacy row");
    check("(UPGRADED_STORE) a fresh watermark sighting attaches cleanly (attempt 1, not escalated)",
      updated.watermark.attempts === 1 && updated.watermark.escalated === false);
    check("(UPGRADED_STORE) the legacy content-check fields (attempts=3, escalated=true) are untouched by the watermark write",
      updated.attempts === 3 && updated.escalated === true && updated.kind === "definitive");
  } finally {
    try { dbInst?.close(); } catch { /* best-effort */ }
    try { fs.rmSync(dbPath, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// --- WATERMARK_ONLY_ESCALATE_SURVIVES (Code Review of 1fae1b98, Minor 1): calling the CONTENT-CHECK's
// own markStaleGenerationEscalated on a WATERMARK-ONLY row (no content fields at all) must be a no-op,
// never a write — writing `escalated:true` alone would make `anyContent` true while the other five
// content fields stay undefined, so the all-or-none type guard would drop the WHOLE row on the next
// read, including the already-escalated `watermark` sub-entry, making its own one-shot nudge re-fire.
// Pure DB-level unit check — no real boot needed. ---
{
  const dbPath = path.join(os.tmpdir(), `loom-sgwu-wmonly-db-${sfx}.db`);
  let dbInst;
  try {
    dbInst = new Db(dbPath);
    const sessionId = `sgwu-wmonly-${sfx}`;
    const ctx = { branch: "loom/wmonly", taskId: `sgwu-wmonly-task-${sfx}`, projectId: `sgwu-wmonly-proj-${sfx}` };
    dbInst.recordStaleGenerationWatermarkUnresolved(sessionId, ctx, "watermark failure, no content-check sighting ever");
    dbInst.markStaleGenerationWatermarkEscalated(sessionId); // the row's watermark sub-entry IS escalated...

    dbInst.markStaleGenerationEscalated(sessionId); // ...but THIS call must no-op: no content sighting exists for this session.

    const listed = dbInst.listStaleGenerationUnresolved();
    check("(WATERMARK_ONLY_ESCALATE_SURVIVES) the row survives the no-op call, not dropped",
      listed.some((e) => e.sessionId === sessionId));
    check("(WATERMARK_ONLY_ESCALATE_SURVIVES) the watermark sub-entry's OWN escalated:true is preserved",
      listed.some((e) => e.sessionId === sessionId && e.watermark?.escalated === true));
    check("(WATERMARK_ONLY_ESCALATE_SURVIVES) the top-level content fields stay absent (the no-op never fabricated any)",
      listed.some((e) => e.sessionId === sessionId && e.escalated === undefined && e.firstDetectedAt === undefined));
  } finally {
    try { dbInst?.close(); } catch { /* best-effort */ }
    try { fs.rmSync(dbPath, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

if (failures > 0) {
  console.error(`\n❌ ${failures} FAILURE(S)`);
  process.exit(1);
} else {
  console.log("\n✅ ALL PASS");
}
