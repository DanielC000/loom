import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1069c8e1, manager review Q3 (+ a follow-up Code Reviewer CRITICAL/MAJOR pass) — REGRESSION/
// behavior test for the additive-only rotation guard on mergeConfigOverride: on every AGENT-facing
// config-write path, orchestration.rotationMarkers may only GROW (an agent patch can add a marker but
// never remove one), rotationLiveCommitmentsFloor may only RISE, and rotationLiveCommitmentsHeading —
// once configured — can neither be CLEARED nor RE-POINTED (only the initial unset->set transition is
// additive). Closes the failure mode named at review: a manager mid-rotation, under context pressure,
// hitting a refusal naming a marker it doesn't want to deal with, could otherwise delete the marker
// rather than restore the rule it names ("the rotation is where rules die", with the guard itself as
// the casualty) — and the Code Reviewer found the FIRST version of this guard only covered 2 of the 3
// legs: rotationLiveCommitmentsHeading fell through unguarded, letting an agent silently disable the
// floor check (clear to "") while `configured` stayed true, or satisfy it against unrelated content
// (re-point it) — the exact fail-open class card a681aed5 fixed in CODE, reintroduced here through
// CONFIG. Also closes a MAJOR the same review found: the union-merge itself could exceed the schema's
// per-patch array cap across successive additive patches (5x 200-entry patches -> 1000 markers).
//
// Layers tested:
//   1. mergeConfigOverride itself (unit-level): additiveOnlyRotationGuard:true blocks marker removal,
//      floor-lowering, AND heading clear/re-point, clamps the merged array to the cap even across many
//      patches, and allows every legitimate growth direction; omitted (the default) stays plain symmetric
//      replace, UNCHANGED for every other caller (the human/Lead project_configure path, the REST PATCH
//      path).
//   2. The REAL agent-facing wiring: SessionService.updateProjectStructural (the manager's project_update
//      tool) — proves the guard (all three legs) is actually WIRED at the call site, not just available
//      as an unused option (mirrors project-update-config-merge.mjs's own end-to-end style for the
//      sibling merge bug), including the two heading attacks run against the REAL production call path.
//
// HERMETIC + CLAUDE-FREE (real Db + SessionService against a no-op fake pty).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-rotguard-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";
requireHermeticEnv();

const { mergeConfigOverride } = await import("../dist/mcp/platform.js");
const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");

// ── LAYER 1: mergeConfigOverride unit tests ─────────────────────────────────────────────────────────
{
  const existing = {
    orchestration: {
      rotationMarkers: [{ token: "A", note: "keep" }, { token: "B" }],
      rotationLiveCommitmentsFloor: 5,
    },
  };

  // Additive-only ON: a patch that DROPS "A" (submits only "B" + a new "C") must not remove "A".
  const dropAttempt = { orchestration: { rotationMarkers: [{ token: "B" }, { token: "C" }] } };
  const guarded = mergeConfigOverride(existing, dropAttempt, { additiveOnlyRotationGuard: true });
  const guardedTokens = guarded.orchestration.rotationMarkers.map((m) => m.token).sort();
  check("additive guard ON: a dropped marker (A) SURVIVES the patch", guardedTokens.includes("A"));
  check("additive guard ON: a NEW marker (C) in the patch is APPENDED", guardedTokens.includes("C"));
  check("additive guard ON: the pre-existing survivor's own fields are UNCHANGED (not overwritten)",
    guarded.orchestration.rotationMarkers.find((m) => m.token === "A").note === "keep");
  check("additive guard ON: result is the union, exactly 3 tokens (A, B, C)", guardedTokens.length === 3);

  // Additive-only ON: floor LOWER attempt is clamped to the existing (higher) value.
  const lowerFloor = mergeConfigOverride(existing, { orchestration: { rotationLiveCommitmentsFloor: 2 } }, { additiveOnlyRotationGuard: true });
  check("additive guard ON: a LOWER floor patch is REJECTED (stays at existing 5, not dropped to 2)", lowerFloor.orchestration.rotationLiveCommitmentsFloor === 5);

  // Additive-only ON: floor RAISE attempt is honored (growth is always safe).
  const raiseFloor = mergeConfigOverride(existing, { orchestration: { rotationLiveCommitmentsFloor: 10 } }, { additiveOnlyRotationGuard: true });
  check("additive guard ON: a HIGHER floor patch is honored (5 → 10)", raiseFloor.orchestration.rotationLiveCommitmentsFloor === 10);

  // Additive-only ON, but the patch didn't touch orchestration at all — untouched, no throw.
  const untouched = mergeConfigOverride(existing, { kanbanColumns: [] }, { additiveOnlyRotationGuard: true });
  check("additive guard ON: a patch that never touches orchestration leaves rotationMarkers untouched",
    untouched.orchestration.rotationMarkers.map((m) => m.token).sort().join(",") === "A,B");

  // Additive-only OFF (default, omitted) — plain symmetric replace, UNCHANGED from before this card:
  // the human-equivalent Lead project_configure path and the REST PATCH path must still be able to
  // shrink the list (a deliberate owner-directed retirement of a marker).
  const symmetricReplace = mergeConfigOverride(existing, dropAttempt); // no options at all
  const symmetricTokens = symmetricReplace.orchestration.rotationMarkers.map((m) => m.token).sort();
  check("additive guard OFF (default): a patch CAN remove a marker (plain array replace, human path)", symmetricTokens.join(",") === "B,C");
  check("additive guard OFF (default): a lower floor patch is honored too (symmetric replace)",
    mergeConfigOverride(existing, { orchestration: { rotationLiveCommitmentsFloor: 2 } }).orchestration.rotationLiveCommitmentsFloor === 2);

  // First-ever write (no existing markers at all) — additive guard is a no-op; the whole patch lands.
  const firstWrite = mergeConfigOverride({}, { orchestration: { rotationMarkers: [{ token: "X" }] } }, { additiveOnlyRotationGuard: true });
  check("additive guard ON: first-ever write (no existing state) lands the whole patch", firstWrite.orchestration.rotationMarkers.map((m) => m.token).join(",") === "X");
}

// ── CODE-REVIEW CRITICAL FIX — rotationLiveCommitmentsHeading is the THIRD guarded leg ────────────────
// Before this fix, applyAdditiveOnlyRotationGuard covered ONLY rotationMarkers + rotationLiveCommitmentsFloor.
// The heading fell through the plain deep-merge (agent-writable, no guard) — an agent patch could clear
// it to "" (floor check silently disabled while `configured` stays true because markers are non-empty)
// or RE-POINT it to a different section entirely (satisfying the floor against unrelated content — the
// SAME fail-open shape card a681aed5 fixed in code, reintroduced here through config).
{
  const existingHeaded = {
    orchestration: {
      rotationMarkers: [{ token: "OWNER-GATED" }],
      rotationLiveCommitmentsHeading: "LIVE COMMITMENTS",
      rotationLiveCommitmentsFloor: 12,
    },
  };

  // ATTACK 1: clear the heading to "" (disables the floor check while markers stay non-empty).
  const clearAttempt = mergeConfigOverride(existingHeaded, { orchestration: { rotationLiveCommitmentsHeading: "" } }, { additiveOnlyRotationGuard: true });
  check("additive guard ON: a heading-CLEAR attempt is BLOCKED — stays \"LIVE COMMITMENTS\", not \"\"",
    clearAttempt.orchestration.rotationLiveCommitmentsHeading === "LIVE COMMITMENTS");

  // ATTACK 2: re-point the heading to a DIFFERENT, unrelated section.
  const repointAttempt = mergeConfigOverride(existingHeaded, { orchestration: { rotationLiveCommitmentsHeading: "Unrelated Notes" } }, { additiveOnlyRotationGuard: true });
  check("additive guard ON: a heading-REPOINT attempt is BLOCKED — stays \"LIVE COMMITMENTS\", not the new target",
    repointAttempt.orchestration.rotationLiveCommitmentsHeading === "LIVE COMMITMENTS");

  // The ONE legitimate additive transition: unset ("") -> some heading, turning the floor check ON
  // for the first time. This must still work — additive-only means "can't be weakened," not "frozen."
  const firstTimeSet = mergeConfigOverride({ orchestration: {} }, { orchestration: { rotationLiveCommitmentsHeading: "LIVE COMMITMENTS" } }, { additiveOnlyRotationGuard: true });
  check("additive guard ON: setting a PREVIOUSLY-EMPTY heading for the first time is ALLOWED",
    firstTimeSet.orchestration.rotationLiveCommitmentsHeading === "LIVE COMMITMENTS");

  // A patch re-submitting the SAME value is an inert no-op, not a rejection.
  const sameValue = mergeConfigOverride(existingHeaded, { orchestration: { rotationLiveCommitmentsHeading: "LIVE COMMITMENTS" } }, { additiveOnlyRotationGuard: true });
  check("additive guard ON: re-submitting the SAME heading value is a no-op (still the same value)",
    sameValue.orchestration.rotationLiveCommitmentsHeading === "LIVE COMMITMENTS");

  // Additive-only OFF (the human-equivalent Lead/REST path) — heading stays freely settable, unchanged.
  const humanClear = mergeConfigOverride(existingHeaded, { orchestration: { rotationLiveCommitmentsHeading: "" } });
  check("additive guard OFF (default): the human-equivalent path CAN clear the heading (unguarded, as before this fix)",
    humanClear.orchestration.rotationLiveCommitmentsHeading === "");
}

// ── CODE-REVIEW MAJOR FIX — the union-merge must still respect the schema's array cap ─────────────────
// Before this fix, additiveMergeRotationMarkers unioned onto the EXISTING array with no re-check against
// ROTATION_MARKERS_MAX_LEN — the schema only bounds each INCOMING patch, so successive additive patches
// could grow the STORED array without bound (reviewer's repro: 5x 200-entry patches -> 1000 markers).
{
  const existingAt199 = {
    orchestration: { rotationMarkers: Array.from({ length: 199 }, (_, i) => ({ token: `existing-${i}` })) },
  };
  // A patch adding 2 more NEW tokens would grow the union to 201 — one over the 200 cap.
  const overCap = mergeConfigOverride(
    existingAt199,
    { orchestration: { rotationMarkers: [{ token: "new-a" }, { token: "new-b" }] } },
    { additiveOnlyRotationGuard: true },
  );
  check("additive guard ON: the MERGED result is clamped to the 200-entry cap, even though the union would exceed it",
    overCap.orchestration.rotationMarkers.length === 200);
  check("additive guard ON: clamping doesn't corrupt the existing 199 — they're all still present",
    Array.from({ length: 199 }, (_, i) => `existing-${i}`).every((t) => overCap.orchestration.rotationMarkers.some((m) => m.token === t)));

  // RED PROOF that the cap is a real ceiling, not vacuous: repeat the reviewer's own repro shape (many
  // successive additive patches, each individually valid) and confirm the STORED result never exceeds
  // the cap regardless of how many patches are applied.
  let growing = { orchestration: { rotationMarkers: [] } };
  for (let batch = 0; batch < 5; batch++) {
    const newBatch = Array.from({ length: 200 }, (_, i) => ({ token: `batch${batch}-${i}` }));
    growing = mergeConfigOverride(growing, { orchestration: { rotationMarkers: newBatch } }, { additiveOnlyRotationGuard: true });
  }
  check("additive guard ON: 5 successive 200-entry patches do NOT grow the stored array past the 200 cap (reviewer's repro)",
    growing.orchestration.rotationMarkers.length === 200);
}

// ── LAYER 2: the REAL agent-facing wiring (manager's project_update) ───────────────────────────────────
{
  const now = new Date().toISOString();
  const db = new Db(path.join(tmpHome, "loom.db"));
  const seededConfig = {
    orchestration: {
      rotationMarkers: [{ token: "MGR122-FLOOR" }, { token: "QUIET-LANE" }],
      rotationLiveCommitmentsHeading: "LIVE COMMITMENTS",
      rotationLiveCommitmentsFloor: 12,
    },
  };
  db.insertProject({ id: "pRot", name: "RotProj", repoPath: tmpHome, vaultPath: tmpHome, config: seededConfig, createdAt: now, archivedAt: null, reserved: false });
  db.insertAgent({ id: "aRot", projectId: "pRot", name: "Lead", startupPrompt: "do it", position: 0, profileId: null });
  db.insertSession({
    id: "MRot", projectId: "pRot", agentId: "aRot", engineSessionId: null, title: null, cwd: tmpHome,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", parentSessionId: null,
  });
  const pty = { enqueueStdin: () => ({ delivered: false }) };
  const svc = new SessionService(db, pty, new OrchestrationControl());

  try {
    // A manager patch that (deliberately or under pressure) tries to drop MGR122-FLOOR and lower the floor.
    svc.updateProjectStructural("MRot", "pRot", {
      config: { orchestration: { rotationMarkers: [{ token: "QUIET-LANE" }], rotationLiveCommitmentsFloor: 3 } },
    });
    const after = db.getProject("pRot").config;
    const afterTokens = after.orchestration.rotationMarkers.map((m) => m.token).sort();
    check("project_update (agent path): a marker-removal attempt is BLOCKED end-to-end — MGR122-FLOOR survives", afterTokens.includes("MGR122-FLOOR"));
    check("project_update (agent path): QUIET-LANE (kept in the patch) is still present too", afterTokens.includes("QUIET-LANE"));
    check("project_update (agent path): a floor-lowering attempt is BLOCKED end-to-end — stays at 12, not 3", after.orchestration.rotationLiveCommitmentsFloor === 12);

    // ── CODE-REVIEW CRITICAL, exercised end-to-end against the REAL wiring ──────────────────────────
    // ATTACK 1: clear rotationLiveCommitmentsHeading to "" — before the fix this silently disabled the
    // floor check while `configured` stayed true (rotationMarkers is non-empty), so a manager under
    // rotation pressure could clear ONE STRING (cheaper than deleting a marker) and have resume_doc_check
    // still read as a fully-configured pass with the floor never applied.
    svc.updateProjectStructural("MRot", "pRot", { config: { orchestration: { rotationLiveCommitmentsHeading: "" } } });
    const afterClear = db.getProject("pRot").config;
    check("project_update (agent path): a heading-CLEAR attempt is BLOCKED end-to-end — stays \"LIVE COMMITMENTS\"",
      afterClear.orchestration.rotationLiveCommitmentsHeading === "LIVE COMMITMENTS");

    // ATTACK 2: re-point the heading to a different, unrelated section — before the fix this could
    // satisfy the floor check against UNRELATED content (findHeadingLine matches ANY heading line
    // containing the token as a case-insensitive substring), the same fail-open class as card a681aed5.
    svc.updateProjectStructural("MRot", "pRot", { config: { orchestration: { rotationLiveCommitmentsHeading: "Some Other Section" } } });
    const afterRepoint = db.getProject("pRot").config;
    check("project_update (agent path): a heading-REPOINT attempt is BLOCKED end-to-end — stays \"LIVE COMMITMENTS\", not the new target",
      afterRepoint.orchestration.rotationLiveCommitmentsHeading === "LIVE COMMITMENTS");

    // The SAME manager CAN legitimately grow the set — adding a new marker and raising the floor.
    svc.updateProjectStructural("MRot", "pRot", {
      config: { orchestration: { rotationMarkers: [{ token: "MGR122-FLOOR" }, { token: "QUIET-LANE" }, { token: "NEW-RULE" }], rotationLiveCommitmentsFloor: 15 } },
    });
    const after2 = db.getProject("pRot").config;
    const after2Tokens = after2.orchestration.rotationMarkers.map((m) => m.token).sort();
    check("project_update (agent path): the SAME manager can freely ADD a new marker", after2Tokens.includes("NEW-RULE"));
    check("project_update (agent path): and RAISE the floor", after2.orchestration.rotationLiveCommitmentsFloor === 15);
  } finally {
    db.close();
    cleanupPathSync(tmpHome);
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the additive-only rotation guard blocks marker removal, floor-lowering, AND heading clear/re-point (all three legs, including the Code Reviewer's CRITICAL finding) on every AGENT-facing config-write path (unit-level AND the real manager project_update wiring), clamps the merged marker array to its cap across successive additive patches (the MAJOR finding), permits every legitimate growth direction freely, leaves the human-equivalent/REST path fully symmetric (unchanged from before this card), and is a no-op on a first-ever write — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
