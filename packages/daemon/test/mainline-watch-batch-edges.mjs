import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 59d2577a — the mainline-move tripwire (card 4fa36502, docs/decisions/4fa36502-mainline-move-tripwire.md) on `merge_batch`. REAL git on temp repos, an injected
// always-green `runGate` seam, the real `mergeBatchTracked`. (Boot lives in mainline-watch-boot.mjs — split so each file stays fast.)
//
//   (B4)  TOCTOU: main moves AFTER the batch's check but BEFORE its fast-forward ⇒ the batch forfeits and the move is NOT absorbed: reported exactly once.
//   (B5)  FAIL-OPEN: a failing reader ⇒ the batch lands exactly as today, no event, watermark not advanced past the unverified move; the next landing catches it.
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
const batch = async (d, ws) => { const r = await d.sessions.mergeBatchTracked(P.mgrId, ws.map((w) => w.workerId)); return r.settled && r.ok ? r.value : { __unsettled: r }; };
const confirm = async (d, w) => { const r = await d.sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId); return r.settled && r.ok ? r.value : { __unsettled: r }; };
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
    const before = mwEvents(d1).length, wmBefore = watermark(d1)?.sha;
    // The reader seam runs inside the check (post-gate, guard held): let it read the pre-move facts, THEN write main — i.e. the move lands in the
    // window between the check and the fast-forward.
    const realReader = d1.sessions.mainlineFactsReader;
    let armed = true;
    d1.sessions.mainlineFactsReader = async (...args) => { const facts = await realReader(...args); if (armed) { armed = false; git(k.worktreePath, "update-ref", MAINREF, k.tip); git(P.repo, "reset", "-q", "--hard"); } return facts; };
    // The reader is only consulted when main != watermark; force that (a benign human commit) so the seam actually fires.
    fs.writeFileSync(path.join(P.repo, "human2.txt"), "h2\n"); git(P.repo, "add", "human2.txt"); git(P.repo, "commit", "-q", "-m", "docs: human commit before B4");
    const r4 = await batch(d1, [l, m]);
    d1.sessions.mainlineFactsReader = realReader;
    check("(B4) setup control: the move DID land between the check and the fast-forward (the raw-written tip is in main's history)", armed === false && (() => { try { git(P.repo, "merge-base", "--is-ancestor", k.tip, "HEAD"); return true; } catch { return false; } })());
    check("(B4) the batch FORFEITED (main moved since it was cut): it landed nothing itself (its candidates fall back to solo landings)", r4.ok === false && (r4.landed?.length ?? 0) === 0);
    const o = await addWorker(d1.db, "o");
    await confirm(d1, o);
    const ev4 = mwEvents(d1).slice(before);
    check("(B4) the move is NOT absorbed by the batch: across the forfeit's fallback landings and the next confirm it is reported exactly ONCE, naming the raw-written tip", ev4.length === 1 && ev4[0].detail.suspectShas?.includes(k.tip) && ev4[0].detail.to === k.tip);
    void n; void wmBefore;
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

} finally {
  try { d1.db.close(); } catch { /* already closed */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the batch tripwire is TOCTOU-safe and fail-open."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
