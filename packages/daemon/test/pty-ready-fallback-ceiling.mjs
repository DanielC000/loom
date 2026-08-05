import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c469d54e — DoD-2's residual liveness guarantee, isolated in its own process.
//
// pty-ready-fallback-race.mjs proves the RE-ARMED, cycle-scoped fallback (MODE_CYCLE_FALLBACK_MS) closes
// the incident's actual race. This file proves the SEPARATE absolute-ceiling mechanism
// (READY_FALLBACK_ABSOLUTE_CEILING_MS, measured from spawn) is what still bounds the worst case this fix
// does NOT eliminate — a SessionStart so severely delayed, or a cycle so thoroughly stuck, that neither the
// re-armed timer's own generous budget nor cycleToMode's own internal give-up would release a queued
// kickoff in reasonable time. Split into its own file because host.ts reads these constants from
// `process.env` ONCE AT IMPORT — pty-ready-fallback-race.mjs needs MODE_CYCLE_FALLBACK_MS generous (so a
// HEALTHY cycle there completes on its own, un-interrupted) while this file needs it deliberately tiny
// RELATIVE to an enormous MODE_CYCLE_FALLBACK_MS and an enormous cycleToMode give-up budget, to prove the
// ceiling — not either of those — is what produces readiness. The two configurations cannot coexist in one
// process.
//
// RUN: pnpm build (from packages/daemon) then `node test/pty-ready-fallback-ceiling.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-ready-fallback-ceiling-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_READY_FALLBACK_MS = "200"; // irrelevant here — SessionStart fires promptly, cancelling it quickly either way
process.env.LOOM_MODE_CYCLE_FALLBACK_MS = "60000"; // deliberately far larger than the ceiling under test below
process.env.LOOM_READY_FALLBACK_ABSOLUTE_CEILING_MS = "250"; // the mechanism actually under test
process.env.LOOM_RESUME_MODE_POLL_MS = "40";
process.env.LOOM_RESUME_MODE_MAX_POLLS = "500"; // cycleToMode's OWN give-up: 500 × 40ms = 20s — far past the 250ms ceiling
// logLandedMode's OWN footer-read poll gates kickoff delivery — left at its 500ms×8-attempt default, a
// session whose footer is never fed (as here) burns ~4s on that poll alone. Fast here so the wait budget
// below reflects the CEILING mechanism, not an unrelated poll's default pacing.
process.env.LOOM_MODE_LOG_POLL_MS = "5";

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

const PASTE_START = "\x1b[200~";
const SHIFT_TAB = "\x1b[Z";

const fakes = [];
class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    const writes = [];
    const fake = { ...base, write: (d) => writes.push(d), writes };
    fakes.push(fake);
    return fake;
  }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);
const writtenOf = (fake) => fake.writes.filter((w) => typeof w === "string").join("");
const countIn = (fake, marker) => writtenOf(fake).split(marker).length - 1;
const countShiftTabs = (fake) => fake.writes.filter((w) => w === SHIFT_TAB).length;

try {
  const B = "ceiling-B";
  const KICKOFF = "orchestrate task — must still land eventually via the absolute ceiling";
  host.spawn({
    sessionId: B, cwd: tmpHome, startupPrompt: KICKOFF,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 2 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  const fb = fakes[fakes.length - 1];
  // Deliberately feed NOTHING — the footer never becomes readable, so cycleToMode's own give-up
  // (~20s, per RESUME_MODE_MAX_POLLS above) cannot fire within this test's own budget on its own, and the
  // cycle-scoped re-armed timer (60s) can't either — only the 250ms absolute ceiling can.
  host.deliverHook(B, { hook_event_name: "SessionStart", session_id: "eng-B" });
  check("the absolute ceiling still delivers the kickoff, without waiting for the far-larger cycle-scoped or cycleToMode give-up budgets",
    await waitUntil(() => countIn(fb, PASTE_START) === 1, { timeoutMs: 3000, label: "kickoff delivered via the absolute ceiling" }));
  // CODE REVIEW CORRECTION (2026-08-05): this used to say "0 presses — footer never became readable; its
  // own give-up needs ~20s" — misattributed. The ceiling fires at ~246ms (boundedDelay = min(60000,
  // 250-elapsed)), which is BEFORE cycleToMode's fixed, non-overridable 700ms post-SessionStart settle
  // (MODE_CYCLE_SETTLE_MS) has even elapsed — cycleToMode's `awaitReadable` hasn't taken its FIRST
  // scheduled read yet at that point, so 0 presses here reflects "the cycle hasn't started deciding
  // anything yet", not "it tried, found the footer unreadable, and gave up". The conclusion (the CEILING,
  // not the cycle, produced readiness) is still correct — timing alone proves it: delivery lands within
  // this test's 3000ms budget, far short of both the 60000ms cycle-scoped budget and the ~20000ms
  // cycleToMode give-up RESUME_MODE_MAX_POLLS(500) is sized for.
  check("at delivery time cycleToMode had NOT even started deciding (0 presses — the 250ms ceiling fires before the fixed 700ms settle elapses) — the CEILING, not the cycle, produced readiness",
    countShiftTabs(fb) === 0);
  try { host.stop(B, "hard"); } catch { /* ignore */ }
} finally {
  try { host.stop("ceiling-B", "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the absolute ceiling (READY_FALLBACK_ABSOLUTE_CEILING_MS, from spawn) independently "
    + "guarantees a queued kickoff is never stranded forever, even when both the cycle-scoped fallback "
    + "budget and cycleToMode's own internal give-up are configured far larger than it — the ceiling alone "
    + "produced this delivery, proven by the cycle never having pressed at all when it landed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
