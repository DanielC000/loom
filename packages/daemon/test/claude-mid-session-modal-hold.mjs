// Card 20ff76de — MID-SESSION unknown-modal detector + hold. Two layers:
//   (1) PURE: detectMidSessionModal on synthetic screens — match (generic footer, known dialog by NAME),
//       no-match on ordinary output, STALE frames (scrolled out / before a screen reset), the echoed
//       lastPrompt, and a footer QUOTED mid-output (followed by the composer box).
//   (2) REAL PtyHost state machine against a fake pty (createSeamHost): an UNCONFIRMED delivery with a modal on
//       the CURRENT tail engages a hold — one mid-session event (name only), no retry Enter, every Loom write
//       dropped at the ptyWrite chokepoint (interrupt Esc / flush refused with a readable reason), human input
//       never blocked. Three release kinds: screen-cleared resumes the parked chain at the NEXT attempt of the
//       SAME generation; a hook releases and resumes NOTHING; human input releases, writes no Enter and requeues.
//       Owner escalation fires once after the bound. Engage is gated on past-boot and on role.
// Every "no Enter while held" negative is paired with a positive control on the SAME check (an identical
// unconfirmed delivery WITHOUT a modal DOES retry its Enter within the same window).
// RUN: pnpm build, then `node test/claude-mid-session-modal-hold.mjs` from packages/daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { assertNeverWithControl, pollUntil } from "./_timing-guard.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const waitUntil = async (pred, timeoutMs) => {
  try {
    return await sharedWaitUntil(pred, { timeoutMs, intervalMs: 10, label: "mid-session-modal-hold" });
  } catch (err) {
    if (err?.exhaustedOnThrow !== false) throw err;
    return false; // timed out: report as a FAIL line, never a bare throw
  }
};

const tmpHome = path.join(os.tmpdir(), `loom-msmh-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const ENTER_DELAY = 10;
const VERIFY_TIMEOUT = 60;
const MAX_ATTEMPTS = 3;
const ESCALATE_MS = 250;
process.env.LOOM_SUBMIT_ENTER_DELAY_MS = String(ENTER_DELAY);
process.env.LOOM_SUBMIT_VERIFY_TIMEOUT_MS = String(VERIFY_TIMEOUT);
process.env.LOOM_SUBMIT_MAX_ATTEMPTS = String(MAX_ATTEMPTS);
process.env.LOOM_READY_FALLBACK_MS = "60000";
process.env.LOOM_CLAUDE_BOOT_DIALOG_STUCK_TIMEOUT_MS = "60000";
process.env.LOOM_MODAL_HOLD_ESCALATE_MS = String(ESCALATE_MS);
const SETTLE_MS = 150;
process.env.LOOM_MODAL_DISMISS_SETTLE_MS = String(SETTLE_MS);

const {
  PtyHost, detectMidSessionModal, MODAL_TAIL_MAX_CHARS, MODAL_HOLD_REFUSAL, MODAL_DISMISS_SETTLE_MS,
} = await import("../dist/pty/host.js");
const { REAL_FIRST_SCREEN_RAW, REAL_STATUS_REPAINT_AFTER, OWNER_SECOND_SCREEN } = await import("./_fixture-teach-auto-mode-modal.mjs");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const MODAL = "Some brand-new Claude Code prompt\n❯ 1. Yes\n  2. No\nEnter to confirm · Esc to cancel";
const ORDINARY = "● Reading file…\nWorking (3s · esc to interrupt)\n> Ask Claude to do anything";
const filler = (n) => "x".repeat(n);
const COMPOSER_BOX = `\n${"─".repeat(120)}\n❯ \n${"─".repeat(120)}\n  [Opus 5.5] 📁 loom | 🌿 main`;

// ---------- (1) PURE ----------
check("(1) positive: a generic dialog footer at the END of the frame is recognized as unknown-modal", detectMidSessionModal(MODAL) === "unknown-modal");
check("(1) positive: footer split by ANSI + cursor-moves still matches (collapse-normalized)",
  detectMidSessionModal("\x1b[1mEnter\x1b[1Cto\x1b[1Cconfirm\x1b[0m · \x1b[2mEsc\x1b[0m to cancel") === "unknown-modal");
check("(1) positive: a modal followed by its own bottom border still matches", detectMidSessionModal(MODAL + "\n╰" + "─".repeat(110) + "╯") === "unknown-modal");
check("(1) positive: a KNOWN dialog is named by its own signature, not the generic one",
  detectMidSessionModal("Is this a project you trust?\n❯ Yes, I trust this folder\nEnter to confirm · Esc to cancel") === "workspace-trust");
check("(1) negative control: ordinary busy/composer output never matches", detectMidSessionModal(ORDINARY) === null);
check("(1) negative control: empty tail never matches", detectMidSessionModal("") === null);
check("(1) negative control: only ONE of the two footer halves never matches", detectMidSessionModal("press Esc to cancel the run") === null && detectMidSessionModal("Enter to confirm") === null);
check("(1) STALE: a modal followed by the REDRAWN composer box (dismissed) does not match", detectMidSessionModal(MODAL + COMPOSER_BOX) === null);
// REAL bytes (captured read-only from a live session, 2026-11-11) + the owner-supplied second screen.
check("(1) REAL first screen of 'Teach auto mode about your environment?' (raw ANSI bytes) matches", detectMidSessionModal(REAL_FIRST_SCREEN_RAW) === "unknown-modal");
check("(1) REAL first screen still matches after MANY status-line repaints (timers/spinner never push it out of play)",
  detectMidSessionModal(REAL_FIRST_SCREEN_RAW + REAL_STATUS_REPAINT_AFTER.repeat(8)) === "unknown-modal");
check("(1) the owner-supplied SECOND screen (footer 'Enter to continue') matches", detectMidSessionModal(OWNER_SECOND_SCREEN) === "unknown-modal");
check("(1) the same REAL text QUOTED mid-output in an agent reply (composer box redrawn after) does not match",
  detectMidSessionModal("● The dialog says:\n" + OWNER_SECOND_SCREEN + "\n" + COMPOSER_BOX) === null && detectMidSessionModal("● He quoted it:\n" + REAL_FIRST_SCREEN_RAW + COMPOSER_BOX) === null);
check("(1) negative control: the real text's footer-less body alone (no footer) does not match", detectMidSessionModal(OWNER_SECOND_SCREEN.split("←/→")[0]) === null);
check("(1) STALE: modal pushed out of the bounded tail entirely does not match", detectMidSessionModal(MODAL + filler(MODAL_TAIL_MAX_CHARS + 50)) === null);
check("(1) STALE: a modal BEFORE a full-screen erase is not the current frame", detectMidSessionModal(MODAL + "\x1b[2J\x1b[H" + ORDINARY) === null);
check("(1) current frame: a modal AFTER a full-screen erase still matches", detectMidSessionModal(ORDINARY + "\x1b[2J\x1b[H" + MODAL) === "unknown-modal");
check("(1) FALSE POSITIVE: a footer QUOTED in an agent reply (followed by the composer box) does not match",
  detectMidSessionModal("● The dialog says: Enter to confirm · Esc to cancel" + COMPOSER_BOX) === null);
const echoed = "please check whether the prompt shows: Enter to confirm · Esc to cancel";
check("(1) FALSE POSITIVE: the session's own echoed lastPrompt containing the footer does not match when excluded",
  detectMidSessionModal("> " + echoed, { echoText: echoed }) === null);
check("(1) the SAME echoed text DOES match without the exclusion (the exclusion is what suppresses it)", detectMidSessionModal("> " + echoed) === "unknown-modal");

// ---------- (2) HOST ----------
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
const spawnOne = (id, role, { pastBoot = true } = {}) => {
  ids.push(id);
  host.spawn({
    sessionId: id, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role,
  });
  if (pastBoot) host.deliverHook(id, { hook_event_name: "SessionStart", session_id: `eng-${id}` });
  return fakes.get(id);
};
const enters = (f) => f.writes.filter((w) => w === "\r").length;
const escs = (f) => f.writes.filter((w) => w === "\x1b").length;
const midEvents = (id) => stuck.filter((e) => e.id === id && e.info.phase === "mid-session" && !e.info.escalation);
const escalations = (id) => stuck.filter((e) => e.id === id && e.info.escalation === true);
const resolvedCount = (id) => resolved.filter((i) => i === id).length;
const held = (id) => host.isBlockedOnUnresolvedBootDialog(host.live.get(id)) === true && host.live.get(id).midSessionModal != null;
const WINDOW = VERIFY_TIMEOUT * (MAX_ATTEMPTS + 2);

// Positive control shared by every "no Enter" negative: the SAME predicate (`moreEntersThan`) watching a
// session that has NO modal must flip within the same window.
let ctlSeq = 0;
const makeEnterControl = () => async () => {
  const id = `sess-ctl-${++ctlSeq}`;
  const f = spawnOne(id, "manager");
  f.feed(ORDINARY);
  host.submit(id, "hello control");
  return pollUntil(() => enters(f) > 1, { timeoutMs: WINDOW, intervalMs: 10 });
};
async function enterCountStable(label, id, baseline) {
  const idWatch = { current: id };
  const control = makeEnterControl();
  return assertNeverWithControl({
    label,
    check: () => enters(fakes.get(idWatch.current)) > (idWatch.current === id ? baseline : 1),
    windowMs: WINDOW,
    positiveControl: async () => {
      // the control session's own retry flips `check` once the watched id points at it
      const before = ctlSeq;
      const p = control();
      idWatch.current = `sess-ctl-${before + 1}`;
      const r = await p;
      idWatch.current = id;
      return r;
    },
  });
}
// "An engaged hold STAYS" over a stable window, paired with a control on the SAME predicate (`midSessionModal == null`):
// a second held session released by its UserPromptSubmit flips it inside the same window.
let shCtlSeq = 0;
async function staysHeld(label, id) {
  const watch = { id };
  return assertNeverWithControl({
    label,
    check: () => host.live.get(watch.id).midSessionModal == null,
    windowMs: SETTLE_MS * 5,
    positiveControl: async () => {
      const cid = `sess-sh-ctl-${++shCtlSeq}`;
      await holdSession(cid, "manager");
      watch.id = cid;
      fakes.get(cid).feed(COMPOSER_BOX); // a modal-free current frame: only then does a UserPromptSubmit release
      host.deliverHook(cid, { hook_event_name: "UserPromptSubmit", session_id: `eng-${cid}`, prompt: "x" });
      const r = await pollUntil(() => host.live.get(cid).midSessionModal == null, { timeoutMs: SETTLE_MS * 5, intervalMs: 10 });
      watch.id = id;
      return r;
    },
  });
}
async function holdSession(id, role) {
  const f = spawnOne(id, role);
  f.feed(MODAL);
  host.submit(id, `report ${id}`);
  const engaged = await waitUntil(() => midEvents(id).length === 1, 3000);
  return { f, engaged };
}

try {
  // ============ A) manager held: event, no retry Enter, field, chokepoint, refusals ============
  const MGR = "sess-mgr";
  const { f: fm, engaged } = await holdSession(MGR, "manager");
  check("(A) manager: the unconfirmed delivery with a modal engages ONE mid-session event", engaged);
  const ev = midEvents(MGR)[0]?.info ?? {};
  check("(A) manager: event carries name/role/phase only — never screen text",
    ev.signatureName === "unknown-modal" && ev.role === "manager" && ev.phase === "mid-session" && Object.keys(ev).sort().join(",") === "phase,role,signatureName,timeoutMs");
  const mgrBaseline = enters(fm);
  check("(A) manager: NOTHING was written (the chokepoint refused the paste + Enter of a delivery made while the modal was detected) and no Esc", mgrBaseline === 0 && escs(fm) === 0 && fm.writes.length === 0);
  check("(A) manager: held (drain/Enter paths gated)", held(MGR));
  check("(A) manager: the hold is exposed as midSessionModalSince (epoch ms), null when not held",
    typeof host.getMidSessionModalSince(MGR) === "number" && host.getMidSessionModalSince("sess-ctl-1") === null);
  check("(A) manager: no retry Enter while held (paired with a positive control on the same check)",
    await enterCountStable("(A) manager: no retry Enter while the modal holds", MGR, mgrBaseline));
  check("(A) manager: still exactly one event (no re-fire per tick)", midEvents(MGR).length === 1);

  // --- ONE write chokepoint (finding 2) ---
  const liveM = host.live.get(MGR);
  const genBefore = liveM.submitGeneration;
  host.ptyWrite(MGR, liveM, "\x1b", "redirect-esc");
  check("(A) chokepoint: a Loom-originated Esc through ptyWrite is DROPPED while held", escs(fm) === 0);
  liveM.ready = true; liveM.busy = true;
  host.interruptForRedirect(MGR);
  check("(A) interruptForRedirect on a held pane writes NO Esc and does not bump the submit generation", escs(fm) === 0 && liveM.submitGeneration === genBefore);
  const flushRes = await host.flushComposer(MGR);
  check("(A) flushComposer on a held pane refuses with the manager-readable reason", flushRes.ok === false && flushRes.reason === MODAL_HOLD_REFUSAL && /resolve the prompt in the terminal, then press Resume deliveries/.test(flushRes.reason));
  check("(A) modalHoldRefusal exposes the same reason for a service pre-check", host.modalHoldRefusal(MGR) === MODAL_HOLD_REFUSAL && host.modalHoldRefusal("sess-ctl-1") === null);
  check("(A) enqueueStdin (system) while held writes nothing", (() => { const n = fm.writes.length; host.enqueueStdin(MGR, "queued while held", "system"); return fm.writes.length === n; })());
  // positive control for the interrupt refusal: the SAME call on an UNHELD busy+ready session DOES write the Esc
  const ctlI = spawnOne("sess-ctl-int", "manager");
  const liveCI = host.live.get("sess-ctl-int");
  liveCI.ready = true; liveCI.busy = true;
  host.interruptForRedirect("sess-ctl-int");
  check("(A) positive control: interruptForRedirect on an UNHELD busy session DOES write the Esc", escs(ctlI) === 1);

  // a Notification hook must NOT release
  host.deliverHook(MGR, { hook_event_name: "Notification", session_id: "eng-sess-mgr" });
  check("(A) manager: a Notification hook does not release the hold", held(MGR));

  // ============ B) screen-cleared release resumes at attempt+1 of the SAME generation (finding 6) ============
  const stampBefore = host.live.get(MGR).currentGenFirstWrittenAt;
  const rBefore = resolvedCount(MGR);
  fm.feed(COMPOSER_BOX); // positive dismissal evidence: the composer box is redrawn
  check("(B) the evidence alone does NOT release: one chunk is never enough, the hold stays through the settle window", host.live.get(MGR).midSessionModal != null && host.live.get(MGR).modalCandidate != null);
  check("(B) box + settle with the hold ENGAGED: the screen alone never releases it (paired with a control)", await staysHeld("(B) engaged hold stays after the settle window", MGR));
  check("(B) ...and no resolved event was raised by the screen", resolvedCount(MGR) === rBefore);
  const relB = host.releaseModalHoldByHuman(MGR, { force: true });
  check("(B) the explicit human release DOES release (held episode)", relB.released && relB.held && host.live.get(MGR).midSessionModal === null);
  check("(B) the human release raises the resolved event once", resolvedCount(MGR) === rBefore + 1);
  check("(B) the human release itself writes NO Enter: the parked delivery goes back through the normal requeue path (busy cleared)",
    enters(fm) === mgrBaseline && host.live.get(MGR).busy === false);
  check("(B) the generation/stamp were not re-stamped by the release", host.live.get(MGR).currentGenFirstWrittenAt === stampBefore && host.live.get(MGR).submitGeneration === genBefore);
  check("(B) no Enter follows the human release (stable, paired with the control)", await enterCountStable("(B) human release writes no Enter", MGR, mgrBaseline));

  // ============ C) HOOK release resumes NOTHING (finding 1) ============
  // C1: the parked generation's OWN confirming UserPromptSubmit
  const { f: fu } = await holdSession("sess-hook-ups", "manager");
  const upsBase = enters(fu);
  const upsRes = resolvedCount("sess-hook-ups");
  fu.feed(COMPOSER_BOX); // the composer was redrawn after the modal: the current frame is modal-free
  host.deliverHook("sess-hook-ups", { hook_event_name: "UserPromptSubmit", session_id: "eng-sess-hook-ups", prompt: "report sess-hook-ups" });
  check("(C1) UserPromptSubmit releases the hold", host.live.get("sess-hook-ups").midSessionModal === null && resolvedCount("sess-hook-ups") === upsRes + 1);
  check("(C1) ...and the parked delivery is CONFIRMED by it (nothing left to resume)", host.live.get("sess-hook-ups").enterConfirmed === true);
  check("(C1) no Enter after a UserPromptSubmit release (stable over time, paired with the control)",
    await enterCountStable("(C1) UserPromptSubmit release resumes nothing", "sess-hook-ups", upsBase));
  // C2: an unrelated hook (PreToolUse)
  const { f: fp } = await holdSession("sess-hook-pre", "worker");
  const preBase = enters(fp);
  host.deliverHook("sess-hook-pre", { hook_event_name: "PreToolUse", session_id: "eng-sess-hook-pre", tool_name: "Read" });
  host.deliverHook("sess-hook-pre", { hook_event_name: "PostToolUse", session_id: "eng-sess-hook-pre", tool_name: "Read" });
  host.deliverHook("sess-hook-pre", { hook_event_name: "Stop", session_id: "eng-sess-hook-pre" });
  check("(C2) PreToolUse / PostToolUse / Stop do NOT release the hold or drop the candidate (the offer fires at the END of a turn)",
    held("sess-hook-pre") && host.live.get("sess-hook-pre").modalCandidate != null);
  check("(C2) ...stable over a window (paired with a control)", await staysHeld("(C2) mid-turn hooks never release", "sess-hook-pre"));
  check("(C2) no Enter after those hooks (stable over time, paired with the control)",
    await enterCountStable("(C2) mid-turn hooks resume nothing", "sess-hook-pre", preBase));

  // ============ D) HUMAN release: no Loom Enter, human input never blocked, requeued (finding 3c) ============
  const { f: fh } = await holdSession("sess-human", "manager");
  const humBase = enters(fh);
  const humRes = resolvedCount("sess-human");
  host.writeStdin("sess-human", "y");
  check("(D) human terminal input is written through while held (never blocked)", fh.writes.includes("y"));
  host.writeStdin("sess-human", "\x1b[A"); host.writeStdin("sess-human", "\x1b[I"); host.writeStdin("sess-human", "\x1b[<0;5;5M");
  check("(D) human raw bytes (printable, arrow, focus-in, mouse) are all written through but NEVER release: hold stays, no resolved event, candidate kept",
    fh.writes.includes("\x1b[A") && fh.writes.includes("\x1b[I") && held("sess-human") && host.live.get("sess-human").modalCandidate != null && resolvedCount("sess-human") === humRes);
  check("(D) no Loom Enter follows human keystrokes (stable, paired with the control)", await enterCountStable("(D) human keystrokes write no Enter", "sess-human", humBase));
  const relD = host.releaseModalHoldByHuman("sess-human", { force: true });
  check("(D) the explicit human release releases and raises the resolved event", relD.released && host.live.get("sess-human").midSessionModal === null && resolvedCount("sess-human") === humRes + 1);
  check("(D) the release itself wrote NO Enter and the unconfirmed generation went back through the give-up path (busy cleared)",
    enters(fh) === humBase && host.live.get("sess-human").busy === false);
  check("(D) no Loom Enter follows the human release (stable, paired with the control)", await enterCountStable("(D) human release writes no Enter", "sess-human", humBase));
  // composer route (source "human")
  // composer route (source "human"): REFUSED while held with the readable reason; never a release, never queued
  const { f: fc2 } = await holdSession("sess-human-composer", "manager");
  const wBefore = fc2.writes.length;
  const compRes = host.enqueueStdin("sess-human-composer", "hello from the composer", "human");
  check("(D) a HUMAN composer entry while held is REFUSED with the readable reason (delivered:false, modal-held, not queued)",
    compRes.delivered === false && compRes.reason === "modal-held" && compRes.queued === false && compRes.message === MODAL_HOLD_REFUSAL);
  check("(D) ...no paste, no Enter was written and the hold STAYS (the composer is not the terminal)",
    fc2.writes.length === wBefore && held("sess-human-composer") && host.live.get("sess-human-composer").pending.length === 0);
  const ctlC = spawnOne("sess-comp-ctl", "manager");
  check("(D) positive control: the same composer entry on an UNHELD session is accepted (not refused)", host.enqueueStdin("sess-comp-ctl", "hello", "human").reason !== "modal-held" && ctlC.writes.length > 0);
  check("(D) ...while a SYSTEM entry does not", await (async () => {
    const { f } = await holdSession("sess-system-no-release", "manager");
    host.enqueueStdin("sess-system-no-release", "warning nudge", "system");
    return held("sess-system-no-release") && f.writes.length === 0;
  })());

  // ============ E) owner escalation: once, after the bound; never into the Enter ladder (finding 3b) ============
  const ESC1 = "sess-escalate";
  const { f: fe } = await holdSession(ESC1, "worker");
  const escBase = enters(fe);
  check("(E) no escalation before the bound", escalations(ESC1).length === 0);
  check("(E) escalation fires after the bound", await waitUntil(() => escalations(ESC1).length === 1, ESCALATE_MS * 8));
  const escInfo = escalations(ESC1)[0]?.info ?? {};
  check("(E) the escalation is mid-session, names the signature, carries the held duration", escInfo.phase === "mid-session" && escInfo.escalation === true && escInfo.signatureName === "unknown-modal" && escInfo.timeoutMs >= ESCALATE_MS - 50);
  check("(E) it is one-shot (its timer is spent) and the hold STAYS (never times out into the Enter ladder)",
    host.live.get(ESC1).midSessionModal?.escalateTimer === null && held(ESC1) && enters(fe) === escBase);
  // a hold released BEFORE the bound never escalates (paired with the escalation observed above)
  const watch = { id: "sess-no-escalate" };
  const { f: fn } = await holdSession(watch.id, "worker");
  void fn;
  host.releaseModalHoldByHuman(watch.id, { force: true }); // human releases inside the bound
  const never = await assertNeverWithControl({
    label: "(E) a hold released inside the bound never escalates",
    check: () => escalations(watch.id).length > 0,
    windowMs: ESCALATE_MS * 3,
    positiveControl: async () => {
      const id = "sess-escalate-control";
      await holdSession(id, "worker");
      const prev = watch.id; watch.id = id;
      const r = await pollUntil(() => escalations(id).length > 0, { timeoutMs: ESCALATE_MS * 8, intervalMs: 10 });
      watch.id = prev;
      return r;
    },
  });
  check("(E) a hold released inside the bound never escalates", never);

  // ============ F) engage gating ============
  // F1: pre-SessionStart (not past boot) — the boot detector owns it; this path never engages
  const BOOT = "sess-preboot";
  const fb = spawnOne(BOOT, "manager", { pastBoot: false });
  fb.feed(MODAL);
  host.submit(BOOT, "hello preboot");
  check("(F1) not past boot: the unconfirmed delivery runs the ordinary retry ladder (no mid-session hold)", await waitUntil(() => enters(fb) > 1, 3000) && midEvents(BOOT).length === 0 && host.live.get(BOOT).midSessionModal == null);
  // F2: stale frame at delivery time
  const STL = "sess-stale";
  const fs2 = spawnOne(STL, "manager");
  fs2.feed(MODAL); fs2.feed(COMPOSER_BOX);
  await waitUntil(() => host.live.get(STL).modalCandidate == null, SETTLE_MS * 20); // the dismissal settles first (a submit INSIDE the window is refused: see section K)
  host.submit(STL, "hello stale");
  check("(F2) stale frame (modal long scrolled past): ordinary retry ladder, no event", await waitUntil(() => enters(fs2) > 1, 3000) && midEvents(STL).length === 0);
  // F3: a footer quoted in an agent reply, followed by the composer box
  const QTE = "sess-quoted";
  const fq = spawnOne(QTE, "manager");
  fq.feed("● The dialog says: Enter to confirm · Esc to cancel" + COMPOSER_BOX);
  host.submit(QTE, "hello quoted");
  check("(F3) a quoted footer in ordinary output never engages (ordinary retry ladder)", await waitUntil(() => enters(fq) > 1, 3000) && midEvents(QTE).length === 0);
  // F4: the session's OWN echoed prompt carrying the footer text
  const ECH = "sess-echo";
  const fx = spawnOne(ECH, "manager");
  host.submit(ECH, echoed);
  fx.feed("> " + echoed); // the engine echoing what Loom just typed, nothing after it
  check("(F4) the session's own echoed lastPrompt never engages the hold", await waitUntil(() => enters(fx) > 1, 3000) && midEvents(ECH).length === 0);
  // F5: role-less (plain / owner-interactive) sessions are not covered
  const PLN = "sess-plain";
  const fpl = spawnOne(PLN, null);
  fpl.feed(MODAL);
  host.submit(PLN, "hello plain");
  check("(F5) plain (role-less) session: ordinary retry ladder, no event", await waitUntil(() => enters(fpl) > 1, 3000) && midEvents(PLN).length === 0);

  // ============ G) the REAL incident shape: the modal sat on screen for a while (status repaints streamed
  // ============    over it, pushing it far past any sliding window) BEFORE a delivery failed ============
  const REAL = "sess-real-modal";
  const fr = spawnOne(REAL, "manager");
  fr.feed(REAL_FIRST_SCREEN_RAW);
  for (let n = 0; n < 40; n++) fr.feed(REAL_STATUS_REPAINT_AFTER); // ~7K of repaints: the modal text is long gone from any 3000-char tail
  host.submit(REAL, "report arrives while the modal is up");
  check("(G) real captured modal + many status repaints BEFORE the delivery: still engages the hold", await waitUntil(() => midEvents(REAL).length === 1, 3000));
  const realBase = enters(fr);
  for (let n = 0; n < 40; n++) fr.feed(REAL_STATUS_REPAINT_AFTER);
  check("(G) while held, further status repaints never release the hold (a sliding window would have)", held(REAL));
  check("(G) ...and nothing more was written", enters(fr) === realBase);
  fr.feed(COMPOSER_BOX);
  check("(G) the redrawn composer box + settle does NOT release an engaged hold (paired with a control)", await staysHeld("(G) engaged hold stays after box + settle", REAL));
  host.deliverHook(REAL, { hook_event_name: "UserPromptSubmit", session_id: `eng-${REAL}`, prompt: "x" });
  check("(G) a UserPromptSubmit (the engine accepted a prompt) releases it", host.live.get(REAL).midSessionModal === null);

  // ============ H) what clears the FROZEN candidate (besides a redrawn composer box / full-screen erase) ============
  const cand = (id) => host.live.get(id).modalCandidate;
  const HK = "sess-cand-hook";
  const fk = spawnOne(HK, "manager"); fk.feed(MODAL);
  check("(H) a footer-completing chunk freezes a candidate", cand(HK) != null && cand(HK).signature === "unknown-modal");
  host.deliverHook(HK, { hook_event_name: "Notification", session_id: "eng-sess-cand-hook" });
  check("(H) a Notification hook does NOT clear it (it can announce the modal)", cand(HK) != null);
  host.deliverHook(HK, { hook_event_name: "PreToolUse", session_id: "eng-sess-cand-hook", tool_name: "Read" });
  host.deliverHook(HK, { hook_event_name: "Stop", session_id: "eng-sess-cand-hook" });
  check("(H) mid-turn hooks (PreToolUse/Stop) do NOT clear it", cand(HK) != null);
  fk.feed(COMPOSER_BOX);
  host.deliverHook(HK, { hook_event_name: "UserPromptSubmit", session_id: "eng-sess-cand-hook", prompt: "p" });
  check("(H) a UserPromptSubmit (the engine accepted a prompt) clears it", cand(HK) == null);
  host.submit(HK, "after a hook");
  check("(H) ...so a later unconfirmed delivery runs the ordinary ladder, never the hold", await waitUntil(() => enters(fk) > 1, 3000) && midEvents(HK).length === 0);
  const HU = "sess-cand-human";
  const fu2 = spawnOne(HU, "manager"); fu2.feed(MODAL);
  host.writeStdin(HU, "x");
  check("(H) human terminal input does NOT clear it (raw bytes are not evidence)", cand(HU) != null);
  const relH = host.releaseModalHoldByHuman(HU, { force: true });
  check("(H) the explicit human release clears a candidate-only episode", relH.released && !relH.held && relH.candidate && cand(HU) == null);
  host.submit(HU, "after human release");
  check("(H) ...and no hold follows (ordinary ladder)", await waitUntil(() => enters(fu2) > 1, 3000) && midEvents(HU).length === 0);
  const HC = "sess-cand-composer";
  const fc3 = spawnOne(HC, "manager"); fc3.feed(MODAL);
  host.enqueueStdin(HC, "composer text", "human");
  check("(H) a human composer entry does NOT clear it (the composer is not the terminal)", cand(HC) != null);
  const HE = "sess-cand-erase";
  const fe2 = spawnOne(HE, "manager"); fe2.feed(MODAL); fe2.feed("\x1b[2J" + ORDINARY);
  check("(H) a full-screen erase alone does NOT clear it (the TUI erases and redraws a still-up modal)", cand(HE) != null);

  // ============ I) C1: erase / Ctrl-L / cursor-home are NOT dismissal; only a composer box AFTER the footer is ============
  const holdReal = async (id) => { const f = spawnOne(id, "manager"); f.feed(REAL_FIRST_SCREEN_RAW); host.submit(id, `report ${id}`); await waitUntil(() => midEvents(id).length === 1, 3000); return f; };
  for (const [label, run] of [
    ["erase + REAL modal redraw in ONE chunk", (f) => f.feed("\x1b[2J\x1b[3J\x1b[H" + REAL_FIRST_SCREEN_RAW)],
    ["erase, then the REAL modal redraw in a SECOND chunk", (f) => { f.feed("\x1b[2J\x1b[H"); f.feed(REAL_FIRST_SCREEN_RAW); }],
    ["erase + composer box + REAL modal (box BEFORE the footer)", (f) => f.feed("\x1b[2J" + COMPOSER_BOX + REAL_FIRST_SCREEN_RAW)],
    ["cursor-home + a status repaint (no erase at all)", (f) => f.feed("\x1b[H\x1b[1;1H" + REAL_STATUS_REPAINT_AFTER.repeat(5))],
  ]) {
    const id = `sess-c1-${label.length}-${label.charCodeAt(0)}`;
    const f = await holdReal(id);
    const base = enters(f);
    run(f);
    check(`(I) ${label}: hold kept, no resolved release`, held(id) && host.live.get(id).midSessionModal != null && host.live.get(id).modalCandidate != null);
    check(`(I) ${label}: Enter count unchanged`, enters(f) === base);
  }
  // the viewer-attach Ctrl-L path: host.repaint() writes Ctrl-L (exempt), the TUI erases + redraws the modal
  const CL = "sess-c1-ctrl-l";
  const fcl = await holdReal(CL);
  const clBase = enters(fcl);
  host.repaint(CL);
  check("(I) host.repaint() wrote the Ctrl-L (exempt from the hold)", fcl.writes.includes("\x0c"));
  fcl.feed("\x1b[2J\x1b[H" + REAL_FIRST_SCREEN_RAW);
  fcl.feed(REAL_STATUS_REPAINT_AFTER.repeat(3));
  check("(I) repaint then the modal repaint: hold kept and NO Enter", held(CL) && enters(fcl) === clBase);
  fcl.feed("\x1b[2J" + REAL_FIRST_SCREEN_RAW + COMPOSER_BOX);
  check("(I) a composer box AFTER the footer is NOT enough to release an engaged hold (paired with a control)", await staysHeld("(I) engaged hold stays after box + settle", CL));
  host.deliverHook(CL, { hook_event_name: "UserPromptSubmit", session_id: `eng-${CL}`, prompt: "x" });
  check("(I) positive control: a UserPromptSubmit releases it", host.live.get(CL).midSessionModal === null);

  // ============ J) the footer's last word split across chunks ("can|cel") still snapshots ============
  const SP = "sess-split-footer";
  const fsp = spawnOne(SP, "manager");
  const cut = REAL_FIRST_SCREEN_RAW.lastIndexOf("cancel") + 3; // "...can" | "cel..."
  fsp.feed(REAL_FIRST_SCREEN_RAW.slice(0, cut));
  check("(J) before the footer completes there is no candidate", host.live.get(SP).modalCandidate == null);
  fsp.feed(REAL_FIRST_SCREEN_RAW.slice(cut));
  check("(J) the split 'can|cel' footer is recognized once the tail END completes it", host.live.get(SP).modalCandidate != null);
} finally {
  for (const id of ids) { try { host.stop(id, "hard"); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\n✅ ALL PASS — mid-session modal detector + hold (card 20ff76de)" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
