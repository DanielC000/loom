import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 6f13746c — the merge-gate INTERVAL: CONFIG + TRUST-BOUNDARY + REST half. Deterministic, no claude/network:
// a real Db + SessionService over a stub pty, the real Platform/Setup routers (in-process MCP) and the real Fastify
// gateway (app.inject).
//
//   (1) resolveConfig/cadence: `mergeGateInterval` is unset by default; the ONE cadence derivation gives
//       every (gate on, whatever the interval) / interval (off + valid N) / never (off + no/invalid N).
//   (2) validators: the HUMAN validator accepts 1..1000 integers and REJECTS 0, 1001, 1.5, "5"; the AGENT
//       shape REJECTS the key (same trust class as mergeGate).
//   (3) the ELEVATED Platform-Lead project_configure (nested human-only list) and the setup router REJECT it,
//       and the Lead may not CLEAR a stored one (unset / prefix-unset / replace:true) — stored config unchanged.
//       CONTROL: a sibling nested key is still accepted/clearable (the rejection is specific to the interval).
//   (4) REST: PATCH /api/projects/:id/config stores/clears it; GET .../merge-gate/status has the contract shape
//       (404 for an unknown project); POST .../merge-gate/gate-next owes the NEXT landing a gate under ANY
//       cadence (`nextLandingGated:true`, `gateOwed:true`) and is 404 for an unknown project.
//   (5) agent-visible read: sessions.mergeGateAgentView carries exactly {cadence, interval, ungatedSinceLastPass,
//       nextLandingGated, gateOwed} (no ring, no shas) — the key-set pin for my_context / worker_merge review.
//
// NOT COVERED here: the merge behaviour itself (merge-gate-interval.mjs) and the web UI.
// Run: 1) build (turbo builds shared first), 2) node test/merge-gate-interval-config.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-mgint-cfg-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { resolveConfig, PLATFORM_DEFAULTS, resolveMergeGateCadence, MERGE_GATE_INTERVAL_MAX } = await import("@loom/shared");
const { PlatformMcpRouter, validateProjectConfigOverride, validateAgentProjectConfigOverride, HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// ============ (1) resolution + cadence ============
check("(1) PLATFORM_DEFAULTS has NO interval (unset = never gate while off)", PLATFORM_DEFAULTS.orchestration.mergeGateInterval === undefined);
check("(1) resolveConfig({}) leaves mergeGateInterval undefined", resolveConfig({}).orchestration.mergeGateInterval === undefined);
check("(1) a project override 5 resolves to 5", resolveConfig({ orchestration: { mergeGateInterval: 5 } }).orchestration.mergeGateInterval === 5);
const cad = (o) => resolveMergeGateCadence(o);
check("(1) cadence: gate on ⇒ every (interval ignored)", cad({ mergeGate: "on" }).cadence === "every" && cad({ mergeGate: "on", mergeGateInterval: 3 }).cadence === "every");
check("(1) cadence: off + N ⇒ interval/N", cad({ mergeGate: "off", mergeGateInterval: 3 }).cadence === "interval" && cad({ mergeGate: "off", mergeGateInterval: 3 }).interval === 3);
check("(1) cadence: off + unset ⇒ never", cad({ mergeGate: "off" }).cadence === "never" && cad({ mergeGate: "off" }).interval === null);
check("(1) cadence: off + an invalid stored value (0 / 1.5) ⇒ never, never a crash", cad({ mergeGate: "off", mergeGateInterval: 0 }).cadence === "never" && cad({ mergeGate: "off", mergeGateInterval: 1.5 }).cadence === "never");
check("(1) MERGE_GATE_INTERVAL_MAX is 1000", MERGE_GATE_INTERVAL_MAX === 1000);

// ============ (2) validators ============
const okv = (r) => r.ok === true;
const human = (v) => validateProjectConfigOverride({ orchestration: { mergeGateInterval: v } });
check("(2) human validator ACCEPTS 1, 5 and 1000", okv(human(1)) && okv(human(5)) && okv(human(1000)));
check("(2) human validator REJECTS 0, 1001, 1.5, \"5\", null", !okv(human(0)) && !okv(human(1001)) && !okv(human(1.5)) && !okv(human("5")) && !okv(human(null)));
const agentSet = validateAgentProjectConfigOverride({ orchestration: { mergeGateInterval: 5 } });
check("(2) AGENT project-config shape REJECTS orchestration.mergeGateInterval", !okv(agentSet) && /mergeGateInterval/.test(agentSet.error ?? ""));
check("(2) CONTROL: the AGENT shape still accepts a normal nested orchestration key", okv(validateAgentProjectConfigOverride({ orchestration: { maxConcurrentWorkers: 2 } })));
check("(2) the nested human-only list names BOTH orchestration.mergeGate and orchestration.mergeGateInterval", HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS.includes("orchestration.mergeGate") && HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS.includes("orchestration.mergeGateInterval"));

// ============ (3) routers ============
const now = new Date().toISOString();
const db = new Db();
const svc = new SessionService(db, { stop() {}, isAlive() { return false; }, enqueueStdin() {} }, new OrchestrationControl());
db.insertProject({ id: "pI", name: "I", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
async function callTool(server, name, args) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "merge-gate-interval-config-test", version: "0" });
  await client.connect(clientT);
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
const lead = () => new PlatformMcpRouter(db, svc).buildServer();
const before = JSON.stringify(db.getProject("pI").config);
const leadRes = await callTool(lead(), "project_configure", { projectId: "pI", config: { orchestration: { mergeGateInterval: 5 } } });
check("(3) elevated Platform-Lead project_configure REJECTS nested orchestration.mergeGateInterval", typeof leadRes.error === "string" && /mergeGateInterval/.test(leadRes.error));
const setupRes = await callTool(new SetupMcpRouter(db, svc).buildServer("SETUP"), "project_configure", { projectId: "pI", config: { orchestration: { mergeGateInterval: 5 } } });
check("(3) setup-surface project_configure REJECTS orchestration.mergeGateInterval", typeof setupRes.error === "string" && /mergeGateInterval/.test(setupRes.error));
check("(3) neither rejected write changed the stored config", JSON.stringify(db.getProject("pI").config) === before);
db.setProjectConfig("pI", { orchestration: { mergeGate: "off", mergeGateInterval: 5, maxConcurrentWorkers: 2 } });
const stored = JSON.stringify(db.getProject("pI").config);
const u1 = await callTool(lead(), "project_configure", { projectId: "pI", config: {}, unset: ["orchestration.mergeGateInterval"] });
check("(3) Lead unset of orchestration.mergeGateInterval is REFUSED", typeof u1.error === "string" && /mergeGateInterval/.test(u1.error));
const u2 = await callTool(lead(), "project_configure", { projectId: "pI", config: {}, unset: ["orchestration"] });
check("(3) Lead unset of the PREFIX \"orchestration\" is REFUSED", typeof u2.error === "string");
const u3 = await callTool(lead(), "project_configure", { projectId: "pI", config: { docLint: false }, replace: true });
check("(3) Lead replace:true that would drop the stored interval is REFUSED", typeof u3.error === "string");
check("(3) none of the refused writes changed the stored config", JSON.stringify(db.getProject("pI").config) === stored);
const u4 = await callTool(lead(), "project_configure", { projectId: "pI", config: {}, unset: ["orchestration.maxConcurrentWorkers"] });
check("(3) CONTROL: unsetting a SIBLING nested key works and the interval survives", !u4.error && db.getProject("pI").config?.orchestration?.mergeGateInterval === 5);
db.setProjectConfig("pI", {});

// ============ (4) REST ============
const stub = {};
const app = await buildServer({ db, pty: stub, sessions: svc, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });
try {
  const patch = async (payload) => app.inject({ method: "PATCH", url: "/api/projects/pI/config", payload });
  const r1 = await patch({ config: { orchestration: { mergeGate: "off", mergeGateInterval: 4 } } });
  check("(4) REST PATCH stores mergeGate:\"off\" + mergeGateInterval:4", r1.statusCode === 200 && db.getProject("pI").config?.orchestration?.mergeGateInterval === 4);
  const bad = await patch({ config: { orchestration: { mergeGateInterval: 0 } } });
  check("(4) REST PATCH REJECTS interval 0 (400) and leaves the stored value", bad.statusCode === 400 && db.getProject("pI").config?.orchestration?.mergeGateInterval === 4);
  const st = await app.inject({ method: "GET", url: "/api/projects/pI/merge-gate/status" });
  const sj = st.json();
  check("(4) GET status: 200 with the contract shape", st.statusCode === 200
    && sj.cadence === "interval" && sj.interval === 4 && sj.ungatedSinceLastPass === 0 && sj.nextLandingGated === false && sj.gateOwed === false
    && sj.lastPassAt === null && sj.lastFailure === null && Array.isArray(sj.recent) && sj.recent.length === 0);
  check("(4) GET status key set is EXACTLY the contract's", JSON.stringify(Object.keys(sj).sort()) === JSON.stringify(["cadence", "gateOwed", "interval", "lastFailure", "lastPassAt", "nextLandingGated", "recent", "repoKey", "ungatedSinceLastPass"]));
  check("(4) GET status for an unknown project is 404", (await app.inject({ method: "GET", url: "/api/projects/nope/merge-gate/status" })).statusCode === 404);
  const gn = await app.inject({ method: "POST", url: "/api/projects/pI/merge-gate/gate-next" });
  const gj = gn.json();
  check("(4) POST gate-next: 200, gateOwed:true, nextLandingGated:true (interval cadence)", gn.statusCode === 200 && gj.gateOwed === true && gj.nextLandingGated === true);
  check("(4) gate-next is DURABLE (a fresh read of the db agrees)", db.getMergeGateState("pI").gateOwed === true);
  check("(4) POST gate-next for an unknown project is 404", (await app.inject({ method: "POST", url: "/api/projects/nope/merge-gate/gate-next" })).statusCode === 404);
  // never cadence: gate-next still owes the next landing a gate
  db.putMergeGateState("pI", { ...db.getMergeGateState("pI"), gateOwed: false });
  await patch({ unset: ["orchestration.mergeGateInterval"] });
  const nv = (await app.inject({ method: "GET", url: "/api/projects/pI/merge-gate/status" })).json();
  check("(4) unsetting the interval over REST ⇒ cadence never, interval null", nv.cadence === "never" && nv.interval === null && nv.nextLandingGated === false);
  const gn2 = (await app.inject({ method: "POST", url: "/api/projects/pI/merge-gate/gate-next" })).json();
  check("(4) gate-next works under cadence never too", gn2.gateOwed === true && gn2.nextLandingGated === true && gn2.cadence === "never");
  await patch({ config: { orchestration: { mergeGate: "on" } } });
  const ev = (await app.inject({ method: "GET", url: "/api/projects/pI/merge-gate/status" })).json();
  check("(4) gate on ⇒ cadence every, nextLandingGated true, interval null", ev.cadence === "every" && ev.interval === null && ev.nextLandingGated === true);

  // ============ (4b) per-repo REST + human cadence change clears owed ============
  db.updateProject("pI", { repos: [{ key: "repoB", path: tmpHome + "-b" }] });
  const sB = await app.inject({ method: "GET", url: "/api/projects/pI/merge-gate/status?repoKey=repoB" });
  check("(4b) GET status?repoKey=repoB: 200 and names the repo", sB.statusCode === 200 && sB.json().repoKey === "repoB");
  check("(4b) GET status defaults to the primary repo (repoKey \"primary\")", (await app.inject({ method: "GET", url: "/api/projects/pI/merge-gate/status" })).json().repoKey === "primary");
  check("(4b) GET status?repoKey=nope is 404 (unknown repo)", (await app.inject({ method: "GET", url: "/api/projects/pI/merge-gate/status?repoKey=nope" })).statusCode === 404);
  db.putMergeGateState("pI", { ...db.getMergeGateState("pI", "primary"), gateOwed: false, ungatedSinceLastPass: 0 }, "primary");
  const gnB = await app.inject({ method: "POST", url: "/api/projects/pI/merge-gate/gate-next?repoKey=repoB" });
  check("(4b) POST gate-next?repoKey=repoB owes ONLY repo B (primary untouched)", gnB.statusCode === 200 && gnB.json().gateOwed === true && gnB.json().repoKey === "repoB" && db.getMergeGateState("pI", "primary").gateOwed === false && db.getMergeGateState("pI", "repoB").gateOwed === true);
  check("(4b) POST gate-next?repoKey=nope is 404", (await app.inject({ method: "POST", url: "/api/projects/pI/merge-gate/gate-next?repoKey=nope" })).statusCode === 404);
  // human cadence change clears gateOwed on every repo, keeps the counter, appends a `cleared` row
  db.putMergeGateState("pI", { ...db.getMergeGateState("pI", "repoB"), ungatedSinceLastPass: 3 }, "repoB");
  db.putMergeGateState("pI", { ...db.getMergeGateState("pI", "primary"), gateOwed: true, ungatedSinceLastPass: 1 }, "primary");
  await patch({ config: { orchestration: { mergeGate: "on" } } }); // stored: mergeGate on (already on) — a NO-OP change must NOT clear
  check("(4b) a PATCH that leaves mergeGate/mergeGateInterval UNCHANGED does not clear gateOwed", db.getMergeGateState("pI", "primary").gateOwed === true && db.getMergeGateState("pI", "repoB").gateOwed === true);
  const chg = await patch({ config: { orchestration: { mergeGate: "off", mergeGateInterval: 7 } } });
  const pA = db.getMergeGateState("pI", "primary"), pB = db.getMergeGateState("pI", "repoB");
  check("(4b) a HUMAN PATCH that CHANGES the cadence clears gateOwed on EVERY repo", chg.statusCode === 200 && pA.gateOwed === false && pB.gateOwed === false);
  check("(4b) …and pushes a `cleared` / cadence-changed ring row on each", pA.recent.at(-1)?.result === "cleared" && pA.recent.at(-1)?.reason === "cadence-changed" && pB.recent.at(-1)?.result === "cleared");
  check("(4b) …but does NOT reset the ungated counter (primary 1, repoB 3 — the unverified-on-main figure stays honest)", pA.ungatedSinceLastPass === 1 && pB.ungatedSinceLastPass === 3);
  db.putMergeGateState("pI", { ...db.getMergeGateState("pI", "primary"), gateOwed: true }, "primary");
  await patch({ config: { orchestration: { mergeGateInterval: 9 } } });
  check("(4b) changing ONLY mergeGateInterval also clears (7 → 9)", db.getMergeGateState("pI", "primary").gateOwed === false);
  db.putMergeGateState("pI", { ...db.getMergeGateState("pI", "primary"), gateOwed: true }, "primary");
  await patch({ unset: ["orchestration.mergeGateInterval"] });
  check("(4b) UNSETTING the interval (a cadence change ⇒ never) also clears", db.getMergeGateState("pI", "primary").gateOwed === false);

  // (4c) the clear compares the EFFECTIVE cadence: editing N while the gate is ON changes nothing, so a gate-next-owed flag survives
  await patch({ config: { orchestration: { mergeGate: "on" } } });
  db.putMergeGateState("pI", { ...db.getMergeGateState("pI", "primary"), gateOwed: true }, "primary");
  await patch({ config: { orchestration: { mergeGateInterval: 11 } } });
  check("(4c) editing mergeGateInterval while mergeGate is ON (effective cadence `every` unchanged) does NOT clear a gate-next-owed flag", db.getMergeGateState("pI", "primary").gateOwed === true);
  await patch({ config: { orchestration: { mergeGate: "off" } } });
  check("(4c) …but flipping the gate off (every -> interval) DOES clear it", db.getMergeGateState("pI", "primary").gateOwed === false);

  // ============ (5) agent-visible key set ============
  const view = svc.mergeGateAgentView("pI");
  check("(5) the agent view's key set is EXACTLY {repoKey, cadence, interval, ungatedSinceLastPass, nextLandingGated, gateOwed}",
    JSON.stringify(Object.keys(view).sort()) === JSON.stringify(["cadence", "gateOwed", "interval", "nextLandingGated", "repoKey", "ungatedSinceLastPass"]));
  check("(5) unknown project ⇒ undefined (never a fabricated view)", svc.mergeGateAgentView("nope") === undefined);
} finally {
  try { await app.close(); } catch { /* ignore */ }
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — mergeGateInterval is human-only on every agent path (agent validator, setup router, elevated Lead incl. clearing), validated 1..1000 on the human path, and the REST status/gate-next surface matches the contract."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
