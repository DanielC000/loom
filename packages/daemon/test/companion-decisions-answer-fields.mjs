import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// decisions-relay: an ANSWERED decision returns the owner's answer exactly as stored on BOTH `decisions_list`
// and `decision_get` (chosenOption, note, answeredAt); a permission row also carries its decided grant; a
// credential row NEVER carries chosenOption/note (never-echo); a PENDING row carries no answer keys; a slim
// `since` delta row stays slim. Hermetic: real Db on a temp LOOM_HOME + real OrchestrationMcpRouter over an
// in-memory MCP transport. NO network, NO real claude, NO daemon.
// Run: 1) build, 2) node test/companion-decisions-answer-fields.mjs  (also under LOOM_DEV=1)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-dec-ans-${Date.now()}-${process.pid}`);
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
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-decisions-answer-fields-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const now = new Date().toISOString();
const created = "2020-01-01T00:00:00.000Z";
const ANSWERED_AT = "2020-01-02T03:04:05.000Z";
const NOTE = "ship it, but only after the freeze lifts";
const EXPIRY = "2999-01-01T00:00:00.000Z";
const LAPSED_EXPIRY = "2001-01-01T00:00:00.000Z";

function seedQuestion(db, id, sessionId, projectId, opts = {}) {
  db.insertQuestion({
    id, sessionId, projectId, type: opts.type, title: `Question ${id}`, body: "body text",
    options: opts.options ?? null, recommendation: null,
    state: "pending", chosenOption: null, note: null, createdAt: created, answeredAt: null, consumedAt: null,
  });
}

try {
  const db = new Db(path.join(tmpHome, `${randomUUID()}.db`));
  db.insertProject({ id: "p", name: "P", repoPath: "p", vaultPath: "p", config: {}, createdAt: now, archivedAt: null });
  for (const [id, role] of [["comp", "assistant"], ["mgr", "manager"]]) {
    db.insertAgent({ id: `a-${id}`, projectId: "p", name: role, startupPrompt: "", position: 0 });
    db.insertSession({
      id, projectId: "p", agentId: `a-${id}`, engineSessionId: `eng-${id}`, title: null, cwd: "p",
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role, taskId: null,
    });
  }
  seedQuestion(db, "q-dec", "mgr", "p", { options: ["a", "b"] });
  seedQuestion(db, "q-pend", "mgr", "p", { options: ["a", "b"] });
  seedQuestion(db, "q-perm", "mgr", "p", { type: "permission" });
  seedQuestion(db, "q-perm-lapsed", "mgr", "p", { type: "permission" });
  seedQuestion(db, "q-cred", "mgr", "p", { type: "credential" });
  db.answerQuestion("q-dec", { chosenOption: "b", note: NOTE, answeredAt: ANSWERED_AT });
  db.answerQuestion("q-perm", { chosenOption: "authorize", note: null, answeredAt: ANSWERED_AT, decidedScope: "standing", decidedExpiresAt: EXPIRY });
  db.answerQuestion("q-perm-lapsed", { chosenOption: "authorize", note: null, answeredAt: ANSWERED_AT, decidedScope: "standing", decidedExpiresAt: LAPSED_EXPIRY });
  check("fixture: credential row actually answered", db.answerCredentialQuestion("q-cred", { secretBlob: "SECRET-BLOB-SENTINEL", answeredAt: ANSWERED_AT })?.state === "answered");
  db.upsertCompanionCapabilityGrant({ sessionId: "comp", capability: "decisions-relay", projectId: "p", mode: "read" });

  const orch = new OrchestrationMcpRouter(db, {});
  const client = await connect(orch.buildServer("comp", "assistant"));

  const list = await call(client, "decisions_list", {});
  const row = (id) => list.decisions.find((d) => d.questionId === id);
  const dec = row("q-dec");
  check("list: answered row carries chosenOption/note/answeredAt exactly as stored",
    dec?.chosenOption === "b" && dec?.note === NOTE && dec?.answeredAt === ANSWERED_AT && dec?.state === "answered");
  const get = (await call(client, "decision_get", { questionId: "q-dec" })).decision;
  check("get: answered row carries chosenOption/note/answeredAt exactly as stored",
    get?.chosenOption === "b" && get?.note === NOTE && get?.answeredAt === ANSWERED_AT);
  check("list: pending row has NO answer keys", !["chosenOption", "note", "answeredAt"].some((k) => k in row("q-pend")));
  const getPend = (await call(client, "decision_get", { questionId: "q-pend" })).decision;
  check("get: pending row has NO answer keys", !["chosenOption", "note", "answeredAt"].some((k) => k in getPend));

  for (const [label, r] of [["list", row("q-perm")], ["get", (await call(client, "decision_get", { questionId: "q-perm" })).decision]]) {
    check(`${label}: permission row carries approved + decided scope/expiry, not lapsed`,
      r?.approved === true && r?.chosenOption === "authorize" && r?.scope === "standing" && r?.expiresAt === EXPIRY && r?.lapsed === false && !("decidedScope" in r) && !("fulfillment" in r) && !("attachments" in r));
  }
  check("list: a permission grant past its expiry reads lapsed:true", row("q-perm-lapsed")?.lapsed === true);
  check("get: a permission grant past its expiry reads lapsed:true", (await call(client, "decision_get", { questionId: "q-perm-lapsed" })).decision?.lapsed === true);
  check("non-permission answered row has no grant keys", !["approved", "scope", "expiresAt", "lapsed"].some((k) => k in dec));

  for (const [label, r] of [["list", row("q-cred")], ["get", (await call(client, "decision_get", { questionId: "q-cred" })).decision]]) {
    check(`${label}: credential row carries answeredAt only (never-echo: no chosenOption/note/grant keys)`,
      r?.answeredAt === ANSWERED_AT && !["chosenOption", "note", "approved", "scope", "expiresAt", "lapsed"].some((k) => k in r));
  }

  const rawCred = (await client.callTool({ name: "decision_get", arguments: { questionId: "q-cred" } })).content[0].text
    + (await client.callTool({ name: "decisions_list", arguments: {} })).content[0].text;
  check("credential secret sentinel never appears in either tool's raw response", !rawCred.includes("SECRET-BLOB-SENTINEL"));

  // since/delta: a second read with `since` after the first read makes the unchanged answered row slim — and it stays slim.
  const slim = await call(client, "decisions_list", { since: list.asOf });
  const slimDec = slim.decisions.find((d) => d.questionId === "q-dec");
  check("delta: unchanged answered row is slim (no answer fields, no body)",
    slimDec?.slimmed === true && !["chosenOption", "note", "answeredAt", "body", "options"].some((k) => k in slimDec));

  await client.close();
  db.close();
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0 ? "\n✅ ALL PASS — answered decisions return the owner's answer on decisions_list and decision_get; credential never-echo and slim delta rows preserved." : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
