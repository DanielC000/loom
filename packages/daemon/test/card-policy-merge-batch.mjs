import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9623e943 — card policies inside merge_batch (mergeBatchTracked). REAL git, a real fast gate command, no claude.
//   (B) 3 candidates, ONE policy-blocked: the batch lands ONLY the two unblocked batchmates; the blocked one is
//       reported started:false with the policy refusal, is NEVER solo-fallback-confirmed (no pending op minted
//       for it, nothing of its landed); after its evidence is satisfied the SAME ids re-call lands it
//       (the refusal was not cached).
//   (F) the < 2 eligible path (one blocked + one good): the good one still lands via the solo path, the blocked one
//       is reported started:false and NOT landed. The landing assertions hold with the batch-level skip removed
//       (the tracked precheck / confirmWorkerMerge backstop each independently refuse) — the mutants run against
//       this file prove which layer is which.
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { waitUntil } from "./_wait.mjs";
useOwnLoomHome("cpmb-");
requireHermeticEnv();

const { makeEnv, closeAll } = await import("./_card-policy-fixture.mjs");
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const REVIEW = { kind: "code-review-report" };
const onlyCard = (taskId) => [{ id: "pc", name: "Blocked card policy", match: { cardIds: [taskId] }, require: [REVIEW] }];

// Settle a batch whichever way it returns (sync fast path, or the documented async degrade + cache recovery).
async function runBatch(e, ids) {
  const r = await e.sessions.mergeBatchTracked(e.mgrId, ids);
  if (r.settled) return r.ok ? r.value : undefined;
  await waitUntil(() => e.sessions.gateStatus(r.op.opId).state === "settled", { timeoutMs: 120_000, label: "batch op to settle" });
  const again = await e.sessions.mergeBatchTracked(e.mgrId, ids);
  return again.settled && again.ok ? again.value : undefined;
}

// ════════════════════════════════════ (B) 3 candidates, one blocked ════════════════════════════════════
{
  const e = await makeEnv({ syncAttachBudgetMs: 240_000 });
  const a = await e.makeWorker("a"), b = await e.makeWorker("b"), c = await e.makeWorker("c");
  e.setPolicies(onlyCard(c.taskId));
  const res = await runBatch(e, [a.workerId, b.workerId, c.workerId]);
  check("(B1) the batch ran and returned a result", !!res);
  check("(B2) the two UNBLOCKED batchmates landed", e.landed("a.txt") && e.landed("b.txt"));
  check("(B2) landed list is exactly the two batchmates (the blocked candidate is not in it)", res?.landed?.length === 2 && !res.landed.some((l) => l.branch === c.branch));
  check("(B3) the blocked candidate did NOT land", !e.landed("c.txt"));
  const fb = res?.fallback?.find((f) => f.workerSessionId === c.workerId);
  check("(B4) the blocked candidate is reported in `fallback` with started:false", fb?.started === false);
  check("(B4) its reason is the policy refusal (names the policy and the waiver)", /Blocked card policy/.test(fb?.reason ?? "") && /waiver/.test(fb?.reason ?? ""));
  check("(B5) the blocked candidate was NEVER solo-fallback-confirmed: no pending/retained merge op for it", e.sessions.peekPendingMerge(c.workerId) === undefined);
  check("(B5) the batchmates produced no fallback entries of their own", !(res?.fallback ?? []).some((f) => f.workerSessionId === a.workerId || f.workerSessionId === b.workerId));
  // satisfy the policy for c (a done review at its current tip) and re-confirm it solo: not a cached refusal
  e.fileReview({ taskId: c.taskId, baseSha: c.tip() });
  const r = await e.sessions.confirmWorkerMergeTracked(e.mgrId, c.workerId);
  check("(B6) once its review exists, the blocked candidate lands solo (the batch refusal left nothing cached)", r.settled && r.ok && r.value.merged === true && e.landed("c.txt"));
  closeAll();
}

// ════════════════════════════════════ (F) the < 2 eligible path ════════════════════════════════════
{
  const e = await makeEnv({ syncAttachBudgetMs: 240_000 });
  const x = await e.makeWorker("x"), y = await e.makeWorker("y");
  e.setPolicies(onlyCard(x.taskId));
  const res = await runBatch(e, [x.workerId, y.workerId]);
  check("(F1) the good candidate landed via the solo path", e.landed("y.txt"));
  check("(F2) the blocked candidate did NOT land (no layer let it through)", !e.landed("x.txt"));
  const fx = res?.fallback?.find((f) => f.workerSessionId === x.workerId);
  check("(F3) the blocked candidate is reported started:false with the policy refusal text (batch-level skip)", fx?.started === false && /Blocked card policy/.test(fx?.reason ?? ""));
  check("(F4) the blocked candidate has no pending/retained merge op (never reached the tracked solo path)", e.sessions.peekPendingMerge(x.workerId) === undefined);
  closeAll();
}

// ════════════════════════════════════ (G) a card dragged to the terminal column is not exempt ════════════════════════════════════
{
  const e = await makeEnv({ syncAttachBudgetMs: 240_000 });
  const x = await e.makeWorker("gx"), y = await e.makeWorker("gy");
  e.setPolicies(onlyCard(x.taskId));
  e.db.updateTask(x.taskId, { columnKey: "done" }); // terminal column, but NOT landed (no mergedSha)
  const res = await runBatch(e, [x.workerId, y.workerId]);
  check("(G1) the terminal-column candidate with no review did NOT land", !e.landed("gx.txt"));
  const fx = res?.fallback?.find((f) => f.workerSessionId === x.workerId);
  check("(G2) it is reported started:false with the policy refusal (column is not proof of landing)", fx?.started === false && /Blocked card policy/.test(fx?.reason ?? ""));
  check("(G3) its unblocked batchmate still landed", e.landed("gy.txt"));
  closeAll();
}

// ════════════════════════════════════ (J) a retitled card is still held to its policy (sticky match) ═══════════════
{
  const e = await makeEnv({ syncAttachBudgetMs: 240_000 });
  const x = await e.makeWorker("jx"), y = await e.makeWorker("jy", { title: "fix(cpf): jy never matched" });
  e.setPolicies([{ id: "pt", name: "Blocked card policy", match: { types: ["feat"] }, require: [REVIEW] }]);
  e.db.updateTask(x.taskId, { title: "retitled to bare prose" }); // a policy exists NOW, so the title write records the OLD feat title's match before the new title applies
  const res = await runBatch(e, [x.workerId, y.workerId]);
  check("(J1) the retitled card did NOT land without a review", !e.landed("jx.txt"));
  const fx = res?.fallback?.find((f) => f.workerSessionId === x.workerId);
  check("(J2) it is reported started:false with the policy refusal", fx?.started === false && /Blocked card policy/.test(fx?.reason ?? ""));
  check("(J3) the never-matching batchmate still landed", e.landed("jy.txt"));
  closeAll();
}

// ════════════════════════════════════ (H) a once-landed card's NEW worker is not exempt (sticky mergedSha) ═══════════
{
  const e = await makeEnv({ syncAttachBudgetMs: 240_000 });
  const x = await e.makeWorker("hx"), y = await e.makeWorker("hy");
  e.setPolicies(onlyCard(x.taskId));
  e.db.updateTask(x.taskId, { mergedSha: "abc1234def", columnKey: "in_progress" }); // landed once before, moved back out of done
  const res = await runBatch(e, [x.workerId, y.workerId]);
  check("(H1) a NEW worker on a card with a sticky mergedSha and no review did NOT land", !e.landed("hx.txt"));
  const fx = res?.fallback?.find((f) => f.workerSessionId === x.workerId);
  check("(H2) it is reported started:false with the policy refusal", fx?.started === false && /Blocked card policy/.test(fx?.reason ?? ""));
  check("(H3) its unblocked batchmate still landed", e.landed("hy.txt"));
  closeAll();
}

console.log(failures === 0 ? "\n✅ ALL PASS — card-policy merge_batch" : `\n${failures} check(s) FAILED.`);
await finishAndExit(failures === 0 ? 0 : 1);
