import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// run_gate STALE-ATTACH ADDRESSED DIRECTIVE (card cfd11b13, SUPERSEDED for the primary re-attach path by
// card a0d912f5): a live specimen (worker `684ff2c2`) fired `run_gate`, re-attached to a still-running
// earlier op that predated its own new commit, and correctly read `staleAgainstWorktree:true` — declining
// to trust the attached result. But the ONLY thing the result told it was that its worktree had moved;
// nothing named the remedy, so its only stated plan was to WAIT for the stale op to settle on its own —
// holding one of only two daemon-global gate lanes for ~18 minutes.
//
// Card cfd11b13's fix named a remedy but pointed it at the MANAGER ("you cannot cancel this yourself, your
// manager can"), because a worker had no `gate_cancel` of its own at the time. Card a0d912f5 closed BOTH
// gaps: (1) `gate_cancel` is now on the WORKER's own tool surface, and (2) a plain re-attach to an
// ALREADY-known-stale op is now REFUSED outright by `runWorkerGate` itself (before ever attaching) —
// {refused:true} — rather than silently attaching and merely flagging it after the fact. The refused shape
// is now the PRIMARY case a real worker hits; the older "attached, staleAgainstWorktree:true, no refused
// flag" shape this file originally tested is STILL a real, reachable outcome (the ORIGINATING call's own
// post-hoc staleness check, or an explicit `force:true` re-attach — see runWorkerGate's own doc) — kept
// below, with UPDATED wording proving the worker is now told it can cancel the op ITSELF.
//
// This file positive/negative-controls the exact `run_gate` MCP tool result text (`mcp/orchestration.ts`'s
// `run_gate` handler), NOT SessionService.runWorkerGate itself (already covered elsewhere, e.g.
// run-gate-result-consumption.mjs) — `sessions.runWorkerGate` is stubbed here so each shape is driven
// directly and deterministically, with no real gate spawn.
//
// HERMETIC, NO daemon, NO claude: the REAL OrchestrationMcpRouter driven in-process over InMemoryTransport
// with role:"worker" — mirrors worker-report-recovery.mjs's harness shape.
//
// Asserts:
//   (REFUSED) the stub returns runWorkerGate's dedicated `{refused:true}` shape — the tool's response
//         carries {status:"refused", action:"stale-attached", canCancel:true, opId} and a `note` naming
//         gate_cancel(opId:"<exact opId>") with the real opId (never a placeholder).
//   (POS) the OLDER "attached, staleAgainstWorktree:true, no refused flag" shape (the originating call's
//         own post-hoc check, or an explicit force:true re-attach) — the `note` names (a) that the caller
//         CAN cancel it itself, quoting the exact opId (not a placeholder), and (b) to re-fire run_gate
//         once cancelled, or report progress/blocked if it would rather wait.
//   (NEG-1) an ordinary pending run_gate (staleAgainstWorktree:false) carries NONE of that directive text —
//           a directive that fires on every gate would be noise, strictly worse than the notice it
//           replaces.
//   (NEG-2) a fast, inline-SETTLED run_gate (no pending shape at all) carries no `note` field whatsoever.
// Run: 1) build daemon (pnpm build), 2) node test/run-gate-stale-directive.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const sandboxHome = mkdtempManaged("loom-rgsd-home-");
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
process.env.LOOM_HOME = path.join(sandboxHome, ".loom");
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");

const dbFile = path.join(os.tmpdir(), `loom-rgsd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);

// The REAL opId a stale-attach would carry — asserted verbatim in the note text below, never a
// placeholder, so a copy/paste-and-rename regression (e.g. hardcoding some other string) would be caught.
const REFUSED_OP_ID = "295587a9-dead-beef-cafe-000000000000";
const STALE_OP_ID = "295587a9-dead-beef-cafe-000000000001";
const FRESH_PENDING_OP_ID = "aaaaaaaa-bbbb-cccc-dddd-000000000002";

// One switchable stub: `mode` selects which of the runWorkerGate shapes the next call returns.
let mode = "refused";
const sessionsStub = {
  async runWorkerGate() {
    if (mode === "refused") {
      return { settled: false, refused: true, op: { opId: REFUSED_OP_ID }, attachedToInFlight: true, staleAgainstWorktree: true };
    }
    if (mode === "stale") {
      return { settled: false, op: { opId: STALE_OP_ID }, attachedToInFlight: true, staleAgainstWorktree: true };
    }
    if (mode === "pending-fresh") {
      return { settled: false, op: { opId: FRESH_PENDING_OP_ID }, attachedToInFlight: false, staleAgainstWorktree: false };
    }
    if (mode === "settled-pass") {
      return { settled: true, ok: true, value: { ran: true, passed: true, validatedHead: "deadbeef" } };
    }
    throw new Error(`unknown mode ${mode}`);
  },
};

const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
const server = router.buildServer("W1", "worker");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "run-gate-stale-directive-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async () => parse(await client.callTool({ name: "run_gate", arguments: {} }));

// ═══════════════════ (REFUSED) runWorkerGate's dedicated refused:true shape (card a0d912f5) ══════════════
mode = "refused";
const refused = await call();
check("(REFUSED) fixture sanity: opId round-trips the exact refused op's id", refused.opId === REFUSED_OP_ID);
check("(REFUSED) status is \"refused\"", refused.status === "refused");
check("(REFUSED) action is \"stale-attached\"", refused.action === "stale-attached");
check("(REFUSED) canCancel:true", refused.canCancel === true);
check("(REFUSED) note quotes the EXACT opId via gate_cancel (not a placeholder)",
  refused.note.includes(`gate_cancel(opId:"${REFUSED_OP_ID}")`));
check("(REFUSED) note names force:true as the explicit override", /force:true/i.test(refused.note));

// ═══════════════════════════════ (POS) staleAgainstWorktree:true — the addressed directive ═══════════════
// The OLDER shape: attached (attachedToInFlight:true) but WITHOUT runWorkerGate's own refused:true — only
// reachable in production via the ORIGINATING call's own post-hoc staleness check, or an explicit
// force:true re-attach (see runWorkerGate's own doc). Wording UPDATED by card a0d912f5: the worker now has
// its own gate_cancel, so the note tells it to cancel the op ITSELF, never "escalate to your manager".
mode = "stale";
const stale = await call();
check("(POS) fixture sanity: staleAgainstWorktree round-trips true", stale.staleAgainstWorktree === true);
check("(POS) fixture sanity: opId round-trips the exact stale op's id", stale.opId === STALE_OP_ID);
check("(POS) note does NOT say the caller cannot cancel it (that framing is retired)",
  !/you cannot cancel this op yourself/i.test(stale.note));
check("(POS) (a) names that the CALLER can cancel it itself, quoting the EXACT opId (not a placeholder)",
  /you can cancel it yourself/i.test(stale.note) && stale.note.includes(`gate_cancel(opId:"${STALE_OP_ID}")`));
check("(POS) (b) directs re-firing run_gate once cancelled, or reporting progress/blocked to wait instead",
  /re-fire run_gate/i.test(stale.note) && /worker_report progress\/blocked/i.test(stale.note));

// ═══════════════ (NEG-1) ordinary pending run_gate — NONE of the directive text fires ══════════════════
mode = "pending-fresh";
const freshPending = await call();
check("(NEG-1) fixture sanity: this really is the non-stale pending shape",
  freshPending.staleAgainstWorktree === false && freshPending.opId === FRESH_PENDING_OP_ID);
check("(NEG-1) note does NOT mention gate_cancel at all", !/gate_cancel/i.test(freshPending.note));
check("(NEG-1) note does NOT claim the caller cannot cancel anything", !/cannot cancel/i.test(freshPending.note));
check("(NEG-1) note does NOT tell the worker to report up now", !/report this up now/i.test(freshPending.note));
check("(NEG-1) note still carries the ordinary end-your-turn guidance", /END your turn/.test(freshPending.note));

// ═══════════════ (NEG-2) a fast inline-settled run_gate carries no `note` at all ════════════════════════
mode = "settled-pass";
const settled = await call();
check("(NEG-2) fixture sanity: this really is the settled shape (no pending fields)",
  settled.opId === undefined && settled.passed === true);
check("(NEG-2) no `note` field at all on a settled result", settled.note === undefined);

await client.close();

try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
// sandboxHome cleanup is handled by mkdtempManaged (registered at process exit, card 995be21f).

console.log(failures === 0
  ? "\n✅ ALL PASS — card a0d912f5: runWorkerGate's own refused:true shape surfaces as " +
    "{status:\"refused\",action:\"stale-attached\",canCancel:true} naming gate_cancel(opId:\"<opId>\") and " +
    "force:true; the older attached-but-not-refused shape now tells the worker it CAN cancel the op " +
    "itself (never 'escalate to your manager'); and an ordinary pending/settled run_gate carries none of " +
    "that directive text."
  : `\n❌ ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
