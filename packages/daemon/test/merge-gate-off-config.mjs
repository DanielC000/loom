import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e8df2659 — the per-project, HUMAN-only `orchestration.mergeGate: "on" | "off"` switch: CONFIG half.
// Deterministic, no claude/network/daemon: a real Db + SessionService over a stub pty.
//
//   (1) resolveConfig: default "on"; a project override "off" resolves to "off"; "on" stays "on".
//   (2) validators: the human project validator ACCEPTS {orchestration:{mergeGate:"off"}}, REJECTS a bad value;
//       the AGENT shape (mcp/platform.ts `agentOrchestrationOverride`) REJECTS the key.
//   (3) the ELEVATED Platform-Lead `project_configure` (shares the FULL human validator, and its
//       HUMAN_ONLY_PROJECT_CONFIG_KEYS check is TOP-LEVEL only) REJECTS the NESTED `orchestration.mergeGate`
//       via HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS — and the stored config is unchanged. The setup router
//       (agent validator) rejects it too.
//   CONTROLS: the same routers still accept a normal key (docLint) and a normal nested orchestration key
//   (maxConcurrentWorkers) — the rejection is specific to mergeGate, not to nested `orchestration`.
//
// NOT COVERED here: the merge behaviour itself (merge-gate-off.mjs) and the web Settings toggle (e2e).
// Run: 1) build (turbo builds shared first), 2) node test/merge-gate-off-config.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-mgoff-cfg-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { resolveConfig, PLATFORM_DEFAULTS } = await import("@loom/shared");
const { PlatformMcpRouter, validateProjectConfigOverride, validateAgentProjectConfigOverride, HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// ============ (1) resolution ============
check("(1) PLATFORM_DEFAULTS.orchestration.mergeGate is \"on\"", PLATFORM_DEFAULTS.orchestration.mergeGate === "on");
check("(1) resolveConfig(undefined) ⇒ \"on\"", resolveConfig(undefined).orchestration.mergeGate === "on");
check("(1) resolveConfig({}) ⇒ \"on\"", resolveConfig({}).orchestration.mergeGate === "on");
check("(1) a project override \"off\" resolves to \"off\"", resolveConfig({ orchestration: { mergeGate: "off" } }).orchestration.mergeGate === "off");
check("(1) a project override \"on\" stays \"on\"", resolveConfig({ orchestration: { mergeGate: "on" } }).orchestration.mergeGate === "on");

// ============ (2) validators ============
const ok = (r) => r.ok === true;
check("(2) human project validator ACCEPTS mergeGate:\"off\"", ok(validateProjectConfigOverride({ orchestration: { mergeGate: "off" } })));
check("(2) human project validator REJECTS a bad value", !ok(validateProjectConfigOverride({ orchestration: { mergeGate: "maybe" } })));
const agentSet = validateAgentProjectConfigOverride({ orchestration: { mergeGate: "off" } });
check("(2) AGENT project-config shape REJECTS orchestration.mergeGate", !ok(agentSet) && /mergeGate/.test(agentSet.error ?? ""));
check("(2) CONTROL: the AGENT shape still accepts a normal nested orchestration key", ok(validateAgentProjectConfigOverride({ orchestration: { maxConcurrentWorkers: 2 } })));
check("(2) the nested human-only list names orchestration.mergeGate", HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS.includes("orchestration.mergeGate"));

// ============ (3) routers ============
const now = new Date().toISOString();
const db = new Db();
const svc = new SessionService(db, { stop() {}, isAlive() { return false; }, enqueueStdin() {} }, new OrchestrationControl());
db.insertProject({ id: "pM", name: "M", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });

async function callTool(server, name, args) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "merge-gate-off-config-test", version: "0" });
  await client.connect(clientT);
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

const storedBefore = JSON.stringify(db.getProject("pM").config);
const leadRes = await callTool(new PlatformMcpRouter(db, svc).buildServer(), "project_configure", { projectId: "pM", config: { orchestration: { mergeGate: "off" } } });
check("(3) elevated Platform-Lead project_configure REJECTS nested orchestration.mergeGate", typeof leadRes.error === "string" && /mergeGate/.test(leadRes.error));
const setupRes = await callTool(new SetupMcpRouter(db, svc).buildServer("SETUP"), "project_configure", { projectId: "pM", config: { orchestration: { mergeGate: "off" } } });
check("(3) setup-surface project_configure REJECTS orchestration.mergeGate", typeof setupRes.error === "string" && /mergeGate/.test(setupRes.error));
check("(3) neither rejected write changed the stored project config", JSON.stringify(db.getProject("pM").config) === storedBefore);
const leadNormal = await callTool(new PlatformMcpRouter(db, svc).buildServer(), "project_configure", { projectId: "pM", config: { orchestration: { maxConcurrentWorkers: 2 } } });
check("(3) CONTROL: the Lead's project_configure still accepts a normal nested orchestration key", !leadNormal.error && db.getProject("pM").config?.orchestration?.maxConcurrentWorkers === 2);
const leadTop = await callTool(new PlatformMcpRouter(db, svc).buildServer(), "project_configure", { projectId: "pM", config: { docLint: false } });
check("(3) CONTROL: the Lead's project_configure still accepts a normal top-level key", !leadTop.error);

// ============ (4) human-only means BOTH directions: the Lead may not CLEAR a stored key either ============
db.setProjectConfig("pM", { orchestration: { mergeGate: "off", maxConcurrentWorkers: 2 }, docLint: false });
const stored4 = JSON.stringify(db.getProject("pM").config);
const lead = () => new PlatformMcpRouter(db, svc).buildServer();
const unsetExact = await callTool(lead(), "project_configure", { projectId: "pM", config: {}, unset: ["orchestration.mergeGate"] });
check("(4) Lead unset of orchestration.mergeGate is REFUSED", typeof unsetExact.error === "string" && /mergeGate/.test(unsetExact.error));
const unsetPrefix = await callTool(lead(), "project_configure", { projectId: "pM", config: {}, unset: ["orchestration"] });
check("(4) Lead unset of the PREFIX \"orchestration\" (which would drop the stored key) is REFUSED", typeof unsetPrefix.error === "string" && /mergeGate/.test(unsetPrefix.error));
const replaceDrop = await callTool(lead(), "project_configure", { projectId: "pM", config: { docLint: false }, replace: true });
check("(4) Lead replace:true that would drop the stored key is REFUSED", typeof replaceDrop.error === "string" && /mergeGate/.test(replaceDrop.error));
for (const shape of ["orchestration.mergeGate.", ".orchestration.mergeGate", "orchestration..mergeGate", "orchestration.", ".orchestration"]) {
  const sh = await callTool(lead(), "project_configure", { projectId: "pM", config: {}, unset: [shape] });
  check(`(4) Lead unset spelled ${JSON.stringify(shape)} (normalizes to a path that would drop the key) is REFUSED`, typeof sh.error === "string" && /mergeGate/.test(sh.error));
}
check("(4) none of the refused writes changed the stored config", JSON.stringify(db.getProject("pM").config) === stored4);
const unsetOther = await callTool(lead(), "project_configure", { projectId: "pM", config: {}, unset: ["docLint"] });
check("(4) CONTROL: unsetting an unrelated key still works and the stored mergeGate survives", !unsetOther.error && db.getProject("pM").config?.orchestration?.mergeGate === "off" && db.getProject("pM").config?.docLint === undefined);
const unsetOtherNested = await callTool(lead(), "project_configure", { projectId: "pM", config: {}, unset: ["orchestration.maxConcurrentWorkers"] });
check("(4) CONTROL: unsetting a SIBLING nested key works and mergeGate survives", !unsetOtherNested.error && db.getProject("pM").config?.orchestration?.mergeGate === "off");
db.setProjectConfig("pM", { docLint: false });
const replaceFree = await callTool(lead(), "project_configure", { projectId: "pM", config: { docLint: true }, replace: true });
check("(4) CONTROL: replace:true is still allowed when NO human-only key is stored", !replaceFree.error);

db.close();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — mergeGate defaults \"on\", resolves per project, and every agent path (agent validator, setup router, ELEVATED Platform-Lead incl. the nested key) rejects the human-only key while the human validator accepts it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
