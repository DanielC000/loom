// Hermetic test for the unified Platform shell's edition config (card 8adccd37). The Developer + End-User
// Platform surfaces were collapsed into ONE shell (src/pages/PlatformView.tsx) driven by an edition config
// (src/pages/platformEdition.ts). The four genuine behavioral forks stay REAL as config-selected leaves.
// This test pins the three DoD-mandated properties:
//   1. the singleton-vs-multi (+ create-only) spawn gating, BOTH editions, BOTH ways;
//   2. the two auditor-schedule variants (list vs single-form) + the forked roles/endpoints;
//   3. the ViewAsToggle pure-view-switch invariant — no spawn/role/stop path reads the toggle key.
//
// platformEdition.ts is JSX-free by design (data + pure functions, no React / no `api`), so it imports
// cleanly under node --experimental-strip-types (mirrors nav-companion-gating.mjs importing lib/companion.ts).
// The invariant (3) is a SOURCE-TEXT structural check — the same shape run-label-copy.mjs / terminal-chrome.mjs
// use for assertions that aren't extractable pure functions. Run standalone:
//   node --experimental-strip-types packages/web/test/platform-edition.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  developerEdition, endUserEdition,
  operatorSpawnDisabled, auditorSpawnDisabled,
} from "../src/pages/platformEdition.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// ── 1. Singleton-vs-multi + create-only gating — BOTH editions, BOTH ways. ────────────────────────────
//
// Matrix:                 operator (Lead/Platform)          auditor
//   developer             never gated by live (multi-Lead)  disabled while live
//   enduser               disabled while live (singleton)   never gated (create-only)

check("dev operator (Lead) is NEVER disabled by a live session — multiple Leads may run concurrently", () => {
  assert.equal(operatorSpawnDisabled(developerEdition, { live: false, pending: false }), false);
  assert.equal(operatorSpawnDisabled(developerEdition, { live: true, pending: false }), false); // the multi-Lead point
  assert.equal(operatorSpawnDisabled(developerEdition, { live: true, pending: true }), true);   // pending still disables
});

check("enduser operator (Platform) IS a singleton — disabled while a session is live", () => {
  assert.equal(operatorSpawnDisabled(endUserEdition, { live: false, pending: false }), false);
  assert.equal(operatorSpawnDisabled(endUserEdition, { live: true, pending: false }), true);    // the singleton gate
  assert.equal(operatorSpawnDisabled(endUserEdition, { live: false, pending: true }), true);
});

check("dev auditor is create-ONCE — disabled while a run is live", () => {
  assert.equal(auditorSpawnDisabled(developerEdition, { live: false, pending: false }), false);
  assert.equal(auditorSpawnDisabled(developerEdition, { live: true, pending: false }), true);    // disabled-while-live
});

check("enduser auditor is CREATE-ONLY — never disabled by a live run (each click is a fresh review)", () => {
  assert.equal(auditorSpawnDisabled(endUserEdition, { live: false, pending: false }), false);
  assert.equal(auditorSpawnDisabled(endUserEdition, { live: true, pending: false }), false);     // the create-only point
  assert.equal(auditorSpawnDisabled(endUserEdition, { live: true, pending: true }), true);       // pending still disables
});

check("the crossed gating booleans encode the matrix", () => {
  assert.equal(developerEdition.operatorSingleton, false);
  assert.equal(developerEdition.auditorCreateOnly, false);
  assert.equal(endUserEdition.operatorSingleton, true);
  assert.equal(endUserEdition.auditorCreateOnly, true);
});

// ── 2. The two auditor-schedule variants + the forked roles/endpoints (kept REAL, not homogenized). ───

check("auditor schedule is a LIST (dev) vs a SINGLE-FORM (enduser)", () => {
  assert.equal(developerEdition.auditorScheduleVariant, "list");
  assert.equal(endUserEdition.auditorScheduleVariant, "single-form");
});

check("the roles are forked — platform/auditor (dev) vs setup/workspace-auditor (enduser)", () => {
  assert.equal(developerEdition.operatorRole, "platform");
  assert.equal(developerEdition.auditorRole, "auditor");
  assert.equal(endUserEdition.operatorRole, "setup");
  assert.equal(endUserEdition.auditorRole, "workspace-auditor");
});

check("the discovery endpoints are forked — platformHome (dev) vs setupHome (enduser)", () => {
  assert.equal(developerEdition.homeQueryKey, "platformHome");
  assert.equal(endUserEdition.homeQueryKey, "setupHome");
});

check("the layout forks are preserved — grid+collapsed (dev) vs split+expanded (enduser)", () => {
  assert.equal(developerEdition.sessionLayout, "grid");
  assert.equal(developerEdition.historyCollapsed, true);
  assert.equal(developerEdition.auditorHistoryShowFindings, true);
  assert.equal(endUserEdition.sessionLayout, "split");
  assert.equal(endUserEdition.historyCollapsed, false);
  assert.equal(endUserEdition.auditorHistoryShowFindings, false);
});

// ── 3. The ViewAsToggle pure-view-switch invariant (source-text). ─────────────────────────────────────
// The toggle's persisted key `loom.platformViewAs` must live ONLY in Platform.tsx (where the toggle owns
// its local state), and NEVER in the shared shell or the edition config — so no spawn/role/stop path can
// read it. The shell + config also touch no browser storage at all. And Platform.tsx (which selects the
// edition) itself calls no spawn/stop REST — the spawn surface lives entirely in the shell, which receives
// only the static edition prop and never the toggle.
const platformSrc = readFileSync(new URL("../src/pages/Platform.tsx", import.meta.url), "utf8");
const shellSrc = readFileSync(new URL("../src/pages/PlatformView.tsx", import.meta.url), "utf8");
const editionSrc = readFileSync(new URL("../src/pages/platformEdition.ts", import.meta.url), "utf8");

check("the toggle key `loom.platformViewAs` appears ONLY in Platform.tsx", () => {
  assert.ok(platformSrc.includes("loom.platformViewAs"), "Platform.tsx should define the toggle key");
  assert.ok(!shellSrc.includes("loom.platformViewAs"), "PlatformView.tsx must not reference the toggle key");
  assert.ok(!editionSrc.includes("loom.platformViewAs"), "platformEdition.ts must not reference the toggle key");
});

check("neither the shell nor the edition config touches browser storage", () => {
  assert.ok(!shellSrc.includes("localStorage"), "PlatformView.tsx must not touch localStorage");
  assert.ok(!editionSrc.includes("localStorage"), "platformEdition.ts must not touch localStorage");
});

check("Platform.tsx (the edition selector) drives NO spawn/stop REST — the spawn surface is in the shell", () => {
  // Match the actual CALL form (`api.startSession(` / `api.stopSession(`), not the bare word — the file's
  // header comment mentions the role names in prose, which is not a call.
  assert.ok(!platformSrc.includes("api.startSession"), "Platform.tsx must not call api.startSession");
  assert.ok(!platformSrc.includes("api.stopSession"), "Platform.tsx must not call api.stopSession");
});

check("the shell's spawn uses the edition's static `role`, not a toggle-derived value", () => {
  // The one spawn call site passes the AgentControl `role` prop (edition.operatorRole/auditorRole),
  // never anything derived from the preview toggle.
  assert.ok(shellSrc.includes("api.startSession(agent!.id, role)"), "shell spawn must pass the static role prop");
});

check("every <PlatformView> mount is KEYED by edition — a toggle REMOUNTS, not reuses the fiber", () => {
  // The two ORIGINAL view files were distinct component types, so a "View as" toggle fully remounted and
  // reset all transient mutation state (an inline spawn error, a stuck "Starting…"). The unified shell is
  // ONE component type, so without a per-edition key React would reuse the fiber and carry that stale
  // state across a toggle onto the other edition's cards. Every mount must carry `key={…Edition.kind}`.
  const mounts = [...platformSrc.matchAll(/<PlatformView\b[^>]*?>/g)].map((m) => m[0]);
  assert.ok(mounts.length >= 2, "expected at least two <PlatformView> mounts in Platform.tsx");
  for (const mount of mounts) {
    assert.ok(/\bkey=\{[^}]*\.kind\}/.test(mount), `a <PlatformView> mount is missing a key={….kind}: ${mount}`);
  }
});

console.log(`\n${pass} passed`);
