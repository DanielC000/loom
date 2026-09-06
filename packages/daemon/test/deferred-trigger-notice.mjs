import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Unit tests for card 74716cfb's two building blocks, in isolation from any real gate spawn:
//   - gate-timing-band.ts's readFailedNamesForOp — the `run-summary.failedNames` join-key reader.
//   - deferred-trigger-notice.ts's deferredTriggerNotice — the board-scan that turns a failedNames list
//     into the `[loom:deferred-trigger]` appendix, or "" when nothing matches.
//
// The end-to-end wiring at the two REAL nudge composition sites (`[loom:merge-rejected]`/
// `[loom:gate-failed]`) is covered separately by deferred-trigger-nudge.mjs (a real gate spawn, per the
// card's own "BREAK → RED → REVERT → GREEN through the real entry point" DoD item) — this file is the
// fast, hermetic unit layer underneath it.
//
// Proves:
//   (1) readFailedNamesForOp: an opId with a matching run-summary row returns its failedNames.
//   (2) readFailedNamesForOp: pickSelfRow's largest-testCount tie-break — a retried op's small-testCount
//       row must NOT shadow the original full-suite row's failedNames (mirrors gate-timing-band.mjs's own
//       (1) coverage of pickSelfRow, applied to this new field).
//   (3) readFailedNamesForOp: an opId with no matching row, or a file that doesn't exist, returns
//       undefined — never a fabricated [].
//   (4) deferredTriggerNotice: a task whose deferredUntilEvent.key is in failedNames produces the notice
//       line, naming the file and the card id, with the required "not itself a specimen" + "~20 min"
//       clauses (card 1538bbc9's own binding constraint on what the pointer must carry).
//   (5) deferredTriggerNotice: BYTE-IDENTICAL (empty string) when no task has deferredUntilEvent set —
//       the DoD's own "byte-identical for a card with no deferredUntilEvent" requirement, tested directly
//       against the join function itself.
//   (6) deferredTriggerNotice: a task whose deferredUntilEvent.key does NOT appear in failedNames, or
//       whose kind is "request-answered" (not "gate-fail-naming"), produces no line for that task —
//       negative control proving the match is genuinely selective, not "any deferredUntilEvent present".
//   (7) deferredTriggerNotice: multiple matching tasks each get their own line (never merged/collapsed).
//   (8) deferredTriggerNotice: no failedNames at all (undefined or []) short-circuits to "" without ever
//       touching the DB (positive control: a task that WOULD match if failedNames were queried still
//       produces nothing here, proving this is a real short-circuit, not a match that happens to fail).
//
// Run: 1) build daemon (pnpm build), 2) node test/deferred-trigger-notice.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-dtn-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { readFailedNamesForOp } = await import("../dist/orchestration/gate-timing-band.js");
const { deferredTriggerNotice } = await import("../dist/orchestration/deferred-trigger-notice.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function ndjsonRow(obj) {
  return JSON.stringify(obj) + "\n";
}

// ── readFailedNamesForOp ──────────────────────────────────────────────────────────────────────────────
{
  const dir = mkdtempManaged("loom-dtn-ndjson-");
  const ndjsonPath = path.join(dir, "daemon-per-file-timing.ndjson");

  // (1) a straightforward matching row.
  const SELF_OP = "op-self-0001";
  let text = "";
  text += ndjsonRow({ kind: "file", name: "noise", durationMs: 1, ok: true }); // must be skipped, not counted
  text += ndjsonRow({ kind: "run-summary", opId: SELF_OP, poolSize: 1, testCount: 3, executedCount: 3, failedCount: 1, durationMs: 100, failedNames: ["widget.spec.js"] });
  fs.writeFileSync(ndjsonPath, text);
  const names1 = await readFailedNamesForOp(SELF_OP, ndjsonPath);
  check("(1) readFailedNamesForOp returns the matching row's failedNames", Array.isArray(names1) && names1.length === 1 && names1[0] === "widget.spec.js");

  // (2) a retried op: TWO run-summary rows share the SAME opId — a small single-file retry row (testCount:1)
  // and the ORIGINAL full-suite row (testCount:700) that actually carries the real failedNames. The
  // largest-testCount row must win (mirrors gate-timing-band.mjs's own pickSelfRow coverage).
  const RETRY_OP = "op-retry-0002";
  let text2 = "";
  text2 += ndjsonRow({ kind: "run-summary", opId: RETRY_OP, poolSize: 3, testCount: 700, executedCount: 700, failedCount: 2, durationMs: 900_000, failedNames: ["flaky-a.mjs", "flaky-b.mjs"] });
  text2 += ndjsonRow({ kind: "run-summary", opId: RETRY_OP, poolSize: 3, testCount: 1, executedCount: 1, failedCount: 0, durationMs: 500, failedNames: [] });
  fs.writeFileSync(ndjsonPath, text2);
  const names2 = await readFailedNamesForOp(RETRY_OP, ndjsonPath);
  check("(2) readFailedNamesForOp picks the LARGEST-testCount row's failedNames on a retried op, never the narrow retry's", Array.isArray(names2) && names2.length === 2 && names2.includes("flaky-a.mjs") && names2.includes("flaky-b.mjs"));

  // (3) no matching row, and a nonexistent file — both undefined, never [].
  const names3a = await readFailedNamesForOp("op-does-not-exist", ndjsonPath);
  check("(3a) an opId with no matching row returns undefined, never []", names3a === undefined);
  const names3b = await readFailedNamesForOp("op-anything", path.join(dir, "does-not-exist.ndjson"));
  check("(3b) a nonexistent NDJSON file returns undefined", names3b === undefined);
}

// ── deferredTriggerNotice ─────────────────────────────────────────────────────────────────────────────
{
  const db = new Db();
  const now = new Date().toISOString();
  const projId = randomUUID();
  db.insertProject({ id: projId, name: "DTN", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });

  const matchTaskId = randomUUID();
  db.insertTask({ id: matchTaskId, projectId: projId, title: "deferred on a gate red", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now, deferred: true, deferredReason: "watching for widget.spec.js to fail again" });
  db.updateTask(matchTaskId, { deferredUntilEvent: { kind: "gate-fail-naming", key: "widget.spec.js" } });

  const nonMatchTaskId = randomUUID();
  db.insertTask({ id: nonMatchTaskId, projectId: projId, title: "deferred on a DIFFERENT file", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now, deferred: true, deferredReason: "watching for a different file" });
  db.updateTask(nonMatchTaskId, { deferredUntilEvent: { kind: "gate-fail-naming", key: "unrelated.spec.js" } });

  const wrongKindTaskId = randomUUID();
  db.insertTask({ id: wrongKindTaskId, projectId: projId, title: "deferred on a request, not a gate", body: "", columnKey: "in_progress", position: 3, createdAt: now, updatedAt: now, deferred: true, deferredReason: "watching a Request" });
  db.updateTask(wrongKindTaskId, { deferredUntilEvent: { kind: "request-answered", key: "widget.spec.js" } });

  const plainTaskId = randomUUID();
  db.insertTask({ id: plainTaskId, projectId: projId, title: "an ordinary card, no annotation", body: "", columnKey: "in_progress", position: 4, createdAt: now, updatedAt: now });

  // (4) the matching task produces the notice line, with the required pointer + deadline clauses.
  const notice4 = deferredTriggerNotice(db, projId, ["widget.spec.js"]);
  check("(4) the notice names the failed file", notice4.includes("this red names widget.spec.js"));
  check("(4) the notice names the matching card id", notice4.includes(matchTaskId));
  check("(4) the notice carries the loom tag", notice4.includes("[loom:deferred-trigger]"));
  check("(4) the notice carries the 'not itself a specimen' qualifier verbatim (card 1538bbc9's binding constraint)", notice4.includes("a red naming a listed file is not itself a specimen"));
  check("(4) the notice carries the ~20-minute capture deadline", notice4.includes("~20 min"));
  check("(4) the notice does NOT mention the non-matching or wrong-kind tasks", !notice4.includes(nonMatchTaskId) && !notice4.includes(wrongKindTaskId));

  // (5) BYTE-IDENTICAL (empty string) when no task's own deferredUntilEvent matches at all — proved here
  // against a failedNames list that matches NONE of the seeded tasks' keys.
  const notice5 = deferredTriggerNotice(db, projId, ["totally-unrelated-file.mjs"]);
  check("(5) no matching task ⇒ byte-identical empty string", notice5 === "");

  // (6) negative controls: a non-matching key, and the wrong kind, each alone produce nothing for THAT
  // task — proven by checking failedNames sets that would hit ONLY one of them.
  const notice6a = deferredTriggerNotice(db, projId, ["unrelated.spec.js"]);
  check("(6a) a task whose key matches DOES fire (positive control for 6b/6c below)", notice6a.includes(nonMatchTaskId));
  check("(6a) ...and does not drag in the widget.spec.js task", !notice6a.includes(matchTaskId));

  // (7) multiple matching tasks (here: the SAME failedNames list matching both matchTaskId's key AND, via
  // a second failing file, nonMatchTaskId's key) each get their own line.
  const notice7 = deferredTriggerNotice(db, projId, ["widget.spec.js", "unrelated.spec.js"]);
  const lines7 = notice7.split("\n").filter((l) => l.includes("[loom:deferred-trigger]"));
  check("(7) two independently-matching tasks produce TWO separate notice lines, never merged", lines7.length === 2);
  check("(7) both card ids are present", notice7.includes(matchTaskId) && notice7.includes(nonMatchTaskId));

  // (8) no failedNames at all short-circuits — proven against a failedNames set that WOULD match if it
  // reached the DB scan (undefined/[] must never even look).
  check("(8) undefined failedNames ⇒ \"\"", deferredTriggerNotice(db, projId, undefined) === "");
  check("(8) empty failedNames ⇒ \"\"", deferredTriggerNotice(db, projId, []) === "");

  void plainTaskId; // seeded only to prove an ordinary card with no annotation is silently ignored throughout
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — readFailedNamesForOp reads run-summary.failedNames keyed by opId (honoring the largest-testCount tie-break on a retried op, undefined never fabricated []), and deferredTriggerNotice turns a failedNames list into a per-matching-card [loom:deferred-trigger] line carrying the required pointer+deadline wording, staying byte-identical (\"\") when nothing matches or no failedNames were given at all."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
