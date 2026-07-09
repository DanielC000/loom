// Companion injection-guard PRIMITIVES B + C (Companion Capability & Permission-Lever Framework §3,
// card 8e511951) — PURE unit tests, no pty/db/daemon. Primitive A (getActiveTurnOwnerText) is exercised
// through the REAL turn-formation path in pty-owner-attestation.mjs, not here.
//
// B — isVerbatimOwnerSubstring: a PURE checker that an owner-words arg is a normalized-whitespace VERBATIM
// substring of what the owner actually said this turn — "relay, don't author".
// C — OwnerConfirmStore: the propose→confirm round-trip for the highest-risk ACT levers, short-TTL and
// single-use, keyed to (sessionId, route) — mirrors companion_pairing_codes' server-side discipline.
//
// RUN (no daemon needed): node test/companion-attestation.mjs  (build first: from packages/daemon `pnpm build`).
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { isVerbatimOwnerSubstring, OwnerConfirmStore } = await import("../dist/companion/attestation.js");

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

  // --- propose -> confirm commits once ---
  const proposed = store.propose({ sessionId, route, summary: "Resolve decision X as approve?" });
  check("C: propose returns a token embedded in promptText", proposed.promptText.includes(proposed.token));
  const firstConfirm = store.confirm({ sessionId, route, ownerText: `yes CONFIRM ${proposed.token} please` });
  check("C: a matching confirm COMMITS", firstConfirm.committed === true && firstConfirm.summary === "Resolve decision X as approve?");

  // --- second confirm rejected (single-use) ---
  const secondConfirm = store.confirm({ sessionId, route, ownerText: `yes CONFIRM ${proposed.token} please` });
  check("C: a SECOND confirm with the same token is REJECTED (single-use)", secondConfirm.committed === false && secondConfirm.reason === "no-pending");

  // --- expired proposal rejected (TTL) ---
  const expiring = store.propose({ sessionId, route, summary: "Expiring proposal", ttlMs: 1000 });
  nowMs += 1001; // advance the fake clock PAST the TTL
  const expiredConfirm = store.confirm({ sessionId, route, ownerText: `CONFIRM ${expiring.token}` });
  check("C: a confirm AFTER the TTL elapsed is REJECTED (expired)", expiredConfirm.committed === false && expiredConfirm.reason === "expired");
  const expiredRetry = store.confirm({ sessionId, route, ownerText: `CONFIRM ${expiring.token}` });
  check("C: an expired proposal is single-use-cleaned (no lingering re-confirm)", expiredRetry.committed === false && expiredRetry.reason === "no-pending");

  // --- confirm on a different session/route rejected ---
  const scoped = store.propose({ sessionId, route, summary: "Scoped to one session+route" });
  const wrongSession = store.confirm({ sessionId: "sess-someone-else", route, ownerText: `CONFIRM ${scoped.token}` });
  check("C: a confirm from a DIFFERENT session is REJECTED (no-pending)", wrongSession.committed === false && wrongSession.reason === "no-pending");
  const wrongRoute = store.confirm({ sessionId, route: { channel: "telegram", chatId: "tg-1" }, ownerText: `CONFIRM ${scoped.token}` });
  check("C: a confirm from a DIFFERENT route (same session) is REJECTED (no-pending)", wrongRoute.committed === false && wrongRoute.reason === "no-pending");
  const rightRoute = store.confirm({ sessionId, route, ownerText: `CONFIRM ${scoped.token}` });
  check("C: the ORIGINAL (session, route) still commits after the wrong ones were rejected", rightRoute.committed === true);

  // --- a token-mismatch leaves the proposal standing (a legitimate retry works within TTL) ---
  const retryable = store.propose({ sessionId, route, summary: "Retryable on typo" });
  const typo = store.confirm({ sessionId, route, ownerText: "CONFIRM totally-wrong-code" });
  check("C: a WRONG token is rejected but does not consume the pending proposal", typo.committed === false && typo.reason === "token-mismatch");
  const retry = store.confirm({ sessionId, route, ownerText: `CONFIRM ${retryable.token}` });
  check("C: the SAME proposal can still be confirmed correctly after a mismatched attempt", retry.committed === true);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Primitive B (verbatim-substring) and Primitive C (owner-confirm round-trip) behave per the Companion Capability & Permission-Lever Framework §3."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
