import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 3e92e23b (child of d9332365) — commitTrailers/commitLogBody CONFIG + TRUST-BOUNDARY half, mirroring
// merge-gate-interval-config.mjs's (1)/(2)/(3) sections for this card's narrower, config-plumbing-only scope
// (no merge-path behaviour — see sibling cards 9a5d040c/5933734e for that). Deterministic, no claude/network:
// a real Db + SessionService over a stub pty, the real Platform/Setup routers (in-process MCP).
//
//   (1) resolveConfig: both keys default "on" when unset, resolve independently, and an override survives
//       verbatim; resolveRepo/ResolvedRepo (projects/resolve-repo.ts) surfaces the SAME project-level
//       resolved value for the primary repo AND a registered repo entry — neither key has a per-entry
//       override (see ResolvedRepo's own doc: no per-repo toolchain-divergence reasoning applies here).
//   (2) validators: the AGENT shape REJECTS both keys (same trust class as mergeGate/mergeGateInterval).
//   (3) the ELEVATED Platform-Lead project_configure and the setup router REJECT both, and the Lead may not
//       CLEAR a stored value (unset / prefix-unset / replace:true) — stored config unchanged. CONTROL: a
//       sibling nested key is still accepted/clearable, and both values survive that sibling write.
//
// Run: 1) build (turbo builds shared first), 2) node test/commit-trailers-config.mjs
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("cmtr-cfg-"); // temp SHORT LOOM_HOME, set BEFORE the dist import below

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { resolveConfig, PLATFORM_DEFAULTS } = await import("@loom/shared");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { resolveRepo } = await import("../dist/projects/resolve-repo.js");
const { PlatformMcpRouter, validateProjectConfigOverride, validateAgentProjectConfigOverride, HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// ============ (1) resolveConfig + resolveRepo/ResolvedRepo ============
check("(1) PLATFORM_DEFAULTS.orchestration.commitTrailers is \"on\"", PLATFORM_DEFAULTS.orchestration.commitTrailers === "on");
check("(1) PLATFORM_DEFAULTS.orchestration.commitLogBody is \"on\"", PLATFORM_DEFAULTS.orchestration.commitLogBody === "on");
check("(1) resolveConfig({}) defaults both to \"on\"", resolveConfig({}).orchestration.commitTrailers === "on" && resolveConfig({}).orchestration.commitLogBody === "on");
check("(1) resolveConfig({}) leaves a pre-existing sibling field untouched (no regression)", resolveConfig({}).orchestration.mergeGate === "on" && resolveConfig({}).orchestration.gateCommand === "");
const bothOff = resolveConfig({ orchestration: { commitTrailers: "off", commitLogBody: "off" } }).orchestration;
check("(1) an override on BOTH keys resolves verbatim", bothOff.commitTrailers === "off" && bothOff.commitLogBody === "off");
const onlyTrailersOff = resolveConfig({ orchestration: { commitTrailers: "off" } }).orchestration;
check("(1) the two keys resolve INDEPENDENTLY — overriding one leaves the other at its default", onlyTrailersOff.commitTrailers === "off" && onlyTrailersOff.commitLogBody === "on");

const baseProject = {
  id: "p1", name: "Demo", repoPath: "/host/primary-repo", vaultPath: "/host/vault",
  config: { orchestration: { commitTrailers: "off", commitLogBody: "off" } },
  createdAt: "2026-01-01T00:00:00.000Z", archivedAt: null, reserved: false,
  referenceRepos: [], noGateByDesign: false, denyGlobs: ["mockups/**"],
  repos: [{ key: "svc-a", path: "/host/svc-a-repo" }],
};
const primary = resolveRepo(baseProject);
check("(1) primary ResolvedRepo carries the project-level resolved commitTrailers", primary.commitTrailers === "off");
check("(1) primary ResolvedRepo carries the project-level resolved commitLogBody", primary.commitLogBody === "off");
const repoEntry = resolveRepo(baseProject, { repoKey: "svc-a" });
check("(1) a registry entry has NO per-entry override — it carries the SAME project-level resolved value as primary",
  repoEntry.commitTrailers === "off" && repoEntry.commitLogBody === "off");
const defaultProject = { ...baseProject, config: {} };
check("(1) with the project config unset, BOTH primary and a registry entry resolve to the default \"on\"",
  resolveRepo(defaultProject).commitTrailers === "on" && resolveRepo(defaultProject).commitLogBody === "on" &&
  resolveRepo(defaultProject, { repoKey: "svc-a" }).commitTrailers === "on" && resolveRepo(defaultProject, { repoKey: "svc-a" }).commitLogBody === "on");

// ============ (2) validators ============
const okv = (r) => r.ok === true;
const human = (v) => validateProjectConfigOverride({ orchestration: { commitTrailers: v } });
check("(2) human validator ACCEPTS \"on\" and \"off\"", okv(human("on")) && okv(human("off")));
check("(2) human validator REJECTS an invalid value (\"maybe\", 1, null)", !okv(human("maybe")) && !okv(human(1)) && !okv(human(null)));
const agentTrailers = validateAgentProjectConfigOverride({ orchestration: { commitTrailers: "off" } });
check("(2) AGENT project-config shape REJECTS orchestration.commitTrailers", !okv(agentTrailers) && /commitTrailers/.test(agentTrailers.error ?? ""));
const agentBody = validateAgentProjectConfigOverride({ orchestration: { commitLogBody: "off" } });
check("(2) AGENT project-config shape REJECTS orchestration.commitLogBody", !okv(agentBody) && /commitLogBody/.test(agentBody.error ?? ""));
check("(2) CONTROL: the AGENT shape still accepts a normal nested orchestration key", okv(validateAgentProjectConfigOverride({ orchestration: { maxConcurrentWorkers: 2 } })));
check("(2) the nested human-only list names BOTH orchestration.commitTrailers and orchestration.commitLogBody",
  HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS.includes("orchestration.commitTrailers") && HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS.includes("orchestration.commitLogBody"));

// ============ (3) routers ============
const now = new Date().toISOString();
const db = new Db();
const svc = new SessionService(db, { stop() {}, isAlive() { return false; }, enqueueStdin() {} }, new OrchestrationControl());
db.insertProject({ id: "pI", name: "I", repoPath: process.env.LOOM_HOME, vaultPath: process.env.LOOM_HOME, config: {}, createdAt: now, archivedAt: null });
async function callTool(server, name, args) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "commit-trailers-config-test", version: "0" });
  await client.connect(clientT);
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
const lead = () => new PlatformMcpRouter(db, svc).buildServer();
const before = JSON.stringify(db.getProject("pI").config);
const leadRes1 = await callTool(lead(), "project_configure", { projectId: "pI", config: { orchestration: { commitTrailers: "off" } } });
check("(3) elevated Platform-Lead project_configure REJECTS nested orchestration.commitTrailers", typeof leadRes1.error === "string" && /commitTrailers/.test(leadRes1.error));
const leadRes2 = await callTool(lead(), "project_configure", { projectId: "pI", config: { orchestration: { commitLogBody: "off" } } });
check("(3) elevated Platform-Lead project_configure REJECTS nested orchestration.commitLogBody", typeof leadRes2.error === "string" && /commitLogBody/.test(leadRes2.error));
const setupRes = await callTool(new SetupMcpRouter(db, svc).buildServer("SETUP"), "project_configure", { projectId: "pI", config: { orchestration: { commitTrailers: "off" } } });
check("(3) setup-surface project_configure REJECTS orchestration.commitTrailers", typeof setupRes.error === "string" && /commitTrailers/.test(setupRes.error));
check("(3) none of the rejected writes changed the stored config", JSON.stringify(db.getProject("pI").config) === before);
db.setProjectConfig("pI", { orchestration: { commitTrailers: "off", commitLogBody: "off", maxConcurrentWorkers: 2 } });
const stored = JSON.stringify(db.getProject("pI").config);
const u1 = await callTool(lead(), "project_configure", { projectId: "pI", config: {}, unset: ["orchestration.commitTrailers"] });
check("(3) Lead unset of orchestration.commitTrailers is REFUSED", typeof u1.error === "string" && /commitTrailers/.test(u1.error));
const u2 = await callTool(lead(), "project_configure", { projectId: "pI", config: {}, unset: ["orchestration.commitLogBody"] });
check("(3) Lead unset of orchestration.commitLogBody is REFUSED", typeof u2.error === "string" && /commitLogBody/.test(u2.error));
const u3 = await callTool(lead(), "project_configure", { projectId: "pI", config: {}, unset: ["orchestration"] });
check("(3) Lead unset of the PREFIX \"orchestration\" is REFUSED", typeof u3.error === "string");
const u4 = await callTool(lead(), "project_configure", { projectId: "pI", config: { docLint: false }, replace: true });
check("(3) Lead replace:true that would drop the stored commitTrailers/commitLogBody is REFUSED", typeof u4.error === "string");
check("(3) none of the refused writes changed the stored config", JSON.stringify(db.getProject("pI").config) === stored);
const u5 = await callTool(lead(), "project_configure", { projectId: "pI", config: {}, unset: ["orchestration.maxConcurrentWorkers"] });
check("(3) CONTROL: unsetting a SIBLING nested key works and both values survive",
  !u5.error && db.getProject("pI").config?.orchestration?.commitTrailers === "off" && db.getProject("pI").config?.orchestration?.commitLogBody === "off");
db.setProjectConfig("pI", {});
db.close();

console.log(failures === 0
  ? "\n✅ ALL PASS — commitTrailers/commitLogBody default \"on\", resolve independently, resolve identically for the primary repo and a registered repo entry (no per-entry override), and are human-only on every agent path (agent validator, setup router, elevated Lead incl. clearing)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
