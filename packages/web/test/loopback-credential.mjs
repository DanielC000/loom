// Hermetic unit test for the loopback-credential lock (card 093981dd). Everything asserted here lives in
// src/lib/loopbackCredential.ts, which is JSX-free so this test imports the SAME source the app ships —
// it can't drift from what renders. Run:
//   node --experimental-strip-types packages/web/test/loopback-credential.mjs
import assert from "node:assert/strict";
import {
  isCredentialGuardFailure, isCredentialGuardMessage, isCredentialSocketFailure,
  credentialLock, noteCredentialLock, clearCredentialLock, subscribeCredentialLock,
  resetCredentialLockForTest,
} from "../src/lib/loopbackCredential.ts";

let pass = 0;
const check = (name, fn) => { resetCredentialLockForTest(); fn(); pass++; console.log(`ok   ${name}`); };

// The three 401 bodies the daemon actually produces (gateway/server.ts). Copied verbatim so a daemon-side
// reword shows up here as a failing test rather than as a banner that silently stops appearing.
const GUARD_401 = "unauthorized — see `loom open` for how to obtain the local access credential";
const UNDETERMINABLE_401 = "unauthorized — peer address undeterminable";
const TRUST_TIER_401 = "unauthorized";

check("the loopback guard's own 401 is a credential failure", () => {
  assert.equal(isCredentialGuardFailure(401, GUARD_401), true);
});

// Both guard branches (the Bearer one and the WS one) send the identical string, so one constant covers
// them; what matters is that the OTHER two 401s are excluded.
check("the undeterminable-peer 401 is NOT — no credential rescues it", () => {
  assert.equal(isCredentialGuardFailure(401, UNDETERMINABLE_401), false);
});

check("the trust-tier wall's bare 401 is NOT — that caller needs a gateway token, not this secret", () => {
  assert.equal(isCredentialGuardFailure(401, TRUST_TIER_401), false);
});

check("a non-401 carrying the same words is not a credential failure", () => {
  assert.equal(isCredentialGuardFailure(403, GUARD_401), false);
  assert.equal(isCredentialGuardFailure(500, GUARD_401), false);
  assert.equal(isCredentialGuardFailure(200, GUARD_401), false);
});

check("an empty / non-JSON 401 body is not a credential failure", () => {
  assert.equal(isCredentialGuardFailure(401, ""), false);
  assert.equal(isCredentialGuardFailure(401, "/api/projects -> 401"), false);
});

// The message-only half, used by main.tsx to suppress its blocking window.alert for this one class (the
// banner already covers it). Same three bodies, same verdicts — a drift between the two would mean either
// a modal per failed write, or a genuine error silently swallowed.
check("the message-only predicate agrees with the status-aware one", () => {
  assert.equal(isCredentialGuardMessage(GUARD_401), true);
  assert.equal(isCredentialGuardMessage(UNDETERMINABLE_401), false);
  assert.equal(isCredentialGuardMessage(TRUST_TIER_401), false);
  assert.equal(isCredentialGuardMessage("/api/projects -> 500"), false, "an unrelated failure must still alert");
});

// ── socket inference ──────────────────────────────────────────────────────────
check("a rejected handshake on a token-less browser is a credential failure", () => {
  assert.equal(isCredentialSocketFailure(false, null), true);
});

check("a rejected handshake on a browser that HAS a token is not", () => {
  // The healthy host browser: it captured a token from `loom open`'s URL, so its failure is something
  // else and it must never be offered the paste field.
  assert.equal(isCredentialSocketFailure(false, "deadbeef"), false);
});

check("a mid-session disconnect is never a credential failure", () => {
  assert.equal(isCredentialSocketFailure(true, null), false);
  assert.equal(isCredentialSocketFailure(true, "deadbeef"), false);
});

// ── the lock store ────────────────────────────────────────────────────────────
check("starts unlocked", () => {
  assert.equal(credentialLock(), null);
});

check("a noted lock is readable and notifies subscribers", () => {
  const seen = [];
  subscribeCredentialLock((r) => seen.push(r));
  noteCredentialLock("socket");
  assert.equal(credentialLock(), "socket");
  assert.deepEqual(seen, ["socket"]);
});

check("re-noting the same reason does not re-notify", () => {
  const seen = [];
  subscribeCredentialLock((r) => seen.push(r));
  noteCredentialLock("write");
  noteCredentialLock("write");
  noteCredentialLock("write");
  assert.deepEqual(seen, ["write"], "a page of failing panes must not re-render the banner once per pane");
});

check("socket UPGRADES to write — the direct observation wins", () => {
  noteCredentialLock("socket");
  noteCredentialLock("write");
  assert.equal(credentialLock(), "write");
});

check("write is NEVER downgraded to socket", () => {
  // The refused write is observed; the refused socket is inferred (a guard-less daemon also has no
  // token). Once the strong signal exists, its wording is what stays on screen.
  noteCredentialLock("write");
  noteCredentialLock("socket");
  assert.equal(credentialLock(), "write");
});

check("clearing unlocks and notifies", () => {
  const seen = [];
  noteCredentialLock("write");
  subscribeCredentialLock((r) => seen.push(r));
  clearCredentialLock();
  assert.equal(credentialLock(), null);
  assert.deepEqual(seen, [null]);
});

check("clearing an already-clear lock does not notify", () => {
  const seen = [];
  subscribeCredentialLock((r) => seen.push(r));
  clearCredentialLock();
  assert.deepEqual(seen, []);
});

check("unsubscribe stops delivery", () => {
  const seen = [];
  const off = subscribeCredentialLock((r) => seen.push(r));
  off();
  noteCredentialLock("write");
  assert.deepEqual(seen, []);
  assert.equal(credentialLock(), "write", "the lock itself still updates — only this listener detached");
});

console.log(`\n${pass} checks passed`);
