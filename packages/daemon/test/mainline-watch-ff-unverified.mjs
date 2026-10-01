import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b801bad0 (fix round) — Code Review MINOR 2: an `unverified` batch fast-forward (the `--ff-only`
// itself did not throw, but the POST-ff re-read that confirms where it landed failed — see
// `FastForwardResult.unverified`, git/batch-merge.ts) does NOT advance the mainline watermark
// (`advanceMainlineWatermarkForBatch` is gated on `result.ok`, which is `false` for this outcome too —
// sessions/service.ts). This file proves that gap does NOT make the tripwire (card 4fa36502,
// docs/decisions/4fa36502-mainline-move-tripwire.md) misfire a FALSE `mainline_moved_outside_loom` alert
// on the NEXT check, even though the watermark is left stale pointing at the PRE-landing sha.
//
// Mechanism under test: a genuinely-landed batch (proper `Loom-Worker-Branch` trailers, a porcelain
// `--ff-only` reflog message) whose watermark advance was skipped reads, on the next check, as an ordinary
// EXPLAINED forward move — the first-parent range W..tip is entirely trailered and the reflog entry is
// porcelain, so `classifyMainlineMove` returns "explained", not "alert" — and the watermark self-corrects
// to the real tip. Rather than engineering the exact unverified code path through the full
// `mergeBatchTracked` stack (no seam exists to fail only the POST-ff re-read inside the real service
// flow), this drives a REAL batch landing via `mergeBatchTracked` and then manually rewinds the STORED
// watermark back to its pre-landing value — the exact observable state `unverified` leaves behind (main
// moved, watermark did not) — before calling `checkMainlineMove` again. This is the real mechanism
// `unverified`'s own doc relies on, not a simulation of the gating logic itself (that gating is proven
// directly by batch-merge-canonical-branch-divert.mjs's own `unverified` scenario).
//
//   (U1) a real batch lands normally (control) — the watermark advances to the landed tip, as always.
//   (U2) rewind the STORED watermark back to the pre-landing sha — the exact state an `unverified` outcome
//        would have left (main moved, watermark did not).
//   (U3) the NEXT checkMainlineMove call reads the real (already-landed, already-trailered) range as
//        EXPLAINED, not an alert: no event, no nudge — and the watermark catches up to the real tip.
//   (U4) NEGATIVE CONTROL — same rewind, but with the trailer on the landed commit stripped first (so the
//        first-parent range is genuinely untrailered): THIS instead alerts `reflog-raw-write`-shaped
//        (if the write looks raw) or at minimum is distinguishable from (U3)'s silence, confirming the
//        check actually discriminates rather than being silent unconditionally.
//
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/mainline-watch-ff-unverified.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-mw-ffunv-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const MW = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "mwu", GIT_AUTHOR_EMAIL: "mwu@loom", GIT_COMMITTER_NAME: "mwu", GIT_COMMITTER_EMAIL: "mwu@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=mwu@loom -c user.name=mwu";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const PASS = { passed: true, steps: [{ step: "gate", durationMs: 1, status: 0 }] };

const P = { projId: `mwu-proj-${sfx}`, agentId: `mwu-agent-${sfx}`, mgrId: `mwu-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mwu-repo-${sfx}`) };
fs.mkdirSync(P.repo, { recursive: true }); registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# mwu\n");
git(P.repo, "init", "-q"); git(P.repo, "config", "core.autocrlf", "false"); git(P.repo, "config", "user.email", "mwu@loom"); git(P.repo, "config", "user.name", "mwu");
commitAll(P.repo, "init", GIT_ID);
const MAIN = git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const MAINREF = `refs/heads/${MAIN}`;
const canonHead = () => git(P.repo, "rev-parse", "HEAD");

const db = new Db();
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => PASS, reapWorktreeProcesses: noReap });
const nudges = [];
const origEnqueue = sessions.enqueueDurableMessage.bind(sessions);
sessions.enqueueDurableMessage = (target, text, ...rest) => { if (String(text).startsWith("[loom:mainline-moved]")) nudges.push(text); return origEnqueue(target, text, ...rest); };
db.insertProject({ id: P.projId, name: "MWU", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

const KEY = MW.mainlineWatermarkKey(P.projId, "primary");
const watermark = () => MW.parseMainlineWatermark(db.getMeta(KEY));
const mwEvents = () => db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === P.projId);
const runCheck = () => sessions.checkMainlineMove({ projectId: P.projId, repoKey: "primary", repoPath: P.repo, managerSessionId: P.mgrId, workerSessionId: null, taskId: null });

let seq = 0;
async function addWorker(tag) {
  const n = `${tag}${++seq}`;
  const taskId = `mwu-${n}-task-${sfx}`, workerId = `mwu-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, `${n}.ts`), `export const ${n} = 1;\n`);
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
const batch = async (ws) => { const r = await sessions.mergeBatchTracked(P.mgrId, ws.map((w) => w.workerId)); return r.settled && r.ok ? r.value : { __unsettled: r }; };

try {
  // ── (U1) a real batch lands normally — control, establishes the watermark baseline ────────────────────
  const preLandingSha = canonHead();
  const a = await addWorker("a"), b = await addWorker("b");
  const r1 = await batch([a, b]);
  check("(U1) setup control: the batch landed cleanly (2 branches)", r1.ok === true && r1.landed?.length === 2);
  const landedSha = canonHead();
  check("(U1) the watermark advanced to the landed tip, as an ordinary green batch always does", watermark()?.sha === landedSha && landedSha !== preLandingSha);
  check("(U1) no mainline_moved_outside_loom event / nudge on a normal green landing", mwEvents().length === 0 && nudges.length === 0);

  // ── (U2) rewind the STORED watermark back to pre-landing — the exact state `unverified` leaves ─────────
  db.setMeta(KEY, JSON.stringify({ branch: MAIN, sha: preLandingSha }));
  check("(U2) watermark manually rewound to the pre-landing sha (simulating a skipped advance)", watermark()?.sha === preLandingSha);
  check("(U2) canonical mainline itself is UNCHANGED by the rewind (still at the real landed tip)", canonHead() === landedSha);

  // ── (U3) the next check reads the already-landed, already-trailered range as EXPLAINED — no false alert,
  //         and the watermark self-corrects ──────────────────────────────────────────────────────────────
  const nBefore = mwEvents().length, nudgesBefore = nudges.length;
  const observed = await runCheck();
  check("(U3) checkMainlineMove returns the real current tip", observed === landedSha);
  check("(U3) NO new mainline_moved_outside_loom event — a genuinely-landed, properly-trailered range is EXPLAINED, not an alert", mwEvents().length === nBefore);
  check("(U3) NO new manager nudge either", nudges.length === nudgesBefore);
  check("(U3) the watermark SELF-CORRECTS to the real tip on this next check (never stays stale forever)", watermark()?.sha === landedSha);

  // ── (U4) NEGATIVE CONTROL: the SAME rewind, but this time the landed range is genuinely NOT fully
  //         trailered (strip trailers + rewrite via a RAW update-ref, simulating an actual bypass in the
  //         exact same window) — THIS must alert, proving (U3)'s silence is not unconditional ─────────────
  const c = await addWorker("c"), e = await addWorker("e");
  const r2 = await batch([c, e]);
  check("(U4) setup control: a second batch landed cleanly", r2.ok === true && r2.landed?.length === 2);
  const secondPreSha = landedSha; // watermark is at `landedSha` right now (U3 corrected it)
  const secondLandedSha = canonHead();
  // Rewind the watermark the same way, but ALSO simulate a bypass sitting in the SAME window: a raw
  // (non-porcelain) update-ref of an untrailered commit layered on top, mirroring a real worker/human raw
  // write that happened to land in the identical gap a skipped watermark advance would leave open.
  fs.writeFileSync(path.join(P.repo, "raw-bypass.txt"), "bypass\n");
  git(P.repo, "add", "raw-bypass.txt");
  const bypassTree = git(P.repo, "write-tree");
  const bypassSha = git(P.repo, "commit-tree", "-p", secondLandedSha, "-m", "raw bypass, no prefix", bypassTree);
  git(P.repo, "update-ref", MAINREF, bypassSha); // EMPTY reflog message — a raw, non-porcelain write
  git(P.repo, "reset", "-q", "--hard");
  db.setMeta(KEY, JSON.stringify({ branch: MAIN, sha: secondPreSha }));
  const nBefore2 = mwEvents().length;
  const observed2 = await runCheck();
  check("(U4) negative control: this window DOES alert — the check discriminates, (U3)'s silence was earned, not blanket", observed2 === bypassSha && mwEvents().length === nBefore2 + 1 && mwEvents()[mwEvents().length - 1].detail.evidence.includes("reflog-raw-write"));
} finally {
  try { db.close(); } catch { /* already closed */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a batch landing whose watermark advance was skipped (the exact state an `unverified` fast-forward leaves) self-corrects silently on the next mainline check, and the check still discriminates a real bypass in the identical window."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
