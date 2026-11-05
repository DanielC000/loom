import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9623e943 — the HUMAN-only REST waiver surface (POST/DELETE /api/tasks/:id/policy-waivers), driven through the
// real gateway with app.inject (no listener, no daemon). Proves: validation, persistence per (card, policy,
// requirement kind), the audit `card_policy_waived` event on waive AND revoke, no event for a no-op revoke, and that
// a recorded waiver is what the evaluator reads (a requirement flips unmet -> waived -> unmet).
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";
useOwnLoomHome("cpw-");
process.env.LOOM_PORT = String(hermeticPort());
requireHermeticEnv();

const { makeEnv, policy, closeAll } = await import("./_card-policy-fixture.mjs");
const { buildServer } = await import("../dist/gateway/server.js");
const { getProjectTask } = await import("../dist/mcp/tasks.js");
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const e = await makeEnv();
const stub = {};
const app = await buildServer({ db: e.db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
const t = e.addTask("w1");
e.setPolicies([policy({ require: [{ kind: "approved-request" }] })]);
const url = `/api/tasks/${t}/policy-waivers`;
const post = (payload, u = url) => app.inject({ method: "POST", url: u, payload });
const del = (payload, u = url) => app.inject({ method: "DELETE", url: u, payload });
const waivedEvents = () => e.db.listRecentEventsByKinds(["card_policy_waived"], 50);
const viewStatus = async () => (await getProjectTask(e.db, e.projId, t)).policy?.find((p) => p.requirement === "approved-request")?.status;

check("(W0) setup: the requirement is unmet before any waiver", (await viewStatus()) === "unmet");

check("(W1) unknown task => 404", (await post({ policyId: "p1", requirement: "approved-request", reason: "r" }, "/api/tasks/nope/policy-waivers")).statusCode === 404);
check("(W1) missing reason => 400 (a waiver always carries a reason)", (await post({ policyId: "p1", requirement: "approved-request" })).statusCode === 400);
check("(W1) blank reason => 400", (await post({ policyId: "p1", requirement: "approved-request", reason: "   " })).statusCode === 400);
check("(W1) unknown requirement kind => 400", (await post({ policyId: "p1", requirement: "teleport", reason: "r" })).statusCode === 400);
check("(W1) bad policyId => 400", (await post({ policyId: "has space", requirement: "approved-request", reason: "r" })).statusCode === 400);
const ghost = await post({ policyId: "ghost", requirement: "approved-request", reason: "r" });
check("(W1) a policyId that matches NO configured policy => 400 naming it", ghost.statusCode === 400 && /ghost/.test(ghost.json().error ?? ""));
e.setPolicies("not-a-list");
check("(W1) with an unreadable policy config nothing can be validated => 400", (await post({ policyId: "p1", requirement: "approved-request", reason: "r" })).statusCode === 400);
e.setPolicies([policy({ require: [{ kind: "approved-request" }] })]);
check("(W1) none of the rejected calls wrote a waiver or an event", e.db.listCardPolicyWaivers(t, e.projId).length === 0 && waivedEvents().length === 0);

const ok = await post({ policyId: "p1", requirement: "approved-request", reason: "owner approved out of band" });
check("(W2) valid waiver => 200 {ok:true}", ok.statusCode === 200 && ok.json().ok === true);
const rows = e.db.listCardPolicyWaivers(t, e.projId);
check("(W2) one row for exactly (card, policy, requirement) with the reason and a human author", rows.length === 1 && rows[0].policyId === "p1" && rows[0].requirementKind === "approved-request" && rows[0].reason === "owner approved out of band" && rows[0].waivedBy === "human");
const ev = waivedEvents();
check("(W2) an audit card_policy_waived event {action:waive} names card, policy, requirement and reason", ev.length === 1 && ev[0].taskId === t && ev[0].detail?.action === "waive" && ev[0].detail?.policyId === "p1" && ev[0].detail?.requirement === "approved-request" && ev[0].detail?.reason === "owner approved out of band");
check("(W2) the waive event detail records the card's projectId", ev[0].detail?.projectId === e.projId);
check("(W3) the evaluator reads it: the requirement now shows `waived`", (await viewStatus()) === "waived");

const again = await post({ policyId: "p1", requirement: "approved-request", reason: "updated reason" });
check("(W4) re-POST upserts (still ONE row, reason updated)", again.statusCode === 200 && e.db.listCardPolicyWaivers(t, e.projId).length === 1 && e.db.listCardPolicyWaivers(t, e.projId)[0].reason === "updated reason");

const other = await post({ policyId: "p1", requirement: "code-review-report", reason: "r2" });
check("(W5) a waiver for another requirement kind is a separate row", other.statusCode === 200 && e.db.listCardPolicyWaivers(t, e.projId).length === 2);

const gone = await del({ policyId: "p1", requirement: "approved-request" });
check("(W6) DELETE => 200 removed:true and the requirement is `unmet` again", gone.statusCode === 200 && gone.json().removed === true && (await viewStatus()) === "unmet");
check("(W6) revoking one kind leaves the sibling waiver", e.db.listCardPolicyWaivers(t, e.projId).length === 1 && e.db.listCardPolicyWaivers(t, e.projId)[0].requirementKind === "code-review-report");
check("(W6) the revoke wrote an audit event {action:revoke}", waivedEvents().some((x) => x.detail?.action === "revoke" && x.detail?.requirement === "approved-request"));
check("(W6) the revoke event detail records the card's projectId", waivedEvents().some((x) => x.detail?.action === "revoke" && x.detail?.projectId === e.projId));
const eventsBefore = waivedEvents().length;
const noop = await del({ policyId: "p1", requirement: "approved-request" });
check("(W7) revoking a waiver that does not exist => removed:false and NO event", noop.statusCode === 200 && noop.json().removed === false && waivedEvents().length === eventsBefore);
check("(W7) DELETE needs no reason, but still validates the requirement kind", (await del({ policyId: "p1", requirement: "teleport" })).statusCode === 400);


// (A1) card 9623e943 F1: a REAL human REST answer is what satisfies approved-request. POST /api/questions/:id/answer stamps
// answeredVia:"human"; the SAME answer written the agent way (db.answerQuestion with no stamp: question_resolve / companion
// decision_resolve) does not count. Both rows are otherwise identical (permission, answered, authorize).
{
  const tH = e.addTask("humanrest"), tA = e.addTask("agentrow");
  const viewOf = async (id) => (await getProjectTask(e.db, e.projId, id)).policy?.find((p) => p.requirement === "approved-request")?.status;
  const hq = e.fileRequest({ taskId: tH, state: "pending" });
  const aq = e.fileRequest({ taskId: tA, state: "answered", answeredVia: null });
  check("(A1) setup: both cards are unmet before the human answers", (await viewOf(tH)) === "unmet" && (await viewOf(tA)) === "unmet");
  const ans = await app.inject({ method: "POST", url: `/api/questions/${hq}/answer`, payload: { decision: "authorize" } });
  check("(A1) the human REST answer route accepts the authorize answer", ans.statusCode === 200);
  check("(A1) ...and stamped answeredVia 'human' on the row", e.db.getQuestion(hq)?.answeredVia === "human");
  check("(A1) ...which flips the card's approved-request to `met`", (await viewOf(tH)) === "met");
  check("(A1) the agent-written authorize answer (answeredVia null) stays `unmet`", e.db.getQuestion(aq)?.answeredVia == null && (await viewOf(tA)) === "unmet");
}
await app.close();
closeAll();
console.log(failures === 0 ? "\n✅ ALL PASS — card-policy waiver route" : `\n${failures} check(s) FAILED.`);
await finishAndExit(failures === 0 ? 0 : 1);
