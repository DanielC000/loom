import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 59d2577a — the mainline-move tripwire (card 4fa36502) at daemon BOOT. REAL git; two Db/SessionService instances on ONE LOOM_HOME stand for "the daemon went down and came back".
// (merge_batch lives in mainline-watch-batch.mjs.)
//   (D0)  first sight at boot is SILENT (W initialised).
//   (D3)  a CLEAN boot (a human commit while down) is silent and ADVANCES W; the next landing is quiet.
//   (D1)  RED-FIRST: a raw move made while down ⇒ exactly ONE durable event at boot (source:"boot"), NO nudge, and W is NOT advanced (boot never absorbs an alert).
//   (D2)  the next landing re-detects the same move WITH a manager: one more event + one nudge; then deduped (also across a second boot).
//   (S)   index.ts kicks the boot pass fire-and-forget.
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/mainline-watch-boot.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-mw-boot-home-");

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

const P = { projId: `mwbt-proj-${sfx}`, agentId: `mwbt-agent-${sfx}`, mgrId: `mwbt-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mwbt-repo-${sfx}`) };
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
  const taskId = `mwbt-${n}-task-${sfx}`, workerId = `mwbt-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  fs.mkdirSync(path.join(worktreePath, "src"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "src", `${n}.ts`), `export const ${tag}${seq} = ${seq};\n`);
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch, tip: git(worktreePath, "rev-parse", "HEAD") };
}
const confirm = async (d, w) => { const r = await d.sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId); return r.settled && r.ok ? r.value : { __unsettled: r }; };
const mwEvents = (d) => d.db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === P.projId);
const watermark = (d) => MW.parseMainlineWatermark(d.db.getMeta(MW.mainlineWatermarkKey(P.projId, "primary")));
const bypass = (w) => { git(w.worktreePath, "update-ref", MAINREF, w.tip); git(P.repo, "reset", "-q", "--hard"); };

try {
  // one landing so the primary repo has a watermark (a fresh project's first sight is silent)
  const a0 = await addWorker(d1.db, "a");
  check("(D0) setup: no watermark before the first landing", watermark(d1) === null);
  await confirm(d1, a0);
  check("(D0) setup: the first landing initialised the watermark silently", watermark(d1)?.sha === canonHead() && mwEvents(d1).length === 0);

  // (D0) BOOT FIRST SIGHT: a SECOND project with no watermark is initialised silently.
  const P2 = { projId: `mwbt2-proj-${sfx}`, repo: path.join(os.tmpdir(), `loom-mwbt2-repo-${sfx}`) };
  fs.mkdirSync(P2.repo, { recursive: true }); registerForCleanup(P2.repo);
  fs.writeFileSync(path.join(P2.repo, "README.md"), "# mwbt2\n");
  git(P2.repo, "init", "-q"); git(P2.repo, "config", "core.autocrlf", "false"); git(P2.repo, "config", "user.email", "mw@loom"); git(P2.repo, "config", "user.name", "mw");
  commitAll(P2.repo, "init", GIT_ID);
  d1.db.insertProject({ id: P2.projId, name: "MWBT2", repoPath: P2.repo, vaultPath: P2.repo, config: {}, createdAt: now, archivedAt: null });
  const w2 = () => MW.parseMainlineWatermark(d1.db.getMeta(MW.mainlineWatermarkKey(P2.projId, "primary")));
  check("(D0) setup control: the second project has no watermark", w2() === null);
  await d1.sessions.checkMainlineMovesOnBoot();
  check("(D0) BOOT FIRST SIGHT: initialised SILENTLY at the current tip (no event for it)", w2()?.sha === git(P2.repo, "rev-parse", "HEAD") && d1.db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === P2.projId).length === 0);
  check("(D0) the primary repo (tip == watermark) raised nothing and is unchanged", watermark(d1)?.sha === canonHead() && mwEvents(d1).length === 0);

  // (D3) a CLEAN boot advances W: a human commit made while down is silent, W follows main, and the next landing is quiet.
  fs.writeFileSync(path.join(P.repo, "human1.txt"), "h1\n"); git(P.repo, "add", "human1.txt"); git(P.repo, "commit", "-q", "-m", "docs: human commit while down");
  const wBeforeClean = watermark(d1)?.sha;
  await d1.sessions.checkMainlineMovesOnBoot();
  check("(D3) a human commit while down ⇒ NO event at boot, and W ADVANCED to main (a clean verdict stores W)", mwEvents(d1).length === 0 && wBeforeClean !== canonHead() && watermark(d1)?.sha === canonHead());
  const a1 = await addWorker(d1.db, "a");
  await confirm(d1, a1);
  check("(D3) the next landing after a clean boot is quiet", mwEvents(d1).length === 0 && d1.nudges.length === 0);

  // (D4) the compare-and-set must never REGRESS W: a landing that advances W while the boot pass is still reading the head wins (the CAS's expected value is read BEFORE the head read).
  {
    fs.writeFileSync(path.join(P.repo, "human5.txt"), "h5\n"); git(P.repo, "add", "human5.txt"); git(P.repo, "commit", "-q", "-m", "docs: human commit before D4");
    const advanced = git(P.repo, "rev-parse", "HEAD~2"); // stands in for "a landing advanced W to S" — any valid sha distinct from the old W and the tip
    const oldW = watermark(d1)?.sha;
    check("(D4) setup control: W is behind the tip and distinct from the simulated concurrent advance", oldW !== canonHead() && advanced !== oldW && advanced !== canonHead());
    const realHead = d1.sessions.mainlineHeadReader;
    check("(D4) setup control: the head-reader seam exists", typeof realHead === "function");
    d1.sessions.mainlineHeadReader = async (...args) => { const h = await realHead(...args); d1.db.setMeta(MW.mainlineWatermarkKey(P.projId, "primary"), JSON.stringify({ branch: MAIN, sha: advanced })); return h; };
    await d1.sessions.checkMainlineMovesOnBoot();
    d1.sessions.mainlineHeadReader = realHead;
    check("(D4) a concurrent advance of W during the boot pass's head read is NOT regressed by the boot pass's store", watermark(d1)?.sha === advanced && mwEvents(d1).length === 0);
    d1.db.setMeta(MW.mainlineWatermarkKey(P.projId, "primary"), JSON.stringify({ branch: MAIN, sha: canonHead() })); // restore for the scenarios below
  }

  // (D1) RED-FIRST: a raw move made while the daemon is "down": close instance 1, move main, open instance 2 on the SAME LOOM_HOME.
  const wDown = watermark(d1)?.sha;
  const v = await addWorker(d1.db, "v");
  const nxt = await addWorker(d1.db, "n");
  d1.db.close();
  bypass(v);
  const d2 = boot();
  check("(D1) setup control: instance 2 sees instance 1's watermark on the shared LOOM_HOME, and main has moved past it", watermark(d2)?.sha === wDown && canonHead() === v.tip);
  const t0 = Date.now();
  const bootP = d2.sessions.checkMainlineMovesOnBoot();
  check("(D1) the boot check returns a promise (async, off the boot critical path)", typeof bootP?.then === "function");
  await bootP;
  const evBoot = mwEvents(d2);
  check("(D1) exactly ONE durable event at boot for the move made while down (severity high, source boot, empty manager id)", evBoot.length === 1 && evBoot[0].detail.severity === "high" && evBoot[0].detail.source === "boot" && evBoot[0].detail.suspectShas?.includes(v.tip) && evBoot[0].detail.to === v.tip && evBoot[0].detail.repoKey === "primary" && evBoot[0].managerSessionId === "");
  check("(D1) NO boot-time nudge (no manager is known at boot)", d2.nudges.length === 0);
  check("(D1) W is NOT advanced by an alerting boot pass (the boot path never absorbs an alert)", watermark(d2)?.sha === wDown);
  check("(D1) the boot check was quick on a tiny repo (bounded, not a scan)", Date.now() - t0 < 30_000);

  // (D2) the next landing re-detects the SAME move, now with a manager to nudge — one more event + one nudge.
  const rn = await confirm(d2, nxt);
  const evAfter = mwEvents(d2);
  check("(D2) the next landing still merges (never a refusal)", rn.merged === true);
  check("(D2) the next landing's check re-detects the move: ONE more event (not source boot) naming the same tip, and ONE nudge to its manager", evAfter.length === 2 && evAfter[1].detail.source === undefined && evAfter[1].detail.suspectShas?.includes(v.tip) && d2.nudges.length === 1 && /\[loom:mainline-moved\]/.test(d2.nudges[0]));
  check("(D2) after that landing W has advanced", watermark(d2)?.sha === canonHead());
  await d2.sessions.checkMainlineMovesOnBoot();
  const y = await addWorker(d2.db, "y");
  await confirm(d2, y);
  check("(D2) DEDUPE: a second boot pass and the following landing raise no further event or nudge", mwEvents(d2).length === 2 && d2.nudges.length === 1);

  // (D5)/(D6) card 787dd2a7 — BOOT FIRST SIGHT with a RESOLVABLE default that DISAGREES with the checkout:
  // unlike (D0) (no origin/HEAD — nothing to compare against, seeds unconditionally, unchanged), a repo
  // whose `refs/remotes/origin/HEAD` names a real default branch must NOT be silently seeded from whatever
  // else happens to be checked out at boot. No real remote is needed — resolveMainlineBranch only reads the
  // symbolic ref.
  const P3 = { projId: `mwbt3-proj-${sfx}`, repo: path.join(os.tmpdir(), `loom-mwbt3-repo-${sfx}`) };
  fs.mkdirSync(P3.repo, { recursive: true }); registerForCleanup(P3.repo);
  fs.writeFileSync(path.join(P3.repo, "README.md"), "# mwbt3\n");
  git(P3.repo, "init", "-q"); git(P3.repo, "config", "core.autocrlf", "false"); git(P3.repo, "config", "user.email", "mw@loom"); git(P3.repo, "config", "user.name", "mw");
  commitAll(P3.repo, "init", GIT_ID);
  const MAIN3 = git(P3.repo, "rev-parse", "--abbrev-ref", "HEAD");
  git(P3.repo, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${MAIN3}`);
  git(P3.repo, "checkout", "-q", "-b", "boot-stray");
  d2.db.insertProject({ id: P3.projId, name: "MWBT3", repoPath: P3.repo, vaultPath: P3.repo, config: {}, createdAt: now, archivedAt: null });
  const w3 = () => MW.parseMainlineWatermark(d2.db.getMeta(MW.mainlineWatermarkKey(P3.projId, "primary")));
  const ev3 = () => d2.db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === P3.projId);
  check("(D5) setup control: the repo resolves a default that disagrees with the checkout", git(P3.repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD") === `origin/${MAIN3}` && git(P3.repo, "rev-parse", "--abbrev-ref", "HEAD") === "boot-stray");
  await d2.sessions.checkMainlineMovesOnBoot();
  check("(D5) BOOT FIRST SIGHT, resolvable-and-disagreeing default: W stays UNSEEDED", w3() === null);
  check("(D5) …and exactly ONE low-severity first-sight-declined event names the mismatch", ev3().length === 1 && ev3()[0].detail.severity === "low" && ev3()[0].detail.evidence?.includes("first-sight-declined") && ev3()[0].detail.branch === "boot-stray" && ev3()[0].detail.expectedBranch === MAIN3);
  await d2.sessions.checkMainlineMovesOnBoot();
  check("(D6) DEDUPE: a second boot pass over the SAME unresolved fact raises no further event", w3() === null && ev3().length === 1);

  // structural: the boot kick is fire-and-forget in index.ts (never awaited)
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const KICK = /void sessions\.checkMainlineMovesOnBoot\(\)\.catch\(/;
  check("(S) control: the comment stripper removes a commented-out kick (a comment cannot flip this check), and the pattern matches a real one", KICK.test("void sessions.checkMainlineMovesOnBoot().catch(") && !KICK.test(stripComments("// void sessions.checkMainlineMovesOnBoot().catch(\n/* void sessions.checkMainlineMovesOnBoot().catch( */")));
  const idx = stripComments(fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"));
  check("(S) index.ts kicks checkMainlineMovesOnBoot as a fire-and-forget `void` call, never awaited", KICK.test(idx) && !/await sessions\.checkMainlineMovesOnBoot/.test(idx));
  d2.db.close();
} finally {
  try { d1.db.close(); } catch { /* already closed */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the boot pass reports a move made while down once, never absorbs an alert, advances W only on a clean verdict."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
