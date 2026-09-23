import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 91fef05a — spill-protect user-audit.ts's `agent_prompt_read` and `skill_read` (the End-User
// Workspace Auditor's own reads — mcp/user-audit.ts). Their siblings (agent_get, the orchestration skill
// tools) already spilled via `spillTextIfLarge`/`spillableAgentGet`; these two single-large-value reads
// had none, so a large agent startupPrompt or a large skill body could exceed the engine's own native
// tool-result threshold, which spills into `~/.claude/projects/**/tool-results/**` — a tree denied to
// the workspace-auditor role (TRANSCRIPT_ROOT_DENY_ROLES).
// HERMETIC, CLAUDE-FREE, NETWORK-FREE: a bare Db + the real WorkspaceAuditMcpRouter driven over in-process
// MCP InMemoryTransport (mirrors mcp-memory-skill-spill.mjs's light harness).
//
// Covers:
//   (A) agent_prompt_read — below-cap stays {id,projectId,name,startupPrompt}; an oversized startupPrompt
//       spills to {id,projectId,name,startupPromptFile,startupPromptChars,note}.
//   (B) skill_read — below-cap stays {name,content}; an oversized skill body spills to
//       {name,contentFile,contentChars,note}.
// Run: 1) build (turbo builds shared first), 2) node test/user-audit-read-spill.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-uars-${Date.now()}-${process.pid}`);
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
const { WorkspaceAuditMcpRouter } = await import("../dist/mcp/user-audit.js");
const { writeSkill } = await import("../dist/skills/store.js");
const { SPILL_INLINE_BUDGET_CHARS } = await import("../dist/spill.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "user-audit-read-spill-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

try {
  // ============ (A) agent_prompt_read ============
  {
    const file = path.join(tmpHome, `${randomUUID()}.db`);
    const db = new Db(file);
    const now = new Date().toISOString();
    db.insertProject({ id: "pAudit", name: "Audit Proj", repoPath: "/t", vaultPath: "/t", config: {}, createdAt: now, archivedAt: null });
    const bigPrompt = "A".repeat(SPILL_INLINE_BUDGET_CHARS + 5000);
    db.insertAgent({ id: "agentBig", projectId: "pAudit", name: "Big Agent", startupPrompt: bigPrompt, position: 0 });
    db.insertAgent({ id: "agentSmall", projectId: "pAudit", name: "Small Agent", startupPrompt: "small prompt", position: 1 });

    const router = new WorkspaceAuditMcpRouter(db, {});
    const client = await connect(router.buildServer("sAuditPrompt"));

    const big = await call(client, "agent_prompt_read", { agentId: "agentBig" });
    check("(A) an oversized agent_prompt_read IS spilled (not the bare startupPrompt shape)", big.startupPrompt === undefined && typeof big.startupPromptFile === "string");
    check("(A) the spill pointer carries id/projectId/name/startupPromptFile/startupPromptChars/note", big.id === "agentBig" && big.projectId === "pAudit" && big.name === "Big Agent" && typeof big.startupPromptChars === "number" && typeof big.note === "string");
    check("(A) the spill file lives under THIS auditor session's own scratch dir", big.startupPromptFile.includes("sAuditPrompt"));
    const spilledContent = fs.readFileSync(big.startupPromptFile, "utf8");
    check("(A) the spill file's content is the real prompt text", spilledContent === bigPrompt);

    const small = await call(client, "agent_prompt_read", { agentId: "agentSmall" });
    check("(A) a below-cap agent_prompt_read stays inline (byte-identical shape)", small.startupPrompt === "small prompt" && small.startupPromptFile === undefined);

    const missing = await call(client, "agent_prompt_read", { agentId: "no-such-agent" });
    check("(A) an unknown agentId still errors cleanly", missing.error === "agent not found");

    await client.close();
    db.close();
  }

  // ============ (B) skill_read ============
  {
    const file = path.join(tmpHome, `${randomUUID()}.db`);
    const db = new Db(file);
    const bigBody = "S".repeat(SPILL_INLINE_BUDGET_CHARS + 5000);
    const okBig = writeSkill("big-audit-skill", `---\nname: big-audit-skill\ndescription: oversized\n---\n${bigBody}`);
    check("(B) fixture sanity: writeSkill(big-audit-skill) succeeded", okBig === true);
    const okSmall = writeSkill("small-audit-skill", "---\nname: small-audit-skill\ndescription: tiny\n---\nsmall body");
    check("(B) fixture sanity: writeSkill(small-audit-skill) succeeded", okSmall === true);

    const router = new WorkspaceAuditMcpRouter(db, {});
    const client = await connect(router.buildServer("sAuditSkill"));

    const big = await call(client, "skill_read", { name: "big-audit-skill" });
    check("(B) an oversized skill_read IS spilled (not the bare {name,content} shape)", big.content === undefined && typeof big.contentFile === "string");
    check("(B) the spill pointer carries name/contentFile/contentChars/note", big.name === "big-audit-skill" && typeof big.contentChars === "number" && typeof big.note === "string");
    check("(B) the spill file lives under THIS auditor session's own scratch dir", big.contentFile.includes("sAuditSkill"));
    const spilledSkill = fs.readFileSync(big.contentFile, "utf8");
    check("(B) the spill file's content is the real (unescaped) skill text", spilledSkill.includes(bigBody));

    const small = await call(client, "skill_read", { name: "small-audit-skill" });
    check("(B) a below-cap skill_read stays inline (byte-identical shape)", small.content !== undefined && small.contentFile === undefined && small.content.includes("small body"));

    const missing = await call(client, "skill_read", { name: "no-such-skill" });
    check("(B) an unknown skill name still errors cleanly", missing.error === "skill not found");

    await client.close();
    db.close();
  }
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the workspace Auditor's agent_prompt_read and skill_read (mcp/user-audit.ts) both spill an oversized value to the caller's own scratch dir (same convention as their already-protected siblings agent_get/skill_list), and both stay byte-identical below the cap."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
