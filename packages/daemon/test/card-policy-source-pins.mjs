import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// @decision 9623e943 — class A guard (what each pin protects and why it must not be loosened); the review-round history lives in that record.
// Card 9623e943 — SOURCE-TEXT pins for card-policy enforcement (comment-stripped src/**/*.ts and dist/mcp/*.js
// text; no daemon, no DB, no git). NOT whole-corpus semantics: these are shape pins that make a quiet
// regression loud. Controls: c1 (P1), c2 (P2), c3 (P3), c4 (P4), c5 (P5) each run the SAME predicate/machinery the real check
// uses against a mutated copy of the text and assert it flips; the P2/P4 slicers are locate-then-slice and THROW on a
// missing anchor (a control asserts that too). NOT covered: the c5 control only proves the stripper+regex flag a waiver
// registration, not that every router file is reached.
//   (P1) SINGLE READER — `cardPolicies` appears in daemon src ONLY at: card-policy.ts (the evaluator), the two RAW
//        stored-override reads (sessions/service.ts, mcp/tasks.ts, and the Db sticky-match recorder db.ts — each a cast of
//        `project.config`, never resolveConfig),
//        and mcp/platform.ts's write-time validation / human-only lists. No line mixes `resolveConfig` with
//        `cardPolicies`; no `orchestration.cardPolicies` member read exists outside those.
//   (P2) ONE SHARED merge check — `mergePolicyRefusal(` is defined once and CALLED from exactly the four merge
//        sites (tracked pre-attach, confirmWorkerMerge backstop, the confirmWorkerMerge pre-squash re-check against the
//        pinned squash tip, mergeBatchTracked), and exempts on the worker's own landed branch, never a card-level
//        field; `evaluateCardPolicies(` is
//        called only from the evaluator's two wrappers (service.ts evaluateTaskPolicies, mcp/tasks.ts taskPolicyView).
//   (P3) CALLER CENSUS — `spawnWorker(` is invoked from exactly reviveWorker, spawnWorkerTracked and the cap-queue
//        drain; recycleWorker / resumeFleetOnBoot / recoverCrashOrphanedWorkers bodies reference no policy function
//        (so a recovery path can never be policy-refused). The spawn-phase check is NOT conditioned on a revive spawn.
//   (P4) BATCH ORDER — `policyBlocked` is part of the `chosen` filter, so the f944d4e4 dedupe key
//        (buildBatchDedupeKey over `chosen`) is derived over the same set with or without a policy block.
//   (P6) ONLY THE HUMAN REST ANSWER ROUTE STAMPS `answeredVia` — an agent-path writer that stamped it would let an agent
//        approve its own spawn.
//   (P5) NO MCP WAIVER — no compiled MCP router mentions a waiver at all, and the orchestration manager + worker tool
//        lists (real routers, in-memory MCP client) contain no /waive/i tool.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { stripComments } from "./_strip-comments.mjs";
const tmpHome = useOwnLoomHome("cpp-");
requireHermeticEnv();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "..", "src");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));
const rel = (f) => path.relative(srcDir, f).split(path.sep).join("/");
const files = walk(srcDir);
const stripped = new Map(files.map((f) => [rel(f), stripComments(fs.readFileSync(f, "utf8"))]));
const hits = (re, only, map = stripped) => [...map].filter(([f]) => !only || only(f)).flatMap(([f, t]) => t.split("\n").map((l, i) => ({ f, i: i + 1, l })).filter((x) => re.test(x.l)));
// Locate-then-slice: an anchor that is missing THROWS (the check fails loudly) instead of silently slicing garbage.
const locate = (text, anchor, from = 0) => { const i = text.indexOf(anchor, from); if (i < 0) throw new Error(`anchor not found: ${anchor}`); return i; };
const methodSlice = (text, startAnchor) => { const s = locate(text, startAnchor); return text.slice(s, locate(text, "\n  async ", s + startAnchor.length)); };
const mutate = (map, file, from, to) => { const t = map.get(file); locate(t, from); const m = new Map(map); m.set(file, t.replace(from, () => to)); return m; };
const throwsLoudly = (fn) => { try { fn(); return false; } catch (e) { return /anchor not found/.test(String(e.message)); } };

// ── (P1) single reader ────────────────────────────────────────────────────────────────────────────────────────────
{
  const RAW_CAST = /as \{ orchestration\?: \{ cardPolicies\?: unknown \} \}/;
  // The REAL P1 machinery: returns the list of problems found in a (comment-stripped) file map.
  const p1Problems = (map) => {
    const h = (re) => hits(re, undefined, map);
    const out = [];
    const byFile = new Map();
    for (const x of h(/cardPolicies/)) byFile.set(x.f, (byFile.get(x.f) ?? 0) + 1);
    const expected = new Map([["mcp/platform.ts", 4], ["mcp/tasks.ts", 1], ["sessions/service.ts", 1], ["db.ts", 1]]); // db.ts: the sticky-match recorder (title chokepoint), also a RAW read
    for (const [f, n] of byFile) if (expected.get(f) !== n && !f.startsWith("orchestration/card-policy")) out.push(`unexpected 'cardPolicies' count ${n} in ${f}`);
    for (const [f, n] of expected) if (byFile.get(f) !== n) out.push(`pinned site ${f} no longer has exactly ${n}`);
    if (h(/resolveConfig/).some((x) => /cardPolicies/.test(x.l))) out.push("a line mixes resolveConfig with cardPolicies");
    if (h(/orchestration\??\.cardPolicies/).some((x) => !(RAW_CAST.test(x.l) || x.f === "mcp/platform.ts"))) out.push("an orchestration.cardPolicies member read outside the RAW casts");
    const raw = h(RAW_CAST).filter((x) => !x.f.startsWith("orchestration/card-policy")); // the evaluator module's own helpers may cast too
    if (!(raw.length === 3 && raw.every((x) => /config as/.test(x.l)))) out.push("the three RAW reads (service evaluator, tasks_get view, Db sticky recorder) are not RAW casts of the stored project config");
    return out;
  };
  const real = p1Problems(stripped);
  check(`(P1) the real tree passes the P1 machinery (problems: ${JSON.stringify(real)})`, real.length === 0);
  const svcText = stripped.get("sessions/service.ts");
  const bad = p1Problems(new Map([...stripped, ["sessions/service.ts", svcText + "\nconst p = resolveConfig(project.config).orchestration.cardPolicies;\n"]]));
  check("(c1) CONTROL (positive): the SAME P1 machinery, run on a tree with a resolveConfig(...).orchestration.cardPolicies read, FAILS naming it", bad.some((p) => /resolveConfig with cardPolicies/.test(p)) && bad.some((p) => /member read/.test(p)));
  check("(c1) CONTROL (negative): a bogus pattern matches nothing in the real tree", hits(/zzNoSuchIdentifierZz/).length === 0);
}

// ── (P2) one shared merge check ───────────────────────────────────────────────────────────────────────────────────
{
  const svc = stripped.get("sessions/service.ts");
  // The REAL P2 machinery over a service.ts text; every slice is locate-then-slice (a missing anchor throws).
  const RUNNING_GUARD = 'this.pendingOps.peek(key)?.state !== "running"';
  const p2 = (text) => {
    const calls = [...text.matchAll(/mergePolicyRefusal\(/g)].length;
    const tracked = methodSlice(text, "  async confirmWorkerMergeTracked(");
    const key = locate(tracked, "const key = lineageOp");
    const call = locate(tracked, "mergePolicyRefusal(");
    const attach = locate(tracked, "this.pendingOps.attach<ConfirmMergeResult>(");
    // Anchored on the guard IMMEDIATELY preceding the call: other `peek(key)` lines (e.g. the restartExiting refusal) may precede it, so mere presence in key..call proves nothing.
    const gi = tracked.slice(key, call).lastIndexOf(RUNNING_GUARD);
    const runningGuard = gi >= 0 && tracked.slice(key + gi + RUNNING_GUARD.length, call).length < 80;
    const conf = methodSlice(text, "  async confirmWorkerMerge(");
    const backstop = locate(conf, "mergePolicyRefusal(") < locate(conf, "resolveConfig(");
    const squash = locate(conf, "const squashTip =");
    const pre = locate(conf, "mergePolicyRefusal(workerSessionId, { pinnedTip: squashTip })", squash);
    const preSquashPinned = pre > squash && pre < locate(conf, "this.checkMainlineMove(", squash);
    const def = methodSlice(text, "  async mergePolicyRefusal(");
    const vt = locate(text, "verifiedTip.set(");
    const batchPinned = locate(text, "mergePolicyRefusal(cand.workerSessionId, pinned ? { pinnedTip: pinned } : undefined)", vt) > vt && /const pinned = verifiedTip\.get\(cand\.workerSessionId\)/.test(text);
    const noCardLevelExemption = !/mergedSha|columnKey/.test(def) && /workerBranchProvenLanded\(/.test(def);
    return { calls, trackedOrder: key < call && call < attach, runningGuard, backstop, preSquashPinned, noCardLevelExemption, batchPinned };
  };
  // Control mutant: replace the guard occurrence nearest BEFORE the tracked wrapper's policy call (the one that really protects it), not the first textual occurrence.
  const dropGuardBeforePolicyCall = (text) => {
    const start = locate(text, "  async confirmWorkerMergeTracked(");
    const callAt = locate(text, "mergePolicyRefusal(", start);
    const at = text.lastIndexOf(RUNNING_GUARD, callAt);
    if (at < start) throw new Error("anchor not found: running guard before the policy call");
    return text.slice(0, at) + "true" + text.slice(at + RUNNING_GUARD.length);
  };
  const r2 = p2(svc);
  check(`(P2) mergePolicyRefusal( occurs 5 times in service.ts: the definition + the 3 merge sites + the pre-squash pinned-tip re-check (got ${r2.calls})`, r2.calls === 5);
  check("(P2) the pre-squash re-check passes the PINNED squash tip and sits between `const squashTip` and checkMainlineMove", r2.preSquashPinned);
  check("(P2) the batch loop judges each candidate at the tip its reviewed-tip verdict read (verifiedTip), mirroring the solo pin", r2.batchPinned);
  check("(P2) mergePolicyRefusal exempts on the worker's own proven-landed branch, and reads neither mergedSha nor the column", r2.noCardLevelExemption);
  check("(P2) the tracked wrapper runs it after the lineage key and BEFORE pendingOps.attach (so a refusal mints no op)", r2.trackedOrder);
  check("(P2) ...and only when no op is already RUNNING under that key (a running op is attached to, never refused)", r2.runningGuard);
  check("(P2) confirmWorkerMerge runs it before resolveConfig / any gate work (the backstop)", r2.backstop);
  check("(c2) CONTROL (loud): a service.ts missing the key anchor makes the P2 machinery THROW, not pass", throwsLoudly(() => p2(svc.replace("const key = lineageOp", "const kkey = lineageOp"))));
  check("(c2) CONTROL (positive): dropping the running-op guard flips the guard predicate to false", p2(dropGuardBeforePolicyCall(svc)).runningGuard === false);
  check("(c2) CONTROL (positive): moving the policy call after attach flips the order predicate to false", p2(svc.replace(/(const key = lineageOp[^\n]*\n)/, "$1    const __zz = this.pendingOps.attach<ConfirmMergeResult>(\n")).trackedOrder === false);
  const evalCalls = hits(/evaluateCardPolicies\(/, (f) => f !== "orchestration/card-policy.ts").map((h) => h.f).sort();
  check(`(P2) evaluateCardPolicies( is called only from service.ts + mcp/tasks.ts (got ${evalCalls.join(",")})`, evalCalls.join(",") === "mcp/tasks.ts,sessions/service.ts");
}

// ── (P3) caller census ────────────────────────────────────────────────────────────────────────────────────────────
{
  const svc = stripped.get("sessions/service.ts");
  const callers = [];
  for (const h of hits(/\bthis\.spawnWorker\(|\.spawnWorker\(/, (f) => f === "sessions/service.ts")) {
    // the enclosing method = the nearest preceding 2-space-indented `async name(`
    const lines = svc.split("\n");
    let j = h.i - 1; while (j >= 0 && !/^  (private |public )?async \w+\(/.test(lines[j])) j--;
    callers.push(lines[j]?.match(/async (\w+)\(/)?.[1] ?? "?");
  }
  check(`(P3) spawnWorker( is invoked only from reviveWorker, spawnWorkerTracked, maybeDrainCapQueue (got ${callers.sort().join(",")})`, callers.sort().join(",") === "maybeDrainCapQueue,reviveWorker,spawnWorkerTracked");
  const body = (name) => {
    const ls = svc.split("\n");
    const start = ls.findIndex((l) => new RegExp(`^  (?:private |public |protected )?(?:async )?${name}\\(`).test(l));
    if (start < 0) return "";
    let end = start + 1;
    while (end < ls.length && !/^  (?:private |public |protected )?(?:async )?\w+\(/.test(ls[end])) end++;
    return ls.slice(start, end).join("\n");
  };
  for (const m of ["recycleWorker", "resumeFleetOnBoot", "recoverCrashOrphanedWorkers"]) {
    const b = body(m);
    check(`(P3) ${m} exists (body found) and references no policy function`, b.length > 200 && !/evaluateTaskPolicies|mergePolicyRefusal|evaluateCardPolicies|describePolicyRefusal/.test(b));
  }
  const SPAWN_CALL = 'const ev = await this.evaluateTaskPolicies(project, task, "spawn");';
  const reviveNotExempt = (text) => !/internal\?\.revive/.test(text.slice(Math.max(0, locate(text, SPAWN_CALL) - 400), locate(text, SPAWN_CALL)));
  check("(P3) the spawn-phase check is NOT conditioned on a revive spawn (a revive onto a follow-up card runs the full policy)", reviveNotExempt(svc));
  check("(c3) CONTROL (positive): wrapping the spawn check in `if (!internal?.revive)` flips the predicate to false", reviveNotExempt(svc.replace(SPAWN_CALL, () => "if (!internal?.revive) { " + SPAWN_CALL)) === false);
  check("(c3) CONTROL (negative): a bogus method name finds no body", body("noSuchMethodZz") === "");
}

// ── (P4) batch order ──────────────────────────────────────────────────────────────────────────────────────────────
{
  const svc = stripped.get("sessions/service.ts");
  const lineOf = (text, re) => { const l = text.split("\n").find((x) => re.test(x)); if (l === undefined) throw new Error(`anchor not found: ${re}`); return l; };
  const p4 = (text) => ({
    chosen: lineOf(text, /const chosen = candidates\.filter\(/).includes("policyBlocked.has("),
    batchable: lineOf(text, /const batchable = candidates\.filter\(/).includes("!policyBlocked.has("),
    keyAfter: locate(text, "const policyBlocked = new Map") < locate(text, "buildBatchDedupeKey(this.db, managerSessionId, chosen)"),
    skip: /const policyText = policyBlocked\.get\(f\.workerSessionId\);\s*\n\s*if \(policyText\)/.test(text),
  });
  const r4 = p4(svc);
  check("(P4) `chosen` keeps policy-blocked candidates (so the dedupe key is derived over the same set)", r4.chosen);
  check("(P4) `batchable` excludes them (never assembled)", r4.batchable);
  check("(P4) the dedupe key is derived from `chosen` AFTER the policy map is built", r4.keyAfter);
  check("(P4) runFallback skips a policy-blocked candidate (never solo-confirmed from there)", r4.skip);
  check("(c4) CONTROL (positive): dropping policyBlocked from the `chosen` filter flips the chosen predicate to false", p4(svc.replace("|| policyBlocked.has(c.workerSessionId) || liveChosen.includes(c)", () => "|| liveChosen.includes(c)")).chosen === false);
  check("(c4) CONTROL (positive): dropping the runFallback skip flips the skip predicate to false", p4(svc.replace("if (policyText) {", () => "if (false) {")).skip === false);
  check("(c4) CONTROL (loud): a service.ts without the `chosen` anchor makes the P4 machinery THROW", throwsLoudly(() => p4(svc.replace("const chosen = candidates.filter(", "const chosenX = candidates.filter("))));
}

// ── (P6) only the human REST route stamps answeredVia ─────────────────────────────────────────────────────────────
// Card 9623e943 F1: approved-request evidence requires answeredVia "human". That is only a trust boundary while NO agent-path
// writer (question_resolve in mcp/questionTool.ts, the companion decision_resolve in companion/capabilities.ts) stamps it.
{
  const answerSites = (map) => hits(/\.answerQuestion\(/, undefined, map);
  const stampers = (map) => answerSites(map).filter((x) => /answeredVia/.test(x.l));
  const p6 = (map) => ({ sites: answerSites(map).length, stampFiles: [...new Set(stampers(map).map((x) => x.f))], agentFilesSeen: [...new Set(answerSites(map).map((x) => x.f))] });
  const r6 = p6(stripped);
  check(`(P6) answerQuestion call sites in src: ${r6.sites} across ${r6.agentFilesSeen.join(",")}`, r6.sites >= 5 && r6.agentFilesSeen.includes("mcp/questionTool.ts") && r6.agentFilesSeen.includes("companion/capabilities.ts"));
  check(`(P6) ONLY gateway/server.ts stamps answeredVia at an answerQuestion call (stampers: ${r6.stampFiles.join(",")})`, r6.stampFiles.length === 1 && r6.stampFiles[0] === "gateway/server.ts");
  check("(P6) the evidence reader requires answeredVia === \"human\"", /q\.answeredVia === "human"/.test(stripped.get("orchestration/card-policy.ts")));
  // CONTROL (positive): an agent-path file that stamped it WOULD change the answer
  const mutated = mutate(stripped, "mcp/questionTool.ts", "answeredAt: new Date().toISOString() })", 'answeredAt: new Date().toISOString(), answeredVia: "human" })');
  check("(c6) CONTROL (positive): a stamping question_resolve makes the P6 machinery see a second stamper file", p6(mutated).stampFiles.length === 2);
  check("(c6) CONTROL (loud): a questionTool.ts without the call anchor makes the mutation THROW", throwsLoudly(() => mutate(stripped, "mcp/questionTool.ts", "NO_SUCH_ANCHOR_X", "y")));
}

// ── (P5) no MCP waiver ────────────────────────────────────────────────────────────────────────────────────────────
{
  const mcpDist = path.join(here, "..", "dist", "mcp");
  const mcpFiles = fs.readdirSync(mcpDist).filter((f) => f.endsWith(".js"));
  const off = mcpFiles.filter((f) => /waiv/i.test(stripComments(fs.readFileSync(path.join(mcpDist, f), "utf8"))));
  check(`(P5) no compiled MCP router (${mcpFiles.length} files) mentions a waiver (offenders: ${off.join(",") || "none"})`, mcpFiles.length > 0 && off.length === 0);
  check("(c5) CONTROL (positive): a registered waive tool WOULD be flagged", /waiv/i.test(stripComments('server.registerTool("policy_waive", {});\n')));
  check("(c5) CONTROL (negative): the same stripper does not flag comment-only mentions", !/waiv/i.test(stripComments("// no waiver tool exists\n")));
  // the REST route exists and is not an MCP tool
  const gw = stripped.get("gateway/server.ts");
  check("(P5) the waiver is a REST route on the gateway", /app\.post\("\/api\/tasks\/:id\/policy-waivers"/.test(gw) && /app\.delete\("\/api\/tasks\/:id\/policy-waivers"/.test(gw));

  // dynamic: manager + worker tool lists of the REAL orchestration router
  const { makeEnv, closeAll } = await import("./_card-policy-fixture.mjs");
  const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const e = await makeEnv();
  const w = await e.makeWorker("surf");
  const router = new OrchestrationMcpRouter(e.db, e.sessions);
  for (const [sid, role] of [[e.mgrId, "manager"], [w.workerId, "worker"]]) {
    const info = router.resolveRole(sid);
    check(`(P5) ${role} session resolves its orchestration role (sanity)`, !!info && info.role === role);
    const server = router.buildServer(sid, info.role);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "card-policy-source-pins", version: "0" });
    await client.connect(ct);
    const names = (await client.listTools()).tools.map((t) => t.name);
    check(`(P5) ${role} tool list (${names.length} tools) has no /waive/i tool`, names.length > 0 && !names.some((n) => /waive/i.test(n)));
    await client.close();
  }
  closeAll();
}

console.log(failures === 0 ? "\n✅ ALL PASS — card-policy source pins" : `\n${failures} check(s) FAILED.`);
await finishAndExit(failures === 0 ? 0 : 1);
