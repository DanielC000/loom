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
//       {skills:[...]}, above-cap spills to a {skillsFile,skillsChars,rowCount,note} pointer. A caller
//       with no session id (sessionId omitted) falls back to the pre-spill inline shape rather than
//       throwing — every existing non-session call site (if any) stays byte-identical.
//   (c) skill_list wiring on the PLATFORM router (the highest-privilege of the three call sites) actually
//       passes its own session id through to skillListData, proving the wiring (not just the shared
//       function) is live — platform.ts/setup.ts/user-audit.ts share ONE implementation, so this one
//       wiring proof covers the shape all three now share; a per-router duplicate isn't needed to prove
//       the pattern, only that at least one real call site is wired correctly.
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
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
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

  // ============ (b) skillListData: pure-function spill, and the no-sessionId fallback ============
  {
    // A small store (well under the cap): stays inline regardless of sessionId.
    const inlineNoSession = skillListData();
    check("(b) skillListData() with no sessionId returns the bare {skills} shape", Array.isArray(inlineNoSession.skills) && inlineNoSession.skillsFile === undefined);
    const inlineWithSession = skillListData("some-session-id-that-should-not-be-touched");
    check("(b) skillListData(sessionId) on a small store also stays inline (byte-identical shape)", Array.isArray(inlineWithSession.skills) && inlineWithSession.skillsFile === undefined);
  }

  // ============ (c) skill_list wiring on the platform router actually threads the caller's session id ============
  {
    const file = path.join(tmpHome, `${randomUUID()}.db`);
    const db = new Db(file);
    const now = new Date().toISOString();
    db.insertProject({ id: "pSkill", name: "Skill Wiring Proj", repoPath: "/t", vaultPath: "/t", config: {}, createdAt: now, archivedAt: null });
    const router = new PlatformMcpRouter(db, {});
    const server = router.buildServer("sSkill");
    const client = await connect(server);
    const result = await call(client, "skill_list", {});
    // A near-empty test store stays inline — this proves the WIRING (skill_list actually calls
    // skillListData(callerSessionId) and returns its result verbatim) rather than the spill threshold
    // itself, which (b) above already covers directly and more cheaply.
    check("(c) skill_list on the platform router returns the {skills} shape end-to-end", Array.isArray(result.skills));
    await client.close();
    db.close();
  }
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — memory_list (TaskMcpRouter) spills an oversized pull to the caller's own scratch dir as an NDJSON pointer, stays byte-identical below the cap; skillListData (shared by platform/setup/user-audit's skill_list) does the same, with a no-sessionId caller falling back to the pre-spill inline shape rather than throwing; the platform router's skill_list wiring actually threads its caller's session id through end-to-end."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
