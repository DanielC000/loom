import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// PATCH /api/projects/:id/config now DEEP-MERGES by default instead of replacing the whole override
// (card 546034fa) — matching every MCP config-write surface (project_configure/project_update), closing
// the asymmetry where the HUMAN route was the one that silently destroyed sibling config on a
// single-key PATCH (this recurred twice on this host before the fix: a sessionEnv-only PATCH would have
// deleted orchestration.gateCommand + maxConcurrentManagers with no error and no warning).
//
// Proves:
//   (1) a single-key PATCH preserves sibling orchestration keys — the exact near-miss reproduced.
//   (2) a nested object (sessionEnv) merges field-by-field, not scalar-replace of the whole object.
//   (3) `unset: [dot-paths]` expresses deletion the merge itself cannot; a sibling key survives it.
//   (4) `replace: true` opts back into the old whole-object-replace behavior, byte-identical to before.
//   (5) this human REST path carries NO additiveOnlyRotationGuard: a rotationMarkers entry can be
//       REMOVED, rotationLiveCommitmentsFloor can be LOWERED, and rotationLiveCommitmentsHeading can be
//       RE-POINTED through it (@decision 1069c8e1) — the documented escape hatch Settings.tsx relies on.
//   (6) an invalid PATCH (unknown top-level key) is REJECTED and the stored config is left UNCHANGED.
//   (7)-(9) the daemon-level MECHANISM behind the Settings.tsx UI's three clear paths (card 546034fa's
//       own web-side follow-up) — memory / alertWebhook / rotationMarkers+heading — each cleared via
//       `unset` and asserted GENUINELY ABSENT (not stored-empty), with an untouched sibling surviving.
//       This is a hermetic PROOF of the mechanism those UI e2e specs exercise (settings.spec.ts,
//       settings-rotation-markers.spec.ts), on a suite that actually runs in this rig — this file cannot
//       drive the browser itself, so it does not stand in for running those specs.
//   (10) the REGRESSION a live e2e run against this branch actually caught: `unsetConfigPath` now PRUNES
//       a now-empty parent after unsetting EVERY leaf of a group one dot-path at a time (the real
//       Settings.tsx shape — `applyNumField` pushes one path per field, never a single group-level
//       path) — in either leaf order, and a PARTIAL clear does NOT prune (the untouched sibling leaf
//       survives).
//   (11) card b5faa194: the handler still merge-THEN-unsets, but a write and an `unset` of the SAME
//       dot-path in ONE payload is now REFUSED (400, naming the path, stored config UNCHANGED) instead
//       of silently discarding the write — and a NON-colliding rename (a different key written vs.
//       unset) is unaffected, so the refusal is specific to the actual collision. Settings.tsx's
//       sessionEnv editor (card 32b23f0f) already avoids the collision client-side, which is why the
//       two-pass payload it actually sends (no unset for a name it writes back) is proven well-formed.
//   (12) an `unset` dot-path genuinely deletes a sessionEnv key, and an unmodeled `pty` override
//       survives a sessionEnv-only write — relocated from credential-sessionenv-spawn.mjs, which is
//       Windows-gated for its real-spawn fixture, so these two platform-independent assertions never
//       ran on ubuntu CI there.
//   (13) `findConfigPatchUnsetCollisions` (mcp/platform.ts) — the shared primitive BOTH the REST handler
//       above and mcp/platform.ts's project_configure call before merging — imported straight from dist
//       and exercised directly: exact-path collisions, ancestor-vs-descendant collisions, a primitive
//       write making a deeper unset path unreachable (matching unsetConfigPath's own no-op), a mixed
//       payload returning only the genuinely colliding path — PLUS (reviewer session 4275d929, reviewing
//       commit 3425b1a3) a prototype-family name (constructor/toString/valueOf/hasOwnProperty/__proto__)
//       the patch never actually WROTE is never a false-positive collision (own-property semantics via
//       Object.hasOwn, matching unsetConfigPath's own descent, card e07daa96), while a genuinely OWN key
//       sharing one of those names is still a real collision when written — and a zero-segment unset
//       path ("."/"..") is never a collision (mirrors unsetConfigPath's own documented no-op).
//   (14) end-to-end: a zero-segment unset ("unset: [\".\"]") alongside a real write is no longer wrongly
//       REFUSED through the REST handler — the same regression case (13) proves at the primitive level.
//   (15) card e4e854cc: a raw `sessionEnv.__proto__` key is REFUSED at validation (400, stored config
//       UNCHANGED) instead of zod's `z.record` silently dropping it and returning 200 — driven through
//       the real REST handler (validateProjectConfigOverride is its first step), PLUS a positive control
//       sweeping the same 10 prototype-family names as (13) through the same PATCH path: each is a
//       genuine own key of the request body and lands correctly, proving the __proto__ refusal is
//       specific to that one name, not a side effect of the sweep rejecting the whole family.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic: a REAL Db + the REAL Fastify gateway
// (app.inject), every other dep STUBBED — mirrors mgmt-project-agent.mjs's minimal harness (this route
// never touches sessions/pty, so there is nothing real to boot).
//
// Run: 1) build (turbo builds shared first), 2) node test/project-config-patch-merge.mjs
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-cfgpatchmerge-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { findConfigPatchUnsetCollisions, validateProjectConfigOverride } = await import("../dist/mcp/platform.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const now = new Date().toISOString();
const dbFile = path.join(TMP, "loom.db");
const db = new Db(dbFile);
const stub = {};
let app;
try {
  app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const patch = (id, payload) => app.inject({ method: "PATCH", url: `/api/projects/${id}/config`, payload });

  // ===================== (1)+(2) single-key PATCH preserves siblings; nested objects deep-merge =====================
  db.insertProject({
    id: "pA", name: "A", repoPath: TMP, vaultPath: TMP,
    config: { orchestration: { gateCommand: "npm run lint && npm test && npm run build", maxConcurrentManagers: 12 }, sessionEnv: { FOO: "1" } },
    createdAt: now, archivedAt: null, reserved: false,
  });
  const r1 = await patch("pA", { config: { sessionEnv: { BAR: "2" } } });
  check("(1) single-key PATCH → 200", r1.statusCode === 200);
  const cfgA = db.getProject("pA").config;
  check("(1) ★ gateCommand SURVIVES an unrelated sessionEnv PATCH (the exact near-miss)", cfgA.orchestration.gateCommand === "npm run lint && npm test && npm run build");
  check("(1) ★ maxConcurrentManagers SURVIVES too", cfgA.orchestration.maxConcurrentManagers === 12);
  check("(2) ★ sessionEnv MERGES field-by-field — FOO survives, BAR is added", cfgA.sessionEnv.FOO === "1" && cfgA.sessionEnv.BAR === "2");

  // ===================== (3) unset deletes a key the merge cannot remove; a sibling survives =====================
  const r2 = await patch("pA", { unset: ["orchestration.gateCommand"] });
  check("(3) unset-only PATCH (no config key) → 200", r2.statusCode === 200);
  const cfgA2 = db.getProject("pA").config;
  check("(3) ★ gateCommand is GONE after unset", cfgA2.orchestration.gateCommand === undefined);
  check("(3) ★ the sibling maxConcurrentManagers SURVIVES the unset", cfgA2.orchestration.maxConcurrentManagers === 12);
  check("(3) sessionEnv is untouched by an orchestration-scoped unset", cfgA2.sessionEnv.FOO === "1" && cfgA2.sessionEnv.BAR === "2");

  // ===================== (4) replace:true opts back into whole-object replace, byte-identical to before =====================
  const r3 = await patch("pA", { config: { docLint: true }, replace: true });
  check("(4) replace:true PATCH → 200", r3.statusCode === 200);
  const cfgA3 = db.getProject("pA").config;
  check("(4) ★ replace:true REPLACES the whole override — sessionEnv/orchestration are GONE", cfgA3.sessionEnv === undefined && cfgA3.orchestration === undefined);
  check("(4) the new value is stored exactly", cfgA3.docLint === true);

  // ===================== (5) no additiveOnlyRotationGuard: this REST path can SHRINK/LOWER/RE-POINT =====================
  db.insertProject({
    id: "pB", name: "B", repoPath: TMP, vaultPath: TMP,
    config: { orchestration: {
      rotationMarkers: [{ token: "ALPHA" }, { token: "BETA" }],
      rotationLiveCommitmentsFloor: 5,
      rotationLiveCommitmentsHeading: "## Commitments",
    } },
    createdAt: now, archivedAt: null, reserved: false,
  });
  const r4 = await patch("pB", { config: { orchestration: {
    rotationMarkers: [{ token: "ALPHA" }],
    rotationLiveCommitmentsFloor: 1,
    rotationLiveCommitmentsHeading: "## Different heading",
  } } });
  check("(5) rotation-shrink PATCH → 200", r4.statusCode === 200);
  const cfgB = db.getProject("pB").config;
  check("(5) ★ a rotationMarkers entry was REMOVED (not additive-only)", cfgB.orchestration.rotationMarkers.length === 1 && cfgB.orchestration.rotationMarkers[0].token === "ALPHA");
  check("(5) ★ rotationLiveCommitmentsFloor was LOWERED (not rise-only)", cfgB.orchestration.rotationLiveCommitmentsFloor === 1);
  check("(5) ★ rotationLiveCommitmentsHeading was RE-POINTED (not locked once set)", cfgB.orchestration.rotationLiveCommitmentsHeading === "## Different heading");

  // ===================== (6) an invalid PATCH is rejected and the stored config is left UNCHANGED =====================
  const beforeBad = JSON.stringify(db.getProject("pA").config);
  const r5 = await patch("pA", { config: { bogusTopLevelKey: 1 } });
  check("(6) an unknown top-level key → 400", r5.statusCode === 400);
  check("(6) a rejected PATCH leaves the stored config UNCHANGED", JSON.stringify(db.getProject("pA").config) === beforeBad);

  // ===================== (7) clearing `memory` via unset removes the key genuinely (not stored-empty) =====================
  db.insertProject({
    id: "pC", name: "C", repoPath: TMP, vaultPath: TMP,
    config: { orchestration: { gateCommand: "pnpm build" }, memory: { budgetTokens: 3000, topK: 12, maxNotes: 200 } },
    createdAt: now, archivedAt: null, reserved: false,
  });
  const r6 = await patch("pC", { unset: ["memory"] });
  check("(7) memory unset PATCH → 200", r6.statusCode === 200);
  const cfgC = db.getProject("pC").config;
  check("(7) ★ memory is GENUINELY ABSENT (not an empty object)", cfgC.memory === undefined);
  check("(7) ★ the untouched sibling gateCommand SURVIVES", cfgC.orchestration.gateCommand === "pnpm build");

  // ===================== (8) clearing `orchestration.alertWebhook` via unset removes it, a sibling survives ============
  db.insertProject({
    id: "pD", name: "D", repoPath: TMP, vaultPath: TMP,
    config: { orchestration: { gateCommand: "pnpm build", alertWebhook: { url: "https://hooks.example.com/x", events: ["merge_done"] } } },
    createdAt: now, archivedAt: null, reserved: false,
  });
  const r7 = await patch("pD", { unset: ["orchestration.alertWebhook"] });
  check("(8) alertWebhook unset PATCH → 200", r7.statusCode === 200);
  const cfgD = db.getProject("pD").config;
  check("(8) ★ alertWebhook is GENUINELY ABSENT (not an empty object)", cfgD.orchestration.alertWebhook === undefined);
  check("(8) ★ the untouched sibling gateCommand SURVIVES", cfgD.orchestration.gateCommand === "pnpm build");

  // ===================== (9) clearing rotationMarkers + heading via unset removes both, floor survives =================
  db.insertProject({
    id: "pE", name: "E", repoPath: TMP, vaultPath: TMP,
    config: { orchestration: {
      rotationMarkers: [{ token: "LIVE COMMITMENTS" }],
      rotationLiveCommitmentsHeading: "## Commitments",
      rotationLiveCommitmentsFloor: 5,
    } },
    createdAt: now, archivedAt: null, reserved: false,
  });
  const r8 = await patch("pE", { unset: ["orchestration.rotationMarkers", "orchestration.rotationLiveCommitmentsHeading"] });
  check("(9) rotation-clear PATCH → 200", r8.statusCode === 200);
  const cfgE = db.getProject("pE").config;
  check("(9) ★ rotationMarkers is GENUINELY ABSENT (not an empty array — the e2e's exact 'absent, not stored-empty' assertion)", cfgE.orchestration.rotationMarkers === undefined);
  check("(9) ★ rotationLiveCommitmentsHeading is GENUINELY ABSENT", cfgE.orchestration.rotationLiveCommitmentsHeading === undefined);
  check("(9) ★ the untouched sibling rotationLiveCommitmentsFloor SURVIVES", cfgE.orchestration.rotationLiveCommitmentsFloor === 5);

  // ===================== (10) unsetting EVERY LEAF of a group (one dot-path per field, one PATCH) prunes
  // the now-empty PARENT too — this is the actual Settings.tsx shape (applyNumField pushes one dot-path
  // per field, never a single group-level path) and the regression a live e2e run (settings.spec.ts:644)
  // caught: unsetting all three memory.* leaves used to leave `memory: {}` behind, which a raw
  // `project.config?.memory ?? null` reader (exactly what that spec asserts) sees as truthy, not null. ===
  db.insertProject({
    id: "pF", name: "F", repoPath: TMP, vaultPath: TMP,
    config: { orchestration: { gateCommand: "pnpm build" }, memory: { budgetTokens: 3000, topK: 12, maxNotes: 200 } },
    createdAt: now, archivedAt: null, reserved: false,
  });
  const r9 = await patch("pF", { unset: ["memory.budgetTokens", "memory.topK", "memory.maxNotes"] });
  check("(10) per-leaf memory unset PATCH → 200", r9.statusCode === 200);
  const cfgF = db.getProject("pF").config;
  check("(10) ★★ memory is GENUINELY ABSENT after every leaf is individually unset (not a dangling {})", cfgF.memory === undefined);
  check("(10) ★ the untouched sibling gateCommand SURVIVES", cfgF.orchestration.gateCommand === "pnpm build");

  // Order independence: the same three leaves in the OPPOSITE order still prune correctly (the prune
  // only fires once the LAST remaining leaf is removed, whichever dot-path that happens to be).
  db.insertProject({
    id: "pG", name: "G", repoPath: TMP, vaultPath: TMP,
    config: { memory: { budgetTokens: 3000, topK: 12, maxNotes: 200 } },
    createdAt: now, archivedAt: null, reserved: false,
  });
  const r10 = await patch("pG", { unset: ["memory.maxNotes", "memory.topK", "memory.budgetTokens"] });
  check("(10) reverse-order per-leaf unset PATCH → 200", r10.statusCode === 200);
  check("(10) ★ memory is GENUINELY ABSENT regardless of unset order", db.getProject("pG").config.memory === undefined);

  // A PARTIAL clear (only some of a group's leaves) must NOT prune — the group survives with its
  // remaining, untouched field.
  db.insertProject({
    id: "pH", name: "H", repoPath: TMP, vaultPath: TMP,
    config: { memory: { budgetTokens: 3000, topK: 12, maxNotes: 200 } },
    createdAt: now, archivedAt: null, reserved: false,
  });
  const r11 = await patch("pH", { unset: ["memory.budgetTokens", "memory.topK"] });
  check("(10) partial per-leaf unset PATCH → 200", r11.statusCode === 200);
  const cfgH = db.getProject("pH").config;
  check("(10) ★ a PARTIAL group clear does NOT prune — the untouched sibling leaf survives", cfgH.memory?.maxNotes === 200);
  check("(10) the two cleared leaves are gone", cfgH.memory.budgetTokens === undefined && cfgH.memory.topK === undefined);

  // ===================== (11) merge-THEN-unset: a COLLIDING unset is REFUSED, not resolved either way ===
  // Card b5faa194: the handler still applies `merge` then `unset`, unconditionally and in that order —
  // but a payload carrying BOTH a write of a key AND an `unset` of that SAME key used to silently
  // discard the write (the unset ran after and pruned it, HTTP 200, no error). DoD-0 found no live
  // caller depending on that old "unset wins" precedence — Settings.tsx's sessionEnv editor (card
  // 32b23f0f) already avoids the collision client-side rather than rely on it — so the handler now
  // REFUSES the whole PATCH instead, naming the colliding path, and the stored config is left UNCHANGED.
  // This is the same collision card 32b23f0f's fix was written around: a human removing a secret and
  // re-adding the SAME name in one save (the natural way to rotate a value you cannot see).
  db.insertProject({
    id: "pI", name: "I", repoPath: TMP, vaultPath: TMP,
    config: { sessionEnv: { API_KEY: "old-secret", OTHER: "keep-me" }, pty: { cols: 132, rows: 48 } },
    createdAt: now, archivedAt: null, reserved: false,
  });
  const beforeCollide = JSON.stringify(db.getProject("pI").config);
  const rCollide = await patch("pI", { config: { sessionEnv: { API_KEY: "fresh-secret" } }, unset: ["sessionEnv.API_KEY"] });
  check("(11) ★ colliding write+unset PATCH → 400 (refused, not silently resolved)", rCollide.statusCode === 400);
  check("(11) ★ the error names the colliding path", typeof rCollide.json().error === "string" && rCollide.json().error.includes("sessionEnv.API_KEY"));
  check("(11) ★ a refused PATCH leaves the stored config UNCHANGED — neither the old nor the new value wins",
    JSON.stringify(db.getProject("pI").config) === beforeCollide);

  // A non-colliding RENAME (a different key written vs. unset — the reviewer's own measured positive
  // control) is unaffected — proves the collision check is specific to the actual colliding path, not a
  // blanket refusal whenever `unset` and `config` are both present. A separate project (pI2) keeps this
  // check's own key name independent of `pI`'s below, so `pI` stays byte-identical to the pre-b5faa194
  // fixture shape for the two-pass + (12) assertions that follow.
  db.insertProject({
    id: "pI2", name: "I2", repoPath: TMP, vaultPath: TMP,
    config: { sessionEnv: { API_KEY: "old-secret", OTHER: "keep-me" } },
    createdAt: now, archivedAt: null, reserved: false,
  });
  const rRename = await patch("pI2", { config: { sessionEnv: { RENAMED: "fresh-secret" } }, unset: ["sessionEnv.API_KEY"] });
  check("(11) a non-colliding rename (different key written vs. unset) → 200", rRename.statusCode === 200);
  const cfgIRename = db.getProject("pI2").config;
  check("(11) ★ the write landed", cfgIRename.sessionEnv?.RENAMED === "fresh-secret");
  check("(11) ★ the unset of the OLD name landed too — both effects apply, since they don't collide", cfgIRename.sessionEnv?.API_KEY === undefined);
  check("(11) an unrelated sibling key in the same map is untouched", cfgIRename.sessionEnv?.OTHER === "keep-me");

  // The shape a FIXED client actually sends for a same-name rotation (card 32b23f0f): the write is kept
  // and no unset is emitted for a name this payload writes back. Proves the two-pass payload is
  // well-formed here — the daemon-side complement of the browser e2e that drives the panel itself.
  const rTwoPass = await patch("pI", { config: { sessionEnv: { API_KEY: "fresh-secret" } }, unset: [] });
  check("(11) two-pass payload (no colliding unset) → 200", rTwoPass.statusCode === 200);
  const cfgI2 = db.getProject("pI").config;
  check("(11) ★ omitting the colliding unset lands the rotated value", cfgI2.sessionEnv?.API_KEY === "fresh-secret");

  // ===================== (12) sessionEnv unset + unmodeled-key survival (relocated) ==================
  // Card 32b23f0f DoD-7 originally asserted these two inside credential-sessionenv-spawn.mjs, which
  // exits early on non-win32 (its .cmd-wrapper fixture is Windows-only) — so on ubuntu CI they never
  // ran. Neither has any platform dependency: both are pure config-write logic. They live here, where
  // the suite runs everywhere; the real-spawn half correctly stays behind that Windows gate.
  const rUnsetSenv = await patch("pI", { unset: ["sessionEnv.API_KEY", "sessionEnv.OTHER"] });
  check("(12) sessionEnv unset PATCH → 200", rUnsetSenv.statusCode === 200);
  const cfgI3 = db.getProject("pI").config;
  check("(12) ★ an `unset` dot-path genuinely deletes a sessionEnv key (and prunes the emptied parent)",
    cfgI3.sessionEnv === undefined);
  check("(12) ★ the unmodeled `pty` override survived every sessionEnv write + unset above",
    cfgI3.pty?.cols === 132 && cfgI3.pty?.rows === 48);

  // ===================== (13) findConfigPatchUnsetCollisions — the SAME shared primitive mcp/platform.ts's
  // project_configure calls before its own merge+unset (card b5faa194's DoD-1 "both surfaces" scope).
  // Imported straight from dist and called directly — no reimplementation of the collision logic here —
  // so this is a genuine proof of the function the OTHER surface actually runs, not a lookalike. The REST
  // route above already proves the end-to-end refusal through the real handler (11); this proves the
  // primitive behind BOTH handlers on cases the REST harness above doesn't otherwise exercise. ===
  check("(13) exact-path collision: unset targets exactly what the patch writes",
    JSON.stringify(findConfigPatchUnsetCollisions({ sessionEnv: { API_KEY: "x" } }, ["sessionEnv.API_KEY"])) === JSON.stringify(["sessionEnv.API_KEY"]));
  check("(13) ★ ancestor collision: unsetting the WHOLE map while the patch writes ONE nested key still collides — the unset would prune the just-written key too",
    JSON.stringify(findConfigPatchUnsetCollisions({ sessionEnv: { API_KEY: "x" } }, ["sessionEnv"])) === JSON.stringify(["sessionEnv"]));
  check("(13) no collision: the patch never touches the unset path at all",
    findConfigPatchUnsetCollisions({ sessionEnv: { OTHER: "y" } }, ["sessionEnv.API_KEY"]).length === 0);
  check("(13) no collision: a primitive write makes a DEEPER unset path unreachable — same as unsetConfigPath's own no-op",
    findConfigPatchUnsetCollisions({ orchestration: { gateCommand: "cmd" } }, ["orchestration.gateCommand.nested"]).length === 0);
  check("(13) mixed payload: only the genuinely colliding path is returned, the non-colliding one is not",
    JSON.stringify(findConfigPatchUnsetCollisions({ sessionEnv: { API_KEY: "x" } }, ["sessionEnv.OTHER", "sessionEnv.API_KEY"])) === JSON.stringify(["sessionEnv.API_KEY"]));
  check("(13) empty unset list → no collisions", findConfigPatchUnsetCollisions({ sessionEnv: { API_KEY: "x" } }, []).length === 0);

  // ===== (13) BLOCKING Major (reviewer session 4275d929, reviewing 3425b1a3): own-property semantics —
  // a prototype-chain name the patch never actually WROTE must never register as a collision. Without
  // Object.hasOwn, a plain bracket read resolves __proto__/constructor/toString/etc. through the
  // prototype chain to a defined (inherited) value, so a payload REMOVING a stored key that happens to
  // share one of those names gets refused as a "collision" the patch never wrote — false diagnostics on
  // top of a regression: pre-b5faa194, that removal worked. =====
  for (const protoKey of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    check(`(13) ★★ prototype-family key "${protoKey}" the patch never wrote is NOT a false-positive collision`,
      findConfigPatchUnsetCollisions({ sessionEnv: { OTHER: "y" } }, [`sessionEnv.${protoKey}`]).length === 0);
  }
  check("(13) ★★ a bare top-level prototype-family name against an EMPTY patch is NOT a false-positive collision",
    findConfigPatchUnsetCollisions({}, ["constructor"]).length === 0);
  // A genuinely OWN key sharing a prototype-family name (e.g. an actual sessionEnv var named
  // "constructor") is still a REAL collision when the patch writes it — the hasOwn guard narrows to
  // inherited names, it doesn't blanket-exempt the literal string.
  check("(13) ★ an OWN key that happens to share a prototype-family name IS still a real collision when written",
    JSON.stringify(findConfigPatchUnsetCollisions({ sessionEnv: { constructor: "x" } }, ["sessionEnv.constructor"])) === JSON.stringify(["sessionEnv.constructor"]));

  // ===== (13) Minor: a zero-segment unset path ("." / "..") is unsetConfigPath's own documented no-op
  // (`if (!parts.length) return config`) — it can never collide with anything the patch writes. =====
  check('(13) zero-segment unset path "." is never a collision (mirrors unsetConfigPath\'s own no-op)',
    findConfigPatchUnsetCollisions({ sessionEnv: { API_KEY: "x" } }, ["."]).length === 0);
  check('(13) zero-segment unset path ".." is never a collision either',
    findConfigPatchUnsetCollisions({ sessionEnv: { API_KEY: "x" } }, [".."]).length === 0);

  // ===================== (14) end-to-end: a zero-segment unset alongside a real write is no longer
  // wrongly refused. Pre-fix, `parts=[]` skipped the whole descent loop and fell straight to `return
  // node !== undefined` with `node` still the PATCH itself — always truthy for any non-empty write, so
  // ANY payload combining a real write with `unset: ["."]` was refused as a false "collision". =====
  db.insertProject({
    id: "pJ", name: "J", repoPath: TMP, vaultPath: TMP,
    config: { orchestration: { gateCommand: "pnpm build" } },
    createdAt: now, archivedAt: null, reserved: false,
  });
  const rZeroSeg = await patch("pJ", { config: { sessionEnv: { API_KEY: "x" } }, unset: ["."] });
  check("(14) a write alongside a zero-segment unset (\".\") is NOT refused → 200", rZeroSeg.statusCode === 200);
  const cfgJ = db.getProject("pJ").config;
  check("(14) ★ the write landed", cfgJ.sessionEnv?.API_KEY === "x");
  check("(14) ★ the untouched sibling gateCommand SURVIVES", cfgJ.orchestration?.gateCommand === "pnpm build");

  // ===================== (15) card e4e854cc: sessionEnv.__proto__ is REFUSED at validation, not silently
  // dropped. `validateProjectConfigOverride` is called DIRECTLY (imported from dist, like (13)'s
  // findConfigPatchUnsetCollisions) rather than through `app.inject` — driving it through a REAL HTTP
  // request would test a DIFFERENT, already-existing guard instead of this one: Fastify's own JSON body
  // parser defaults to `onProtoPoisoning: "error"` (secure-json-parse) and throws on ANY request body
  // containing a literal `"__proto__":` key, on every route on this app, before `req.body` is even
  // populated — confirmed directly against this project's real Fastify instance (a PATCH carrying
  // `{"sessionEnv":{"__proto__":"evil"}}` 400s with `FST_ERR_CTP_INVALID_JSON_BODY`, never reaching this
  // handler at all). That is a genuine, separate, pre-existing defense at the TRANSPORT layer — this
  // card's fix is at the VALIDATOR layer, for any caller (present or future) of `validateProjectConfigOverride`
  // that isn't sitting behind that same Fastify body-parser default. =====
  {
    // Built via JSON.parse, not a JS object literal: `{ __proto__: "evil" }` as a LITERAL is spec-
    // special-cased to SET the object's prototype rather than create an own property (and a string
    // target is a silent no-op), which would produce an empty sessionEnv and defeat this test before it
    // starts. JSON.parse instead uses CreateDataProperty, so `__proto__` becomes a genuine own key —
    // exactly how the reviewer's own reproduction (card e4e854cc) built it.
    const protoSessionEnv = JSON.parse('{"__proto__":"evil"}');
    const vProto = validateProjectConfigOverride({ sessionEnv: protoSessionEnv });
    check("(15) ★ sessionEnv.__proto__ is REFUSED at validation (ok:false), not silently dropped", vProto.ok === false);
    check("(15) ★ the error names the offending field", typeof vProto.error === "string" && vProto.error.includes("sessionEnv") && vProto.error.includes("__proto__"));
    check("(15) the request's own prototype chain is untouched by the refused payload", Object.getPrototypeOf({}) === Object.prototype);

    // Positive control (card e4e854cc DoD-3): the SAME 10 prototype-family names swept in (13) all
    // survive as ordinary own keys through the real validator — proving the __proto__ refusal is
    // specific to that one name, not an accidental side effect of rejecting the whole prototype family.
    for (const protoKey of ["constructor", "prototype", "hasOwnProperty", "toString", "valueOf", "isPrototypeOf", "propertyIsEnumerable", "__defineGetter__", "_proto_", "PATH"]) {
      const vPositive = validateProjectConfigOverride({ sessionEnv: { [protoKey]: "fine" } });
      check(`(15) positive control: sessionEnv["${protoKey}"] validates ok:true (not swept up by the __proto__ refusal)`, vPositive.ok === true);
      check(`(15) ★ sessionEnv["${protoKey}"] survives as a genuine own key with the parsed value`,
        vPositive.ok === true && Object.hasOwn(vPositive.value.sessionEnv, protoKey) && vPositive.value.sessionEnv[protoKey] === "fine");
    }

    // A __proto__ refusal alongside an untouched sibling key: the whole PATCH object still fails (one
    // bad key refuses the batch, matching how a bad top-level key in (6) refuses its whole payload too),
    // and the sibling key is never independently inspected — refusal is all-or-nothing at this boundary.
    // Built via JSON.parse (same reason as protoSessionEnv above): a literal `{__proto__: ...}` key in
    // this source file would set the object's prototype instead of creating an own property.
    const mixedSessionEnv = JSON.parse('{"KEEP":"1","__proto__":"evil"}');
    const vMixed = validateProjectConfigOverride({ sessionEnv: mixedSessionEnv });
    check("(15) ★ a __proto__ key alongside a legitimate sibling still refuses the WHOLE sessionEnv map", vMixed.ok === false);
  }

  // Separately (and NOT a proof of this card's fix — see the comment above): confirm the real REST route
  // ALSO currently refuses an HTTP body carrying a literal __proto__ key, end-to-end, via app.inject —
  // documenting Fastify's own transport-layer guard so a future reader doesn't mistake it for this card's
  // validator-layer fix, or remove this schema change believing HTTP already covers it unconditionally
  // (Fastify's own guard is a daemon-wide default that could be reconfigured; the validator fix cannot).
  db.insertProject({
    id: "pK", name: "K", repoPath: TMP, vaultPath: TMP,
    config: { orchestration: { gateCommand: "pnpm build" } },
    createdAt: now, archivedAt: null, reserved: false,
  });
  const rProtoHttp = await patch("pK", { config: { sessionEnv: JSON.parse('{"__proto__":"evil"}') } });
  check("(15) HTTP-layer note: a real PATCH body carrying __proto__ is ALSO refused today (400) — by Fastify's own onProtoPoisoning default, a separate guard from this card's fix", rProtoHttp.statusCode === 400);
  check("(15) the untouched project is unaffected by the refused HTTP request", db.getProject("pK").config.orchestration?.gateCommand === "pnpm build");
} finally {
  try { if (app) await app.close(); } catch { /* ignore */ }
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — PATCH /api/projects/:id/config deep-merges by default (a single-key PATCH preserves every sibling key, nested objects merge field-by-field), `unset` expresses deletion the merge itself cannot, `replace:true` still opts into the old whole-object-replace behavior byte-identical, this human REST path carries NO additiveOnlyRotationGuard (can shrink/lower/re-point rotation fields — the documented Settings.tsx escape hatch), a rejected PATCH leaves the stored config unchanged, `unset` genuinely REMOVES memory/alertWebhook/rotationMarkers+heading (not stored-empty) with an untouched sibling surviving each, and unsetting EVERY leaf of a group one dot-path at a time (the real Settings.tsx shape) PRUNES the now-empty parent too — in either order, while a PARTIAL clear leaves the group's untouched sibling leaf intact; PLUS (card b5faa194) a write and an `unset` of the SAME dot-path in one payload is now REFUSED (400, named, stored config unchanged) rather than the unset silently winning, a non-colliding rename in the same map is unaffected, the sessionEnv editor's own two-pass payload lands its rotated value, and a sessionEnv unset genuinely deletes its key while an unmodeled `pty` override survives; PLUS (card e07daa96 / reviewer session 4275d929) a prototype-family name the patch never wrote is never a false-positive collision while a genuinely own key sharing that name still is, and a zero-segment unset path is never a collision — at both the primitive and the end-to-end REST layer; PLUS (card e4e854cc) a raw sessionEnv.__proto__ key is REFUSED at validation (400, stored config unchanged) instead of zod's z.record silently dropping it, with a positive control proving the same 10 prototype-family names from (13) still land as ordinary own keys through the real PATCH path."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
