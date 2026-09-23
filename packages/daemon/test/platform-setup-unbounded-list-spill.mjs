import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 91fef05a — spill-protect the remaining unbounded list/read tools found in the audit that split off
// `26134f1a`: list_all_projects (BOTH platform.ts and setup.ts), list_all_profiles (platform.ts),
// list_all_schedules (platform.ts), and agent_update (BOTH platform.ts and setup.ts) — all
// `db.list*().map(...)` or single-agent-with-startupPrompt reads with no cap or spill, structurally
// unbounded even though a real corpus is usually small. Fixed via the SAME shared
// spillRowsIfLarge/spillableAgentGet primitives every sibling list/single-record tool already uses.
// HERMETIC, CLAUDE-FREE, NETWORK-FREE: a bare Db + the real PlatformMcpRouter/SetupMcpRouter driven over
// in-process MCP InMemoryTransport (mirrors mcp-memory-skill-spill.mjs's light harness — no PtyHost/
// SessionService needed, since every tool under test is a pure DB read/patch).
//
// Covers, per tool, on EVERY router that registers it:
//   list_all_projects (platform.ts, setup.ts)   — below-cap bare array; oversized spills to
//                                                  {projectsFile,projectsChars,rowCount,note}.
//   list_all_profiles (platform.ts)             — same shape, {profilesFile,...}.
//   list_all_schedules (platform.ts)            — same shape, {schedulesFile,...}, both with and without
//                                                  an explicit projectId filter (two independent spillKeys).
//   agent_update (platform.ts, setup.ts)        — a PATCH that leaves/sets a large startupPrompt spills it
//                                                  the same way agent_get already does (spillableAgentGet):
//                                                  {..., startupPromptFile, startupPromptChars, note} in
//                                                  place of `startupPrompt`; a small-prompt PATCH stays
//                                                  byte-identical.
// Run: 1) build (turbo builds shared first), 2) node test/platform-setup-unbounded-list-spill.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-psuls-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { SPILL_INLINE_BUDGET_CHARS } = await import("../dist/spill.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "platform-setup-unbounded-list-spill-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

try {
  // ============ list_all_projects (platform.ts AND setup.ts) ============
  {
    const file = path.join(tmpHome, `${randomUUID()}.db`);
    const db = new Db(file);
    const now = new Date().toISOString();
    const bigName = "P".repeat(2000);
    const wantCount = Math.ceil(SPILL_INLINE_BUDGET_CHARS / 2000) + 5;
    for (let i = 0; i < wantCount; i++) {
      db.insertProject({ id: `proj-${i}`, name: `${bigName}-${i}`, repoPath: "/t", vaultPath: "/t", config: {}, createdAt: now, archivedAt: null });
    }

    for (const [label, Router, sessId] of [["platform", PlatformMcpRouter, "sPlatProj"], ["setup", SetupMcpRouter, "sSetupProj"]]) {
      const router = new Router(db, {});
      const client = await connect(router.buildServer(sessId));
      const result = await call(client, "list_all_projects", {});
      check(`(list_all_projects/${label}) oversized set IS spilled (not a bare array)`, !Array.isArray(result) && typeof result.projectsFile === "string");
      check(`(list_all_projects/${label}) the spill pointer carries projectsFile/projectsChars/rowCount/note`, typeof result.projectsChars === "number" && typeof result.rowCount === "number" && typeof result.note === "string");
      check(`(list_all_projects/${label}) the spill file lives under THIS session's own scratch dir`, result.projectsFile.includes(sessId));
      const lines = fs.readFileSync(result.projectsFile, "utf8").trim().split("\n");
      check(`(list_all_projects/${label}) the spill file is NDJSON with the expected row count`, lines.length === result.rowCount && result.rowCount === wantCount);
      await client.close();
    }

    // Below-cap: a fresh empty-ish DB stays a bare array on both routers.
    const smallFile = path.join(tmpHome, `${randomUUID()}.db`);
    const smallDb = new Db(smallFile);
    smallDb.insertProject({ id: "proj-small", name: "Small", repoPath: "/t", vaultPath: "/t", config: {}, createdAt: now, archivedAt: null });
    for (const [label, Router, sessId] of [["platform", PlatformMcpRouter, "sPlatProjSmall"], ["setup", SetupMcpRouter, "sSetupProjSmall"]]) {
      const router = new Router(smallDb, {});
      const client = await connect(router.buildServer(sessId));
      const result = await call(client, "list_all_projects", {});
      check(`(list_all_projects/${label}) below-cap set stays a bare array (byte-identical shape)`, Array.isArray(result));
      await client.close();
    }
    smallDb.close();
    db.close();
  }

  // ============ list_all_profiles (platform.ts) ============
  {
    const file = path.join(tmpHome, `${randomUUID()}.db`);
    const db = new Db(file);
    const bigDesc = "D".repeat(2000);
    const wantCount = Math.ceil(SPILL_INLINE_BUDGET_CHARS / 2000) + 5;
    for (let i = 0; i < wantCount; i++) {
      db.insertProfile({ id: `prof-${i}`, name: `Rig ${i}`, role: null, description: bigDesc, allowDelta: [], skills: null, model: null, icon: null });
    }
    const router = new PlatformMcpRouter(db, {});
    const client = await connect(router.buildServer("sPlatProf"));
    const result = await call(client, "list_all_profiles", {});
    check("(list_all_profiles) oversized set IS spilled (not a bare array)", !Array.isArray(result) && typeof result.profilesFile === "string");
    check("(list_all_profiles) the spill pointer carries profilesFile/profilesChars/rowCount/note", typeof result.profilesChars === "number" && typeof result.rowCount === "number" && typeof result.note === "string");
    check("(list_all_profiles) the spill file lives under THIS session's own scratch dir", result.profilesFile.includes("sPlatProf"));
    const lines = fs.readFileSync(result.profilesFile, "utf8").trim().split("\n");
    check("(list_all_profiles) the spill file is NDJSON with the expected row count", lines.length === result.rowCount && result.rowCount === wantCount);
    await client.close();

    // Below-cap on a fresh small DB.
    const smallDb = new Db(path.join(tmpHome, `${randomUUID()}.db`));
    smallDb.insertProfile({ id: "prof-small", name: "Small Rig", role: null, description: "tiny", allowDelta: [], skills: null, model: null, icon: null });
    const smallClient = await connect(new PlatformMcpRouter(smallDb, {}).buildServer("sPlatProfSmall"));
    const smallResult = await call(smallClient, "list_all_profiles", {});
    check("(list_all_profiles) below-cap set stays a bare array (byte-identical shape)", Array.isArray(smallResult));
    await smallClient.close();
    smallDb.close();
    db.close();
  }

  // ============ list_all_schedules (platform.ts) — with and without a projectId filter ============
  {
    const file = path.join(tmpHome, `${randomUUID()}.db`);
    const db = new Db(file);
    const now = new Date().toISOString();
    db.insertProject({ id: "pSched", name: "Sched Proj", repoPath: "/t", vaultPath: "/t", config: {}, createdAt: now, archivedAt: null });
    db.insertAgent({ id: "agentSched", projectId: "pSched", name: "sched-agent", startupPrompt: "go", position: 0 });
    const bigPrompt = "S".repeat(2000);
    const wantCount = Math.ceil(SPILL_INLINE_BUDGET_CHARS / 2000) + 5;
    for (let i = 0; i < wantCount; i++) {
      db.insertSchedule({
        id: `sched-${i}`, name: `Schedule ${i}`, agentId: "agentSched", cron: "0 9 * * *", enabled: true,
        nextFireAt: now, lastFiredAt: null, createdAt: now, kind: "manager", prompt: bigPrompt,
      });
    }
    const router = new PlatformMcpRouter(db, {});
    const client = await connect(router.buildServer("sPlatSched"));

    const unfiltered = await call(client, "list_all_schedules", {});
    check("(list_all_schedules) unfiltered oversized set IS spilled (not a bare array)", !Array.isArray(unfiltered) && typeof unfiltered.schedulesFile === "string");
    check("(list_all_schedules) the spill pointer carries schedulesFile/schedulesChars/rowCount/note", typeof unfiltered.schedulesChars === "number" && typeof unfiltered.rowCount === "number" && typeof unfiltered.note === "string");
    check("(list_all_schedules) the spill file lives under THIS session's own scratch dir", unfiltered.schedulesFile.includes("sPlatSched"));
    const unfilteredLines = fs.readFileSync(unfiltered.schedulesFile, "utf8").trim().split("\n");
    check("(list_all_schedules) the spill file is NDJSON with the expected row count", unfilteredLines.length === unfiltered.rowCount && unfiltered.rowCount === wantCount);

    // projectId-filtered call: independent spillKey (never collides with the unfiltered file above).
    const filtered = await call(client, "list_all_schedules", { projectId: "pSched" });
    check("(list_all_schedules) projectId-filtered oversized set IS ALSO spilled", !Array.isArray(filtered) && typeof filtered.schedulesFile === "string");
    check("(list_all_schedules) the filtered spill file is a DIFFERENT file from the unfiltered one (independent spillKey)", filtered.schedulesFile !== unfiltered.schedulesFile);
    const filteredLines = fs.readFileSync(filtered.schedulesFile, "utf8").trim().split("\n");
    check("(list_all_schedules) the filtered spill file carries the same row count (single-project fixture)", filteredLines.length === filtered.rowCount && filtered.rowCount === wantCount);
    await client.close();

    // Below-cap on a fresh small DB.
    const smallDb = new Db(path.join(tmpHome, `${randomUUID()}.db`));
    smallDb.insertProject({ id: "pSchedSmall", name: "Small Sched Proj", repoPath: "/t", vaultPath: "/t", config: {}, createdAt: now, archivedAt: null });
    smallDb.insertAgent({ id: "agentSchedSmall", projectId: "pSchedSmall", name: "sched-agent-small", startupPrompt: "go", position: 0 });
    smallDb.insertSchedule({ id: "sched-small", name: "Small", agentId: "agentSchedSmall", cron: "0 9 * * *", enabled: true, nextFireAt: now, lastFiredAt: null, createdAt: now, kind: "manager", prompt: "tiny" });
    const smallClient = await connect(new PlatformMcpRouter(smallDb, {}).buildServer("sPlatSchedSmall"));
    const smallResult = await call(smallClient, "list_all_schedules", {});
    check("(list_all_schedules) below-cap set stays a bare array (byte-identical shape)", Array.isArray(smallResult));
    await smallClient.close();
    smallDb.close();
    db.close();
  }

  // ============ agent_update (platform.ts AND setup.ts) — mirrors agent_get's spillableAgentGet ============
  {
    const file = path.join(tmpHome, `${randomUUID()}.db`);
    const db = new Db(file);
    const now = new Date().toISOString();
    const bigPrompt = "A".repeat(SPILL_INLINE_BUDGET_CHARS + 5000);

    for (const [label, Router, sessId] of [["platform", PlatformMcpRouter, "sPlatAgentUpd"], ["setup", SetupMcpRouter, "sSetupAgentUpd"]]) {
      db.insertProject({ id: `pAgentUpd-${label}`, name: `Agent Update ${label}`, repoPath: "/t", vaultPath: "/t", config: {}, createdAt: now, archivedAt: null });
      db.insertAgent({ id: `agentUpd-${label}`, projectId: `pAgentUpd-${label}`, name: "a", startupPrompt: "small", position: 0 });

      const router = new Router(db, {});
      const client = await connect(router.buildServer(sessId));
      const result = await call(client, "agent_update", { agentId: `agentUpd-${label}`, startupPrompt: bigPrompt });
      check(`(agent_update/${label}) a PATCH landing an oversized startupPrompt IS spilled`, result.startupPrompt === undefined && typeof result.startupPromptFile === "string");
      check(`(agent_update/${label}) the spill pointer carries startupPromptFile/startupPromptChars/note`, typeof result.startupPromptChars === "number" && typeof result.note === "string");
      check(`(agent_update/${label}) the spill file lives under THIS session's own scratch dir`, result.startupPromptFile.includes(sessId));
      const spilledContent = fs.readFileSync(result.startupPromptFile, "utf8");
      check(`(agent_update/${label}) the spill file's content is the real prompt text`, spilledContent === bigPrompt);
      // Every other field stays inline alongside the spill pointer.
      check(`(agent_update/${label}) other fields (id/name) stay inline alongside the spill pointer`, result.id === `agentUpd-${label}` && result.name === "a");

      // A small-prompt PATCH on the SAME agent stays byte-identical (no spill pointer).
      const smallResult = await call(client, "agent_update", { agentId: `agentUpd-${label}`, startupPrompt: "back to small" });
      check(`(agent_update/${label}) a small-prompt PATCH stays inline (byte-identical shape)`, smallResult.startupPrompt === "back to small" && smallResult.startupPromptFile === undefined);
      await client.close();
    }
    db.close();
  }
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — list_all_projects (platform+setup), list_all_profiles (platform), list_all_schedules (platform, filtered and unfiltered), and agent_update (platform+setup) all spill an oversized response to the caller's own scratch dir via the shared spillRowsIfLarge/spillableAgentGet primitives, and all stay byte-identical below the cap."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
