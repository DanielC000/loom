import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 05e7f246 — the mainline-move tripwire (card 4fa36502): a boot ALERT is filed ONCE per distinct move, and a loom-tip CAP skip is visible. REAL git; two Db/SessionService instances on ONE LOOM_HOME stand for "the daemon restarted".
//   (B1) RED-FIRST: three boot passes (three daemon restarts) over ONE unhandled move ⇒ exactly ONE durable event (was: three); W is still NOT advanced by any of them.
//   (B2) a DIFFERENT move (new `to`) after that is a new fact ⇒ it files again (the dedupe key is the move, not the project).
//   (B3) the dedupe marker does not swallow the landing path: the next LANDING's check still re-detects the move (checked in mainline-watch-boot.mjs (D2); here we only pin that the marker is per (project, repoKey, from, to)).
//   (C1) RED-FIRST: a loom-tip CAP skip with a non-alert verdict files ONE low `unverifiable` event naming the skip AND still stores W (a busy repo must not become permanently unverifiable).
//   (C2) control: the same human commit WITHOUT the cap trip files nothing (the event is not filed for every non-alert verdict).
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/mainline-watch-boot-dedupe.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-mw-dd-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
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

const P = { projId: `mwdd-proj-${sfx}`, repo: path.join(os.tmpdir(), `loom-mwdd-repo-${sfx}`) };
fs.mkdirSync(P.repo, { recursive: true }); registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# mwdd\n");
git(P.repo, "init", "-q"); git(P.repo, "config", "core.autocrlf", "false"); git(P.repo, "config", "user.email", "mw@loom"); git(P.repo, "config", "user.name", "mw");
commitAll(P.repo, "init", GIT_ID);
const MAIN = git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const MAINREF = `refs/heads/${MAIN}`;
const canonHead = () => git(P.repo, "rev-parse", "HEAD");

/** One "daemon": a Db on the shared LOOM_HOME + a SessionService. */
function boot() {
  const db = new Db();
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => ({ passed: true, steps: [] }), reapWorktreeProcesses: noReap });
  return { db, sessions };
}
let d = boot();
d.db.insertProject({ id: P.projId, name: "MWDD", repoPath: P.repo, vaultPath: P.repo, config: {}, createdAt: now, archivedAt: null });
const mwEvents = () => d.db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === P.projId);
const wKey = MW.mainlineWatermarkKey(P.projId, "primary");
const watermark = () => MW.parseMainlineWatermark(d.db.getMeta(wKey));
const restart = () => { d.db.close(); d = boot(); };

try {
  await d.sessions.checkMainlineMovesOnBoot(); // first sight: W initialised silently
  check("(setup) first sight initialised W silently", watermark()?.sha === canonHead() && mwEvents().length === 0);
  const w0 = watermark().sha;

  // A raw move made while "down": a bare update-ref onto a commit made on a side branch (empty reflog message + a trailer-less commit in W..tip).
  git(P.repo, "checkout", "-q", "-b", "side"); fs.writeFileSync(path.join(P.repo, "raw.txt"), "r\n"); git(P.repo, "add", "raw.txt"); git(P.repo, "commit", "-q", "-m", "feat(x): raw");
  const rawTip = canonHead(); git(P.repo, "checkout", "-q", MAIN); git(P.repo, "update-ref", MAINREF, rawTip); git(P.repo, "reset", "-q", "--hard");
  check("(setup control) main moved past W by a raw write", canonHead() === rawTip && rawTip !== w0);

  // (B1) three restarts, ONE event.
  await d.sessions.checkMainlineMovesOnBoot();
  check("(B1) control: the FIRST boot pass files the alert (the detector fires on this fixture)", mwEvents().length === 1 && mwEvents()[0].detail.severity === "high");
  restart(); await d.sessions.checkMainlineMovesOnBoot();
  restart(); await d.sessions.checkMainlineMovesOnBoot();
  check("(B1) three boot passes over one unhandled move ⇒ exactly ONE event", mwEvents().length === 1);
  check("(B1) W is still NOT advanced (a boot alert never stores W)", watermark()?.sha === w0);

  // (B2) a different move is a new fact.
  fs.writeFileSync(path.join(P.repo, "raw2.txt"), "r2\n"); git(P.repo, "add", "raw2.txt"); git(P.repo, "commit", "-q", "-m", "feat(x): human on top");
  git(P.repo, "checkout", "-q", "-b", "side2"); fs.writeFileSync(path.join(P.repo, "raw3.txt"), "r3\n"); git(P.repo, "add", "raw3.txt"); git(P.repo, "commit", "-q", "-m", "feat(x): raw2");
  const rawTip2 = canonHead(); git(P.repo, "checkout", "-q", MAIN); git(P.repo, "update-ref", MAINREF, rawTip2); git(P.repo, "reset", "-q", "--hard");
  restart(); await d.sessions.checkMainlineMovesOnBoot();
  const evs = mwEvents();
  check("(B2) a later, different move (new `to`) files again: two events, the second naming the new tip", evs.length === 2 && evs[1].detail.to === rawTip2 && evs[1].detail.from === w0);

  // (C) cap-skip. Reset the scene: W follows main silently (owner action), then a human commit while >TIP_CHECK_CAP fresh loom branches sit on the new tip.
  d.db.setMeta(wKey, JSON.stringify({ branch: MAIN, sha: canonHead() }));
  fs.writeFileSync(path.join(P.repo, "h1.txt"), "h1\n"); git(P.repo, "add", "h1.txt"); git(P.repo, "commit", "-q", "-m", "docs: human commit, no cap trip");
  const before = mwEvents().length;
  await d.sessions.checkMainlineMovesOnBoot();
  check("(C2) control: a human commit with NO cap trip files nothing and W follows main", mwEvents().length === before && watermark()?.sha === canonHead());

  fs.writeFileSync(path.join(P.repo, "h2.txt"), "h2\n"); git(P.repo, "add", "h2.txt"); git(P.repo, "commit", "-q", "-m", "docs: human commit, cap trip");
  for (let i = 0; i < MW.MAINLINE_LOOM_TIP_CHECK_CAP + 1; i++) git(P.repo, "branch", `loom/cap-${sfx}-${i}`);
  const tipC = canonHead();
  await d.sessions.checkMainlineMovesOnBoot();
  const evC = mwEvents().slice(before);
  check("(C1) a loom-tip CAP skip files ONE low unverifiable event naming the skip", evC.length === 1 && evC[0].detail.severity === "low" && evC[0].detail.unverifiable === true && /loom-tip signal skipped \(cap\)/.test(String(evC[0].detail.reason)));
  check("(C1) …and W IS still stored (a busy repo is not made permanently unverifiable)", watermark()?.sha === tipC);
} finally {
  try { d.db.close(); } catch { /* already closed */ }
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
