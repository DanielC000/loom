import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 432765ab — `orchestration.attachmentMaxBytes`/`attachmentMaxCount` are HUMAN-only, SAME trust tier
// as `orchestration.maxNoticesPerHour` (the party these caps govern — the asker — must never be able to
// raise its own ceiling). Mirrors notice-request-kind.mjs's (F)/(G) sections exactly, scoped to these two
// new keys:
//   (A) the AGENT-facing project-config validator REJECTS both keys outright.
//   (B) CONTROL: the AGENT shape still accepts a normal nested orchestration key.
//   (C) both dot-paths are listed in HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS.
//   (D) CONTROL: the human (full) validator still ACCEPTS both — a trust-tier restriction, not a bug.
//   (E) the ELEVATED Platform Lead's project_configure ALSO rejects both, leaving the stored config
//       unchanged — even the Lead cannot raise its own fleet's cap.
//   (F) resolveConfig resolves the platform defaults (25MB / 10) and honors an explicit per-project
//       override (settable only via the human/REST path, never exercised here as a write — this reads a
//       directly-stored config to prove the merge itself, independent of who may write it).
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/attachment-caps-config.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-attach-caps-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const {
  PlatformMcpRouter, validateAgentProjectConfigOverride, validateProjectConfigOverride,
  HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS,
} = await import("../dist/mcp/platform.js");
const { resolveConfig } = await import("@loom/shared");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const dbFile = path.join(tmpHome, "caps.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

try {
  // ===== (A)/(B) the AGENT config validator =====
  {
    const okv = (r) => r.ok === true;
    const bytesSet = validateAgentProjectConfigOverride({ orchestration: { attachmentMaxBytes: 1024 } });
    check("(A1) AGENT shape REJECTS orchestration.attachmentMaxBytes", !okv(bytesSet) && /attachmentMaxBytes/.test(bytesSet.error ?? ""));
    const countSet = validateAgentProjectConfigOverride({ orchestration: { attachmentMaxCount: 1 } });
    check("(A2) AGENT shape REJECTS orchestration.attachmentMaxCount", !okv(countSet) && /attachmentMaxCount/.test(countSet.error ?? ""));
    check("(B) CONTROL: the AGENT shape still accepts a normal nested orchestration key", okv(validateAgentProjectConfigOverride({ orchestration: { maxConcurrentWorkers: 2 } })));
  }

  // ===== (C) the nested human-only list names both keys =====
  {
    check("(C1) HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS names orchestration.attachmentMaxBytes", HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS.includes("orchestration.attachmentMaxBytes"));
    check("(C2) HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS names orchestration.attachmentMaxCount", HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS.includes("orchestration.attachmentMaxCount"));
  }

  // ===== (D) CONTROL: the human (full) validator still accepts both =====
  {
    const okv = (r) => r.ok === true;
    check("(D1) CONTROL: the human (full) validator ACCEPTS attachmentMaxBytes", okv(validateProjectConfigOverride({ orchestration: { attachmentMaxBytes: 1024 } })));
    check("(D2) CONTROL: the human (full) validator ACCEPTS attachmentMaxCount", okv(validateProjectConfigOverride({ orchestration: { attachmentMaxCount: 1 } })));
  }

  // ===== (E) the ELEVATED Platform Lead's project_configure also rejects both =====
  {
    const reservedProjId = "caps-platform-home";
    db.insertProject({ id: reservedProjId, name: "Loom Platform", repoPath: reservedProjId, vaultPath: reservedProjId, config: {}, createdAt: now, archivedAt: null, reserved: true });
    const leadAgentId = "caps-lead-agent";
    db.insertAgent({ id: leadAgentId, projectId: reservedProjId, name: "Lead", startupPrompt: "BRIEF", position: 0 });
    const leadId = "caps-lead";
    db.insertSession({
      id: leadId, projectId: reservedProjId, agentId: leadAgentId, engineSessionId: "eng-caps-lead", title: null, cwd: reservedProjId,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "platform",
    });
    const before = JSON.stringify(db.getProject(reservedProjId).config);
    const leadConfigureServer = new PlatformMcpRouter(db, {}).buildServer(leadId);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([leadConfigureServer.connect(st), (async () => {})()]);
    const client = new Client({ name: "attachment-caps-config-lead-test", version: "0" });
    await client.connect(ct);
    const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
    const bytesRes = await call("project_configure", { projectId: reservedProjId, config: { orchestration: { attachmentMaxBytes: 1024 } } });
    check("(E1) elevated Platform-Lead project_configure REJECTS orchestration.attachmentMaxBytes", typeof bytesRes.error === "string" && /attachmentMaxBytes/.test(bytesRes.error));
    const countRes = await call("project_configure", { projectId: reservedProjId, config: { orchestration: { attachmentMaxCount: 1 } } });
    check("(E2) elevated Platform-Lead project_configure REJECTS orchestration.attachmentMaxCount", typeof countRes.error === "string" && /attachmentMaxCount/.test(countRes.error));
    check("(E3) the rejected configures left the stored config UNCHANGED", JSON.stringify(db.getProject(reservedProjId).config) === before);
    await client.close();
  }

  // ===== (F) resolveConfig: platform defaults + a stored per-project override =====
  {
    const defaults = resolveConfig(undefined);
    check("(F1) the platform default per-attachment cap is 25MB", defaults.orchestration.attachmentMaxBytes === 25 * 1024 * 1024);
    check("(F2) the platform default per-request count cap is 10", defaults.orchestration.attachmentMaxCount === 10);
    const overridden = resolveConfig({ orchestration: { attachmentMaxBytes: 1024, attachmentMaxCount: 2 } });
    check("(F3) an explicit project override wins over the platform default (bytes)", overridden.orchestration.attachmentMaxBytes === 1024);
    check("(F4) an explicit project override wins over the platform default (count)", overridden.orchestration.attachmentMaxCount === 2);
    const zeroCount = resolveConfig({ orchestration: { attachmentMaxCount: 0 } });
    check("(F5) an explicit 0 count ('no attachments allowed') survives the merge, never falls back to the default", zeroCount.orchestration.attachmentMaxCount === 0);
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — attachmentMaxBytes/attachmentMaxCount are rejected by the agent validator AND the elevated Platform Lead, accepted by the human validator, and resolveConfig merges the platform default/override correctly."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
