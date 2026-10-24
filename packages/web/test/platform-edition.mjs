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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// The api read/write classifier is an AST walk, not a pattern match — see its own note below for the
// defect that forced it. `typescript` is already a dev dependency of this package (it builds it).
import ts from "typescript";
import {
  developerEdition, endUserEdition,
  operatorSpawnDisabled, auditorSpawnDisabled, resolveOperatorSpawnRole,
} from "../src/pages/platformEdition.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// Extract the real attribute text of every `<Tag …>` mount in `src` (section 7 proves it works).
//
// Written as a scanner rather than a regex because a flat `<Tag[^>]*?/>` is WRONG on this file: some
// mounts carry a NESTED element inside a brace expression (`auditorFooter={… <AuditorScheduleInline … /> …}`),
// so a character class stops at the inner tag and silently inspects a TRUNCATED mount — passing or
// failing depending on where the attribute being looked for happens to sit. Tracking brace depth and
// stopping at the first depth-0 `>` consumes the whole opening tag, nested elements included, so a
// per-mount assertion is exact and immune to attribute order.
function mountAttrs(src, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?=[\\s/>])`, "g");
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

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

// f437d4e9 C5: the end-user operator now runs as the full Platform Lead (role "platform"), matching the
// daemon's seed/migration — the auditor fork (auditor vs workspace-auditor) is untouched by that card.
check("the roles are forked — platform/auditor (dev) vs platform/workspace-auditor (enduser)", () => {
  assert.equal(developerEdition.operatorRole, "platform");
  assert.equal(developerEdition.auditorRole, "auditor");
  assert.equal(endUserEdition.operatorRole, "platform");
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

// f437d4e9 C5: on a DEV install, the underlying Getting-Started agent behind the "View as: End-user"
// preview is never upgraded to the Lead (§1c), so that ONE mount must disable the spawn button
// (previewOnly) rather than letting the static operatorRole:"platform" mint a stray session against it.
// The shipping (!isDev) mount must NOT carry it — a real end-user install's Lead must stay spawnable.
check("previewOnly is passed on the dev End-user PREVIEW mount only, never on the shipping mount", () => {
  const mounts = [...platformSrc.matchAll(/<PlatformView\b[^>]*?>/g)].map((m) => m[0]);
  const withPreview = mounts.filter((m) => /\bpreviewOnly\b/.test(m));
  assert.equal(withPreview.length, 1, `expected exactly one previewOnly mount, found ${withPreview.length}`);
  assert.ok(withPreview[0].includes("endUserEdition"), "the previewOnly mount must be the end-user edition");
});

check("PlatformView disables the operator spawn via previewDisabled, independent of the edition's own gate", () => {
  assert.ok(shellSrc.includes("previewDisabled"), "PlatformView.tsx must thread a previewDisabled prop");
  assert.ok(/spawnDisabled\s*=\s*!!previewDisabled\s*\|\|/.test(shellSrc), "spawnDisabled must OR in previewDisabled");
});

// ── 4. resolveOperatorSpawnRole (card be9cb999 round 3, M2/M4d) — the operator's DYNAMIC spawn role,
// including the "profiles not loaded yet" state that must disable the spawn rather than guess. ────────

check("platform-bound operator ⇒ role 'platform', spawn enabled", () => {
  const r = resolveOperatorSpawnRole({ hasOperator: true, profilesLoaded: true, operatorProfileRole: "platform", fallbackRole: "platform" });
  assert.equal(r.role, "platform");
  assert.equal(r.spawnDisabled, false);
});

check("setup-bound operator ⇒ role 'setup', spawn enabled", () => {
  const r = resolveOperatorSpawnRole({ hasOperator: true, profilesLoaded: true, operatorProfileRole: "setup", fallbackRole: "platform" });
  assert.equal(r.role, "setup");
  assert.equal(r.spawnDisabled, false);
});

check("no bound profile at all (profileId null) ⇒ role 'setup' (the same 'anything not platform' default), spawn enabled", () => {
  const r = resolveOperatorSpawnRole({ hasOperator: true, profilesLoaded: true, operatorProfileRole: null, fallbackRole: "platform" });
  assert.equal(r.role, "setup");
  assert.equal(r.spawnDisabled, false);
});

check("profiles NOT yet loaded ⇒ spawn DISABLED, never a guessed 'setup' the caller could act on", () => {
  const r = resolveOperatorSpawnRole({ hasOperator: true, profilesLoaded: false, operatorProfileRole: null, fallbackRole: "platform" });
  assert.equal(r.spawnDisabled, true);
});

check("no operator agent resolved at all ⇒ spawn NOT disabled by this function (the 'missing agent' card handles it separately)", () => {
  const r = resolveOperatorSpawnRole({ hasOperator: false, profilesLoaded: false, operatorProfileRole: null, fallbackRole: "platform" });
  assert.equal(r.spawnDisabled, false);
  assert.equal(r.role, "platform"); // the static fallback, for rendering only
});

check("PlatformView threads roleUnknown into the operator AgentControl mount and ORs it into spawnDisabled", () => {
  assert.ok(/<AgentControl\b[^>]*\bagent=\{operator\}[^>]*\broleUnknown=\{operatorRoleUnknown\}/.test(shellSrc) ||
    /<AgentControl\b[^>]*\broleUnknown=\{operatorRoleUnknown\}[^>]*\bagent=\{operator\}/.test(shellSrc),
    "the operator AgentControl mount must pass roleUnknown={operatorRoleUnknown}");
  assert.ok(/spawnDisabled\s*=\s*!!previewDisabled\s*\|\|\s*!!roleUnknown\s*\|\|/.test(shellSrc),
    "spawnDisabled must ALSO OR in roleUnknown, alongside previewDisabled");
});

// ── 5. card b2b69ec8 (M3) — the operator resolves by the daemon's OWN authority (setupHome's
// `resolvedLead`) when the server provides one, never by re-deriving "the Lead" from `agents` by list
// order/name alone. SOURCE-TEXT structural checks (same shape as section 3/4 above) since this logic is
// inline in the shell, not an extractable pure function. ───────────────────────────────────────────────

check("the operator resolves by resolvedLead.agentId FIRST, falling back to role/name only when absent", () => {
  assert.ok(shellSrc.includes("resolvedLead?.agentId"),
    "PlatformView.tsx must read resolvedLead?.agentId");
  assert.ok(/agents\.find\(\(a\)\s*=>\s*a\.id\s*===\s*resolvedLead\.agentId\)/.test(shellSrc),
    "the operator must be resolved by exact id match against resolvedLead.agentId");
});

check("the operator's spawn role trusts resolvedLead.role directly, with no profiles-loading window, when present", () => {
  assert.ok(shellSrc.includes("resolvedLead?.role"),
    "PlatformView.tsx must read resolvedLead?.role for the operator's spawn role");
});

// ── 6. card c07ff42a (Atlas P2-4) — the shell now drives TWO LAYOUTS (the classic stack and the Atlas
// node tabs) off the SAME resolved values. These pin the properties that make that split safe, i.e. that
// a layout is presentation only: it cannot decide an edition, re-derive what an edition may show, or
// stand up a second spawn surface. SOURCE-TEXT checks, same shape as sections 3-5 above. ──────────────
const findingsSrc = readFileSync(new URL("../src/pages/PlatformFindings.tsx", import.meta.url), "utf8");

check("the findings event kind is FORKED per edition — the kind is what scopes a read to one home", () => {
  // Each kind has exactly one daemon emit site (sessions/service.ts), so the kind alone keeps the dev
  // Platform board's findings out of the end-user home's and vice versa.
  assert.equal(developerEdition.findingEventKind, "audit_finding");
  assert.equal(endUserEdition.findingEventKind, "workspace_audit_suggestion");
});

check("the Atlas switch is read ONCE, in the shell — never inside a layout or a section", () => {
  // One call, at the top of PlatformView, purely to pick a layout. A second one would mean some section
  // had started branching on the display switch, which is how a layout fork becomes a behavior fork.
  const calls = [...shellSrc.matchAll(/useAtlasUi\(/g)].length;
  assert.equal(calls, 1, `expected exactly one useAtlasUi() call in PlatformView.tsx, found ${calls}`);
  assert.ok(!findingsSrc.includes("useAtlasUi"), "PlatformFindings.tsx must not read the Atlas switch");
});

check("BOTH layouts render the ONE shared agents section — neither builds its own spawn card", () => {
  // The gating props (previewDisabled / roleUnknown / gate) reach AgentControl through exactly ONE
  // <AgentControl> pair, inside PlatformAgentsSection. If a layout grew its own <AgentControl>, that
  // thread could be dropped on one layout and not the other — so the count is the guard.
  const controls = [...shellSrc.matchAll(/<AgentControl\b/g)].length;
  assert.equal(controls, 2, `expected exactly 2 <AgentControl> mounts (operator + auditor), found ${controls}`);
  const sections = [...shellSrc.matchAll(/<PlatformAgentsSection\b/g)].length;
  assert.equal(sections, 2, `both layouts must render <PlatformAgentsSection>, found ${sections} mount(s)`);
});

// The section is shared, but `previewOnly` is handed to it once PER LAYOUT — so the thread is only as
// strong as its WEAKEST mount, and a single mount regressed to `previewOnly={false}` stays green on
// every other check in this file and in the e2e suite that exercises the OTHER layout. What it would
// actually do is re-enable "Start Platform" in a dev install's End-user preview, against §1c: the
// underlying Getting-Started agent there is never upgraded to the Lead, so a click would mint a stray
// role:"platform" session on it. Count-equality against the mount count is what makes a dropped or
// hardcoded hop on EITHER layout fail here rather than only in whichever layout a test happened to walk.
// ⚠️ This check USED to be a whole-file count of `previewOnly={previewOnly}` against the
// `<PlatformAgentsSection>` mount count, because that spelling was unique to those mounts. Card
// b472645a broke that premise: SEVERAL component kinds now thread the same attribute, so a whole-file
// count can be satisfied by the wrong mounts entirely — e.g. two session-section hops standing in for
// two missing agents-section hops. It is now PER MOUNT, via `mountAttrs` (section 7), which extracts a
// mount's real attribute text instead of counting occurrences anywhere in the file.
check("EVERY <PlatformAgentsSection> mount threads previewOnly — no layout may hardcode it", () => {
  const mounts = mountAttrs(shellSrc, "PlatformAgentsSection");
  assert.ok(mounts.length >= 2, `expected at least two <PlatformAgentsSection> mounts, found ${mounts.length}`);
  for (const mount of mounts) {
    assert.match(mount, /\bpreviewOnly=\{previewOnly\}/,
      `a <PlatformAgentsSection> mount is hardcoding or dropping previewOnly: ${mount.slice(0, 160)}…`);
  }
});

check("the Atlas findings surface drives NO spawn/stop REST and reads no browser storage or toggle key", () => {
  assert.ok(!findingsSrc.includes("api.startSession"), "PlatformFindings.tsx must not call api.startSession");
  assert.ok(!findingsSrc.includes("api.stopSession"), "PlatformFindings.tsx must not call api.stopSession");
  assert.ok(!findingsSrc.includes("localStorage"), "PlatformFindings.tsx must not touch localStorage");
  assert.ok(!findingsSrc.includes("loom.platformViewAs"), "PlatformFindings.tsx must not reference the toggle key");
});

check("the Atlas findings surface takes the RESOLVED edition as a prop, never an edition literal", () => {
  // Importing developerEdition/endUserEdition here would be a SECOND place that decides which edition is
  // in view — the one decision Platform.tsx owns, gated on the real server signal.
  assert.ok(!findingsSrc.includes("developerEdition"), "PlatformFindings.tsx must not import developerEdition");
  assert.ok(!findingsSrc.includes("endUserEdition"), "PlatformFindings.tsx must not import endUserEdition");
  assert.ok(/edition:\s*PlatformEdition/.test(findingsSrc), "PlatformFindings.tsx must take `edition: PlatformEdition` as a prop");
});

// ── 7. card b472645a — the dev End-user PREVIEW is READ-ONLY for everything PlatformView owns.
//
// @decision b472645a — the gate covers both spawns, both Stops, both prompt editors, the whole cadence
// form and the session tiles; measured, before the fix, as EIGHT live controls in the preview. These are
// SOURCE-TEXT checks (same shape as sections 3-6) and they are the only thing standing between a future
// refactor and a silently re-opened trust boundary, because the gate is a prop thread: every hop is a
// place it can be dropped on ONE layout and stay green on every test that walks the other.
const promptEditorSrc = readFileSync(new URL("../src/components/AgentPromptEditor.tsx", import.meta.url), "utf8");
// The shared ⌘/Ctrl+Enter handler the prompt editor's textarea delegates to — read here because the
// readOnly gate below is only as strong as what the helper does with the `enabled` it is handed.
const modEnterSrc = readFileSync(new URL("../src/lib/modEnter.ts", import.meta.url), "utf8");
const sessionTileSrc = readFileSync(new URL("../src/components/PlatformSessionTile.tsx", import.meta.url), "utf8");
const terminalCardSrc = readFileSync(new URL("../src/components/TerminalCard.tsx", import.meta.url), "utf8");
const runHistorySrc = readFileSync(new URL("../src/components/RunHistory.tsx", import.meta.url), "utf8");

// POSITIVE CONTROL on `mountAttrs` itself, BEFORE anything relies on it. A scanner that returned
// truncated (or empty) attribute text would make every per-mount assertion below pass vacuously, and a
// vacuous pass here reads exactly like a real one.
check("mountAttrs extracts a WHOLE mount, nested element included, and stops at its own tag end", () => {
  const mounts = mountAttrs(shellSrc, "PlatformAgentsSection");
  assert.ok(mounts.length >= 2, `expected >=2 mounts to control on, found ${mounts.length}`);
  // (a) it does not truncate: the classic mount's nested auditorFooter element must be INSIDE the text.
  const withNested = mounts.filter((m) => m.includes("<AuditorScheduleInline"));
  assert.equal(withNested.length, 1,
    "exactly one <PlatformAgentsSection> mount should carry the nested <AuditorScheduleInline> footer"
    + ` — found ${withNested.length}, so the scanner is truncating or the layouts changed`);
  // (b) it does not over-run: no mount may swallow the sibling element that follows it.
  for (const m of mounts) {
    assert.ok(!m.includes("<PlatformSessionsSection"),
      `a <PlatformAgentsSection> mount ran past its own tag end into the next element: ${m.slice(-120)}`);
    assert.ok(m.trimEnd().endsWith("/>") || m.trimEnd().endsWith(">"),
      "an extracted mount must end at a real tag close");
  }
});

// Every component the gate is threaded THROUGH, and the exact attribute each mount must carry. `min` is
// an ANTI-VACUITY FLOOR, not an expected count: it only exists so a renamed/removed component can't make
// "every mount carries it" true by matching zero mounts. A third layout raises the real count and still
// passes the floor, while the per-mount assertion keeps catching a dropped hop on ANY layout.
const GATE_THREAD = [
  { tag: "AgentControl", attr: /\bpreviewDisabled=\{previewOnly\}/, min: 2,
    why: "both go-live cards — the auditor one was the hole this card closed" },
  { tag: "PlatformAgentsSection", attr: /\bpreviewOnly=\{previewOnly\}/, min: 2, why: "once per layout" },
  { tag: "PlatformSessionsSection", attr: /\bpreviewOnly=\{previewOnly\}/, min: 2, why: "once per layout" },
  { tag: "AuditorCadenceFormSection", attr: /\bpreviewOnly=\{previewOnly\}/, min: 1, why: "the Atlas Cadence tab" },
  { tag: "AuditorScheduleInline", attr: /\bpreviewOnly=\{previewOnly\}/, min: 2,
    why: "the classic auditor-card footer AND the Atlas cadence section" },
  { tag: "PlatformSessions", attr: /\bpreviewOnly=\{previewOnly\}/, min: 1, why: "the dev session grid" },
  { tag: "SingleSession", attr: /\bpreviewOnly=\{previewOnly\}/, min: 2, why: "the end-user operator + auditor wrappers" },
  { tag: "PlatformSessionTile", attr: /\bpreviewOnly=\{previewOnly\}/, min: 2, why: "the grid tile + the single-session tile" },
  { tag: "AgentPromptEditor", attr: /\breadOnly=\{!!previewDisabled\}/, min: 1, why: "inside AgentControl, one per card" },
  { tag: "PlatformHistorySections", attr: /\bpreviewOnly=\{previewOnly\}/, min: 2, why: "once per layout" },
  { tag: "RunHistory", attr: /\bpreviewOnly=\{previewOnly\}/, min: 2,
    why: "the operator AND auditor histories — each run row carries a Resume that respawns the session" },
];

for (const { tag, attr, min, why } of GATE_THREAD) {
  check(`EVERY <${tag}> mount carries the preview gate (${why})`, () => {
    const mounts = mountAttrs(shellSrc, tag);
    assert.ok(mounts.length >= min,
      `expected at least ${min} <${tag}> mount(s) in PlatformView.tsx, found ${mounts.length}`
      + " — renamed or removed? this check cannot pass vacuously");
    for (const mount of mounts) {
      assert.match(mount, attr,
        `a <${tag}> mount is dropping or hardcoding the preview gate: ${mount.slice(0, 200)}…`);
    }
  });
}

check("the operator AND auditor Stop buttons are held by previewDisabled, not just the spawns", () => {
  // One shared AgentControl renders both cards' Stop, so this is a single expression — but it is the one
  // the pre-b472645a code was missing, and a `disabled={stop.isPending}` regression reads as a tidy-up.
  assert.match(shellSrc, /disabled=\{!!previewDisabled \|\| stop\.isPending\}/,
    "AgentControl's Stop button must OR in previewDisabled");
});

check("the preview copy says ACTING, not spawning, and both sites read ONE constant", () => {
  // The gate now holds far more than the spawn, so a caption naming only spawning under-describes what
  // is actually held. Two call sites (tooltip + caption) read the same pair of constants so they cannot drift.
  assert.match(shellSrc, /const PREVIEW_DISABLED_TITLE = "[^"]*acting here is disabled"/);
  assert.match(shellSrc, /const PREVIEW_DISABLED_NOTE = "[^"]*acting here is disabled\."/);
  assert.ok(!/Preview only on a dev install — spawning/.test(shellSrc),
    "the old spawn-only wording must be gone — it now understates the gate");
});

check("AgentPromptEditor's readOnly holds the TEXTAREA, so Ctrl/Cmd+Enter cannot save either", () => {
  // MEASURED on the e2e fixture: the textarea's own onKeyDown is a SECOND, independent save trigger, so a
  // disabled Save button alone still let the preview send POST /api/agents/:id. It is gated via `dirty`,
  // which folds readOnly in — hence both assertions, not just the readOnly attribute.
  assert.match(promptEditorSrc, /\breadOnly\?\s*:\s*boolean/, "AgentPromptEditor must accept a readOnly prop");
  // mountAttrs, not a `<textarea[^>]*>` regex: the element's own `onChange={(e) => …}` contains a `>`,
  // so a negated character class stops at the fat arrow and reads a truncated attribute list.
  const textareas = mountAttrs(promptEditorSrc, "textarea");
  assert.equal(textareas.length, 1, `expected one <textarea> in AgentPromptEditor.tsx, found ${textareas.length}`);
  assert.match(textareas[0], /\breadOnly=\{readOnly\}/,
    "the textarea itself must be readOnly — not just the Save button");
  assert.match(promptEditorSrc, /const dirty = !readOnly && draft !== saved/,
    "dirty must fold in readOnly — it is what gates the Ctrl/Cmd+Enter save path");
  // The handler itself is now the SHARED one (src/lib/modEnter.ts, card c6b80cf7) — the project-agent
  // editor had drifted without it. So this claim takes two reads rather than one: the textarea must
  // still pass `dirty` as the enabling condition, AND the helper it passes it to must be the thing that
  // honours it. Asserting only the call site would pass against a helper that ignored `enabled`.
  assert.match(textareas[0], /onKeyDown=\{modEnterSubmit\(dirty && !save\.isPending,/,
    "the Ctrl/Cmd+Enter handler must still be gated on dirty, or the fold above buys nothing");
  assert.match(modEnterSrc, /e\.key !== "Enter" \|\| !\(e\.metaKey \|\| e\.ctrlKey\) \|\| !enabled/,
    "modEnterSubmit must refuse unless it is Enter WITH a modifier AND enabled is true");
});

check("RunHistory's Resume button is held by previewOnly, and the row receives the flag", () => {
  // The Code Review's Critical. Both legs matter: the ROW must get the flag (it is a separate component
  // from RunHistory itself), and the BUTTON must OR it in.
  assert.match(runHistorySrc, /\bpreviewOnly\?\s*:\s*boolean/, "RunHistory must accept a previewOnly prop");
  const rows = mountAttrs(runHistorySrc, "RunRow");
  assert.ok(rows.length >= 1, `expected a <RunRow> mount in RunHistory.tsx, found ${rows.length}`);
  for (const row of rows) {
    assert.match(row, /\bpreviewOnly=\{previewOnly\}/, `a <RunRow> mount drops the gate: ${row.slice(0, 160)}…`);
  }
  assert.match(runHistorySrc, /disabled=\{previewOnly \|\| resumeM\.isPending\}/,
    "the Resume button must OR in previewOnly");
});

check("PlatformSessionTile gates through TerminalCard's EXISTING props — the shared card is untouched", () => {
  // Deliberate: TerminalCard is mounted by /terminals, Overview, SessionView and Companion. Gating by
  // adding a flag THERE would put this trust boundary in four unrelated surfaces' path.
  assert.match(sessionTileSrc, /\breadOnly=\{previewOnly\}/, "the tile must pass readOnly through");
  assert.match(sessionTileSrc, /\blifecycle=\{previewOnly \? "none" : "stop"\}/,
    "the tile must drop the lifecycle button in a preview");
  assert.match(sessionTileSrc, /\bsubPanels=\{previewOnly \? undefined :/,
    "the queue/wakes sub-panels write to the previewed home's session — withhold the whole set");
  assert.ok(!terminalCardSrc.includes("previewOnly"),
    "TerminalCard.tsx must NOT learn about previewOnly — that is the point of reusing readOnly/lifecycle");
});

check("the cadence form gates the COMPONENT behind one derived flag, not its individual buttons", () => {
  // Save / Enable / Disable / Remove render ONLY when a schedule already exists, so on a home with none
  // they are exactly the mutations a per-button gate leaves open. `held` + a readOnly field is the whole
  // surface; `dirty` folds it in so Save can never light up on a field that cannot be edited.
  assert.match(shellSrc, /const held = previewOnly;/, "AuditorScheduleInlineForm must derive one `held` flag");
  assert.match(shellSrc, /const dirty = !held && !!existing/, "dirty must fold in `held`");
  // Again mountAttrs rather than `<Input[^>]*>`: `onChange={(e) => setCron(…)}` carries a `>`.
  const crons = mountAttrs(shellSrc, "Input");
  const heldCron = crons.filter((m) => /\breadOnly=\{held\}/.test(m) && /\bdisabled=\{held\}/.test(m));
  assert.equal(heldCron.length, 1,
    `expected exactly one cron <Input> held by \`held\`, found ${heldCron.length} of ${crons.length} <Input> mount(s)`
    + " — the single-form variant's field is the one that renders in a preview");
  const heldGates = (shellSrc.match(/disabled=\{held \|\| /g) ?? []).length;
  assert.ok(heldGates >= 4,
    `expected >=4 cadence buttons gated by \`held\` (Schedule/Save/Enable-Disable/Remove), found ${heldGates}`);
  // ⭐ The per-control flags alone do NOT make "a new control inherits the gate" true — that claim needs
  // a DISABLED FIELDSET, which disables every form control it contains whether or not its author
  // remembered the flag. Pinned because the comment next to `held` asserts exactly this property.
  // Filtered rather than counted: `mountAttrs` is a text scanner, so a COMMENT that mentions `<fieldset>`
  // (the one next to `held` does) is indistinguishable from a real mount to it.
  const heldFieldsets = mountAttrs(shellSrc, "fieldset").filter((m) => /\bdisabled=\{held\}/.test(m));
  assert.equal(heldFieldsets.length, 1,
    `expected exactly one <fieldset disabled={held}> in PlatformView.tsx, found ${heldFieldsets.length}`
    + " — that wrapper is what a cadence control added later inherits the gate from");
});

// ⭐⭐ THE TRANSITIVE WRITE SWEEP — the only check here that doesn't rot, and the one that must be
// TRANSITIVE rather than file-local.
//
// 🔴 WHY: the first version of this sweep read PlatformView.tsx + AgentPromptEditor.tsx only, and a Code
// Review then found Run History's "Resume" (`components/RunHistory.tsx`) firing `POST /api/sessions/:id/
// resume` in the preview — un-archiving and RESPAWNING the previewed home's session. A file-local sweep
// cannot see that by construction: the control lives in a leaf the shell renders but does not itself
// contain. So the sweep now walks every LOCAL module transitively reachable from PlatformView.tsx and
// enumerates every write in each one.
//
// Three kinds of write are looked for, because a mutation does not have to look like `useMutation({`:
//   1. `useMutation(` in every shape — `const x = useMutation({`, destructured `const { mutate } = …`,
//      and the generic form `useMutation<T>(`;
//   2. a CUSTOM HOOK that wraps one — `use*Session` / `use*Mutation` (e.g. `useStopSession()`), which is
//      how PlatformSessionTile's stop is spelled and which no `useMutation` pattern would ever match;
//   3. a RAW `api.<write>(` call, for a write issued outside any mutation at all;
//   4. a request that bypasses the client — a bare `fetch(` or `navigator.sendBeacon(`;
//   5. a module boundary the walk cannot follow statically — `lazy(` or a dynamic `import(`.
//
// The write MEMBERS of `api` are DERIVED by an AST walk over api.ts, fail-closed (see
// `classifyApiMembers`) — never hand-listed here. ⚠️ That makes a new write MEMBER in scope the moment
// it exists; it does NOT make every write api.ts can expose in scope. A write exported BESIDE the `api`
// object (`restartCompanionSession`) is in no object the classifier walks and matches no `api.<write>(`
// call — what covers that is the separate assertion that this graph's only VALUE import from lib/api is
// `{ api }`. The record lists the shapes nothing here catches at all.
const apiSrc = readFileSync(new URL("../src/lib/api.ts", import.meta.url), "utf8");

// 🔴 FAIL-CLOSED, and it has to be. The first version of this derivation asked "does the body call a
// known WRITE helper?" — which a Code Review measured as missing 49 of 117 write members (42%), because
// api.ts has write helpers that list did not name (`delErr`, `putErr`, `patch`) AND members that
// delegate to a bespoke per-route function instead of a helper at all (`updateTaskReq`,
// `provisionCompanionReq`, `patchProject`). A planted `api.updateTask(` call stayed GREEN.
//
// Inverted: a member is a READ only if its body calls one of the three READ helpers; EVERYTHING ELSE is
// a write. A new helper, a bespoke request function, an unrecognised shape — all now land on the write
// side, which is the side that fails loudly rather than the side that goes quiet.
const API_READ_HELPERS = new Set(["get", "getOrNull", "getErr"]);

// card 66b9e590: the "other calls" side of the read verdict (below, in classifyApiMembers) was ITSELF
// fail-OPEN — it only recognised a bare call to a declared+shaped helper or bare `fetch`, so a request
// helper imported from elsewhere, a METHOD-form `window.fetch(`/`globalThis.fetch(`, or a `new
// WebSocket`/`new EventSource` all silently passed as "no other call" and left a read verdict standing.
// Inverted the same way as the read helpers above: a member's OTHER calls must each be a bare read
// helper, a global named here, or a declared api.ts function the fixpoint below proves request-free —
// anything else (including a method named `fetch`, or either of those two constructors) is a write.
// This allowlist is reasoned, not inferred: these two globals are the only non-declared bare calls the
// current read members actually make (see decision b472645a's record for the measurement).
const PURE_GLOBALS = new Set(["encodeURIComponent", "String"]);

// 🔴 AN AST WALK, NOT A REGEX — and the reason is a defect the regex version actually had.
//
// Two regex classifiers preceded this one and BOTH were wrong, in ways no amount of pattern-tightening
// fixes, because the question "does this member issue a read?" is about CALL STRUCTURE:
//   • `\b(?:get|getOrNull|getErr)\s*[<(]` matches a METHOD call too. `r.headers.get("content-type")` is
//     not a request — but it made `vaultRawBlob`, `vaultRawHead` and `questionAttachmentBlob` classify
//     as READS when each in fact calls `guardedFetch` and NO read helper at all. All three were
//     genuinely outside the sweep, and a planted `guardedFetch(url,{method:"POST"})` beside a
//     `r.headers.get(` would have gone green.
//   • a member's text had to be sliced by line arithmetic, which swallowed the NEXT member's leading
//     comment (that is how a real `del<>` read as a read), and comment-stripping it back out was a
//     patch on the wrong layer — a trailing SAME-LINE comment mentioning `get()` defeated it anyway.
// An AST has no windows, no comment bleed, and distinguishes `get(…)` from `x.get(…)` structurally.
//
// Measured, same api.ts: the open-polarity windowed regex found 67 of 121 writes (missed 45%); the
// fail-closed regex found 118 (missed exactly the three above); the AST finds 121 / 93 reads / 214
// members, and claims no write the fail-closed regex called a read.

/** Module-level function-ish declarations in api.ts, by name → node. The helper universe. */
function apiDeclaredFunctions(sf) {
  const declared = new Map();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) declared.set(st.name.text, st);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer
          && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          declared.set(d.name.text, d.initializer);
        }
      }
    }
  }
  return declared;
}

/**
 * Calls (and constructions) inside a subtree, split by SHAPE: a BARE call (`get(…)`) names a function
 * in scope; a METHOD call (`r.headers.get(…)` or `window.fetch(…)`) names a property on some object and
 * says nothing about helpers ON ITS OWN — but its RECEIVER does, which is why each method call carries
 * its receiver's identifier text (`null` when the receiver isn't a bare identifier, e.g. `a.b.get(…)`);
 * a `new X(…)` construction (`new WebSocket(…)`) is neither. Keeping them apart is the whole point of
 * using an AST here.
 */
function callsIn(node) {
  const bare = [];
  const methods = [];
  const news = [];
  (function walk(n) {
    if (ts.isCallExpression(n)) {
      if (ts.isIdentifier(n.expression)) bare.push(n.expression.text);
      else if (ts.isPropertyAccessExpression(n.expression)) {
        const receiver = ts.isIdentifier(n.expression.expression) ? n.expression.expression.text : null;
        methods.push({ receiver, name: n.expression.name.text });
      }
    } else if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) {
      news.push(n.expression.text);
    }
    ts.forEachChild(n, walk);
  })(node);
  return { bare, methods, news };
}

/**
 * Which declared helpers actually ISSUE a request — a fixpoint, so a member delegating to
 * `updateTaskReq` (which calls `guardedFetch`) is caught without naming it here. Derived rather than
 * listed because the list is exactly what went stale last time.
 *
 * This is also why a pure formatter like `errorMessageFrom` does NOT count: it never reaches a fetch,
 * so a genuine read that calls it is still classified a read and the polarity control stays meaningful.
 *
 * 🔴 card 66b9e590 follow-up: a declared helper that performs its request as a METHOD call — e.g.
 * `restartCompanionSession` calling `api.stopSession(…)` — was previously invisible to this fixpoint
 * (it only ever walked BARE calls, plus the one method name `sendBeacon`), so it landed in `declared \
 * shaped` (`pureHelpers`, in classifyApiMembers below) even though it genuinely issues requests. EVERY
 * `api` member issues a request by construction (that is what this whole file classifies), so a method
 * call whose receiver is the bare identifier `api` is request-shaped on its own, with no need to know
 * which member it names.
 */
function requestShapedHelpers(declared) {
  const shaped = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, node] of declared) {
      if (shaped.has(name)) continue;
      const { bare, methods } = callsIn(node);
      if (bare.includes("fetch") || bare.includes("guardedFetch")
        || methods.some((m) => m.receiver === "api" || m.name === "fetch" || m.name === "sendBeacon")
        || bare.some((b) => shaped.has(b))) { shaped.add(name); changed = true; }
    }
  }
  return shaped;
}

/**
 * Classify EVERY property of the `api` object, FAIL-CLOSED on BOTH sides of the verdict: a member is a
 * READ only when it makes a BARE call to a read helper, AND every OTHER call it makes is either a BARE
 * call to a global in `PURE_GLOBALS` or to a declared api.ts function the fixpoint below proves
 * request-free (`declared` minus `shaped`) — never a function merely "not recognised as a writer", which
 * is the open-polarity shape card 66b9e590 closed. Any other bare call, any METHOD call named `fetch` or
 * `sendBeacon`, or a `new WebSocket`/`new EventSource` construction, makes it a WRITE — an unrecognised
 * helper, an imported request helper, a bespoke per-route function, a shorthand member with no calls at
 * all, all land on the write side, which is the side that fails loudly.
 */
function classifyApiMembers(src, fileName) {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declared = apiDeclaredFunctions(sf);
  const shaped = requestShapedHelpers(declared);
  // Request-free by the SAME fixpoint that proves the read helpers themselves request-shaped (see the
  // check below) — disjoint from `shaped` by construction, so a helper that reaches a request can never
  // land here no matter how deep the delegation chain.
  const pureHelpers = new Set([...declared.keys()].filter((n) => !shaped.has(n)));

  let obj = null;
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === "api" && d.initializer
        && ts.isObjectLiteralExpression(d.initializer)) obj = d.initializer;
    }
  }
  assert.ok(obj, "api.ts must declare `export const api = { … }` as an object literal");

  const reads = new Set();
  const writes = new Set();
  const shorthand = new Set();
  for (const p of obj.properties) {
    const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : "<computed>";
    if (ts.isShorthandPropertyAssignment(p)) shorthand.add(name);
    const { bare, methods, news } = callsIn(p);
    const readCalls = bare.filter((b) => API_READ_HELPERS.has(b));
    const otherRequests = bare
      .filter((b) => !API_READ_HELPERS.has(b) && !pureHelpers.has(b) && !PURE_GLOBALS.has(b))
      .concat(methods.filter((m) => m.name === "sendBeacon" || m.name === "fetch" || m.receiver === "api")
        .map((m) => m.name))
      .concat(news.filter((n) => n === "WebSocket" || n === "EventSource"));
    (readCalls.length > 0 && otherRequests.length === 0 ? reads : writes).add(name);
  }
  return { total: obj.properties.length, reads, writes, shorthand, declared, shaped, pureHelpers };
}

const API_MEMBERS = classifyApiMembers(apiSrc, "api.ts");
const API_WRITE_MEMBERS = API_MEMBERS.writes;

check("every api.ts member classifies as read or write, fail-CLOSED (unknown shape ⇒ write)", () => {
  // The read helpers must actually exist AND must themselves reach a request, or "calls a read helper"
  // is a test for nothing: every member would fall to the write side — safe, but no longer discriminating.
  for (const h of API_READ_HELPERS) {
    assert.ok(API_MEMBERS.declared.has(h), `api.ts must declare a read helper \`${h}\``);
    assert.ok(API_MEMBERS.shaped.has(h), `read helper \`${h}\` must itself reach a request`);
  }
  assert.ok(API_MEMBERS.total >= 150,
    `the AST found only ${API_MEMBERS.total} api propert(ies) — the object lookup is broken`);
  assert.ok(API_MEMBERS.writes.size >= 100,
    `derived only ${API_MEMBERS.writes.size} write member(s) — fail-closed should yield most of them`);

  // ⚠️ `reads + writes === total` is TRUE BY CONSTRUCTION here (every property lands in exactly one
  // set), so it is NOT evidence that the parse saw every member — the previous version asserted it as
  // if it were. A member the parse never sees simply lowers `total` too, and the sum still holds; that
  // is exactly how a planted SHORTHAND member (`updateTaskReq,`) stayed green, absorbed into a
  // neighbour's text slice while `total` sat unchanged at 214.
  //
  // The real check is an INDEPENDENT count. The AST counts object properties; this regex counts
  // member-shaped LINES, the way the retired classifier did. They must agree — and a shorthand member
  // is precisely the case where they do not, because the AST sees it and the line pattern does not.
  const lineCount = (apiObjectText(apiSrc).match(/^ {2}[A-Za-z0-9_]+\s*[:,]/gm) ?? []).length;
  assert.equal(API_MEMBERS.total, lineCount,
    `the AST sees ${API_MEMBERS.total} api properties but a line scan sees ${lineCount} —`
    + " they must agree. A mismatch means one method is blind to a member shape the other sees"
    + " (a shorthand member, a computed key, a quoted key), and the blind one may be the sweep's.");
  // Fail-closed covers a shorthand member too: it has no calls, so it cannot be a read.
  for (const name of API_MEMBERS.shorthand) {
    assert.ok(API_MEMBERS.writes.has(name),
      `the shorthand member \`${name}\` must classify as a WRITE — it makes no read call`);
  }

  for (const known of ["updateTask", "deleteAgent", "dismissQuestion", "mergeWorker", "updateProfile",
    "startSession", "stopSession", "resumeSession", "updateAgent", "createSchedule", "deleteSchedule",
    "sendInput", "createTask", "deleteVaultFile"]) {
    assert.ok(API_MEMBERS.writes.has(known), `api.${known} must classify as a WRITE`);
  }
  // Polarity control: without this, "classify everything as a write" would pass every assertion above.
  for (const read of ["platformHome", "setupHome", "allSessions", "profiles", "schedules", "board",
    "archivedSessions", "projects", "gitLog"]) {
    assert.ok(API_MEMBERS.reads.has(read), `api.${read} is a READ — it must not classify as a write`);
  }

  // 🔴 THE THREE THE REGEX GOT WRONG, pinned by name. Each calls `guardedFetch` and NO read helper, and
  // each classified as a READ purely because its body also calls `r.headers.get("content-type")` — a
  // METHOD call the old pattern could not tell from the `get(…)` helper. All three were outside the
  // sweep entirely. This is the regression pin for that whole class, and it is also why the retired
  // `deepestReadHit > 300` assertion had to go: its own specimen was `vaultRawBlob`, so the assertion
  // was encoding the defect rather than guarding against it.
  for (const wasMisread of ["vaultRawBlob", "vaultRawHead", "questionAttachmentBlob"]) {
    assert.ok(API_MEMBERS.writes.has(wasMisread),
      `api.${wasMisread} must classify as a WRITE — it calls guardedFetch and no read helper, so a read`
      + " verdict means method calls are being counted as helper calls again");
  }
});

// card 66b9e590 closed the "other calls" side's fail-open gaps (an imported helper, method-form fetch,
// new WebSocket/EventSource). None of today's real reads/writes actually exercise any of those three
// shapes (re-measured against this exact api.ts before writing the fix), so the exact count is unchanged
// from before that fix — pinned exactly, not just by the >= thresholds above, so a FUTURE api.ts change
// that newly crosses one of those shapes is visible as a count change here rather than silently absorbed.
// Card 40646822 added one new write member (`gitMainlineWatermarkReset`, a `post<...>` call to the
// human-only mainline-watermark reset route) — 214→215 total, 121→122 writes, reads unchanged at 93.
check("the exact read/write split is unchanged by card 66b9e590's fail-closed fix, plus card 40646822's gitMainlineWatermarkReset write (93 reads / 122 writes / 215 members)", () => {
  assert.equal(API_MEMBERS.total, 215, `api.ts now has ${API_MEMBERS.total} members, not 215`);
  assert.equal(API_MEMBERS.reads.size, 93, `api.ts now has ${API_MEMBERS.reads.size} reads, not 93`);
  assert.equal(API_MEMBERS.writes.size, 122, `api.ts now has ${API_MEMBERS.writes.size} writes, not 122`);
});

// ── card 66b9e590 — planted negative controls proving the "other calls" side is now fail-closed. ─────
// Each is a MINIMAL, self-contained api.ts-SHAPED fixture (its own get/getOrNull/getErr/guardedFetch
// declarations, so it drives the SAME fixpoint the real file does) with one planted member calling
// get(...) plus exactly one additional call — one of the three named fail-open shapes this card closes,
// or (d) an arbitrary unlisted one, proving the verdict is fail-closed rather than a patched list of
// three. Each must classify as a WRITE. Measured directly against the pre-fix logic before writing these
// as assertions: all four read as READ under it (RED) and WRITE under the fix (GREEN); the baseline
// fixture with no extra call reads as READ under both, so a control fails because of what it adds, not
// because the fixture itself can't read.
function fixtureWithPlantedMember(extra, { withImport = false } = {}) {
  const importLine = withImport ? 'import { importedHelper } from "./elsewhere";\n' : "";
  return `${importLine}function guardedFetch(url) { return fetch(url); }
function get(url) { return guardedFetch(url); }
function getOrNull(url) { return guardedFetch(url); }
function getErr(url) { return guardedFetch(url); }
export const api = {
  planted: () => { get("/x"); ${extra} },
};
`;
}

check("the planted-member fixture itself classifies as a READ with no extra call (the controls' baseline)", () => {
  const { reads } = classifyApiMembers(fixtureWithPlantedMember(""), "fixture-baseline.ts");
  assert.ok(reads.has("planted"), "get(...) alone, with nothing else, must still classify as a READ");
});

check("planted control (a): get(...) + an IMPORTED request helper classifies as a WRITE", () => {
  const src = fixtureWithPlantedMember("importedHelper();", { withImport: true });
  assert.ok(classifyApiMembers(src, "fixture-a.ts").writes.has("planted"),
    "a read also calling a helper imported from another module must be a WRITE");
});

check("planted control (b): get(...) + window.fetch(...) classifies as a WRITE", () => {
  const src = fixtureWithPlantedMember('window.fetch("/x");');
  assert.ok(classifyApiMembers(src, "fixture-b.ts").writes.has("planted"),
    "a read also calling method-form fetch (window.fetch/globalThis.fetch) must be a WRITE");
});

check("planted control (c): get(...) + new EventSource(...) classifies as a WRITE", () => {
  const src = fixtureWithPlantedMember('new EventSource("/x");');
  assert.ok(classifyApiMembers(src, "fixture-c.ts").writes.has("planted"),
    "a read also opening a new EventSource (or, same shape, WebSocket) must be a WRITE");
});

check("planted control (d): get(...) + a NEW, unlisted bare function classifies as a WRITE"
  + " (the fail-closed proof)", () => {
  const src = fixtureWithPlantedMember("someFutureHelperNobodyHasSeen();");
  assert.ok(classifyApiMembers(src, "fixture-d.ts").writes.has("planted"),
    "a read calling ANY bare function outside the reasoned allowlist must be a WRITE — not just the"
    + " three named shapes above, or this is a patched list rather than a fail-closed verdict");
});

// 🔴 planted control (e) — the fixpoint's OWN residual (named in decision b472645a's not-caught list
// until this follow-up closed it): a DECLARED helper that performs its request as a METHOD call on the
// bare identifier `api` (exactly how `restartCompanionSession` calls `api.stopSession(…)`) used to be
// invisible to `requestShapedHelpers`'s bare-call-only walk, so it landed in `pureHelpers` and a read
// calling it stayed misclassified as a read. Unlike (a)-(d), the extra call here is INDIRECT — through
// a sibling declared helper the planted member calls — so it proves the fixpoint itself closed the gap,
// not just the per-member allowlist.
check("planted control (e): get(...) + a declared helper calling api.updateTask(...) classifies as a WRITE", () => {
  const src = `function guardedFetch(url) { return fetch(url); }
function get(url) { return guardedFetch(url); }
function getOrNull(url) { return guardedFetch(url); }
function getErr(url) { return guardedFetch(url); }
function helperCallingApi() { return api.updateTask("x"); }
export const api = {
  planted: () => { get("/x"); helperCallingApi(); },
};
`;
  const result = classifyApiMembers(src, "fixture-e.ts");
  assert.ok(result.shaped.has("helperCallingApi"),
    "a declared helper calling api.<x>(...) must itself be request-shaped — every api member issues a"
    + " request, so the receiver name alone is enough");
  assert.ok(result.writes.has("planted"),
    "a read calling a helper that itself calls api.updateTask(...) must be a WRITE — the helper is not"
    + " request-free just because the fixpoint never saw a bare fetch/guardedFetch call inside it");
});

/** The `api` object literal's own source text — for the independent line count above only. */
function apiObjectText(src) {
  const decl = src.indexOf("export const api = {");
  const start = src.indexOf("{", decl);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error("api.ts: unbalanced braces in the api object");
}

// Where the walk STOPS. Each entry is a decision, with its reason, about a whole subtree — so the sweep
// stays a list of decisions rather than a list of every file in the app. A boundary file's own writes are
// covered by its reason; the walk does not descend past it.
//
// ⚠️ `pages/Schedules.tsx` is the one entry that is NOT a "we decided not to gate this" — it is reached
// only because PlatformView imports the pure helper `looksLikeCron` from it. Import reachability is not
// render reachability, and that distinction is checked below rather than asserted in prose.
const SWEEP_BOUNDARIES = new Map(Object.entries({
  "components/PlatformSessionTile.tsx":
    "GATED AT THIS BOUNDARY — in a preview the tile passes readOnly + lifecycle=\"none\" + no subPanels"
    + " (each asserted by its own check above), so neither its own stop nor anything in TerminalCard's"
    + " subtree (Composer stdin, SessionQueue, SessionWakes, PresetPrompts, useSessionActions) is"
    + " reachable. The props ARE the gate; that is why they are pinned and not just commented.",
  // 🔴 The ground here was WRONG until round 3, and wrong in the direction that matters. It used to read
  // "the same board is reachable at /board, so a gate here contains nothing" — FALSE: a RESERVED home is
  // not selectable in the project picker (`db.ts` listProjects filters `reserved = 0`; see
  // `lib/activeProject.tsx`'s own note), so on a dev install this preview is the ONLY UI route to the
  // setup home's board. The decision did not change; its justification did.
  "pages/Board.tsx":
    "UNGATED by decision b472645a on R2's CRITERION, not on reachability: card CRUD writes TASKS, and a"
    + " task is not one of the previewed home's agents/schedules/sessions. ⚠️ NAMED RESIDUAL: this"
    + " subtree includes components/requests.tsx, whose answer/dismiss/credential actions and NudgeMgr's"
    + " sendInput WOULD act on a session. They are unreachable today only because no role the setup home"
    + " hosts on a DEV install registers question_ask — see the record for the verified reason and the"
    + " follow-up trigger.",
  "pages/PlatformFindings.tsx":
    "UNGATED by decision b472645a — the preset-suggestion store is daemon-GLOBAL, not home-scoped, so"
    + " Adopt/Dismiss here is identical to doing it from any composer popover.",
  "components/SetupWizard.tsx":
    "UNGATED by decision b472645a — guided setup is edition-agnostic, present identically in the Developer"
    + " view, and it creates a NEW project rather than touching the previewed home.",
  "pages/Schedules.tsx":
    "NOT RENDERED — imported solely for the pure helper `looksLikeCron`. Its own schedule CRUD belongs to"
    + " the Schedules PAGE, which this shell never mounts. Checked, not assumed (see the import check).",
  "lib/api.ts":
    "THE API CLIENT ITSELF — its internal `api.<write>(` occurrences are those members' own"
    + " implementations and a couple of library helpers, not controls a preview can click.",
}));

check("Schedules.tsx is imported for a PURE HELPER only — the one boundary that is a fact, not a decision", () => {
  // The whole Schedules page sits in the import graph because of one named helper. If someone later
  // imports a COMPONENT from it and renders it here, that page's own schedule CRUD becomes genuinely
  // reachable from this shell and the boundary's reason silently becomes false. Pinning the import list
  // is what turns that from prose into a check.
  const imports = [...shellSrc.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/Schedules"/g)];
  assert.equal(imports.length, 1, "expected exactly one import from ./Schedules in PlatformView.tsx");
  const named = imports[0][1].split(",").map((s) => s.trim()).filter(Boolean).sort();
  assert.deepEqual(named, ["looksLikeCron"],
    `PlatformView.tsx imports ${named.join(", ")} from ./Schedules — if that now includes a component,`
    + " the SWEEP_BOUNDARIES reason for pages/Schedules.tsx ('NOT RENDERED') is no longer true:"
    + " either stop rendering it or move that subtree out of the boundary list and gate its writes.");
});

/** Every LOCAL module transitively reachable from PlatformView.tsx, stopping at SWEEP_BOUNDARIES. */
function transitiveLocalModules(entryRel) {
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  const rel = (abs) => path.relative(srcDir, abs).split(path.sep).join("/");
  const resolveLocal = (fromAbs, spec) => {
    if (!spec.startsWith(".")) return null; // a package import — not ours to sweep
    const base = path.resolve(path.dirname(fromAbs), spec);
    for (const c of [`${base}.tsx`, `${base}.ts`, path.join(base, "index.tsx"), path.join(base, "index.ts")]) {
      if (existsSync(c)) return c;
    }
    return null;
  };
  const seen = new Set();
  const out = [];
  (function walk(abs) {
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push(rel(abs));
    if (SWEEP_BOUNDARIES.has(rel(abs))) return; // a decided boundary — do not descend
    for (const spec of moduleSpecifiers(readFileSync(abs, "utf8"))) {
      if (!spec.startsWith(".")) continue; // a package import — not ours to sweep
      const next = resolveLocal(abs, spec);
      // ⚠️ An UNRESOLVABLE relative specifier used to be skipped in silence, which is the same failure
      // as a skipped module: a real local import the walk never follows, and nothing to show it. A
      // relative specifier that does not resolve means the resolver's extension/index candidates have
      // fallen behind the tree, so fail loudly instead of quietly sweeping less.
      assert.ok(next, `${rel(abs)} imports "${spec}", which this walk could not resolve to a file —`
        + " the sweep would silently skip that module and everything under it");
      walk(next);
    }
  })(path.join(srcDir, entryRel));
  return out;
}

/**
 * Every module specifier a file imports/exports from, plus its dynamic `import("…")` targets.
 *
 * ⚠️ NO CHARACTER WINDOW. The previous version matched `import[\s\S]{0,400}?from "…"`, which silently
 * SKIPS a module whose import clause is longer than the window — a long named-import list is ordinary in
 * this tree, and a skipped module is a whole subtree dropped out of the sweep with nothing to show it.
 * This walks from each `import`/`export` keyword to its own terminating specifier instead, so clause
 * length is irrelevant.
 */
function moduleSpecifiers(src) {
  const specs = [];
  // Static: `import … from "x"`, `export … from "x"`, and the bare side-effect form `import "x"`.
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\b/g)) {
    const from = m.index + m[0].length;
    // The clause ends at the first `from "…"` / `from '…'`, or (bare import) at an immediate string.
    const rest = src.slice(from);
    // The clause ends at the NEXT `import`/`export` statement, and at nothing else. ⚠️ An earlier
    // version also terminated on `const|let|var|function|class|type|interface`, which broke on this
    // repo's own multi-line named imports: `import {\n  type PlatformEdition, …\n} from "./x"` was cut
    // at its `type` line, dropping `./platformEdition` — and with it that module's whole subtree. Caught
    // by the reference-scan differential below, not by reading the regex.
    const end = rest.search(/\n[ \t]*(?:import|export)\b/);
    const clause = end >= 0 ? rest.slice(0, end) : rest;
    const named = /^\s*["']([^"']+)["']/.exec(clause) ?? /\bfrom\s*["']([^"']+)["']/.exec(clause);
    if (named) specs.push(named[1]);
  }
  // Dynamic: `import("x")` and `lazy(() => import("x"))` both resolve a real module at runtime.
  for (const m of src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) specs.push(m[1]);
  return specs;
}

/** Every write site in one module, keyed `<file>::<enclosing fn>.<token>`, deduped by source offset. */
function writeSites(relFile, src) {
  const fns = [...src.matchAll(/\bfunction\s+([A-Za-z0-9_]+)\s*\(/g)].map((m) => ({ i: m.index, name: m[1] }));
  const scopeAt = (i) => (fns.filter((f) => f.i < i).pop()?.name ?? "<module>");
  const byOffset = new Map(); // offset -> key, so overlapping patterns can't double-count one site
  const add = (i, token) => { if (!byOffset.has(i)) byOffset.set(i, `${relFile}::${scopeAt(i)}.${token}`); };

  // (1) useMutation in every shape, named or destructured, plain or generic.
  for (const m of src.matchAll(/(?:const\s+(?:([A-Za-z0-9_]+)|\{[^}]*\})\s*=\s*)?\buseMutation\s*[<(]/g)) {
    add(m.index, m[1] ? m[1] : "useMutation");
  }
  // (2) a custom hook wrapping a mutation. `useMutation` itself matches this shape, so (1)'s offsets
  // already claimed those — hence the offset dedupe rather than a negative lookahead.
  for (const m of src.matchAll(/(?:const\s+(?:([A-Za-z0-9_]+)|\{[^}]*\})\s*=\s*)?\b(use[A-Za-z0-9_]*(?:Session|Mutation)[A-Za-z0-9_]*)\s*\(/g)) {
    add(m.index, m[1] ? `${m[1]}=${m[2]}` : m[2]);
  }
  // (3) a raw write through the api client, wherever it sits.
  for (const m of src.matchAll(/\bapi\.([A-Za-z0-9_]+)\s*\(/g)) {
    if (API_WRITE_MEMBERS.has(m[1])) add(m.index, `api.${m[1]}`);
  }
  // (4) a request that BYPASSES the api client entirely. `api.*` is the convention, not a constraint —
  // a bare `fetch` or a `sendBeacon` is just as much a write, and neither would match anything above.
  for (const m of src.matchAll(/(?<!\w)fetch\s*\(/g)) add(m.index, "fetch");
  for (const m of src.matchAll(/\bnavigator\s*\.\s*sendBeacon\s*\(/g)) add(m.index, "sendBeacon");
  // (5) a module boundary the WALK cannot follow statically to a known file — `lazy(() => import(x))`
  // or a dynamic `import(x)` whose target this sweep did resolve is fine, but the SITE is still recorded
  // so a decision exists about the subtree it pulls in.
  for (const m of src.matchAll(/\blazy\s*\(/g)) add(m.index, "lazy");
  for (const m of src.matchAll(/\bimport\s*\(/g)) add(m.index, "dynamic-import");
  // Two sites in one function can legitimately share a key — `save` and `toggle` both call
  // api.updateSchedule. Suffix the repeats in SOURCE ORDER (`…#2`, `…#3`) rather than collapsing them:
  // collapsing would let a THIRD such call be added with no entry and no failure, which is the whole
  // property this sweep exists to provide.
  const ordered = [...byOffset.keys()].sort((a, b) => a - b).map((i) => byOffset.get(i));
  const seenCount = new Map();
  return ordered.map((key) => {
    const n = (seenCount.get(key) ?? 0) + 1;
    seenCount.set(key, n);
    return n === 1 ? key : `${key}#${n}`;
  });
}

// Every write site in the ENUMERATED (non-boundary) part of the graph, each with its decision. A site
// here is reachable from the preview, so every entry must say what holds it — or why nothing needs to.
const WRITE_SITE_DECISIONS = new Map(Object.entries({
  // ── pages/PlatformView.tsx — the shell's own controls ──
  "pages/PlatformView.tsx::AgentControl.spawn": "GATED — previewDisabled (the original f437d4e9 C5 gate)",
  "pages/PlatformView.tsx::AgentControl.api.startSession": "the spawn mutation's own call",
  "pages/PlatformView.tsx::AgentControl.stop": "GATED — previewDisabled (b472645a)",
  "pages/PlatformView.tsx::AgentControl.api.stopSession": "the stop mutation's own call",
  "pages/PlatformView.tsx::AuditorScheduleInlineForm.create": "GATED — `held` + the disabled fieldset",
  "pages/PlatformView.tsx::AuditorScheduleInlineForm.save": "GATED — `held` + the disabled fieldset",
  "pages/PlatformView.tsx::AuditorScheduleInlineForm.toggle": "GATED — `held` + the disabled fieldset",
  "pages/PlatformView.tsx::AuditorScheduleInlineForm.remove": "GATED — `held` + the disabled fieldset",
  "pages/PlatformView.tsx::AuditorScheduleInlineForm.api.createSchedule": "that form's create call",
  "pages/PlatformView.tsx::AuditorScheduleInlineForm.api.updateSchedule": "that form's save call",
  "pages/PlatformView.tsx::AuditorScheduleInlineForm.api.updateSchedule#2": "that form's enable/disable call",
  "pages/PlatformView.tsx::AuditorScheduleInlineForm.api.deleteSchedule": "that form's remove call",
  "pages/PlatformView.tsx::AuditorScheduleList.create": "UNGATED by decision b472645a — the dev LIST"
    + " variant, unreachable in a preview (previewOnly rides the end-user mount only, and that edition's"
    + " auditorScheduleVariant is single-form), so a gate here would be dead code no test can exercise",
  "pages/PlatformView.tsx::AuditorScheduleList.toggle": "UNGATED — same dev LIST variant",
  "pages/PlatformView.tsx::AuditorScheduleList.remove": "UNGATED — same dev LIST variant",
  "pages/PlatformView.tsx::AuditorScheduleList.api.createSchedule": "that list's create call",
  "pages/PlatformView.tsx::AuditorScheduleList.api.updateSchedule": "that list's toggle call",
  "pages/PlatformView.tsx::AuditorScheduleList.api.deleteSchedule": "that list's remove call",
  // ── components/AgentPromptEditor.tsx ──
  "components/AgentPromptEditor.tsx::AgentPromptEditor.save":
    "GATED — readOnly, which holds the TEXTAREA so the Ctrl/Cmd+Enter path cannot fire either",
  "components/AgentPromptEditor.tsx::AgentPromptEditor.api.updateAgent": "that editor's save call",
  // ── components/RunHistory.tsx — the Code Review's Critical finding ──
  "components/RunHistory.tsx::RunRow.resumeM":
    "GATED — previewOnly (b472645a round 2). Resume un-archives AND respawns the previewed home's own"
    + " session, and the end-user edition renders history EXPANDED, so it needed no disclosure click.",
  "components/RunHistory.tsx::RunRow.api.resumeSession": "that Resume button's call",
  // ── lib/loopbackCredential.ts — in the graph, but not for this ──
  "lib/loopbackCredential.ts::verifyLoopbackToken.fetch":
    "NOT REACHABLE FROM THIS GRAPH — a bare POST probe that tests whether a pasted loopback credential"
    + " passes the human-only write guard (@decision 093981dd: never verify one with a GET). The swept"
    + " modules import ONLY `errorText` from this file, never `verifyLoopbackToken`, and the credential"
    + " UI that does call it is not part of the Platform surface. Checked, not assumed — see the"
    + " import-symbol check below.",
}));

check("the import parser finds every LOCAL specifier a trivial reference scan does", () => {
  // ⚠️ HONEST SCOPE. The clause parser takes no character window, because a window silently SKIPS a
  // module whose import clause is longer than it — and a skipped module is a whole subtree dropped from
  // the sweep with nothing to show it. But reintroducing a window would NOT fail anything today: the
  // longest clause-to-`from` distance in this graph is 123 chars, and it sits in `pages/Board.tsx`,
  // which is a BOUNDARY the walk never descends into. So the hazard here is LATENT, not live, and a
  // "revert it and watch it go red" control does not exist for it yet.
  //
  // This is that control's replacement, and unlike a window-sized assertion it fires the moment any
  // swept module's clause grows past whatever window someone reintroduces: a DIFFERENTIAL against a
  // trivially-correct reference scan (`from "<relative>"` anywhere in the file, no windowing possible).
  // The parser must find at least everything the reference finds.
  const modules = transitiveLocalModules("pages/PlatformView.tsx");
  let compared = 0;
  for (const rel of modules) {
    const src = readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
    const reference = [...src.matchAll(/\bfrom\s*["'](\.[^"']*)["']/g)].map((m) => m[1]).sort();
    const parsed = moduleSpecifiers(src).filter((s) => s.startsWith(".")).sort();
    for (const spec of reference) {
      assert.ok(parsed.includes(spec),
        `${rel}: the import parser MISSED the local specifier "${spec}" that a plain scan finds —`
        + " a character window has been reintroduced, and that silently drops a subtree");
    }
    compared += reference.length;
  }
  // Anti-vacuity: comparing zero specifiers would pass for nothing.
  assert.ok(compared >= 40, `only ${compared} local specifier(s) compared — the reference scan is broken`);
});

check("the swept graph imports only the `api` object from lib/api — never a write exported beside it", () => {
  // 🔴 A WRITE CAN BE EXPORTED FROM api.ts WITHOUT BEING A MEMBER OF `api`. `restartCompanionSession`
  // (api.ts ~:1396) is exactly that: an exported async function that issues a write and belongs to no
  // object the classifier walks. The `api.<write>(` pattern cannot see a call to it, and neither can the
  // member classification — so the sweep's whole api-side coverage rests on the graph reaching writes
  // ONLY through the `api` object.
  //
  // That is a real property, not a hope, so it is asserted: every swept module's VALUE imports from
  // lib/api must be exactly `api`. A type-only import is irrelevant (it emits nothing) and is allowed.
  const modules = transitiveLocalModules("pages/PlatformView.tsx");
  let importers = 0;
  for (const rel of modules) {
    if (SWEEP_BOUNDARIES.has(rel)) continue;
    const src = readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
    for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*["'][^"']*\/api["']/g)) {
      if (m[1]) continue; // `import type { … }` — erased at compile time, cannot call anything
      const named = m[2].split(",").map((s) => s.trim()).filter(Boolean)
        .filter((s) => !s.startsWith("type ")); // inline `type X` specifiers, same reasoning
      importers++;
      assert.deepEqual(named, ["api"],
        `${rel} imports ${named.join(", ")} as VALUES from lib/api — only the \`api\` object is swept.`
        + " A write exported beside it (e.g. restartCompanionSession) is invisible to this sweep, so"
        + " importing one here needs its own decision, not a silent pass.");
    }
  }
  assert.ok(importers >= 3,
    `only ${importers} lib/api value-import(s) found across the swept graph — the scan is broken`);
});

check("the swept graph imports only `errorText` from loopbackCredential — never its POST probe", () => {
  // The companion check to that write-site entry. `lib/loopbackCredential.ts` is genuinely IN the swept
  // graph (three Platform modules import its error formatter), so its credential-probe POST shows up in
  // the sweep. The entry's claim is that nothing here can CALL it — which is a claim about the imported
  // SYMBOLS, so assert those rather than restating it in prose. Deliberately NOT a boundary: keeping the
  // module swept means a NEW write added to it still needs its own decision.
  const modules = transitiveLocalModules("pages/PlatformView.tsx");
  const importers = [];
  for (const rel of modules) {
    if (SWEEP_BOUNDARIES.has(rel)) continue;
    const src = readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*loopbackCredential["']/g)) {
      importers.push({ rel, named: m[1].split(",").map((s) => s.trim()).filter(Boolean) });
    }
  }
  assert.ok(importers.length >= 1,
    "expected at least one swept module to import from loopbackCredential — if none does, this check"
    + " and its write-site entry are both stale and should go");
  for (const { rel, named } of importers) {
    assert.deepEqual(named, ["errorText"],
      `${rel} imports ${named.join(", ")} from loopbackCredential — only \`errorText\` is accounted for.`
      + " Importing verifyLoopbackToken here would make its POST genuinely reachable from the preview.");
  }
});

check("the transitive write sweep: every write reachable from PlatformView is decided", () => {
  const modules = transitiveLocalModules("pages/PlatformView.tsx");
  // Anti-vacuity on the WALK itself, before trusting anything it found: a broken resolver returns just
  // the entry file, and a one-file graph would make the rest of this check pass while sweeping nothing.
  assert.ok(modules.length >= 15,
    `the transitive walk reached only ${modules.length} module(s) — the import resolver is broken`);
  assert.ok(modules.includes("components/RunHistory.tsx"),
    "the walk must reach components/RunHistory.tsx — the leaf whose Resume button this sweep exists to catch");
  for (const boundary of SWEEP_BOUNDARIES.keys()) {
    assert.ok(modules.includes(boundary),
      `SWEEP_BOUNDARIES names ${boundary}, which the walk never reaches — drop the entry or fix the path`);
  }

  const found = [];
  for (const rel of modules) {
    if (SWEEP_BOUNDARIES.has(rel)) continue; // covered wholesale by its reason
    const abs = fileURLToPath(new URL(`../src/${rel}`, import.meta.url));
    found.push(...writeSites(rel, readFileSync(abs, "utf8")));
  }
  assert.ok(found.length >= 20, `the sweep found only ${found.length} write site(s) — a pattern is broken`);
  // Keys are unique by construction (`writeSites` suffixes repeats), so this is not a duplicate check —
  // it is an anti-regression check on THAT, since a future edit to the keying could silently collapse
  // two sites back into one and take a whole write out of scope without failing anything else.
  assert.equal(new Set(found).size, found.length,
    `the keying collapsed two write sites into one — repeats must be suffixed, not merged: ${found.join(", ")}`);

  const unlisted = found.filter((k) => !WRITE_SITE_DECISIONS.has(k));
  assert.deepEqual(unlisted, [],
    `WRITE(S) reachable from the Platform preview with no decision recorded:\n  ${unlisted.join("\n  ")}\n`
    + "Either thread the preview gate through it (see @decision b472645a) and add it to"
    + " WRITE_SITE_DECISIONS with that reason, or — if a whole subtree is deliberately ungated — add that"
    + " subtree's root to SWEEP_BOUNDARIES with its reason. Do NOT add it to a list alone.");
  const stale = [...WRITE_SITE_DECISIONS.keys()].filter((k) => !found.includes(k));
  assert.deepEqual(stale, [],
    `WRITE_SITE_DECISIONS names site(s) that no longer exist: ${stale.join(", ")} — drop the entries.`);
});

check("the gate is never derived from the toggle below Platform.tsx — 8adccd37 still holds", () => {
  // Gating is COMPATIBLE with @decision 8adccd37 only while it stays a boolean handed DOWN. The moment a
  // leaf reads the toggle's key (or storage) to decide, the toggle has been wired into a write path.
  for (const [name, src] of [["PlatformView.tsx", shellSrc], ["AgentPromptEditor.tsx", promptEditorSrc],
    ["PlatformSessionTile.tsx", sessionTileSrc]]) {
    assert.ok(!src.includes("loom.platformViewAs"), `${name} must not reference the preview toggle key`);
    assert.ok(!src.includes("localStorage"), `${name} must not read browser storage`);
  }
});

console.log(`\n${pass} passed`);
