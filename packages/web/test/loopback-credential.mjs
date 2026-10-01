// Hermetic unit test for the loopback-credential lock (card 093981dd). Everything asserted here lives in
// src/lib/loopbackCredential.ts, which is JSX-free so this test imports the SAME source the app ships —
// it can't drift from what renders. Run:
//   node --experimental-strip-types packages/web/test/loopback-credential.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  errorText, CREDENTIAL_LOCKED_TEXT,
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

// Inline mutation errors (card 353df47a): the same classifier, applied where the text is RENDERED.
check("errorText swaps the guard 401 for the banner pointer and passes everything else through raw", () => {
  assert.equal(errorText(new Error(GUARD_401)), CREDENTIAL_LOCKED_TEXT);
  assert.ok(!errorText(new Error(GUARD_401)).includes("loom open"), "the unrunnable advice must not survive");
  assert.equal(errorText(new Error(TRUST_TIER_401)), TRUST_TIER_401, "a non-credential 401 keeps its text");
  assert.equal(errorText(new Error(UNDETERMINABLE_401)), UNDETERMINABLE_401);
  assert.equal(errorText(new Error("boom")), "boom");
  assert.equal(errorText("a bare string"), "a bare string");
  assert.equal(errorText(null), undefined, "nullish stays nullish so `?? fallback` shapes still work");
  assert.equal(errorText(undefined), undefined);
});

// SOURCE SCAN (not a render test): a mutation error rendered via a raw `.message` bypasses errorText. Scope =
// the mutation variable names converted by this card, in src/**/*.tsx; a NEW mutation with another name is not covered.
const walkTsx = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
  d.isDirectory() ? walkTsx(new URL(`${d.name}/`, dir)) : d.name.endsWith(".tsx") ? [new URL(d.name, dir)] : []);

check("no src file renders a converted mutation's error via a raw .message", () => {
  const root = new URL("../src/", import.meta.url);
  const re = /\((save|clear|remove|connect|createBinding|add|del|applyPreset|spawn|create|update|retry|reclaim|validateSonar|createOAuth|resolve|adopt|mut)\.error as Error\)\??\.message/;
  const files = walkTsx(root);
  assert.ok(files.length > 20, "the scan must actually see the source tree");
  const bad = files.filter((f) => re.test(fs.readFileSync(f, "latin1"))).map((f) => f.pathname);
  assert.deepEqual(bad, [], "raw mutation-error .message render(s) — use errorText()");
  assert.ok(re.test("x{(save.error as Error).message}"), "negative control: the pattern matches the bad shape");
});

// ── card ad42a127: main.tsx's MutationCache is the SOLE owner of the mutation-failure alert ──────────
// TanStack v5 runs the cache handler AND the per-mutation one for the same failure, so a second alerter
// means two modals for one error — exactly what `alertUnlessCredentialGuard` did at 27 call sites. The
// two scans below pin the two shapes that defect took. Both strip comments first: this file's own prose
// (and Skills.tsx's) says "window.alert()" while describing the rule, and a scan that reads prose as code
// fails for the wrong reason.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
// Two arms, because the defect had two shapes and neither pattern sees the other: ACT catches an inline
// `alert(...)`; NAME catches a shared helper passed by reference (`onError: alertUnlessCredentialGuard`,
// the original 27-site shape) whose definition this scan never opens.
const ALERTS = /(?:^|[^.\w])(?:window\.)?alert\s*\(/;
// NAME is scoped to a BARE identifier reference (`onError: someAlerter`) — not an arrow body, where a
// name like `setAlertText` would be ordinary inline UI state and a false fail.
const ALERT_NAMED_REF = /^onError\s*:\s*[\w$]*[Aa]lert[\w$]*\s*$/;
const alertsSomehow = (s) => s != null && (ALERTS.test(s) || ALERT_NAMED_REF.test(s.trim()));
/** Every `useMutation( … )` call in `src`, as balanced-paren slices. */
const mutationBlocks = (src) => {
  const out = []; let i = 0;
  while ((i = src.indexOf("useMutation(", i)) !== -1) {
    let d = 0, j = i + "useMutation".length;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === "(") d++; else if (c === ")") { d--; if (d === 0) { j++; break; } }
    }
    out.push({ start: i, end: j, text: src.slice(i, j) }); i = j;
  }
  return out;
};
/** The text of an object literal's `onError:` value — up to the comma that ends the property. */
const onErrorValue = (block) => {
  const m = /\bonError\s*:/.exec(block);
  if (!m) return null;
  let d = 0;
  for (let i = m.index + m[0].length; i < block.length; i++) {
    const c = block[i];
    if ("([{".includes(c)) d++;
    else if (")]}".includes(c)) { if (d === 0) return block.slice(m.index, i); d--; }
    else if (c === "," && d === 0) return block.slice(m.index, i);
  }
  return block.slice(m.index);
};

check("no mutation alerts its own failure — main.tsx's MutationCache owns that", () => {
  const bad = [];
  let scanned = 0;
  for (const f of walkTsx(new URL("../src/", import.meta.url))) {
    if (f.pathname.endsWith("/main.tsx")) continue; // the one sanctioned alerter
    const src = stripComments(fs.readFileSync(f, "latin1"));
    for (const b of mutationBlocks(src)) {
      scanned++;
      const handler = onErrorValue(b.text);
      if (handler && alertsSomehow(handler)) bad.push(`${f.pathname.split("/src/")[1]}: ${handler.trim().slice(0, 80)}`);
    }
  }
  assert.ok(scanned > 100, `the scan must actually see the mutations (saw ${scanned})`);
  assert.deepEqual(bad, [], "mutation onError(s) that alert — the user gets TWO modals for one failure");
  // POSITIVE CONTROLS: an empty result means nothing unless the instrument can return a hit.
  assert.ok(alertsSomehow(onErrorValue("useMutation({ onError: (e) => alert(e.message), mutationFn: f })")),
    "positive control (ACT): a bare call-site alert is caught");
  assert.ok(alertsSomehow(onErrorValue("useMutation({ onError: (e) => { window.alert(e); }, mutationFn: f })")),
    "positive control (ACT): a window.alert in a block body is caught");
  assert.ok(alertsSomehow(onErrorValue("useMutation({ onError: alertUnlessCredentialGuard, mutationFn: f })")),
    "positive control (NAME): the exact 27-site shape this card removed is caught");
  assert.ok(alertsSomehow(onErrorValue("useMutation({\n    onError: showAlertModal,\n    mutationFn: f,\n  })")),
    "positive control (NAME): a renamed alerting helper is caught too");
  // ...and the extractor must stop at the property, not run on into a LATER alerting property.
  assert.ok(!alertsSomehow(onErrorValue("useMutation({ onError: invalidate, onSuccess: () => window.alert('ok') })")),
    "negative control: an onSuccess toast is not an error alert");
  assert.ok(!alertsSomehow(onErrorValue("useMutation({ onError: (e) => setErr(errorText(e)), mutationFn: f })")),
    "negative control: an inline-rendering handler is not an alert");
});

// The other half of the same defect: a mutation that renders its error inline but omits `meta.inlineError`
// draws an inline message AND a modal over it. Nothing type-checks that pairing, so pin it structurally.
check("every mutation that surfaces its own error sets meta.inlineError", () => {
  const bad = [];
  let scanned = 0;
  for (const f of walkTsx(new URL("../src/", import.meta.url))) {
    const src = stripComments(fs.readFileSync(f, "latin1"));
    for (const b of mutationBlocks(src)) {
      const name = (/(?:const|let)\s+([A-Za-z0-9_$]+)\s*(?::[^=]*?)?=\s*$/
        .exec(src.slice(Math.max(0, b.start - 300), b.start)) ?? [])[1];
      if (!name) continue;
      scanned++;
      if (/meta:\s*(?:\{[^{}]*inlineError|[A-Za-z0-9_$.]+\s*\?\s*\{\s*inlineError)/.test(b.text)) continue;
      const outside = src.slice(0, b.start) + src.slice(b.end);
      const rendersErr = new RegExp("\\b" + name.replace(/\$/g, "\\$") + "\\.(error|isError)\\b").test(outside);
      const ownsError = /\bonError\s*:/.test(b.text);
      if (rendersErr || ownsError) {
        bad.push(`${f.pathname.split("/src/")[1]} [${name}] ${rendersErr ? "renders .error" : "has its own onError"}`);
      }
    }
  }
  assert.ok(scanned > 100, `the scan must actually see the mutations (saw ${scanned})`);
  assert.deepEqual(bad, [], "mutation(s) surfacing their own error without meta.inlineError — inline message AND a modal");
});

// The shared-helper shape: `alertUnlessCredentialGuard` lived HERE and was wired into 27 call sites. The
// scan above is blind to a helper defined in a .ts file, so pin its home directly.
check("the credential module exports no alerting helper", () => {
  const src = stripComments(fs.readFileSync(new URL("../src/lib/loopbackCredential.ts", import.meta.url), "latin1"));
  assert.ok(src.includes("isCredentialGuardMessage"), "positive control: the scan is reading the real module");
  assert.ok(!alertsSomehow(src),
    "a shared alerting onError here re-creates the double modal — the cache handler already suppresses the guard 401");
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
