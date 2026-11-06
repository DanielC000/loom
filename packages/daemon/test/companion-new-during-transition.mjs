import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 564eaffb — an owner "/new" sent while a companion recycle/upgrade is in flight (the dead-pty window).
// "/new" = "/clear" through submitTurn (held by withCompanionSelfHeal) + a persona reinject via a RAW pty enqueue
// (a dead pty DROPS it). Without holding the reinject too, the held "/clear" replays onto the successor with no
// persona behind it. Hermetic: temp LOOM_HOME, REAL Db + SessionService + REAL CompanionController/ChatGateway +
// REAL withCompanionSelfHeal + withCompanionTransitionHeldReinject, SCRIPTED pty double (no claude/daemon/network).
// The "/new" is injected deterministically inside the scripted pty's own death callback (after death, before the
// stop loop's next isAlive check), for BOTH recycle and upgrade.
//
// Run: 1) build, 2) node packages/daemon/test/companion-new-during-transition.mjs
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = useOwnLoomHome("loom-new-trans-");
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
const { withCompanionSelfHeal, withCompanionTransitionHeldReinject } = await import("../dist/companion/revive.js");
const { InAppChannel, IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");
const { CompanionController } = await import("../dist/companion/controller.js");

const now = new Date().toISOString();
const cwd = path.join(tmpHome, "cwd");
fs.mkdirSync(cwd, { recursive: true });
const db = new Db();
const projId = randomUUID();
db.insertProject({ id: projId, name: "NewTrans", repoPath: cwd, vaultPath: cwd, config: {}, createdAt: now, archivedAt: null });
const profileId = randomUUID();
db.insertProfile({
  id: profileId, name: "Companion", role: "assistant", description: "", allowDelta: [], skills: null, model: null, icon: null,
  browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false, connections: [], capabilities: [],
});
const agentId = randomUUID();
db.insertAgent({ id: agentId, projectId: projId, name: "Juno", startupPrompt: "AGENT_OWN_PROMPT", position: 0, profileId, endpoint: false, ioSchema: null });

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
  db.upsertCompanionConfig({
    sessionId: id, botTokenBlob: "", channel: IN_APP_CHANNEL, allowedChatId: id, chatScope: "dm",
    heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true, name: "Aria",
  });
  db.upsertCompanionBinding({ sessionId: id, channel: IN_APP_CHANNEL, chatId: id, scope: "dm" });
  return { id, eng };
};

/** Scripted pty: dies on its own timer during the stop loop's sleep, then runs onDeath (the "/new" injection).
 *  A dead pty returns {delivered:false} with NO position (host.ts contract) and records NOTHING — it drops. */
function makePty({ onDeath }) {
  const st = { alive: true, gen: 0, spawns: [], deliveries: [] };
  const pty = {
    isAlive: () => st.alive,
    isBusy: () => false,
    holdDrain() {}, releaseDrain() {},
    stop(_sid, mode) {
      if (mode === "graceful") setTimeout(() => { st.alive = false; onDeath?.(); }, 0);
      else st.alive = false;
    },
    spawn(opts) { st.spawns.push(opts); st.alive = true; st.gen++; },
    enqueueStdin(_sid, text, source) {
      if (!st.alive) return { delivered: false };
      st.deliveries.push({ text, source, gen: st.gen });
      return { delivered: false, position: st.deliveries.length };
    },
    flushPending: () => [],
    getPending: () => [],
    requeueQueuedMessage() {},
    getActiveTurnOrigin: () => null,
    getActiveTurnIsProactive: () => false,
  };
  return { st, pty };
}

/** Wire the REAL gateway exactly as index.ts does: healed submitTurn + held reinject over a raw enqueue. */
async function wire(svc, pty, id, { holdReinject = true } = {}) {
  const transition = { holdIfInFlight: (sid, replay) => svc.holdInboundDuringCompanionTransition(sid, replay) };
  const submitTurn = withCompanionSelfHeal((sid, text) => pty.enqueueStdin(sid, text, "system"), { resume: (sid) => { svc.resume(sid); }, transition });
  const rawReinject = (sid) => {
    const prompt = svc.composeCompanionReinjectPrompt(sid);
    if (prompt) pty.enqueueStdin(sid, `[loom:persona-reinject] ${prompt}`, "system");
    return !!prompt;
  };
  const inApp = new InAppChannel({
    record: (sid, author, text) => db.insertCompanionMessage({ id: randomUUID(), sessionId: sid, channel: IN_APP_CHANNEL, chatId: sid, author, text, createdAt: new Date().toISOString() }),
  });
  const cfg = {
    botToken: null, allowedChatId: id, sessionId: id, chatScope: "dm",
    homeChannel: IN_APP_CHANNEL, homeChatId: id, heartbeatIntervalMinutes: 0, heartbeatPrompt: "p",
  };
  const controller = new CompanionController({
    db, submitTurn, pty, hooks: { companionSessionIds: new Set() }, env: {}, inApp, resolveEffective: () => [cfg],
    reinjectPersona: holdReinject ? withCompanionTransitionHeldReinject(rawReinject, transition) : rawReinject,
  });
  await controller.reconcile();
  return controller;
}

/** After the op: the successor (gen 1) must have received "/clear" THEN the persona reinject, each exactly once. */
function assertSuccessor(label, st, ack) {
  const succ = st.deliveries.filter((d) => d.gen === 1);
  const iClear = succ.findIndex((d) => d.text === "/clear");
  const iPersona = succ.findIndex((d) => d.text.startsWith("[loom:persona-reinject]") && d.text.includes("Your name is Aria."));
  check(`${label}: the successor got "/clear" exactly once`, succ.filter((d) => d.text === "/clear").length === 1);
  check(`${label}: the successor got the persona reinject exactly once`, succ.filter((d) => d.text.startsWith("[loom:persona-reinject]")).length === 1);
  check(`${label}: persona lands AFTER the "/clear" (persona intact at the end)`, iClear >= 0 && iPersona > iClear);
  check(`${label}: the persona is the LAST thing the successor received`, succ.length > 0 && succ[succ.length - 1].text.startsWith("[loom:persona-reinject]"));
  check(`${label}: nothing was delivered to the dead/old pty (gen 0)`, st.deliveries.filter((d) => d.gen === 0).length === 0);
  check(`${label}: owner got the honest "fresh conversation" ack and /new was handled as a command`, ack && ack.accepted === false && ack.reason === "command" && ack.command === "new");
}

async function scenario(kind, opts = {}) {
  const { id } = mkSession(kind === "recycle");
  let controller = null; let pending = null;
  const { st, pty } = makePty({ onDeath: () => { pending = controller.handleInAppInbound(id, "/new"); } });
  const svc = new SessionService(db, pty, new OrchestrationControl());
  controller = await wire(svc, pty, id, opts);
  if (kind === "recycle") await svc.recycleCompanion(id); else await svc.upgradeCompanionCapabilities(id);
  const ack = await pending;
  return { st, ack, svc, id };
}

try {
  {
    const { st, ack, svc, id } = await scenario("recycle");
    check("recycle: exactly one FRESH spawn (no resumeId)", st.spawns.length === 1 && st.spawns[0].resumeId === undefined);
    assertSuccessor("recycle", st, ack);
    check("recycle: marker cleared", svc.isCompanionTransitionInFlight(id) === false);
  }
  {
    const { st, ack, svc, id } = await scenario("upgrade");
    check("upgrade: exactly one spawn, resuming the same transcript", st.spawns.length === 1 && st.spawns[0].resumeId !== undefined);
    assertSuccessor("upgrade", st, ack);
    check("upgrade: marker cleared", svc.isCompanionTransitionInFlight(id) === false);
  }
  // Control (the pre-fix behaviour): without the held reinject the persona is DROPPED on the dead pty.
  {
    const { st } = await scenario("upgrade", { holdReinject: false });
    check("control (reinject NOT held): persona never reaches the successor — proves the scenario can fail",
      st.deliveries.filter((d) => d.text.startsWith("[loom:persona-reinject]")).length === 0);
  }
  // Outside a transition the wrapper is a pure pass-through (immediate reinject).
  {
    const { id } = mkSession(false);
    const { st, pty } = makePty({});
    const svc = new SessionService(db, pty, new OrchestrationControl());
    const controller = await wire(svc, pty, id);
    await controller.handleInAppInbound(id, "/new");
    check("no transition: /clear then persona delivered immediately, in order",
      st.deliveries.length === 2 && st.deliveries[0].text === "/clear" && st.deliveries[1].text.startsWith("[loom:persona-reinject]"));
  }
} finally {
  db.close();
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
