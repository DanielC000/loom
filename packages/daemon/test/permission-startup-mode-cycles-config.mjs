import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cc39bbf2 — `permission.startupModeCycles` was declared on the shared PermissionPolicy type but
// absent from `permissionOverride`'s `.strict()` validator shape, so a config PATCH that explicitly set
// it 400'd on every surface, human REST included. It is a LIVE knob (pty/host.ts's computeBootMode/
// resolveModeTarget fallback + the resume/auto-heal convergence target), version-sensitive to the real
// claude CLI's own Shift+Tab cycle order — so the fix makes it HUMAN-only (same trust class as
// gateCommand/harness), never agent-writable. Full narrative + Do-nots:
// docs/decisions/cc39bbf2-startup-mode-cycles-human-only.md.
//
//   (1) resolveConfig: default 2; a project override resolves through; HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS
//       names "permission.startupModeCycles".
//   (2) validators: the human project validator ACCEPTS a valid value and RESOLVES through resolveConfig;
//       out-of-range values (-1, 21, 1.5) are REJECTED by the human validator; the AGENT shape
//       (agentPermissionOverride) REJECTS the key outright, at any value.
//   (3) real wiring: the manager's project_update (SessionService.updateProjectStructural) REJECTS it;
//       the setup-surface project_configure AND project_update REJECT it.
//   (4) real wiring: the ELEVATED Platform-Lead project_configure (shares the FULL human validator) still
//       REJECTS setting it (via HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS), and also REJECTS clearing an
//       already-stored value via unset or a replace:true that would drop it — human-only means BOTH
//       directions (card e8df2659/74f27ab5's existing guard, extended to this key).
//   CONTROLS: the same routers still accept a normal permission field (allow) and a normal top-level key
//   (docLint); a stored value survives an unrelated patch/unset.
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE: a real Db + SessionService/routers over a stub pty, no real
// claude, no daemon.
// Run: 1) build (turbo builds shared first), 2) node test/permission-startup-mode-cycles-config.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-smc-cfg-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { resolveConfig, PLATFORM_DEFAULTS } = await import("@loom/shared");
const {
  PlatformMcpRouter, validateProjectConfigOverride, validateAgentProjectConfigOverride,
  HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS,
} = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// ============ (1) resolution ============
check("(1) PLATFORM_DEFAULTS.permission.startupModeCycles is 2", PLATFORM_DEFAULTS.permission.startupModeCycles === 2);
check("(1) resolveConfig(undefined) ⇒ 2", resolveConfig(undefined).permission.startupModeCycles === 2);
check("(1) resolveConfig({}) ⇒ 2", resolveConfig({}).permission.startupModeCycles === 2);
check("(1) a project override 0 resolves to 0", resolveConfig({ permission: { startupModeCycles: 0 } }).permission.startupModeCycles === 0);
check("(1) a project override 3 resolves to 3", resolveConfig({ permission: { startupModeCycles: 3 } }).permission.startupModeCycles === 3);
check("(1) the nested human-only list names permission.startupModeCycles", HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS.includes("permission.startupModeCycles"));

// ============ (2) validators ============
const ok = (r) => r.ok === true;
const humanSet = validateProjectConfigOverride({ permission: { startupModeCycles: 3 } });
check("(2) human project validator ACCEPTS a valid startupModeCycles", ok(humanSet) && humanSet.value.permission?.startupModeCycles === 3);
check("(2) CONTROL: resolveConfig resolves the accepted value through", resolveConfig(humanSet.value).permission.startupModeCycles === 3);
for (const bad of [-1, 21, 1.5]) {
  const r = validateProjectConfigOverride({ permission: { startupModeCycles: bad } });
  check(`(2) human project validator REJECTS out-of-range startupModeCycles ${bad}`, !ok(r));
}
// boundary values (0 and 20) are accepted, not off-by-one rejected.
check("(2) human validator ACCEPTS the exact boundary values (0 and 20)",
  ok(validateProjectConfigOverride({ permission: { startupModeCycles: 0 } })) &&
  ok(validateProjectConfigOverride({ permission: { startupModeCycles: 20 } })));
const agentSet = validateAgentProjectConfigOverride({ permission: { startupModeCycles: 2 } });
check("(2) AGENT project-config shape REJECTS permission.startupModeCycles (even a valid value)", !ok(agentSet) && /startupModeCycles/.test(agentSet.error ?? ""));
check("(2) CONTROL: the AGENT shape still accepts a normal permission field (allow)", ok(validateAgentProjectConfigOverride({ permission: { allow: ["Bash(git status:*)"] } })));
check("(2) CONTROL: an override without permission at all still parses on both validators",
  ok(validateProjectConfigOverride({ docLint: false })) && ok(validateAgentProjectConfigOverride({ docLint: false })));

// ============ (3) manager + setup wiring ============
{
  const now = new Date().toISOString();
  const db = new Db();
  db.insertProject({ id: "pSMC", name: "SMC", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "aSMC", projectId: "pSMC", name: "Mgr", startupPrompt: "do it", position: 0, profileId: null });
  db.insertSession({
    id: "MSMC", projectId: "pSMC", agentId: "aSMC", engineSessionId: null, title: null, cwd: tmpHome,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", parentSessionId: null,
  });
  const pty = { enqueueStdin: () => ({ delivered: false }) };
  const svc = new SessionService(db, pty, new OrchestrationControl());

  let threw = null;
  try {
    await svc.updateProjectStructural("MSMC", "pSMC", { config: { permission: { startupModeCycles: 1 } } });
  } catch (e) { threw = e; }
  check("(3) project_update (manager): a permission.startupModeCycles patch is REJECTED end-to-end", threw !== null);
  check("(3) project_update (manager): the rejection names startupModeCycles", threw !== null && /startupModeCycles/.test(String(threw.message ?? threw)));
  check("(3) project_update (manager): the stored config is UNCHANGED after the rejected attempt", db.getProject("pSMC").config.permission?.startupModeCycles === undefined);

  // CONTROL: the manager can still patch a normal permission field.
  await svc.updateProjectStructural("MSMC", "pSMC", { config: { permission: { allow: ["Bash(ls:*)"] } } });
  check("(3) CONTROL: project_update (manager) still accepts permission.allow", db.getProject("pSMC").config.permission?.allow?.includes("Bash(ls:*)"));

  // setup-surface: project_configure + project_update.
  const router = new SetupMcpRouter(db, svc);
  const server = router.buildServer("SETUP");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "permission-startup-mode-cycles-config-setup-test", version: "0" });
  await client.connect(clientT);
  const parse = (res) => JSON.parse(res.content[0].text);
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

  const cfgRes = await call("project_configure", { projectId: "pSMC", config: { permission: { startupModeCycles: 1 } } });
  check("(3) setup project_configure: REJECTS permission.startupModeCycles", typeof cfgRes.error === "string" && /startupModeCycles/.test(cfgRes.error));
  check("(3) setup project_configure: stored config is UNCHANGED after the rejected attempt", db.getProject("pSMC").config.permission?.startupModeCycles === undefined);
  const updRes = await call("project_update", { projectId: "pSMC", config: { permission: { startupModeCycles: 1 } } });
  check("(3) setup project_update: REJECTS permission.startupModeCycles", typeof updRes.error === "string" && /startupModeCycles/.test(updRes.error));

  db.close();
}

// ============ (4) elevated Platform-Lead: rejects SET and rejects CLEAR ============
{
  const now = new Date().toISOString();
  const db = new Db();
  db.insertProject({ id: "pLeadSMC", name: "LeadSMC", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  const pty = { enqueueStdin: () => ({ delivered: false }) };
  const svc = new SessionService(db, pty, new OrchestrationControl());
  const lead = () => new PlatformMcpRouter(db, svc).buildServer();

  async function callTool(server, name, args) {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "permission-startup-mode-cycles-config-lead-test", version: "0" });
    await client.connect(clientT);
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  // CONTROL: the elevated route genuinely has the full human validator in play — accepts gateCommand.
  const cfgOrdinary = await callTool(lead(), "project_configure", { projectId: "pLeadSMC", config: { orchestration: { gateCommand: "echo ok" } } });
  check("(4) platform project_configure CONTROL: accepts gateCommand (full validator genuinely in play)", !cfgOrdinary.error);

  // SET: rejected even though validateProjectConfigOverride alone would accept it.
  const setRes = await callTool(lead(), "project_configure", { projectId: "pLeadSMC", config: { permission: { startupModeCycles: 1 } } });
  check("(4) platform project_configure (Lead-elevated): REJECTS setting permission.startupModeCycles", typeof setRes.error === "string" && /startupModeCycles/.test(setRes.error));
  check("(4) platform project_configure (Lead-elevated): stored config is UNCHANGED after the rejected set", db.getProject("pLeadSMC").config.permission?.startupModeCycles === undefined);

  // CONTROL: a normal nested permission field still works on the elevated route.
  const leadAllow = await callTool(lead(), "project_configure", { projectId: "pLeadSMC", config: { permission: { allow: ["Bash(ls:*)"] } } });
  check("(4) CONTROL: the Lead's project_configure still accepts permission.allow", !leadAllow.error && db.getProject("pLeadSMC").config.permission?.allow?.includes("Bash(ls:*)"));

  // Seed a stored value the normal write path would never allow (mirrors the harness-unset-guard pattern).
  db.setProjectConfig("pLeadSMC", { permission: { startupModeCycles: 3, allow: ["Bash(ls:*)"] }, docLint: false });
  const stored4 = JSON.stringify(db.getProject("pLeadSMC").config);

  const unsetExact = await callTool(lead(), "project_configure", { projectId: "pLeadSMC", config: {}, unset: ["permission.startupModeCycles"] });
  check("(4) Lead unset of permission.startupModeCycles is REFUSED", typeof unsetExact.error === "string" && /startupModeCycles/.test(unsetExact.error));
  check("(4) the refused unset did not change the stored config", JSON.stringify(db.getProject("pLeadSMC").config) === stored4);

  const unsetPrefix = await callTool(lead(), "project_configure", { projectId: "pLeadSMC", config: {}, unset: ["permission"] });
  check("(4) Lead unset of the PREFIX \"permission\" (which would drop the stored key) is REFUSED", typeof unsetPrefix.error === "string" && /startupModeCycles/.test(unsetPrefix.error));

  const replaceDrop = await callTool(lead(), "project_configure", { projectId: "pLeadSMC", config: { docLint: false }, replace: true });
  check("(4) Lead replace:true that would drop the stored key is REFUSED", typeof replaceDrop.error === "string" && /startupModeCycles/.test(replaceDrop.error));
  check("(4) none of the refused writes changed the stored config", JSON.stringify(db.getProject("pLeadSMC").config) === stored4);

  const unsetOther = await callTool(lead(), "project_configure", { projectId: "pLeadSMC", config: {}, unset: ["docLint"] });
  check("(4) CONTROL: unsetting an unrelated key still works and stored startupModeCycles survives",
    !unsetOther.error && db.getProject("pLeadSMC").config?.permission?.startupModeCycles === 3 && db.getProject("pLeadSMC").config?.docLint === undefined);
  const unsetSiblingNested = await callTool(lead(), "project_configure", { projectId: "pLeadSMC", config: {}, unset: ["permission.allow"] });
  check("(4) CONTROL: unsetting a SIBLING nested field (permission.allow) works and startupModeCycles survives",
    !unsetSiblingNested.error && db.getProject("pLeadSMC").config?.permission?.startupModeCycles === 3);

  db.setProjectConfig("pLeadSMC", { docLint: false });
  const replaceFree = await callTool(lead(), "project_configure", { projectId: "pLeadSMC", config: { docLint: true }, replace: true });
  check("(4) CONTROL: replace:true is still allowed when NO human-only startupModeCycles is stored", !replaceFree.error);

  db.close();
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — permission.startupModeCycles defaults 2, resolves per project, is bounded [0,20] on the "
    + "human validator, and every agent path (agent validator, manager project_update, setup "
    + "project_configure/project_update) rejects it while the human validator accepts it — including the "
    + "ELEVATED Platform-Lead project_configure, which rejects both SETTING and CLEARING (unset/replace-drop) "
    + "it despite otherwise sharing the full human validator."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
