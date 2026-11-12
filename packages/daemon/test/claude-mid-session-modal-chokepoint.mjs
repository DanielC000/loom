// Card 20ff76de (round 4) — the STRUCTURAL invariant behind the mid-session modal hold: a past-boot,
// BOOT_DIALOG_DETECTOR_ROLES session with a hold OR a frozen modal candidate takes NO Loom-originated write
// (ptyWrite chokepoint), and a candidate is dropped only after its dismissal evidence has stood a settle window.
//   K) the two redraw shapes that wrote an Enter into a still-up modal in round 3 (erase-led redraw split across
//      chunks: dismissal-looking box first, the real modal frame next) — ZERO writes over a stable window, with the
//      requeue/drain hold shortened (LOOM_GIVE_UP_HOLD_MS) so a leaked drain WOULD land inside the window;
//   L) a chokepoint refusal for every write tag that can reach such a session + the exempt tags + human input;
//   M) the settle window: a genuine dismissal still releases after it (positive control), not before;
//   N) healIfStuck is skipped while held (a heal bumps the generation under the parked chain).
// Every "no write" negative runs through assertNeverWithControl with a positive control on the SAME predicate.
// RUN: pnpm build, then `node test/claude-mid-session-modal-chokepoint.mjs` from packages/daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { assertNeverWithControl, pollUntil } from "./_timing-guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const waitUntil = async (pred, timeoutMs) => {
  try {
    return await sharedWaitUntil(pred, { timeoutMs, intervalMs: 10, label: "mid-session-modal-chokepoint" });
  } catch (err) {
    if (err?.exhaustedOnThrow !== false) throw err;
    return false;
  }
};

const tmpHome = path.join(os.tmpdir(), `loom-msmc-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const SETTLE_MS = 150;
const GIVE_UP_HOLD = 150;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = "10";
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = "60";
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = "3";
process.env.LOOM_READY_FALLBACK_MS = "60000";
process.env.LOOM_CLAUDE_BOOT_DIALOG_STUCK_TIMEOUT_MS = "60000";
const ESCALATE_MS = 300;
process.env.LOOM_MODAL_HOLD_ESCALATE_MS = String(ESCALATE_MS);
process.env.LOOM_MODAL_DISMISS_SETTLE_MS = String(SETTLE_MS);
process.env.LOOM_GIVE_UP_HOLD_MS = String(GIVE_UP_HOLD);
// Long enough for: settle (150) + give-up hold (150) + a drain tick + retry ladder (3 x 60) — all of which a leak would use.
const STABLE_WINDOW = 1200;

const { PtyHost, MODAL_HOLD_REFUSAL } = await import("../dist/pty/host.js");
const { MODAL_RESOLVE_STEPS } = await import("../dist/pty/modal-hold-text.js");
const { REAL_FIRST_SCREEN_RAW, REAL_STATUS_REPAINT_AFTER, OWNER_SECOND_SCREEN } = await import("./_fixture-teach-auto-mode-modal.mjs");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const MODAL = "Some brand-new Claude Code prompt\n❯ 1. Yes\n  2. No\nEnter to confirm · Esc to cancel";
const ORDINARY = "● Reading file…\nWorking (3s · esc to interrupt)\n> Ask Claude to do anything";
const COMPOSER_BOX = `\n${"─".repeat(120)}\n❯ \n${"─".repeat(120)}\n  [Opus 5.5] 📁 loom | 🌿 main`;
const ERASE = "\x1b[2J\x1b[H";

const fakes = new Map();
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    let dataCb = null;
    const fake = { ...base, write: (d) => writes.push(d), onData: (cb) => { dataCb = cb; return { dispose() {} }; }, feed: (s) => dataCb?.(s), writes };
    fakes.set(opts.sessionId, fake);
    return fake;
  }
}
const stuck = [];
const resolved = [];
const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  onClaudeBootDialogStuck(id, info) { stuck.push({ id, info }); },
  onClaudeBootDialogResolved(id) { resolved.push(id); },
};
const host = new TestPtyHost(events);
const ids = [];
const spawnOne = (id, role = "manager") => {
  ids.push(id);
  host.spawn({
    sessionId: id, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role,
  });
  host.deliverHook(id, { hook_event_name: "SessionStart", session_id: `eng-${id}` });
  return fakes.get(id);
};
const liveOf = (id) => host.live.get(id);
const escalations = (id) => stuck.filter((e) => e.id === id && e.info.escalation === true);
const midEvents = (id) => stuck.filter((e) => e.id === id && e.info.phase === "mid-session" && !e.info.escalation);

// "No Loom write over a STABLE window" with its positive control: the SAME predicate (`writes.length > base`) on an
// UNHELD session that submits must flip inside the same window.
let ctlSeq = 0;
async function writesStable(label, id, baseline) {
  const watch = { id, base: baseline };
  return assertNeverWithControl({
    label,
    check: () => fakes.get(watch.id).writes.length > watch.base,
    windowMs: STABLE_WINDOW,
    positiveControl: async () => {
      const cid = `sess-ctl-${++ctlSeq}`;
      const f = spawnOne(cid);
      f.feed(ORDINARY);
      watch.id = cid; watch.base = 0;
      host.submit(cid, "hello control");
      const r = await pollUntil(() => f.writes.length > 0, { timeoutMs: STABLE_WINDOW, intervalMs: 10 });
      watch.id = id; watch.base = baseline;
      return r;
    },
  });
}
async function holdReal(id) {
  const f = spawnOne(id);
  f.feed(REAL_FIRST_SCREEN_RAW);
  host.submit(id, `report ${id}`);
  const engaged = await waitUntil(() => midEvents(id).length === 1, 3000);
  return { f, engaged };
}

try {
  // ============ K) round-3 repros: an erase-led redraw split across chunks must never release into a write ============
  {
    // K1 — chunk (a): erase + content with a composer box and NO footer (dismissal-looking evidence); chunk (b): the real modal frame.
    const { f, engaged } = await holdReal("sess-k1");
    check("(K1) setup: the real modal + an unconfirmed delivery engages the hold with ZERO writes (the paste/Enter were refused at the chokepoint)", engaged && f.writes.length === 0);
    f.feed(ERASE + "● redrawing…\n" + COMPOSER_BOX);
    check("(K1) after chunk (a) the dismissal evidence has NOT released the hold (settle window pending)", liveOf("sess-k1").midSessionModal != null);
    f.feed(REAL_FIRST_SCREEN_RAW); // chunk (b): the real modal frame re-created
    check("(K1) after chunk (b) the hold stays and the settle evidence was reset", liveOf("sess-k1").midSessionModal != null && liveOf("sess-k1").modalCandidate?.dismissSince === null);
    check("(K1) ZERO writes over a stable window longer than settle + the requeue hold + the retry ladder (paired with a control)",
      await writesStable("(K1) no write into a modal Loom currently detects", "sess-k1", 0));
    check("(K1) ...and the hold is still engaged at the end of the window", liveOf("sess-k1").midSessionModal != null);

    // K2 — same, but the real frame arrives only AFTER part of the settle window elapsed (evidence stood, then was lost).
    const { f: f2 } = await holdReal("sess-k2");
    f2.feed(ERASE + "● redrawing…\n" + COMPOSER_BOX);
    await pollUntil(() => Date.now() - (liveOf("sess-k2").modalCandidate?.dismissSince ?? Infinity) >= SETTLE_MS / 3, { timeoutMs: SETTLE_MS * 5, intervalMs: 5 }); // observable: the evidence has stood part of the window
    f2.feed(ERASE + REAL_FIRST_SCREEN_RAW);
    check("(K2) the modal frame landing inside the window keeps the hold", liveOf("sess-k2").midSessionModal != null);
    check("(K2) ZERO writes over the stable window (paired with a control)", await writesStable("(K2) no write after a late modal frame", "sess-k2", 0));

    // K3 — NO hold engaged yet (candidate only): a dismissal-looking box, then a delivery INSIDE the settle window, then the
    // real frame again. The delivery must be refused (engaging the hold), never typed.
    const f3 = spawnOne("sess-k3");
    f3.feed(REAL_FIRST_SCREEN_RAW);
    f3.feed(ERASE + COMPOSER_BOX);
    check("(K3) setup: the dismissal evidence started a settle window", liveOf("sess-k3").modalCandidate?.dismissSince != null);
    host.submit("sess-k3", "delivery inside the settle window");
    // Dismissal settling: the write is refused but does NOT engage (an engaged hold is released only by a hook/human, and the
    // refused write is what would produce that hook — a just-dismissed boot dialog would deadlock).
    check("(K3) a delivery inside the settle window is refused at the chokepoint and does NOT engage the hold yet", f3.writes.length === 0 && liveOf("sess-k3").midSessionModal == null && midEvents("sess-k3").length === 0);
    f3.feed(REAL_FIRST_SCREEN_RAW);
    check("(K3) the modal re-appearing resets the settle evidence (dismissSince null)", liveOf("sess-k3").modalCandidate?.dismissSince === null);
    host.submit("sess-k3", "next write attempt after the modal came back");
    check("(K3) ...and the NEXT write attempt engages the full hold exactly as before, with zero writes", f3.writes.length === 0 && liveOf("sess-k3").midSessionModal != null && midEvents("sess-k3").length === 1);
    check("(K3) ZERO writes over the stable window (paired with a control)", await writesStable("(K3) no write after the frame re-appears", "sess-k3", 0));

    // K4 — the deadlock this guard exists for: a dismissal that DOES settle. Zero writes inside the window, no hold, then the
    // queued delivery drains on its own once the settle drops the candidate.
    const f4 = spawnOne("sess-k4");
    f4.feed(REAL_FIRST_SCREEN_RAW);
    f4.feed(ERASE + COMPOSER_BOX);
    host.enqueueStdin("sess-k4", "queued during the settle window", "system");
    check("(K4) zero Loom writes and no hold between the dismiss signal and settle", f4.writes.length === 0 && liveOf("sess-k4").midSessionModal == null && liveOf("sess-k4").modalCandidate != null);
    check("(K4) the settle drops the candidate and the queued delivery drains without any hook or human release",
      await pollUntil(() => liveOf("sess-k4").modalCandidate == null && f4.writes.length > 0, { timeoutMs: SETTLE_MS * 10, intervalMs: 5 }) && liveOf("sess-k4").midSessionModal == null && midEvents("sess-k4").length === 0);

    // K5 — the modal comes BACK while a delivery waits out the settle window: the hold must engage at that moment (event +
    // escalation), not on some later write attempt, with zero writes throughout.
    const f5 = spawnOne("sess-k5");
    f5.feed(REAL_FIRST_SCREEN_RAW);
    f5.feed(ERASE + COMPOSER_BOX);
    host.enqueueStdin("sess-k5", "queued during the settle window", "system");
    check("(K5) setup: queued inside the settle window, no hold, no write", liveOf("sess-k5").midSessionModal == null && f5.writes.length === 0 && liveOf("sess-k5").pending.length > 0);
    f5.feed(ERASE + REAL_FIRST_SCREEN_RAW);
    check("(K5) the modal re-appearing engages the hold itself (one mid-session event) with zero writes", liveOf("sess-k5").midSessionModal != null && midEvents("sess-k5").length === 1 && f5.writes.length === 0);
    check("(K5) ZERO writes over the stable window (paired with a control)", await writesStable("(K5) no write after the modal re-appeared", "sess-k5", 0));

    // K6 — a DIRECT submit inside the settle window: its body paste is refused, so the Enter-verify chain must stop and requeue
    // the content instead of retrying an Enter into the just-dismissed composer (which could hold a human draft).
    const f6 = spawnOne("sess-k6");
    f6.feed(REAL_FIRST_SCREEN_RAW);
    f6.feed(ERASE + COMPOSER_BOX);
    host.submit("sess-k6", "direct submit inside the settle window");
    check("(K6) setup: the body was refused inside the window (no hold, no write)", f6.writes.length === 0 && liveOf("sess-k6").midSessionModal == null);
    check("(K6) the delivery eventually lands via the requeue once the candidate settles away",
      await pollUntil(() => f6.writes.some((w) => w.includes("direct submit inside the settle window")), { timeoutMs: SETTLE_MS * 20, intervalMs: 5 }));
    const firstWrite = f6.writes[0] ?? "";
    check("(K6) the FIRST write after the settle is the body paste, never a stray Enter into the empty composer", firstWrite.includes("\x1b[200~") && (f6.writes.indexOf("\r") === -1 || f6.writes.indexOf("\r") > f6.writes.findIndex((w) => w.includes("direct submit inside the settle window"))));
    check("(K6) no hold was ever engaged for it", liveOf("sess-k6").midSessionModal == null && midEvents("sess-k6").length === 0);

    // K7 — resumeAfterRateLimit replays lastPrompt: onto a pane showing a modal it must QUEUE (enqueueStdin), never submit()
    // directly (a direct submit starts a new generation and types into the modal).
    const f7 = spawnOne("sess-k7");
    f7.feed(ORDINARY);
    host.submit("sess-k7", "the turn a rate limit killed");
    const l7 = liveOf("sess-k7");
    l7.busy = false; l7.rateLimited = true;
    f7.feed(MODAL);
    f7.feed(ERASE + COMPOSER_BOX); // the dialog was just dismissed: settling, so the queued replay is not parked by an engaged hold
    const gen7 = l7.submitGeneration, writes7 = f7.writes.length;
    host.resumeAfterRateLimit("sess-k7");
    check("(K7) the replay on a modal pane is queued, not submitted: no new generation, no new write, one pending entry", l7.submitGeneration === gen7 && f7.writes.length === writes7 && l7.pending.length === 1);
    check("(K7) the queued replay DRAINS once the candidate settles away (no strand)",
      await pollUntil(() => f7.writes.slice(writes7).some((w) => w.includes("the turn a rate limit killed")), { timeoutMs: SETTLE_MS * 20, intervalMs: 5 }) && l7.pending.length === 0);

    // K8 — the settle fires BETWEEN a refused bracket-start and the delayed attempt-1 Enter (the settle drops the candidate, so only
    // the per-generation refusal can stop that Enter reaching an empty composer). Settle is invoked directly in the gap.
    const f8 = spawnOne("sess-k8");
    f8.feed(REAL_FIRST_SCREEN_RAW);
    f8.feed(ERASE + COMPOSER_BOX);
    host.submit("sess-k8", "body whose Enter follows the settle");
    const l8 = liveOf("sess-k8");
    check("(K8) setup: body refused (no write yet), candidate still settling", f8.writes.length === 0 && l8.modalCandidate?.dismissSince != null);
    host.settleModalDismissal("sess-k8", l8, l8.modalCandidate); // the settle fires in the bracket-start -> Enter gap
    check("(K8) the settle dropped the candidate", l8.modalCandidate == null);
    await pollUntil(() => f8.writes.some((w) => w.includes("body whose Enter follows the settle")), { timeoutMs: SETTLE_MS * 20, intervalMs: 5 });
    const bodyIdx8 = f8.writes.findIndex((w) => w.includes("body whose Enter follows the settle"));
    check("(K8) NO write (stray Enter, torn body) of the refused generation precedes the requeued, whole delivery", bodyIdx8 !== -1 && f8.writes.slice(0, bodyIdx8).every((w) => w === "\x1b[200~") && f8.writes.slice(0, bodyIdx8).length <= 1);
    check("(K8) the content is delivered exactly once", f8.writes.filter((w) => w.includes("body whose Enter follows the settle")).length === 1);
  }

  // ============ L) the chokepoint, per write tag ============
  {
    const TAGS = ["bracket-start", "chunk", "bracket-end", "reassert-paste", "enter", "redirect-esc", "esc-mcp-dismiss", "shift-tab", "resume-gate-enter"];
    for (const tag of TAGS) {
      const id = `sess-l-${tag}`;
      const f = spawnOne(id);
      f.feed(MODAL); // candidate only: NO hold yet
      const live = liveOf(id);
      check(`(L) ${tag}: a candidate-only session has no hold before the write`, live.modalCandidate != null && live.midSessionModal == null);
      host.ptyWrite(id, live, "X", tag);
      check(`(L) ${tag}: the write is REFUSED at the chokepoint and re-engages the hold`, f.writes.length === 0 && live.midSessionModal != null);
      // positive control: the SAME write on a session with no candidate IS written
      const cid = `sess-l-ctl-${tag}`;
      const cf = spawnOne(cid);
      cf.feed(ORDINARY);
      host.ptyWrite(cid, liveOf(cid), "X", tag);
      check(`(L) ${tag}: control — the same write on an unheld, candidate-free session is written`, cf.writes.length === 1 && cf.writes[0] === "X");
    }
    // the real Loom paths on a candidate-only session
    const fd = spawnOne("sess-l-drain");
    fd.feed(MODAL);
    host.enqueueStdin("sess-l-drain", "a system nudge", "system");
    check("(L) enqueueStdin (a drain/immediate-submit path) on a candidate-only session writes nothing", fd.writes.length === 0);
    const fs2 = spawnOne("sess-l-submit");
    fs2.feed(MODAL);
    host.submit("sess-l-submit", "direct submit");
    check("(L) submit() on a candidate-only session writes nothing and parks it (hold engaged)", fs2.writes.length === 0 && liveOf("sess-l-submit").midSessionModal != null);
    check("(L) drains are gated on the candidate alone (isBlockedOnUnresolvedBootDialog)", (() => { const f = spawnOne("sess-l-gate"); f.feed(MODAL); return host.isBlockedOnUnresolvedBootDialog(liveOf("sess-l-gate")) === true && host.isBlockedOnUnresolvedBootDialog(liveOf("sess-l-ctl-enter")) === false; })());
    // exempt writes keep working while held
    const fx = spawnOne("sess-l-exempt");
    fx.feed(MODAL);
    host.ptyWrite("sess-l-exempt", liveOf("sess-l-exempt"), "z", "redirect-esc"); // engage
    host.repaint("sess-l-exempt");
    check("(L) the viewer Ctrl-L repaint is exempt (still written while held)", fx.writes.includes("\x0c"));
    host.ptyWrite("sess-l-exempt", liveOf("sess-l-exempt"), "\x03", "stop-ctrl-c");
    check("(L) stop's Ctrl-C is exempt", fx.writes.includes("\x03"));
    host.writeStdin("sess-l-exempt", "y");
    check("(L) human terminal input is written through", fx.writes.includes("y"));
    // pre-boot + role-less sessions are untouched by the candidate rule
    const fp = spawnOne("sess-l-plain", null);
    fp.feed(MODAL);
    host.ptyWrite("sess-l-plain", liveOf("sess-l-plain"), "X", "enter");
    check("(L) a role-less session is not covered: the write goes through", fp.writes.length === 1);
  }

  // ============ M) the settle window: a genuine dismissal still releases, but only after it ============
  {
    const { f, engaged } = await holdReal("sess-m");
    f.feed(COMPOSER_BOX);
    const stamp = Date.now();
    check("(M) the dismissal evidence starts a settle window (candidate kept, hold kept)", engaged && liveOf("sess-m").modalCandidate?.dismissSince != null && liveOf("sess-m").midSessionModal != null);
    check("(M) the settle timer has fired and, with the hold ENGAGED, the screen alone did not release it", await waitUntil(() => liveOf("sess-m").modalCandidate?.dismissSince === null, SETTLE_MS * 20) && liveOf("sess-m").midSessionModal != null && Date.now() - stamp >= SETTLE_MS - 20);
    check("(M) ...so the chokepoint still refuses", (() => { host.ptyWrite("sess-m", liveOf("sess-m"), "X", "enter"); return !f.writes.includes("X"); })());
    host.deliverHook("sess-m", { hook_event_name: "UserPromptSubmit", session_id: "eng-sess-m", prompt: "p" });
    check("(M) a UserPromptSubmit releases it and drops the candidate", liveOf("sess-m").midSessionModal === null && liveOf("sess-m").modalCandidate == null);
    host.ptyWrite("sess-m", liveOf("sess-m"), "X", "enter");
    check("(M) after the release the chokepoint writes again", f.writes.includes("X"));
    // a candidate that blocked NOTHING (a quoted footer) is dropped by the settle: the one screen-only exit (positive control)
    const f2 = spawnOne("sess-m2");
    f2.feed(MODAL);
    f2.feed(COMPOSER_BOX);
    check("(M) candidate-only (nothing blocked): evidence pending, then dropped after the window", liveOf("sess-m2").modalCandidate != null && await waitUntil(() => liveOf("sess-m2").modalCandidate == null, SETTLE_MS * 20));
    // ...but the SAME evidence never clears one that has blocked something (the first blocked write engages it)
    const f3 = spawnOne("sess-m3");
    f3.feed(MODAL);
    host.ptyWrite("sess-m3", liveOf("sess-m3"), "X", "enter"); // blocked -> engaged
    f3.feed(COMPOSER_BOX);
    check("(M) candidate that blocked something is NOT dropped by the settle", await waitUntil(() => liveOf("sess-m3").modalCandidate?.dismissSince === null, SETTLE_MS * 20) && liveOf("sess-m3").modalCandidate != null && liveOf("sess-m3").midSessionModal != null);
  }

  // ============ N) healIfStuck is skipped while held ============
  {
    const makeStale = (id) => {
      const live = liveOf(id);
      live.busy = true; live.firstTurnStarted = true;
      live.busySince = Date.now() - 3_600_000; live.lastOutputAt = Date.now() - 3_600_000;
      return live;
    };
    const { engaged } = await holdReal("sess-n");
    const live = makeStale("sess-n");
    const gen = live.submitGeneration;
    host.healIfStuck(live, "sess-n");
    check("(N) a held session is NOT healed: busy and the submit generation are untouched", engaged && live.busy === true && live.submitGeneration === gen);
    const fc = spawnOne("sess-n-ctl");
    fc.feed(ORDINARY);
    const lc = makeStale("sess-n-ctl");
    const g0 = lc.submitGeneration;
    host.healIfStuck(lc, "sess-n-ctl");
    check("(N) control: the same stale session WITHOUT a hold IS healed (busy cleared, generation bumped)", lc.busy === false && lc.submitGeneration === g0 + 1);
  }

  // ============ O) a candidate IS an episode (M1): hold + escalation + midSessionModalSince ============
  {
    const f = spawnOne("sess-o1");
    f.feed(MODAL); // candidate at idle: nothing pending, nothing arrives
    check("(O) idle candidate with nothing pending and nothing arriving: no episode yet (a quoted footer costs nothing)", liveOf("sess-o1").midSessionModal == null && host.getMidSessionModalSince("sess-o1") === null);
    host.enqueueStdin("sess-o1", "a system nudge", "system");
    check("(O) an enqueue on the candidate engages the episode: midSessionModalSince set, ONE mid-session event, nothing written",
      typeof host.getMidSessionModalSince("sess-o1") === "number" && midEvents("sess-o1").length === 1 && f.writes.length === 0);
    check("(O) the 3-min owner escalation is armed on that episode and fires once (shortened here)", await waitUntil(() => escalations("sess-o1").length === 1, ESCALATE_MS * 8));
    // pending BEFORE the candidate exists: the candidate's creation engages immediately
    const f2 = spawnOne("sess-o2");
    f2.feed(ORDINARY);
    host.submit("sess-o2", "first turn");
    host.enqueueStdin("sess-o2", "queued behind it", "system");
    check("(O) setup: a message is pending behind the busy turn", liveOf("sess-o2").pending.length === 1 && liveOf("sess-o2").midSessionModal == null);
    f2.feed(MODAL);
    check("(O) a candidate created while something is pending engages at creation (event + since, no further trigger)", midEvents("sess-o2").length === 1 && typeof host.getMidSessionModalSince("sess-o2") === "number");
    // control: no candidate -> an enqueue never creates an episode
    const fc = spawnOne("sess-o3");
    fc.feed(ORDINARY);
    host.enqueueStdin("sess-o3", "nudge", "system");
    check("(O) control: an enqueue with no candidate creates no episode", host.getMidSessionModalSince("sess-o3") === null && midEvents("sess-o3").length === 0);
  }

  // ============ P) ONE predicate for every surface (M2) ============
  {
    const f = spawnOne("sess-p");
    f.feed(MODAL); // candidate only
    check("(P) modalHoldRefusal reports the candidate-only block (the gateway composer 409 and deliverRedirect read it)", host.modalHoldRefusal("sess-p") === MODAL_HOLD_REFUSAL);
    const f2 = spawnOne("sess-p2");
    f2.feed(MODAL);
    const res = host.enqueueStdin("sess-p2", "my unfinished draft", "human");
    check("(P) a human composer entry on a candidate-only session is refused (modal-held, not queued: the draft stays with the human)",
      res.delivered === false && res.reason === "modal-held" && res.queued === false && liveOf("sess-p2").pending.length === 0 && f2.writes.length === 0);
    const f3 = spawnOne("sess-p3");
    f3.feed(MODAL);
    liveOf("sess-p3").ready = true; liveOf("sess-p3").busy = true;
    host.interruptForRedirect("sess-p3");
    const fl = await host.flushComposer("sess-p3");
    check("(P) interruptForRedirect writes no Esc and flushComposer refuses on a candidate-only session", f3.writes.length === 0 && fl.ok === false && fl.reason === MODAL_HOLD_REFUSAL);
    const fk = spawnOne("sess-p-ctl");
    fk.feed(ORDINARY);
    liveOf("sess-p-ctl").ready = true; liveOf("sess-p-ctl").busy = true;
    host.interruptForRedirect("sess-p-ctl");
    check("(P) control: the same interrupt on a candidate-free session DOES write its Esc; modalHoldRefusal is null", fk.writes.includes("\x1b") && host.modalHoldRefusal("sess-p-ctl") === null);
  }

  // ============ Q) C1: human raw bytes pass through but NEVER release; the release route; UserPromptSubmit ============
  {
    const { f, engaged } = await holdReal("sess-q");
    host.writeStdin("sess-q", "\x1b[A"); host.writeStdin("sess-q", "\x1b[I"); host.writeStdin("sess-q", "x");
    check("(Q) setup: engaged; human arrows/focus/printable were written through", engaged && f.writes.includes("\x1b[A") && f.writes.includes("\x1b[I") && f.writes.includes("x"));
    check("(Q) ...and the hold + candidate STAY (human bytes are not evidence)", liveOf("sess-q").midSessionModal != null && liveOf("sess-q").modalCandidate != null);
    const baseline = f.writes.length;
    check("(Q) ZERO Loom writes over the stable window after the human keystrokes (paired with a control)", await writesStable("(Q) no Loom write after human keystrokes", "sess-q", baseline));
    check("(Q) the human release on a candidate-free, unheld session is a no-op (released:false)", host.releaseModalHoldByHuman("sess-p-ctl", { force: true }).released === false && host.releaseModalHoldByHuman("sess-nope", { force: true }).released === false);
    const rel = host.releaseModalHoldByHuman("sess-q", { force: true });
    check("(Q) the explicit human release ends the episode and drops the candidate", rel.released && rel.held && liveOf("sess-q").midSessionModal == null && liveOf("sess-q").modalCandidate == null);
  }

  // ============ R) a parked kickoff-style submit is re-guaranteed on release (UserPromptSubmit and human) ============
  {
    const KICK = "KICKOFF-TEXT-for-sess-r";
    const kickOrigin = [{ id: "k1", text: KICK, source: "system", kind: "agent", logicalId: "k1" }];
    for (const via of ["human", "hook"]) {
      const id = `sess-r-${via}`;
      const f = spawnOne(id);
      f.feed(MODAL);
      host.submit(id, KICK, undefined, undefined, undefined, undefined, "kickoff-guarantee", kickOrigin);
      check(`(R/${via}) the kickoff submit is parked by the hold: nothing written`, liveOf(id).midSessionModal != null && f.writes.length === 0);
      if (via === "human") host.releaseModalHoldByHuman(id, { force: true });
      else { f.feed(COMPOSER_BOX); host.deliverHook(id, { hook_event_name: "UserPromptSubmit", session_id: `eng-${id}` }); } // no reported prompt: the engine echo cannot race a prompt-mismatch notice into the redelivery
      check(`(R/${via}) the parked kickoff was requeued (not lost)`, liveOf(id).pending.some((m) => m.text.includes(KICK)) || f.writes.join("").includes(KICK));
      if (via === "hook") host.deliverHook(id, { hook_event_name: "Stop", session_id: `eng-${id}` });
      check(`(R/${via}) the kickoff is eventually delivered after the release (re-guaranteed)`, await pollUntil(() => { host.reconcile(); return f.writes.join("").includes(KICK); }, { timeoutMs: 12000, intervalMs: 20 })); // reconcile() is the periodic tick that drains a held requeue
    }
  }

  // ============ S) a UserPromptSubmit never wipes a modal frame ALREADY received (hook latency) ============
  {
    const SECOND = ERASE + OWNER_SECOND_SCREEN.replace(/\n/g, "\r\n");
    const ups = (id) => host.deliverHook(id, { hook_event_name: "UserPromptSubmit", session_id: `eng-${id}`, prompt: "/auto-mode-setup" });
    const stop = (id) => host.deliverHook(id, { hook_event_name: "Stop", session_id: `eng-${id}` });
    // S1: the wizard (second screen) was painted BEFORE the hook landed, then Stop drains a queued message.
    const { f, engaged } = await holdReal("sess-s1");
    f.feed(SECOND);
    ups("sess-s1");
    check("(S1) the UPS landing AFTER the second modal frame is a NO-OP: the episode and candidate stay", engaged && liveOf("sess-s1").midSessionModal != null && liveOf("sess-s1").modalCandidate != null);
    host.enqueueStdin("sess-s1", "[loom:x] follow-up", "system");
    stop("sess-s1");
    check("(S1) ZERO writes after the Stop over a stable window, hold still engaged (paired with a control)", await writesStable("(S1) no write into the wizard", "sess-s1", f.writes.length) && liveOf("sess-s1").midSessionModal != null);
    // S2: the wizard paints in a frame received before the hook, with the candidate created by THAT frame (P3 shape).
    const f2 = spawnOne("sess-s2");
    host.submit("sess-s2", "[loom:x] turn");
    f2.feed(SECOND);
    ups("sess-s2");
    host.enqueueStdin("sess-s2", "[loom:x] next", "system");
    const base2 = f2.writes.length;
    stop("sess-s2");
    check("(S2) candidate created by the frame, UPS afterwards: still held, ZERO writes after the Stop (paired with a control)", liveOf("sess-s2").midSessionModal != null && await writesStable("(S2) no write after the Stop", "sess-s2", base2));
    // S3 control: a modal-FREE current frame (composer box after the footer) DOES let the UPS release
    const { f: f3 } = await holdReal("sess-s3");
    f3.feed(COMPOSER_BOX);
    ups("sess-s3");
    check("(S3) control: with a modal-free current frame the same UPS releases the episode", liveOf("sess-s3").midSessionModal == null && liveOf("sess-s3").modalCandidate == null);

    // S4 (B1): the hook lands INSIDE the footer bytes ("...Esc to can" | UPS | "cel"): the frame head must survive the hook.
    const { f: f4 } = await holdReal("sess-s4");
    const cut = SECOND.indexOf("Esc to can") + "Esc to can".length;
    f4.feed(SECOND.slice(0, cut));
    ups("sess-s4");
    f4.feed(SECOND.slice(cut));
    host.enqueueStdin("sess-s4", "[loom:x] follow-up", "system");
    const base4 = f4.writes.length;
    stop("sess-s4");
    check("(S4) split footer across the hook: the footer still completes into a held episode, ZERO writes after the Stop (paired with a control)",
      liveOf("sess-s4").midSessionModal != null && liveOf("sess-s4").modalCandidate != null && await writesStable("(S4) no write into the wizard", "sess-s4", base4));

    // S5 (B2): an AGED frame — N >= 40 real status repaints (~7K, far past any sliding window) after the modal.
    const { f: f5 } = await holdReal("sess-s5");
    for (let n = 0; n < 45; n++) f5.feed(REAL_STATUS_REPAINT_AFTER);
    const r5 = host.releaseModalHoldByHuman("sess-s5");
    check("(S5) 45 status repaints later the modal is still TRACKED as shown: Resume without force is soft-refused", r5.released === false && r5.stillOnScreen === true && liveOf("sess-s5").midSessionModal != null);
    ups("sess-s5");
    host.enqueueStdin("sess-s5", "[loom:x] f", "system");
    const base5 = f5.writes.length;
    stop("sess-s5");
    check("(S5) ...and a UPS on that aged frame is a no-op: still held, ZERO writes after the Stop (paired with a control)", liveOf("sess-s5").midSessionModal != null && await writesStable("(S5) no write after an aged-frame UPS", "sess-s5", base5));
    // AGU: second screen after an erase, then 45 repaints, then the UPS
    const { f: f6 } = await holdReal("sess-s6");
    f6.feed(SECOND);
    for (let n = 0; n < 45; n++) f6.feed(REAL_STATUS_REPAINT_AFTER);
    ups("sess-s6");
    check("(S5) AGU: erase + second screen + 45 repaints, then UPS: still held", liveOf("sess-s6").midSessionModal != null && liveOf("sess-s6").modalCandidate?.shown === true);

    // S6 positive controls: a genuine erase + modal-free frame, then UPS, releases; a dismissal with NO erase stays soft-refused until force.
    const { f: f7 } = await holdReal("sess-s7");
    f7.feed(ERASE + COMPOSER_BOX);
    check("(S6) control: a genuine erase + a modal-free frame clears the tracked state", liveOf("sess-s7").modalCandidate?.shown === false);
    ups("sess-s7");
    check("(S6) control: ...and the UPS then releases", liveOf("sess-s7").midSessionModal == null);
    const { f: f8 } = await holdReal("sess-s8");
    f8.feed("\x1b[5;1H\x1b[J\x1b[5;3H> "); // a cursor-addressed clear: NO erase and NO box = no evidence
    const r8 = host.releaseModalHoldByHuman("sess-s8");
    check("(S6) a dismissal with no erase and no composer box stays soft-refused (bounded, visible)", r8.released === false && r8.stillOnScreen === true);
    check("(S6) ...until the human forces it", host.releaseModalHoldByHuman("sess-s8", { force: true }).released === true);

    // S7: a footer followed by >200 trailing bytes in the SAME chunk (an erase-led redraw + coalesced repaints) must still be sighted.
    const TRAIL = "\x1b[?25l\x1b[40;1H\x1b[2K" + " ".repeat(10) + "\x1b[38;2;153;153;153m? for shortcuts\x1b[39m".repeat(8);
    check("(S7) setup: the trailing bytes really exceed the 200-char footer window", TRAIL.length > 200);
    const softAndQuiet = async (id, f, what) => {
      const r = host.releaseModalHoldByHuman(id);
      ups(id);
      host.enqueueStdin(id, "[loom:x] f", "system");
      const base = f.writes.length;
      stop(id);
      return r.released === false && r.stillOnScreen === true && liveOf(id).midSessionModal != null && await writesStable(`(S7) ${what}: no write after UPS+Stop`, id, base);
    };
    const { f: f9 } = await holdReal("sess-s9");
    f9.feed(SECOND + TRAIL);
    check("(S7) one chunk = erase + modal + >200 trailing bytes: tracked as shown, Resume soft-refused, UPS+Stop writes nothing (paired with a control)", liveOf("sess-s9").modalCandidate?.shown === true && await softAndQuiet("sess-s9", f9, "erase+modal+trail in one chunk"));
    const { f: f10 } = await holdReal("sess-s10");
    const cut10 = SECOND.indexOf("Esc to can") + "Esc to can".length;
    f10.feed(SECOND.slice(0, cut10));
    f10.feed(SECOND.slice(cut10) + TRAIL);
    check("(S7) its split-footer twin ('cel' + >200 trailing bytes in the second chunk): same", liveOf("sess-s10").modalCandidate?.shown === true && await softAndQuiet("sess-s10", f10, "split footer + trail"));
    // erase ordering: a footer only BEFORE the erase in a chunk must NOT count; one AFTER it must
    const { f: f11 } = await holdReal("sess-s11");
    f11.feed(SECOND + ERASE + "hello");
    check("(S7) erase ordering: footer BEFORE an erase (then a footer-free frame) does not count as shown", liveOf("sess-s11").modalCandidate?.shown === false);
    const { f: f12 } = await holdReal("sess-s12");
    f12.feed(SECOND.slice(0, cut10) + "\x1b[2J");
    f12.feed("cel");
    check("(S7) erase ordering: 'Esc to can' + erase | 'cel' is not a footer", liveOf("sess-s12").modalCandidate?.shown === false);
    const { f: f13 } = await holdReal("sess-s13");
    f13.feed("old text\x1b[2J" + OWNER_SECOND_SCREEN.replace(/\n/g, "\r\n") + TRAIL);
    check("(S7) erase ordering: erase THEN footer (+ trail) in one chunk counts as shown", liveOf("sess-s13").modalCandidate?.shown === true);

    // SD / HR: a NEW modal half-painted ("...Esc to can") at the moment the candidate is dropped by the settle (SD) or by a
    // NON-force human release (HR) must still complete ("cel") into a candidate, then block writes.
    const HALF = "\r\n" + OWNER_SECOND_SCREEN.replace(/\n/g, "\r\n").split("Esc to cancel")[0] + "Esc to can";
    const f15 = spawnOne("sess-sd");
    f15.feed(MODAL);
    f15.feed(COMPOSER_BOX);
    f15.feed(HALF);
    check("(SD) setup: the half-painted second modal arrives while the dismissed candidate's settle is pending", liveOf("sess-sd").modalCandidate != null && liveOf("sess-sd").modalCandidate.shown === false);
    check("(SD) the settle drops the candidate", await waitUntil(() => liveOf("sess-sd").modalCandidate == null, SETTLE_MS * 20));
    f15.feed("cel");
    check("(SD) the split footer completes across the settle drop into a NEW candidate", liveOf("sess-sd").modalCandidate != null);
    host.enqueueStdin("sess-sd", "[loom:x] q", "system");
    check("(SD) ZERO writes over a stable window (paired with a control)", liveOf("sess-sd").midSessionModal != null && await writesStable("(SD) no write into the new modal", "sess-sd", f15.writes.length));
    const f16 = spawnOne("sess-hr");
    f16.feed(MODAL);
    f16.feed(COMPOSER_BOX);
    f16.feed(HALF);
    const rHR = host.releaseModalHoldByHuman("sess-hr");
    check("(HR) setup: the NON-force human release of the dismissed candidate is accepted", rHR.released === true && liveOf("sess-hr").modalCandidate == null);
    f16.feed("cel");
    check("(HR) the split footer completes across the human release into a NEW candidate", liveOf("sess-hr").modalCandidate != null);
    host.enqueueStdin("sess-hr", "[loom:x] q", "system");
    check("(HR) ZERO writes over a stable window (paired with a control)", liveOf("sess-hr").midSessionModal != null && await writesStable("(HR) no write into the new modal", "sess-hr", f16.writes.length));

    // C1: a human FORCE release wipes the tail (no carry), so the stale footer cannot resurrect a new false hold
    const { f: f14 } = await holdReal("sess-c1");
    f14.feed("\x1b[5;1H\x1b[J\x1b[5;3H> ");
    host.releaseModalHoldByHuman("sess-c1", { force: true });
    f14.feed("\r\n● I will cancel the old job now.\r\n");
    check("(C1) after a force release, agent text containing 'cancel' creates NO new candidate or hold", liveOf("sess-c1").modalCandidate == null && liveOf("sess-c1").midSessionModal == null);
  }

  // ============ T) the soft refusal on Resume (overridable) + the shared wording ============
  {
    const { f, engaged } = await holdReal("sess-t1");
    const r1 = host.releaseModalHoldByHuman("sess-t1");
    check("(T) Resume while the current frame still shows a modal footer is refused softly (stillOnScreen), nothing changes", engaged && r1.released === false && r1.stillOnScreen === true && liveOf("sess-t1").midSessionModal != null && liveOf("sess-t1").modalCandidate != null);
    const r2 = host.releaseModalHoldByHuman("sess-t1", { force: true });
    check("(T) ...and force:true overrides it (the evidence is synthetic)", r2.released === true && r2.held === true && liveOf("sess-t1").midSessionModal == null);
    const { f: f4 } = await holdReal("sess-t2");
    f4.feed(COMPOSER_BOX);
    const r3 = host.releaseModalHoldByHuman("sess-t2");
    check("(T) control: a modal-free current frame releases WITHOUT force (no stillOnScreen)", r3.released === true && r3.stillOnScreen === undefined);
    const f5 = spawnOne("sess-t3");
    f5.feed(MODAL);
    const r4 = host.releaseModalHoldByHuman("sess-t3");
    check("(T) a candidate-only session with the modal still shown is refused softly too", r4.released === false && r4.stillOnScreen === true && liveOf("sess-t3").modalCandidate != null);
    check("(T) wording: the composer refusal names BOTH steps and no longer says any human input releases", MODAL_HOLD_REFUSAL.includes(MODAL_RESOLVE_STEPS) && /resolve the prompt in the terminal, then press Resume deliveries/.test(MODAL_HOLD_REFUSAL) && !/any human input/.test(MODAL_HOLD_REFUSAL));
  }
} finally {
  for (const id of ids) { try { host.stop(id, "hard"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\n✅ ALL PASS — mid-session modal chokepoint invariant + settle window (card 20ff76de)" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
