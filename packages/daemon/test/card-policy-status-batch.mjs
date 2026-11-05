import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f9a774c4 — the board's card-policy-status read batches its evidence (one project-keyed waiver read, one project-keyed
// permission-Request read) and must still equal per-card `taskPolicyView` for EVERY card, with the same trust rules:
//  (E) a mixed fixture (human-path / agent-path / consumed / lapsed / reject / decision Requests, a legacy 8-char-prefix
//      Request, a same-id Request and waiver in ANOTHER project) => batched entry === taskPolicyView entry, per card;
//  (T) the trust expectations are asserted as absolutes too (so an evaluator and a batch that are wrong TOGETHER still fail):
//      an agent-written answer never counts, another project's Request/waiver never counts, a legacy prefix Request does;
//  (Q) the batch issues a constant number of evidence reads, not one per card.
import { randomUUID } from "node:crypto";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";
useOwnLoomHome("cpsb-");
process.env.LOOM_PORT = String(hermeticPort());
requireHermeticEnv();

const { makeEnv, policy, closeAll } = await import("./_card-policy-fixture.mjs");
const { buildServer } = await import("../dist/gateway/server.js");
const { taskPolicyView } = await import("../dist/mcp/tasks.js");
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const e = await makeEnv();
const stub = {};
const app = await buildServer({ db: e.db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
const getStatus = async () => (await app.inject({ method: "GET", url: `/api/projects/${e.projId}/card-policy-status` })).json().tasks;

const otherProj = `cpsb-other-${e.sfx}`;
e.db.insertProject({ id: otherProj, name: "Other", repoPath: e.repo, vaultPath: e.repo, config: {}, createdAt: e.now, archivedAt: null });

// Real UUID card ids (the legacy-prefix lookup depends on the `<8 hex>-` id shape).
const card = (title) => { const id = randomUUID(); e.db.insertTask({ id, projectId: e.projId, title, body: "", columnKey: "in_progress", position: 1, createdAt: e.now, updatedAt: e.now }); return id; };
const cards = {
  human: card("feat(x): human"), agent: card("feat(x): agent"), consumed: card("feat(x): consumed"), lapsed: card("feat(x): lapsed"),
  reject: card("feat(x): reject"), decision: card("feat(x): decision"), legacy: card("feat(x): legacy"), foreignReq: card("feat(x): foreign request"),
  legacyUpper: card("feat(x): legacy upper"), foreignLegacy: card("feat(x): foreign legacy"),
  foreignWaiver: card("feat(x): foreign waiver"), waived: card("feat(x): waived"), none: card("feat(x): nothing"), plain: card("docs(x): plain"),
};
e.setPolicies([policy({ id: "ap", name: "Approve", match: { types: ["feat"] }, require: [{ kind: "approved-request" }] })]);

const past = new Date(Date.now() - 3_600_000).toISOString();
e.fileRequest({ taskId: cards.human });
e.fileRequest({ taskId: cards.agent, answeredVia: null }); // answered through the agent path (question_resolve): no human stamp
e.fileRequest({ taskId: cards.consumed, state: "consumed" });
e.fileRequest({ taskId: cards.lapsed, decidedExpiresAt: past });
e.fileRequest({ taskId: cards.reject, chosenOption: "reject" });
e.fileRequest({ taskId: cards.decision, type: "decision", chosenOption: "approve" });
// A legacy Request linked by the 8-char id PREFIX (pre-a3f1319f rows), human-answered.
e.fileRequest({ taskId: cards.legacy.slice(0, 8) });
// The same shape with the prefix stored UPPERCASE: the per-card LIKE is case-insensitive, so the batch must match it too.
e.fileRequest({ taskId: cards.legacyUpper.slice(0, 8).toUpperCase() });
// A human-authorized Request in ANOTHER project that carries this project's card id: must never count here.
const fileForeign = (taskId) => {
  const id = `cpsb-q-${randomUUID().slice(0, 8)}`;
  e.db.insertQuestion({ id, sessionId: e.mgrId, projectId: otherProj, title: "foreign", body: "b", type: "permission", options: null, recommendation: null, taskId, state: "pending", chosenOption: null, note: null, createdAt: e.now, answeredAt: null, consumedAt: null });
  e.db.answerQuestion(id, { chosenOption: "authorize", note: "n", answeredAt: e.now, answeredVia: "human" });
};
fileForeign(cards.foreignReq);
// ...and the same for a legacy 8-char PREFIX Request in another project.
fileForeign(cards.foreignLegacy.slice(0, 8));
// A waiver recorded under ANOTHER project for this project's card id: must never count here.
e.db.upsertCardPolicyWaiver({ taskId: cards.foreignWaiver, projectId: otherProj, policyId: "ap", requirementKind: "approved-request", reason: "r", waivedBy: "owner", createdAt: e.now });
e.db.upsertCardPolicyWaiver({ taskId: cards.waived, projectId: e.projId, policyId: "ap", requirementKind: "approved-request", reason: "r", waivedBy: "owner", createdAt: e.now });

// ── (E) batched === taskPolicyView, per card ────────────────────────────────────────────────────────────
const batched = await getStatus();
let equal = true;
for (const t of e.db.listTasks(e.projId)) {
  const view = await taskPolicyView(e.db, e.projId, t);
  const want = view ? { blocking: view.filter((r) => r.status === "unmet" || r.status === "unreadable").length, total: view.length } : undefined;
  if (JSON.stringify(batched[t.id]) !== JSON.stringify(want)) { equal = false; console.log("   MISMATCH", t.id, JSON.stringify(batched[t.id]), JSON.stringify(want)); }
}
check("(E1) every card's batched entry equals per-card taskPolicyView", equal);

// ── (T) absolute trust expectations ─────────────────────────────────────────────────────────────────────
const blocking = (k) => batched[cards[k]]?.blocking;
check("(T1) a human-path authorize counts (blocking 0)", blocking("human") === 0);
check("(T2) an AGENT-written answer does NOT count (blocking 1)", blocking("agent") === 1);
check("(T3) a consumed human grant counts", blocking("consumed") === 0);
check("(T4) a lapsed grant, a reject and a decision-type Request do not count", blocking("lapsed") === 1 && blocking("reject") === 1 && blocking("decision") === 1);
check("(T5) a legacy 8-char-prefix Request counts for its card", blocking("legacy") === 0);
check("(T5b) a legacy 8-char-prefix Request stored UPPERCASE counts (case-insensitive like the per-card LIKE)", blocking("legacyUpper") === 0);
check("(T5c) ANOTHER project's authorized legacy-PREFIX Request does not count", blocking("foreignLegacy") === 1);
check("(T6) ANOTHER project's authorized Request for the same card id does not count", blocking("foreignReq") === 1);
check("(T7) ANOTHER project's waiver for the same card id does not waive; this project's does", blocking("foreignWaiver") === 1 && blocking("waived") === 0);
check("(T8) a card with no Request is unmet, and a card no policy matches is absent", blocking("none") === 1 && !(cards.plain in batched));

// ── (Q) constant evidence reads ─────────────────────────────────────────────────────────────────────────
{
  const counts = { perCardQ: 0, perCardW: 0, batchQ: 0, batchW: 0 };
  const wrap = (name, key) => { const o = e.db[name].bind(e.db); e.db[name] = (...a) => { counts[key]++; return o(...a); }; };
  wrap("listQuestionsForTask", "perCardQ"); wrap("listCardPolicyWaivers", "perCardW");
  wrap("listAnsweredPermissionQuestionsForProject", "batchQ"); wrap("listCardPolicyWaiversForProject", "batchW");
  await getStatus();
  check("(Q1) the status read makes no per-card evidence read", counts.perCardQ === 0 && counts.perCardW === 0);
  check("(Q2) ...and exactly one project-keyed read of each kind", counts.batchQ === 1 && counts.batchW === 1);
}

await app.close();
closeAll();
console.log(failures === 0 ? "\n✅ ALL PASS — card-policy status batch" : `\n${failures} check(s) FAILED.`);
await finishAndExit(failures === 0 ? 0 : 1);
