// Claude-free regression guard for card d0c1e76d — a `default` permission-mode climb must be confirmed
// POSITIVELY. `default` has no footer label, so the old whole-ring "last labeled token wins" read left a
// dropped FINAL Shift+Tab (auto → default) indistinguishable from success: the session stayed in `auto`
// (MORE permissive) undetected. The cycle now reads only bytes written AFTER each press and fails toward
// visible: anything short of a COMPLETE unlabeled default footer is `unknown`, and a `default` target that
// does not end `default` files the durable mode-mismatch (reportModeMismatch → claude_boot_dialog_stuck).
//
// Drives the REAL PtyHost state machine against a FAKE pty at the createPty() seam (mirrors
// pty-mode-convergence.mjs). No real claude, no daemon, no network.
//   (a) pure detectPermissionModeSince table, incl. the ambiguous cases that must NOT read `default`
//   (b) full climb to default is confirmed `default` even though older `auto` labels sit in the ring
//   (c) dropped 3rd press (nothing repainted) → mismatch {target default, landed auto}; no 4th press
//   (d) 3rd press answered by a partial hint fragment / unrelated output → mismatch, NEVER success
//   (e) modeUnconfirmedNotice wording is direction-aware
//
// RUN: pnpm build (repo root) then `node test/pty-mode-default-confirm.mjs` from packages/daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const waitUntil = async (pred, timeoutMs, intervalMs = 20) => {
  try {
    return await sharedWaitUntil(pred, { timeoutMs, intervalMs, label: "pty-mode-default-confirm" });
  } catch (err) {
    if (err?.exhaustedOnThrow !== false) throw err;
    return false;
  }
};

const tmpHome = path.join(os.tmpdir(), `loom-pmdc-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_RESUME_MODE_POLL_MS = "40";
process.env.LOOM_RESUME_MODE_MAX_POLLS = "3";
process.env.LOOM_READY_FALLBACK_MS = "9000";

const hostMod = await import("../dist/pty/host.js");
// Tolerant of the pre-fix build (no such exports) so the RED is BEHAVIOURAL (the dropped-press scenario), not an import error.
const { PtyHost } = hostMod;
const detectPermissionModeSince = hostMod.detectPermissionModeSince ?? (() => ({ mode: "<export missing>" }));
const modeUnconfirmedNotice = hostMod.modeUnconfirmedNotice ?? (() => "<export missing>");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

// ── (a) pure table ──
const TAIL = "(shift+tab to cycle) · ← for agents";
// SYNTHETIC default footer (not a raw capture): composer-line context, then the hint + tail, no label.
const DEFAULT_FULL = "❯ Try \"how does <filepath> work?\" ──────────── " + TAIL;
const T = [
  ["complete default footer", "❯ Try \"x\"\n" + DEFAULT_FULL, "default"],
  ["complete default footer, ANSI-laden", "❯ Try x ──────── \x1b[2m(shift+tab to cycle)\x1b[0m · ← for agents", "default"],
  ["labeled auto footer (same tail) is auto, not default", "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents", "auto"],
  ["stale auto then complete default → default (later wins)", "auto mode on (shift+tab to cycle) · ← for agents" + "\n" + DEFAULT_FULL, "default"],
  ["default then later auto repaint → auto (later wins)", DEFAULT_FULL + "\nauto mode on (shift+tab to cycle) · ← for agents", "auto"],
  ["partial auto repaint carrying ONLY the hint fragment → NOT default", "(shift+tab to cycle)", "unknown"],
  // CR 1da8d056's three dist-probed fail-open inputs (each must NOT read default):
  ["corrupted label residue `automde on` before the hint → NOT default", "⏵⏵ auto mde on " + TAIL, "unknown"],
  ["label glyphs only (label text lost) before the hint → NOT default", "⏵⏵ " + TAIL, "unknown"],
  ["hint+tail-only window (no preceding context) → NOT default", TAIL, "unknown"],
  ["⏸ glyph residue before the hint → NOT default", "⏸ plan " + TAIL.replace("(", "("), "unknown"],
  ["hint fragment without opening paren → NOT default", "shift+tab to cycle) · ← for agents", "unknown"],
  ["wrap-dropped-char hint variant → NOT default", "(shift+tab tocycle) · ← for agents".replace("tocycle", "ocycle"), "unknown"],
  ["hint cut off before its tail → NOT default", "(shift+tab to cycle) · ← for", "unknown"],
  ["unrelated output, no hint → unknown", "✳ Thinking… (12s · esc to interrupt)", "unknown"],
  ["empty window → unknown", "", "unknown"],
];
for (const [label, input, expected] of T) {
  const got = detectPermissionModeSince(input).mode;
  check(`(a) ${label}: ${expected} (got ${got})`, got === expected);
}

// ── harness ──
const SHIFT_TAB = "\x1b[Z";
const ACCEPT_EDITS_FOOTER = "accept edits on (shift+tab to cycle) · ← for agents";
const PLAN_FOOTER = "plan mode on (shift+tab to cycle) · ← for agents";
const AUTO_FOOTER = "auto mode on (shift+tab to cycle) · ← for agents";
const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    let dataCb = null;
    const fake = {
      ...base, write: (d) => writes.push(d),
      onData: (cb) => { dataCb = cb; return { dispose() {} }; },
      writes,
      feed: (s) => { if (dataCb) dataCb(s); },
    };
    fakes.push(fake);
    return fake;
  }
}
const mismatches = [];
const matchedLines = [];
const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  onClaudeBootDialogStuck(sid, info) { mismatches.push({ sid, info }); },
};
const host = new TestPtyHost(events);
const cycleLines = [];
const realLog = console.log, realErr = console.error;
console.log = (...a) => { const l = a.join(" "); if (l.includes("cycle→")) cycleLines.push(l); if (l.includes(" kind=") && l.includes("matched=")) matchedLines.push(l); realLog(...a); };
console.error = (...a) => { realErr(...a); };
const countShiftTabs = (f) => f.writes.filter((w) => w === SHIFT_TAB).length;
const spawnDefault = (id, role = "manager", cycles = 3) => {
  host.spawn({
    sessionId: id, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: cycles },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {}, role,
  });
  const f = fakes[fakes.length - 1];
  f.feed(ACCEPT_EDITS_FOOTER);
  host.deliverHook(id, { hook_event_name: "SessionStart", session_id: `eng-${id}` });
  return f;
};
const climbToAuto = async (f) => {
  check("climb: 1st press", await waitUntil(() => countShiftTabs(f) === 1, 2500));
  f.feed(PLAN_FOOTER);
  check("climb: 2nd press", await waitUntil(() => countShiftTabs(f) === 2, 1000));
  f.feed(AUTO_FOOTER);
  check("climb: 3rd press (auto → default attempt)", await waitUntil(() => countShiftTabs(f) === 3, 1000));
};
const mismatchFor = (sid) => mismatches.filter((m) => m.sid === sid && m.info.modeMismatch);
const ids = ["dc-full", "dc-dropped", "dc-fragment", "dc-noise", "dc-tailonly", "dc-auto-target", "dc-worker"];
const sentText = (f) => f.writes.join("");

try {
  // (b) full climb confirmed default despite stale auto labels in the ring
  const fb = spawnDefault("dc-full");
  await climbToAuto(fb);
  fb.feed(DEFAULT_FULL);
  check("(b) cycle logs `reached` (positively confirmed default)",
    await waitUntil(() => cycleLines.some((l) => l.includes("dc-full") && l.includes("reached") && l.includes("mode=default")), 2000));
  check("(b) no mismatch filed for a confirmed default climb", mismatchFor("dc-full").length === 0);

  // (c) dropped 3rd press: nothing repainted
  const fc = spawnDefault("dc-dropped");
  await climbToAuto(fc);
  check("(c) dropped 3rd press is DETECTED: cycle ends footer-unchanged with mode=auto",
    await waitUntil(() => cycleLines.some((l) => l.includes("dc-dropped") && l.includes("footer-unchanged") && l.includes("mode=auto")), 2000));
  check("(c) durable mismatch filed {target:default, landed:auto}",
    await waitUntil(() => mismatchFor("dc-dropped").some((m) => m.info.modeMismatch.target === "default" && m.info.modeMismatch.landed === "auto"), 2000));
  check("(c) no 4th press after the give-up", countShiftTabs(fc) === 3);

  // (d) ambiguous post-press output must NOT be success
  const fd = spawnDefault("dc-fragment");
  await climbToAuto(fd);
  fd.feed("(shift+tab to cycle)"); // partial auto repaint: only the hint fragment
  check("(d) hint-fragment-only repaint is NOT accepted as default: mismatch filed, landed auto",
    await waitUntil(() => mismatchFor("dc-fragment").some((m) => m.info.modeMismatch.landed === "auto"), 2000));
  check("(d) and the cycle never logged reached for it", !cycleLines.some((l) => l.includes("dc-fragment") && l.includes("reached")));

  const fe = spawnDefault("dc-noise");
  await climbToAuto(fe);
  fe.feed("✳ Thinking… (3s · esc to interrupt)");
  check("(d) unrelated output after the press is NOT success: mismatch filed",
    await waitUntil(() => mismatchFor("dc-noise").length === 1, 2000));
  check("(d) and the cycle never logged reached for it", !cycleLines.some((l) => l.includes("dc-noise") && l.includes("reached")));

  // (d2) label BEFORE press 3's mark, only hint+tail AFTER it → mismatch, never `reached`
  const ft = spawnDefault("dc-tailonly");
  await climbToAuto(ft);
  ft.feed(TAIL);
  check("(d2) hint+tail-only window after press 3 (label only before the mark) files a mismatch, not reached",
    await waitUntil(() => mismatchFor("dc-tailonly").some((m) => m.info.modeMismatch.landed === "auto"), 2000)
    && !cycleLines.some((l) => l.includes("dc-tailonly") && l.includes("reached")));

  // (f) NON-default target (auto): a plausible `default` repaint after press 2 must not advance/overshoot
  const fa = spawnDefault("dc-auto-target", "manager", 2);
  check("(f) auto target: 1st press", await waitUntil(() => countShiftTabs(fa) === 1, 2500));
  fa.feed(PLAN_FOOTER);
  check("(f) auto target: 2nd press", await waitUntil(() => countShiftTabs(fa) === 2, 1000));
  fa.feed(DEFAULT_FULL); // a misread-able default frame (or corrupted automodeon) — must NOT trigger a 3rd press
  check("(f) cycle ends footer-unchanged at plan (no overshoot, no mismatch for a non-default target)",
    await waitUntil(() => cycleLines.some((l) => l.includes("dc-auto-target") && l.includes("footer-unchanged") && l.includes("mode=plan")), 2000)
    && countShiftTabs(fa) === 2 && mismatchFor("dc-auto-target").length === 0);

  // (g) notice / heal / matched pairing after a dropped 3rd press
  check("(g) manager (non-healable) got the MORE-permissive [loom:mode-unconfirmed] notice for auto-vs-default",
    await waitUntil(() => /mode-unconfirmed[\s\S]*MORE permissive/.test(sentText(fc)), 4000));
  check("(g) matched= is `-` when the mode came from the cycle outcome (not a ring token)",
    await waitUntil(() => matchedLines.some((l) => l.includes("dc-dropped") && l.includes("mode=auto") && l.includes("matched=-")), 3000));
  check("(g) the manager is NOT auto-healed (no 4th press)", countShiftTabs(fc) === 3);

  const fw = spawnDefault("dc-worker", "worker", 3);
  await climbToAuto(fw);
  check("(g) worker (healable) landing in auto with a default target is HEALED through cycleToMode (4th press)",
    await waitUntil(() => countShiftTabs(fw) === 4, 4000));
} finally {
  console.log = realLog;
  for (const s of ids) { try { host.stop(s, "hard"); } catch { /* ignore */ } }
}

// ── (e) wording ──
const more = modeUnconfirmedNotice("auto", "default");
check("(e) more-permissive landing names the MORE permissive direction", /MORE permissive/.test(more) && !/blocked from writes/.test(more));
check("(e) acceptEdits vs default is also more permissive", /MORE permissive/.test(modeUnconfirmedNotice("acceptEdits", "default")));
check("(e) less-permissive landing keeps the blocked-from-writes advice", /blocked from writes/.test(modeUnconfirmedNotice("plan", "auto")));

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
