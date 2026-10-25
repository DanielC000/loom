import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 26c12fac — a post-rebind ledger row must never seed a FOREIGN (old-repo) branch-gone-ledger
// boundary. From c13666c6's third Code Review (probe4 F): `resetMainlineBaselinesForRepoChange` clears
// a scope's `mainline_landed_commits` rows + its durable `gone-branch-ledger-boundary:*` app_meta key on
// a genuine repoPath change — but a confirm/batch that captured `repoPath` BEFORE the rebind and is still
// mid-flight can finish AFTER it, writing a ledger row with the OLD repo's shas. Since the table was just
// cleared, that late write re-seeds the boundary with a sha that never resolves in the NEW repo —
// `resolveGoneBranchLedgerBoundary` then returns it forever (write-if-absent, never re-seeded), and every
// later gone-branch lookup in the new repo reads "error" (never cached) until a human intervenes.
//
// REACHABLE: `checkRepoRebind` only refuses while a LIVE worktree session exists project-wide
// (`checkLiveWorktreeSessions`) — it has no notion of an in-flight merge. A worker's session can be
// EXITED with its worktree/branch RETAINED while a confirm/batch for it is still running (an
// already-tested pattern elsewhere: confirmworkermerge-reserved-home-guard.mjs, project-rebind.mjs
// (3b)/(3c)). Both ledger-write call sites (`confirmWorkerMerge`'s `repoPath`, `mergeBatchTracked`'s
// `finalRepoPath`) capture their repo path ONCE, early, and never re-read it before the eventual write.
//
// FIX: `SessionService.recordMainlineLedgerEntryIfRepoUnchanged` (service.ts) — the ONE chokepoint BOTH
// the solo and batch callers now route through — re-reads the project fresh and compares (via
// `literalRepoPathKey`, never raw `!==`) against the repoPath the caller captured; a mismatch skips the
// write (console.warn) rather than seeding a foreign boundary. Mirrors the pre-existing "repoPath
// reconfirmation against a rebind mid-flight" guard `advanceMainlineWatermark`/
// `advanceMainlineWatermarkForBatch` already have (decision c013e8a5) — see docs/decisions/26c12fac-*.md
// for why THIS guard uses `literalRepoPathKey` while the watermark's own guard still uses raw `!==`.
//
//   (a) Db-only fast repro, calling the new helper directly (bracket-notation — it is intentionally
//       private; there is no lighter-weight public surface for this exact mechanics): seed → rebind →
//       late write ⇒ boundary stays null and no row is written. Plus an ordinary (unchanged-repoPath)
//       control that still records, and a cosmetic-trailing-slash control that must still record
//       (literalRepoPathKey normalizes it — a raw `!==` would false-mismatch here). Round 2 (Code
//       Review 3f3a5d9d): also a NON-PRIMARY registry repoKey re-pathed mid-flight, and that same
//       registry entry REMOVED mid-flight (UnknownRepoKeyError) — each skipped, each with its own
//       unraced control, and the removed-key case also asserts the log line (grep-able by card id).
//   (b) Real-git SOLO and BATCH cases, injecting the rebind mid-flight via the existing
//       `soloMergeGitFactory`/`batchFfGitFactory` test seams (R3 pattern, mainline-watch-race-guards.mjs)
//       — deterministic, no wall-clock race. Each has an unchanged-repoPath control that still records.
//
// Run: 1) build (pnpm --filter @loom/daemon build), 2) node test/mainline-ledger-rebind-race.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { lateCommitBeforeSquashTarget } from "./_late-commit-seam.mjs";

useOwnLoomHome("loom-26c12fac-");

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { boundedSimpleGit } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");
const { awaitTrackedSettle } = await import("./_settle-tracked-monotonic.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const GIT_ID = "-c user.email=mlrr@loom -c user.name=mlrr";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

function mkRepo(tag) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), `loom-26c12fac-${tag}-`));
  registerForCleanup(r);
  execFileSync("git", GIT_ID.split(" ").filter(Boolean).concat(["init", "-q"]), { cwd: r });
  git(r, "checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(r, "seed.md"), `# ${tag}\n`);
  commitAll(r, `init ${tag}`, GIT_ID);
  return r;
}

const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const PASS = { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };

let sfx = 0;
const nextId = (tag) => `mlrr-${tag}-${Date.now()}-${++sfx}`;

try {
  // ══════════════════════ (a) Db-only fast repro, via the new helper directly ══════════════════════
  {
    const db = new Db();
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl());
    try {
      const pX = nextId("a-px");
      db.insertProject({ id: pX, name: "A-PX", repoPath: "/fake/repoA", vaultPath: "/fake/repoA", config: {}, createdAt: now, archivedAt: null });

      // Seed a genuine first-ever row (as if an earlier, unraced landing already happened).
      sessions["recordMainlineLedgerEntryIfRepoUnchanged"](pX, "primary", "/fake/repoA", "main", "tipA1", "baseA1");
      check("(a-setup) boundary seeded from the scope's first-ever row", db.resolveGoneBranchLedgerBoundary(pX, "primary") === "baseA1");

      // The rebind: clears the ledger + boundary for this scope (real resetMainlineBaselinesForRepoChange).
      db.updateProject(pX, { repoPath: "/fake/repoB" });
      check("(a-setup) the rebind cleared the boundary", db.resolveGoneBranchLedgerBoundary(pX, "primary") === null);

      // THE RACE: a confirm/batch that captured repoPath="/fake/repoA" BEFORE the rebind finishes AFTER it,
      // calling the new helper with its OWN (now-stale) captured repoPath.
      sessions["recordMainlineLedgerEntryIfRepoUnchanged"](pX, "primary", "/fake/repoA", "main", "tipA2", "baseA2");
      check("(a) FIX: the late write (stale repoPath) left the boundary cleanly null — no foreign-repo sha seeded",
        db.resolveGoneBranchLedgerBoundary(pX, "primary") === null);
      check("(a) FIX: the late write's row was never inserted at all", db.getGoneBranchLedgerMaxRowId(pX, "primary") === null);

      // CONTROL: an ordinary (unraced) repeat — repoPath passed matches the project's CURRENT repoPath —
      // must still record normally. Proves the guard isn't a blanket refusal.
      const pCtrl = nextId("a-pctrl");
      db.insertProject({ id: pCtrl, name: "A-PCTRL", repoPath: "/fake/repoA", vaultPath: "/fake/repoA", config: {}, createdAt: now, archivedAt: null });
      sessions["recordMainlineLedgerEntryIfRepoUnchanged"](pCtrl, "primary", "/fake/repoA", "main", "tipC1", "baseC1");
      check("(a) CONTROL: an unraced write (repoPath matches) records normally", db.resolveGoneBranchLedgerBoundary(pCtrl, "primary") === "baseC1");

      // COSMETIC-VARIANT CONTROL: a trailing-slash-only difference between the captured repoPath and the
      // project's stored one must NOT read as "changed" — literalRepoPathKey normalizes it away. A raw
      // `!==` comparison (like the watermark's own guard uses) would WRONGLY skip this write.
      const pVar = nextId("a-pvar");
      const varRepo = path.join(os.tmpdir(), `loom-26c12fac-var-${pVar}`);
      db.insertProject({ id: pVar, name: "A-PVAR", repoPath: varRepo, vaultPath: varRepo, config: {}, createdAt: now, archivedAt: null });
      sessions["recordMainlineLedgerEntryIfRepoUnchanged"](pVar, "primary", `${varRepo}${path.sep}`, "main", "tipV1", "baseV1");
      check("(a) COSMETIC CONTROL: a trailing-slash-only repoPath variant still records (literalRepoPathKey, not raw !==)",
        db.resolveGoneBranchLedgerBoundary(pVar, "primary") === "baseV1");

      // Captures every console.warn message fired during `fn()`, then restores console.warn — used below
      // to prove the round-2 (ii) case takes the SAME "mismatch" log line as an ordinary repoPath change,
      // not the generic "(fail-open)" catch text, per the manager's own round-2 nit.
      const captureWarnings = (fn) => {
        const real = console.warn, msgs = [];
        console.warn = (m) => msgs.push(String(m));
        try { fn(); } finally { console.warn = real; }
        return msgs;
      };

      // ROUND 2 (i): a NON-PRIMARY registry repoKey, RE-PATHED mid-flight — the identical race, scoped to
      // a `repos` entry rather than `repoPath`.
      const pSec = nextId("a-psec");
      const secOldPath = path.join(os.tmpdir(), `loom-26c12fac-sec-old-${pSec}`);
      const secNewPath = path.join(os.tmpdir(), `loom-26c12fac-sec-new-${pSec}`);
      db.insertProject({ id: pSec, name: "A-PSEC", repoPath: "/fake/primary", vaultPath: "/fake/primary", config: {}, createdAt: now, archivedAt: null });
      db.updateProject(pSec, { repos: [{ key: "sec", path: secOldPath }] });
      sessions["recordMainlineLedgerEntryIfRepoUnchanged"](pSec, "sec", secOldPath, "main", "tipS1", "baseS1");
      check("(a-repoKey setup) a non-primary repoKey's first row seeds its own boundary", db.resolveGoneBranchLedgerBoundary(pSec, "sec") === "baseS1");
      db.updateProject(pSec, { repos: [{ key: "sec", path: secNewPath }] }); // re-path "sec" only
      check("(a-repoKey setup) re-pathing the registry entry cleared ITS OWN boundary", db.resolveGoneBranchLedgerBoundary(pSec, "sec") === null);
      const warnsS = captureWarnings(() => sessions["recordMainlineLedgerEntryIfRepoUnchanged"](pSec, "sec", secOldPath, "main", "tipS2", "baseS2")); // stale path, captured before the re-path
      check("(a) FIX (non-primary repoKey re-pathed): the late write is skipped — boundary stays null", db.resolveGoneBranchLedgerBoundary(pSec, "sec") === null);
      check("(a) FIX (non-primary repoKey re-pathed): no row was written for this scope", db.getGoneBranchLedgerMaxRowId(pSec, "sec") === null);
      check("(a) FIX (non-primary repoKey re-pathed): logs the SAME mismatch line as a primary rebind (grep-able by card id)",
        warnsS.some((m) => m.includes("26c12fac") && m.includes("changed mid-flight")));

      // CONTROL: the identical shape, but the registry entry is never re-pathed — the second write must
      // still record.
      const pSecCtrl = nextId("a-psec-ctrl");
      const secCtrlPath = path.join(os.tmpdir(), `loom-26c12fac-sec-ctrl-${pSecCtrl}`);
      db.insertProject({ id: pSecCtrl, name: "A-PSEC-CTRL", repoPath: "/fake/primary", vaultPath: "/fake/primary", config: {}, createdAt: now, archivedAt: null });
      db.updateProject(pSecCtrl, { repos: [{ key: "sec", path: secCtrlPath }] });
      sessions["recordMainlineLedgerEntryIfRepoUnchanged"](pSecCtrl, "sec", secCtrlPath, "main", "tipSC1", "baseSC1");
      sessions["recordMainlineLedgerEntryIfRepoUnchanged"](pSecCtrl, "sec", secCtrlPath, "main", "tipSC2", "baseSC2");
      check("(a) CONTROL (non-primary repoKey unraced): with no re-path, the second write still records",
        db.getGoneBranchLedgerMaxRowId(pSecCtrl, "sec") !== null && db.resolveGoneBranchLedgerBoundary(pSecCtrl, "sec") === "baseSC1");

      // ROUND 2 (ii): that registry entry REMOVED entirely mid-flight — `resolveRepoByKey` now throws
      // `UnknownRepoKeyError` for "sec"; the helper's catch must take the SAME skip-as-mismatch branch.
      const pRem = nextId("a-prem");
      const remPath = path.join(os.tmpdir(), `loom-26c12fac-rem-${pRem}`);
      db.insertProject({ id: pRem, name: "A-PREM", repoPath: "/fake/primary", vaultPath: "/fake/primary", config: {}, createdAt: now, archivedAt: null });
      db.updateProject(pRem, { repos: [{ key: "sec", path: remPath }] });
      sessions["recordMainlineLedgerEntryIfRepoUnchanged"](pRem, "sec", remPath, "main", "tipR1", "baseR1");
      check("(a-repoKey-removed setup) seeded a boundary for the registry entry", db.resolveGoneBranchLedgerBoundary(pRem, "sec") === "baseR1");
      db.updateProject(pRem, { repos: [] }); // remove "sec" entirely
      check("(a-repoKey-removed setup) removing the registry entry cleared its boundary", db.resolveGoneBranchLedgerBoundary(pRem, "sec") === null);
      const warnsR = captureWarnings(() => sessions["recordMainlineLedgerEntryIfRepoUnchanged"](pRem, "sec", remPath, "main", "tipR2", "baseR2")); // stale path; "sec" no longer resolves at all now
      check("(a) FIX (repoKey removed): a late write for a now-unknown repoKey is skipped — boundary stays null", db.resolveGoneBranchLedgerBoundary(pRem, "sec") === null);
      check("(a) FIX (repoKey removed): no row was written for this now-gone scope", db.getGoneBranchLedgerMaxRowId(pRem, "sec") === null);
      check("(a) FIX (repoKey removed): logs the SAME mismatch line (naming 'no longer registered'), never the generic fail-open text",
        warnsR.some((m) => m.includes("26c12fac") && m.includes("changed mid-flight") && m.includes("no longer registered"))
        && !warnsR.some((m) => m.includes("(fail-open)")));

      // CONTROL for removal: the identical shape, but the registry entry is never removed — the second
      // write must still record.
      const pRemCtrl = nextId("a-prem-ctrl");
      const remCtrlPath = path.join(os.tmpdir(), `loom-26c12fac-rem-ctrl-${pRemCtrl}`);
      db.insertProject({ id: pRemCtrl, name: "A-PREM-CTRL", repoPath: "/fake/primary", vaultPath: "/fake/primary", config: {}, createdAt: now, archivedAt: null });
      db.updateProject(pRemCtrl, { repos: [{ key: "sec", path: remCtrlPath }] });
      sessions["recordMainlineLedgerEntryIfRepoUnchanged"](pRemCtrl, "sec", remCtrlPath, "main", "tipRC1", "baseRC1");
      sessions["recordMainlineLedgerEntryIfRepoUnchanged"](pRemCtrl, "sec", remCtrlPath, "main", "tipRC2", "baseRC2");
      check("(a) CONTROL (repoKey not removed): with no removal, the second write still records",
        db.getGoneBranchLedgerMaxRowId(pRemCtrl, "sec") !== null && db.resolveGoneBranchLedgerBoundary(pRemCtrl, "sec") === "baseRC1");
    } finally {
      db.close();
    }
  }

  // ══════════════════════ (b) real-git SOLO case ══════════════════════
  {
    const db = new Db();
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => PASS });
    try {
      const repoA = mkRepo("solo-old");
      const repoB = mkRepo("solo-new");
      const pSolo = nextId("b-solo"), agentId = nextId("b-solo-agent"), mgrId = nextId("b-solo-mgr");
      db.insertProject({ id: pSolo, name: "B-SOLO", repoPath: repoA, vaultPath: repoA, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
      db.insertAgent({ id: agentId, projectId: pSolo, name: "t", startupPrompt: "", position: 0 });
      db.insertSession({ id: mgrId, projectId: pSolo, agentId, engineSessionId: null, title: null, cwd: repoA, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

      const addWorker = async (tag) => {
        const taskId = nextId(`b-solo-task-${tag}`), workerId = nextId(`b-solo-wkr-${tag}`);
        db.insertTask({ id: taskId, projectId: pSolo, title: `feat(x): ${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
        const { worktreePath, branch } = await createWorktree(repoA, pSolo, taskId);
        registerForCleanup(worktreePath);
        fs.writeFileSync(path.join(worktreePath, `${tag}.txt`), `${tag}\n`);
        commitAll(worktreePath, `feat(x): ${tag}`, GIT_ID);
        db.insertSession({ id: workerId, projectId: pSolo, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
        return { taskId, workerId, worktreePath, branch };
      };

      // WARM-UP: a (project, repoKey)'s genuine FIRST-EVER landing writes NO ledger row at all — only
      // the second and later landings do (decision c13666c6's own "named quirk": `expectedMainlineBranch`
      // is resolved before THIS SAME confirm's own watermark gets established on first sight). So the
      // boundary-seeding assertion below needs a throwaway warm-up landing ahead of it, same as every
      // round-2 test of c13666c6 itself does.
      const warm = await addWorker("warm");
      await sessions.confirmWorkerMerge(mgrId, warm.workerId);

      // ORDINARY landing (no race) — this is the scope's genuine FIRST ledger row, seeding the boundary.
      const w1 = await addWorker("w1");
      const confirm1 = await sessions.confirmWorkerMerge(mgrId, w1.workerId);
      check("(b-solo setup) the first (unraced) landing succeeded", confirm1.merged === true);
      const boundaryAfter1 = db.resolveGoneBranchLedgerBoundary(pSolo, "primary");
      check("(b-solo setup) it seeded a genuine boundary", typeof boundaryAfter1 === "string" && boundaryAfter1.length > 0);

      // THE RACE: a SECOND landing captures repoPath=repoA at confirm-start; a rebind to repoB lands
      // mid-flight (injected deterministically at mergeBranchLocked's own squash-target resolve — the
      // exact instant AFTER repoPath was captured and BEFORE the ledger write at service.ts:21386).
      const w2 = await addWorker("w2");
      let rebindRan = false;
      sessions.soloMergeGitFactory = lateCommitBeforeSquashTarget(w2.branch, () => { db.updateProject(pSolo, { repoPath: repoB }); rebindRan = true; });
      const confirm2 = await sessions.confirmWorkerMerge(mgrId, w2.workerId);
      sessions.soloMergeGitFactory = undefined;

      check("(b-solo) setup control: the rebind genuinely ran mid-flight", rebindRan === true);
      check("(b-solo) the landing ITSELF still succeeded against the OLD repo (the race doesn't break the merge)", confirm2.merged === true);
      check("(b-solo) the project really is rebound now", db.getProject(pSolo).repoPath === repoB);
      check("(b-solo) FIX: the boundary was NOT re-seeded with a foreign (old-repo) sha — stays null",
        db.resolveGoneBranchLedgerBoundary(pSolo, "primary") === null);
      check("(b-solo) FIX: the late landing's ledger row was never written for this (now foreign) scope",
        db.getGoneBranchLedgerMaxRowId(pSolo, "primary") === null);

      // CONTROL: the identical two-landing shape, but with NO rebind at all — the second landing must
      // still record normally (proves the fix isn't a blanket refusal of the second landing).
      const repoC = mkRepo("solo-ctrl");
      const pCtrl = nextId("b-solo-ctrl"), agentIdC = nextId("b-solo-ctrl-agent"), mgrIdC = nextId("b-solo-ctrl-mgr");
      db.insertProject({ id: pCtrl, name: "B-SOLO-CTRL", repoPath: repoC, vaultPath: repoC, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
      db.insertAgent({ id: agentIdC, projectId: pCtrl, name: "t", startupPrompt: "", position: 0 });
      db.insertSession({ id: mgrIdC, projectId: pCtrl, agentId: agentIdC, engineSessionId: null, title: null, cwd: repoC, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
      const addCtrlWorker = async (tag) => {
        const taskId = nextId(`b-solo-ctrl-task-${tag}`), workerId = nextId(`b-solo-ctrl-wkr-${tag}`);
        db.insertTask({ id: taskId, projectId: pCtrl, title: `feat(x): ${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
        const { worktreePath, branch } = await createWorktree(repoC, pCtrl, taskId);
        registerForCleanup(worktreePath);
        fs.writeFileSync(path.join(worktreePath, `${tag}.txt`), `${tag}\n`);
        commitAll(worktreePath, `feat(x): ${tag}`, GIT_ID);
        db.insertSession({ id: workerId, projectId: pCtrl, agentId: agentIdC, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrIdC, taskId, worktreePath, branch });
        return { taskId, workerId };
      };
      const warmC = await addCtrlWorker("warm");
      await sessions.confirmWorkerMerge(mgrIdC, warmC.workerId);
      const c1 = await addCtrlWorker("c1");
      await sessions.confirmWorkerMerge(mgrIdC, c1.workerId);
      const boundaryAfterC1 = db.resolveGoneBranchLedgerBoundary(pCtrl, "primary");
      check("(b-solo) CONTROL setup: c1 (the scope's genuine first row) seeded a boundary", typeof boundaryAfterC1 === "string" && boundaryAfterC1.length > 0);
      const ctrlRowAfter1 = db.getGoneBranchLedgerMaxRowId(pCtrl, "primary");
      const c2 = await addCtrlWorker("c2");
      const confirmC2 = await sessions.confirmWorkerMerge(mgrIdC, c2.workerId);
      check("(b-solo) CONTROL: with no rebind, the second landing succeeds and records a NEW row",
        confirmC2.merged === true && db.getGoneBranchLedgerMaxRowId(pCtrl, "primary") > ctrlRowAfter1);
      check("(b-solo) CONTROL: with no rebind, the boundary stays the genuine first-row sha (write-once, unchanged by c2)",
        db.resolveGoneBranchLedgerBoundary(pCtrl, "primary") === boundaryAfterC1);
    } finally {
      db.close();
    }
  }

  // ══════════════════════ (b) real-git BATCH case ══════════════════════
  {
    const db = new Db();
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: async () => PASS });
    try {
      const repoA = mkRepo("batch-old");
      const repoB = mkRepo("batch-new");
      const pBatch = nextId("b-batch"), agentId = nextId("b-batch-agent"), mgrId = nextId("b-batch-mgr");
      db.insertProject({ id: pBatch, name: "B-BATCH", repoPath: repoA, vaultPath: repoA, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
      db.insertAgent({ id: agentId, projectId: pBatch, name: "t", startupPrompt: "", position: 0 });
      db.insertSession({ id: mgrId, projectId: pBatch, agentId, engineSessionId: null, title: null, cwd: repoA, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

      const addWorker = async (tag) => {
        const taskId = nextId(`b-batch-task-${tag}`), workerId = nextId(`b-batch-wkr-${tag}`);
        db.insertTask({ id: taskId, projectId: pBatch, title: `feat(x): ${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
        const { worktreePath, branch } = await createWorktree(repoA, pBatch, taskId);
        registerForCleanup(worktreePath);
        fs.writeFileSync(path.join(worktreePath, `${tag}.txt`), `${tag}\n`);
        commitAll(worktreePath, `feat(x): ${tag}`, GIT_ID);
        db.insertSession({ id: workerId, projectId: pBatch, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });
        return { taskId, workerId };
      };

      // WARM-UP (same c13666c6 quirk as the solo case above): the scope's genuine first-ever landing
      // writes no ledger row at all — the second one does.
      const warm = await addWorker("warm");
      await awaitTrackedSettle(() => sessions.confirmWorkerMergeTracked(mgrId, warm.workerId), { label: "confirmWorkerMergeTracked (warm-up)", timeoutMs: 120_000, pendingOps: sessions.pendingOps });

      // ORDINARY solo landing (no race) — this IS the scope's genuine first ledger row, seeding the boundary.
      const seed = await addWorker("seed");
      const seedConfirm = await awaitTrackedSettle(() => sessions.confirmWorkerMergeTracked(mgrId, seed.workerId), { label: "confirmWorkerMergeTracked", timeoutMs: 120_000, pendingOps: sessions.pendingOps });
      check("(b-batch setup) the seed landing settled", seedConfirm.settled === true && seedConfirm.ok === true);
      check("(b-batch setup) it seeded a genuine boundary", typeof db.resolveGoneBranchLedgerBoundary(pBatch, "primary") === "string");

      // THE RACE: a batch of two candidates captures finalRepoPath=repoA at mint; a rebind to repoB lands
      // mid-flight — injected deterministically on the FIRST real git call made through the batch's own
      // `batchFfGitFactory` (fires once, before every subsequent call, including the ledger-write's own
      // caller resolving `finalRepoPath`/`baseMainSha`).
      const k = await addWorker("k"), l = await addWorker("l");
      let rebindRan = false;
      sessions.batchFfGitFactory = (repoPath, blockTimeoutMs) => {
        const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
        let fired = false;
        return {
          raw: async (args) => {
            if (!fired) { fired = true; db.updateProject(pBatch, { repoPath: repoB }); rebindRan = true; }
            return real.raw(args);
          },
        };
      };
      const batchResult = await awaitTrackedSettle(() => sessions.mergeBatchTracked(mgrId, [k.workerId, l.workerId]), { label: "mergeBatchTracked", timeoutMs: 120_000, pendingOps: sessions.pendingOps });
      sessions.batchFfGitFactory = undefined;

      check("(b-batch) setup control: the rebind genuinely ran mid-flight", rebindRan === true);
      check("(b-batch) settled ok", batchResult.settled === true && batchResult.ok === true);
      check("(b-batch) the batch landing ITSELF still succeeded against the OLD repo", batchResult.value?.landed?.length === 2);
      check("(b-batch) the project really is rebound now", db.getProject(pBatch).repoPath === repoB);
      check("(b-batch) FIX: the boundary was NOT re-seeded with a foreign (old-repo) sha — stays null",
        db.resolveGoneBranchLedgerBoundary(pBatch, "primary") === null);
      check("(b-batch) FIX: the late batch landing's ledger row was never written for this (now foreign) scope",
        db.getGoneBranchLedgerMaxRowId(pBatch, "primary") === null);

      // CONTROL: the identical shape, but with NO rebind at all — the batch landing must still record.
      const repoC = mkRepo("batch-ctrl");
      const pCtrl = nextId("b-batch-ctrl"), agentIdC = nextId("b-batch-ctrl-agent"), mgrIdC = nextId("b-batch-ctrl-mgr");
      db.insertProject({ id: pCtrl, name: "B-BATCH-CTRL", repoPath: repoC, vaultPath: repoC, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
      db.insertAgent({ id: agentIdC, projectId: pCtrl, name: "t", startupPrompt: "", position: 0 });
      db.insertSession({ id: mgrIdC, projectId: pCtrl, agentId: agentIdC, engineSessionId: null, title: null, cwd: repoC, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
      const addCtrlWorker = async (tag) => {
        const taskId = nextId(`b-batch-ctrl-task-${tag}`), workerId = nextId(`b-batch-ctrl-wkr-${tag}`);
        db.insertTask({ id: taskId, projectId: pCtrl, title: `feat(x): ${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
        const { worktreePath, branch } = await createWorktree(repoC, pCtrl, taskId);
        registerForCleanup(worktreePath);
        fs.writeFileSync(path.join(worktreePath, `${tag}.txt`), `${tag}\n`);
        commitAll(worktreePath, `feat(x): ${tag}`, GIT_ID);
        db.insertSession({ id: workerId, projectId: pCtrl, agentId: agentIdC, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrIdC, taskId, worktreePath, branch });
        return { taskId, workerId };
      };
      const warmC = await addCtrlWorker("warm");
      await awaitTrackedSettle(() => sessions.confirmWorkerMergeTracked(mgrIdC, warmC.workerId), { label: "confirmWorkerMergeTracked (warm-up)", timeoutMs: 120_000, pendingOps: sessions.pendingOps });
      const seedC = await addCtrlWorker("seed");
      await awaitTrackedSettle(() => sessions.confirmWorkerMergeTracked(mgrIdC, seedC.workerId), { label: "confirmWorkerMergeTracked", timeoutMs: 120_000, pendingOps: sessions.pendingOps });
      const ctrlRowAfterSeed = db.getGoneBranchLedgerMaxRowId(pCtrl, "primary");
      check("(b-batch) CONTROL setup: seedC (the scope's genuine first row) seeded a boundary", typeof db.resolveGoneBranchLedgerBoundary(pCtrl, "primary") === "string");
      const kC = await addCtrlWorker("k"), lC = await addCtrlWorker("l");
      const ctrlBatchResult = await awaitTrackedSettle(() => sessions.mergeBatchTracked(mgrIdC, [kC.workerId, lC.workerId]), { label: "mergeBatchTracked", timeoutMs: 120_000, pendingOps: sessions.pendingOps });
      check("(b-batch) CONTROL: with no rebind, the batch lands and records a NEW row",
        ctrlBatchResult.ok === true && ctrlBatchResult.value?.landed?.length === 2 && db.getGoneBranchLedgerMaxRowId(pCtrl, "primary") > ctrlRowAfterSeed);
    } finally {
      db.close();
    }
  }
} finally {
  // nothing further to release; each section closed its own Db above.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a post-rebind late ledger write is dropped (never seeds a foreign boundary) on both the solo and batch paths, via the new repoPath-reconfirmation guard; an unraced landing still records normally in every case."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
