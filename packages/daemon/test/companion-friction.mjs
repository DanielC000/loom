// Companion Capability & Permission-Lever Framework §6.2, Card 0 — the SHARED friction/tier chokepoint
// (`mayProceedWithoutConfirm`/`onStepUpCommitted`, companion/capabilities.ts) — PURE unit tests, no pty/
// db/daemon. The real per-lever end-to-end retrofit (decision_resolve's tier-split, friction:"per-action"
// override) is covered by companion-decision-resolve-friction.mjs against the REAL router.
//
// RUN (no daemon needed): node test/companion-friction.mjs  (build first: from packages/daemon `pnpm build`).
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { CompanionTrustWindow } = await import("../dist/companion/trust-window.js");
const { mayProceedWithoutConfirm, onStepUpCommitted, resolveFrictionMode, DEFAULT_FRICTION_MODE } = await import("../dist/companion/capabilities.js");

const ROUTE = { channel: "in-app", chatId: "cockpit" };
const scope = (sessionId) => ({ sessionId, route: ROUTE, senderId: null, capability: "decisions-relay" });

// ===== resolveFrictionMode =====
{
  check("absent config ⇒ DEFAULT_FRICTION_MODE (session-trust)", resolveFrictionMode({}) === DEFAULT_FRICTION_MODE);
  check("DEFAULT_FRICTION_MODE is 'session-trust'", DEFAULT_FRICTION_MODE === "session-trust");
  check("config.friction:'per-action' ⇒ per-action", resolveFrictionMode({ friction: "per-action" }) === "per-action");
  check("an unrecognized friction value degrades to the DEFAULT (never the stricter one)", resolveFrictionMode({ friction: "bogus" }) === "session-trust");
}

// ===== Tier R — never confirms, regardless of window state =====
{
  const w = new CompanionTrustWindow({ now: () => 1_000_000 });
  const s = scope("sess-r");
  check("Tier R proceeds even with a COLD window", mayProceedWithoutConfirm(w, "R", "session-trust", s) === true);
  check("Tier R proceeds under friction:'per-action' too", mayProceedWithoutConfirm(w, "R", "per-action", s) === true);
}

// ===== Tier A — flows in a warm window, arms cold with one step-up =====
{
  let nowMs = 1_000_000;
  const w = new CompanionTrustWindow({ now: () => nowMs });
  const s = scope("sess-a");

  check("Tier A on a COLD window must step up (returns false)", mayProceedWithoutConfirm(w, "A", "session-trust", s) === false);
  // Simulate the step-up committing: the lever calls onStepUpCommitted after its OWN confirmPending fires.
  onStepUpCommitted(w, "A", "session-trust", s);
  check("Tier A step-up ARMS the window", w.isWarm({ sessionId: s.sessionId, route: s.route, senderId: s.senderId }) === true);
  check("Tier A now proceeds WITHOUT a step-up (window is warm)", mayProceedWithoutConfirm(w, "A", "session-trust", s) === true);
}

// ===== Tier X — ALWAYS steps up, even inside an otherwise-warm window; never arms/extends it =====
{
  const w = new CompanionTrustWindow({ now: () => 1_000_000 });
  const s = scope("sess-x");
  // Pre-arm the window via a Tier-A step-up (as if a PRIOR general decision already warmed it).
  onStepUpCommitted(w, "A", "session-trust", s);
  check("window is warm going into the Tier-X check", w.isWarm({ sessionId: s.sessionId, route: s.route, senderId: s.senderId }) === true);
  check("Tier X ALWAYS steps up, even with a warm window", mayProceedWithoutConfirm(w, "X", "session-trust", s) === false);
  // A Tier-X step-up committing must NOT arm/extend the window.
  const before = w.isWarm({ sessionId: s.sessionId, route: s.route, senderId: s.senderId });
  onStepUpCommitted(w, "X", "session-trust", s);
  check("a Tier-X step-up commit does not touch the window (still just whatever it was before)", w.isWarm({ sessionId: s.sessionId, route: s.route, senderId: s.senderId }) === before);
}

// ===== friction:"per-action" reverts a Tier-A act to per-action confirm =====
{
  let nowMs = 1_000_000;
  const w = new CompanionTrustWindow({ now: () => nowMs });
  const s = scope("sess-per-action");
  // Warm the window as "session-trust" first (as if a DIFFERENT grant on this same session/route armed it).
  onStepUpCommitted(w, "A", "session-trust", s);
  check("window is warm", w.isWarm({ sessionId: s.sessionId, route: s.route, senderId: s.senderId }) === true);
  check("Tier A under friction:'per-action' NEVER skips the round-trip, even with a warm window", mayProceedWithoutConfirm(w, "A", "per-action", s) === false);
  // And a step-up committing under 'per-action' must not (re)arm the window either.
  const cleared = new CompanionTrustWindow({ now: () => nowMs });
  onStepUpCommitted(cleared, "A", "per-action", s);
  check("a Tier-A step-up under friction:'per-action' does NOT arm the window", cleared.isWarm({ sessionId: s.sessionId, route: s.route, senderId: s.senderId }) === false);
}

// ===== distinct sessions/routes/senders never cross-warm each other via the helper =====
{
  const w = new CompanionTrustWindow({ now: () => 1_000_000 });
  const alice = { sessionId: "sess-group", route: { channel: "telegram", chatId: "grp" }, senderId: "alice", capability: "decisions-relay" };
  const bob = { sessionId: "sess-group", route: { channel: "telegram", chatId: "grp" }, senderId: "bob", capability: "decisions-relay" };
  onStepUpCommitted(w, "A", "session-trust", alice);
  check("alice's step-up warms HER window", mayProceedWithoutConfirm(w, "A", "session-trust", alice) === true);
  check("alice's step-up does NOT warm bob's window", mayProceedWithoutConfirm(w, "A", "session-trust", bob) === false);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
