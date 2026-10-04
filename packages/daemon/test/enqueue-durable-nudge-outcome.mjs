import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a21f5c9e — direct unit coverage of the REAL `SessionService.enqueueDurableNudge` against a
// fake-but-faithful `PtyHost` stub (never a bare-stubbed `onOutcome`, unlike
// webhook-enqueue-durable-nudge.mjs's own Part 1, which stubs `enqueueDurableNudge` itself rather than
// exercising it). HERMETIC, no real claude, no network.
//
//   (1) an MCP-mounting role's deferred dispatch, with the fake host's `enqueueStdin` reporting a
//       "dropped" deliveryState and `db.appendEvent` SUCCEEDING: `onOutcome` fires `dispatched:true`, and
//       the durable `session_message_queued` row is KEPT — `enqueueDurableMessage` persists it regardless
//       of deliveryState (decision a21f5c9e Part 1's load-bearing reframing).
//   (1b) ROUND 3 FIX (card a21f5c9e Round 3, must be RED on 31085e65): "dropped" + `db.appendEvent` ALSO
//       throws — for "dropped" that write is the ONLY effect, so this is a genuine TOTAL LOSS. Round 2's
//       blanket swallow reported this as `dispatched:true`, keeping a webhook caller's dedupe row forever
//       on a delivery that is actually gone. Fixed via a typed `PostEffectPersistError` whose `landed` is
//       false for "dropped" — `onOutcome` must report `dispatched:false`. A second check then simulates
//       (by construction, off that SAME dispatched:false — not independent evidence) what a caller
//       following `fireWebhookTarget`'s own reject-on-dispatched:false contract would do with it: undo
//       its dedupe row. No real webhook endpoint is spun up here.
//   (2) `pty.enqueueStdin` ITSELF throwing — nothing ever landed — reports `dispatched:false` and leaves
//       NO durable row, on both the sync (non-MCP role) and deferred (MCP role) paths.
//   (3) THE DOUBLE-FIRE-EDGE FIX (kept from Round 2, now implemented via `PostEffectPersistError.landed`):
//       `pty.enqueueStdin` succeeds with a "queued" deliveryState (held), but the durability bookkeeping
//       write (`db.appendEvent`) throws AFTERWARD — `onOutcome` still reports `dispatched:true` (the
//       enqueue itself landed in the pty's FIFO regardless), never a false `dispatched:false` that would
//       make a caller like webhooks/ingress.ts undo a dedupe row for a delivery that is actually live.
//   (4) `onOutcome` fires EXACTLY ONCE on both the sync and deferred paths, even when the callback ITSELF
//       throws — never a second, defensive re-fire, and never an unhandled rejection.
//   (5) ROUND 3 item (c): a NON-NUDGE caller (`enqueueSystemNudge`, a public wrapper around the same
//       private `enqueueDurableMessage`) still sees a plain throw when the durability write fails — only
//       `enqueueDurableNudge`'s own `dispatch()` catch special-cases `PostEffectPersistError`; every other
//       caller (this one, `carryPendingToSuccessor`, `handleGiveUpExhausted`, ~30 total) is unaffected by
//       Round 2 or Round 3 and behaves exactly as it did before either ever existed. The real end-to-end
//       shape for `carryPendingToSuccessor` specifically (a recycle whose re-mint throws keeps the OLD
//       record unresolved and re-arms it) is already covered by
//       `carry-pending-to-successor-mint-then-resolve.mjs` and
//       `post-spawn-bookkeeping-best-effort.mjs`'s scenario (H) — re-run as part of this card's own
//       verification, not duplicated here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-edn-outcome-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

const flush = () => new Promise((r) => setTimeout(r, 0));

// Faithful-enough fake host: `waitForMcpSeen` NEVER rejects (mirrors the real contract, pty/host.ts),
// resolving per-id on a controllable timer; `enqueueStdin` returns (or throws) whatever this scenario
// configured. `hasAmbiguousMatch` omitted deliberately — `enqueueDurableMessage`'s own `typeof` guard
// degrades that to the pre-card self-rooting behavior for a stub that doesn't implement it (expected,
// logged once via console.warn, never console.error — doesn't interfere with this suite's own
// console.error-based assertions).
class PtyStub {
  constructor() {
    this.enqueueCalls = [];
    this.enqueueStdinImpl = () => ({ delivered: true });
  }
  waitForMcpSeen() { return Promise.resolve(true); }
  enqueueStdin(id, text, source, onDeliver, route, kind, ...rest) {
    this.enqueueCalls.push({ id, text, source, route, kind });
    return this.enqueueStdinImpl(id, text, source, onDeliver, route, kind, ...rest);
  }
}

const db = new Db();
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const proj = `edo-proj-${sfx}`, agent = `edo-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (id, role) => db.insertSession({
  id, projectId: proj, agentId: agent, engineSessionId: `eng-${id}`, title: null, cwd: os.tmpdir(),
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role,
});
const undeliveredFor = (recipientId, msgId) =>
  db.listUndeliveredQueuedMessages().filter((e) => e.workerSessionId === recipientId && e.detail?.msgId === msgId);

try {
  // ===== (1) MCP role, deferred path: enqueueStdin reports "dropped" -> dispatched:true, row KEPT =====
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const recip = `edo-1-recip-${sfx}`;
    mkSession(recip, "manager");
    pty.enqueueStdinImpl = () => ({ delivered: false, deliveryState: "dropped", reason: "session-dead" });

    const outcomes = [];
    sessions.enqueueDurableNudge(recip, "manager", "EDO_ONE_TEXT", null, { kind: "agent", onOutcome: (o) => outcomes.push(o) });
    await flush();

    check("(1) onOutcome fired exactly once", outcomes.length === 1);
    check("(1) dispatched:true even though the underlying deliveryState is 'dropped'", outcomes[0]?.dispatched === true);
    const msgId = outcomes[0]?.result?.msgId;
    check("(1) the result carries a real msgId", typeof msgId === "string" && msgId.length > 0);
    check("(1) the durable session_message_queued row was KEPT (enqueueDurableMessage records on !delivered regardless of deliveryState)",
      undeliveredFor(recip, msgId).length === 1);
  }

  // ===== (1b) THE ROUND 3 FIX: "dropped" + db.appendEvent ALSO throws -> TOTAL LOSS -> dispatched:false,
  // and (mirroring fireWebhookTarget's own reject-on-dispatched:false contract) a webhook-shaped caller's
  // dedupe row is undone. Must be RED on 31085e65 (Round 2's blanket swallow reported this dispatched:true,
  // keeping the dedupe row forever on a genuinely lost delivery). =====
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const recip = `edo-1b-recip-${sfx}`;
    mkSession(recip, "manager");
    pty.enqueueStdinImpl = () => ({ delivered: false, deliveryState: "dropped", reason: "session-dead" });

    const originalAppendEvent = db.appendEvent.bind(db);
    db.appendEvent = () => { throw new Error("simulated: db.appendEvent threw — NOTHING survives (dropped + failed persist = total loss)"); };
    try {
      const outcomes = [];
      let dedupeRowUndone = false; // stands in for the webhook ingress's own dedupe-row-undo side effect
      await new Promise((resolve, reject) => {
        sessions.enqueueDurableNudge(recip, "manager", "EDO_ONE_B_TEXT", null, {
          kind: "agent",
          onOutcome: (o) => {
            outcomes.push(o);
            // Mirrors fireWebhookTarget's OWN contract exactly (webhooks/ingress.ts): reject on
            // dispatched:false so the caller's .catch() undoes the dedupe row.
            if (o.dispatched) resolve(); else reject(new Error("not dispatched"));
          },
        });
      }).catch(() => { dedupeRowUndone = true; });

      check("(1b) onOutcome fired exactly once", outcomes.length === 1);
      check("(1b) THE FIX: dispatched:false for a TOTAL LOSS (dropped + appendEvent also failed)", outcomes[0]?.dispatched === false);
      check("(1b) CONTRACT SIMULATION (by construction, not independent evidence — the local .catch sets this directly off the SAME dispatched:false checked above): IF a caller follows fireWebhookTarget's own reject-on-dispatched:false contract, this dispatched:false would undo its dedupe row",
        dedupeRowUndone === true);
    } finally {
      db.appendEvent = originalAppendEvent;
    }
  }

  // ===== (2a) pty.enqueueStdin itself throws, SYNC path (non-MCP role) -> dispatched:false, no row =====
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const recip = `edo-2a-recip-${sfx}`;
    mkSession(recip, null); // usesOrchestrationMcp(null) === false -> sync dispatch
    pty.enqueueStdinImpl = () => { throw new Error("simulated: enqueueStdin itself threw (nothing landed)"); };

    const before = db.listUndeliveredQueuedMessages().length;
    const outcomes = [];
    sessions.enqueueDurableNudge(recip, null, "EDO_TWO_A_TEXT", null, { kind: "agent", onOutcome: (o) => outcomes.push(o) });

    check("(2a) onOutcome fired exactly once (sync path)", outcomes.length === 1);
    check("(2a) dispatched:false (nothing ever landed)", outcomes[0]?.dispatched === false);
    check("(2a) no durable row was created (there was nothing to make durable)", db.listUndeliveredQueuedMessages().length === before);
  }

  // ===== (2b) pty.enqueueStdin itself throws, DEFERRED path (MCP role) -> dispatched:false, no row =====
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const recip = `edo-2b-recip-${sfx}`;
    mkSession(recip, "worker"); // usesOrchestrationMcp("worker") === true -> deferred via waitForMcpSeen
    pty.enqueueStdinImpl = () => { throw new Error("simulated: enqueueStdin itself threw (nothing landed)"); };

    const before = db.listUndeliveredQueuedMessages().length;
    const outcomes = [];
    sessions.enqueueDurableNudge(recip, "worker", "EDO_TWO_B_TEXT", null, { kind: "agent", onOutcome: (o) => outcomes.push(o) });
    await flush();

    check("(2b) onOutcome fired exactly once (deferred path)", outcomes.length === 1);
    check("(2b) dispatched:false (nothing ever landed)", outcomes[0]?.dispatched === false);
    check("(2b) no durable row was created (there was nothing to make durable)", db.listUndeliveredQueuedMessages().length === before);
  }

  // ===== (3) THE DOUBLE-FIRE-EDGE FIX: enqueueStdin SUCCEEDS (held) but the post-effect durability write
  // (db.appendEvent) throws afterward -> onOutcome must still report dispatched:true (the enqueue itself
  // landed), never a false dispatched:false that would make a caller undo an already-live delivery =====
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const recip = `edo-3-recip-${sfx}`;
    mkSession(recip, "manager");
    // A held/queued outcome (!delivered) is what drives enqueueDurableMessage into its `db.appendEvent`
    // branch — the step whose failure `enqueueDurableMessage` now reports via a typed
    // `PostEffectPersistError` (card a21f5c9e Round 3), which `enqueueDurableNudge`'s dispatch() catch
    // then inspects (`landed`) to still report `dispatched:true`.
    pty.enqueueStdinImpl = () => ({ delivered: false, deliveryState: "queued", position: 1 });

    const originalAppendEvent = db.appendEvent.bind(db);
    let appendEventCalls = 0;
    db.appendEvent = (evt) => {
      appendEventCalls++;
      throw new Error("simulated: db.appendEvent threw (e.g. SQLITE_BUSY) AFTER the real effect already landed");
    };
    const originalWarn = console.warn;
    const warnLines = [];
    console.warn = (...args) => { warnLines.push(args.join(" ")); };
    try {
      const outcomes = [];
      sessions.enqueueDurableNudge(recip, "manager", "EDO_THREE_TEXT", null, { kind: "agent", onOutcome: (o) => outcomes.push(o) });
      await flush();

      check("(3) db.appendEvent was actually exercised (the scenario is real, not vacuous)", appendEventCalls === 1);
      check("(3) onOutcome fired exactly once", outcomes.length === 1);
      check("(3) THE FIX: dispatched:true despite the post-effect durability write throwing (the enqueue itself landed)",
        outcomes[0]?.dispatched === true);
      check("(3) the landed-but-failed-persist case was logged (never silently swallowed)",
        warnLines.some((l) => l.includes("landed") && l.includes("durability write failed")));
    } finally {
      console.warn = originalWarn;
      db.appendEvent = originalAppendEvent;
    }
  }

  // ===== (4a) onOutcome fires EXACTLY ONCE even when it itself throws — SYNC path =====
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const recip = `edo-4a-recip-${sfx}`;
    mkSession(recip, null);
    pty.enqueueStdinImpl = () => ({ delivered: true });

    let calls = 0;
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      sessions.enqueueDurableNudge(recip, null, "EDO_FOUR_A_TEXT", null, {
        kind: "agent",
        onOutcome: () => { calls++; throw new Error("simulated: onOutcome itself throws"); },
      });
      await flush();
      check("(4a) a throwing onOutcome is still invoked exactly once (sync path)", calls === 1);
      check("(4a) no unhandled rejection surfaced", unhandled.length === 0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }

  // ===== (4b) onOutcome fires EXACTLY ONCE even when it itself throws — DEFERRED path =====
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const recip = `edo-4b-recip-${sfx}`;
    mkSession(recip, "manager");
    pty.enqueueStdinImpl = () => ({ delivered: true });

    let calls = 0;
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      sessions.enqueueDurableNudge(recip, "manager", "EDO_FOUR_B_TEXT", null, {
        kind: "agent",
        onOutcome: () => { calls++; throw new Error("simulated: onOutcome itself throws"); },
      });
      await flush();
      check("(4b) a throwing onOutcome is still invoked exactly once (deferred path)", calls === 1);
      check("(4b) no unhandled rejection surfaced", unhandled.length === 0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }

  // ===== (5) ROUND 3 item (c): a NON-NUDGE caller still sees the throw — only enqueueDurableNudge's own
  // dispatch() catch special-cases PostEffectPersistError; enqueueSystemNudge (a public, non-nudge wrapper
  // around the SAME private enqueueDurableMessage) must see a plain throw, exactly as before Round 2 ever
  // existed. (The real end-to-end carryPendingToSuccessor shape is covered by
  // carry-pending-to-successor-mint-then-resolve.mjs / post-spawn-bookkeeping-best-effort.mjs — see this
  // file's own header comment.) =====
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const recip = `edo-5-recip-${sfx}`;
    mkSession(recip, "manager");
    // A held/queued outcome drives enqueueDurableMessage into its db.appendEvent branch — same trigger
    // shape as (1b)/(3) above, just observed through a different, non-nudge caller this time.
    pty.enqueueStdinImpl = () => ({ delivered: false, deliveryState: "queued", position: 1 });

    const originalAppendEvent = db.appendEvent.bind(db);
    db.appendEvent = () => { throw new Error("simulated: db.appendEvent threw"); };
    try {
      let thrown;
      try {
        sessions.enqueueSystemNudge(recip, "EDO_FIVE_TEXT", { kind: "agent" });
      } catch (e) { thrown = e; }
      check("(5) a non-nudge caller (enqueueSystemNudge) STILL sees the throw propagate — never swallowed", thrown instanceof Error);
    } finally {
      db.appendEvent = originalAppendEvent;
    }
  }
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — SessionService.enqueueDurableNudge: a 'dropped' deliveryState whose durability write SUCCEEDS still keeps its durable row (dispatched:true); a 'dropped' delivery whose durability write ALSO throws is a genuine total loss and correctly reports dispatched:false, undoing a webhook-shaped caller's dedupe row (card a21f5c9e Round 3's fix — Round 2's blanket swallow got this backwards); pty.enqueueStdin itself throwing (nothing landed) reports dispatched:false with no row, on both the sync and MCP-deferred paths; a 'queued' delivery's post-effect db.appendEvent write throwing AFTER a real landed enqueue still reports dispatched:true (the double-fire-edge fix, now via a typed PostEffectPersistError.landed); onOutcome fires EXACTLY once on every path, even when the callback itself throws, with no unhandled rejection; and a non-nudge caller (enqueueSystemNudge) still sees a plain throw, exactly as before Round 2 ever existed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
