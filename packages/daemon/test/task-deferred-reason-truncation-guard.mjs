import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a53b24ce — a Lead wanted a card's `version` in order to pass `baseVersion` elsewhere, and wrote a
// PLACEHOLDER into that card's `deferredReason` to read the version off the update ack. The write
// succeeded silently and destroyed a real, load-bearing deferral reason: `deferredReason` is a
// FIELD-ONLY patch (never gated by the title/body baseVersion CAS, card d0978321) and — unlike `body` —
// had NO destructive-truncation guard at all (card 09d68835's guard fires only on `patch.body`). This
// extends that SAME guard shape (same MIN_SUBSTANTIAL_BODY_CHARS/MAX_SURVIVING_FRACTION thresholds, same
// allowTruncate override, same {truncation:true,...} shape) to `deferredReason` — without breaking the
// version-free bare `{deferred:false}` flag-flip contract, which this card must not change.
//
// HERMETIC: no daemon, no real claude — drives the built business logic (dist/) against a throwaway
// SQLite Db, mirroring task-body-truncation-guard.mjs's harness style exactly.
//
// Proves the DoD (each RED-proofed against the pre-guard behavior — see the paired assertion against the
// raw DB write below each case):
//   (1) THE DESTRUCTIVE CASE: a substantial deferredReason (>=1KB) replaced by a sliver (<25% of it) is
//       REFUSED, names the current/proposed lengths in the error, and returns the untouched current
//       deferredReason.
//   (2) THE OVERRIDE: the SAME destructive write with allowTruncate:true succeeds.
//   (3) ⭐ THE REGRESSION THAT MATTERS MOST (DoD-2): a bare `{deferred:false}` flag flip on a card
//       carrying a long deferredReason still succeeds with NO baseVersion — byte-identical to today, even
//       though it auto-nulls deferredReason as a side effect (an intentional CLEAR, not a truncation).
//   (4) DELIBERATE CLEAR (DoD-3): deferredReason:null on a card with a substantial reason is NEVER
//       guarded — a guard you cannot satisfy is worse than one you ignore.
//   (5) A SHORT-REASON CARD is untouched by the guard — a reason under the substantial floor can be
//       replaced by anything, no override needed.
//   (6) A COMPARABLE-SIZE REWRITE (stays >=25% of the original) is untouched by the guard.
//   (7) the refusal is a DISTINCT discriminant (`truncation`, not `conflict`), and the destructive write
//       never reached the database.
// Run: 1) build daemon, 2) node test/task-deferred-reason-truncation-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { createProjectTask, updateProjectTask, MIN_SUBSTANTIAL_BODY_CHARS, MAX_SURVIVING_FRACTION } from "../dist/mcp/tasks.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const file = path.join(os.tmpdir(), `loom-task-deferred-reason-truncation-guard-${Date.now()}-${process.pid}.db`);
const now = new Date().toISOString();

try {
  const db = new Db(file);
  db.insertProject({ id: "projT", name: "Deferred Reason Truncation Guard", repoPath: "C:/t", vaultPath: "C:/t", config: {}, createdAt: now, archivedAt: null, reserved: false });

  // A "substantial" reason well over the 1KB floor, mirroring the real specimen's shape (a multi-
  // thousand-character reason holding measured correlations and explicit bounds). Trimmed (no leading/
  // trailing whitespace) because `updateProjectTask` trims `deferredReason` before storing it (pre-
  // existing normalization, unrelated to this guard) — an untrimmed fixture would never byte-equal what
  // comes back, which would look like a guard defect but isn't one.
  const bigReason = "Measured correlations, four explicit bounds, and a retraction. ".repeat(200).trim(); // ~13,000 chars
  check("(setup) the fixture reason is genuinely substantial", bigReason.length >= MIN_SUBSTANTIAL_BODY_CHARS);

  // Helper: a manually-deferred card carrying `bigReason` (a manual deferral REQUIRES a reason, card
  // c90e9525) — set up via a single updateProjectTask call (createProjectTask has no deferredReason input).
  const makeDeferredCard = async (title) => {
    const created = createProjectTask(db, "projT", { title, columnKey: "backlog" });
    const deferred = await updateProjectTask(db, "projT", created.id, { deferred: true, deferredReason: bigReason });
    check(`(setup) ${title}: the manual deferral with the big reason landed`, !deferred.error && deferred.deferredReason === bigReason);
    return db.getTask(created.id);
  };

  // ===== (1) THE DESTRUCTIVE CASE — a placeholder read-the-version probe replacing a substantial reason =====
  const card1 = await makeDeferredCard("destructive case");
  const placeholder = "reading version";
  check("(1) placeholder is under the 25% floor of the fixture reason", placeholder.length < bigReason.length * MAX_SURVIVING_FRACTION);
  const destructive = await updateProjectTask(db, "projT", card1.id, { deferredReason: placeholder });
  check("(1) THE FIX: a destructive deferredReason write is REFUSED", destructive.truncation === true && typeof destructive.error === "string");
  check("(1) the error names the CURRENT length", destructive.error.includes(String(bigReason.length)));
  check("(1) the error names the PROPOSED length", destructive.error.includes(String(placeholder.length)));
  check("(1) currentLength/proposedLength are also broken out structurally", destructive.currentLength === bigReason.length && destructive.proposedLength === placeholder.length);
  check("(1) the refusal returns the CURRENT (untouched) deferredReason to reconcile against", destructive.current?.deferredReason === bigReason);
  check("(1) THE DESTRUCTIVE WRITE NEVER REACHED THE DATABASE", db.getTask(card1.id).deferredReason === bigReason);
  check("(1) the discriminant is `truncation`, distinct from the baseVersion guard's `conflict`", destructive.conflict === undefined);

  // ===== (2) THE OVERRIDE — the identical write, with allowTruncate:true, succeeds =====
  const overridden = await updateProjectTask(db, "projT", card1.id, { deferredReason: placeholder }, undefined, undefined, true);
  check("(2) allowTruncate:true bypasses the guard", !overridden.error);
  check("(2) the override write actually landed", db.getTask(card1.id).deferredReason === placeholder);

  // ===== (3) ⭐ THE REGRESSION THAT MATTERS MOST — a bare {deferred:false} flag flip on a card carrying
  // a long reason must still succeed with NO baseVersion, byte-identical to today (DoD-2) =====
  const card3 = await makeDeferredCard("bare flag flip");
  const flagFlip = await updateProjectTask(db, "projT", card3.id, { deferred: false });
  check("(3) ⭐ a bare {deferred:false} on a card with a LONG reason is NOT blocked by the new guard", !flagFlip.error && flagFlip.truncation === undefined);
  check("(3) the flag flip actually landed (deferred cleared)", db.getTask(card3.id).deferred === false);
  check("(3) deferredReason was auto-nulled as the existing un-defer side effect (a clear, not a truncation)", db.getTask(card3.id).deferredReason === null);

  // ===== (4) DELIBERATE CLEAR — deferredReason:null on a card with a substantial reason is NEVER guarded
  // by THIS truncation guard. Set up via a route-(a) deferral (deferredUntilTaskId set) rather than
  // makeDeferredCard's manual deferral: a MANUAL deferral (deferred:true, no deferredUntilTaskId) has its
  // own PRE-EXISTING, unrelated guard (card c90e9525) that refuses leaving it manually-deferred with NO
  // reason at all — correctly so, and orthogonal to this card. A route-(a) deferral has no such
  // requirement (its release condition is the named blocker, not the reason text), so a caller can attach
  // an informational reason to it and later clear that reason without touching `deferred` at all — the
  // clean way to exercise ONLY this truncation guard's null-is-never-guarded behavior. =====
  const blocker = createProjectTask(db, "projT", { title: "the blocker", columnKey: "backlog" });
  const created4 = createProjectTask(db, "projT", { title: "deliberate clear", columnKey: "backlog" });
  const setup4 = await updateProjectTask(db, "projT", created4.id, { deferred: true, deferredUntilTaskId: blocker.id, deferredReason: bigReason });
  check("(4) setup: a route-(a) deferral with an informational big reason landed", !setup4.error && setup4.deferredReason === bigReason);
  const card4 = db.getTask(created4.id);
  const deliberateClear = await updateProjectTask(db, "projT", card4.id, { deferredReason: null });
  check("(4) a deliberate deferredReason:null clear is NOT blocked (DoD-3)", !deliberateClear.error && deliberateClear.truncation === undefined);
  check("(4) the clear actually landed", db.getTask(card4.id).deferredReason === null);

  // ===== (5) SHORT-REASON CARD — under the substantial-reason floor, untouched by the guard =====
  const created5 = createProjectTask(db, "projT", { title: "short-reason card", columnKey: "backlog" });
  const shortReason = "a short reason, well under 1KB";
  check("(5) the short-reason fixture really is short", shortReason.length < MIN_SUBSTANTIAL_BODY_CHARS);
  const setShort = await updateProjectTask(db, "projT", created5.id, { deferred: true, deferredReason: shortReason });
  check("(5) setup: the short reason landed", !setShort.error);
  const shortReplace = await updateProjectTask(db, "projT", created5.id, { deferredReason: "x" });
  check("(5) a short reason can be replaced by anything — no override needed", !shortReplace.error);
  check("(5) the short-reason replace actually landed", db.getTask(created5.id).deferredReason === "x");

  // ===== (6) COMPARABLE-SIZE REWRITE — stays >=25% of the original, untouched by the guard =====
  const card6 = await makeDeferredCard("comparable rewrite");
  const comparable = "y".repeat(Math.ceil(bigReason.length * 0.5)); // 50% of the original — well above the 25% floor
  const comparableWrite = await updateProjectTask(db, "projT", card6.id, { deferredReason: comparable });
  check("(6) a comparable-size rewrite (50% of original) is NOT blocked", !comparableWrite.error);
  check("(6) the comparable rewrite actually landed", db.getTask(card6.id).deferredReason === comparable);

  db.close();
} finally {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — updateProjectTask (card a53b24ce) refuses a `deferredReason` write that would discard the large majority (keeping <25%) of a substantial (>=1KB) existing reason, names the current/proposed lengths in the error, returns the untouched current reason to reconcile against, and NEVER lets the destructive write reach the database — while a bare {deferred:false} flag flip, a deliberate deferredReason:null clear, a short-reason card, and a comparable-size rewrite all pass through untouched with no baseVersion required, and the explicit allowTruncate:true override bypasses the guard deliberately."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
