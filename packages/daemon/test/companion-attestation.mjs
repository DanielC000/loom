// Companion injection-guard PRIMITIVES B + C (Companion Capability & Permission-Lever Framework §3,
// card 8e511951) — PURE unit tests, no pty/db/daemon. Primitive A (getActiveTurnOwnerText) is exercised
// through the REAL turn-formation path in pty-owner-attestation.mjs, not here.
//
// B — isVerbatimOwnerSubstring: a PURE checker that an owner-words arg is a normalized-whitespace VERBATIM
// substring of what the owner actually said this turn — "relay, don't author".
// C — OwnerConfirmStore: the propose→confirm round-trip for the highest-risk ACT levers, short-TTL and
// single-use, keyed to (sessionId, route, capability) — mirrors companion_pairing_codes' server-side
// discipline, `capability` namespacing two different levers proposing on the same (session, route) at
// once (CR hardening, card a8ddd6d2).
//
// RUN (no daemon needed): node test/companion-attestation.mjs  (build first: from packages/daemon `pnpm build`).
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { isVerbatimOwnerSubstring, isVerbatimOwnerSubstringRecent, OwnerConfirmStore, AuthoredContentGrantStore } = await import("../dist/companion/attestation.js");

// ===== Primitive B — isVerbatimOwnerSubstring =====
{
  check("B: exact verbatim match", isVerbatimOwnerSubstring("approve the merge", "please approve the merge now") === true);
  check(
    "B: whitespace-normalized match (extra/irregular spacing on both sides)",
    isVerbatimOwnerSubstring("approve   the\tmerge", "please  approve the merge   now") === true,
  );
  check("B: case-mismatch is REJECTED (case-sensitive on content)", isVerbatimOwnerSubstring("Approve the merge", "please approve the merge now") === false);
  check("B: a non-substring claim is REJECTED", isVerbatimOwnerSubstring("reject the merge", "please approve the merge now") === false);
  check("B: null owner text (no owner-authored turn) is REJECTED", isVerbatimOwnerSubstring("approve the merge", null) === false);
  check("B: an empty candidate is REJECTED (never a meaningful verbatim quote)", isVerbatimOwnerSubstring("", "please approve the merge now") === false);
  check("B: a whitespace-only candidate (space) is REJECTED, not treated as an empty-substring match-all", isVerbatimOwnerSubstring("   ", "please approve the merge now") === false);
  check("B: a whitespace-only candidate (tab/newline) is REJECTED too", isVerbatimOwnerSubstring("\t\n", "please approve the merge now") === false);
  check("B: owner text alone (candidate === ownerText) matches", isVerbatimOwnerSubstring("approve", "approve") === true);
}

// ===== Primitive C — OwnerConfirmStore =====
{
  // Injectable clock so TTL expiry is deterministic — no real sleeps.
  let nowMs = 1_000_000;
  const store = new OwnerConfirmStore({ now: () => nowMs, random: () => 0 }); // random:()=>0 ⇒ deterministic token

  const sessionId = "sess-owner-confirm";
  const route = { channel: "in-app", chatId: "cockpit" };
  const capability = "decisions-relay";

  // --- propose -> confirm commits once ---
  const proposed = store.propose({ sessionId, route, capability, summary: "Resolve decision X as approve?" });
  check("C: propose returns a token embedded in promptText", proposed.promptText.includes(proposed.token));
  const firstConfirm = store.confirm({ sessionId, route, capability, ownerText: `yes CONFIRM ${proposed.token} please` });
  check("C: a matching confirm COMMITS", firstConfirm.committed === true && firstConfirm.summary === "Resolve decision X as approve?");

  // --- second confirm rejected (single-use) ---
  const secondConfirm = store.confirm({ sessionId, route, capability, ownerText: `yes CONFIRM ${proposed.token} please` });
  check("C: a SECOND confirm with the same token is REJECTED (single-use)", secondConfirm.committed === false && secondConfirm.reason === "no-pending");

  // --- expired proposal rejected (TTL) ---
  const expiring = store.propose({ sessionId, route, capability, summary: "Expiring proposal", ttlMs: 1000 });
  nowMs += 1001; // advance the fake clock PAST the TTL
  const expiredConfirm = store.confirm({ sessionId, route, capability, ownerText: `CONFIRM ${expiring.token}` });
  check("C: a confirm AFTER the TTL elapsed is REJECTED (expired)", expiredConfirm.committed === false && expiredConfirm.reason === "expired");
  const expiredRetry = store.confirm({ sessionId, route, capability, ownerText: `CONFIRM ${expiring.token}` });
  check("C: an expired proposal is single-use-cleaned (no lingering re-confirm)", expiredRetry.committed === false && expiredRetry.reason === "no-pending");

  // --- confirm on a different session/route rejected ---
  const scoped = store.propose({ sessionId, route, capability, summary: "Scoped to one session+route" });
  const wrongSession = store.confirm({ sessionId: "sess-someone-else", route, capability, ownerText: `CONFIRM ${scoped.token}` });
  check("C: a confirm from a DIFFERENT session is REJECTED (no-pending)", wrongSession.committed === false && wrongSession.reason === "no-pending");
  const wrongRoute = store.confirm({ sessionId, route: { channel: "telegram", chatId: "tg-1" }, capability, ownerText: `CONFIRM ${scoped.token}` });
  check("C: a confirm from a DIFFERENT route (same session) is REJECTED (no-pending)", wrongRoute.committed === false && wrongRoute.reason === "no-pending");
  const rightRoute = store.confirm({ sessionId, route, capability, ownerText: `CONFIRM ${scoped.token}` });
  check("C: the ORIGINAL (session, route) still commits after the wrong ones were rejected", rightRoute.committed === true);

  // --- a token-mismatch leaves the proposal standing (a legitimate retry works within TTL) ---
  const retryable = store.propose({ sessionId, route, capability, summary: "Retryable on typo" });
  const typo = store.confirm({ sessionId, route, capability, ownerText: "CONFIRM totally-wrong-code" });
  check("C: a WRONG token is rejected but does not consume the pending proposal", typo.committed === false && typo.reason === "token-mismatch");
  const retry = store.confirm({ sessionId, route, capability, ownerText: `CONFIRM ${retryable.token}` });
  check("C: the SAME proposal can still be confirmed correctly after a mismatched attempt", retry.committed === true);

  // --- CR hardening (card a8ddd6d2): capability namespacing — two DIFFERENT levers proposing on the SAME
  // (session, route) at once must never clobber each other's pending token. A VARYING random source is
  // used here (unlike the fixed `random: () => 0` store above) so the two levers' minted tokens are
  // actually distinct — with a fixed random source both tokens would trivially be identical strings,
  // which would let a WRONG-capability confirm "accidentally" match the other lever's own proposal and
  // mask a real namespacing bug. ---
  {
    let seed = 0;
    const nsStore = new OwnerConfirmStore({ now: () => nowMs, random: () => { seed = (seed + 0.13) % 1; return seed; } });
    const nsA = nsStore.propose({ sessionId, route, capability: "decisions-relay", summary: "Lever A's action" });
    const nsB = nsStore.propose({ sessionId, route, capability: "board-write", summary: "Lever B's action" });
    check("C namespacing: two levers' tokens on the same (session,route) are DIFFERENT (not clobbered)", nsA.token !== nsB.token);
    // board-write DOES have its OWN pending proposal (nsB) — so this is a token-mismatch against THAT
    // proposal, not "no-pending"; the meaningful assertion is that it does NOT commit lever A's action
    // under lever B's capability namespace.
    const confirmWrongCapability = nsStore.confirm({ sessionId, route, capability: "board-write", ownerText: `CONFIRM ${nsA.token}` });
    check("C namespacing: confirming lever A's token under lever B's capability does NOT commit", confirmWrongCapability.committed === false && confirmWrongCapability.reason === "token-mismatch");
    const confirmA = nsStore.confirm({ sessionId, route, capability: "decisions-relay", ownerText: `CONFIRM ${nsA.token}` });
    check("C namespacing: confirming lever A's token under lever A's OWN capability still commits", confirmA.committed === true && confirmA.summary === "Lever A's action");
    const confirmB = nsStore.confirm({ sessionId, route, capability: "board-write", ownerText: `CONFIRM ${nsB.token}` });
    check("C namespacing: lever B's own proposal is UNTOUCHED by lever A's propose/confirm and still commits", confirmB.committed === true && confirmB.summary === "Lever B's action");
  }
}

// ===== Primitive A/B widening (card 2b26035c) — isVerbatimOwnerSubstringRecent =====
{
  const recent = ["Creative projects for the new client", "no, creating a new project structure", "ok thanks"];
  check("recent: a candidate verbatim in an OLDER (not the most-recent) turn matches", isVerbatimOwnerSubstringRecent("creating a new project structure", recent) === true);
  check("recent: a candidate verbatim in the MOST-recent turn also matches", isVerbatimOwnerSubstringRecent("ok thanks", recent) === true);
  check("recent: a candidate that appears in NO recent turn is REJECTED", isVerbatimOwnerSubstringRecent("delete the production database", recent) === false);
  check("recent: an empty window (no owner turns yet) REJECTS everything", isVerbatimOwnerSubstringRecent("anything", []) === false);
  check("recent: an empty candidate is REJECTED (mirrors Primitive B)", isVerbatimOwnerSubstringRecent("", recent) === false);
  // Security regression: candidates must be checked against EACH turn independently, never a
  // concatenation — so a phrase that only exists by stitching the END of one turn to the START of
  // another must NOT match (a real owner never said that contiguously in one authenticated turn).
  const boundary = ["please approve the", "merge request now"];
  check("recent: a candidate spanning a TURN BOUNDARY (never said contiguously) is REJECTED — no cross-turn concatenation", isVerbatimOwnerSubstringRecent("approve the merge request", boundary) === false);
}

// ===== Direction (a), card 2b26035c — AuthoredContentGrantStore =====
{
  const store = new AuthoredContentGrantStore();
  const sid = "sess-grant";
  const proj = "proj-a";

  check("grant: no grant yet ⇒ hasGrant false", store.hasGrant(sid, proj) === false);
  store.grant(sid, proj, "once");
  check("grant: hasGrant true after granting 'once'", store.hasGrant(sid, proj) === true);
  check("grant: a PEEK (hasGrant) does not consume it — still true on a second peek", store.hasGrant(sid, proj) === true);
  store.consumeIfOnce(sid, proj);
  check("grant: 'once' scope is consumed after consumeIfOnce", store.hasGrant(sid, proj) === false);

  store.grant(sid, proj, "session");
  store.consumeIfOnce(sid, proj);
  check("grant: 'session' scope survives consumeIfOnce (only 'once' is consumed)", store.hasGrant(sid, proj) === true);

  const otherProj = "proj-b";
  check("grant: scoped per-project — a grant on proj-a does NOT leak to proj-b", store.hasGrant(sid, otherProj) === false);

  const otherSess = "sess-other";
  store.grant(sid, proj, "session");
  check("grant: scoped per-session too — a grant for sess-grant does NOT leak to sess-other", store.hasGrant(otherSess, proj) === false);

  store.clearSession(sid);
  check("grant: clearSession revokes every grant held for that session", store.hasGrant(sid, proj) === false);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Primitive B (verbatim-substring, including its recent-turns widening) and Primitive C (owner-confirm round-trip) behave per the Companion Capability & Permission-Lever Framework §3; the inline authored-content grant store (Direction (a), card 2b26035c) scopes per (session, project) and honors once/session semantics."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
