import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 05e7f246 — WHO READS a boot-time mainline alert (card 4fa36502): the project's live MANAGER(S), told ONCE, as an addressed directive, through ONE helper (SessionService.deliverPendingBootAlerts)
// called from the boot check and from ONE chokepoint (onOrchestrationMcpFirstSeen: the gateway runs it on a manager's first /mcp-orch/ contact, which every spawn path crosses). Plus the positively-missing-watermark rule. REAL git; the order of events is DRIVEN explicitly (no sleeps).
//   (R1) manager ALREADY live when the boot check files ⇒ exactly ONE delivery, to it; a later boot pass / resume adds none.
//   (R2) manager NOT live when the boot check files ⇒ NO delivery, marker pending (nudgedAt null); the manager's first orchestration-MCP contact (the ONE chokepoint every spawn path crosses: onOrchestrationMcpFirstSeen) delivers exactly ONE; a second adds none.
//   (R3) the same chokepoint for a FRESH startManager() and a non-manager session (no delivery).
//   (D1) the claim and the DURABLE record are one synchronous step: with a NEVER-settling waitForMcpSeen and the REAL enqueue path, a new SessionService on the same Db still finds the durable session_message_queued record.
//   (I1) an UNDELIVERED marker is never deleted by a later store() of W (a non-alert cap-skip landing check); only a delivered marker or an undone move may drop it (I2).
//   (R4) ATOMIC claim: (a) db.compareAndSetMeta with one expected value wins once; (b) two helper runs interleaved on the same marker (the second runs INSIDE the first, between its read and its claim) ⇒ each of two live managers gets exactly ONE nudge.
//   (R5) the nudge is an ADDRESSED DIRECTIVE: full from/to shas, the exact `git log --oneline <from>..<to>` and `git reflog show <branch>`, and "ask the owner". TWO live managers ⇒ both are told under the one claim.
//   (R6) a settled move (W stored by a later landing-path check) deletes the pending marker; deleteProject purges markers.
//   (M1) a POSITIVELY missing W at BOOT ⇒ ONE high event (watermark-missing + reason), W untouched, deduped over a second boot, delivered via the helper.
//   (M2) the same at LANDING ⇒ ONE high event + a nudge to the confirming manager + W stored at the tip (the tripwire is not blinded).
//   (M3) a TRANSIENT failure is NOT "missing": a rev-parse that throws rejects out of readMainlineFacts; one that prints nothing IS missing (control); the service fails open (no event, W untouched).
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/mainline-watch-boot-reader.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-no-such-codex-bin");
useOwnLoomHome("loom-mw-rd-home-");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const MW = await import("../dist/git/mainline-watch.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "mw", GIT_AUTHOR_EMAIL: "mw@loom", GIT_COMMITTER_NAME: "mw", GIT_COMMITTER_EMAIL: "mw@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=mw@loom -c user.name=mw";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: false }; }, spawn() {}, waitForMcpSeen() { return new Promise(() => {}); } }; // a held enqueue + a NEVER-settling MCP wait: the durable record must not depend on the wait

const P = { projId: `mwrd-proj-${sfx}`, agentId: `mwrd-agent-${sfx}`, repo: path.join(os.tmpdir(), `loom-mwrd-repo-${sfx}`) };
fs.mkdirSync(P.repo, { recursive: true }); registerForCleanup(P.repo);
fs.writeFileSync(path.join(P.repo, "README.md"), "# mwrd\n");
git(P.repo, "init", "-q"); git(P.repo, "config", "core.autocrlf", "false"); git(P.repo, "config", "user.email", "mw@loom"); git(P.repo, "config", "user.name", "mw");
commitAll(P.repo, "init", GIT_ID);
const MAIN = git(P.repo, "rev-parse", "--abbrev-ref", "HEAD");
const MAINREF = `refs/heads/${MAIN}`;
const canonHead = () => git(P.repo, "rev-parse", "HEAD");

const db = new Db();
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => ({ passed: true, steps: [] }), reapWorktreeProcesses: noReap });
/** every `[loom:mainline-moved]` delivery: {to: session id, text} — enqueueDurableNudge is the helper's ONE delivery primitive. */
const nudges = [];
const origMsg = sessions.enqueueDurableMessage.bind(sessions); // the REAL delivery primitive stays in place (card 05e7f246 review): only observed
sessions.enqueueDurableMessage = (target, text, ...rest) => { if (String(text).startsWith("[loom:mainline-moved]")) nudges.push({ to: target, text }); return origMsg(target, text, ...rest); };

db.insertProject({ id: P.projId, name: "MWRD", repoPath: P.repo, vaultPath: P.repo, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: P.agentId, projectId: P.projId, name: "mgr", startupPrompt: "", position: 0 });
const addManager = (tag, processState) => {
  const id = `mwrd-${tag}-${sfx}`;
  db.insertSession({ id, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState, resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  return id;
};
const mwEvents = () => db.listEventsSince(0, 100000).filter((e) => e.kind === "mainline_moved_outside_loom" && e.detail?.projectId === P.projId);
const wKey = MW.mainlineWatermarkKey(P.projId, "primary");
const aKey = MW.mainlineBootAlertKey(P.projId, "primary");
const watermark = () => MW.parseMainlineWatermark(db.getMeta(wKey));
const marker = () => MW.parseMainlineBootAlert(db.getMeta(aKey));
const setW = (sha) => db.setMeta(wKey, JSON.stringify({ branch: MAIN, sha }));
/** a bare update-ref onto a trailer-less commit made on a side branch: the raw-write bypass shape (empty reflog message + untrailered W..tip). */
let n = 0;
function rawMove() {
  const side = `side-${++n}`; git(P.repo, "checkout", "-q", "-b", side); fs.writeFileSync(path.join(P.repo, `raw${n}.txt`), `r${n}\n`); git(P.repo, "add", `raw${n}.txt`); git(P.repo, "commit", "-q", "-m", `feat(x): raw ${n}`);
  const tip = canonHead(); git(P.repo, "checkout", "-q", MAIN); git(P.repo, "update-ref", MAINREF, tip); git(P.repo, "reset", "-q", "--hard"); return tip;
}
const humanCommit = () => { fs.writeFileSync(path.join(P.repo, `h${++n}.txt`), "h\n"); git(P.repo, "add", `h${n}.txt`); git(P.repo, "commit", "-q", "-m", `docs: human ${n}`); return canonHead(); };
const bootCheck = () => sessions.checkMainlineMovesOnBoot();
const forDelivery = (id) => nudges.filter((x) => x.to === id);

try {
  await bootCheck(); // first sight
  const w0 = watermark().sha;
  check("(setup) first sight initialised W silently", w0 === canonHead() && mwEvents().length === 0 && marker() === null);

  // ── (R1) manager already live when the boot check files ──
  const mgrA = addManager("a", "live");
  const tipA = rawMove();
  await bootCheck();
  check("(R1) control: the boot check filed the alert and left W alone", mwEvents().length === 1 && watermark().sha === w0 && marker()?.to === tipA);
  check("(R1) exactly ONE delivery, to the already-live manager", nudges.length === 1 && nudges[0].to === mgrA && marker()?.nudgedAt !== null);
  const aDirective = nudges[0].text;
  check("(R5) the nudge is an ADDRESSED DIRECTIVE: full shas, the exact git log + reflog commands, and 'ask the owner'", aDirective.includes(`git log --oneline ${w0}..${tipA}`) && aDirective.includes(`git reflog show ${MAIN}`) && /ask the owner/.test(aDirective) && /\[loom:mainline-moved\]/.test(aDirective));
  await bootCheck(); await bootCheck();
  check("(R1) later boot passes add no event and no delivery", mwEvents().length === 1 && nudges.length === 1);

  // ── (R2) manager NOT live at boot: pending, then delivered at its first MCP contact after a real resume(), once ──
  setW(canonHead()); db.deleteMeta(aKey); nudges.length = 0;
  db.setProcessState(mgrA, "exited");
  const eng = `eng-mwrd-${sfx}`; db.setEngineSessionId(mgrA, eng);
  const tFile = engineTranscriptPath(P.repo, eng); fs.mkdirSync(path.dirname(tFile), { recursive: true }); registerForCleanup(path.dirname(tFile));
  fs.writeFileSync(tFile, JSON.stringify({ type: "user", message: { content: "seed" } }) + "\n");
  const wB = watermark().sha; const tipB = rawMove();
  const evBefore = mwEvents().length;
  await bootCheck();
  check("(R2) manager not live: the alert is filed and the marker is PENDING; nobody was told yet", mwEvents().length === evBefore + 1 && marker()?.to === tipB && marker()?.nudgedAt === null && nudges.length === 0);
  sessions.resume(mgrA);
  check("(R2) control: a real resume() ALONE delivers nothing (the chokepoint is the MCP contact)", nudges.length === 0);
  sessions.onOrchestrationMcpFirstSeen(mgrA);
  check("(R2) the manager's first MCP contact delivers exactly ONE nudge to it and claims the marker", nudges.length === 1 && nudges[0].to === mgrA && marker()?.nudgedAt !== null && nudges[0].text.includes(`${wB}..${tipB}`));
  db.setProcessState(mgrA, "exited"); sessions.resume(mgrA); sessions.onOrchestrationMcpFirstSeen(mgrA); await bootCheck();
  check("(R2) a second resume+contact and a later boot pass add no further delivery or event", nudges.length === 1 && mwEvents().length === evBefore + 1);

  // ── (R3) a fresh startManager() is a reader too ──
  setW(canonHead()); db.deleteMeta(aKey); nudges.length = 0; db.setProcessState(mgrA, "exited");
  const tipC = rawMove(); await bootCheck();
  check("(R3) control: pending alert, nobody live", marker()?.to === tipC && marker()?.nudgedAt === null && nudges.length === 0);
  const fresh = sessions.startManager(P.agentId);
  sessions.onOrchestrationMcpFirstSeen(fresh.id);
  check("(R3) startManager()'s first MCP contact delivers the pending alert exactly once, to the NEW manager", nudges.length === 1 && nudges[0].to === fresh.id && marker()?.nudgedAt !== null);
  db.setProcessState(fresh.id, "exited");

  // ── (R4a) the claim is one atomic statement ──
  db.setMeta("mwrd-cas", "v0");
  check("(R4a) compareAndSetMeta: the first claim on an expected value wins, the second (same expected) loses, the value is the winner's", db.compareAndSetMeta("mwrd-cas", "v0", "v1") === true && db.compareAndSetMeta("mwrd-cas", "v0", "v2") === false && db.getMeta("mwrd-cas") === "v1" && db.compareAndSetMeta("mwrd-absent", "x", "y") === false);

  // ── (R4b)+(R5) two live managers, two helper runs interleaved on the SAME marker ──
  setW(canonHead()); db.deleteMeta(aKey); nudges.length = 0;
  const mgrX = addManager("x", "live"), mgrY = addManager("y", "live");
  const tipD = rawMove();
  const realList = db.listMetaByPrefix.bind(db);
  let reentered = false;
  // The boot pass files the marker itself and delivers; to force the race, file the marker WITHOUT the pass's own delivery, then run the helper with a competing run injected between its read and its claim.
  db.setMeta(aKey, JSON.stringify({ branch: MAIN, from: watermark().sha, to: tipD, evidence: ["reflog-raw-write"], suspectShas: [tipD], nudgedAt: null }));
  db.listMetaByPrefix = (prefix) => { const rows = realList(prefix); if (!reentered) { reentered = true; sessions.deliverPendingBootAlerts(P.projId); } return rows; };
  sessions.deliverPendingBootAlerts(P.projId);
  db.listMetaByPrefix = realList;
  check("(R4b) two runs on one marker, the second INSIDE the first's read→claim window: each live manager got exactly ONE nudge (the stale reader's claim lost)", reentered && forDelivery(mgrX).length === 1 && forDelivery(mgrY).length === 1 && nudges.length === 2);
  check("(R5) with two live managers BOTH are told under the single claim", marker()?.nudgedAt !== null);
  db.setProcessState(mgrX, "exited"); db.setProcessState(mgrY, "exited");

  // ── (R6) settled ⇒ marker deleted; deleteProject purges ──
  setW(canonHead()); db.deleteMeta(aKey); const mgrS = addManager("s", "exited");
  const tipE = rawMove(); await bootCheck();
  check("(R6) control: a pending marker exists", marker()?.to === tipE && marker()?.nudgedAt === null);
  await sessions.checkMainlineMove({ projectId: P.projId, repoKey: "primary", repoPath: P.repo, managerSessionId: mgrS, workerSessionId: null, taskId: null, source: "landing" });
  check("(R6) a landing-path check that settles the move (stores W) deletes the pending marker, so no manager is later told about a settled move", watermark().sha === tipE && marker() === null);

  // ── (M1) a positively missing W at BOOT ──
  const fake = "d".repeat(40); setW(fake); const nM = mwEvents().length; nudges.length = 0;
  const liveM = addManager("m", "live");
  await bootCheck();
  const evM = mwEvents().slice(nM);
  check("(M1) boot + missing W ⇒ ONE high alert-class event: evidence watermark-missing and the reason text", evM.length === 1 && evM[0].detail.severity === "high" && evM[0].detail.evidence.join() === "watermark-missing" && /no longer resolvable \(possible reflog expire\/prune or force-rewrite\)/.test(evM[0].detail.reason) && evM[0].detail.source === "boot");
  check("(M1) W is UNTOUCHED at boot, the marker is set, and the live manager was told once", watermark().sha === fake && marker()?.from === fake && forDelivery(liveM).length === 1);
  check("(M1) the missing-W nudge does NOT tell the manager to run an unresolvable `git log <from>..<to>`: it gives reflog + `git log --oneline -20 <to>`", forDelivery(liveM).length === 1 && !forDelivery(liveM)[0].text.includes(`${fake}..`) && forDelivery(liveM)[0].text.includes(`git reflog show ${MAIN}`) && forDelivery(liveM)[0].text.includes(`git log --oneline -20 ${canonHead()}`) && /ask the owner/.test(forDelivery(liveM)[0].text));
  await bootCheck();
  check("(M1) a second boot pass over the same missing W adds no event or delivery (deduped by the marker)", mwEvents().length === nM + 1 && forDelivery(liveM).length === 1);

  // ── (M2) the same at LANDING ──
  const nL = mwEvents().length; const tipNow = canonHead(); nudges.length = 0;
  await sessions.checkMainlineMove({ projectId: P.projId, repoKey: "primary", repoPath: P.repo, managerSessionId: liveM, workerSessionId: null, taskId: null, source: "landing" });
  const evL = mwEvents().slice(nL);
  check("(M2) landing + missing W ⇒ ONE high event, a nudge to the confirming manager, and W stored at the tip", evL.length === 1 && evL[0].detail.severity === "high" && evL[0].detail.evidence.join() === "watermark-missing" && nudges.length === 1 && nudges[0].to === liveM && watermark().sha === tipNow && marker() === null);
  db.setProcessState(liveM, "exited");

  // ── (M3) a transient failure is NOT "missing" ──
  const facts = (run) => MW.readMainlineFacts(P.repo, fake, { branch: MAIN, tip: canonHead() }, 10_000, undefined, run).then((f) => ({ missing: f.watermarkMissing }), (e) => ({ err: String(e.message) }));
  const NOT_FOUND = () => { throw new Error("fatal: git cat-file: could not get object info"); };
  const rej = await facts(async (args) => { if (args[0] === "rev-parse") throw new Error("git rev-parse timed out after 10000ms"); return ""; });
  check("(M3) a rev-parse that THROWS (timeout-shaped) rejects out of readMainlineFacts — never classified missing", /timed out/.test(rej.err ?? ""));
  const killed = await facts(async () => "");
  check("(M3) an EXTERNALLY KILLED child (simple-git resolves empty stdout as success) is NOT proof of missing: empty rev-parse + empty cat-file ⇒ read error", killed.missing === undefined && /no positive/.test(killed.err ?? ""));
  const exists = await facts(async (args) => (args[0] === "cat-file" ? "commit" : ""));
  check("(M3) the empty rev-parse was a kill if git then says the object IS a commit ⇒ read error, never missing", exists.missing === undefined && /no positive/.test(exists.err ?? ""));
  const ctl = await facts(async (args) => { if (args[0] === "cat-file") NOT_FOUND(); return ""; });
  check("(M3) control: empty rev-parse + git's OWN not-found answer (a rejection naming the object) IS missing", ctl.missing === true);
  const otherErr = await facts(async (args) => { if (args[0] === "cat-file") throw new Error("spawn EAGAIN"); return ""; });
  check("(M3) control: any OTHER cat-file failure is a read error, not missing", otherErr.missing === undefined);
  const real = await MW.readMainlineFacts(P.repo, fake, { branch: MAIN, tip: canonHead() }, 10_000);
  check("(M3) REAL git: a dangling W IS positively missing (the not-found probe is a rejection in this git, so the positive rule is reachable)", real.watermarkMissing === true);
  setW(fake); const nT = mwEvents().length; const realReader = sessions.mainlineFactsReader;
  sessions.mainlineFactsReader = async () => { throw new Error("spawn EAGAIN"); };
  await bootCheck();
  await sessions.checkMainlineMove({ projectId: P.projId, repoKey: "primary", repoPath: P.repo, managerSessionId: null, workerSessionId: null, taskId: null, source: "landing" });
  sessions.mainlineFactsReader = realReader;
  check("(M3) the service fails OPEN on that error: no event, W untouched", mwEvents().length === nT && watermark().sha === fake);

  // ── (D1) the claim and the durable record are ONE synchronous step (a death in between must lose nothing) ──
  db.setMeta(aKey, JSON.stringify({ branch: MAIN, from: w0, to: canonHead(), evidence: ["reflog-raw-write"], suspectShas: [], nudgedAt: null }));
  const mgrD = addManager("d", "live"); const qBefore = db.listEventsSince(0, 100000).filter((e) => e.kind === "session_message_queued").length;
  sessions.deliverPendingBootAlerts(P.projId); // real enqueue path; waitForMcpSeen NEVER settles in ptyStub
  const svc2 = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, runGate: async () => ({ passed: true, steps: [] }), reapWorktreeProcesses: noReap }); // "the daemon died and came back" on the same Db
  const durable = db.listEventsSince(0, 100000).filter((e) => e.kind === "session_message_queued" && e.workerSessionId === mgrD && String(e.detail?.text).startsWith("[loom:mainline-moved]"));
  check("(D1) after the claim, a DURABLE session_message_queued record for the manager exists without waiting on the MCP handshake", marker()?.nudgedAt !== null && durable.length === 1 && db.listEventsSince(0, 100000).filter((e) => e.kind === "session_message_queued").length === qBefore + 1);
  check("(D1) control: a second service on the same Db finds the marker claimed and adds nothing (the record, not the claim, is what survives)", svc2.deliverPendingBootAlerts(P.projId) === 0);
  db.setProcessState(mgrD, "exited"); db.deleteMeta(aKey);

  // ── (D2) a THROW while enqueueing must not leave a claimed marker with no record ──
  const mgrT = addManager("t", "live");
  db.setMeta(aKey, JSON.stringify({ branch: MAIN, from: w0, to: canonHead(), evidence: ["reflog-raw-write"], suspectShas: [], nudgedAt: null }));
  const realEnq = sessions.enqueueDurableMessage; let threw = 0;
  sessions.enqueueDurableMessage = (...args) => { if (String(args[1]).startsWith("[loom:mainline-moved]") && threw++ === 0) throw new Error("enqueue boom"); return realEnq(...args); };
  const first = sessions.deliverPendingBootAlerts(P.projId);
  check("(D2) a throwing first enqueue: nothing delivered and the marker is UNCLAIMED again (still deliverable)", first === 0 && marker()?.nudgedAt === null);
  const second = sessions.deliverPendingBootAlerts(P.projId);
  sessions.enqueueDurableMessage = realEnq;
  check("(D2) the next attempt delivers it, once, and claims it", second === 1 && marker()?.nudgedAt !== null && nudges.filter((x) => x.to === mgrT).length === 1);
  db.setProcessState(mgrT, "exited"); db.deleteMeta(aKey);

  // ── (I1) an UNDELIVERED marker survives a later store() of W; (I2) a delivered one and an UNDONE move are dropped ──
  setW(canonHead()); nudges.length = 0;
  const wI = watermark().sha; const tipI = rawMove();
  await bootCheck();
  check("(I1) control: a pending (undelivered) marker exists for the raw move", marker()?.to === tipI && marker()?.nudgedAt === null && nudges.length === 0);
  const realR = sessions.mainlineFactsReader;
  sessions.mainlineFactsReader = async (...a) => ({ ...(await realR(...a)), reflog: null, untrailered: [], loomTipHits: [], loomTipsSkipped: true }); // the raw-write evidence is gone (e.g. an expired reflog) and the loom-tip signal was cap-skipped ⇒ non-alert verdict ⇒ store()
  const evI = mwEvents().length;
  await sessions.checkMainlineMove({ projectId: P.projId, repoKey: "primary", repoPath: P.repo, managerSessionId: null, workerSessionId: null, taskId: null, source: "landing" });
  sessions.mainlineFactsReader = realR;
  check("(I1) control: that landing check took the non-alert path (a low cap-skip event) and STORED W at the tip", mwEvents().length === evI + 1 && mwEvents().at(-1).detail.severity === "low" && watermark().sha === tipI);
  check("(I1) …and the UNDELIVERED marker is still there (a store() must not silence an alert nobody has read)", marker()?.to === tipI && marker()?.nudgedAt === null);
  // (I3) the reviewer's chain: the post-landing advance moves W FURTHER, then a check with tip==W must NOT drop the undelivered marker (its `to` no longer equals the tip); and a later landing ALERT about a DIFFERENT window (its W is not the marker's `from`) must not drop it either.
  const tipI2 = humanCommit(); setW(tipI2); await bootCheck();
  check("(I3) tip==W with W advanced past the marker's `to`: the UNDELIVERED marker is still there", marker()?.to === tipI && marker()?.nudgedAt === null);
  const tipI3 = rawMove(); nudges.length = 0;
  await sessions.checkMainlineMove({ projectId: P.projId, repoKey: "primary", repoPath: P.repo, managerSessionId: mgrS, workerSessionId: null, taskId: null, source: "landing" });
  check("(I3) control: that landing alerted about ITS window (a nudge to the confirming manager) and stored W", nudges.length === 1 && nudges[0].to === mgrS && watermark().sha === tipI3);
  check("(I3) …and did NOT drop the boot alert about the older move (its baseline is not this check's W)", marker()?.from === wI && marker()?.to === tipI && marker()?.nudgedAt === null);
  nudges.length = 0;
  const mgrI = addManager("i", "live"); sessions.onOrchestrationMcpFirstSeen(mgrI);
  check("(I1) …so the next manager contact still delivers it, once", nudges.length === 1 && nudges[0].to === mgrI && marker()?.nudgedAt !== null);
  db.setProcessState(mgrI, "exited");
  // (I2a) a DELIVERED marker is dropped by the next store() of W
  humanCommit(); await bootCheck();
  check("(I2a) a DELIVERED marker is dropped once W moves on (a clean boot verdict stores W)", marker() === null);
  // (I2b) an UNDONE move drops even an undelivered marker: main is put back to W, so there is nothing left to tell anyone
  setW(canonHead()); const wU = watermark().sha; const tipU = rawMove(); await bootCheck();
  check("(I2b) control: pending marker for a raw move", marker()?.to === tipU && marker()?.nudgedAt === null);
  git(P.repo, "update-ref", MAINREF, wU); git(P.repo, "reset", "-q", "--hard"); await bootCheck();
  check("(I2b) the move UNDONE (tip back at W, a different tip than the alerted one) drops the undelivered marker", marker() === null && canonHead() === wU);

  // ── (L) the not-found probe reads git's MESSAGE, so it runs with the locale pinned; a hostile ambient locale must not change the answer ──
  const stripL = (s) => s.replace(/^\s*\/\/.*$/gm, "");
  const PIN = /canonicalGit\(repoPath, timeoutMs, localReadGitEnv\(process\.env, \{ LC_ALL: "C", LANGUAGE: "C" \}\)\)/;
  const PIN_SAMPLE = 'canonicalGit(repoPath, timeoutMs, localReadGitEnv(process.env, { LC_ALL: "C", LANGUAGE: "C" }))';
  check("(L) control: the pin pattern matches a real call and NOT a commented-out one", PIN.test(PIN_SAMPLE) && !PIN.test(stripL("// " + PIN_SAMPLE)));
  check("(L) the probe runner is built on a canonicalGit with LC_ALL and LANGUAGE pinned to C", PIN.test(stripL(fs.readFileSync(new URL("../src/git/mainline-watch.ts", import.meta.url), "utf8"))));
  const savedLoc = { a: process.env.LC_ALL, b: process.env.LANGUAGE }; process.env.LC_ALL = "de_DE.UTF-8"; process.env.LANGUAGE = "de";
  const hostile = await MW.readMainlineFacts(P.repo, "e".repeat(40), { branch: MAIN, tip: canonHead() }, 10_000).then((f) => f.watermarkMissing, (e) => `err:${e.message}`);
  if (savedLoc.a === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = savedLoc.a; if (savedLoc.b === undefined) delete process.env.LANGUAGE; else process.env.LANGUAGE = savedLoc.b;
  check("(L) REAL git under a hostile ambient locale (de_DE): a dangling W is still detected as missing", hostile === true);

  // (L2) an EXPLICIT env makes simple-git's unsafe-operations guard inspect it: ambient GIT_ASKPASS & co. (VS Code's terminal sets GIT_ASKPASS) would make the probe throw on EVERY call ⇒ read error ⇒ the tripwire blind for the repo forever.
  const UNSAFE_AMBIENT = { GIT_ASKPASS: "C:/nope/askpass", SSH_ASKPASS: "C:/nope/ssh-askpass", GIT_SSH: "C:/nope/ssh", GIT_SSH_COMMAND: "C:/nope/ssh -x", GIT_PROXY_COMMAND: "C:/nope/proxy", GIT_TEMPLATE_DIR: "C:/nope/tpl", GIT_CONFIG_COUNT: "0" };
  const withAmbient = async (vars, fn) => { const saved = {}; for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; } try { return await fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } } };
  const probeMissing = () => MW.readMainlineFacts(P.repo, "f".repeat(40), { branch: MAIN, tip: canonHead() }, 10_000).then((f) => f.watermarkMissing, (e) => "err:" + e.message);
  check("(L2) control: with no unsafe ambient env a dangling W is detected as missing", (await probeMissing()) === true);
  check("(L2) with GIT_ASKPASS / SSH_ASKPASS / GIT_SSH(_COMMAND) / GIT_PROXY_COMMAND / GIT_TEMPLATE_DIR / GIT_CONFIG_COUNT ambient, a REAL-git dangling W is STILL detected as missing (the probe env must not trip simple-git's unsafe guard)", (await withAmbient(UNSAFE_AMBIENT, probeMissing)) === true);
  if (process.platform === "win32") check("(L2) win32: the SAME holds for a differently-cased spelling (Git_Askpass IS GIT_ASKPASS to git-for-windows)", (await withAmbient({ Git_Askpass: "C:/nope/askpass", Ssh_Askpass: "C:/nope/x" }, probeMissing)) === true);

  const B = await import("../dist/git/bounded.js");
  const baseEnv = { PATH: "/bin", GIT_ASKPASS: "a", SSH_ASKPASS: "b", GIT_SSH: "c", GIT_SSH_COMMAND: "d", GIT_PROXY_COMMAND: "e", GIT_TEMPLATE_DIR: "f", GIT_CONFIG_COUNT: "1", Lc_All: "de_DE", KEEP_ME: "k" };
  const pinned = B.localReadGitEnv(baseEnv, { LC_ALL: "C", LANGUAGE: "C" });
  check("(L2) localReadGitEnv: every transport-family key is removed, unrelated keys are kept, and the overrides are applied", ["GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_PROXY_COMMAND", "GIT_TEMPLATE_DIR", "GIT_CONFIG_COUNT"].every((k) => !(k in pinned)) && pinned.PATH === "/bin" && pinned.KEEP_ME === "k" && pinned.LC_ALL === "C" && pinned.LANGUAGE === "C");
  check("(L2) localReadGitEnv never mutates its input, and (win32) removes a differently-cased spelling of an override/transport key", baseEnv.GIT_ASKPASS === "a" && baseEnv.Lc_All === "de_DE" && (process.platform !== "win32" || (!("Lc_All" in pinned) && !("Git_Askpass" in B.localReadGitEnv({ Git_Askpass: "x" }, {})))));

  // ── (S) the chokepoint wiring: the gateway runs the hook only on the FIRST /mcp-orch/ contact (markMcpSeen newly true) ──
  const strip = (s) => s.replace(/^\s*\/\/.*$/gm, ""); // whole-line comments only: a block-comment stripper mis-pairs the `/*` inside the gateway's route glob strings
  const HOOK = /if \(deps\.pty\.markMcpSeen\(sessionId\) === true\) deps\.sessions\.onOrchestrationMcpFirstSeen\?\.\(sessionId\);/;
  const gw = strip(fs.readFileSync(new URL("../src/gateway/server.ts", import.meta.url), "utf8")), host = strip(fs.readFileSync(new URL("../src/pty/host.ts", import.meta.url), "utf8"));
  check("(S) control: the pattern matches a real call and NOT a commented-out one", HOOK.test("if (deps.pty.markMcpSeen(sessionId) === true) deps.sessions.onOrchestrationMcpFirstSeen?.(sessionId);") && !HOOK.test(strip("// if (deps.pty.markMcpSeen(sessionId) === true) deps.sessions.onOrchestrationMcpFirstSeen?.(sessionId);")));
  check("(S) the gateway wires the hook off markMcpSeen's newly-seen boolean", HOOK.test(gw));
  check("(S) PtyHost.markMcpSeen returns true ONLY when it newly marks (false for an unknown/dead/already-seen session)", /markMcpSeen\(sessionId: string\): boolean \{\s*const live = this\.findAnyLive\(sessionId\);\s*if \(!live\?\.alive \|\| live\.mcpSeen\) return false;[\s\S]*?return true;/.test(host));

  // ── deleteProject purges markers ──
  db.setMeta(aKey, JSON.stringify({ branch: MAIN, from: w0, to: canonHead(), evidence: [], suspectShas: [], nudgedAt: null }));
  db.deleteProject(P.projId);
  check("(R6) deleteProject purges the boot-alert marker (and the watermark)", db.getMeta(aKey) === undefined && db.getMeta(wKey) === undefined);
} finally {
  try { db.close(); } catch { /* already closed */ }
}

console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
