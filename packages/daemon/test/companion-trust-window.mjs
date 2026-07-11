// Companion Trust Window (Companion Capability & Permission-Lever Framework — Companion→Platform-Lead
// epic, Card 0) — PURE unit tests, no pty/db/daemon. Mirrors companion-attestation.mjs's own style for
// OwnerConfirmStore: an injectable clock so TTL/cap expiry is deterministic, no real sleeps.
//
// RUN (no daemon needed): node test/companion-trust-window.mjs  (build first: from packages/daemon `pnpm build`).
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { CompanionTrustWindow, TRUST_WINDOW_IDLE_TTL_MS, TRUST_WINDOW_ABSOLUTE_CAP_MS } = await import("../dist/companion/trust-window.js");

const ROUTE = { channel: "in-app", chatId: "cockpit" };

// ===== arm / isWarm basics =====
{
  let nowMs = 1_000_000;
  const w = new CompanionTrustWindow({ now: () => nowMs });
  const key = { sessionId: "s1", route: ROUTE, senderId: null };

  check("a never-armed window is cold", w.isWarm(key) === false);
  w.arm(key);
  check("an armed window is warm immediately", w.isWarm(key) === true);
}

// ===== touch on a non-existent window is a no-op (never creates one) =====
{
  let nowMs = 1_000_000;
  const w = new CompanionTrustWindow({ now: () => nowMs });
  const key = { sessionId: "s2", route: ROUTE, senderId: null };
  w.touch(key); // no arm() first
  check("touch() on a never-armed window is a no-op — still cold", w.isWarm(key) === false);
}

// ===== idle TTL refresh via touch() =====
{
  let nowMs = 1_000_000;
  const w = new CompanionTrustWindow({ now: () => nowMs });
  const key = { sessionId: "s3", route: ROUTE, senderId: null };
  w.arm(key);
  nowMs += TRUST_WINDOW_IDLE_TTL_MS - 1; // just under the idle TTL
  check("still warm just under the idle TTL", w.isWarm(key) === true);
  w.touch(key); // refresh lastActiveAt
  nowMs += TRUST_WINDOW_IDLE_TTL_MS - 1; // another near-TTL stretch, but refreshed by touch()
  check("touch() refreshes the idle TTL — still warm after a 2nd near-TTL stretch", w.isWarm(key) === true);
}

// ===== idle TTL expiry (no touch) =====
{
  let nowMs = 1_000_000;
  const w = new CompanionTrustWindow({ now: () => nowMs });
  const key = { sessionId: "s4", route: ROUTE, senderId: null };
  w.arm(key);
  nowMs += TRUST_WINDOW_IDLE_TTL_MS + 1; // past the idle TTL, no touch() in between
  check("idle-TTL-expired window reads cold", w.isWarm(key) === false);
}

// ===== absolute cap expiry (even with continuous touch()) =====
{
  let nowMs = 1_000_000;
  const w = new CompanionTrustWindow({ now: () => nowMs });
  const key = { sessionId: "s5", route: ROUTE, senderId: null };
  w.arm(key);
  // Touch every step just under the idle TTL, repeatedly, until we cross the absolute cap — proves the
  // cap is measured from armedAt, NOT reset by activity.
  const step = TRUST_WINDOW_IDLE_TTL_MS - 1;
  let elapsed = 0;
  while (elapsed < TRUST_WINDOW_ABSOLUTE_CAP_MS - step) {
    nowMs += step;
    elapsed += step;
    w.touch(key);
  }
  check("still warm just under the absolute cap despite continuous touch()", w.isWarm(key) === true);
  nowMs += step;
  check("absolute-cap-expired window reads cold EVEN THOUGH it was touched right up to the boundary", w.isWarm(key) === false);
}

// ===== close() revokes a single window (the "/lock" primitive) =====
{
  let nowMs = 1_000_000;
  const w = new CompanionTrustWindow({ now: () => nowMs });
  const key = { sessionId: "s6", route: ROUTE, senderId: null };
  w.arm(key);
  check("armed before close()", w.isWarm(key) === true);
  w.close(key);
  check("close() revokes the window — cold again", w.isWarm(key) === false);
  // Idempotent — closing an already-cold/never-armed window doesn't throw.
  w.close(key);
  check("a second close() on an already-closed window is a harmless no-op", w.isWarm(key) === false);
}

// ===== a re-arm resets the absolute cap (a fresh window, not an extension) =====
{
  let nowMs = 1_000_000;
  const w = new CompanionTrustWindow({ now: () => nowMs });
  const key = { sessionId: "s7", route: ROUTE, senderId: null };
  const step = TRUST_WINDOW_IDLE_TTL_MS - 1; // stay under the idle TTL on every hop, isolating the cap
  w.arm(key);
  let elapsed = 0;
  while (elapsed < TRUST_WINDOW_ABSOLUTE_CAP_MS - step) {
    nowMs += step;
    elapsed += step;
    w.touch(key);
  }
  w.arm(key); // re-arm right at the point the ORIGINAL cap would have expired it
  elapsed = 0;
  while (elapsed < TRUST_WINDOW_ABSOLUTE_CAP_MS - step) {
    nowMs += step;
    elapsed += step;
    w.touch(key);
  }
  check("a re-arm resets the absolute cap from the NEW armedAt (still warm past where the OLD cap would've expired it)", w.isWarm(key) === true);
}

// ===== group-route window keyed by sender.id — one member's window never covers another's =====
{
  let nowMs = 1_000_000;
  const w = new CompanionTrustWindow({ now: () => nowMs });
  const groupRoute = { channel: "telegram", chatId: "grp-1" };
  const alice = { sessionId: "companion-1", route: groupRoute, senderId: "alice" };
  const bob = { sessionId: "companion-1", route: groupRoute, senderId: "bob" };

  w.arm(alice);
  check("alice's group window is warm", w.isWarm(alice) === true);
  check("bob's window (SAME session+route, DIFFERENT sender) is still cold — alice's arm doesn't cover bob", w.isWarm(bob) === false);

  w.arm(bob);
  check("bob can independently arm his own window", w.isWarm(bob) === true);
  w.close(alice);
  check("closing alice's window doesn't touch bob's", w.isWarm(bob) === true);
  check("alice's window is now cold", w.isWarm(alice) === false);
}

// ===== DM route: senderId omitted/null — the route itself is the identity =====
{
  let nowMs = 1_000_000;
  const w = new CompanionTrustWindow({ now: () => nowMs });
  const dmKeyOmitted = { sessionId: "companion-dm", route: { channel: "telegram", chatId: "owner-dm" } };
  const dmKeyNull = { sessionId: "companion-dm", route: { channel: "telegram", chatId: "owner-dm" }, senderId: null };
  w.arm(dmKeyOmitted);
  check("an omitted senderId and an explicit null senderId key to the SAME DM window", w.isWarm(dmKeyNull) === true);
}

// ===== different routes on the same session never share a window =====
{
  let nowMs = 1_000_000;
  const w = new CompanionTrustWindow({ now: () => nowMs });
  const routeA = { sessionId: "companion-multi", route: { channel: "telegram", chatId: "chat-a" }, senderId: null };
  const routeB = { sessionId: "companion-multi", route: { channel: "telegram", chatId: "chat-b" }, senderId: null };
  w.arm(routeA);
  check("a different route on the same session is a DIFFERENT window (still cold)", w.isWarm(routeB) === false);
}

// ===== closeAllForSession — bulk revoke (session recycle/unbind/binding-change/re-pair close paths) =====
{
  let nowMs = 1_000_000;
  const w = new CompanionTrustWindow({ now: () => nowMs });
  const sameSessionA = { sessionId: "companion-bulk", route: { channel: "telegram", chatId: "chat-a" }, senderId: null };
  const sameSessionGroupMember = { sessionId: "companion-bulk", route: { channel: "telegram", chatId: "grp" }, senderId: "carol" };
  const otherSession = { sessionId: "companion-other", route: { channel: "telegram", chatId: "chat-a" }, senderId: null };
  w.arm(sameSessionA);
  w.arm(sameSessionGroupMember);
  w.arm(otherSession);
  w.closeAllForSession("companion-bulk");
  check("closeAllForSession revokes EVERY window for that session (route A)", w.isWarm(sameSessionA) === false);
  check("closeAllForSession revokes EVERY window for that session (group member)", w.isWarm(sameSessionGroupMember) === false);
  check("closeAllForSession leaves an UNRELATED session's window untouched", w.isWarm(otherSession) === true);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
