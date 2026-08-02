import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 085d9422 — the [loom:redelivery-parked] notice fires when MOOT, duplicates itself, and spends
// ~1.1KB per copy on invariant boilerplate. Owner-directed: "I find the redelivery messages too frequent
// and verbose. Too much context usage." NO claude, NO live daemon, NO process.exit.
//
// ROOT CAUSE ESTABLISHED (this card's own investigation, NOT the card's leading hypothesis): the notice's
// OWN re-mint/recursion machinery is safe (give-up-exhausted-durable.mjs scenario (7) already proves the
// "system" sentinel terminates it with zero follow-on dispatch). The REAL duplication mechanism is
// `enqueueDurableMessage`'s auto-join (`hasAmbiguousMatch`, card 4a0af485): a SECOND, independent
// dispatch of matching content joins an EXISTING chain's rootMsgId label, but each dispatch still runs
// its OWN independent chainDepth counter and can reach PARK entirely on its own — two independently-
// parking chains sharing one rootMsgId produce two BYTE-IDENTICAL notices, neither carrying a
// possible-duplicate tag (each is a fresh, self-rooted send to the sender, not a re-mint of the other).
//
// THE FIX: `SessionService.suppressMootParkNotice` (sessions/service.ts), checked at the PARK site before
// the notice is built (never before the durable `session_message_gave_up outcome:"parked"` event, which
// is ALWAYS recorded regardless):
//   (1) a PRIOR parked event for the SAME rootMsgId already exists (the auto-join double-park above),
//   (2) a NEWER, genuinely-different directive from the same sender to the same recipient already
//       superseded this one (resolved via each directive's EFFECTIVE root, not its raw msgId — see the
//       method's own doc for the false-positive this card's own reproduction caught: comparing raw
//       msgIds would wrongly treat an auto-joined RESEND of the SAME chain as "a different directive"),
//   (3) a `confirmed-after-park` event for the same root already landed (a narrow race).
//
// This suite proves, via the SAME contract-faithful PtyStub pattern give-up-exhausted-durable.mjs uses
// (extended with a REAL `hasAmbiguousMatch` — the dual bare/tagged check `pty/host.ts` actually
// implements, imported directly rather than reproduced by hand):
//   (1) THE FIX: an auto-joined resend that ALSO wedges produces exactly ONE [loom:redelivery-parked]
//       notice, not two — the second park is suppressed, tagged `noticeSuppressed:true` in its own
//       durable event (never silently dropped from the audit trail).
//   (2) THE LOAD-BEARING NEGATIVE CONTROL: a single, non-auto-joined message that genuinely wedges (no
//       resend, no prior park for this root) STILL gets its notice — suppression never silences a
//       genuinely lost message.
//   (3) SUPERSEDED: a genuinely DIFFERENT, later directive to the same recipient (no auto-join — distinct
//       content) suppresses the ORIGINAL's park as superseded, while the newer directive's OWN eventual
//       park (if it too wedges) still fires normally — proving the false-positive this card's own
//       investigation caught (an auto-joined resend wrongly read as "a different directive") is fixed by
//       resolving effective roots, not raw msgIds.
//   (4) SHORTENED: the notice no longer inlines the resend-join caveats/confirmation hedge; the relocated
//       content is verified present in mcp/orchestration.ts's worker_message/worker_list descriptions.
//
// Run: 1) build daemon (pnpm build from packages/daemon), 2) node test/redelivery-parked-notice-suppression.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-park-notice-suppression-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_GIVE_UP_REMINT_LIMIT = "2";
const REMINT_LIMIT = 2;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { framePossibleDuplicate } = await import("../dist/pty/host.js");

const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// PtyStub mirrors give-up-exhausted-durable.mjs's own stub, PLUS a REAL hasAmbiguousMatch (the same
// bare/tagged dual check pty/host.ts implements, imported not reproduced) — a plain Map, no TTL/cap,
// since this suite only needs one ambiguous window to stay open across two calls at a time.
class PtyStub {
  constructor() { this.q = new Map(); this.live = new Set(); this.busy = new Set(); this.sent = []; this.ambiguous = new Map(); }
  setLive(id, on = true) { if (on) this.live.add(id); else this.live.delete(id); }
  setBusy(id, on = true) { if (on) this.busy.add(id); else this.busy.delete(id); }
  hasAmbiguousMatch(_id, text) {
    for (const [logicalId, storedText] of this.ambiguous) {
      if (storedText === text || storedText === framePossibleDuplicate(text, logicalId)) return logicalId;
    }
    return null;
  }
  enqueueStdin(id, text, _source = "system", onDeliver, _route, _kind, _questionId, _ownerText, _proactive, _senderId, tail) {
    const isTailObject = typeof tail === "object" && tail !== null;
    const giveUpHeldUntil = isTailObject ? tail.giveUpHeldUntil : tail;
    const onGiveUpExhausted = isTailObject ? tail.onGiveUpExhausted : undefined;
    const logicalId = isTailObject ? tail.logicalId : undefined;
    this.sent.push({ id, text });
    if (logicalId) this.ambiguous.set(logicalId, text);
    if (!this.live.has(id)) return { delivered: false, reason: "session-dead", queued: false };
    const stillGiveUpHeld = giveUpHeldUntil !== undefined && Date.now() < giveUpHeldUntil;
    if (!this.busy.has(id) && !stillGiveUpHeld) return { delivered: true };
    const a = this.q.get(id) ?? []; a.push({ text, onDeliver, onGiveUpExhausted }); this.q.set(id, a);
    return { delivered: false, position: a.length, queued: true, landsAt: "next-turn-boundary" };
  }
  giveUpOn(id) {
    this.busy.delete(id);
    const a = this.q.get(id) ?? []; const m = a.shift();
    if (!m) return undefined;
    if (m.onDeliver) m.onDeliver();
    if (m.onGiveUpExhausted) m.onGiveUpExhausted();
    return m.text;
  }
  getPending(id) { return (this.q.get(id) ?? []).map((m) => m.text); }
  getPersistablePendingSnapshot(id) { return { texts: (this.q.get(id) ?? []).filter((m) => !m.onDeliver).map((m) => m.text), holds: {} }; }
  waitForMcpSeen() { return Promise.resolve(true); }
}

const db = new Db();
const proj = `pns-proj-${sfx}`, agent = `pns-ag-${sfx}`;
db.insertProject({ id: proj, name: proj, repoPath: os.tmpdir(), vaultPath: os.tmpdir(), config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agent, projectId: proj, name: "t", startupPrompt: "", position: 0 });
const mkSession = (o) => db.insertSession({
  id: o.id, projectId: proj, agentId: agent, engineSessionId: `eng-${o.id}`, title: null, cwd: os.tmpdir(),
  processState: o.processState ?? "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: o.role ?? null, parentSessionId: o.parentSessionId ?? null, taskId: o.taskId ?? null,
  worktreePath: null, branch: null, recycledFrom: o.recycledFrom ?? null,
});
const gaveUpEventsFor = (recipientId) => db.listEventsForWorker(recipientId).filter((e) => e.kind === "session_message_gave_up");

try {
  // ===== (1) THE FIX: an auto-joined resend that ALSO wedges produces exactly ONE parked notice ==========
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `pns-a-mgr-${sfx}`, wkr = `pns-a-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr); pty.setBusy(mgr, false);

    sessions.messageWorker(mgr, wkr, "SAME_CONTENT_TWICE");
    pty.giveUpOn(wkr); pty.setBusy(wkr); // call A gives up once (chainDepth 0->1), worker STAYS wedged
    sessions.messageWorker(mgr, wkr, "SAME_CONTENT_TWICE"); // call B: independent dispatch, same content
    check("(1) setup: call B auto-joined call A's rootMsgId", pty.ambiguous.size === 1);
    for (let i = 0; i < 6; i++) { pty.giveUpOn(wkr); pty.setBusy(wkr); } // exhaust BOTH chains to PARK

    const mgrSent = pty.sent.filter((s) => s.id === mgr).map((s) => s.text);
    const parkedNotices = mgrSent.filter((t) => t.includes("[loom:redelivery-parked]"));
    check("(1) THE FIX: exactly ONE notice reached the sender, not two", parkedNotices.length === 1);

    const parkedEvents = gaveUpEventsFor(wkr).filter((e) => e.detail?.outcome === "parked");
    check("(1) BOTH chains still recorded their OWN parked event (audit trail complete, nothing silently dropped)", parkedEvents.length === 2);
    check("(1) exactly ONE of the two parked events is marked noticeSuppressed:true",
      parkedEvents.filter((e) => e.detail?.noticeSuppressed === true).length === 1);
    check("(1) the suppressed one carries reason 'duplicate-parked'",
      parkedEvents.find((e) => e.detail?.noticeSuppressed === true)?.detail?.noticeSuppressedReason === "duplicate-parked");
  }

  // ===== (2) THE LOAD-BEARING NEGATIVE CONTROL: a single, genuinely-wedged message (no resend, no prior ===
  // ===== park for this root) STILL gets its notice — suppression never silences a real loss =============
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `pns-b-mgr-${sfx}`, wkr = `pns-b-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr); pty.setBusy(mgr, false);

    sessions.messageWorker(mgr, wkr, "NEVER_LANDS_STAYS_WEDGED_ALONE");
    for (let i = 0; i <= REMINT_LIMIT; i++) { pty.giveUpOn(wkr); pty.setBusy(wkr); }

    const mgrSent = pty.sent.filter((s) => s.id === mgr).map((s) => s.text);
    const parkedNotices = mgrSent.filter((t) => t.includes("[loom:redelivery-parked]"));
    check("(2) NEGATIVE CONTROL: a genuinely lost message (no dup, no supersede) IS still reported", parkedNotices.length === 1);
    const parkedEvt = gaveUpEventsFor(wkr).find((e) => e.detail?.outcome === "parked");
    check("(2) NEGATIVE CONTROL: its own event is NOT marked suppressed", parkedEvt?.detail?.noticeSuppressed !== true);
  }

  // ===== (3) SUPERSEDED: a genuinely DIFFERENT, later directive (no auto-join) suppresses the ORIGINAL's ===
  // ===== park; the newer directive's OWN eventual park still fires — proves effective-root resolution =====
  // ===== fixes the false positive this card's own investigation caught (raw msgId comparison would have ===
  // ===== wrongly treated an auto-joined RESEND as "a different directive" too) ============================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `pns-c-mgr-${sfx}`, wkr = `pns-c-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr); pty.setBusy(mgr, false);

    sessions.messageWorker(mgr, wkr, "ORIGINAL_DIRECTIVE_GOES_STALE");
    pty.giveUpOn(wkr); pty.setBusy(wkr); // original gives up once (chainDepth 0->1), worker STAYS wedged
    sessions.messageWorker(mgr, wkr, "COMPLETELY_DIFFERENT_NEWER_DIRECTIVE"); // genuinely different content — no auto-join
    check("(3) setup: the newer directive did NOT auto-join (distinct content, distinct root)", pty.ambiguous.size === 2);
    for (let i = 0; i < 6; i++) { pty.giveUpOn(wkr); pty.setBusy(wkr); } // exhaust BOTH chains to PARK

    const mgrSent = pty.sent.filter((s) => s.id === mgr).map((s) => s.text);
    const parkedNotices = mgrSent.filter((t) => t.includes("[loom:redelivery-parked]"));
    check("(3) SUPERSEDED: exactly ONE notice reached the sender (for the NEWER directive)", parkedNotices.length === 1);
    check("(3) SUPERSEDED: the ONE notice that fired is about the NEWER content, not the stale original",
      parkedNotices[0]?.includes("COMPLETELY_DIFFERENT_NEWER_DIRECTIVE"));

    const parkedEvents = gaveUpEventsFor(wkr).filter((e) => e.detail?.outcome === "parked");
    check("(3) BOTH chains still recorded their OWN parked event", parkedEvents.length === 2);
    const suppressed = parkedEvents.find((e) => e.detail?.noticeSuppressed === true);
    check("(3) the ORIGINAL (stale) directive's park is the one suppressed, reason superseded-by-newer-directive",
      !!suppressed && suppressed.detail?.noticeSuppressedReason === "superseded-by-newer-directive");
  }

  // ===== (4) SHORTENED: the relocated invariant text is GONE from the notice, and PRESENT in the tool ======
  // ===== descriptions it was relocated to (mcp/orchestration.ts) ============================================
  {
    const pty = new PtyStub();
    const sessions = new SessionService(db, pty, new OrchestrationControl());
    const mgr = `pns-d-mgr-${sfx}`, wkr = `pns-d-wkr-${sfx}`;
    mkSession({ id: mgr, role: "manager" });
    mkSession({ id: wkr, role: "worker", parentSessionId: mgr });
    pty.setLive(mgr); pty.setLive(wkr); pty.setBusy(wkr); pty.setBusy(mgr, false);

    sessions.messageWorker(mgr, wkr, "SHORTENED_NOTICE_CHECK");
    for (let i = 0; i <= REMINT_LIMIT; i++) { pty.giveUpOn(wkr); pty.setBusy(wkr); }
    const note = pty.sent.filter((s) => s.id === mgr).map((s) => s.text).find((t) => t.includes("[loom:redelivery-parked]"));
    check("(4) setup: got the notice", !!note);
    check("(4) SHORTENED: the resend-join caveat (a)/(b) prose is GONE from the notice body", !!note && !/embeds YOUR OWN session id/.test(note));
    check("(4) SHORTENED: the inline three-state confirmation hedge prose is GONE from the notice body", !!note && !/Loom MAY follow up with a \[loom:redelivery-confirmed\]/.test(note));
    check("(4) SHORTENED: a pointer to worker_message's own docs replaces it", !!note && /worker_message.*resend/i.test(note));
    // Card 417cea0a's own honesty split (canCheckRecipient) is exercised — not re-tested — by
    // give-up-exhausted-durable.mjs's own PEER SENDER case (8), which asserts "worker_list" is ABSENT for
    // a sender who can't act on it; this test's recipient IS the sender's own worker (canCheckRecipient
    // true), so `recipientCheckClause` legitimately naming worker_list here is correct, not a regression.
    console.log(`\n--- (4) new notice length: ${note?.length} chars ---\n${note}\n`);

    const orchSrc = fs.readFileSync(path.join(fileURLToPath(new URL("../src/mcp/orchestration.ts", import.meta.url))), "utf8");
    check("(4) RELOCATED: worker_message's description now carries resend-join caveat (a)", orchSrc.includes("embeds YOUR OWN session id"));
    check("(4) RELOCATED: worker_message's description now carries resend-join caveat (b)", orchSrc.includes("join window closes the instant Loom itself confirms"));
    check("(4) RELOCATED: worker_list's parkedDirective doc now carries the three-state hedge", orchSrc.includes("is NOT proof the directive was never received"));
    check("(4) RELOCATED: both relocations cite this card", (orchSrc.match(/card 085d9422/g) ?? []).length >= 2);
  }

  db.close();
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a moot [loom:redelivery-parked] notice (duplicate-park via auto-join, or superseded by a genuinely newer directive) is suppressed while its audit event is still recorded; a genuinely lost message is still reported at the same latency as before; and the relocated invariant boilerplate is verifiably present where it was moved to."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
