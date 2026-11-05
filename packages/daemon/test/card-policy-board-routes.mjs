import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 61d32daf — the board UI's daemon half, driven through the real gateway with app.inject (no listener, no daemon):
//  (R) the human config PATCH resolves every written `cardPolicies[].match.cardIds` entry to the full id of ONE card on
//      THIS project, refusing an unknown or ambiguous entry (the 78a9ae1c review's plan deviation), and leaves a PATCH
//      that does not write the list alone;
//  (G) GET /api/tasks/:id/policy and GET /api/projects/:id/card-policy-status render the SAME view tasks_get carries
//      (one evaluator), with the badge count = unmet + unreadable, and nothing at all for a project with no policy.
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";
useOwnLoomHome("cpb-");
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
const patch = (config) => app.inject({ method: "PATCH", url: `/api/projects/${e.projId}/config`, payload: { config } });
const stored = () => e.db.getProject(e.projId).config.orchestration?.cardPolicies;
const withCards = (cardIds) => [policy({ id: "pc", match: { cardIds }, require: [{ kind: "approved-request" }] })];

// Ids are `cpf-t-<label>-<sfx>`: labels "alpha" and "alpine" share the prefix "cpf-t-alp", so it is AMBIGUOUS, while
// "cpf-t-alph" names exactly one card.
const alpha = e.addTask("alpha", "chore(cpf): alpha");
const alpine = e.addTask("alpine", "chore(cpf): alpine");
const featCard = e.addTask("feat1", "feat(cpf): one");
const plainCard = e.addTask("plain", "docs(cpf): unrelated");

// A SECOND project with its own card: its id must never resolve from the first project's PATCH.
const otherProj = `cpb-other-${e.sfx}`;
e.db.insertProject({ id: otherProj, name: "Other", repoPath: e.repo, vaultPath: e.repo, config: {}, createdAt: e.now, archivedAt: null });
const foreign = `cpb-foreign-${e.sfx}`;
e.db.insertTask({ id: foreign, projectId: otherProj, title: "feat(x): foreign", body: "", columnKey: "in_progress", position: 1, createdAt: e.now, updatedAt: e.now });

// ── (R) cardIds resolution on write ──────────────────────────────────────────────────────────────────────
{
  const r = await patch({ orchestration: { cardPolicies: withCards(["cpf-t-alph"]) } });
  check("(R1) an unambiguous 8+-char prefix is accepted => 200", r.statusCode === 200);
  check("(R1) ...and STORED as the card's full id, not the prefix", JSON.stringify(stored()?.[0]?.match?.cardIds) === JSON.stringify([alpha]));

  const before = JSON.stringify(stored());
  const amb = await patch({ orchestration: { cardPolicies: withCards(["cpf-t-alp"]) } });
  check("(R2) an ambiguous prefix => 400 naming it and BOTH matching cards", amb.statusCode === 400 && /ambiguous/.test(amb.json().error ?? "") && (amb.json().error ?? "").includes(alpha) && (amb.json().error ?? "").includes(alpine));
  check("(R2) ...and nothing was stored", JSON.stringify(stored()) === before);

  const unk = await patch({ orchestration: { cardPolicies: withCards(["deadbeef-0000"]) } });
  check("(R3) an id matching no card => 400 'matches no card', nothing stored", unk.statusCode === 400 && /matches no card/.test(unk.json().error ?? "") && JSON.stringify(stored()) === before);

  const fr = await patch({ orchestration: { cardPolicies: withCards([foreign]) } });
  check("(R4) a card on ANOTHER project's board never resolves (even by its exact full id) => 400", fr.statusCode === 400 && /matches no card/.test(fr.json().error ?? "") && JSON.stringify(stored()) === before);

  const dup = await patch({ orchestration: { cardPolicies: withCards([alpha, "cpf-t-alph", alpine]) } });
  check("(R5) full ids pass through and two entries naming the same card collapse to one", dup.statusCode === 200 && JSON.stringify(stored()?.[0]?.match?.cardIds) === JSON.stringify([alpha, alpine]));

  // A list stored by some other path with a now-unknown id: a PATCH that does not WRITE cardPolicies is untouched.
  e.setPolicies(withCards(["zzzzzzzz-gone"]));
  const other = await patch({ orchestration: { maxConcurrentWorkers: 7 } });
  check("(R6) a PATCH that does not write cardPolicies is not refused by a stale stored entry", other.statusCode === 200 && stored()?.[0]?.match?.cardIds?.[0] === "zzzzzzzz-gone");

  const typesOnly = await patch({ orchestration: { cardPolicies: [policy({ id: "pt", match: { types: ["feat"] }, require: [{ kind: "approved-request" }] })] } });
  check("(R7) a list with no cardIds at all is stored as written", typesOnly.statusCode === 200 && JSON.stringify(stored()) === JSON.stringify([{ id: "pt", name: "Feat policy", match: { types: ["feat"] }, require: [{ kind: "approved-request" }] }]));
}

// ── (G) the two read routes ──────────────────────────────────────────────────────────────────────────────
{
  const getPolicy = (id) => app.inject({ method: "GET", url: `/api/tasks/${id}/policy` });
  const getStatus = (pid = e.projId) => app.inject({ method: "GET", url: `/api/projects/${pid}/card-policy-status` });

  e.setPolicies([policy({ id: "pf", name: "Feat gate", match: { types: ["feat"] }, require: [{ kind: "approved-request" }, { kind: "code-review-report" }] })]);
  const g = await getPolicy(featCard);
  const mcpView = (await getProjectTask(e.db, e.projId, featCard)).policy;
  check("(G1) GET /api/tasks/:id/policy => 200 with the SAME rows tasks_get carries", g.statusCode === 200 && JSON.stringify(g.json().policy) === JSON.stringify(mcpView));
  check("(G1) ...approved-request unmet, code review deferred to merge", g.json().policy?.find((r) => r.requirement === "approved-request")?.status === "unmet" && g.json().policy?.find((r) => r.requirement === "code-review-report")?.status === "deferred");
  check("(G1) a card no policy applies to => {policy: []}", JSON.stringify((await getPolicy(plainCard)).json()) === JSON.stringify({ policy: [] }));
  check("(G1) unknown task => 404", (await getPolicy("nope")).statusCode === 404);

  const s = (await getStatus()).json().tasks;
  check("(G2) status lists the matching card with blocking = unmet + unreadable (1) and total = its rows (2)", s?.[featCard]?.blocking === 1 && s?.[featCard]?.total === 2);
  check("(G2) ...and omits every card no policy applies to", !(plainCard in s) && !(alpha in s) && !(alpine in s));
  check("(G2) unknown project => 404", (await getStatus("nope")).statusCode === 404);

  const w = await app.inject({ method: "POST", url: `/api/tasks/${featCard}/policy-waivers`, payload: { policyId: "pf", requirement: "approved-request", reason: "owner ok" } });
  const afterWaive = (await getStatus()).json().tasks?.[featCard];
  check("(G3) after a waiver the card's blocking count drops to 0 (total unchanged)", w.statusCode === 200 && afterWaive?.blocking === 0 && afterWaive?.total === 2);
  check("(G3) ...and the drawer read shows the requirement `waived`", (await getPolicy(featCard)).json().policy?.find((r) => r.requirement === "approved-request")?.status === "waived");

  e.setPolicies("not-a-list");
  const unreadable = (await getStatus()).json().tasks;
  check("(G4) an unreadable stored list fails closed: EVERY card shows one blocking row", [alpha, alpine, featCard, plainCard].every((id) => unreadable?.[id]?.blocking === 1));

  e.setPolicies([]);
  check("(G5) an empty list => {tasks: {}}", JSON.stringify((await getStatus()).json()) === JSON.stringify({ tasks: {} }));
  check("(G5) a project with no list at all => {tasks: {}}", JSON.stringify((await getStatus(otherProj)).json()) === JSON.stringify({ tasks: {} }));
}

// ── (B) the batched status route equals per-card taskPolicyView ───────────────────────────────────────────
{
  const { taskPolicyView } = await import("../dist/mcp/tasks.js");
  const getStatus = () => app.inject({ method: "GET", url: `/api/projects/${e.projId}/card-policy-status` });
  const matched = e.addTask("bm", "feat(cpf): matched");
  const unmatched = e.addTask("bu", "docs(cpf): unmatched");
  const stickyOnly = e.addTask("bs", "docs(cpf): sticky only");
  const idOnly = e.addTask("bi", "docs(cpf): id only");
  const waivedCard = e.addTask("bw", "feat(cpf): waived");
  const bare = e.addTask("bb", "bare prose title");
  e.setPolicies([
    policy({ id: "bf", name: "Feat", match: { types: ["feat"] }, require: [{ kind: "approved-request" }, { kind: "code-review-report" }] }),
    policy({ id: "bs", name: "Sticky", match: { types: ["perf"] }, require: [{ kind: "approved-request" }] }),
    policy({ id: "bi", name: "Ids", match: { cardIds: [idOnly] }, require: [{ kind: "approved-request" }] }),
  ]);
  e.db.recordCardPolicyMatches(stickyOnly, e.projId, ["bs"]); // matched once, since retitled out of the selector
  e.db.recordCardPolicyMatches(unmatched, e.projId, ["gone-policy"]); // a sticky id naming a deleted policy applies to nothing
  const w = await app.inject({ method: "POST", url: `/api/tasks/${waivedCard}/policy-waivers`, payload: { policyId: "bf", requirement: "approved-request", reason: "ok" } });
  check("(B0) fixture waiver recorded", w.statusCode === 200);

  const batched = (await getStatus()).json().tasks;
  let equal = true, evaluated = 0;
  for (const t of e.db.listTasks(e.projId)) {
    const view = await taskPolicyView(e.db, e.projId, t);
    const got = batched[t.id];
    const want = view ? { blocking: view.filter((r) => r.status === "unmet" || r.status === "unreadable").length, total: view.length } : undefined;
    if (JSON.stringify(got) !== JSON.stringify(want)) { equal = false; console.log("   MISMATCH", t.id, JSON.stringify(got), JSON.stringify(want)); }
    if (want) evaluated++;
  }
  check("(B1) every card's batched entry equals taskPolicyView's (present iff a view exists, same blocking/total)", equal);
  check("(B2) the fixture exercised matched, sticky-only, cardIds-only and waived cards (plus earlier feat cards) and omitted the rest", evaluated >= 4 && [matched, stickyOnly, idOnly, waivedCard].every((id) => id in batched) && !(unmatched in batched) && !(bare in batched));
  check("(B3) sticky-only card is counted (retitled out of its selector)", batched[stickyOnly]?.blocking === 1);
  check("(B4) waived requirement is not blocking, total unchanged", batched[waivedCard]?.blocking === 0 && batched[waivedCard]?.total === 2 && batched[matched]?.blocking === 1);
}

// ── (S) a deleted card's exact id already stored for that policy does not block later saves ──────────────
{
  const gone = e.addTask("gone", "chore(cpf): will be deleted");
  const keep = e.addTask("keep", "chore(cpf): stays");
  const ok = await patch({ orchestration: { cardPolicies: withCards([gone, keep]) } });
  check("(S0) both ids stored while both cards exist", ok.statusCode === 200 && stored()?.[0]?.match?.cardIds?.length === 2);
  e.db.deleteTask(gone);
  const again = await patch({ orchestration: { cardPolicies: withCards([gone, keep]) } });
  check("(S1) re-saving the whole list with the since-deleted exact id => 200 and it is kept", again.statusCode === 200 && JSON.stringify(stored()?.[0]?.match?.cardIds) === JSON.stringify([gone, keep]));
  const newUnknown = await patch({ orchestration: { cardPolicies: withCards([gone, keep, "feedface-0000-dead"]) } });
  check("(S2) a NEW unknown id beside it is still refused", newUnknown.statusCode === 400 && /matches no card/.test(newUnknown.json().error ?? ""));
  const prefixOfGone = await patch({ orchestration: { cardPolicies: withCards([gone.slice(0, 10)]) } });
  check("(S3) a PREFIX of the deleted id is not accepted (only the exact stored full id)", prefixOfGone.statusCode === 400);
  const otherPolicy = await patch({ orchestration: { cardPolicies: [policy({ id: "other-pol", match: { cardIds: [gone] }, require: [{ kind: "approved-request" }] })] } });
  check("(S4) the same id under a DIFFERENT policy id is not covered by the first policy's stored entry", otherPolicy.statusCode === 400);
}

// ── (C) project CREATE refuses cardIds (a new project has no cards), on both human POST routes ─────────────
{
  const { mkdtempManaged } = await import("./_tmp-fixture.mjs");
  const { execSync } = await import("node:child_process");
  const mkRepo = (p) => { const d = mkdtempManaged(p); execSync("git init -q", { cwd: d }); return d; };
  const cfg = { orchestration: { cardPolicies: withCards(["cpf-t-alph"]) } };
  const before = e.db.listProjects().length;
  const a = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "cpc-a", repoPath: mkRepo("cpc-a-"), config: cfg } });
  check("(C1) POST /api/projects with a cardIds prefix => 400 'matches no card'", a.statusCode === 400 && /matches no card/.test(a.json().error ?? ""));
  const b = await app.inject({ method: "POST", url: "/api/setup/project-init", payload: { name: `cpc-init-${e.sfx}`, config: cfg } });
  check("(C2) POST /api/setup/project-init with a cardIds prefix => 400 'matches no card'", b.statusCode === 400 && /matches no card/.test(b.json().error ?? ""));
  check("(C3) neither route created a project", e.db.listProjects().length === before);
  const okCreate = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "cpc-ok", repoPath: mkRepo("cpc-ok-"), config: { orchestration: { cardPolicies: [policy({ id: "ty", match: { types: ["feat"] }, require: [{ kind: "approved-request" }] })] } } } });
  check("(C4) a create whose policies carry no cardIds still succeeds", okCreate.statusCode === 200 || okCreate.statusCode === 201);
}

await app.close();
closeAll();
console.log(failures === 0 ? "\n✅ ALL PASS — card-policy board routes" : `\n${failures} check(s) FAILED.`);
await finishAndExit(failures === 0 ? 0 : 1);
