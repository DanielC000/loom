import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card d56c6ef0 finding 2 — tasks_get's `bodyGrep`/`bodySlice` excerpt spill shared its scratch-file KEY
// with the plain (unexcerpted) full-body spill: both called `spillableTaskGet(sessionId,
// "tasks-get-spills", result.id, ...)`, keyed ONLY on the task's own id. A plain full-body read and a
// `bodyGrep`/`bodySlice` excerpt read of the SAME oversized task are genuinely DIFFERENT content — but
// when BOTH exceed the spill budget, they land on the SAME scratch file, so whichever call happens
// SECOND silently overwrites the first's spilled file with different content. A caller holding the
// first call's `bodyFile` pointer then reads the SECOND call's (wrong) content with no error or signal —
// the exact collision class `taskListSpillKey` (mcp/server.ts) already fixed for `tasks_list`'s own
// filter/pagination combos.
//
// FIX: a new `taskGetSpillKey(taskId, {bodyGrep,bodySlice})` helper (mcp/server.ts) derives the spill key
// from the task id AND the excerpt options together — a PLAIN read (no bodyGrep/bodySlice) keeps the
// UNCHANGED, byte-identical key (just the task's own id, same as spillableTaskUpdateResult/every other
// spillableTaskGet call site), so a repeat plain read still overwrites rather than accumulates. Only an
// EXCERPTED read gets a distinguishing suffix, and two DIFFERENT excerpt options get two DIFFERENT keys.
//
// HERMETIC, CLAUDE-FREE, NETWORK-FREE: isolated LOOM_HOME + sandboxed HOME, a REAL Db, the REAL
// TaskMcpRouter over an in-process MCP InMemoryTransport (no HTTP, no daemon, no pty). Mirrors
// tasks-get-body-spill.mjs's harness shape.
//
// Proves:
//   (1) a plain (unexcerpted) oversized read spills, same as before.
//   (2) a bodyGrep excerpt of the SAME task, ALSO large enough to exceed the spill budget, spills to a
//       DIFFERENT file than the plain read — never the same key.
//   (3) THE COLLISION, directly: after the excerpt call runs, the PLAIN read's own spilled file is still
//       byte-identical to the full, unexcerpted text — it was NOT silently overwritten by the excerpt
//       call (the actual defect this card fixes; under the old shared key, this file would now hold the
//       excerpt's content instead).
//   (4) the excerpt's own spilled file holds ONLY the excerpted (matching-lines) text, not the full body.
//   (5) a SECOND, DIFFERENT bodyGrep excerpt (also over-budget) gets its OWN third file, distinct from
//       both the plain read's file and the first excerpt's file.
//   (6) a repeat PLAIN read (no excerpt) re-uses the SAME key as the original plain read — unchanged,
//       byte-identical "same content overwrites" behavior for the non-excerpt path.
//
// Run: 1) build (turbo builds shared first), 2) node test/tasks-get-excerpt-spill-key.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-tgesk-${Date.now()}-${process.pid}`);
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
const dbFile = path.join(tmpHome, "tgesk.db");
const db = new Db(dbFile);
const projId = "p-excerptspill";
const SESSION_ID = "S-EXCERPTSPILL";
db.insertProject({ id: projId, name: "Excerpt Spill Project", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: now, archivedAt: null, reserved: false });
const agentId = "excerptspill-agent";
db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
db.insertSession({
  id: SESSION_ID, projectId: projId, agentId, engineSessionId: "eng-excerptspill", title: null, cwd: "C:/f",
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager",
});

// 900 interleaved lines, 300 each of KEEP/DROP/SPARE — each line ~110 chars, so:
//   - the FULL body is ~99,000 chars (comfortably over the 48,000 budget)
//   - a bodyGrep for "KEEP-" alone (300 matching lines, ~33,000 chars) is UNDER budget on its own, so the
//     two KEEP lines are widened below; see the actual padding chosen to push EACH excerpt over budget too.
const PAD = "x".repeat(170);
const lines = [];
for (let i = 0; i < 300; i++) {
  lines.push(`KEEP-${i}-${PAD}`);
  lines.push(`DROP-${i}-${PAD}`);
  lines.push(`SPARE-${i}-${PAD}`);
}
const bigBody = lines.join("\n");
check("(setup) the full body exceeds the spill budget", bigBody.length > SPILL_INLINE_BUDGET_CHARS);
const keepLines = lines.filter((l) => l.startsWith("KEEP-")).join("\n");
check("(setup) the KEEP-only excerpt ALSO exceeds the spill budget", keepLines.length > SPILL_INLINE_BUDGET_CHARS);
const dropLines = lines.filter((l) => l.startsWith("DROP-")).join("\n");
check("(setup) the DROP-only excerpt ALSO exceeds the spill budget", dropLines.length > SPILL_INLINE_BUDGET_CHARS);

const TASK = "excerptspill-task";
const TITLE = "Big Card For Excerpt Spill Keys";
db.insertTask({ id: TASK, projectId: projId, title: TITLE, body: bigBody, columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

try {
  const server = new TaskMcpRouter(db, wakes).buildServer(projId, SESSION_ID);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "tasks-get-excerpt-spill-key-test", version: "0" });
  await client.connect(clientT);
  const call = async (args) => JSON.parse((await client.callTool({ name: "tasks_get", arguments: args })).content[0].text);

  // ═══════════════════════════ (1) plain (unexcerpted) read — spills as before ═══════════════════════════
  const plain1 = await call({ id: TASK });
  check("(1) plain read spills (bodyFile present, no inline body)", typeof plain1.bodyFile === "string" && !("body" in plain1));
  const expectedPlainText = `${TITLE}\n\n${bigBody}`;
  check("(1) plain read's spilled file is byte-identical to the full title+body text", fs.readFileSync(plain1.bodyFile, "utf8") === expectedPlainText);

  // ═══════════════════════════ (2) bodyGrep excerpt — spills to a DIFFERENT file ═══════════════════════════
  const keepExcerpt = await call({ id: TASK, bodyGrep: "KEEP-" });
  check("(2) the KEEP excerpt also spills (it exceeds budget too)", typeof keepExcerpt.bodyFile === "string" && !("body" in keepExcerpt));
  check(
    "(2) THE FIX: the excerpt spills to a DIFFERENT file than the plain read — under the OLD shared " +
    "key (just the task id) these would be the SAME file",
    keepExcerpt.bodyFile !== plain1.bodyFile,
  );

  // ═══════════════════════════ (3) THE COLLISION, directly: the plain file survives untouched ═══════════════
  const plainFileAfterExcerpt = fs.readFileSync(plain1.bodyFile, "utf8");
  check(
    "(3) THE BUG, directly: after the excerpt call ran, the PLAIN read's own spilled file is STILL the " +
    "full, unexcerpted text — it was not silently overwritten by the excerpt's different content",
    plainFileAfterExcerpt === expectedPlainText,
  );

  // ═══════════════════════════ (4) the excerpt's own file holds ONLY the matching lines ═══════════════════
  const expectedKeepText = `${TITLE}\n\n${keepLines}`;
  check("(4) the excerpt's spilled file is byte-identical to its OWN (excerpted) text, not the full body", fs.readFileSync(keepExcerpt.bodyFile, "utf8") === expectedKeepText);
  check("(4) the excerpt's spilled file does NOT contain any DROP/SPARE lines", !fs.readFileSync(keepExcerpt.bodyFile, "utf8").includes("DROP-") && !fs.readFileSync(keepExcerpt.bodyFile, "utf8").includes("SPARE-"));

  // ═══════════════════════ (5) a SECOND, different excerpt gets its OWN third file ═══════════════════════
  const dropExcerpt = await call({ id: TASK, bodyGrep: "DROP-" });
  check("(5) the DROP excerpt also spills", typeof dropExcerpt.bodyFile === "string" && !("body" in dropExcerpt));
  check("(5) the DROP excerpt's file differs from the plain read's file", dropExcerpt.bodyFile !== plain1.bodyFile);
  check("(5) the DROP excerpt's file differs from the KEEP excerpt's file (two different excerpt options never collide)", dropExcerpt.bodyFile !== keepExcerpt.bodyFile);
  const expectedDropText = `${TITLE}\n\n${dropLines}`;
  check("(5) the DROP excerpt's spilled file is byte-identical to its OWN text", fs.readFileSync(dropExcerpt.bodyFile, "utf8") === expectedDropText);
  // Re-confirm (3) once more: a THIRD spill (the DROP excerpt) still must not disturb the plain file either.
  check("(5) the plain read's file is STILL untouched after a second, different excerpt call", fs.readFileSync(plain1.bodyFile, "utf8") === expectedPlainText);

  // ═══════════════════ (6) a repeat PLAIN read re-uses the SAME key — unchanged behavior ═══════════════════
  const plain2 = await call({ id: TASK });
  check("(6) a repeat plain read re-uses the SAME deterministic scratch path as the first plain read (no accumulation)", plain2.bodyFile === plain1.bodyFile);

  await client.close();
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — tasks_get's bodyGrep/bodySlice excerpt spill now keys off the excerpt options as well as the task id, so an excerpted spill and a plain full-body spill of the SAME oversized task (and two different excerpt options of it) land on genuinely different scratch files instead of silently overwriting each other; a repeat plain read still re-uses its original key unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
