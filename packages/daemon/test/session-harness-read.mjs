import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 41f35bfe: the symmetric Session half of card 3edf6ef7 (see that card's own
// profile-harness-read.mjs for the Profile-side precedent this mirrors). `worker_status` could not tell
// "this worker's harness is unset" apart from "this tool doesn't project harness" — a NULL `harness`
// column maps to `undefined` (db.ts's `toSession`), and JSON.stringify drops an undefined-valued key
// entirely, so the wire response for an unset worker carried no `harness` key at all, same as a
// hypothetical tool that never named the field. First-hand evidence this card cites: a real
// `worker_status` call returned every sibling field and no `harness` key for a live claude worker.
//
// HERMETIC, real OrchestrationMcpRouter + real Db + InMemoryTransport (like worker-liveness-signal.mjs)
// — no daemon, no real claude, no pty needed for this read-only surface.
//
// Covers:
//   (1) REPRO — simulating the actual MCP wire shape (JSON.parse(JSON.stringify(...)), matching this
//       router's `ok()` envelope) on the RAW `db.getSession()` output: a SET harness survives the
//       round-trip, an UNSET one vanishes — the ambiguity, reproduced independent of any fix.
//   (2) FIX — `worker_status`'s actual wire response resolves an unset harness to explicit `null`, so
//       the key is ALWAYS present, AND an unset worker stays distinguishable from one explicitly set to
//       "claude" (the property this card needs: can a reader answer "is this set?", not just "is the
//       key present?"). `null` mirrors what the DB column itself already means.
//   (3) SCOPE — `db.ts`'s shared `toSession()` mapper is left UNTOUCHED: an unset harness still reads
//       back as `undefined` off `db.getSession()` directly. Negative control on the read fix itself — it
//       must not have leaked into the shared object it wraps. Left untouched for a TYPE reason, not a
//       partial-update "leave the column as-is" one: `Session.harness` is typed `?: "claude" | "codex"`
//       with no `null` member, so `toSession()` returning an explicit `null` wouldn't compile without
//       widening that shared type. This does NOT mirror the Profile side: no `UPDATE sessions SET`
//       statement in db.ts touches `harness` at all (unlike `updateProfile`'s binding at db.ts:4806,
//       which genuinely does read an unresolved `undefined` as "leave the column as-is" on a real
//       partial-PATCH path) — the fork/recycle "carry the pinned vendor CLI forward" call sites
//       (sessions/service.ts) each build a brand-new `Session` literal, so there is no leave-as-is
//       semantic on the Session side to disturb in the first place.
//   (4) worker_list's own curated fleet row is UNCHANGED by this fix (a separate, pre-existing curation
//       choice that never included `harness` at all — not this card's bug, not this card's fix).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/session-harness-read.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-sharness-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const dbFile = path.join(os.tmpdir(), `loom-sharness-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const seeded = "2026-09-08T00:00:00.000Z";
const projId = "proj-sharness";
const agentId = "agent-sharness";
db.insertProject({ id: projId, name: "Sharness", repoPath: projId, vaultPath: projId, config: {}, createdAt: seeded, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });
db.insertSession({ id: "mgr", projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: seeded, lastActivity: seeded, lastError: null, role: "manager", ctxInputTokens: null, ctxTurns: null, model: null });
db.insertSession({ id: "w-unset", projectId: projId, agentId, engineSessionId: "eng-w-unset", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seeded, lastActivity: seeded, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-unset" });
db.insertSession({ id: "w-codex", projectId: projId, agentId, engineSessionId: "eng-w-codex", title: null, cwd: projId, processState: "live", resumability: "unknown", busy: false, createdAt: seeded, lastActivity: seeded, lastError: null, role: "worker", parentSessionId: "mgr", taskId: "task-codex", harness: "codex" });

// ===================== (1) REPRO — the ambiguity, on the raw db.getSession() wire shape =====================
const rawUnset = db.getSession("w-unset");
const rawCodex = db.getSession("w-codex");
const wireRawCodex = JSON.parse(JSON.stringify(rawCodex));
const wireRawUnset = JSON.parse(JSON.stringify(rawUnset));
check("(1 repro) positive control: a SET harness survives the raw wire round-trip", wireRawCodex.harness === "codex");
check("(1 repro) THE DEFECT: an UNSET harness's key is entirely ABSENT from the raw wire round-trip " +
  "(indistinguishable from a tool that never projects harness at all)", !("harness" in wireRawUnset));

const sessionsStub = {
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
  listCapQueuedSpawns() { return []; },
  isArchivedWithoutReport() { return false; },
  async getDanglingWorkers() { return []; },
};

const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub), {});
const server = router.buildServer("mgr", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "session-harness-read-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} }));

try {
  // ===================== (2) FIX — worker_status always projects harness, SET and UNSET distinguishable =====================
  const statusCodex = await call("worker_status", { workerSessionId: "w-codex" });
  const statusUnset = await call("worker_status", { workerSessionId: "w-unset" });
  check("(2 fix) worker_status: a SET harness still reads through unchanged", statusCodex.harness === "codex");
  check("(2 fix) worker_status: an UNSET harness now reads back explicitly as `null`, no longer ambiguous",
    statusUnset.harness === null);
  check("(2 fix) worker_status: the harness key is present on the wire in BOTH cases now",
    "harness" in statusCodex && "harness" in statusUnset);
  check("(2 fix) worker_status: UNSET (null) and explicitly-SET-to-a-value remain DISTINGUISHABLE — the " +
    "property the card actually needs, not just key-presence", statusUnset.harness !== statusCodex.harness);

  // ===================== (3) SCOPE — db.ts's shared toSession() mapper is UNTOUCHED =====================
  // Negative control on the fix itself: if worker_status's resolution had leaked into the shared
  // db.getSession() object, this would go red.
  check("(3 scope) db.getSession() raw output for the UNSET worker is untouched: harness is still " +
    "`undefined` (never coerced) — left this way for a TYPE reason (Session.harness has no null member), " +
    "not a partial-update merge-base \"leave-as-is\" one (that hazard is Profile-only, db.ts:4806)",
    db.getSession("w-unset").harness === undefined);
  check("(3 scope) db.getSession() raw output for the SET worker is untouched",
    db.getSession("w-codex").harness === "codex");

  // ===================== (4) worker_list's curated fleet row is unaffected =====================
  const list = await call("worker_list");
  const listedUnset = list.find((w) => w.workerSessionId === "w-unset");
  const listedCodex = list.find((w) => w.workerSessionId === "w-codex");
  check("(4) worker_list rows exist for both workers", Boolean(listedUnset) && Boolean(listedCodex));
  check("(4) worker_list's own curated row shape is unchanged by this fix (harness was never one of its " +
    "named fields — a separate, pre-existing curation choice, not this card's bug or fix)",
    !("harness" in listedUnset) && !("harness" in listedCodex));
} finally {
  await client.close().catch(() => {});
}

console.log(failures === 0 ? "\nAll session-harness-read checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
