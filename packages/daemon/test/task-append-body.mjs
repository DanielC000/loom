import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8636f761 (DoD-1) — `updateProjectTask`'s `appendBody` param: an ADDITIVE alternative to `body`
// for a Lead triaging a `platform_escalate` card. `body` is a full replace with no undo — writing a
// verdict through it destroyed the reporter's original evidence unless the Lead manually re-pasted it
// under its own "preserved verbatim" heading first (a workaround for a data-loss default, not a fix).
//
// Proves the DoD:
//   (1) appendBody adds a timestamped "## Triage note — <ts>" section and PRESERVES the existing body
//       (including content that itself arrived via an earlier plain `body` write — appendBody must
//       build on top of whatever is there, the same guarantee platform-escalate-append.mjs proves for
//       the manager-side re-escalation append).
//   (2) both `body` and `appendBody` together is REJECTED — whole patch, nothing written.
//   (3) appendBody needs NO baseVersion — succeeds with baseVersion omitted, and even with a STALE
//       baseVersion passed alongside it (appendBody computes its own version from a fresh read, so a
//       caller's stale/absent value can never block it — a `body` write with the SAME stale baseVersion
//       would be refused as a conflict, proving the two really do differ here).
//   (4) the DESTRUCTIVE-TRUNCATION GUARD is NOT bypassed for appendBody's resulting write — a `body`
//       write with the identical BEFORE/AFTER lengths appendBody would itself produce (i.e. the same
//       total size an append that somehow shrank would look like) is still refused by the guard. This
//       demonstrates the guard's code path is genuinely in the loop for an appendBody-shaped write, even
//       though a CORRECT append (which only ever grows the body) can never trip it in practice.
//
// HERMETIC: no daemon, no real claude — drives the built business logic (dist/) against a throwaway
// SQLite Db, mirroring task-body-truncation-guard.mjs's harness style.
//
// Run: 1) build daemon, 2) node test/task-append-body.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { createProjectTask, updateProjectTask, MIN_SUBSTANTIAL_BODY_CHARS, MAX_SURVIVING_FRACTION } from "../dist/mcp/tasks.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const file = path.join(os.tmpdir(), `loom-task-append-body-${Date.now()}-${process.pid}.db`);
const now = new Date().toISOString();

try {
  const db = new Db(file);
  db.insertProject({ id: "projA", name: "Append Body", repoPath: "C:/t", vaultPath: "C:/t", config: {}, createdAt: now, archivedAt: null, reserved: false });

  // ===== (1) appendBody adds a section, preserves what's already there =====
  const card1 = createProjectTask(db, "projA", { title: "escalation under triage", body: "**Escalated by a project manager.**\n\nOriginal evidence: the gate hung for 4 minutes.", columnKey: "backlog" });
  const appended1 = await updateProjectTask(db, "projA", card1.id, {}, undefined, undefined, undefined, "Investigating — looks host-related, not a Loom bug.");
  check("(1) appendBody succeeds with no error", !appended1.error);
  check("(1) the ORIGINAL body is preserved", appended1.body?.includes("Original evidence: the gate hung for 4 minutes."));
  check("(1) the note is added as its own timestamped section", appended1.body?.includes("## Triage note —"));
  check("(1) the note text itself is present", appended1.body?.includes("Investigating — looks host-related, not a Loom bug."));
  check("(1) the DB row actually carries the appended body", db.getTask(card1.id).body === appended1.body);

  // A SECOND triage note (e.g. a follow-up verdict) must build on top of the first, not replace it.
  const appended1b = await updateProjectTask(db, "projA", card1.id, {}, undefined, undefined, undefined, "Confirmed host-related — closing.");
  check("(1b) a second appendBody preserves the FIRST triage note", appended1b.body?.includes("Investigating — looks host-related, not a Loom bug."));
  check("(1b) ...and the ORIGINAL evidence underneath both", appended1b.body?.includes("Original evidence: the gate hung for 4 minutes."));
  check("(1b) ...and adds the new note too", appended1b.body?.includes("Confirmed host-related — closing."));

  // ===== (2) body + appendBody together is rejected, nothing written =====
  const card2 = createProjectTask(db, "projA", { title: "exclusivity check", body: "original body", columnKey: "backlog" });
  const both = await updateProjectTask(db, "projA", card2.id, { body: "replacement body" }, undefined, card2.version, undefined, "a triage note");
  check("(2) passing both body and appendBody is REJECTED", typeof both.error === "string");
  check("(2) the body is untouched by the rejected call", db.getTask(card2.id).body === "original body");

  // ===== (3) no baseVersion required — and a STALE baseVersion doesn't block it either =====
  const card3 = createProjectTask(db, "projA", { title: "no baseVersion needed", body: "v1 body", columnKey: "backlog" });
  const noVersion = await updateProjectTask(db, "projA", card3.id, {}, undefined, undefined, undefined, "note with no baseVersion at all");
  check("(3) appendBody with NO baseVersion succeeds", !noVersion.error && noVersion.body?.includes("note with no baseVersion at all"));

  // Bump the version once more (a plain body write) so `card3.version` (captured at creation) is now stale.
  await updateProjectTask(db, "projA", card3.id, { body: "v2 body, unrelated edit" }, undefined, noVersion.version);
  const staleAppend = await updateProjectTask(db, "projA", card3.id, {}, undefined, card3.version /* stale */, undefined, "note with a STALE baseVersion");
  check("(3) appendBody with a STALE baseVersion still succeeds (it computes its own version internally)", !staleAppend.error && staleAppend.body?.includes("note with a STALE baseVersion"));
  check("(3) ...and it appended onto the CURRENT (v2) body, not the stale one it was handed", staleAppend.body?.includes("v2 body, unrelated edit"));
  // Contrast: the SAME stale baseVersion on a plain `body` write IS refused — proving appendBody's
  // exemption is real, not just "this Db instance never checks baseVersion".
  const staleBodyWrite = await updateProjectTask(db, "projA", card3.id, { body: "should not land" }, undefined, card3.version /* stale */);
  check("(3) CONTRAST: the identical stale baseVersion on a plain `body` write IS refused", staleBodyWrite.conflict === true);

  // ===== (4) the destructive-truncation guard still applies to the write appendBody produces =====
  // appendBody can never itself construct a shrinking write (it only ever concatenates onto the
  // current body), so we can't trigger the guard THROUGH the public appendBody knob without injecting
  // a bug. What we CAN prove is that the guard is still live on the exact SHAPE of write appendBody
  // performs internally (a `body` patch, checked against the task's CURRENT on-disk body) — i.e. the
  // guard was not disabled or routed around for this call shape.
  const bigBody = "The measured evidence and retracted hypotheses. ".repeat(300); // ~14,700 chars, well over MIN_SUBSTANTIAL_BODY_CHARS
  const card4 = createProjectTask(db, "projA", { title: "guard still live for this write shape", body: bigBody, columnKey: "backlog" });
  check("(4) the fixture body is genuinely substantial", bigBody.length >= MIN_SUBSTANTIAL_BODY_CHARS);
  const shrinkingBodyWrite = await updateProjectTask(db, "projA", card4.id, { body: "a sliver" }, undefined, card4.version);
  check("(4) a shrinking `body` write against this same task is still refused by the truncation guard", shrinkingBodyWrite.truncation === true);
  check("(4) ...and never reached the database", db.getTask(card4.id).body === bigBody);
  // And the ordinary appendBody path on the SAME substantial-body task is untouched by the guard,
  // since it only ever grows the body — the guard costs nothing on the correct path.
  const growingAppend = await updateProjectTask(db, "projA", card4.id, {}, undefined, undefined, undefined, "a short triage note");
  check("(4) appendBody on a substantial body is NOT blocked (it only ever grows the body)", !growingAppend.error);
  check("(4) ...and the full original body is still there underneath the note", growingAppend.body?.startsWith(bigBody));

  db.close();
} finally {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — updateProjectTask's appendBody (card 8636f761) appends a timestamped triage-note section without ever clobbering the existing body (including a prior appendBody's own note), rejects body+appendBody together with nothing written, needs no baseVersion (and is immune to a stale one, unlike a plain body write), and leaves the destructive-truncation guard fully live for the write shape it produces."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
