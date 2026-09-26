import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 864bdd63 — the mainline tripwire's rewind + missing-watermark reads take git's real OUTPUT answer, and any error in them fails OPEN (card 4fa36502, docs/decisions/4fa36502-mainline-move-tripwire.md). REAL git on temp repos.
//   (A) a real rewind of main (update-ref to an older commit) ⇒ ONE high `rewind-raw-write` event.
//   (E) control: a forward porcelain move stays silent (the (A) fix did not turn every move into a rewind).
//   (B) a W that no longer resolves ⇒ watermarkMissing ⇒ ONE low "unverifiable" event.
//   (C) a rev-parse / merge-base that ERRORS (timeout-shaped, spawn-shaped) ⇒ fail-open: check returns null, W untouched, no event — never "unverifiable"+store, never "explained"+store.
//   (F) isAncestorCommit's default path stays output-based (it is the ONE helper both callers use).
// Run: 1) build daemon (pnpm build), 2) node test/mainline-watch-reads.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-mainline-reads-home-");

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
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

const repo = path.join(os.tmpdir(), `loom-mwr-${sfx}`);
fs.mkdirSync(repo, { recursive: true }); registerForCleanup(repo);
fs.writeFileSync(path.join(repo, "README.md"), "# mwr\n");
git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false"); git(repo, "config", "user.email", "mw@loom"); git(repo, "config", "user.name", "mw");
commitAll(repo, "init", GIT_ID);
const MAIN = git(repo, "rev-parse", "--abbrev-ref", "HEAD"), MAINREF = `refs/heads/${MAIN}`;
const head = () => git(repo, "rev-parse", "HEAD");
const addCommit = (n) => { fs.writeFileSync(path.join(repo, `f${n}.txt`), `${n}\n`); commitAll(repo, `chore(x): step ${n}`, GIT_ID); return head(); };

const projId = `mwr-proj-${sfx}`, agentId = `mwr-agent-${sfx}`, mgrId = `mwr-mgr-${sfx}`;
const db = new Db();
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => ({ passed: true, steps: [] }), reapWorktreeProcesses: async () => ({ killedPids: [] }) });
db.insertProject({ id: projId, name: "MWR", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
const KEY = MW.mainlineWatermarkKey(projId, "primary");
const setW = (sha) => db.setMeta(KEY, JSON.stringify({ branch: MAIN, sha }));
const watermark = () => MW.parseMainlineWatermark(db.getMeta(KEY));
const events = () => db.listEventsForSession(mgrId).filter((e) => e.kind === "mainline_moved_outside_loom");
const nudges = [];
const origEnqueue = sessions.enqueueDurableMessage.bind(sessions);
sessions.enqueueDurableMessage = (target, text, ...rest) => { if (String(text).startsWith("[loom:mainline-moved]")) nudges.push(text); return origEnqueue(target, text, ...rest); };
const runCheck = () => sessions.checkMainlineMove({ projectId: projId, repoKey: "primary", repoPath: repo, managerSessionId: mgrId, workerSessionId: null, taskId: null });
const warned = []; const realWarn = console.warn; console.warn = (...a) => { warned.push(a.join(" ")); };
const realFactsReader = sessions.mainlineFactsReader;
/** A real git runner (the `runOverride` seam) that, like simple-git's raw(), resolves a non-zero exit with its stdout instead of throwing on exit 1. */
const realRun = async (args) => { try { return execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "ignore"] }); } catch (e) { if (e.status === 1) return String(e.stdout ?? ""); throw e; } };
const failOn = (cmd, err) => async (args) => { if (args[0] === cmd) throw err; return realRun(args); };

try {
  // ── (A) a REAL rewind ──
  const base = head(); addCommit(1); const w2 = addCommit(2); // W = w2, then main is rewound to `base` by a bare update-ref (empty reflog message)
  setW(w2);
  git(repo, "update-ref", MAINREF, base); git(repo, "reset", "-q", "--hard");
  const factsA = await MW.readMainlineFacts(repo, w2, { branch: MAIN, tip: base }, 10_000);
  check("(A0) readMainlineFacts reads forward=false for a real rewind (W is NOT an ancestor of the rewound tip)", factsA.forward === false && factsA.watermarkMissing === false);
  const vA = MW.classifyMainlineMove(w2, factsA);
  check("(A1) the classifier alerts rewind-raw-write on those facts", vA.verdict === "alert" && vA.evidence.join() === "rewind-raw-write");
  const rA = await runCheck();
  const evA = events();
  check("(A2) the service check files ONE high rewind-raw-write event, nudges the manager once, and stores W at the rewound tip", rA === base && evA.length === 1 && evA[0].detail.severity === "high" && evA[0].detail.evidence.join() === "rewind-raw-write" && evA[0].detail.suspectShas.includes(base) && nudges.length === 1 && watermark()?.sha === base);

  // ── (E) control: a forward move by porcelain commits stays silent ──
  const w3 = addCommit(3); const nE = events().length;
  const factsE = await MW.readMainlineFacts(repo, base, { branch: MAIN, tip: w3 }, 10_000);
  check("(E) a forward porcelain move reads forward=true and stays silent (explained), files nothing", factsE.forward === true && MW.classifyMainlineMove(base, factsE).verdict === "explained" && (await runCheck()) === w3 && events().length === nE);

  // ── (B) a W that no longer resolves ──
  const fake = "0123456789abcdef0123456789abcdef01234567"; // 40 hex that names no object in this repo
  const probe = (() => { try { return { out: execFileSync("git", ["rev-parse", "--verify", "--quiet", `${fake}^{commit}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), status: 0 }; } catch (e) { return { out: String(e.stdout ?? ""), status: e.status }; } })();
  check("(B0) setup control: for a dangling W the reader's rev-parse form prints NOTHING and exits 1 (the answer simple-git reports as success)", probe.out.trim() === "" && probe.status === 1);
  const w4 = addCommit(4);
  const factsB = await MW.readMainlineFacts(repo, fake, { branch: MAIN, tip: w4 }, 10_000);
  check("(B1) readMainlineFacts reads watermarkMissing=true for a dangling W", factsB.watermarkMissing === true);
  setW(fake); const nB = events().length;
  const rB = await runCheck();
  const evB = events().slice(nB);
  check("(B2) the service check files ONE low unverifiable event naming the unresolvable watermark, and stores W at the tip", rB === w4 && evB.length === 1 && evB[0].detail.severity === "low" && evB[0].detail.unverifiable === true && /no longer resolvable/.test(evB[0].detail.reason) && watermark()?.sha === w4);

  // ── (C) an ERROR in either read fails OPEN ──
  const w5 = addCommit(5); setW(w4); // a healthy forward move w4 → w5 to be read
  const spawnErr = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
  const cases = [["rev-parse timeout", "rev-parse", new Error("git rev-parse timed out after 10000ms")], ["merge-base timeout", "merge-base", new Error("git merge-base timed out after 10000ms")], ["rev-parse spawn failure", "rev-parse", spawnErr], ["merge-base spawn failure", "merge-base", spawnErr]];
  for (const [name, cmd, err] of cases) {
    let threw = null; try { await MW.readMainlineFacts(repo, w4, { branch: MAIN, tip: w5 }, 10_000, undefined, failOn(cmd, err)); } catch (e) { threw = e; }
    check(`(C) readMainlineFacts THROWS on a ${name} (never returns facts that classify as missing/rewind/explained)`, threw === err);
    const n0 = events().length, nn = nudges.length;
    sessions.mainlineFactsReader = (r, w, h, ms, d) => realFactsReader(r, w, h, ms, d, failOn(cmd, err));
    let out; try { out = await runCheck(); } finally { sessions.mainlineFactsReader = realFactsReader; }
    check(`(C) the service check on a ${name}: returns null (fail-open), W untouched, NO event, NO nudge, logged as a fail-open skip`, out === null && watermark()?.sha === w4 && events().length === n0 && nudges.length === nn && warned.some((x) => /check skipped \(fail-open\)/.test(x)));
  }
  check("(C) the next healthy check reads the same move normally (explained, silent) and stores W — the failed checks absorbed nothing", (await runCheck()) === w5 && watermark()?.sha === w5);

  // ── (F) isAncestorCommit is ONE helper: its default runner answers by merge-base output too ──
  check("(F) isAncestorCommit (default runner): true for an ancestor and for equal, false for a rewound relation", (await MW.isAncestorCommit(repo, base, w5, 10_000)) === true && (await MW.isAncestorCommit(repo, w5, w5, 10_000)) === true && (await MW.isAncestorCommit(repo, w5, base, 10_000)) === false);

  // ── (G) a NON-forward move still runs the range read and the loom-tip scan (no derived fact short-circuits them) ──
  {
    const A = head();
    const X1 = git(repo, "commit-tree", "-p", A, "-m", "work x1", `${A}^{tree}`);
    git(repo, "update-ref", "-m", "commit: work x1", `refs/heads/loom/x-${sfx}`, X1); // a worker branch cut at A that authored X1
    const B = addCommit(6); // main advances while the worker runs (the NORMAL case)
    setW(B);
    git(repo, "update-ref", "-m", `merge loom/x-${sfx}: Fast-forward`, MAINREF, X1); git(repo, "reset", "-q", "--hard"); // divergent (B is not an ancestor of X1), porcelain-LOOKING message
    check("(G0) setup control: the forged main reflog message is PORCELAIN (only the loom-tip signal can see it) and B is NOT an ancestor of X1", !MW.isRawReflogMessage(git(repo, "reflog", "show", "--format=%gs", "-n1", MAINREF)) && (await MW.isAncestorCommit(repo, B, X1, 10_000)) === false);
    const factsG = await MW.readMainlineFacts(repo, B, { branch: MAIN, tip: X1 }, 10_000);
    check("(G1) a divergent move still reads the loom-tip signal: forward=false AND loomTipHits names X1", factsG.forward === false && factsG.loomTipHits.includes(X1));
    const nG = events().length;
    const rG = await runCheck(); const evG = events().slice(nG);
    check("(G2) the forged divergent bypass ALERTS loom-branch-reachable (not 'explained'), and W is stored at the tip", rG === X1 && evG.length === 1 && evG[0].detail.severity === "high" && evG[0].detail.evidence.join() === "loom-branch-reachable" && evG[0].detail.suspectShas.includes(X1) && watermark()?.sha === X1);

    // an owner's porcelain `reset --hard` to an older commit: rewind, but nothing new in W..tip and a porcelain reflog ⇒ silent
    const C1 = addCommit(7), C2 = addCommit(8); setW(C2); const nR = events().length;
    git(repo, "reset", "-q", "--hard", C1);
    check("(G3) an owner porcelain `reset --hard` to an older commit stays SILENT (rewind reads forward=false, reflog is porcelain, W..tip empty) and stores W", (await runCheck()) === C1 && events().length === nR && watermark()?.sha === C1);

    // an owner `commit --amend` on main: tip replaced, amend message is porcelain, no loom tip ⇒ silent
    setW(C1); const nM = events().length;
    fs.writeFileSync(path.join(repo, "amend.txt"), "a\n"); git(repo, "add", "amend.txt"); git(repo, "commit", "-q", "--amend", "-m", "chore(x): amended");
    const amended = head();
    check("(G4) an owner `commit --amend` on main stays SILENT (forward=false, porcelain reflog, no loom tip) and stores W", amended !== C1 && (await runCheck()) === amended && events().length === nM && watermark()?.sha === amended);

    // the same rewind WITHOUT a porcelain message is still a raw write
    const D1 = addCommit(9), D2 = addCommit(10); setW(D2); const nW = events().length;
    git(repo, "update-ref", MAINREF, D1); git(repo, "reset", "-q", "--hard");
    const rW = await runCheck(); const evW = events().slice(nW);
    check("(G5) a no-message raw rewind still alerts rewind-raw-write", rW === D1 && evW.length === 1 && evW[0].detail.evidence.join() === "rewind-raw-write");
  }
} finally {
  console.warn = realWarn;
  try { db.close(); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a real rewind and a dangling W are read from git's output, and a read error fails open."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
