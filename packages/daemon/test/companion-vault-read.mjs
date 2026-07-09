import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — `vault-read` (a read-only `vault_lookup` tool
// searching a granted project's Obsidian vault notes). Mirrors companion-board-reach.mjs's coverage
// shape. READ-ONLY LEVER — there is no act half.
// Fully hermetic: a REAL Db on a temp LOOM_HOME + a REAL fixture vault dir on disk + the REAL
// OrchestrationMcpRouter over an in-memory MCP transport. NO network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   (a) grant present ⇒ vault_lookup returns the matching note WITH its path citation + excerpt.
//   (b) SECURITY: a .env / *.pem / a note under secrets/ whose content MATCHES the query is NEVER
//       returned, even though its content matches — the core security assertion.
//   (c) a `companion-read: false` note that matches is excluded.
//   (d) a `project` selector outside scope is rejected with {error}; a note in an UNGRANTED project is
//       never searched (proven via a query that only matches content in the ungranted project).
//   (e) no grant ⇒ vault_lookup is NOT registered (inert + invisible; byte-identical tool surface).
//   (f) a grant row on a non-assistant-role session registers nothing (role gate).
//   (g) result count is bounded to the cap even when more matching notes exist.
// Run: 1) build (turbo builds shared first), 2) node test/companion-vault-read.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-vault-read-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-vault-read-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const listOf = async (server) => { const c = await connect(server); const names = (await c.listTools()).tools.map((t) => t.name); await c.close(); return names; };
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const now = new Date().toISOString();
function seedProject(db, id, name, vaultPath) {
  db.insertProject({ id, name, repoPath: id, vaultPath: vaultPath ?? "", config: {}, createdAt: now, archivedAt: null });
}
function seedSession(db, id, projectId, role) {
  const agentId = `a-${id}`;
  db.insertAgent({ id: agentId, projectId, name: role, startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projectId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role, taskId: null,
  });
}
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

function writeNote(vaultDir, relPath, content) {
  const abs = path.join(vaultDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function makeVault(nameSuffix) {
  const dir = path.join(tmpHome, `vault-${nameSuffix}-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

try {
  // ============ (a) grant present ⇒ vault_lookup returns the matching note + path + excerpt ============
  {
    const vaultA = makeVault("a");
    writeNote(vaultA, "Design/Widget.md", "The widget frobnicator handles the special-sauce case for widgets.");
    writeNote(vaultA, "Notes/Unrelated.md", "This note is about something else entirely.");

    const db = tmpDb();
    const projA = "proj-vault-a";
    seedProject(db, projA, "Vault A", vaultA);
    const companionSess = "companion-vault-a";
    seedSession(db, companionSess, projA, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "vault-read", projectId: projA, mode: "read" });

    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("(a) the GRANTED companion HAS vault_lookup", tools.includes("vault_lookup"));

    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "vault_lookup", { query: "frobnicator" });
    check("(a) vault_lookup returns the matching note", res.results.some((r) => r.path === "Design/Widget.md"));
    const hit = res.results.find((r) => r.path === "Design/Widget.md");
    check("(a) result carries projectId/projectName + a citable path + an excerpt containing the match",
      hit?.projectId === projA && hit?.projectName === "Vault A" && typeof hit?.excerpt === "string"
      && hit.excerpt.toLowerCase().includes("frobnicator"));
    check("(a) the unrelated note is not returned", !res.results.some((r) => r.path === "Notes/Unrelated.md"));
    await client.close();
    db.close();
  }

  // ============ (b) SECURITY: secret-shaped notes are NEVER returned, even on a content match ============
  {
    const vaultB = makeVault("secure");
    writeNote(vaultB, ".env", "API_KEY=supersecretvalue123\n");
    writeNote(vaultB, "config.pem", "-----BEGIN CERTIFICATE-----\nsupersecretvalue123\n-----END CERTIFICATE-----");
    writeNote(vaultB, "secrets/token.md", "supersecretvalue123 is the rotating token.");
    writeNote(vaultB, "Notes/Safe.md", "This note mentions supersecretvalue123 too, but lives in a normal folder.");

    const db = tmpDb();
    const projB = "proj-vault-secure";
    seedProject(db, projB, "Vault Secure", vaultB);
    const companionSess = "companion-vault-secure";
    seedSession(db, companionSess, projB, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "vault-read", projectId: projB, mode: "read" });

    const orch = new OrchestrationMcpRouter(db, {});
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "vault_lookup", { query: "supersecretvalue123" });
    check("(b) SECURITY: .env is NEVER returned even though its content matches", !res.results.some((r) => r.path === ".env"));
    check("(b) SECURITY: *.pem is NEVER returned even though its content matches", !res.results.some((r) => r.path === "config.pem"));
    check("(b) SECURITY: a note under secrets/ is NEVER returned even though its content matches", !res.results.some((r) => r.path === "secrets/token.md"));
    check("(b) a normal note with the SAME matching content IS returned (proves the query itself works)", res.results.some((r) => r.path === "Notes/Safe.md"));
    await client.close();
    db.close();
  }

  // ============ (c) a `companion-read: false` note that matches is excluded ============
  {
    const vaultC = makeVault("optout");
    writeNote(vaultC, "OptOut.md", "---\ncompanion-read: false\n---\n\nThis note mentions the unicorn-marker phrase.");
    writeNote(vaultC, "Included.md", "This note also mentions the unicorn-marker phrase but has no opt-out.");

    const db = tmpDb();
    const projC = "proj-vault-optout";
    seedProject(db, projC, "Vault Optout", vaultC);
    const companionSess = "companion-vault-optout";
    seedSession(db, companionSess, projC, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "vault-read", projectId: projC, mode: "read" });

    const orch = new OrchestrationMcpRouter(db, {});
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "vault_lookup", { query: "unicorn-marker" });
    check("(c) a `companion-read: false` note is excluded even on a content match", !res.results.some((r) => r.path === "OptOut.md"));
    check("(c) a normal note with the same match IS returned", res.results.some((r) => r.path === "Included.md"));
    await client.close();
    db.close();
  }

  // ============ (c2) CR fix: BOM-prefixed / CRLF frontmatter + falsy broadening ============
  {
    const vaultC2 = makeVault("optout-bom");
    // A leading UTF-8 BOM (U+FEFF) sits before the `---` fence — realistic on this Windows-primary host
    // (VSCode/PowerShell commonly write one). Before the CR fix this defeated the `^---` anchor entirely.
    writeNote(vaultC2, "BomOptOut.md", "﻿---\ncompanion-read: false\n---\n\nThis note mentions the bom-marker phrase.");
    writeNote(vaultC2, "CrlfOptOut.md", "---\r\ncompanion-read: false\r\n---\r\n\r\nThis note mentions the crlf-marker phrase.\r\n");
    writeNote(vaultC2, "NoOptOut.md", "---\ncompanion-read: no\n---\n\nThis note mentions the no-marker phrase.");
    writeNote(vaultC2, "QuotedOptOut.md", "---\ncompanion-read: \"false\"\n---\n\nThis note mentions the quoted-marker phrase.");
    writeNote(vaultC2, "LeadingBlankLine.md", "\n---\ncompanion-read: false\n---\n\nThis note mentions the blank-line-marker phrase.");

    const db = tmpDb();
    const proj = "proj-vault-optout-bom";
    seedProject(db, proj, "Vault Optout BOM", vaultC2);
    const companionSess = "companion-vault-optout-bom";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "vault-read", projectId: proj, mode: "read" });

    const orch = new OrchestrationMcpRouter(db, {});
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const bomRes = await call(client, "vault_lookup", { query: "bom-marker" });
    check("(c2) CR FIX: a BOM-prefixed `companion-read: false` note IS excluded", !bomRes.results.some((r) => r.path === "BomOptOut.md"));

    const crlfRes = await call(client, "vault_lookup", { query: "crlf-marker" });
    check("(c2) a CRLF-frontmatter `companion-read: false` note is excluded", !crlfRes.results.some((r) => r.path === "CrlfOptOut.md"));

    const noRes = await call(client, "vault_lookup", { query: "no-marker" });
    check("(c2) falsy broadening: `companion-read: no` excludes the note", !noRes.results.some((r) => r.path === "NoOptOut.md"));

    const quotedRes = await call(client, "vault_lookup", { query: "quoted-marker" });
    check("(c2) falsy broadening: a quoted `companion-read: \"false\"` excludes the note", !quotedRes.results.some((r) => r.path === "QuotedOptOut.md"));

    const blankRes = await call(client, "vault_lookup", { query: "blank-line-marker" });
    check("(c2) a leading BLANK LINE before the `---` fence is correctly NOT treated as frontmatter (Obsidian ignores it too) — note IS returned",
      blankRes.results.some((r) => r.path === "LeadingBlankLine.md"));

    await client.close();
    db.close();
  }

  // ============ (b2) CR fix: extended denied-folder floor + basename-beyond-.env + case/nesting ============
  {
    const vaultB2 = makeVault("secure-extended");
    writeNote(vaultB2, "id_rsa.txt", "extended-marker-phrase is the private key material.");
    writeNote(vaultB2, "keys/api-key.md", "extended-marker-phrase lives under a keys/ folder.");
    writeNote(vaultB2, "passwords/list.md", "extended-marker-phrase is a password list.");
    writeNote(vaultB2, ".aws/credentials.md", "extended-marker-phrase is an AWS credential note.");
    writeNote(vaultB2, ".gnupg/note.md", "extended-marker-phrase lives under .gnupg.");
    // Case-insensitive + NESTED denied segment (not just top-level, not just lowercase).
    writeNote(vaultB2, "Projects/Secrets/x.md", "extended-marker-phrase nested under a capitalized Secrets folder.");
    writeNote(vaultB2, ".ENV", "extended-marker-phrase in an uppercase-named env file.");
    writeNote(vaultB2, "Notes/StillSafe.md", "extended-marker-phrase in a genuinely normal note.");

    const db = tmpDb();
    const proj = "proj-vault-secure-extended";
    seedProject(db, proj, "Vault Secure Extended", vaultB2);
    const companionSess = "companion-vault-secure-extended";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "vault-read", projectId: proj, mode: "read" });

    const orch = new OrchestrationMcpRouter(db, {});
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "vault_lookup", { query: "extended-marker-phrase" });
    check("(b2) basename deny beyond .env: id_rsa.txt is excluded despite passing the extension floor", !res.results.some((r) => r.path === "id_rsa.txt"));
    check("(b2) a note under keys/ is excluded", !res.results.some((r) => r.path === "keys/api-key.md"));
    check("(b2) a note under passwords/ is excluded", !res.results.some((r) => r.path === "passwords/list.md"));
    check("(b2) a note under .aws/ is excluded", !res.results.some((r) => r.path === ".aws/credentials.md"));
    check("(b2) a note under .gnupg/ is excluded", !res.results.some((r) => r.path === ".gnupg/note.md"));
    check("(b2) a NESTED, capitalized Secrets/ segment is excluded (case-insensitive + any depth)", !res.results.some((r) => r.path === "Projects/Secrets/x.md"));
    check("(b2) an uppercase .ENV file is excluded", !res.results.some((r) => r.path === ".ENV"));
    check("(b2) a genuinely normal note with the SAME content IS returned", res.results.some((r) => r.path === "Notes/StillSafe.md"));
    await client.close();
    db.close();
  }

  // ============ (d) project-selector scoping + an ungranted project's notes are never searched ============
  {
    const vaultD1 = makeVault("scope-a");
    const vaultD2 = makeVault("scope-b");
    writeNote(vaultD1, "A.md", "granted-project-marker appears here in project A.");
    writeNote(vaultD2, "B.md", "granted-project-marker appears here in project B too.");

    const db = tmpDb();
    const projA = "proj-scope-a", projB = "proj-scope-b";
    seedProject(db, projA, "Scope A", vaultD1);
    seedProject(db, projB, "Scope B", vaultD2);
    const companionSess = "companion-scope";
    seedSession(db, companionSess, projA, "assistant");
    // Grant ONLY project A — project B is never granted.
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "vault-read", projectId: projA, mode: "read" });

    const orch = new OrchestrationMcpRouter(db, {});
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const rejected = await call(client, "vault_lookup", { query: "granted-project-marker", project: projB });
    check("(d) a `project` selector OUTSIDE scope is REJECTED with an {error} (can never widen scope)",
      typeof rejected.error === "string" && rejected.results === undefined);

    const scoped = await call(client, "vault_lookup", { query: "granted-project-marker" });
    check("(d) the granted project's note IS returned", scoped.results.some((r) => r.path === "A.md" && r.projectId === projA));
    check("(d) the UNGRANTED project's note is never searched/returned", !scoped.results.some((r) => r.path === "B.md"));
    await client.close();
    db.close();
  }

  // ============ (e) no grant ⇒ vault_lookup is NOT registered (inert + invisible) ============
  {
    const vaultE = makeVault("nogrant");
    writeNote(vaultE, "Note.md", "content");
    const db = tmpDb();
    const proj = "proj-vault-no-grant";
    seedProject(db, proj, "No grant", vaultE);
    const companionSess = "companion-vault-no-grant";
    seedSession(db, companionSess, proj, "assistant");

    const orch = new OrchestrationMcpRouter(db, {});
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("(e) an ungranted companion does NOT have vault_lookup", !tools.includes("vault_lookup"));
    db.close();
  }

  // ============ (f) registerCompanionCapabilities is role-gated to "assistant" ============
  {
    const vaultF = makeVault("rolegate");
    const db = tmpDb();
    const proj = "proj-vault-role-gate";
    seedProject(db, proj, "Role gate", vaultF);
    // A grant row on a NON-assistant session id — should never happen via the REST writer (it requires
    // role==="assistant"), but seed it directly to prove the belt-and-suspenders role gate holds even then.
    const mgrSess = "mgr-with-stray-vault-grant";
    seedSession(db, mgrSess, proj, "manager");
    db.upsertCompanionCapabilityGrant({ sessionId: mgrSess, capability: "vault-read", projectId: null });

    const orch = new OrchestrationMcpRouter(db, {});
    const mgrTools = await listOf(orch.buildServer(mgrSess, "manager"));
    check("(f) a manager session with a STRAY grant row still does NOT get vault_lookup (role gate)", !mgrTools.includes("vault_lookup"));
    db.close();
  }

  // ============ (g) result count is bounded to the cap even when more matching notes exist ============
  {
    const vaultG = makeVault("capped");
    for (let i = 0; i < 20; i++) {
      writeNote(vaultG, `Note-${String(i).padStart(2, "0")}.md`, `cap-marker-phrase appears in note ${i}.`);
    }
    const db = tmpDb();
    const proj = "proj-vault-capped";
    seedProject(db, proj, "Capped", vaultG);
    const companionSess = "companion-vault-capped";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "vault-read", projectId: proj, mode: "read" });

    const orch = new OrchestrationMcpRouter(db, {});
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "vault_lookup", { query: "cap-marker-phrase" });
    check("(g) 20 matching notes exist but the result list is capped well under that", res.results.length > 0 && res.results.length <= 15);
    await client.close();
    db.close();
  }

  // ============ (h) CR fix: an oversize note (over the per-file byte cap) is skipped, never read ============
  {
    const vaultH = makeVault("oversize");
    // Comfortably over VAULT_LOOKUP_MAX_FILE_BYTES (512 KiB) — a pasted multi-hundred-KB note.
    const huge = "oversize-marker-phrase " + "x".repeat(600 * 1024);
    writeNote(vaultH, "Huge.md", huge);
    writeNote(vaultH, "Normal.md", "oversize-marker-phrase also appears in this normal-sized note.");

    const db = tmpDb();
    const proj = "proj-vault-oversize";
    seedProject(db, proj, "Oversize", vaultH);
    const companionSess = "companion-vault-oversize";
    seedSession(db, companionSess, proj, "assistant");
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "vault-read", projectId: proj, mode: "read" });

    const orch = new OrchestrationMcpRouter(db, {});
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const res = await call(client, "vault_lookup", { query: "oversize-marker-phrase" });
    check("(h) CR FIX: an oversize note is NEVER returned even though its content matches (skipped before the full read)",
      !res.results.some((r) => r.path === "Huge.md"));
    check("(h) a normal-sized note with the SAME matching content IS returned", res.results.some((r) => r.path === "Normal.md"));
    await client.close();
    db.close();
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — vault_lookup registers ONLY behind a vault-read grant and searches ONLY the granted project(s)' text notes, returning a path + excerpt for each match; secret/credential-shaped notes (incl. BOM-prefixed / CRLF / falsy-broadened companion-read opt-outs, the extended deny-folder list, and oversize notes over the per-file byte cap) are NEVER returned even on a content match; a project selector can never widen scope; an ungranted/non-assistant session gets nothing; and results stay bounded to the cap."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
