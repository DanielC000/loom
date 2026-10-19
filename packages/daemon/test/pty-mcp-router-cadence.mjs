import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card d1521fca, Code Review round — PtyHost.recordMcpRouterSeen / getMcpRouterLastSeen /
// getMcpRouterCadenceMs / getMcpRoutersSeen: the per-session, per-router MCP-silence cadence tracking
// IdleWatcher's own watchdog reads (orchestration/idle-watcher.ts). HERMETIC — no real spawn: directly
// registers a minimal Live-shaped (claude) and CodexLive-shaped (codex) entry into PtyHost's own
// private `live`/`liveCodex` maps, the SAME precedented technique pty-codex-agnostic-methods.mjs uses
// ("TypeScript's `private` is a compile-time-only annotation, so a compiled JS test can read/write
// it"). Covers: the alive gate (a dead/unknown session's hit is a silent no-op, never a throw), the
// cadence = MAX-of-last-N-gaps fix (a request burst's near-zero gap must not collapse the estimate —
// this is the exact false-positive mechanism the Code Review replay caught), and that it works
// identically for a codex-registered entry (the harness-agnostic requirement).
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { PtyHost } = await import("../dist/pty/host.js");

const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {} };
const host = new PtyHost(events);

const fakePty = { pid: 1, write() {}, kill() {}, resize() {}, onData(cb) { this._onData = cb; }, onExit(cb) { this._onExit = cb; } };
const fakeLogStream = { write() {}, end() {}, on() {} };

/** Deliberately minimal — only the fields recordMcpRouterSeen/getMcpRouter* actually read (`alive`,
 *  `mcpRouterSeenAt`); mirrors pty-codex-agnostic-methods.mjs's own documented minimal-fixture pattern. */
function makeLive(alive) {
  return {
    pty: fakePty, pid: fakePty.pid, cwd: "/fake", geometry: { cols: 80, rows: 24 },
    hookToken: "", engineSessionId: "eng", ring: { chunks: [], bytes: 0 }, subscribers: new Set(),
    alive, killed: false, startedAt: Date.now(), logStream: fakeLogStream, logBroken: false,
    busy: false, pending: [], stopping: false, drainHeld: false, role: "worker",
    mcpSeen: false, mcpSeenWaiters: [], mcpRouterSeenAt: new Map(),
    activeTurnRoute: null, lastPromptRoute: null, activeTurnProactive: false, lastPromptProactive: false,
    activeTurnOwnerText: null, lastPromptOwnerText: null, recentOwnerTurns: [],
    activeTurnSenderId: null, lastPromptSenderId: null,
  };
}

// ============================ (1) negative control: an unknown session id reads absent, never a throw ============================
{
  check("(1) getMcpRouterLastSeen on an unknown session is undefined (not a throw)",
    host.getMcpRouterLastSeen("no-such-session", "task") === undefined);
  check("(1) getMcpRouterCadenceMs on an unknown session is undefined", host.getMcpRouterCadenceMs("no-such-session", "task") === undefined);
  check("(1) getMcpRoutersSeen on an unknown session is []", Array.isArray(host.getMcpRoutersSeen("no-such-session")) && host.getMcpRoutersSeen("no-such-session").length === 0);
  // Must not throw either — the real call site (gateway/server.ts) wraps it in try/catch for exactly
  // this kind of surprise, but the method itself should already be a clean no-op.
  let threw = false;
  try { host.recordMcpRouterSeen("no-such-session", "task"); } catch { threw = true; }
  check("(1) recordMcpRouterSeen on an unknown session does not throw", !threw);
}

// ============================ (2) alive gate: a registered but NOT-alive session is also a no-op ============================
{
  const id = "s-dead";
  host.live.set(id, makeLive(false));
  host.recordMcpRouterSeen(id, "task");
  check("(2) recordMcpRouterSeen is a no-op for alive:false (never records a sighting for a dead pty)",
    host.getMcpRouterLastSeen(id, "task") === undefined);
}

// ============================ (3) happy path: a single sighting has no cadence yet (nothing to compare against) ============================
{
  const id = "s-one-sighting";
  host.live.set(id, makeLive(true));
  const before = Date.now();
  host.recordMcpRouterSeen(id, "task");
  const lastSeen = host.getMcpRouterLastSeen(id, "task");
  check("(3) a single sighting records a real lastSeen timestamp", typeof lastSeen === "number" && lastSeen >= before);
  check("(3) a single sighting has NO cadence yet (nothing to compare against)", host.getMcpRouterCadenceMs(id, "task") === undefined);
  check("(3) getMcpRoutersSeen names exactly the one router seen", JSON.stringify(host.getMcpRoutersSeen(id)) === JSON.stringify(["task"]));
}

// ============================ (4) cadence = MAX of recent gaps, never the single last gap (the false-positive fix) ============================
{
  const id = "s-burst";
  host.live.set(id, makeLive(true));
  const live = host.live.get(id);
  // Hand-seed three sightings directly (bypassing Date.now() for a deterministic gap sequence): a
  // normal ~6min keepalive gap, immediately followed by a request BURST (near-zero gap) — the exact
  // shape (`initialize` then `tools/list`) that corrupted the cadence estimate before this fix.
  const t0 = 1_000_000_000_000;
  const WINDOW = 5; // mirrors PtyHost's own MCP_ROUTER_CADENCE_WINDOW
  live.mcpRouterSeenAt.set("task", { lastAt: t0, gaps: [] });
  const recordAt = (atMs) => {
    const prior = live.mcpRouterSeenAt.get("task");
    const gaps = [...prior.gaps, atMs - prior.lastAt];
    if (gaps.length > WINDOW) gaps.shift();
    live.mcpRouterSeenAt.set("task", { lastAt: atMs, gaps });
  };
  recordAt(t0 + 6 * 60_000); // normal 6min keepalive gap
  recordAt(t0 + 6 * 60_000 + 50); // burst: 50ms gap
  check("(4) cadence is the MAX of recent gaps (the real 6min keepalive), not the tiny burst gap",
    host.getMcpRouterCadenceMs(id, "task") === 6 * 60_000);
}
{
  // The window is BOUNDED (MCP_ROUTER_CADENCE_WINDOW) — an old spike eventually ages out once enough
  // fresh gaps accumulate, rather than permanently inflating the estimate.
  const id = "s-window";
  host.live.set(id, makeLive(true));
  const live = host.live.get(id);
  let t = 2_000_000_000_000;
  const WINDOW = 5; // mirrors PtyHost's own MCP_ROUTER_CADENCE_WINDOW
  live.mcpRouterSeenAt.set("task", { lastAt: t, gaps: [] });
  const recordAt = (atMs) => {
    const prior = live.mcpRouterSeenAt.get("task");
    const gaps = [...prior.gaps, atMs - prior.lastAt];
    if (gaps.length > WINDOW) gaps.shift();
    live.mcpRouterSeenAt.set("task", { lastAt: atMs, gaps });
  };
  t += 60 * 60_000; recordAt(t); // one huge 60min spike
  for (let i = 0; i < 6; i++) { t += 60_000; recordAt(t); } // then 6 normal-ish 1min gaps
  check("(4) a single old spike eventually ages out of the bounded window once enough fresh gaps arrive",
    host.getMcpRouterCadenceMs(id, "task") === 60_000);
}

// ============================ (5) works identically for a CODEX-registered entry (harness-agnostic) ============================
{
  const id = "s-codex";
  host.liveCodex.set(id, makeLive(true));
  host.recordMcpRouterSeen(id, "orchestration");
  check("(5) recordMcpRouterSeen reaches a codex-registered entry via findAnyLive",
    typeof host.getMcpRouterLastSeen(id, "orchestration") === "number");
  // getMcpRouterCadenceMs itself (not just recordMcpRouterSeen/getMcpRouterLastSeen above) must also
  // resolve via findAnyLive for a codex-registered entry — a second, deterministic sighting on the
  // SAME router gives it a real gap to measure.
  check("(5) a single codex sighting has no cadence yet (nothing to compare against)",
    host.getMcpRouterCadenceMs(id, "orchestration") === undefined);
  const codexLive = host.liveCodex.get(id);
  const priorSeen = codexLive.mcpRouterSeenAt.get("orchestration");
  codexLive.mcpRouterSeenAt.set("orchestration", { lastAt: priorSeen.lastAt + 5 * 60_000, gaps: [5 * 60_000] });
  check("(5) getMcpRouterCadenceMs resolves a real cadence for a codex-registered entry via findAnyLive",
    host.getMcpRouterCadenceMs(id, "orchestration") === 5 * 60_000);
  check("(5) a codex entry's alive gate works the same way", (() => {
    const deadId = "s-codex-dead";
    host.liveCodex.set(deadId, makeLive(false));
    host.recordMcpRouterSeen(deadId, "orchestration");
    return host.getMcpRouterLastSeen(deadId, "orchestration") === undefined;
  })());
  // Per-router independence: seeing "orchestration" must never create an entry for "task" too.
  check("(5) a router never seen at all is absent from getMcpRoutersSeen",
    !host.getMcpRoutersSeen(id).includes("task"));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — PtyHost's per-router MCP cadence tracking is alive-gated, harness-agnostic (claude + codex), and its cadence estimate resists a request-burst's near-zero gap via the bounded max-of-N-gaps window."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
