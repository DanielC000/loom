// Hermetic regression test for card d9d6fc8a, item ① — "a clamp on the conservative composer-dirty
// field silently manufactures the false zero it guards" (pty/host.ts, clearComposerDirtyOnConfirm).
//
// THE GAP (card body): `composerDirtyLen === Σ composerDirtyMarkedGens.values()` is an invariant
// maintained by every write site to the field — so `clearComposerDirtyOnConfirm`'s subtraction
// (`live.composerDirtyLen = Math.max(0, live.composerDirtyLen - resolved)`) can never legitimately
// underflow. Pre-fix code clamped it anyway, silently, with no distinguishing signal from the
// EXPECTED clamp on `composerDirtyLenBelieved` (which genuinely can read lower than the marked sum —
// see that field's own doc). A future invariant break on `composerDirtyLen` would therefore floor
// SILENTLY at exactly the false "composer clean" zero this whole family of fields exists to prevent.
//
// THIS TEST proves the fix: it deliberately breaks the invariant (composerDirtyMarkedGens holds more
// than composerDirtyLen currently tracks — something that cannot happen via any real write path, so we
// force it directly on `live`) and confirms clearComposerDirtyOnConfirm now logs a loud, identifiable
// `console.error` INVARIANT VIOLATION line before flooring — instead of floating past silently.
//
// TWO CONTROLS:
//  - NEGATIVE: a normal, invariant-respecting resolve (resolved <= composerDirtyLen, the only shape any
//    real write path ever produces) must NOT log an invariant violation — proving the check doesn't fire
//    on ordinary confirms.
//  - POSITIVE (the case above): the deliberately-broken invariant DOES fire the check, and immediately
//    afterward `composerDirtyLen` still floors to exactly 0 (never negative) — the diagnostic is
//    additive, not a behavior change to the floor itself.
//
// RED-PROOF: verified this test's positive-control assertion (the console.error line) fails against
// pre-fix code via the sanctioned `git diff`/`git checkout HEAD --`/`git apply` revert recipe (this repo
// shares one stash stack across worktrees — never `git stash`): pre-fix code silently floors with no
// matching console.error line at all, so the positive-control assertion goes RED, exactly as expected.
//
// RUN (daemon must be built first — reads ../dist/pty/host.js): from packages/daemon, `pnpm build` then
// `node test/pty-composerdirtylen-invariant-violation-loud.mjs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-composerdirtylen-invariant-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");

// Card pty-healifstuck-clear.mjs's own pattern: intercept console.error/log to capture [submit] lines
// without silencing them (still forwards to the real console).
const submitLog = [];
const realConsoleLog = console.log.bind(console);
const realConsoleError = console.error.bind(console);
console.log = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleLog(...args); };
console.error = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("[submit]")) submitLog.push(args[0]); realConsoleError(...args); };
const invariantViolationLines = () => submitLog.filter((l) => l.includes("INVARIANT VIOLATION"));

class TestPtyHost extends createSeamHost(PtyHost) {
  createPty(opts) {
    const base = super.createPty(opts);
    return { ...base, write: () => {} }; // never emits output — no real engine activity needed for this test
  }
}

const events = {
  onEngineSessionId() {}, onBusy() {}, onContextStats() {},
  onRateLimited() {}, onExit() {},
};

const host = new TestPtyHost(events);
function spawnReady(sessionId) {
  host.spawn({
    sessionId, cwd: tmpHome,
    permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
    geometry: { cols: 120, rows: 40 }, sessionEnv: {},
  });
  host.deliverHook(sessionId, { hook_event_name: "SessionStart" });
}

try {
  const SID = "sess-invariant-violation";
  spawnReady(SID);
  const live = host.live.get(SID);

  // ===== NEGATIVE CONTROL: an ordinary, invariant-respecting resolve must NOT log a violation ==========
  live.composerDirtyMarkedGens = new Map([[1, 50]]);
  live.composerDirtyLen = 50;
  live.composerDirtyLenBelieved = 50;
  host["clearComposerDirtyOnConfirm"](SID, live, 1, true);
  check("negative control: an ordinary resolve (resolved === composerDirtyLen) logs NO invariant violation",
    invariantViolationLines().length === 0);
  check("negative control: composerDirtyLen resolved to exactly 0, the expected non-violating outcome",
    host.getComposerDirtyLen(SID) === 0 && host.getComposerDirtyLenBelieved(SID) === 0);

  // ===== POSITIVE CONTROL: deliberately break the invariant — composerDirtyMarkedGens holds MORE than ===
  // ===== composerDirtyLen currently tracks. No real write path can produce this (every additive site sets
  // ===== a NEW map entry of the SAME amount it adds to the scalar; every full-reset site clears both
  // ===== together — see the field's own doc) — this is forced directly on `live` to prove the diagnostic
  // ===== fires if that invariant ever DOES break, rather than trusting it can never happen.
  live.composerDirtyMarkedGens = new Map([[2, 100]]);
  live.composerDirtyLen = 40; // deliberately LESS than the 100 the map says gen 2 is owed
  live.composerDirtyLenBelieved = 40;
  host["clearComposerDirtyOnConfirm"](SID, live, 2, true);
  const violations = invariantViolationLines();
  check("THE FIX — a broken invariant (resolved=100 > composerDirtyLen=40) logs a LOUD INVARIANT "
    + "VIOLATION line — this is the assertion that goes RED against pre-fix code, which silently floors "
    + "with no matching console.error line at all",
    violations.length === 1);
  check("the violation line names both the stale composerDirtyLen value and the resolved amount that "
    + "exceeded it, so the diagnostic is actionable, not just a bare trip",
    violations[0]?.includes("composerDirtyLen (40)") && violations[0]?.includes("resolved (100)"));
  check("POST-DIAGNOSIS: composerDirtyLen still floors to exactly 0 (never negative) — the LOUD signal is "
    + "additive, not a change to the safe floor itself",
    host.getComposerDirtyLen(SID) === 0);
  check("composerDirtyLenBelieved's OWN clamp (expected, undocumented-as-violation) also floors to 0, "
    + "with no violation line of its own — only composerDirtyLen's clamp is treated as an invariant break",
    host.getComposerDirtyLenBelieved(SID) === 0);
} finally {
  try { host.stop("sess-invariant-violation", "hard"); } catch { /* ignore */ }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — composerDirtyLen's clamp is a LOUD backstop (logs an INVARIANT VIOLATION line before "
    + "flooring) while composerDirtyLenBelieved's clamp stays silent, the expected case documented at its "
    + "own site."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
