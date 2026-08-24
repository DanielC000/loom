import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 09d68835 — a manager passed a one-sentence annotation as the FULL replacement `body` on a
// ~13,300-character card and silently destroyed it: `tasks_update`'s `body` is (correctly) a full
// replace with no undo, so the write succeeded and recovery only worked because a scratch copy of the
// intended body happened to exist. This brings a BLOCKING PRECONDITION to `updateProjectTask`: a `body`
// write that would discard the large majority of an existing SUBSTANTIAL body is refused unless the
// caller passes the explicit `allowTruncate:true` override — mirroring `tasks_create`'s `allowDuplicate`.
//
// HERMETIC: no daemon, no real claude — drives the built business logic (dist/) against a throwaway
// SQLite Db, mirroring task-version-guard.mjs's harness style.
//
// Proves the DoD (each RED-proofed against the pre-guard behavior — see the paired assertion against
// the raw DB write below each case):
//   (1) THE DESTRUCTIVE CASE: a substantial body (>=1KB) replaced by a sliver (<25% of it) is REFUSED,
//       names the current/proposed lengths in the error, and returns the untouched current body.
//   (2) THE OVERRIDE: the SAME destructive write with allowTruncate:true succeeds.
//   (3) A SHORT-BODY CARD is untouched by the guard — a body under the substantial-body floor can be
//       replaced by anything, no override needed.
//   (4) A COMPARABLE-SIZE REWRITE (stays >=25% of the original) is untouched by the guard.
//   (5) ⭐ THE CASE THAT MATTERS MOST: a legitimate large rewrite that merely SHRINKS the body somewhat
//       (well above the 25% floor) is NOT blocked — an over-eager guard here would get allowTruncate
//       cargo-culted onto every call, defeating the whole point.
//   (6) the refusal is a DISTINCT discriminant (`truncation`, not `conflict`) from the baseVersion
//       guard, and the destructive write never reached the database.
// Run: 1) build daemon, 2) node test/task-body-truncation-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { createProjectTask, updateProjectTask, MIN_SUBSTANTIAL_BODY_CHARS, MAX_SURVIVING_FRACTION } from "../dist/mcp/tasks.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const file = path.join(os.tmpdir(), `loom-task-body-truncation-guard-${Date.now()}-${process.pid}.db`);
const now = new Date().toISOString();

try {
  const db = new Db(file);
  db.insertProject({ id: "projT", name: "Truncation Guard", repoPath: "C:/t", vaultPath: "C:/t", config: {}, createdAt: now, archivedAt: null, reserved: false });

  check("(setup) the constants are the card's own proposed thresholds", MIN_SUBSTANTIAL_BODY_CHARS === 1024 && MAX_SURVIVING_FRACTION === 0.25);

  // A "substantial" body well over the 1KB floor, mirroring the real specimen's shape.
  const bigBody = "The measured evidence and retracted hypotheses. ".repeat(300); // ~14,700 chars
  check("(setup) the fixture body is genuinely substantial", bigBody.length >= MIN_SUBSTANTIAL_BODY_CHARS);

  // ===== (1) THE DESTRUCTIVE CASE — a one-sentence annotation replacing a substantial body =====
  const card1 = createProjectTask(db, "projT", { title: "destructive case", body: bigBody, columnKey: "backlog" });
  const sliver = "unchanged except the final paragraph, replaced by the retraction below";
  check("(1) sliver is under the 25% floor of the fixture body", sliver.length < bigBody.length * MAX_SURVIVING_FRACTION);
  const destructive = await updateProjectTask(db, "projT", card1.id, { body: sliver }, undefined, card1.version);
  check("(1) THE FIX: a destructive body write is REFUSED", destructive.truncation === true && typeof destructive.error === "string");
  check("(1) the error names the CURRENT length", destructive.error.includes(String(bigBody.length)));
  check("(1) the error names the PROPOSED length", destructive.error.includes(String(sliver.length)));
  check("(1) currentLength/proposedLength are also broken out structurally", destructive.currentLength === bigBody.length && destructive.proposedLength === sliver.length);
  check("(1) the refusal returns the CURRENT (untouched) body to reconcile against", destructive.current?.body === bigBody);
  check("(1) THE DESTRUCTIVE WRITE NEVER REACHED THE DATABASE", db.getTask(card1.id).body === bigBody);
  check("(1) the discriminant is `truncation`, distinct from the baseVersion guard's `conflict`", destructive.conflict === undefined);

  // ===== (2) THE OVERRIDE — the identical write, with allowTruncate:true, succeeds =====
  const overridden = await updateProjectTask(db, "projT", card1.id, { body: sliver }, undefined, card1.version, true);
  check("(2) allowTruncate:true bypasses the guard", !overridden.error);
  check("(2) the override write actually landed", db.getTask(card1.id).body === sliver);

  // ===== (3) SHORT-BODY CARD — under the substantial-body floor, untouched by the guard =====
  const shortBody = "a short body, well under 1KB";
  check("(3) the short-body fixture really is short", shortBody.length < MIN_SUBSTANTIAL_BODY_CHARS);
  const card3 = createProjectTask(db, "projT", { title: "short-body card", body: shortBody, columnKey: "backlog" });
  const shortReplace = await updateProjectTask(db, "projT", card3.id, { body: "x" }, undefined, card3.version);
  check("(3) a short body can be replaced by anything — no override needed", !shortReplace.error);
  check("(3) the short-body replace actually landed", db.getTask(card3.id).body === "x");

  // ===== (4) COMPARABLE-SIZE REWRITE — stays >=25% of the original, untouched by the guard =====
  const card4 = createProjectTask(db, "projT", { title: "comparable rewrite", body: bigBody, columnKey: "backlog" });
  const comparable = "x".repeat(Math.ceil(bigBody.length * 0.5)); // 50% of the original — well above the 25% floor
  const comparableWrite = await updateProjectTask(db, "projT", card4.id, { body: comparable }, undefined, card4.version);
  check("(4) a comparable-size rewrite (50% of original) is NOT blocked", !comparableWrite.error);
  check("(4) the comparable rewrite actually landed", db.getTask(card4.id).body === comparable);

  // ===== (5) ⭐ THE CASE THAT MATTERS MOST — a legitimate large rewrite that merely shrinks the body
  // somewhat (well above the 25% floor: this one keeps ~80%) must NOT be blocked. =====
  const card5 = createProjectTask(db, "projT", { title: "legitimate shrink", body: bigBody, columnKey: "backlog" });
  const trimmedBody = bigBody.slice(0, Math.floor(bigBody.length * 0.8)); // keeps 80% — a real edit, not an accident
  check("(5) the trimmed fixture is a real edit (>25% survives) but genuinely shorter than the original", trimmedBody.length < bigBody.length && trimmedBody.length >= bigBody.length * MAX_SURVIVING_FRACTION);
  const legitimateShrink = await updateProjectTask(db, "projT", card5.id, { body: trimmedBody }, undefined, card5.version);
  check("(5) ⭐ A LEGITIMATE SHRINKING REWRITE IS NOT BLOCKED — the guard must not be over-eager", !legitimateShrink.error && legitimateShrink.truncation === undefined);
  check("(5) the legitimate shrink actually landed", db.getTask(card5.id).body === trimmedBody);

  // ===== (6) boundary sanity: exactly AT the substantial-body floor with exactly AT the surviving
  // fraction should NOT trip (guard uses strict '<', not '<=', on the surviving-fraction side) =====
  const boundaryBody = "y".repeat(MIN_SUBSTANTIAL_BODY_CHARS);
  const card6 = createProjectTask(db, "projT", { title: "boundary card", body: boundaryBody, columnKey: "backlog" });
  const exactQuarter = "z".repeat(Math.ceil(boundaryBody.length * MAX_SURVIVING_FRACTION)); // >= 25%, not strictly under
  const boundaryWrite = await updateProjectTask(db, "projT", card6.id, { body: exactQuarter }, undefined, card6.version);
  check("(6) a proposed body at exactly the surviving-fraction floor is NOT blocked (strict '<', not '<=')", !boundaryWrite.error);

  db.close();
} finally {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — updateProjectTask (card 09d68835) refuses a `body` write that would discard the large majority (keeping <25%) of a substantial (>=1KB) existing body, names the current/proposed lengths in the error, returns the untouched current body to reconcile against, and NEVER lets the destructive write reach the database — while a short-body card, a comparable-size rewrite, and (most importantly) a legitimate large rewrite that merely shrinks the body somewhat all pass through untouched, and the explicit allowTruncate:true override bypasses the guard deliberately."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
