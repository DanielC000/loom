import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card d10ac47e — an inbound chat message landing in the window between the OLD pty's exit and the
// recycle/upgrade stop loop's next isAlive check must NOT be self-healed onto the OLD engine id (recycle: the
// message lands in an abandoned transcript = LOST). With the in-flight marker it is HELD and replayed ONCE
// onto the successor. Hermetic: temp LOOM_HOME + sandboxed HOME, REAL Db + SessionService + REAL
// withCompanionSelfHeal, SCRIPTED pty double (no real claude/daemon/network). The window is injected
// deterministically: the scripted pty kills itself on a timer tick DURING the loop's 100 ms sleep and submits the
// inbound in that same callback, i.e. strictly after death and strictly before the loop's next check.
//
// Run: 1) build, 2) node packages/daemon/test/companion-self-heal-in-flight-transition.mjs
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = useOwnLoomHome("loom-selfheal-trans-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.CLAUDE_CONFIG_DIR;
process.env.LOOM_UPGRADE_BUSY_WAIT_MS = "300";

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { COMPANION_TRANSITION_MARKER_TTL_MS, UPGRADE_BUSY_WAIT_MAX_MS } = await import("../dist/sessions/service.js");
const { withCompanionSelfHeal } = await import("../dist/companion/revive.js");

const now = new Date().toISOString();
const cwd = path.join(tmpHome, "cwd");
fs.mkdirSync(cwd, { recursive: true });
const db = new Db();
const projId = randomUUID();
db.insertProject({ id: projId, name: "SelfHeal", repoPath: cwd, vaultPath: cwd, config: {}, createdAt: now, archivedAt: null });
const profileId = randomUUID();
db.insertProfile({
  id: profileId, name: "Companion", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null,
  browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false, connections: [], capabilities: [],
});
const agentId = randomUUID();
db.insertAgent({ id: agentId, projectId: projId, name: "Juno", startupPrompt: "You are Juno.", position: 0, profileId, endpoint: false, ioSchema: null });

const mkSession = (exhausted) => {
  const id = randomUUID();
  const eng = `eng-${id.slice(0, 8)}`;
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: eng, title: null, cwd,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "assistant", browserTesting: false, documentConversion: false, restrictedTools: false,
    noCommit: false, skills: null, connections: [], capabilities: [],
  });
  const tp = engineTranscriptPath(cwd, eng);
  fs.mkdirSync(path.dirname(tp), { recursive: true });
  fs.writeFileSync(tp, JSON.stringify({ type: "user", message: { content: "hello" } }) + "\n");
  if (exhausted) db.setContextExhausted(id, new Date().toISOString(), "Context exhausted");
  return { id, eng };
};

/** Scripted pty: alive until its own timer "exit" fires during the stop loop's sleep; that callback then submits
 *  the inbound (strictly after death, before the loop's next check). `spawnFailuresLeft` makes the next N spawns throw. */
function makePty({ onDeath, spawnFailuresLeft = 0, carry = [] }) {
  const st = { order: [], carryLeft: [...carry], alive: true, spawns: [], inbound: [], stops: [], gen: 0, deliveries: [], failLeft: spawnFailuresLeft };
  const pty = {
    isAlive: () => st.alive,
    isBusy: () => false,
    holdDrain() {}, releaseDrain() {},
    stop(_sid, mode) {
      st.stops.push(mode);
      if (mode === "graceful") setTimeout(() => { st.alive = false; onDeath?.(); }, 0);
      else st.alive = false; // a hard stop kills whatever is alive — incl. a wrongly auto-resumed pty
    },
    spawn(opts) {
      if (st.failLeft > 0) { st.failLeft--; throw new Error("injected spawn failure"); }
      st.spawns.push(opts); st.alive = true; st.gen++;
    },
    // dead pty ⇒ {delivered:false} with NO position (host.ts's enqueueStdin contract); alive ⇒ held in the FIFO.
    enqueueStdin(_sid, text) {
      if (!st.alive) return { delivered: false };
      st.deliveries.push({ text, gen: st.gen });
      st.order.push(text);
      return { delivered: false, position: st.deliveries.length };
    },
    flushPending: () => st.carryLeft.splice(0),
    getPending: () => [],
    requeueQueuedMessage(_sid, msg) { st.order.push(msg.text); },
  };
  return { st, pty };
}

const mkHealing = (svc, pty, extra = {}) => withCompanionSelfHeal(
  (sid, text) => pty.enqueueStdin(sid, text),
  { resume: (sid) => { svc.resume(sid); }, transition: { holdIfInFlight: (sid, replay) => svc.holdInboundDuringCompanionTransition(sid, replay) }, ...extra },
);

try {
  // ===================== 1. RECYCLE: inbound in the window is delivered exactly once, to the FRESH successor =====================
  {
    const { id } = mkSession(true);
    let healing = null; let injected = null;
    const { st, pty } = makePty({ onDeath: () => { injected = healing(id, "INBOUND-RECYCLE-1"); } });
    const svc = new SessionService(db, pty, new OrchestrationControl());
    healing = mkHealing(svc, pty);
    const res = await svc.recycleCompanion(id);
    const hits = st.deliveries.filter((d) => d.text === "INBOUND-RECYCLE-1");
    check("recycle: the in-window inbound was acked as queued (held), not dead", injected && injected.delivered === false && injected.position !== undefined);
    check("recycle: exactly ONE spawn, and it is FRESH (no resumeId) — self-heal did not resume the old engine", st.spawns.length === 1 && st.spawns[0].resumeId === undefined);
    check("recycle: the old pty was never hard-killed (no auto-resumed pty to kill)", !st.stops.includes("hard"));
    check("recycle: the inbound reached the pty EXACTLY once, and it was the successor (gen 1)", hits.length === 1 && hits[0].gen === 1);
    check("recycle: marker cleared after the op", svc.isCompanionTransitionInFlight(id) === false && res.id === id);
  }

  // ===================== 2. UPGRADE: same window, same guarantee =====================
  {
    const { id, eng } = mkSession(false);
    let healing = null; let injected = null;
    const { st, pty } = makePty({ onDeath: () => { injected = healing(id, "INBOUND-UPGRADE-1"); } });
    const svc = new SessionService(db, pty, new OrchestrationControl());
    healing = mkHealing(svc, pty);
    await svc.upgradeCompanionCapabilities(id);
    const hits = st.deliveries.filter((d) => d.text === "INBOUND-UPGRADE-1");
    check("upgrade: the in-window inbound was acked as queued (held)", injected && injected.delivered === false && injected.position !== undefined);
    check("upgrade: exactly ONE spawn (the upgrade's own resume), on the same engine id", st.spawns.length === 1 && st.spawns[0].resumeId === eng);
    check("upgrade: the inbound reached the pty EXACTLY once, on the successor (gen 1)", hits.length === 1 && hits[0].gen === 1);
    check("upgrade: marker cleared after the op", svc.isCompanionTransitionInFlight(id) === false);
  }

  // ===================== 3. the op THROWS mid-way: marker cleared, held inbound still delivered exactly once =====================
  {
    const { id } = mkSession(true);
    let healing = null;
    const { st, pty } = makePty({ onDeath: () => { healing(id, "INBOUND-THROW-1"); }, spawnFailuresLeft: 1 });
    const svc = new SessionService(db, pty, new OrchestrationControl());
    healing = mkHealing(svc, pty);
    let threw = false;
    try { await svc.recycleCompanion(id); } catch { threw = true; }
    const hits = st.deliveries.filter((d) => d.text === "INBOUND-THROW-1");
    check("throw: the recycle failed (injected spawn failure)", threw);
    check("throw: marker cleared on throw", svc.isCompanionTransitionInFlight(id) === false);
    check("throw: the held inbound was replayed once via a NORMAL self-heal (now unblocked) — exactly one delivery", hits.length === 1);
  }
  {
    const { pty } = makePty({});
    const svc = new SessionService(db, pty, new OrchestrationControl());
    const missing = randomUUID();
    let threw = false;
    try { await svc.upgradeCompanionCapabilities(missing); } catch { threw = true; }
    check("throw (early validation): marker cleared when the op throws before doing anything", threw && svc.isCompanionTransitionInFlight(missing) === false);
    let threwR = false;
    const { id: healthy } = mkSession(false); // not exhausted ⇒ recycle refuses
    try { await svc.recycleCompanion(healthy); } catch { threwR = true; }
    check("throw (recycle refusal): marker cleared", threwR && svc.isCompanionTransitionInFlight(healthy) === false);
  }

  // ===================== 4. marker bounds: TTL, concurrency, idempotent end() =====================
  {
    const { pty } = makePty({});
    const svc = new SessionService(db, pty, new OrchestrationControl());
    const sid = "sid-bounds";
    const replays = [];
    const endA = svc.beginCompanionTransition(sid);
    const endB = svc.beginCompanionTransition(sid);
    check("bounds: in flight with two concurrent tokens", svc.isCompanionTransitionInFlight(sid) === true);
    check("bounds: hold returns a 1-based position", svc.holdInboundDuringCompanionTransition(sid, () => replays.push("x")) === 1);
    endA();
    check("bounds: still in flight after ONE of two ends, nothing replayed yet", svc.isCompanionTransitionInFlight(sid) === true && replays.length === 0);
    endB(); endB(); endA();
    check("bounds: replayed exactly once after the LAST end; repeated end() is idempotent", replays.length === 1 && svc.isCompanionTransitionInFlight(sid) === false);
    check("bounds: with no marker, hold declines (self-heal proceeds)", svc.holdInboundDuringCompanionTransition(sid, () => {}) === null);

    const endLeak = svc.beginCompanionTransition("sid-leak"); // never ended: a leaked marker
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60_000;
    let afterTtl;
    try { afterTtl = svc.isCompanionTransitionInFlight("sid-leak"); } finally { Date.now = realNow; }
    check("bounds: a LEAKED marker stops blocking self-heal after its TTL", afterTtl === false);
    endLeak();
  }
  // ===================== 5. a replay that is STILL dead is reported, not silently acked =====================
  {
    const { id } = mkSession(true);
    let healing = null; const dead = [];
    const { st, pty } = makePty({ onDeath: () => { healing(id, "INBOUND-DEAD-1"); }, spawnFailuresLeft: 2 });
    const svc = new SessionService(db, pty, new OrchestrationControl());
    healing = mkHealing(svc, pty, { onReplayDead: (sid) => dead.push(sid) });
    try { await svc.recycleCompanion(id); } catch { /* expected: injected spawn failure */ }
    check("dead replay: the op failed AND the replay's self-heal left the pty dead", st.alive === false && st.deliveries.length === 0);
    check("dead replay: onReplayDead fired exactly once for the session", dead.length === 1 && dead[0] === id);
  }

  // ===================== 6. ordering: carried -> held1 -> held2, positions 1 and 2 =====================
  {
    const { id } = mkSession(true);
    let healing = null; const acks = [];
    const { st, pty } = makePty({
      carry: [{ text: "CARRIED-0" }],
      onDeath: () => { acks.push(healing(id, "HELD-1")); acks.push(healing(id, "HELD-2")); },
    });
    const svc = new SessionService(db, pty, new OrchestrationControl());
    healing = mkHealing(svc, pty);
    await svc.recycleCompanion(id);
    check("order: the two in-window inbounds got held positions 1 and 2", acks.length === 2 && acks[0].position === 1 && acks[1].position === 2);
    check("order: successor sees carried -> held1 -> held2", JSON.stringify(st.order) === JSON.stringify(["CARRIED-0", "HELD-1", "HELD-2"]));
  }

  // ===================== 7. TTL is derived from the bounds it protects; env can't push past it =====================
  {
    check("ttl: covers the busy wait + both stop loops (10 s) with margin", COMPANION_TRANSITION_MARKER_TTL_MS >= 3_000 + 10_000 + 30_000);
    check("ttl: the busy-wait ceiling plus the stop loops fits inside the TTL's margin class", UPGRADE_BUSY_WAIT_MAX_MS + 10_000 < 120_000);
    // this process set LOOM_UPGRADE_BUSY_WAIT_MS=300 above, so the TTL must track it (not a fixed 120 s)
    check("ttl: tracks the configured busy wait (300 ms here), not a fixed constant", COMPANION_TRANSITION_MARKER_TTL_MS === 300 + 10_000 + 60_000);
  }
} finally {
  db.close();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
