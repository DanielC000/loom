import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 59d2577a — the mainline-move tripwire (card 4fa36502, docs/decisions/4fa36502-mainline-move-tripwire.md) on `merge_batch`. REAL git on temp repos, an injected
// always-green `runGate` seam, the real `mergeBatchTracked`. (Boot lives in mainline-watch-boot.mjs — split so each file stays fast.)
//
//   (B4)  TOCTOU: main moves AFTER the batch's check but BEFORE its fast-forward ⇒ the batch forfeits and the move is NOT absorbed: reported exactly once.
//   (B5)  FAIL-OPEN: a failing reader ⇒ the batch lands exactly as today, no event, watermark not advanced past the unverified move; the next landing catches it.
//   (B6)  card 787dd2a7 round 2 — DEFER: a TRANSIENT first-sight default-branch resolver failure never seeds AND never declines (no event, no nudge); the very
//         next landing, once the resolver is healthy again, seeds normally.
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/mainline-watch-batch-edges.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-mw-edges-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { boundedSimpleGit } = await import("../dist/git/bounded.js");
const { nonInteractiveEnv } = await import("../dist/git/writer.js");
const { awaitTrackedSettle } = await import("./_settle-tracked-monotonic.mjs");
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
const PASS = { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };

const P = { projId: `mwbe-proj-${sfx}`, agentId: `mwbe-agent-${sfx}`, mgrId: `mwbe-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mwbe-repo-${sfx}`) };
fs.mkdirSync(P.repo, { recursive: true }); registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# mwbb\n");
git(P.repo, "init", "-q"); git(P.repo, "config", "core.autocrlf", "false"); git(P.repo, "config", "user.email", "mw@loom"); git(P.repo, "config", "user.name", "mw");
commitAll(P.repo, "init", GIT_ID);
const MAIN = git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const MAINREF = `refs/heads/${MAIN}`;
const canonHead = () => git(P.repo, "rev-parse", "HEAD");

/** One "daemon": a Db on the shared LOOM_HOME + a SessionService with an always-green gate. `nudges` records mainline nudges. */
function boot() {
  const db = new Db();
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => PASS, reapWorktreeProcesses: noReap });
  const nudges = [];
  const orig = sessions.enqueueDurableMessage.bind(sessions);
  sessions.enqueueDurableMessage = (target, text, ...rest) => { if (String(text).startsWith("[loom:mainline-moved]")) nudges.push(text); return orig(target, text, ...rest); };
  return { db, sessions, nudges };
}
let d1 = boot();
d1.db.insertProject({ id: P.projId, name: "MWBB", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
d1.db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
d1.db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

let seq = 0;
async function addWorker(db, tag) {
  const n = `${tag}${++seq}`;
  const taskId = `mwbe-${n}-task-${sfx}`, workerId = `mwbe-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  fs.mkdirSync(path.join(worktreePath, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "src", `${n}.ts`), `export const ${tag}${seq} = ${seq};\n`);
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch, tip: git(worktreePath, "rev-parse", "HEAD") };
}
// Card 7aeaeedd: await the REAL settle (`awaitTrackedSettle`, same shared helper
// cut-base-sha-confirm-and-batch.mjs uses) rather than taking a possible `{settled:false, op}` FIRST
// result as final — a real `mergeBatchTracked`/`confirmWorkerMergeTracked` call can legitimately degrade
// to that shape once `syncAttachBudgetMs` elapses before the real batch assembly + gate + fallback
// landings finish, a documented, supported async path (orchestration/pending-ops.ts), never a failure.
// The ORIGINAL unguarded `r.settled && r.ok ? r.value : {__unsettled:r}` measured the host's speed, not
// the code: under load it could return `{__unsettled:r}` (r.ok === undefined) for a batch that was still
// correctly forfeiting in the background, failing a `r4.ok === false` assertion for a reason that had
// nothing to do with forfeit detection — confirmed directly by instrumenting a real run of (B4): the
// injected move landed exactly once, deterministically, before the forfeit check's own read, and the
// batch still "FAIL"ed only because `batch()` gave up on the first unsettled poll.
// `timeoutMs: 240_000` (not the helper's own 60s default) — matches the precedent several
// confirmWorkerMergeTracked-polling siblings already use (merge-confirm-branch-tip-unresolvable.mjs,
// merge-confirm-inert-skip-pin.mjs) for a REAL tracked call under real git conditions; a batch's own
// forfeit-and-fallback path here runs TWO full solo squash landings on top of the batch assembly + gate,
// which can legitimately exceed the default 60s under host contention (measured: a 60s budget threw here).
const batch = async (d, ws) => { const r = await awaitTrackedSettle(() => d.sessions.mergeBatchTracked(P.mgrId, ws.map((w) => w.workerId)), { label: "mergeBatchTracked", timeoutMs: 240_000, pendingOps: d.sessions.pendingOps }); return r.ok ? r.value : { __unsettled: r }; };
const confirm = async (d, w) => { const r = await awaitTrackedSettle(() => d.sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId), { label: "confirmWorkerMergeTracked", timeoutMs: 240_000, pendingOps: d.sessions.pendingOps }); return r.ok ? r.value : { __unsettled: r }; };
const mwEvents = (d) => d.db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === P.projId);
const watermark = (d) => MW.parseMainlineWatermark(d.db.getMeta(MW.mainlineWatermarkKey(P.projId, "primary")));
const bypass = (w) => { git(w.worktreePath, "update-ref", MAINREF, w.tip); git(P.repo, "reset", "-q", "--hard"); };

try {
  // setup: one solo landing so the repo has a watermark (a fresh project's first sight is silent)
  const s0 = await addWorker(d1.db, "s");
  await confirm(d1, s0);
  check("(setup) the first landing initialised the watermark silently", watermark(d1)?.sha === canonHead() && mwEvents(d1).length === 0);

  // ── (B4) TOCTOU: main moves AFTER the check, BEFORE the fast-forward ───────
  {
    const k = await addWorker(d1.db, "k"), l = await addWorker(d1.db, "l"), m = await addWorker(d1.db, "m"), n = await addWorker(d1.db, "n");
    const before = mwEvents(d1).length;
    // Card 7aeaeedd: deterministic injection, no wall-clock race. The PRIOR version hooked
    // `mainlineFactsReader` (consulted inside `checkMainlineMove`, itself raced by `boundedByDeadline`
    // against a ~30s deadline with only a 100ms grace past it) and performed the raw move from inside that
    // hook, after awaiting the real reader. Under host contention the two `execFileSync` git spawns doing
    // the raw move could outlast that 100ms grace, so `boundedByDeadline` returned early (fail-open) while
    // the move kept running in the background — landing it AFTER, not before, the batch's own
    // fast-forward read. That let the fast-forward observe the PRE-move tip and succeed instead of
    // forfeiting: a test-synchronization race (seen flaking twice, both under load, card 7aeaeedd), not a
    // product gap. Fixed by injecting through the SAME `batchFfGitFactory` test seam
    // batch-merge-mainline-advanced-post-ff.mjs uses: intercept the SECOND combined `rev-parse HEAD
    // --symbolic-full-name HEAD` read inside `fastForwardCanonicalMain` (the END-OF-GATE forfeit check's
    // own read, git/batch-merge.ts) and perform the raw move synchronously BEFORE delegating to the real
    // git call — the read is then GUARANTEED to observe the moved tip, with no deadline machinery involved
    // at all. Card 627b38c7: the FIRST occurrence is now mergeBatchTracked's own NEW admission-time
    // forfeit check, which must see the UNCHANGED state so the real gate still runs; only the SECOND
    // occurrence (reached once the gate has genuinely passed) is the one this scenario injects the move into.
    let combinedCalls = 0;
    const batchFfGitFactory = (repoPath, blockTimeoutMs) => {
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      return {
        raw: async (args) => {
          if (Array.isArray(args) && args[0] === "rev-parse" && args.includes("--symbolic-full-name")) {
            combinedCalls++;
            if (combinedCalls === 2) bypass(k); // raw move lands inside the end-of-gate forfeit check's own read, before it resolves
          }
          return real.raw(args);
        },
      };
    };
    const realBatchFfGitFactory = d1.sessions.batchFfGitFactory;
    d1.sessions.batchFfGitFactory = batchFfGitFactory;
    const r4 = await batch(d1, [l, m]);
    d1.sessions.batchFfGitFactory = realBatchFfGitFactory;
    check("(B4) setup control: the injected move fired exactly once, from inside the end-of-gate forfeit check's own read (deterministic — no race)", combinedCalls === 2);
    // `combinedCalls === 2` only proves the HOOK fired, not that `bypass(k)`'s own raw git calls actually
    // LANDED — a hook that fired but whose bypass silently failed (e.g. a transient git error swallowed by
    // nothing, since bypass() doesn't check its own exit codes) would otherwise pass this control and then
    // fail the forfeit check below for the WRONG reason (main never having moved at all, not a detection
    // gap). Restore the original ancestry control alongside it: the raw-written tip must actually be main's
    // history by now.
    check("(B4) setup control: the raw-written tip actually landed on main (the hook firing is not proof the bypass itself succeeded)",
      (() => { try { git(P.repo, "merge-base", "--is-ancestor", k.tip, "HEAD"); return true; } catch { return false; } })());
    check("(B4) the batch FORFEITED (main moved since it was cut): it landed nothing itself (its candidates fall back to solo landings)", r4.ok === false && (r4.landed?.length ?? 0) === 0);
    const o = await addWorker(d1.db, "o");
    await confirm(d1, o);
    // Dropping the old human2.txt forcing-commit (no longer needed now the move is injected via
    // batchFfGitFactory, not mainlineFactsReader) changes WHICH checkMainlineMove call first observes the
    // mismatch — the batch's own PRE-ff call now sees watermark===HEAD (main hasn't moved yet) and skips
    // silently — but not THAT it's observed: watermark stays pinned to s0's sha (unchanged) while the raw
    // move already sits on main by the time l's/m's fallback squash runs its own checkMainlineMove (via
    // confirmWorkerMergeTracked), so the SAME real (unmocked) mainlineFactsReader classifies it there
    // instead, exactly once, before the next confirm's own check could duplicate it.
    const ev4 = mwEvents(d1).slice(before);
    // Select by the distinguishing attribute that actually matters (round 19's own freeze source), never
    // by evidence string — the move's own evidence tag depends on exactly which commit relationship it
    // measures at classification time and isn't worth guessing at here.
    const moveEv4 = ev4.find((ev) => ev.detail.source !== "landing-trust-freeze");
    const freezeEv4 = ev4.find((ev) => ev.detail.source === "landing-trust-freeze");
    check("(B4) the move is NOT absorbed by the batch: across the forfeit's fallback landings and the next confirm it is reported exactly ONCE by checkMainlineMove's own classifier, naming the raw-written tip", ev4.length === 2 && moveEv4?.detail.suspectShas?.includes(k.tip) && moveEv4.detail.to === k.tip);
    // @decision 2a6a292a round 19 (card aa7677fa) — a SEPARATE landing-trust-freeze event also fires once
    // in this window: trust (established at the setup landing above) still doesn't match the first
    // fallback's own checked tip (the TOCTOU-injected k.tip), so `advanceMainlineWatermark` declines to
    // re-stamp it; every later landing in this window dedupes on the same frozen `from`.
    check("(B4) THE ACCEPTED COST: a separate landing-trust-freeze event also fires once, HIGH, untrusted-tip-mismatch", freezeEv4?.detail.severity === "high" && freezeEv4.detail.evidence?.includes("untrusted-tip-mismatch"));
    void n;
  }

  // ── (B5) fail-open ─────────────────────────────────────────────────────────
  {
    const p = await addWorker(d1.db, "p"), q = await addWorker(d1.db, "q"), s = await addWorker(d1.db, "s"), t = await addWorker(d1.db, "t");
    bypass(p);
    const before = mwEvents(d1).length, realReader = d1.sessions.mainlineFactsReader;
    d1.sessions.mainlineFactsReader = async () => { throw new Error("injected reader failure"); };
    const r5 = await batch(d1, [q, s]);
    d1.sessions.mainlineFactsReader = realReader;
    check("(B5) a failing reader ⇒ the batch lands exactly as today (never a refusal), NO event", r5.ok === true && mwEvents(d1).length === before);
    check("(B5) the watermark was NOT advanced past the unverified move", watermark(d1)?.sha !== canonHead());
    const u = await addWorker(d1.db, "u");
    await confirm(d1, u);
    check("(B5) the very next landing (reader restored) still catches it: one new event", mwEvents(d1).length === before + 1);
    void t;
  }

  // ── (B6) card 787dd2a7 round 2 — DEFER: a TRANSIENT resolver failure never seeds AND never declines ──
  {
    const key = MW.mainlineWatermarkKey(P.projId, "primary");
    d1.db.deleteMeta(key); // force true first sight
    const v = await addWorker(d1.db, "v"), w = await addWorker(d1.db, "w");
    const before = mwEvents(d1).length, nudgesBefore = d1.nudges.length;
    const realResolver = d1.sessions.resolveMainlineBranchStateReader;
    d1.sessions.resolveMainlineBranchStateReader = async () => ({ state: "failed" });
    const r6 = await batch(d1, [v, w]);
    d1.sessions.resolveMainlineBranchStateReader = realResolver;
    check("(B6) the batch STILL lands despite the transient resolver failure (never a refusal)", r6.ok === true && r6.landed?.length === 2);
    check("(B6) DEFER: no event, no nudge, and the watermark is left UNSEEDED (neither declined nor seeded)", mwEvents(d1).length === before && d1.nudges.length === nudgesBefore && watermark(d1) === null);

    // control: the SAME still-absent state, resolver restored (no transient failure) — the very next
    // landing seeds normally, proving the defer is a retry, not a permanent block.
    const x = await addWorker(d1.db, "x");
    await confirm(d1, x);
    check("(B6) control: the next landing (resolver healthy) seeds normally once the transient failure clears", watermark(d1)?.sha === canonHead());
  }

} finally {
  try { d1.db.close(); } catch { /* already closed */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the batch tripwire is TOCTOU-safe and fail-open."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
