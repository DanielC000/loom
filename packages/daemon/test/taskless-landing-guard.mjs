import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a880c391 — the human-only `orchestration.tasklessGuardedPaths` guard: a TASKLESS worker has no card, so no card policy can
// match it; with a non-empty guard list, the shared `mergePolicyRefusal` refuses a taskless landing whose changed-path set (branch
// tip vs merge-base with the mainline, both sides of a rename) matches a guard glob. REAL git on a temp repo, a real fast gate
// command, stub ptys, no claude, no daemon.
//   (A) default / empty list: a taskless worker lands (byte-identical); zero guard work.
//   (B) solo confirm: a guarded path refuses (names the path + the re-spawn-on-a-card remedy, mints NO op, not cached); an
//       unguarded path lands; matching is case-INSENSITIVE; a rename INTO or OUT OF a guarded path refuses; clearing the list lets
//       the SAME worker land (read live); a TASKED worker touching the same path is unaffected.
//   (C) fail CLOSED: a corrupt stored value, and an unreadable changed-path set, each refuse.
//   (D) merge_batch: a guarded taskless candidate is dropped (started:false + the refusal), never solo-fallback-confirmed;
//       its unguarded batchmate lands.
//   (F) fix round: a same-named TAG cannot shadow the branch (tip resolved via resolveBranchTip), the already-landed exemption, no false
//       refusal after main moved, a corrupt watermark fails closed, a review spawn is covered, and the remedy text.
//   (E) human-only trust boundary: the human validator accepts it, the agent validator / project_update (manager) / elevated Lead
//       project_configure refuse it (set AND unset), and a bad glob is rejected at write time.
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { waitUntil } from "./_wait.mjs";
useOwnLoomHome("tlg-");
requireHermeticEnv();

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
const { makeEnv, closeAll, GIT_ID } = await import("./_card-policy-fixture.mjs");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { parseTasklessGuardedPaths, TASKLESS_GUARDED_PATHS_LIMITS, resolveConfig } = await import("@loom/shared");
const { PlatformMcpRouter, validateProjectConfigOverride, validateAgentProjectConfigOverride, HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GATE = 'node -e "process.exit(0)"';
const cfg = (guard) => ({ orchestration: { gateCommand: GATE, maxConcurrentWorkers: 50, ...(guard !== undefined ? { tasklessGuardedPaths: guard } : {}) } });
const sh = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8" }).trim();
const put = (root, rel, body) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };

/** A worktree/branch cut from the repo's current HEAD, `edit(worktreePath)` applied, committed, and an exited worker row
 *  bound to NO card (or to `taskId` when given). `tipRef` is the branch name. */
async function makeWorker(e, label, edit, { taskId = null, branch: forceBranch, reviewOfTaskId } = {}) {
  const cutBaseSha = sh(e.repo, "rev-parse HEAD");
  const { worktreePath, branch } = await createWorktree(e.repo, e.projId, taskId ?? `tlg-key-${label}-${e.sfx}`);
  edit(worktreePath);
  commitAll(worktreePath, `feat(tlg): ${label}`, GIT_ID);
  const workerId = `tlg-w-${label}-${e.sfx}`;
  e.db.insertSession({ id: workerId, projectId: e.projId, agentId: e.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: e.now, lastActivity: e.now, lastError: null, role: "worker", parentSessionId: e.mgrId, taskId, worktreePath, branch: forceBranch ?? branch, cutBaseSha, ...(reviewOfTaskId ? { reviewOfTaskId } : {}) });
  return { workerId, worktreePath, branch };
}
const confirm = async (e, w) => { const r = await e.sessions.confirmWorkerMergeTracked(e.mgrId, w.workerId); return r.settled && r.ok ? r.value : undefined; };
async function runBatch(e, ids) {
  const r = await e.sessions.mergeBatchTracked(e.mgrId, ids);
  if (r.settled) return r.ok ? r.value : undefined;
  await waitUntil(() => e.sessions.gateStatus(r.op.opId).state === "settled", { timeoutMs: 120_000, label: "batch op to settle" });
  const again = await e.sessions.mergeBatchTracked(e.mgrId, ids);
  return again.settled && again.ok ? again.value : undefined;
}

// ════════════════════════════════════ (A) default: no guard ════════════════════════════════════
{
  const e = await makeEnv({ syncAttachBudgetMs: 240_000 });
  e.db.setProjectConfig(e.projId, cfg());
  const w = await makeWorker(e, "a1", (d) => put(d, "docs/a1.md", "x\n"));
  check("(A1) no key: mergePolicyRefusal(taskless) is null", (await e.sessions.mergePolicyRefusal(w.workerId)) === null);
  const r = await confirm(e, w);
  check("(A1) no key: the taskless worker lands (byte-identical to before)", r?.merged === true && e.landed("docs/a1.md"));
  e.db.setProjectConfig(e.projId, cfg([]));
  const w2 = await makeWorker(e, "a2", (d) => put(d, "docs/a2.md", "x\n"));
  check("(A2) empty list: mergePolicyRefusal is null and it lands", (await e.sessions.mergePolicyRefusal(w2.workerId)) === null && (await confirm(e, w2))?.merged === true && e.landed("docs/a2.md"));
  closeAll();
}

// ════════════════════════════════════ (B) solo confirm ════════════════════════════════════
{
  const e = await makeEnv({ syncAttachBudgetMs: 240_000 });
  put(e.repo, "docs/old.txt", "old\n"); put(e.repo, "keep/mv.txt", "mv\n");
  commitAll(e.repo, "chore(tlg): seed", GIT_ID);
  e.db.setProjectConfig(e.projId, cfg(["docs/**", "Secret/**"]));

  const g = await makeWorker(e, "b1", (d) => put(d, "docs/b1.md", "x\n"));
  const rg = await confirm(e, g);
  check("(B1) a taskless worker touching a guarded path is REFUSED (merged:false), nothing landed", rg?.merged === false && !e.landed("docs/b1.md"));
  check("(B1) the refusal names the matched path and the re-spawn-on-a-card remedy, and cites no card id", /docs\/b1\.md/.test(rg?.reason ?? "") && /re-spawn the work on a card/.test(rg?.reason ?? "") && !/\bcard [0-9a-f]{8}\b/i.test(rg?.reason ?? ""));
  check("(B1) it carries a policyRefusal tag and mints NO op / caches nothing", rg?.policyRefusal?.requirement === "taskless-guarded-paths" && e.sessions.peekPendingMerge(g.workerId) === undefined);

  const u = await makeWorker(e, "b2", (d) => put(d, "src/b2.txt", "x\n"));
  check("(B2) an UNGUARDED taskless path lands", (await confirm(e, u))?.merged === true && e.landed("src/b2.txt"));

  // A directory that exists in NO case on the repo: on a case-insensitive host FS a `DOCS/` path would be written into the existing `docs/`
  // dir and git would record the lowercase name, making the case check vacuous. `secret/` vs the guard `Secret/**` genuinely differs in case.
  const c = await makeWorker(e, "b3", (d) => put(d, "secret/b3.md", "x\n"));
  check("(B3) matching is case-INSENSITIVE: secret/b3.md is refused by the guard Secret/**", (await e.sessions.mergePolicyRefusal(c.workerId)) !== null);

  const into = await makeWorker(e, "b4", (d) => sh(d, "mv keep/mv.txt docs/moved-in.txt"));
  const rIn = await e.sessions.mergePolicyRefusal(into.workerId);
  check("(B4) a rename INTO a guarded path is refused", rIn !== null && /docs\/moved-in\.txt/.test(rIn.text));
  const out = await makeWorker(e, "b5", (d) => { fs.mkdirSync(path.join(d, "elsewhere"), { recursive: true }); sh(d, "mv docs/old.txt elsewhere/old.txt"); });
  const rOut = await e.sessions.mergePolicyRefusal(out.workerId);
  check("(B5) a rename OUT OF a guarded path is refused (the OLD side matches)", rOut !== null && /docs\/old\.txt/.test(rOut.text));

  // The refusal is not cached and the list is read live: clearing it lets the SAME worker land.
  e.db.setProjectConfig(e.projId, cfg([]));
  const again = await confirm(e, g);
  check("(B6) after the owner clears the list, the SAME worker lands (read live; the refusal was not cached)", again?.merged === true && e.landed("docs/b1.md"));

  // A TASKED worker touching a guarded path is unaffected (card policies govern it, not this list).
  e.db.setProjectConfig(e.projId, cfg(["docs/**"]));
  const taskId = e.addTask("tk");
  const t = await makeWorker(e, "b7", (d) => put(d, "docs/b7.md", "x\n"), { taskId });
  check("(B7) a TASKED worker touching a guarded path is NOT refused by this guard", (await e.sessions.mergePolicyRefusal(t.workerId)) === null && (await confirm(e, t))?.merged === true && e.landed("docs/b7.md"));
  closeAll();
}

// ════════════════════════════════════ (C) fail closed ════════════════════════════════════
{
  const e = await makeEnv({ syncAttachBudgetMs: 240_000 });
  const w = await makeWorker(e, "c1", (d) => put(d, "src/c1.txt", "x\n"));
  e.db.setProjectConfig(e.projId, cfg("docs/**")); // wrong-typed stored value (a string, not an array)
  const rc = await e.sessions.mergePolicyRefusal(w.workerId);
  check("(C1) a corrupt stored value refuses (fail CLOSED), naming it unreadable", rc !== null && /unreadable/.test(rc.text));
  check("(C1) ...and the corrupt-value worker did not land", (await confirm(e, w))?.merged === false && !e.landed("src/c1.txt"));
  e.db.setProjectConfig(e.projId, cfg(["docs/**"]));
  const bad = await makeWorker(e, "c2", (d) => put(d, "src/c2.txt", "x\n"), { branch: "loom/no-such-branch-tlg" });
  const rb = await e.sessions.mergePolicyRefusal(bad.workerId);
  check("(C2) an unreadable changed-path set refuses (fail CLOSED) even though the diff would not match", rb !== null && /could not be checked/.test(rb.text));
  closeAll();
}

// ════════════════════════════════════ (D) merge_batch ════════════════════════════════════
{
  const e = await makeEnv({ syncAttachBudgetMs: 240_000 });
  e.db.setProjectConfig(e.projId, cfg(["docs/**"]));
  const bad = await makeWorker(e, "d1", (d) => put(d, "docs/d1.md", "x\n"));
  const good = await makeWorker(e, "d2", (d) => put(d, "src/d2.txt", "x\n"));
  const good2 = await makeWorker(e, "d3", (d) => put(d, "src/d3.txt", "x\n"));
  const res = await runBatch(e, [bad.workerId, good.workerId, good2.workerId]);
  check("(D1) the unguarded batchmates landed", e.landed("src/d2.txt") && e.landed("src/d3.txt"));
  check("(D1) the guarded taskless candidate did NOT land", !e.landed("docs/d1.md"));
  const fb = res?.fallback?.find((f) => f.workerSessionId === bad.workerId);
  check("(D2) it is reported started:false with the taskless-guard refusal text", fb?.started === false && /guards these paths against taskless landings/.test(fb?.reason ?? ""));
  check("(D3) it was NEVER solo-fallback-confirmed (no pending/retained merge op)", e.sessions.peekPendingMerge(bad.workerId) === undefined);
  closeAll();
}

// ════════════════════════════════════ (E) human-only trust boundary ════════════════════════════════════
{
  const okv = (r) => r.ok === true;
  check("(E1) human validator ACCEPTS a well-formed list and the empty list", okv(validateProjectConfigOverride({ orchestration: { tasklessGuardedPaths: ["docs/**", "*.lock"] } })) && okv(validateProjectConfigOverride({ orchestration: { tasklessGuardedPaths: [] } })));
  const bads = { "leading slash": ["/docs/**"], "backslash": ["docs\\x"], "dot-dot": ["a/../b"], "empty": [""], "non-string": [1], "padded": [" docs/**"], "not an array": "docs/**" };
  for (const [name, v] of Object.entries(bads)) check(`(E2) human validator REJECTS ${name}`, !okv(validateProjectConfigOverride({ orchestration: { tasklessGuardedPaths: v } })));
  check("(E2) REJECTS more than the entry cap, ACCEPTS exactly the cap (boundary control)",
    !okv(validateProjectConfigOverride({ orchestration: { tasklessGuardedPaths: Array.from({ length: TASKLESS_GUARDED_PATHS_LIMITS.maxEntries + 1 }, (_, i) => `d${i}/**`) } }))
    && okv(validateProjectConfigOverride({ orchestration: { tasklessGuardedPaths: Array.from({ length: TASKLESS_GUARDED_PATHS_LIMITS.maxEntries }, (_, i) => `d${i}/**`) } })));
  check("(E3) AGENT validator REJECTS the key (non-empty and empty)", !okv(validateAgentProjectConfigOverride({ orchestration: { tasklessGuardedPaths: ["docs/**"] } })) && !okv(validateAgentProjectConfigOverride({ orchestration: { tasklessGuardedPaths: [] } })));
  check("(E3) CONTROL: the agent validator still accepts a sibling key", okv(validateAgentProjectConfigOverride({ orchestration: { maxConcurrentWorkers: 2 } })));
  check("(E3) the nested human-only list names it", HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS.includes("orchestration.tasklessGuardedPaths"));
  check("(E4) parse: undefined is ok+empty; resolveConfig default is [] and a corrupt value degrades to [] (enforcement must read the RAW value)",
    (() => { const p = parseTasklessGuardedPaths(undefined); return p.ok && p.paths.length === 0; })()
    && resolveConfig({}).orchestration.tasklessGuardedPaths.length === 0
    && resolveConfig({ orchestration: { tasklessGuardedPaths: "x" } }).orchestration.tasklessGuardedPaths.length === 0);

  const e = await makeEnv();
  const before = JSON.stringify(e.db.getProject(e.projId).config);
  let msg = null;
  try { await e.sessions.updateProjectStructural(e.mgrId, e.projId, { config: { orchestration: { tasklessGuardedPaths: ["docs/**"] } } }); } catch (err) { msg = String(err?.message ?? err); }
  check("(E5) a manager's project_update REFUSES the key and leaves the config unchanged", !!msg && /tasklessGuardedPaths/.test(msg) && JSON.stringify(e.db.getProject(e.projId).config) === before);

  async function callTool(server, name, args) {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "taskless-landing-guard-test", version: "0" });
    await client.connect(clientT);
    const r = await client.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? "";
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }
  const lead = () => new PlatformMcpRouter(e.db, e.sessions).buildServer();
  const s1 = await callTool(lead(), "project_configure", { projectId: e.projId, config: { orchestration: { tasklessGuardedPaths: ["docs/**"] } } });
  check("(E6) elevated Lead project_configure REFUSES setting it", typeof s1.error === "string" && /tasklessGuardedPaths/.test(s1.error));
  e.db.setProjectConfig(e.projId, cfg(["docs/**"]));
  const stored = JSON.stringify(e.db.getProject(e.projId).config);
  const u1 = await callTool(lead(), "project_configure", { projectId: e.projId, config: {}, unset: ["orchestration.tasklessGuardedPaths"] });
  const u2 = await callTool(lead(), "project_configure", { projectId: e.projId, config: { docLint: false }, replace: true });
  check("(E7) Lead unset of it and a replace:true that would drop it are REFUSED, stored config unchanged", typeof u1.error === "string" && typeof u2.error === "string" && JSON.stringify(e.db.getProject(e.projId).config) === stored);
  closeAll();
}

// ════════════════════════════════════ (F) fix round: tip identity, exemption, no false refusal, watermark, review spawn ════════════════════════════════════
{
  const MW = await import("../dist/git/mainline-watch.js");
  const e = await makeEnv({ syncAttachBudgetMs: 240_000 });
  e.db.setProjectConfig(e.projId, cfg(["docs/**"]));

  // (F1) a same-named TAG outranks the branch in git's bare-revision search; the shared .git is worker-writable, so a worker could shadow its
  // own branch with an innocuous tag. The guard must judge the branch's REAL tip (refs/heads, via resolveBranchTip), never the bare name.
  const t = await makeWorker(e, "f1", (d) => put(d, "docs/f1.md", "x\n"));
  sh(e.repo, `tag ${t.branch} ${sh(e.repo, "rev-parse HEAD")}`); // the tag IS the branch's exact name, pointing at an innocuous (empty-diff) commit
  check("(F1) CONTROL: the shadow tag really outranks the branch for a bare range (the attack is real on this git)", sh(e.repo, `rev-parse ${t.branch}`) === sh(e.repo, "rev-parse HEAD") && sh(e.repo, `rev-parse refs/heads/${t.branch}`) !== sh(e.repo, "rev-parse HEAD"));
  const rt = await e.sessions.mergePolicyRefusal(t.workerId);
  check("(F1) a taskless branch touching a guarded path is STILL refused when a same-named tag shadows it", rt !== null && /docs\/f1\.md/.test(rt.text));
  // The batch path with the worktree GONE has no verified pin (verifiedTip is only filled for an existing worktree): the unpinned arm must also hold.
  const rtu = await e.sessions.mergePolicyRefusal(t.workerId, undefined);
  check("(F1) the unpinned call (a batch candidate whose worktree is gone passes no pin) refuses too", rtu !== null && /docs\/f1\.md/.test(rtu.text));
  // A missing branch (no refs/heads) must fail closed even though a same-named tag exists (the tag must never stand in for it).
  const gone = await makeWorker(e, "f1g", (d) => put(d, "src/f1g.txt", "x\n"));
  sh(e.repo, `tag ${gone.branch}-x ${sh(e.repo, "rev-parse HEAD")}`);
  e.db.insertSession({ id: `tlg-w-f1gx-${e.sfx}`, projectId: e.projId, agentId: e.agentId, engineSessionId: null, title: null, cwd: e.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: e.now, lastActivity: e.now, lastError: null, role: "worker", parentSessionId: e.mgrId, taskId: null, worktreePath: e.repo, branch: `${gone.branch}-x`, cutBaseSha: sh(e.repo, "rev-parse HEAD") });
  const rg = await e.sessions.mergePolicyRefusal(`tlg-w-f1gx-${e.sfx}`);
  check("(F1) a worker whose branch ref is absent but a same-named TAG exists is refused (fail closed, the tag is not the branch)", rg !== null && /could not be checked/.test(rg.text));

  // (F2a) an already-landed taskless branch touching a guarded path is NOT refused on an idempotent re-confirm.
  e.db.setProjectConfig(e.projId, cfg([]));
  const l = await makeWorker(e, "f2a", (d) => put(d, "docs/f2a.md", "x\n"));
  check("(F2a) setup: with the guard off the guarded-path worker lands", (await confirm(e, l))?.merged === true && e.landed("docs/f2a.md"));
  e.db.setProjectConfig(e.projId, cfg(["docs/**"]));
  check("(F2a) the guard is now on, and the ALREADY-LANDED worker is not refused (idempotent re-confirm exemption)", (await e.sessions.mergePolicyRefusal(l.workerId)) === null);
  const nl = await makeWorker(e, "f2b", (d) => put(d, "docs/f2b.md", "x\n"));
  check("(F2a) CONTROL: a not-landed worker touching the same guarded path under the same config IS refused", (await e.sessions.mergePolicyRefusal(nl.workerId)) !== null);

  // (F3) no false refusal: main gains a guarded-path commit AFTER the cut; a branch that merged main in, with its OWN changes unguarded, is not refused.
  const stale = await makeWorker(e, "f3", (d) => put(d, "src/f3.txt", "x\n"));
  put(e.repo, "docs/main-side.md", "m\n");
  commitAll(e.repo, "chore(tlg): main gains a guarded path", GIT_ID);
  check("(F3) a branch NOT yet merged with the newer main is not refused (three-dot: only the branch's own changes count)", (await e.sessions.mergePolicyRefusal(stale.workerId)) === null);
  const mainBranch = sh(e.repo, "rev-parse --abbrev-ref HEAD");
  sh(stale.worktreePath, `${GIT_ID} merge ${mainBranch} --no-edit`);
  check("(F3) setup: the branch now contains main's guarded-path commit", sh(stale.worktreePath, "ls-files").split("\n").includes("docs/main-side.md"));
  check("(F3) a branch that merged main in AFTER main gained a guarded-path commit is not refused (its own changes are unguarded)", (await e.sessions.mergePolicyRefusal(stale.workerId)) === null);

  // (F4) a review spawn (reviewOfTaskId, taskId null) with guarded content is refused, as the decision record claims.
  const reviewed = e.addTask("f4rev");
  const rv = await makeWorker(e, "f4", (d) => put(d, "docs/f4.md", "x\n"), { reviewOfTaskId: reviewed });
  check("(F4) setup: the row is a review spawn (taskId null, reviewOfTaskId set)", e.db.getSession(rv.workerId).taskId === null && e.db.getSession(rv.workerId).reviewOfTaskId === reviewed);
  const rr = await e.sessions.mergePolicyRefusal(rv.workerId);
  check("(F4) a review-spawn taskless branch touching a guarded path is refused", rr !== null && rr.requirement === "taskless-guarded-paths" && /docs\/f4\.md/.test(rr.text));

  // (F5) an unreadable mainline watermark fails CLOSED (and the corrupt row is what makes it so: the same worker passes with it removed).
  const wmKey = MW.mainlineWatermarkKey(e.projId, "primary");
  const wmw = await makeWorker(e, "f5", (d) => put(d, "src/f5.txt", "x\n")); // UNGUARDED content: only the watermark can refuse it
  check("(F5) CONTROL: with no watermark stamped, the unguarded worker is not refused", (await e.sessions.mergePolicyRefusal(wmw.workerId)) === null);
  e.db.setMeta(wmKey, "this is not json at all");
  const rw = await e.sessions.mergePolicyRefusal(wmw.workerId);
  check("(F5) a corrupt mainline watermark refuses (fail CLOSED), naming the mainline as unresolved", rw !== null && /could not be checked/.test(rw.text) && /mainline unresolved/.test(rw.text));

  // (F6) refusal remedy text: accurate today (no Settings field exists), bounded, no card id.
  check("(F6) the remedy does not point at Settings, names the project's orchestration config, cites no card id, and stays bounded",
    !/Settings/.test(rt.text) && /orchestration\.tasklessGuardedPaths/.test(rt.text) && !/\bcard [0-9a-f]{8}\b/i.test(rt.text) && rt.text.length < 700);
  closeAll();
}

console.log(failures === 0 ? "\n✅ ALL PASS — taskless-landing guard" : `\n${failures} check(s) FAILED.`);
await finishAndExit(failures === 0 ? 0 : 1);
