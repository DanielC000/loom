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
//   (11) the handler's merge-THEN-unset ORDER: an `unset` of a key BEATS a write of that same key in
//       ONE payload (the write is silently discarded, HTTP 200). Pinned, not fixed — it is the
//       documented project_configure grammar, and it is WHY Settings.tsx's sessionEnv editor must
//       collect every written name before emitting any unset (card 32b23f0f: remove-then-re-add of the
//       same name destroyed both the old secret and its just-typed replacement).
//   (12) an `unset` dot-path genuinely deletes a sessionEnv key, and an unmodeled `pty` override
//       survives a sessionEnv-only write — relocated from credential-sessionenv-spawn.mjs, which is
//       Windows-gated for its real-spawn fixture, so these two platform-independent assertions never
//       ran on ubuntu CI there.
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

  // ===================== (11) merge-THEN-unset: a COLLIDING unset beats a write of the same key ======
  // The handler applies `merge` then `unset`, unconditionally and in that order. So a payload carrying
  // BOTH an `unset` of a key AND a write of that SAME key ends with the key GONE — the write is
  // silently discarded. This is the documented `project_configure` grammar ("REMOVE a key AFTER the
  // merge"), NOT a defect — and NOT one to "fix" in this file or in Settings.tsx. Reordering it is card
  // b5faa194, deliberately deferred behind 32b23f0f because it targets THIS file too. If that card lands,
  // the starred assertion below INVERTS (the write would win) and must be REWRITTEN, not deleted —
  // deleting it drops the grammar pin AND the sibling-survival check alongside it. The second half (the
  // `unset: []` two-pass payload) is order-independent and survives either way.
  // This case PINS the current order, because it is the
  // reason Settings.tsx's sessionEnv editor must collect every written name BEFORE emitting any unset.
  // Card 32b23f0f: a human removing a secret and re-adding the SAME name in one save (the natural way
  // to rotate a value you cannot see) destroyed BOTH the old secret and the replacement they had just
  // typed, with an HTTP 200 and no error anywhere.
  db.insertProject({
    id: "pI", name: "I", repoPath: TMP, vaultPath: TMP,
    config: { sessionEnv: { API_KEY: "old-secret", OTHER: "keep-me" }, pty: { cols: 132, rows: 48 } },
    createdAt: now, archivedAt: null, reserved: false,
  });
  const rCollide = await patch("pI", { config: { sessionEnv: { API_KEY: "fresh-secret" } }, unset: ["sessionEnv.API_KEY"] });
  check("(11) colliding write+unset PATCH → 200 (it does NOT error)", rCollide.statusCode === 200);
  const cfgI = db.getProject("pI").config;
  check("(11) ★ the unset WINS over a write of the same key in one payload — the new value is discarded",
    cfgI.sessionEnv?.API_KEY === undefined);
  check("(11) an unrelated sibling key in the same map is untouched", cfgI.sessionEnv?.OTHER === "keep-me");

  // The shape a FIXED client actually sends for that same human intent: the write is kept and no unset
  // is emitted for a name this payload writes back. Proves the two-pass payload is well-formed here —
  // the daemon-side complement of the browser e2e that drives the panel itself.
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
} finally {
  try { if (app) await app.close(); } catch { /* ignore */ }
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — PATCH /api/projects/:id/config deep-merges by default (a single-key PATCH preserves every sibling key, nested objects merge field-by-field), `unset` expresses deletion the merge itself cannot, `replace:true` still opts into the old whole-object-replace behavior byte-identical, this human REST path carries NO additiveOnlyRotationGuard (can shrink/lower/re-point rotation fields — the documented Settings.tsx escape hatch), a rejected PATCH leaves the stored config unchanged, `unset` genuinely REMOVES memory/alertWebhook/rotationMarkers+heading (not stored-empty) with an untouched sibling surviving each, and unsetting EVERY leaf of a group one dot-path at a time (the real Settings.tsx shape) PRUNES the now-empty parent too — in either order, while a PARTIAL clear leaves the group's untouched sibling leaf intact; PLUS the merge-THEN-unset order is pinned (a colliding unset beats a write of the same key in one payload, which is why the sessionEnv editor collects written names before emitting any unset), and a sessionEnv unset genuinely deletes its key while an unmodeled `pty` override survives."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
