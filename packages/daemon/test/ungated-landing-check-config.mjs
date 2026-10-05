import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card bd9a483b — the ungated-landing-check safety net: CONFIG + TRUST-BOUNDARY half. Deterministic, no
// claude/network: a real Db + SessionService over a stub pty, the real Platform/Setup routers (in-process MCP).
//
//   (1) resolveConfig: `ungatedLandingCheckCommand`/`ungatedLandingCheckTimeoutMs` default empty/600000 and
//       pair the same way gateCommand/gateCommandTimeoutMs do.
//   (2) validators: the HUMAN validator accepts a real command and REJECTS a whitespace/"&&"-only one (same
//       gateCommandSchema refine gateCommand itself uses); the timeout validates against its own bounds; the
//       AGENT shape REJECTS both keys (same trust class as gateCommand).
//   (3) the ELEVATED Platform-Lead project_configure ACCEPTS ungatedLandingCheckCommand — UNLIKE
//       mergeGate/mergeGateInterval, this key does not change cadence/counter semantics, so it is NOT on the
//       nested human-only list the Lead is otherwise refused. The setup (agent-shape) router still REJECTS it.
//
// NOT COVERED here: the landing-check's own execution/refusal behaviour (ungated-landing-check.mjs).
// Run: 1) build (turbo builds shared first), 2) node test/ungated-landing-check-config.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-ulc-cfg-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { resolveConfig, PLATFORM_DEFAULTS, ORCHESTRATION_TIMEOUT_MS_BOUNDS } = await import("@loom/shared");
const { PlatformMcpRouter, validateProjectConfigOverride, validateAgentProjectConfigOverride, HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// ============ (1) resolution ============
check("(1) PLATFORM_DEFAULTS has an EMPTY ungatedLandingCheckCommand (no check by default)", PLATFORM_DEFAULTS.orchestration.ungatedLandingCheckCommand === "");
check("(1) PLATFORM_DEFAULTS ungatedLandingCheckTimeoutMs is 600000", PLATFORM_DEFAULTS.orchestration.ungatedLandingCheckTimeoutMs === 600000);
check("(1) resolveConfig({}) leaves the command empty and the timeout at the default", resolveConfig({}).orchestration.ungatedLandingCheckCommand === "" && resolveConfig({}).orchestration.ungatedLandingCheckTimeoutMs === 600000);
check("(1) a project override pairs the SAME way gateCommand/gateCommandTimeoutMs do", (() => {
  const r = resolveConfig({ orchestration: { ungatedLandingCheckCommand: "pnpm guards", ungatedLandingCheckTimeoutMs: 300000 } }).orchestration;
  return r.ungatedLandingCheckCommand === "pnpm guards" && r.ungatedLandingCheckTimeoutMs === 300000;
})());
check("(1) ORCHESTRATION_TIMEOUT_MS_BOUNDS carries ungatedLandingCheckTimeoutMs {min:1000,max:1800000}", ORCHESTRATION_TIMEOUT_MS_BOUNDS.ungatedLandingCheckTimeoutMs.min === 1000 && ORCHESTRATION_TIMEOUT_MS_BOUNDS.ungatedLandingCheckTimeoutMs.max === 1_800_000);

// ============ (2) validators ============
const okv = (r) => r.ok === true;
const human = (v) => validateProjectConfigOverride({ orchestration: { ungatedLandingCheckCommand: v } });
check("(2) human validator ACCEPTS a real command", okv(human("pnpm guards")));
check("(2) human validator ACCEPTS an empty string (disables the check)", okv(human("")));
check("(2) human validator REJECTS a whitespace/\"&&\"-only command (same gateCommandSchema refine as gateCommand)", !okv(human("  &&  ")) && !okv(human("&&")));
const humanTimeout = (v) => validateProjectConfigOverride({ orchestration: { ungatedLandingCheckTimeoutMs: v } });
check("(2) human validator ACCEPTS the timeout within bounds", okv(humanTimeout(1000)) && okv(humanTimeout(1_800_000)) && okv(humanTimeout(300000)));
check("(2) human validator REJECTS the timeout out of bounds", !okv(humanTimeout(999)) && !okv(humanTimeout(1_800_001)));
const agentSet = validateAgentProjectConfigOverride({ orchestration: { ungatedLandingCheckCommand: "pnpm guards" } });
check("(2) AGENT project-config shape REJECTS orchestration.ungatedLandingCheckCommand", !okv(agentSet) && /ungatedLandingCheckCommand/.test(agentSet.error ?? ""));
const agentSetTimeout = validateAgentProjectConfigOverride({ orchestration: { ungatedLandingCheckTimeoutMs: 300000 } });
check("(2) AGENT project-config shape REJECTS orchestration.ungatedLandingCheckTimeoutMs", !okv(agentSetTimeout) && /ungatedLandingCheckTimeoutMs/.test(agentSetTimeout.error ?? ""));
check("(2) CONTROL: the AGENT shape still accepts a normal nested orchestration key", okv(validateAgentProjectConfigOverride({ orchestration: { maxConcurrentWorkers: 2 } })));
check("(2) UNLIKE mergeGate/mergeGateInterval, ungatedLandingCheckCommand is NOT on the nested human-only list — it does not change cadence/counter semantics", !HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS.includes("orchestration.ungatedLandingCheckCommand") && HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS.includes("orchestration.mergeGate"));

// ============ (3) routers — the trust-tier distinction from mergeGate/mergeGateInterval ============
const now = new Date().toISOString();
const db = new Db();
const svc = new SessionService(db, { stop() {}, isAlive() { return false; }, enqueueStdin() {} }, new OrchestrationControl());
db.insertProject({ id: "pU", name: "U", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
async function callTool(server, name, args) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "ungated-landing-check-config-test", version: "0" });
  await client.connect(clientT);
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
const lead = () => new PlatformMcpRouter(db, svc).buildServer();
const leadRes = await callTool(lead(), "project_configure", { projectId: "pU", config: { orchestration: { ungatedLandingCheckCommand: "pnpm guards" } } });
check("(3) elevated Platform-Lead project_configure ACCEPTS ungatedLandingCheckCommand — same trust tier as gateCommand, NOT mergeGate/mergeGateInterval", !leadRes.error);
check("(3) the Lead's write actually stored it", db.getProject("pU").config?.orchestration?.ungatedLandingCheckCommand === "pnpm guards");
// Card bd9a483b ruling 4 (CR round 2): NON_CLEARABLE_NESTED_PROJECT_CONFIG_KEYS now also names this field —
// the Lead may CHANGE it but never BLANK/DROP it, mirroring gateCommand's own fa777608 behavior exactly
// (see platform-gatecommand-non-clearable.mjs for the exhaustive gateCommand-only coverage of this shape).
const unsetRes = await callTool(lead(), "project_configure", { projectId: "pU", config: {}, unset: ["orchestration.ungatedLandingCheckCommand"] });
check("(3) NON-CLEARABLE: the Lead's unset of orchestration.ungatedLandingCheckCommand is REFUSED", typeof unsetRes.error === "string" && /ungatedLandingCheckCommand/.test(unsetRes.error) && db.getProject("pU").config?.orchestration?.ungatedLandingCheckCommand === "pnpm guards");
const changeRes = await callTool(lead(), "project_configure", { projectId: "pU", config: { orchestration: { ungatedLandingCheckCommand: "pnpm guards-2" } } });
check("(3) CONTROL: the Lead MAY still CHANGE it to another non-empty command (not frozen, just non-clearable)", !changeRes.error && db.getProject("pU").config?.orchestration?.ungatedLandingCheckCommand === "pnpm guards-2");
const setupRes = await callTool(new SetupMcpRouter(db, svc).buildServer("SETUP"), "project_configure", { projectId: "pU", config: { orchestration: { ungatedLandingCheckCommand: "pnpm guards" } } });
check("(3) setup-surface (agent-shape) project_configure REJECTS orchestration.ungatedLandingCheckCommand", typeof setupRes.error === "string" && /ungatedLandingCheckCommand/.test(setupRes.error));

console.log(failures === 0
  ? "\n✅ ALL PASS — orchestration.ungatedLandingCheckCommand/ungatedLandingCheckTimeoutMs resolve/validate exactly like gateCommand/gateCommandTimeoutMs, the agent-facing shape rejects both, and — the one deliberately different trust-tier call from mergeGateInterval — the elevated Platform Lead MAY set the check command."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
