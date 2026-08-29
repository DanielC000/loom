import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// C5 of the WS delta-push umbrella (1efde4ba) — the orchestration-STATUS change-feed
// (OrchestrationControl.statusChangeListener → fleetHub.broadcast → `status` on /ws/fleet), the same job
// C3 (ws-fleet-session-feed.mjs) did for SESSION one feed over. HERMETIC + CLAUDE-FREE + NETWORK-FREE
// (Db + buildServer via @fastify/websocket's injectWS, like the other ws-fleet-*.mjs specs) — the
// loopback path needs no gateway token.
//
// Proves:
//   1. A REAL OrchestrationControl's pause() mutation emits a `status` delta on a connected socket,
//      carrying the live pausedScopes() AND the boot-time schedulerEnabled this daemon was built with.
//   2. resume() emits its own delta reflecting the now-empty pausedScopes.
//   3. A named (non-"global") scope shows up in pausedScopes by name.
//   4. schedulerEnabled is carried on EVERY emitted delta, constant across mutations (it's a fixed
//      boot-time const — see GatewayDeps' own doc — never a per-mutation input).
//   5. The listener is wired regardless of CALL SITE: this only calls control.pause()/resume() directly
//      (the same method SessionService.killAllWorkers() and the /api/orchestration/pause|resume REST
//      routes call) — proving the feed at the state-owning method, not at each caller, covers all of them
//      without a dedicated test per caller.
//   6. The REST endpoint (/api/orchestration/status) is preserved and still reflects live state — the
//      change-feed is additive, not a replacement.
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-ws-fleet-stf-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45348"; // distinct from ws-fleet.mjs(45343)/ws-json-hardening.mjs(45345)/ws-fleet-session-feed.mjs(45346)/companion-owner-attribution-boundary.mjs(45347)
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { FleetHub } = await import("../dist/gateway/fleet-hub.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Same queued-inbox seam as the other ws-fleet-*.mjs specs: wired via injectWS's `onInit` hook so the
// FIRST message (the server's own `hello`, sent synchronously on open) is never missed by a listener
// attached too late.
function makeInbox() {
  const queue = [];
  let waiter = null;
  const onInit = (ws) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (waiter) { const resolve = waiter; waiter = null; resolve(msg); } else queue.push(msg);
    });
  };
  const next = (ms = 500) => {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiter = null; resolve(null); }, ms);
      waiter = (msg) => { clearTimeout(timer); resolve(msg); };
    });
  };
  return { onInit, next };
}

const db = new Db(path.join(TMP, "loom.db"));
const control = new OrchestrationControl(); // the REAL class — not a stub — so pause()/resume() exercise the actual listener wiring
const fleetHub = new FleetHub();

const app = await buildServer({
  db, pty: {}, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {},
  setupMcp: {}, runMcp: {}, control, usageStatus: {}, requestShutdown: () => {},
  schedulerEnabled: true, // fixed boot-time value (5) — must be echoed unchanged on every delta below
  fleetHub,
});

try {
  await app.ready();

  const inbox = makeInbox();
  const ws = await app.injectWS("/ws/fleet", { headers: { host: "127.0.0.1" } }, { onInit: inbox.onInit });
  const hello = await inbox.next();
  check("connecting sends {t:'hello',v:1}", hello?.t === "hello" && hello.v === 1);

  // --- (1) pause() emits a status delta with live pausedScopes + boot-time schedulerEnabled -----------
  control.pause("global");
  const status1 = await inbox.next();
  check("(1) control.pause('global') emits a status delta", status1?.t === "status");
  check("(1) delta carries the live pausedScopes", Array.isArray(status1?.pausedScopes) && status1.pausedScopes.includes("global"));
  check("(1) delta carries the boot-time schedulerEnabled", status1?.schedulerEnabled === true);

  // --- (2) resume() emits its own delta reflecting the now-empty pausedScopes --------------------------
  control.resume("global");
  const status2 = await inbox.next();
  check("(2) control.resume('global') emits its own status delta", status2?.t === "status");
  check("(2) delta reflects the now-empty pausedScopes", Array.isArray(status2?.pausedScopes) && status2.pausedScopes.length === 0);

  // --- (3) a named (non-'global') scope shows up in pausedScopes by name --------------------------------
  control.pause("mgr-1");
  const status3 = await inbox.next();
  check("(3) pausing a named manager scope shows it by name in pausedScopes",
    Array.isArray(status3?.pausedScopes) && status3.pausedScopes.length === 1 && status3.pausedScopes[0] === "mgr-1");

  // --- (4) schedulerEnabled stays constant across mutations (it's a fixed boot-time const) --------------
  control.resume("mgr-1");
  const status4 = await inbox.next();
  check("(4) schedulerEnabled is unchanged by a pausedScopes mutation", status4?.schedulerEnabled === true);

  // --- (6) the REST endpoint is preserved and still reflects live state (additive, not a replacement) ---
  control.pause("global");
  await inbox.next(); // drain the delta this pause triggers so it doesn't leak into a later check
  const rest = await app.inject({ method: "GET", url: "/api/orchestration/status" });
  const restBody = rest.json();
  check("(6) GET /api/orchestration/status is preserved and reflects the same live pausedScopes",
    Array.isArray(restBody.pausedScopes) && restBody.pausedScopes.includes("global"));
  check("(6) GET /api/orchestration/status still reflects schedulerEnabled", restBody.schedulerEnabled === true);
  control.resume("global");
  await inbox.next(); // drain

  ws.terminate();
} finally {
  await app.close();
  db.close();
  // TMP's own trailing cleanup loop removed here: mkdtempManaged already registered it for guaranteed
  // cleanup at process exit (card 995be21f).
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a real OrchestrationControl's pause()/resume() mutations each emit a `status` delta on a connected /ws/fleet socket, carrying the live pausedScopes and the constant boot-time schedulerEnabled; the REST endpoint stays live and unaffected."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
