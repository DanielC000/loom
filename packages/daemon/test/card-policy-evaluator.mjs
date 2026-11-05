import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9623e943 — the PURE card-policy evaluator (orchestration/card-policy.ts), no daemon, no git, no DB:
//   (E1) an absent/empty stored list returns BEFORE any evidence read (zero spy calls) — byte-identical default.
//   (E2) each requirement kind: met / unmet / unreadable (a throwing reader) / waived, at its own phase;
//        the other phase's kinds report `deferred` and read nothing.
//   (E3) the stored override is parsed RAW: a non-array / structurally invalid / unknown-kind list is
//        "unreadable => every policy unmet" (a single blocking `config` verdict), never an empty pass.
//   (E4) refusal wording names the policy, the requirement, BOTH spawn remedies (permission Request / waiver) and the waiver.
//   (E5) dbPolicyEvidence: ONLY a permission Request, answered|consumed, chosenOption "authorize" counts.
//   (E6) a policy whose selector does not match the card is never evaluated.
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
useOwnLoomHome("cpe-");
requireHermeticEnv();

const cp = await import("../dist/orchestration/card-policy.js");
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function spy(over = {}) {
  const calls = { permission: 0, review: 0, checkpoint: 0, waived: 0 };
  const ev = {
    authorizedPermissionRequest: () => { calls.permission++; return { met: false, detail: "none linked" }; },
    codeReview: () => { calls.review++; return { met: false, detail: "no review" }; },
    checkpoint: () => { calls.checkpoint++; return { met: false, detail: "no checkpoint" }; },
    waived: () => { calls.waived++; return false; },
    ...over,
  };
  return { ev, calls };
}
const task = { id: "abcdef0123456789", title: "feat(x): do a thing" };
const pol = (id, req, match = { types: ["feat"] }) => ({ id, name: `Name ${id}`, match, require: req });
const evalP = (raw, phase, ev) => cp.evaluateCardPolicies({ rawPolicies: raw, task, phase, evidence: ev });

// ── (E1) empty/absent ⇒ zero evidence reads ──────────────────────────────────────────────────────────────────────
for (const [label, raw] of [["undefined", undefined], ["[]", []]]) {
  const { ev, calls } = spy();
  const r = await evalP(raw, "merge", ev);
  check(`(E1) ${label}: no verdicts, nothing blocking`, r.verdicts.length === 0 && r.blocking.length === 0);
  check(`(E1) ${label}: ZERO evidence reads (permission/review/checkpoint/waived)`, Object.values(calls).every((n) => n === 0));
}

// ── (E2) each requirement, per phase ────────────────────────────────────────────────────────────────────────────
{
  const raw = [pol("a", [{ kind: "approved-request" }, { kind: "code-review-report" }, { kind: "investigate-checkpoint" }])];
  // spawn phase: only approved-request is read
  const s = spy();
  const rs = await evalP(raw, "spawn", s.ev);
  check("(E2) spawn: approved-request unmet and blocking", rs.verdicts.find((v) => v.kind === "approved-request")?.status === "unmet" && rs.blocking.length === 1);
  check("(E2) spawn: merge-phase kinds are `deferred` and were NOT read", rs.verdicts.filter((v) => v.status === "deferred").length === 2 && s.calls.review === 0 && s.calls.checkpoint === 0);
  // merge phase: only the two merge kinds are read
  const m = spy();
  const rm = await evalP(raw, "merge", m.ev);
  check("(E2) merge: both merge kinds unmet and blocking", rm.blocking.map((v) => v.kind).sort().join() === "code-review-report,investigate-checkpoint");
  check("(E2) merge: approved-request is `deferred` and was NOT read", rm.verdicts.find((v) => v.kind === "approved-request")?.status === "deferred" && m.calls.permission === 0);
  // met
  const met = spy({ authorizedPermissionRequest: () => ({ met: true }), codeReview: () => ({ met: true }), checkpoint: () => ({ met: true }) });
  check("(E2) met: spawn has no blocking verdict", (await evalP(raw, "spawn", met.ev)).blocking.length === 0);
  check("(E2) met: merge has no blocking verdict", (await evalP(raw, "merge", met.ev)).blocking.length === 0);
  // unreadable: a throwing reader fails CLOSED
  const thr = spy({ codeReview: () => { throw new Error("db down"); }, checkpoint: async () => { throw new Error("git down"); } });
  const ru = await evalP(raw, "merge", thr.ev);
  check("(E2) unreadable: a throwing sync reader is `unreadable` and blocking", ru.verdicts.find((v) => v.kind === "code-review-report")?.status === "unreadable");
  check("(E2) unreadable: a rejecting async reader is `unreadable` and blocking", ru.verdicts.find((v) => v.kind === "investigate-checkpoint")?.status === "unreadable" && ru.blocking.length === 2);
  check("(E2) unreadable verdict detail carries the cause (not an empty message)", /db down/.test(ru.verdicts.find((v) => v.kind === "code-review-report").detail));
  // waived: skips the evidence read entirely and does not block
  const w = spy({ waived: (_t, pid, kind) => pid === "a" && kind === "code-review-report" });
  const rw = await evalP(raw, "merge", w.ev);
  check("(E2) waived: that requirement is `waived`, not blocking, and its evidence was NOT read", rw.verdicts.find((v) => v.kind === "code-review-report")?.status === "waived" && w.calls.review === 0);
  check("(E2) waived is per requirement: the sibling requirement still blocks", rw.blocking.length === 1 && rw.blocking[0].kind === "investigate-checkpoint");
  // a throwing waiver reader must not wave the requirement through
  const wt = spy({ waived: () => { throw new Error("waiver table unreadable"); } });
  check("(E2) a throwing waiver reader is treated as NOT waived (the requirement still blocks)", (await evalP(raw, "merge", wt.ev)).blocking.length === 2);
}

// ── (E3) raw stored value: unreadable ⇒ every policy unmet (fail closed) ────────────────────────────────────────────
for (const [label, raw] of [
  ["a non-array string", "garbage"],
  ["an object", { id: "x" }],
  ["an unknown requirement kind (whole-list rejection)", [pol("ok", [{ kind: "approved-request" }]), pol("bad", [{ kind: "teleport" }])]],
  ["a duplicate policy id", [pol("d", [{ kind: "approved-request" }]), pol("d", [{ kind: "code-review-report" }])]],
  ["an empty match", [{ id: "e", match: {}, require: [{ kind: "approved-request" }] }]],
]) {
  for (const phase of ["spawn", "merge"]) {
    const { ev, calls } = spy({ authorizedPermissionRequest: () => ({ met: true }), codeReview: () => ({ met: true }), checkpoint: () => ({ met: true }) });
    const r = await evalP(raw, phase, ev);
    check(`(E3) ${label} @${phase}: blocked as an unreadable config verdict`, r.blocking.length === 1 && r.blocking[0].kind === "config" && r.blocking[0].status === "unreadable");
    check(`(E3) ${label} @${phase}: never reads evidence (cannot tell which policy matches)`, calls.permission === 0 && calls.review === 0 && calls.checkpoint === 0);
  }
}

// ── (E4) wording ─────────────────────────────────────────────────────────────────────────────────────────────────
{
  const raw = [pol("p9", [{ kind: "approved-request" }, { kind: "code-review-report" }, { kind: "investigate-checkpoint" }])];
  const rs = await evalP(raw, "spawn", spy().ev);
  const spawnText = cp.describePolicyRefusal(rs.blocking[0], { phase: "spawn", taskId: task.id });
  check("(E4) spawn refusal names the policy name and id", spawnText.includes("Name p9") && spawnText.includes("p9"));
  check("(E4) spawn refusal names the requirement (owner-authorized permission Request)", /owner-authorized permission Request/.test(spawnText));
  check("(E4) spawn refusal names BOTH remedies: permission Request AND the waiver", /permission Request linked to this card/.test(spawnText) && /waiver/.test(spawnText));
  check("(E4) spawn refusal says agents cannot waive", /agents cannot waive/.test(spawnText));
  const rm = await evalP(raw, "merge", spy().ev);
  const rev = rm.blocking.find((v) => v.kind === "code-review-report");
  const mergeText = cp.describePolicyRefusal(rev, { phase: "merge", taskId: task.id });
  check("(E4) merge refusal names the review remedy with the card id and the waiver", mergeText.includes(`reviewOfTaskId='${task.id}'`) && /waiver/.test(mergeText));
  check("(E4) merge refusal carries the evidence detail (what was found)", /no review/.test(mergeText));
  const unread = (await evalP(raw, "merge", spy({ codeReview: () => { throw new Error("boom"); } }).ev)).blocking.find((v) => v.kind === "code-review-report");
  check("(E4) an UNREADABLE refusal still names the waiver remedy (never wedges the owner)", /waiver/.test(cp.describePolicyRefusal(unread, { phase: "merge", taskId: task.id })) && /Could not verify: .*boom/.test(cp.describePolicyRefusal(unread, { phase: "merge", taskId: task.id })));
  const cfg = (await evalP("garbage", "spawn", spy().ev)).blocking[0];
  check("(E4) config-unreadable refusal says to fix it in Settings", /Settings/.test(cp.describePolicyRefusal(cfg, { phase: "spawn", taskId: task.id })));
}

// ── (E5) dbPolicyEvidence: the permission-only affirmative ──────────────────────────────────────────────────────────
{
  const mk = (rows) => cp.dbPolicyEvidence({ listQuestionsForTask: () => rows, listCardPolicyWaivers: () => [] }, "proj");
  const q = (o) => ({ type: "permission", state: "answered", chosenOption: "authorize", answeredVia: "human", ...o });
  const yes = (rows) => mk(rows).authorizedPermissionRequest("t").met;
  check("(E5) permission+answered+authorize counts", yes([q({})]) === true);
  check("(E5) permission+consumed+authorize counts", yes([q({ state: "consumed" })]) === true);
  check("(E5) an authorize answer NOT stamped by the human route (agent path, answeredVia null) does NOT count", yes([q({ answeredVia: null })]) === false);
  check("(E5) a pre-field row (answeredVia absent) does NOT count (fail closed)", yes([(({ answeredVia, ...r }) => r)(q({}))]) === false);
  check("(E5) an authorize answer on an ssh_exec hold (reserved permissionAction prefix) does NOT count", yes([q({ permissionAction: "ssh_exec connection=c1 command=ls" })]) === false);
  check("(E5) an authorize answer with an ordinary permissionAction still counts", yes([q({ permissionAction: "deploy it" })]) === true);
  check("(E5) permission+answered+DENY does NOT count", yes([q({ chosenOption: "deny" })]) === false);
  check("(E5) permission still PENDING does NOT count", yes([q({ state: "pending", chosenOption: null })]) === false);
  check("(E5) permission CANCELLED does NOT count", yes([q({ state: "cancelled" })]) === false);
  check("(E5) an answered DECISION Request with an option string does NOT count (a 'reject' option must not pass)", yes([q({ type: "decision", chosenOption: "authorize" })]) === false && yes([q({ type: "decision", chosenOption: "reject" })]) === false);
  check("(E5) an answered INPUT Request does NOT count", yes([q({ type: "input", chosenOption: null })]) === false);
  check("(E5) a NOTICE does NOT count", yes([q({ type: "notice", state: "notice" })]) === false);
  const withExp = (iso) => yes([q({ decidedExpiresAt: iso })]);
  check("(E5) a grant whose decided expiry has LAPSED does NOT count", withExp(new Date(Date.now() - 60_000).toISOString()) === false);
  check("(E5) a grant whose decided expiry is still in the future counts", withExp(new Date(Date.now() + 3_600_000).toISOString()) === true);
  check("(E5) a grant whose decided expiry is exactly NOW is NOT lapsed (the shared isPermissionLapsed edge: lapsed only when t < now)", (() => { const nowMs = 1_700_000_000_000; const ev = cp.dbPolicyEvidence({ listQuestionsForTask: () => [q({ decidedExpiresAt: new Date(nowMs).toISOString() })], listCardPolicyWaivers: () => [] }, "proj", () => nowMs); return ev.authorizedPermissionRequest("t").met === true; })());
  check("(E5) a grant with no expiry (null) counts — 'once' is NOT consumed by a spawn", withExp(null) === true);
  check("(E5) an unparseable decided expiry fails closed (does not count)", withExp("not-a-date") === false);
  const wv = cp.dbPolicyEvidence({ listQuestionsForTask: () => [], listCardPolicyWaivers: () => [{ policyId: "p1", requirementKind: "code-review-report" }] }, "proj");
  check("(E5) waived() matches exactly (policy, kind) — not another kind of the same policy", wv.waived("t", "p1", "code-review-report") === true && wv.waived("t", "p1", "approved-request") === false && wv.waived("t", "p2", "code-review-report") === false);
}

// ── (E6) selector: a non-matching policy is never evaluated ─────────────────────────────────────────────────────────
{
  const { ev, calls } = spy();
  const r = await evalP([pol("fix-only", [{ kind: "code-review-report" }], { types: ["fix"] })], "merge", ev);
  check("(E6) a policy that does not match the card yields no verdict and no reads", r.verdicts.length === 0 && calls.review === 0);
  const byId = await evalP([pol("byid", [{ kind: "code-review-report" }], { cardIds: ["abcdef01"] })], "merge", spy().ev);
  check("(E6) cardIds (8-char prefix) match opts a card in regardless of type", byId.blocking.length === 1);
}

// ── (E7) kickoff helpers ────────────────────────────────────────────────────────────────────────────────────────
{
  const on = await evalP([pol("c", [{ kind: "investigate-checkpoint" }])], "spawn", spy().ev);
  check("(E7) an unwaived investigate-checkpoint activates the kickoff paragraph", cp.hasActiveInvestigateCheckpoint(on) === true);
  const off = await evalP([pol("c", [{ kind: "investigate-checkpoint" }])], "spawn", spy({ waived: () => true }).ev);
  check("(E7) a waived investigate-checkpoint does NOT", cp.hasActiveInvestigateCheckpoint(off) === false);
  check("(E7) the fixed paragraph tells the worker to report blocked/progress and STOP", /worker_report/.test(cp.INVESTIGATE_CHECKPOINT_KICKOFF_PARAGRAPH) && /STOP/.test(cp.INVESTIGATE_CHECKPOINT_KICKOFF_PARAGRAPH));
}

// ── (E8) sticky matching: the UNION of the live title match and the recorded ids ─────────────────────────────────────
{
  const retitled = { id: "abcdef0123456789", title: "just prose now" };
  const run = (sticky, raw = [pol("p1", [{ kind: "code-review-report" }])]) => { const { ev } = spy(); return cp.evaluateCardPolicies({ rawPolicies: raw, task: retitled, phase: "merge", evidence: ev, ...(sticky ? { stickyPolicyIds: sticky } : {}) }); };
  check("(E8) CONTROL: a retitled card with NO recorded ids matches nothing", (await run(undefined)).verdicts.length === 0);
  check("(E8) a recorded id keeps the policy applying after the retitle (blocking, unmet)", (await run(new Set(["p1"]))).blocking.length === 1);
  check("(E8) a recorded id whose policy no longer exists is ignored", (await run(new Set(["gone"]))).verdicts.length === 0);
  check("(E8) recorded ids do not pull in OTHER configured policies", (await run(new Set(["p1"]), [pol("p1", [{ kind: "code-review-report" }]), pol("p2", [{ kind: "investigate-checkpoint" }])])).verdicts.every((v) => v.policyId === "p1"));
  const { ev: wev } = spy({ waived: () => true });
  const w = await cp.evaluateCardPolicies({ rawPolicies: [pol("p1", [{ kind: "code-review-report" }])], task: retitled, phase: "merge", evidence: wev, stickyPolicyIds: new Set(["p1"]) });
  check("(E8) the waiver still clears a sticky-matched requirement", w.blocking.length === 0 && w.verdicts[0]?.status === "waived");
}

console.log(failures === 0 ? "\n✅ ALL PASS — card-policy evaluator" : `\n${failures} check(s) FAILED.`);
await finishAndExit(failures === 0 ? 0 : 1);
