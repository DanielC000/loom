import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card af165ec7 — resume()'s own second-live-manager check (built on 0368c784's refuseSecondLiveManager)
// exempts EXACTLY one pairing: a session's own still-UNRECONCILED halted-recycle partner
// (isSanctionedHaltedPartner, orchestration/crash-orphaned-workers.ts — read that function's own doc for
// the full "why" before touching this file). This file proves the two properties that keep the exemption
// NARROW, each with a RED proof against a deliberately WIDENED exemption so the narrowing is shown to
// matter, not merely asserted:
//
//   (b) a NON-halted, RECONCILED pair (halted, then resolved via a REAL reattemptManagerOwnershipTransfer)
//       gets NO exemption — the second resume (of the now-stopped predecessor, while its successor is the
//       live, legitimate sole owner) is REFUSED. A widened exemption keyed on bare lineage (hasSuccessor/
//       recycledFrom, ignoring the halt/resolved state) would wrongly ALLOW it — proven inline by
//       evaluating that widened rule against the same pair and showing it diverges from the real one.
//   (c) the sanctioned partner IS exempted, but a THIRD, unrelated live manager for the SAME agent
//       (constructed adversarially — 0368c784 already prevents minting one through any ordinary spawn
//       path) is still refused — one hop only, never "any partner found ⇒ skip the whole scan". A widened
//       (one-pass, no re-scan) implementation would wrongly allow it — proven inline the same way.
//
// (a) — both halves of a genuinely halted, UNRESOLVED pair resuming across a restart — is already proven
// by three sibling files, left UNEDITED by this card: recycle-fleet-resolved-after-halted-boot-reconcile.mjs,
// resume-arms-halted-successor-observer.mjs, recycle-manager-halted-successor-dies.mjs.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db + SessionService against a fake pty (the shared
// createPty()/stop() seam), mirroring recycle-manager-halted-successor-dies.mjs's own harness.
//
// Run: 1) build (turbo builds shared first), 2) node test/resume-halted-partner-exemption.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

const tmpHome = path.join(os.tmpdir(), `loom-rhpe-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// Env-shorten every settle bound BEFORE importing dist/** (mirrors recycle-manager-halted-successor-dies.mjs).
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS = "40";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_POLL_MS = "15";
process.env.LOOM_RECYCLE_SUCCESSOR_SETTLE_TIMEOUT_MS = "3600000";
process.env.LOOM_MCP_READY_TIMEOUT_MS = "25";

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService, SecondLiveManagerError } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { encodeProjectDir } = await import("../dist/sessions/transcript.js");
const { isSanctionedHaltedPartner } = await import("../dist/orchestration/crash-orphaned-workers.js");

const repo = path.join(os.tmpdir(), `loom-rhpe-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# resume-halted-partner-exemption test\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=rhpe@loom -c user.name=rhpe");

class SeamHost extends createSeamHost(PtyHost) {
  handles = new Map();
  createPty(opts) {
    const pty = super.createPty(opts);
    this.handles.set(opts.sessionId, pty);
    return pty;
  }
}

function makeHarness() {
  const db = new Db();
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
    onReady(id) { db.setReachedReady(id); },
    onBusy(id, busy) { db.setBusy(id, busy); },
    onContextStats() {}, onRateLimited() {},
  };
  const host = new SeamHost(events);
  let sessions;
  host.events.onExit = (id, code, info) => {
    db.setProcessState(id, "exited");
    db.setBusy(id, false);
    const exited = db.getSession(id);
    if (exited) sessions.archiveOnExit(exited);
    if (exited) sessions.reconcileNeverStartedRecycleSuccessor(id, info.intended);
  };
  sessions = new SessionService(db, host, new OrchestrationControl());
  return { db, host, sessions };
}

function seedProject(db, id) {
  const now = new Date().toISOString();
  db.insertProject({ id, name: id, repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `${id}-mgr`, projectId: id, name: "Mgr", startupPrompt: "MGR", position: 0, profileId: null });
}

function writeFakeTranscript(cwd, engineSessionId) {
  const engineDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(path.resolve(cwd)));
  fs.mkdirSync(engineDir, { recursive: true });
  fs.writeFileSync(path.join(engineDir, `${engineSessionId}.jsonl`), "");
}

const hasEvent = (db, id, kind) => db.listEventsForSession(id).some((e) => e.kind === kind);

/** Forces the "wakes" ownership-transfer step to fail permanently, so recycleManager halts — mirrors
 *  recycle-manager-halted-successor-dies.mjs's own stub. Caller restores. */
function stubWakesPermanentFailure() {
  const original = Db.prototype.reparentWakes;
  Db.prototype.reparentWakes = function () { throw new Error("injected PERMANENT failure (resume-halted-partner-exemption test)"); };
  return () => { Db.prototype.reparentWakes = original; };
}

/** The deliberately WRONG, widened exemption both (b) and (c) are proven RED against: "any lineage
 *  partner, any state" — bare hasSuccessor/recycledFrom, ignoring whether the halt is still unresolved,
 *  and (for the two-hop-aware variant) never re-scanning for a third manager once ANY partner matches. */
function widenedPartnerAnyState(db, a, b) {
  return (db.hasSuccessor(a.id) && db.getSuccessor(a.id)?.id === b.id) ||
         (db.hasSuccessor(b.id) && db.getSuccessor(b.id)?.id === a.id) ||
         a.recycledFrom === b.id || b.recycledFrom === a.id;
}

try {
  // ==================== (b) NON-HALTED, RECONCILED PAIR — no exemption, second resume refused ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rhpe-b";
    seedProject(db, P);
    // markReady must run SYNCHRONOUSLY off deliverHook below (mirrors recycle-manager-halted-successor-dies.mjs's
    // own (H) scenario) — startupModeCycles:0 is what lets a real `reattemptManagerOwnershipTransfer` see
    // M2 as already durably ready, without needing the real mode-cycle footer-read machinery this fake pty
    // can never produce.
    db.setProjectConfig(P, { permission: { startupModeCycles: 0 } });
    const m1 = sessions.startManager(`${P}-mgr`);
    host.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-b" });
    writeFakeTranscript(m1.cwd, "eng-m1-b");

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions.recycleManager(m1.id, "handoff — forcing a halt to later resolve it");
    unstub();
    check("(b pre) the recycle HALTED", hasEvent(db, m2.id, "recycle_ownership_transfer_failed"));

    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-b" });
    writeFakeTranscript(m2.cwd, "eng-m2-b");
    check("(b pre) M2 reached real ready (durably resumable)", host.hasReachedReady(m2.id) === true);

    // While still halted-and-unresolved, the exemption must hold (sanity, not the point of this scenario).
    const m1Row0 = db.getSession(m1.id), m2Row0 = db.getSession(m2.id);
    check("(b pre) WHILE unresolved, isSanctionedHaltedPartner(M1,M2) is true", isSanctionedHaltedPartner(db, m1Row0, m2Row0) === true);

    const result = await sessions.reattemptManagerOwnershipTransfer(m1.id, "handoff — fully resolved now");
    check("(b) the reattempt RESOLVED (not reclaimed/still-split)", result?.outcome === "resolved");
    check("(b) recycle_ownership_transfer_resolved was filed", hasEvent(db, m1.id, "recycle_ownership_transfer_resolved"));

    const m1Stopped = await waitUntil(() => host.isAlive(m1.id) === false);
    check("(b) M1 was actually stopped by the resolved handoff (settleRecycleHandoff, fire-and-forget)", m1Stopped);
    check("(b) M2 remains the sole live owner", host.isAlive(m2.id) === true);

    const m1Row = db.getSession(m1.id), m2Row = db.getSession(m2.id);
    check("(b) FIX: isSanctionedHaltedPartner(M1,M2) is now FALSE — resolved means no longer unresolved",
      isSanctionedHaltedPartner(db, m1Row, m2Row) === false);
    check("(b) RED PROOF: a WIDENED exemption (bare lineage, ignoring resolved state) would WRONGLY say TRUE here",
      widenedPartnerAnyState(db, m1Row, m2Row) === true);

    let thrown;
    try { sessions.resume(m1.id); } catch (e) { thrown = e; }
    check("(b) FIX: resume() REFUSES the now-reconciled predecessor — no exemption for a resolved pair",
      !!thrown && thrown instanceof SecondLiveManagerError && thrown.holderSessionId === m2.id);
  }

  // ==================== (c) PARTNER EXEMPTED, BUT A THIRD UNRELATED LIVE MANAGER IS STILL REFUSED ====================
  {
    const { db, host, sessions } = makeHarness();
    const P = "rhpe-c";
    seedProject(db, P);
    const m1 = sessions.startManager(`${P}-mgr`);
    host.deliverHook(m1.id, { hook_event_name: "SessionStart", session_id: "eng-m1-c" });
    writeFakeTranscript(m1.cwd, "eng-m1-c");

    const unstub = stubWakesPermanentFailure();
    const m2 = await sessions.recycleManager(m1.id, "handoff — halt, stay unresolved for this scenario");
    unstub();
    // M2 must actually reach ready — a successor that dies BEFORE ever reaching SessionStart hits a
    // DIFFERENT path (reconcileNeverStartedRecycleSuccessor, wired on this harness's own onExit) that
    // unlinks recycledFrom outright, which would silently defeat this scenario's own "still-unresolved,
    // still-linked" precondition before isSanctionedHaltedPartner is ever exercised.
    host.deliverHook(m2.id, { hook_event_name: "SessionStart", session_id: "eng-m2-c" });
    writeFakeTranscript(m2.cwd, "eng-m2-c");
    check("(c pre) the recycle HALTED and stays unresolved", hasEvent(db, m2.id, "recycle_ownership_transfer_failed") && !hasEvent(db, m1.id, "recycle_ownership_transfer_resolved"));
    check("(c pre) M1 and M2 are BOTH still alive — the sanctioned coexistence window", host.isAlive(m1.id) === true && host.isAlive(m2.id) === true);

    // Adversarially construct a THIRD, UNRELATED live manager for the SAME agent as M1/M2 — 0368c784
    // already refuses minting one through any ordinary spawn path (startNew/startManager), so this is
    // built the only way such a state could ever exist: spawn it cleanly under its OWN agent (genuinely
    // alive), then rebind the row's agent_id directly — the SAME adversarial-DB-state technique
    // recycle-manager-halted-successor-dies.mjs's own (G)/(G') scenarios use.
    db.insertAgent({ id: `${P}-mgr3`, projectId: P, name: "Mgr3", startupPrompt: "MGR3", position: 1, profileId: null });
    const m3 = sessions.startManager(`${P}-mgr3`);
    host.deliverHook(m3.id, { hook_event_name: "SessionStart", session_id: "eng-m3-c" });
    writeFakeTranscript(m3.cwd, "eng-m3-c");
    check("(c setup) M3 spawned cleanly alive under its OWN agent", host.isAlive(m3.id) === true);
    db.db.prepare("UPDATE sessions SET agent_id = ? WHERE id = ?").run(`${P}-mgr`, m3.id);
    check("(c setup) M3 is now rebound onto M1/M2's own agent, still genuinely alive", db.getSession(m3.id)?.agentId === `${P}-mgr` && host.isAlive(m3.id) === true);
    // listAllSessions orders by last_activity DESC — M3 (just spawned) would otherwise sort BEFORE M2,
    // so the scan's FIRST pass would already land on the unrelated M3 and the two-pass/"must re-scan"
    // property below would never actually be exercised. Re-touch M2's last_activity so it sorts first
    // again, same as it would the instant AFTER the halt (long before M3 ever existed) in a real lineage.
    db.db.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?").run(new Date().toISOString(), m2.id);

    // M1 (the predecessor) is the one resumed in this scenario — kill it (simulating a predecessor crash;
    // the "halted predecessors are never stopped by the SYSTEM" invariant is about recycleManager/
    // settleRecycleHandoff's own behavior, not a restriction on this test exercising resume() directly).
    // M2 (sanctioned partner) and M3 (unrelated) are BOTH live when M1's resume is attempted.
    host.handles.get(m1.id).kill();
    check("(c pre) M1 is no longer alive; M2 and M3 both still are", host.isAlive(m1.id) === false && host.isAlive(m2.id) === true && host.isAlive(m3.id) === true);

    const m1Row = db.getSession(m1.id), m2Row = db.getSession(m2.id), m3Row = db.getSession(m3.id);
    void m3Row;
    check("(c) M2 is M1's sanctioned (still-unresolved) halted partner", isSanctionedHaltedPartner(db, m1Row, m2Row) === true);
    check("(c) M3 is NOT a sanctioned partner of M1 (unrelated lineage)", isSanctionedHaltedPartner(db, m1Row, m3Row) === false);

    // RED PROOF: a WIDENED, ONE-PASS implementation ("find a live holder; if ANY partner rule matches,
    // exempt and STOP — never re-scan for a third") would find M2 first, see it matches even the real
    // (correct, narrow) partner predicate, and exempt — wrongly never looking at M3 at all. This is a
    // DIFFERENT widening axis than (b)'s (state, not hop-count) — the real two-pass implementation below
    // is what closes exactly this gap.
    const localFindLiveManagerForAgent = (agentId, excludeIds) => db.listAllSessions().find((s) =>
      s.agentId === agentId && !excludeIds.includes(s.id) && s.role === "manager" &&
      (s.processState === "live" || s.processState === "starting") && host.isAlive(s.id));
    const widenedOnePassHolder = (() => {
      const holder = localFindLiveManagerForAgent(m1Row.agentId, [m1Row.id]);
      if (holder && isSanctionedHaltedPartner(db, m1Row, holder)) return undefined; // exempt, STOP — no re-scan
      return holder;
    })();
    check("(c) RED PROOF: a widened ONE-PASS check (stop at the first partner match, never re-scan) finds NOBODY to refuse — it never even looks at M3",
      widenedOnePassHolder === undefined);

    let thrown;
    try { sessions.resume(m1.id); } catch (e) { thrown = e; }
    check("(c) FIX: resume() still REFUSES M1 — the sanctioned partner (M2) is excluded from the scan, surfacing the genuinely unrelated M3",
      !!thrown && thrown instanceof SecondLiveManagerError && thrown.holderSessionId === m3.id);
    check("(c) M2 was never named by this refusal (it is not the holder)", thrown?.holderSessionId !== m2.id);
  }
} finally {
  // Nothing to clean up beyond the OS temp dirs — each harness closes its own Db implicitly on process exit.
}

console.log(failures === 0
  ? "\n✅ ALL PASS — resume()'s second-live-manager exemption (af165ec7) covers EXACTLY a session's own still-unresolved halted-recycle partner: a reconciled (resolved) pair gets no exemption and the now-redundant predecessor is refused, and an exempted partner never masks a genuinely unrelated third live manager for the same agent — both properties shown to fail under a deliberately widened exemption."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
