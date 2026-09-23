import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 26134f1a — two more MCP tools found unbounded during the audit that led to `decisions_list`'s own
// fix (companion-decisions-relay.mjs): `memory_list` (mcp/server.ts, the universal loom-tasks router —
// every role, including TRANSCRIPT_ROOT_DENY_ROLES members) and `skillListData` (mcp/skillTools.ts,
// shared verbatim by THREE routers: platform.ts, setup.ts, user-audit.ts's skill_list). Neither had spill
// protection: an unbounded response can exceed the engine's own native tool-result threshold, which
// spills into `~/.claude/projects/**/tool-results/**` — a tree denied to manager/platform/setup/
// assistant/auditor/workspace-auditor. Both now route through the shared spillTextIfLarge/spillRowsIfLarge
// primitive (same convention `tasks_list`/`decisions_list` already use).
//
// Covers:
//   (a) memory_list (TaskMcpRouter, mcp/server.ts): a below-cap pull stays byte-identical NDJSON; an
//       oversized pull (many notes, each already bounded by the per-note write cap, but no row-COUNT
//       bound) spills to the caller's own scratch dir as a {notesFile,notesChars,rowCount,note} pointer.
//   (b) skillListData (mcp/skillTools.ts): the SHARED pure function's own spill logic — below-cap stays
//       {skills:[...]}, above-cap (a GENUINE oversized store, not a near-empty stand-in — card 91fef05a,
//       reviewer finding 3) spills to a {skillsFile,skillsChars,rowCount,note} pointer. A caller with no
//       session id (sessionId omitted) falls back to the pre-spill inline shape rather than throwing —
//       verified on BOTH a small store and the same oversized one, so the fallback is never silently
//       covered only by the case where it can't be exercised anyway.
//   (c) skill_list wiring on ALL THREE routers that share skillListData — platform.ts, setup.ts, AND
//       user-audit.ts (card 91fef05a, reviewer finding 3: the original version of this test only wired
//       the platform router, and — critically — never forced the spill branch on any of them, so it could
//       pass unchanged even if a router's wiring silently dropped its own callerSessionId). Each call here
//       reuses the SAME oversized store (b) above already wrote and asserts the ACTUAL spilled shape came
//       back, keyed to THAT router's own caller session id.
// Run: 1) build (turbo builds shared first), 2) node test/mcp-memory-skill-spill.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-mcp-memory-skill-spill-${Date.now()}-${process.pid}`);
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
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { skillListData } = await import("../dist/mcp/skillTools.js");
const { writeSkill } = await import("../dist/skills/store.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { WorkspaceAuditMcpRouter } = await import("../dist/mcp/user-audit.js");
const { SPILL_INLINE_BUDGET_CHARS } = await import("../dist/spill.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "mcp-memory-skill-spill-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

try {
  // ============ (a) memory_list: below-cap stays inline, oversized spills ============
  {
    const file = path.join(tmpHome, `${randomUUID()}.db`);
    const db = new Db(file);
    const now = new Date().toISOString();
    db.insertProject({ id: "pMem", name: "Memory Spill Proj", repoPath: "/t", vaultPath: "/t", config: {}, createdAt: now, archivedAt: null });
    const server = new TaskMcpRouter(db, { emit: () => {} }).buildServer("pMem", "sMem");
    const client = await connect(server);

    // Below cap: a couple of small notes. Raw (not JSON.parse'd via `call`) since a multi-row NDJSON
    // response isn't valid JSON as a whole — only the spilled-pointer shape is.
    await call(client, "memory_write", { key: "small-1", text: "a small note" });
    await call(client, "memory_write", { key: "small-2", text: "another small note" });
    const smallRaw = (await client.callTool({ name: "memory_list", arguments: {} })).content[0].text;
    check("(a) below-cap memory_list is bare NDJSON text (no spill pointer)", smallRaw.split("\n").length === 2 && !smallRaw.includes("notesFile"));

    // Above cap: enough notes to exceed SPILL_INLINE_BUDGET_CHARS even at moderate per-note size.
    const bigText = "y".repeat(2000);
    const wantCount = Math.ceil(SPILL_INLINE_BUDGET_CHARS / 2000) + 5;
    for (let i = 0; i < wantCount; i++) {
      await call(client, "memory_write", { key: `big-${i}`, text: bigText });
    }
    const big = await call(client, "memory_list", {});
    check("(a) an oversized memory_list is NOT a bare string (spilled)", typeof big === "object" && big !== null);
    check("(a) the spill pointer carries notesFile/notesChars/rowCount/note", typeof big.notesFile === "string" && typeof big.notesChars === "number" && typeof big.rowCount === "number" && typeof big.note === "string");
    check("(a) the spill file lives under THIS session's own scratch dir (never the shared/denied transcript tree)", big.notesFile.includes("sMem") && !big.notesFile.includes(".claude"));
    const spilledLines = fs.readFileSync(big.notesFile, "utf8").trim().split("\n");
    check("(a) the spill file is NDJSON with the expected row count", spilledLines.length === big.rowCount);
    check("(a) the spill file's rows carry real keys", spilledLines.some((l) => JSON.parse(l).key === "big-0"));

    await client.close();
    db.close();
  }

  // ============ (b) skillListData: pure-function spill, the no-sessionId fallback, AND the genuine
  // oversized-store branch (card 91fef05a, reviewer finding 3 — the ORIGINAL (b) here only ever exercised
  // a near-empty test store, so it never actually drove skillListData's own spill branch; the false
  // comment on (c) below, claiming (b) "already covers [the spill threshold] directly", is fixed by
  // actually covering it here). ============
  {
    // A small store (well under the cap): stays inline regardless of sessionId.
    const inlineNoSession = skillListData();
    check("(b) skillListData() with no sessionId returns the bare {skills} shape", Array.isArray(inlineNoSession.skills) && inlineNoSession.skillsFile === undefined);
    const inlineWithSession = skillListData("some-session-id-that-should-not-be-touched");
    check("(b) skillListData(sessionId) on a small store also stays inline (byte-identical shape)", Array.isArray(inlineWithSession.skills) && inlineWithSession.skillsFile === undefined);

    // Genuinely oversized store: write enough USER skills (each with sizeable content, mirroring the
    // memory_list oversized case above) that the NDJSON-joined skill list exceeds SPILL_INLINE_BUDGET_CHARS.
    const bigSkillText = "z".repeat(2000);
    const wantSkillCount = Math.ceil(SPILL_INLINE_BUDGET_CHARS / 2000) + 5;
    for (let i = 0; i < wantSkillCount; i++) {
      const ok = writeSkill(`big-skill-${i}`, `---\nname: big-skill-${i}\ndescription: a big test skill\n---\n${bigSkillText}`);
      check(`(b) fixture sanity: writeSkill("big-skill-${i}") succeeded`, ok === true);
    }
    const oversizedSessionId = "skill-spill-session";
    const spilled = skillListData(oversizedSessionId);
    check("(b) an oversized skillListData IS spilled (not the bare {skills} shape)", typeof spilled.skillsFile === "string" && spilled.skills === undefined);
    check("(b) the spill pointer carries skillsFile/skillsChars/rowCount/note", typeof spilled.skillsChars === "number" && typeof spilled.rowCount === "number" && typeof spilled.note === "string");
    check("(b) the spill file lives under the CALLING session's own scratch dir", spilled.skillsFile.includes(oversizedSessionId));
    const spilledSkillLines = fs.readFileSync(spilled.skillsFile, "utf8").trim().split("\n");
    check("(b) the spill file is NDJSON with the expected row count", spilledSkillLines.length === spilled.rowCount);
    check("(b) the spill file's rows carry real skill names", spilledSkillLines.some((l) => JSON.parse(l).name === "big-skill-0"));
    // No-sessionId fallback on the SAME now-oversized store: still the bare, unbounded {skills} shape —
    // never throws, byte-identical to the small-store fallback case above.
    const oversizedNoSession = skillListData();
    check("(b) skillListData() with no sessionId on an OVERSIZED store still falls back to the bare {skills} shape (never throws)",
      Array.isArray(oversizedNoSession.skills) && oversizedNoSession.skills.length === wantSkillCount && oversizedNoSession.skillsFile === undefined);
  }

  // ============ (c) skill_list wiring — card 91fef05a, reviewer finding 3: proves the wiring on ALL
  // THREE routers that share skillListData (platform.ts, setup.ts, user-audit.ts), and — unlike the
  // original version of this test — actually forces the SPILL branch on each, not just a small-store
  // passthrough. Reuses the oversized skill store (b) above already wrote (skillListData reads the same
  // global on-disk skill store regardless of caller/router, so no per-router re-seeding is needed). ============
  {
    const file = path.join(tmpHome, `${randomUUID()}.db`);
    const db = new Db(file);
    const now = new Date().toISOString();
    db.insertProject({ id: "pSkill", name: "Skill Wiring Proj", repoPath: "/t", vaultPath: "/t", config: {}, createdAt: now, archivedAt: null });

    const platformServer = new PlatformMcpRouter(db, {}).buildServer("sSkillPlatform");
    const platformClient = await connect(platformServer);
    const platformResult = await call(platformClient, "skill_list", {});
    check("(c) platform router's skill_list actually spills the oversized store end-to-end (proves the wiring, not just the shared function)",
      typeof platformResult.skillsFile === "string" && platformResult.skillsFile.includes("sSkillPlatform"));
    await platformClient.close();

    const setupServer = new SetupMcpRouter(db, {}).buildServer("sSkillSetup");
    const setupClient = await connect(setupServer);
    const setupResult = await call(setupClient, "skill_list", {});
    check("(c) setup router's skill_list actually spills the oversized store end-to-end",
      typeof setupResult.skillsFile === "string" && setupResult.skillsFile.includes("sSkillSetup"));
    await setupClient.close();

    const userAuditServer = new WorkspaceAuditMcpRouter(db, {}).buildServer("sSkillUserAudit");
    const userAuditClient = await connect(userAuditServer);
    const userAuditResult = await call(userAuditClient, "skill_list", {});
    check("(c) user-audit router's skill_list actually spills the oversized store end-to-end",
      typeof userAuditResult.skillsFile === "string" && userAuditResult.skillsFile.includes("sSkillUserAudit"));
    await userAuditClient.close();

    db.close();
  }
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — memory_list (TaskMcpRouter) spills an oversized pull to the caller's own scratch dir as an NDJSON pointer, stays byte-identical below the cap; skillListData (shared by platform/setup/user-audit's skill_list) genuinely spills an oversized store the same way (not just a near-empty passthrough), with a no-sessionId caller falling back to the pre-spill inline shape rather than throwing even on that oversized store; ALL THREE routers' skill_list wiring (platform, setup, user-audit) actually threads its own caller's session id through end-to-end and forces the real spill branch."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
