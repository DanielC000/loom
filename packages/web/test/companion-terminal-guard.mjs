// Card 5c87f4b6 — a Companion's terminal must never be writable, from ANY route.
//
// WHY THIS EXISTS: the "a companion is driven ONLY through its chat surface, never a raw pty tile +
// STDIN Composer" invariant was documented in TWO files (lib/sessions.ts groupSessionRows, Terminals.tsx)
// and enforced in NEITHER for the routes that render a terminal from an UNFILTERED session list. Two such
// routes existed: /session/:id (SessionView — the destination a STUCK-BUSY attention alert deep-links to)
// and the project Overview's "Terminals" grid (ProjectTerminals — reachable by just opening the page, no
// alert required). Both rendered <TerminalTile> with no `readOnly`, so a Companion got a full Composer +
// xterm stdin. Server-side those writes fail closed, but the /ws/term stdin path drops them SILENTLY (no
// error frame) — so the owner got keystrokes echoing locally and nothing happening, forever.
//
// A THIRD prose statement was explicitly not the fix. This file is the executable half, in two parts:
//   (1) the PURE predicate (isCompanionSession) — both directions, including the no-role case;
//   (2) a STRUCTURAL guard that the two enforcement layers actually USE it — so the predicate can't be
//       left correct-but-unwired, which is exactly how this invariant rotted the first time.
//
// Part (2) follows terminal-chrome.mjs's idiom (read the source, assert import + use) rather than a React
// render: TerminalPane constructs a real xterm and imports CSS, neither of which loads in a hermetic node
// script. The real-browser behavioural proof lives in e2e/companion-terminal-readonly.spec.ts, which drives
// the actual /ws/term stdin path.
//
// Run standalone: node --experimental-strip-types packages/web/test/companion-terminal-guard.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { COMPANION_ROLE, isCompanionSession } from "../src/lib/sessions.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// ── Part 1: the pure predicate, BOTH directions ────────────────────────────────────────────────────
check("COMPANION_ROLE is the assistant role", () => {
  assert.equal(COMPANION_ROLE, "assistant");
});

check("a companion (assistant-role) session IS companion-driven", () => {
  assert.equal(isCompanionSession({ role: "assistant" }), true);
});

// THE direction that matters most (card DoD-5): an over-broad fix would make every terminal read-only and
// nobody would notice until they needed it. Every non-assistant role must stay writable.
for (const role of ["worker", "manager", "setup", "auditor", "workspace-auditor", "platform"]) {
  check(`a ${role} session is NOT companion-driven (its terminal stays writable)`, () => {
    assert.equal(isCompanionSession({ role }), false);
  });
}

// The case that will silently regress. A raw SHELL terminal is not a DB Session at all and legitimately
// has no role (Terminals.tsx ShellTile passes a bare `{ id }`) — it MUST keep taking keystrokes. If this
// ever flips to `true`, every shell in the app goes read-only.
check("a session with NO role is NOT companion-driven — a raw shell must stay writable", () => {
  assert.equal(isCompanionSession({}), false);
  assert.equal(isCompanionSession({ role: null }), false);
  assert.equal(isCompanionSession({ role: undefined }), false);
});

check("a missing session is NOT companion-driven", () => {
  assert.equal(isCompanionSession(undefined), false);
  assert.equal(isCompanionSession(null), false);
});

// ── Part 2: the predicate is actually WIRED into both enforcement layers ────────────────────────────
const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

// Layer A — the TRANSPORT chokepoint. TerminalPane owns `disableStdin` AND the ws.send({type:"stdin"}),
// so anything rendering it directly (a TerminalCard renderBody, a future call site) bypasses every guard
// placed further up. The role is resolved from the session STORE, never a caller-supplied prop: `role` is
// OPTIONAL on TerminalCardSession, so a prop-trusting guard fails OPEN when a caller omits it.
check("TerminalPane resolves companion-ness from the session store (not a caller prop)", () => {
  const src = read("../src/components/Terminal.tsx");
  assert.match(src, /import\s*\{[^}]*\buseIsCompanionSession\b[^}]*\}\s*from\s*["']\.\.\/lib\/companionGuard["']/,
    "Terminal.tsx must import useIsCompanionSession from lib/companionGuard");
  assert.match(src, /useIsCompanionSession\s*\(\s*sessionId\s*\)/,
    "TerminalPane must resolve the companion guard from the session store by id");
  assert.match(src, /const\s+readOnly\s*=\s*readOnlyProp\s*\|\|/,
    "TerminalPane's effective readOnly must OR the caller's prop with the companion guard — a companion " +
    "is watch-only whether or not the caller passed readOnly");
});

check("TerminalPane still gates BOTH stdin surfaces on the effective flag", () => {
  const src = read("../src/components/Terminal.tsx");
  assert.match(src, /disableStdin:\s*readOnly/, "xterm disableStdin must read the effective flag");
  assert.match(src, /if\s*\(\s*readOnly\s*\)\s*return;/,
    "the onData handler must return before ws.send({type:'stdin'}) on the effective flag");
});

// Layer B — the SURFACE. The turn-Composer is a SEPARATE inbound surface (it POSTs
// /api/sessions/:id/input rather than riding the terminal ws), so TerminalCard must withhold it itself.
check("TerminalCard withholds the Composer for a companion", () => {
  const src = read("../src/components/TerminalCard.tsx");
  assert.match(src, /import\s*\{[^}]*\buseIsCompanionSession\b[^}]*\}\s*from\s*["']\.\.\/lib\/companionGuard["']/,
    "TerminalCard.tsx must import useIsCompanionSession");
  assert.match(src, /const\s+watchOnly\s*=\s*readOnly\s*\|\|/,
    "TerminalCard must derive a watchOnly flag from readOnly OR the companion guard");
  assert.match(src, /\{\s*!watchOnly\s*&&\s*<Composer\b/,
    "the Composer must be gated on watchOnly, NOT the raw readOnly prop — otherwise a companion reached " +
    "via /session/:id or the Overview grid still gets a writable Composer");
  assert.match(src, /<TerminalPane[^>]*readOnly=\{watchOnly\}/,
    "TerminalPane must receive the resolved flag so the two layers stay in step");
});

// The guard must not be defeatable by simply not passing `role` — assert the store lookup is keyed on the
// id (the one field a terminal caller cannot omit), not on the session object's own role field.
check("the companion guard reads the shared allSessions store keyed by session id", () => {
  const src = read("../src/lib/companionGuard.ts");
  assert.match(src, /queryKey:\s*\[\s*["']allSessions["']\s*\]/,
    "the guard must read the SHARED allSessions query key (dedup, zero extra network)");
  assert.match(src, /rows\.find\(\s*\(\s*s\s*\)\s*=>\s*s\.id\s*===\s*sessionId\s*\)/,
    "the guard must resolve the row by session id");
  assert.match(src, /isCompanionSession/, "the guard must reuse the shared predicate, not re-spell the role check");
});

// The PENDING case is a DECISION, not an accident — pin it so nobody tightens it by reflex. While
// ["allSessions"] is still resolving the guard answers `false` (writable). That is deliberate: it is a
// SINGLE shared query, so pending-=>-watch-only would briefly disable stdin on EVERY worker, manager and
// shell terminal on a cold load and then re-attach each websocket when it flips — a visible regression to
// normal sessions, which this card's DoD forbids. The window is harmless because the daemon refuses the
// write server-side anyway, and TerminalPane's attach effect lists the derived `readOnly` in its
// dependency array, so the guard genuinely re-arms when the query lands.
check("the guard answers FALSE while the session store is still resolving (a tested decision, not a slip)", () => {
  const src = read("../src/lib/companionGuard.ts");
  assert.match(src, /return\s+data\s*\?\?\s*false;/,
    "useIsCompanionSession must return `data ?? false` — a pending ['allSessions'] read answers WRITABLE. " +
    "Changing this to `?? true` would briefly make EVERY terminal (worker, manager, raw shell) read-only " +
    "on a cold load and tear down/re-attach every websocket — the over-broad regression DoD-5 forbids.");
  assert.match(src, /NOT fail-closed in the pending case/,
    "the guard's doc comment must NOT claim to be fail-closed — it answers writable while pending, and a " +
    "reader who trusts a FAIL-CLOSED heading here would be misled about the one case that matters.");
});

// TerminalPane must actually re-arm when that pending read lands — otherwise a cold deep-link would be
// writable PERMANENTLY for that mount, not briefly, and the window above would stop being harmless.
check("TerminalPane's attach effect re-runs when the resolved flag flips", () => {
  const src = read("../src/components/Terminal.tsx");
  assert.match(src, /\}\s*,\s*\[\s*sessionId\s*,\s*resizable\s*,\s*readOnly\s*\]\s*\)/,
    "the attach effect must list the DERIVED `readOnly` in its dependency array so xterm is rebuilt with " +
    "disableStdin once the companion guard resolves");
});

console.log(`\n${pass} passed — a companion's terminal is watch-only from every route; everything else is unchanged`);
