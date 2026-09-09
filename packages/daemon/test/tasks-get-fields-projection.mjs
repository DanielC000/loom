import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 40f4cae9 — `tasks_get` gains the SAME `fields:[...]` projection `tasks_list` already has (card
// 23fde5f8), reusing the identical `pickFields` helper (mcp/tasks.ts) wrapped/unwrapped around a
// single-element array since `tasks_get` returns ONE row, not a list.
//
// Proves the DoD line: "a test proving the un-asked-for fields are absent from the response itself" —
//   (A) POSITIVE CONTROL FIRST (polarity trap): the unprojected default read carries columnKey/priority/
//       held/merged/requests — proving the check can actually SEE those fields before we assert their
//       absence.
//   (B) fields:["id","title"] ⇒ the response's key set is EXACTLY {id,title} — every other key (columnKey,
//       priority, held, merged, requests, deferredItems, incomingDeferredItems, heldRequestState, ...) is
//       genuinely absent from the RESPONSE OBJECT, not merely omitted from a preview.
//   (C) an unmatched/unknown field name is silently ignored (no error), never surfaces on the row.
//   (D) `id` is NOT auto-added: fields:["title"] alone returns a response with ONLY {title}, no id.
//   (E) ORDERING: `fields` is applied AFTER the spill decision — an oversized body still spills to a
//       scratch file (bodyFile/bodyChars/note) even when `fields` excludes "body", proving the spill
//       check ran against the FULL content, not the projected one; and when `fields` DOES include "body",
//       the oversized read still gets the bodyFile/bodyChars/note treatment (never a raw giant body key)
//       exactly like the unprojected case.
//
// HERMETIC, CLAUDE-FREE, NETWORK-FREE — mirrors tasks-get-body-spill.mjs's simple fakePty harness.
//
// Run: 1) build (turbo builds shared first), 2) node test/tasks-get-fields-projection.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-tgfp-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { SPILL_INLINE_BUDGET_CHARS } = await import("../dist/spill.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const dbFile = path.join(tmpHome, "tgfp.db");
const db = new Db(dbFile);
const projId = "p-fieldsget";
const SESSION_ID = "S-FIELDSGET";
db.insertProject({ id: projId, name: "Fields Get Project", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: now, archivedAt: null, reserved: false });
const agentId = "fieldsget-agent";
db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
db.insertSession({
  id: SESSION_ID, projectId: projId, agentId, engineSessionId: "eng-fieldsget", title: null, cwd: "C:/f",
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager",
});

const TASK_SMALL = "fieldsget-task-small";
db.insertTask({ id: TASK_SMALL, projectId: projId, title: "Small Card", body: "short body", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now, held: true, heldBy: "human" });

const BODY_LINE = "y".repeat(200);
const bigBody = Array.from({ length: 275 }, (_, i) => `${BODY_LINE}-L${i}`).join("\n");
const TASK_BIG = "fieldsget-task-big";
db.insertTask({ id: TASK_BIG, projectId: projId, title: "Big Card", body: bigBody, columnKey: "in_progress", position: 2, priority: "p1", createdAt: now, updatedAt: now });

const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

try {
  const server = new TaskMcpRouter(db, wakes).buildServer(projId, SESSION_ID);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "tasks-get-fields-projection-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  // ═══════════════════ (A) POSITIVE CONTROL — unprojected read carries the fields we'll later drop ═══
  const defaultRow = await call("tasks_get", { id: TASK_SMALL });
  check("(A) setup: default read resolves the right task", defaultRow.id === TASK_SMALL);
  check("(A) positive control: default read carries columnKey/priority/held (fields we'll later drop)",
    defaultRow.columnKey === "backlog" && defaultRow.priority === "p2" && defaultRow.held === true);
  check("(A) positive control: default read also carries the requests/merged/deferredItems enrichment keys",
    "requests" in defaultRow && "merged" in defaultRow && "deferredItems" in defaultRow && "incomingDeferredItems" in defaultRow);

  // ═══════════════════════ (B) fields:["id","title"] — exact key set ═══════════════════════
  const projected = await call("tasks_get", { id: TASK_SMALL, fields: ["id", "title"] });
  const keys = Object.keys(projected).sort();
  check("(B) fields projection: response key set is EXACTLY {id,title} — no columnKey/priority/held/merged/requests/etc",
    keys.length === 2 && keys[0] === "id" && keys[1] === "title");
  check("(B) fields projection: values are correct (projection didn't corrupt content)",
    projected.id === TASK_SMALL && projected.title === "Small Card");

  // ═══════════════════════ (C) unknown field name — silently ignored, no error ═══════════════════════
  const typoRow = await call("tasks_get", { id: TASK_SMALL, fields: ["id", "thisFieldDoesNotExist"] });
  const typoKeys = Object.keys(typoRow);
  check("(C) unknown field name: call succeeds (not an error) and the real field (id) still resolves",
    typoRow.id === TASK_SMALL);
  check("(C) unknown field name: the bogus name never appears as a key, and no other field leaks in",
    typoKeys.length === 1 && typoKeys[0] === "id");

  // ═══════════════════════════════ (D) `id` is NOT auto-added ═══════════════════════════════
  const noIdRow = await call("tasks_get", { id: TASK_SMALL, fields: ["title"] });
  check("(D) fields:[\"title\"] alone omits id — not auto-added", !("id" in noIdRow) && Object.keys(noIdRow).length === 1 && noIdRow.title === "Small Card");

  // ═════════════ (E) ORDERING: projection applies AFTER the spill decision ═════════════
  // (E1) fields excludes "body" entirely — the spill check must still run against the FULL body first
  // (this is a behavior-neutral cost question, not a correctness one, but the shape must not regress:
  // no raw giant body ever leaks into the response even when it isn't asked for at all).
  const bigNoBody = await call("tasks_get", { id: TASK_BIG, fields: ["id", "title"] });
  check("(E1) projecting away body: response key set is EXACTLY {id,title}, no body/bodyFile leak",
    Object.keys(bigNoBody).sort().join(",") === "id,title");

  // (E2) fields INCLUDES "body" on the oversized task — must still get the bodyFile/bodyChars/note
  // treatment (the spill decision ran on the full content), never a raw multi-KB body key.
  const bigWithBody = await call("tasks_get", { id: TASK_BIG, fields: ["id", "title", "body", "bodyFile", "bodyChars", "note"] });
  check("(E2) requesting body on an oversized task: body itself is absent (spilled), bodyFile/bodyChars/note present instead",
    bigWithBody.body === undefined && typeof bigWithBody.bodyFile === "string" && typeof bigWithBody.bodyChars === "number" && typeof bigWithBody.note === "string");
  check("(E2) bodyChars exceeds the spill budget (proves the spill check ran against the FULL body, not a projected-away one)",
    bigWithBody.bodyChars > SPILL_INLINE_BUDGET_CHARS);
  const expectedText = `Big Card\n\n${bigBody}`;
  check("(E2) the spilled file content is unaffected by the fields projection — byte-identical to the full text",
    fs.readFileSync(bigWithBody.bodyFile, "utf8") === expectedText);
  check("(E2) requested-but-not-materialized keys (fields asked for body/bodyFile/bodyChars/note all at once) still yield the exact set actually present, no more",
    Object.keys(bigWithBody).sort().join(",") === "bodyChars,bodyFile,id,note,title");

  await client.close();
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — tasks_get's fields:[...] projection genuinely drops un-asked-for keys from the response itself (not a spill preview), silently ignores an unmatched field name, never auto-adds id, and is applied AFTER the spill decision so an oversized body is still safely spilled regardless of whether fields asks for it."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
