import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Cross-channel duplicate-card detection (board card 5b221bf2). `platform_escalate` dedupes against its
// OWN prior escalations by title; it has no visibility into a card a peer manager files by hand
// (tasks_create) or boards via peer_message for the SAME finding — the dedupe guarantee holds PER-CHANNEL
// and silently does not hold ACROSS channels. Fixed by keying `tasks_create` on shared RARE IDENTIFIERS
// (a session id, a branch, an OS error constant, a file:line, a code symbol) rather than title/prose
// similarity — two independently-worded reports of one incident still cite the same identifiers even
// though their prose diverges.
//
// §SCOPE FENCE: the refusal lives ONLY in the agent-facing `tasks_create` tool (createProjectTaskChecked,
// mcp/tasks.ts) — never in `createProjectTask`/`db.insertTask`, which automated boarding paths (peer_message,
// platform escalation, workspace-audit suggestions, project seeding) call with a delivery guarantee. A
// refusal there would silently drop a message instead of failing an agent call the agent can read and retry.
//
// Fixture text below is excerpted (paraphrased, identifiers preserved verbatim) from the board's own
// founding specimens for this detector:
//   - 47340c82 / dde0ce24 — the SAME phantom-session/lying-worker_stop defect, filed twice, independently,
//     via two different triage routes. Both cite session id e3641737-6a51-4165-801f-7757e925ea7b and
//     branch loom/ecb6acc1f3a3 — the identifiers that survive independent authorship.
//   - abcf0eba / bc91e86c — the SAME Windows argv-limit defect, filed twice. Both cite
//     ERROR_FILENAME_EXCED_RANGE, CreateProcess, and "error code: 206".
//   - 522cf573 / 66d91a11 — two GENUINELY DISTINCT gate-diagnostic-honesty defects (similar wording, no
//     shared identifiers) that must NOT be flagged — the negative control.
//
// Code Review round 2 measured a 47.5% false-positive rate for the first cut of this detector against
// the REAL 1683-card board (40 most-recently-updated cards, each re-filed against every other card).
// Three mechanical bugs drove it (see packages/daemon/src/mcp/duplicateDetection.ts's module doc for the
// full analysis + fix): an ALL-CAPS shouted word parsing as a PascalCase symbol, a single shared weak
// token being sufficient alone, and `file:line` being single-hit-sufficient. Fixed and re-measured on the
// SAME real board + methodology: 22.5% FP rate, BOTH founding pairs flagging at rank 1 in BOTH directions,
// negative control clear. One false-positive class remains, DELIBERATELY UNFIXED and disclosed in that
// same module doc: a design/meta card (this very card, 5b221bf2) that quotes past incidents' identifiers
// as worked examples can itself get flagged — three citation-based fixes were tried and each traded it
// for a different founding-pair regression, so it's reported rather than tuned around. Real-card
// regressions below use VERBATIM excerpts (board cards aa4e24ff / 7acee6d4) for the fixed classes; the
// live-board FP measurement itself is NOT re-run here (a live 1683-card board is ambient, mutable,
// non-hermetic state — the opposite of what a committed test may depend on), but the mechanism that
// produced it is captured as synthetic minimal-pair regressions instead.
//
// CARD b6eab182 (2026-08-06) — SUPERSEDES the weak-only matching described above. 5 REAL spurious
// create-BLOCKS were measured in LIVE usage (not sampled draws) — the 5th matched on nothing but a bare
// camelCase-shaped field name (`workerlabel`) plus a `file:line` landmark, i.e. exactly the two-weak-
// category bar this detector used to consider sufficient. Per the stated asymmetry (a spurious dedup
// CONFLICT is loud and self-correcting; a spurious create-BLOCK silently kills a finding), weak evidence —
// of ANY category, in ANY combination — is no longer sufficient BY ITSELF: a match now REQUIRES at least
// one STRONG identifier (a session id / task id — both full UUIDs — or a Loom branch name). Weak evidence
// still corroborates a strong match's ranking/report but can never trigger one alone. ACCEPTED COST: this
// module's own founding abcf0eba/bc91e86c pair (caught purely via weak evidence — see below) is no longer
// auto-flagged — tests below document that explicitly as an intended trade rather than silently dropping
// the assertion.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE.
// Run: 1) build (turbo builds shared first), 2) node test/task-dedupe.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-task-dedupe-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { createProjectTask, createProjectTaskChecked } = await import("../dist/mcp/tasks.js");
const { extractIdentifiers, findSuspectedDuplicate } = await import("../dist/mcp/duplicateDetection.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

// ===================== Real-specimen fixtures (card 5b221bf2's founding evidence) =====================
const SPEC = {
  p1a: {
    title: "DUPLICATE of dde0ce24 — do not work; evidence merged there, worker already dispatched on it",
    body: "Escalated by the Codescape manager (platform relay; Lead-triaged 2026-07-30). Observed (Codescape, " +
      "2026-07-30 ~07:25Z, Windows 11): worker_spawn failed (raw Cannot create process, error code: 206 — see " +
      "sibling card) yet had already created session e3641737-6a51-4165-801f-7757e925ea7b with " +
      "processState:live and a real provisioned worktree/branch (loom/ecb6acc1f3a3) — but a shell with NO " +
      "engine: engineSessionId:null, turnSeq:0. Consequences: worker_stop(mode:hard) returned stopped:true " +
      "and the record stayed live. worker_recycle was the escape hatch.",
  },
  p1b: {
    title: "fix(sessions): reconcile spawn-failure phantoms and make worker_stop honest",
    body: "PROVENANCE: reported 2026-07-30 by the Codescape peer manager. THE DEFECT — first-hand, session " +
      "ids on record (Codescape, 2026-07-30 ~07:25Z, Windows 11): worker_spawn failed (raw Cannot create " +
      "process, error code: 206) yet had ALREADY created session e3641737-6a51-4165-801f-7757e925ea7b with a " +
      "real provisioned worktree/branch (loom/ecb6acc1f3a3) — but a shell with NO engine: processState:live, " +
      "engineSessionId: null, turnSeq: 0. worker_stop(mode:hard) returned stopped: true and the record " +
      "STAYED live. worker_recycle WAS the escape hatch.",
  },
  p2a: {
    title: "fix(pty): preflight the Windows command-line limit instead of a raw error 206",
    body: "Observed (Codescape, 2026-07-30 ~07:25Z, Windows 11): worker_spawn returned error: Cannot create " +
      "process, error code: 206 (ERROR_FILENAME_EXCED_RANGE — the classic CreateProcess >32,767-char " +
      "command-line failure). At failure time: startupPrompt ~11 KB, kickoff ~7 KB. Mechanism consistent " +
      "with the startup/kickoff riding the engine argv (pty/host.ts buildSpawnArgs).",
  },
  p2b: {
    title: "DUPLICATE of abcf0eba — do not work; that card is better",
    body: "worker_spawn returned a raw error: Cannot create process, error code: 206 — Windows " +
      "ERROR_FILENAME_EXCED_RANGE, i.e. a CreateProcess command-line length overflow. Cause: the agent's " +
      "startupPrompt is prepended to the kickoff and passed as a command-line ARGUMENT. Their case: a brief " +
      "hardened to ~11 KB via agent_update plus a ~7 KB kickoff. Trimming both made it spawn.",
  },
  neg1: {
    title: "feat(orchestration): a merge-FAILED notification carries no gateDetail — merge-REJECTED does, " +
      "leaving the undiagnosable case undiagnosable",
    body: "Provenance: mgr #70, 2026-07-30. Card 0a542ede's third merge attempt (op a285c028) returned " +
      "loom:merge-failed with the bare text build gate failed and nothing else. THE ASYMMETRY: the same " +
      "card's two earlier attempts returned loom:merge-rejected and were fully diagnosable, naming " +
      "step/phase/failingTest/stderrTail/exitCode/timedOut. DoD: merge-failed carries at least what " +
      "merge-rejected carries — gateDetail where derivable (phase/failedStep/exitCode/signal/timedOut).",
  },
  neg2: {
    title: "fix(sessions): the gate detail renders concurrentAtStart as bare concurrent=, inviting a false " +
      "exclusion — two managers mis-inferred from it in one night",
    body: "Provenance: mgr #71, 2026-07-30. packages/daemon/src/sessions/service.ts:8897 renders a gate-cap " +
      "label as cap=2 concurrent=1. The variable backing that second number is concurrentAtStart — honest " +
      "and exact — but the rendered label drops AtStart, so a reader infers no second gate ran at all. DoD: " +
      "rename the rendered label to concurrentAtStart=1. Do NOT change maxConcurrentGates — that's the " +
      "owner's setting.",
  },
};
const text = (s) => `${s.title}\n${s.body}`;

// Card abdaecda originally used these as a WEAK-ONLY match fixture (shared file:line + camelCase symbol,
// no strong session-id/branch) mirroring the real 166e3536/f3917f96 absurd-specimen shape. Card b6eab182
// repurposes them as the DoD-3 POSITIVE CONTROL instead: two genuinely-distinct cards citing the same
// file:line + symbol must now create CLEANLY (no refusal at all), since weak-only evidence can no longer
// qualify a match. STRONG_A/STRONG_B (below) remain the DoD-4 NEGATIVE CONTROL: a genuine duplicate
// sharing a real STRONG identifier (a session id) must still be blocked.
const WEAKONLY_A = {
  title: "chore(examples): illustrate liveFleetResumeSet usage patterns",
  body: "Worked example only — queries liveFleetResumeSet via service.ts:490 as a sample call site, " +
    "unrelated to any specific incident.",
};
const WEAKONLY_B = {
  title: "fix(sessions): correct an unrelated liveFleetResumeSet edge case",
  body: "Distinct bug: liveFleetResumeSet mishandles a corner case at service.ts:490 in an entirely " +
    "different code path.",
};
const STRONG_A = {
  title: "fix(x): alpha report for a live-incident session",
  body: "Session abcdef12-3456-7890-abcd-ef1234567890 hit an issue.",
};
const STRONG_B = {
  title: "fix(x): beta report for the same live-incident session",
  body: "Same session id abcdef12-3456-7890-abcd-ef1234567890 confirmed independently.",
};

try {
  // ===================== GATE 2 — POSITIVE CONTROL on the real specimens =====================
  const m1 = findSuspectedDuplicate([{ id: "dde0ce24", ...SPEC.p1b }], text(SPEC.p1a));
  check("(pos) 47340c82-shaped text is flagged as a duplicate of dde0ce24 (shared session id + branch)",
    m1?.taskId === "dde0ce24");
  const m1r = findSuspectedDuplicate([{ id: "47340c82", ...SPEC.p1a }], text(SPEC.p1b));
  check("(pos) symmetric: dde0ce24-shaped text is flagged as a duplicate of 47340c82", m1r?.taskId === "47340c82");

  // Card b6eab182 ACCEPTED COST: abcf0eba/bc91e86c share ONLY weak evidence (ERROR_FILENAME_EXCED_RANGE +
  // CreateProcess + startupPrompt — screaming_snake/pascal_case/camel_case, zero strong identifiers). Weak
  // evidence alone no longer qualifies a match (see duplicateDetection.ts's module doc, "CARD b6eab182"),
  // so this founding pair is now a documented, INTENTIONAL false negative rather than a positive control.
  const m2 = findSuspectedDuplicate([{ id: "bc91e86c", ...SPEC.p2b }], text(SPEC.p2a));
  check("(b6eab182, accepted cost) abcf0eba-shaped text is NO LONGER flagged as a duplicate of bc91e86c (weak-only evidence)",
    m2 === null);
  const m2r = findSuspectedDuplicate([{ id: "abcf0eba", ...SPEC.p2a }], text(SPEC.p2b));
  check("(b6eab182, accepted cost) symmetric: bc91e86c-shaped text is NO LONGER flagged as a duplicate of abcf0eba",
    m2r === null);

  // Full-corpus version (all 6 real specimens present at once) — proves the pairing isn't an artifact of
  // an isolated 2-card test: each candidate must land on its OWN true counterpart, not a neighbor.
  const corpus = (excludeKey) => Object.entries(SPEC).filter(([k]) => k !== excludeKey).map(([k, v]) => ({ id: k, ...v }));
  check("(pos, full corpus) p1a's best match is p1b", findSuspectedDuplicate(corpus("p1a"), text(SPEC.p1a))?.taskId === "p1b");
  check("(b6eab182, accepted cost, full corpus) p2a no longer matches anything (weak-only evidence, no strong id)",
    findSuspectedDuplicate(corpus("p2a"), text(SPEC.p2a)) === null);

  // ===================== GATE 2 — NEGATIVE CONTROL: distinct findings, similar wording =====================
  const n1 = findSuspectedDuplicate([{ id: "66d91a11", ...SPEC.neg2 }], text(SPEC.neg1));
  check("(neg) 522cf573-shaped text is NOT flagged as a duplicate of 66d91a11 (no shared rare identifiers)", n1 === null);
  const n2 = findSuspectedDuplicate([{ id: "522cf573", ...SPEC.neg1 }], text(SPEC.neg2));
  check("(neg) symmetric: 66d91a11-shaped text is NOT flagged as a duplicate of 522cf573", n2 === null);
  check("(neg, full corpus) neg1 alongside all 4 real duplicate-pair specimens still matches nothing",
    findSuspectedDuplicate(corpus("neg1"), text(SPEC.neg1)) === null);

  // A shared "Related:" cross-reference between two cards (a task-id token like `565e1b45`) must NOT read
  // as a shared rare identifier — that is exactly what would have broken the negative control above.
  const relatedRefText = "Related: 565e1b45 and 424ed9a8 — see the scope table on fa52f555.";
  check("(neg) a bare 8-hex task-id cross-reference is not itself extracted as an identifier",
    !extractIdentifiers(relatedRefText).has("565e1b45"));

  // A short common abbreviation ('DoD') must not be mistaken for a PascalCase code symbol.
  check("(neg) 'DoD' is excluded (too short to be a real identifier)", !extractIdentifiers("## DoD\nsome text").has("DoD"));

  // ===================== Code Review round 2 (measured 47.5% FP rate on the real 1683-card board) =====================
  // Mechanism 1 — a bare ALL-CAPS shouted word (Loom cards use heavy caps emphasis) must NOT parse as a
  // PascalCase symbol via N single-letter segments (each capital alone satisfied "[A-Z][a-z0-9]*" with a
  // zero-length tail). Real specimen that reproduced this on the board: "MEASURED", "HYPOTHESIS".
  check("(neg) an ALL-CAPS shouted word is not extracted as a PascalCase symbol",
    !extractIdentifiers("this was carefully MEASURED against the HYPOTHESIS").has("measured"));

  // Mechanism 2 — a SINGLE shared weak-category token (however the corpus is shaped) must never be
  // sufficient alone; it needs a SECOND, DISTINCT category. Real specimen (verbatim excerpts, board
  // cards aa4e24ff / 7acee6d4): two genuinely distinct fixes that both happen to name the real field
  // `busyForMs` — sharing that one camelCase symbol must not flag them against each other.
  const REAL_BUSYFORMS_A = {
    title: "fix(orchestration): label refusal previews and advise redirect when held",
    body: "Trigger: busyForMs, NOT text matching. IMPLEMENT: on a held/queued result, when busyForMs " +
      "exceeds a threshold, append an advisory. busyForMs is ALREADY IN THE RESPONSE.",
  };
  const REAL_BUSYFORMS_B = {
    title: "fix(orchestration): give \"hold the worker\" a discoverable tool and trigger",
    body: "add honest fields alongside: { queued: true, landsAt: \"next-turn-boundary\", position, msgId, " +
      "busyForMs }. Do NOT auto-escalate worker_message to a redirect on detected stop-language.",
  };
  check("(neg, real specimen) two genuinely distinct real cards sharing only ONE weak-category token (busyForMs) do not flag",
    findSuspectedDuplicate([{ id: "7acee6d4", ...REAL_BUSYFORMS_B }], text(REAL_BUSYFORMS_A)) === null);

  // Mechanism 3 — file:line refs, however MANY are shared, are ONE weak category and never sufficient
  // alone (an audit/sweep card can share a dozen `file:line` refs with a genuinely distinct sibling).
  const manyFileLineRefs = Array.from({ length: 8 }, (_, i) => `src/module${i}.ts:${100 + i}`).join(", ");
  check("(neg) many shared file:line refs alone (zero other categories) do not flag",
    findSuspectedDuplicate([{ id: "sweepB", title: "sweep B", body: manyFileLineRefs }],
      `sweep A\n${manyFileLineRefs}`) === null);
  // Card b6eab182: a second weak category no longer corroborates into a match on its own either — this
  // is exactly DoD-1's "error constants ... do not trigger a block on their own" (this shape, two weak
  // categories, is the SAME shape as the real workerlabel+file:line spurious block that motivated the fix).
  check("(b6eab182) many shared file:line refs PLUS a second weak category still do NOT flag without a strong id",
    findSuspectedDuplicate(
      [{ id: "sweepB2", title: "sweep B2", body: `${manyFileLineRefs} ERROR_SOME_DISTINCT_CONSTANT` }],
      `sweep A2\n${manyFileLineRefs} ERROR_SOME_DISTINCT_CONSTANT`,
    ) === null);

  // m5 — the rarityThreshold boundary: an identifier shared by EXACTLY `rarityThreshold` tasks (the
  // matched task included) still counts; shared by one more than that, it doesn't. Flipping the `>` to
  // `>=` in the rarity filter would silently invert this and must fail this test.
  const rareBranch = "loom/aaaaaaaaaaaa";
  const atThreshold = [
    { id: "r1", title: "r1", body: rareBranch },
    { id: "r2", title: "r2", body: rareBranch },
    { id: "r3", title: "r3", body: rareBranch },
  ]; // 3 existing carriers — exactly the default rarityThreshold
  check("(m5) an identifier at EXACTLY the rarity threshold (3 existing carriers) still counts as evidence",
    findSuspectedDuplicate(atThreshold, `candidate\n${rareBranch}`)?.taskId === "r1");
  const overThreshold = [...atThreshold, { id: "r4", title: "r4", body: rareBranch }]; // 4 existing carriers
  check("(m5) one carrier OVER the rarity threshold (4 existing carriers) no longer counts",
    findSuspectedDuplicate(overThreshold, `candidate\n${rareBranch}`) === null);

  // M2 — card b6eab182: a strong-less weak match, however rich, no longer qualifies AT ALL (superseding
  // the old "strong outranks richer weak-only" tie-break test) — confirm that directly first.
  const rankSharedWeak = "ERROR_UNRELATED_CONSTANT CreateUnrelatedThing extraSymbolHere";
  const rankSharedUuid = "e3641737-6a51-4165-801f-7757e925ea7b";
  const rankWeakOnlyCandidate = {
    id: "weakOnly", title: "weakOnly", body: rankSharedWeak,
  };
  check("(b6eab182) a strong-less weak match, however many categories, does not qualify at all",
    findSuspectedDuplicate([rankWeakOnlyCandidate], rankSharedWeak) === null);

  // M2 (redesigned for b6eab182) — ranking among candidates that ALL genuinely qualify (each carries the
  // strong id) still respects weak-category richness as the tie-break.
  const rankStrongOnly = { id: "strongOnly", title: "strongOnly", body: rankSharedUuid };
  const rankStrongPlusWeak = { id: "strongPlusWeak", title: "strongPlusWeak", body: `${rankSharedUuid} ${rankSharedWeak}` };
  const rankCandidate = `${rankSharedUuid} ${rankSharedWeak}`;
  check("(M2) both candidates genuinely qualify via the shared STRONG id (sanity)",
    findSuspectedDuplicate([rankStrongOnly], rankCandidate)?.taskId === "strongOnly"
    && findSuspectedDuplicate([rankStrongPlusWeak], rankCandidate)?.taskId === "strongPlusWeak");
  check("(M2) among two equally-STRONG matches, richer corroborating weak evidence wins the tie-break",
    findSuspectedDuplicate([rankStrongOnly, rankStrongPlusWeak], rankCandidate)?.taskId === "strongPlusWeak");

  // n8 — the reported sharedIdentifiers list is bounded even when many identifiers are shared. A shared
  // STRONG id is required to qualify at all (card b6eab182); the many weak tokens (camelCase + snake_case)
  // are corroboration, testing that the bound applies across strong+weak tokens combined.
  const manySharedCamel = Array.from({ length: 6 }, (_, i) => `sharedSymbolNumber${i}`).join(" ");
  const manySharedSnake = Array.from({ length: 6 }, (_, i) => `shared_symbol_number_${i}`).join(" ");
  const manySharedWeak = `${manySharedCamel} ${manySharedSnake}`;
  const manySharedUuid = "12345678-1234-1234-1234-123456789012";
  const manyMatch = findSuspectedDuplicate(
    [{ id: "many", title: "many", body: `${manySharedUuid} ${manySharedWeak}` }],
    `candidate\n${manySharedUuid} ${manySharedWeak}`,
  );
  check("(n8) sharedIdentifiers is bounded, not a raw dump of every shared token",
    manyMatch !== null && manyMatch.sharedIdentifiers.length <= 9 && manyMatch.sharedIdentifiers.some((s) => s.startsWith("and ")));

  // ===================== card b6eab182 — DoD-3 positive control / DoD-4 negative control =====================
  // DoD-3: two genuinely-distinct cards sharing only a code landmark + naming convention (the exact shape
  // card abdaecda used to flag as a weak-only match) must now create CLEANLY — no match at all.
  const weakOnlyMatch = findSuspectedDuplicate([{ id: "weakOnlyExisting", ...WEAKONLY_A }], text(WEAKONLY_B));
  check("(b6eab182, DoD-3 positive control) a shared file:line + camelCase symbol alone (no strong id) no longer matches",
    weakOnlyMatch === null);

  // DoD-4: a genuine duplicate sharing a real STRONG identifier (a session id) must still be blocked.
  const strongFieldMatch = findSuspectedDuplicate([{ id: "strongExisting", ...STRONG_A }], text(STRONG_B));
  check("(b6eab182, DoD-4 negative control) a shared session id (strong identifier) still matches",
    strongFieldMatch !== null && strongFieldMatch.taskId === "strongExisting");
} catch (e) {
  check(`pure-function section threw: ${e.stack}`, false);
}

// ===================== Integration: the tasks_create MCP tool refuses + is overridable =====================
try {
  const db = new Db(path.join(tmpHome, "d.db"));
  const now = new Date().toISOString();
  const PROJECT_ID = "pDedupe";
  db.insertProject({ id: PROJECT_ID, name: "Dedupe Project", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentX", projectId: PROJECT_ID, name: "Agent", startupPrompt: "", position: 0 });
  db.insertSession({
    id: "sMgr", projectId: PROJECT_ID, agentId: "agentX", engineSessionId: null, title: null,
    cwd: tmpHome, processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });
  const wakes = {};
  const router = new TaskMcpRouter(db, wakes);
  const projectId = router.resolveProject("sMgr");
  const server = router.buildServer(projectId, "sMgr");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "task-dedupe-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  const first = await call("tasks_create", { title: SPEC.p1b.title, body: SPEC.p1b.body });
  check("(tool) first card of a real duplicate pair is created normally", !first.error && !!first.id);

  const before = db.listTasks(PROJECT_ID).length;
  const refused = await call("tasks_create", { title: SPEC.p1a.title, body: SPEC.p1a.body });
  check("(tool) the SECOND card of the pair is REFUSED, naming the counterpart id",
    typeof refused.error === "string" && refused.error.includes(first.id));
  check("(tool) the refused create inserted NO card", db.listTasks(PROJECT_ID).length === before);

  const overridden = await call("tasks_create", { title: SPEC.p1a.title, body: SPEC.p1a.body, allowDuplicate: true });
  check("(tool) allowDuplicate:true creates it anyway", !overridden.error && !!overridden.id);
  check("(tool) the board now has both cards", db.listTasks(PROJECT_ID).length === before + 1);

  // supersedes bypasses the refusal too, and records the relationship on the new card's body.
  const p2First = await call("tasks_create", { title: SPEC.p2a.title, body: SPEC.p2a.body });
  check("(tool) p2's first card is created normally", !p2First.error && !!p2First.id);
  const superseded = await call("tasks_create", { title: SPEC.p2b.title, body: SPEC.p2b.body, supersedes: p2First.id });
  check("(tool) supersedes:<id> bypasses the refusal", !superseded.error && !!superseded.id);
  check("(tool) the new card's body records the relationship", db.getTask(superseded.id).body.includes(`Supersedes: ${p2First.id}`));

  // m7 (card 0ef0270b): the relationship is discoverable from BOTH directions — the LOSER card (p2First)
  // must also carry a pointer FORWARD to the new card, not just the new card pointing back at it. This is
  // the exact harm the parent card was filed about: a reader landing directly on the superseded card had
  // no way to tell it had been superseded.
  check("(m7) the SUPERSEDED (loser) card's body is back-noted with a pointer to the new card",
    db.getTask(p2First.id).body.includes(`Superseded by: ${superseded.id}`));

  // relatedTo back-links too, with the distinct "Related to" wording (not "Superseded by") on both sides.
  const relBase = await call("tasks_create", { title: "feat(x): related-base card for m7", body: "loom/deadbeefcafe" });
  check("(m7) related-base card created normally", !relBase.error && !!relBase.id);
  const relNew = await call("tasks_create", { title: "feat(x): related-new card for m7", body: "loom/deadbeefcafe", relatedTo: relBase.id });
  check("(m7) relatedTo:<id> bypasses the refusal", !relNew.error && !!relNew.id);
  check("(m7) the NEW card's body records 'Related to' (not 'Supersedes')", db.getTask(relNew.id).body.includes(`Related to: ${relBase.id}`));
  check("(m7) the RELATED (base) card's body is back-noted with 'Related to' pointing at the new card",
    db.getTask(relBase.id).body.includes(`Related to: ${relNew.id}`));

  // an unresolvable supersedes/relatedTo target is rejected outright (typo protection), nothing written.
  const beforeBadTarget = db.listTasks(PROJECT_ID).length;
  const badTarget = await call("tasks_create", { title: "x", body: "y", supersedes: "00000000" });
  check("(tool) an unresolvable supersedes target is rejected, not silently ignored", typeof badTarget.error === "string");
  check("(tool) nothing was inserted for the bad-target attempt", db.listTasks(PROJECT_ID).length === beforeBadTarget);

  // m3 — passing BOTH supersedes and relatedTo together must never silently prefer one (house "never
  // silently ignore" posture) — reject outright, nothing written.
  const beforeBothGiven = db.listTasks(PROJECT_ID).length;
  const bothGiven = await call("tasks_create", { title: "x2", body: "y2", supersedes: p2First.id, relatedTo: first.id });
  check("(m3) passing both supersedes AND relatedTo is rejected, not silently resolved to one",
    typeof bothGiven.error === "string");
  check("(m3) nothing was inserted for the both-given attempt", db.listTasks(PROJECT_ID).length === beforeBothGiven);

  // Negative control via the real tool surface: two genuinely distinct findings both create cleanly.
  const negFirst = await call("tasks_create", { title: SPEC.neg1.title, body: SPEC.neg1.body });
  const negSecond = await call("tasks_create", { title: SPEC.neg2.title, body: SPEC.neg2.body });
  check("(tool, neg) two genuinely distinct cards with similar wording BOTH create with no refusal",
    !negFirst.error && !negSecond.error && negFirst.id !== negSecond.id);

  // ===================== card b6eab182 — DoD-3 positive control / DoD-4 negative control (real tool surface) =====================
  // DoD-3: two genuinely-distinct cards citing the same file:line + naming convention (this exact fixture
  // was card abdaecda's weak-only-match specimen) now BOTH create cleanly — no refusal at all.
  const weakOnlyFirst = await call("tasks_create", { title: WEAKONLY_A.title, body: WEAKONLY_A.body });
  check("(b6eab182, DoD-3) weak-only fixture's first card creates normally", !weakOnlyFirst.error && !!weakOnlyFirst.id);
  const weakOnlySecond = await call("tasks_create", { title: WEAKONLY_B.title, body: WEAKONLY_B.body });
  check("(b6eab182, DoD-3) the second, genuinely-distinct card sharing only a code landmark + naming " +
    "convention now creates CLEANLY too (no refusal)", !weakOnlySecond.error && !!weakOnlySecond.id);

  // DoD-4: a genuine duplicate — same session id (a STRONG identifier) — is still blocked, and the
  // refusal still names the counterpart plus the allowDuplicate/supersedes/relatedTo escape hatches (DoD-2).
  const strongFirst = await call("tasks_create", { title: STRONG_A.title, body: STRONG_A.body });
  check("(b6eab182, DoD-4) strong fixture's first card creates normally", !strongFirst.error && !!strongFirst.id);
  const strongRefused = await call("tasks_create", { title: STRONG_B.title, body: STRONG_B.body });
  check("(b6eab182, DoD-4) a genuine duplicate (shared session id) is still refused, naming both card titles",
    typeof strongRefused.error === "string"
      && strongRefused.error.includes(STRONG_B.title) && strongRefused.error.includes(STRONG_A.title));
  check("(b6eab182, DoD-2) the refusal states the allowDuplicate/supersedes/relatedTo escape hatches",
    typeof strongRefused.error === "string"
      && strongRefused.error.includes("allowDuplicate") && strongRefused.error.includes("supersedes/relatedTo"));

  await client.close();
  db.close();
} catch (e) {
  check(`tasks_create integration section threw: ${e.stack}`, false);
}

// ===================== §SCOPE FENCE regression: automated boarding paths stay byte-identical =====================
// DoD 8 — the test that catches the destructive version of this feature: a refactor that moved the check
// into createProjectTask/db.insertTask (a shared helper every boarding path calls) would pass every check
// above and FAIL here, because it would start refusing peer_message/platform-escalation boarding too.
try {
  const tmpHome2 = path.join(os.tmpdir(), `loom-task-dedupe-boarding-${Date.now()}-${process.pid}`);
  fs.mkdirSync(path.join(tmpHome2, "logs"), { recursive: true });
  const db = new Db(path.join(tmpHome2, "d.db"));
  const now = new Date().toISOString();

  // --- (a) createProjectTask (the raw shared helper) never refuses, regardless of dedupe status ---
  db.insertProject({ id: "pRaw", name: "Raw Project", repoPath: tmpHome2, vaultPath: tmpHome2, config: {}, createdAt: now, archivedAt: null });
  const rawFirst = createProjectTask(db, "pRaw", { title: SPEC.p1b.title, body: SPEC.p1b.body });
  const rawSecond = createProjectTask(db, "pRaw", { title: SPEC.p1a.title, body: SPEC.p1a.body });
  check("(boarding) createProjectTask (the shared helper under Platform/companion/all boarding paths) still lands BOTH duplicate cards with no refusal",
    !rawFirst.error && !rawSecond.error && rawFirst.id !== rawSecond.id);
  check("(boarding) createProjectTaskChecked is a SEPARATE function — createProjectTask itself takes no dedupe options at all",
    createProjectTask.length === 3);

  // --- (b) peer_message boarding (no live target manager) still lands a duplicate card ---
  db.insertProject({ id: "pOriginPeer", name: "Origin", repoPath: tmpHome2, vaultPath: tmpHome2, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pTargetPeer", name: "Target (no live manager)", repoPath: tmpHome2, vaultPath: tmpHome2, config: {}, createdAt: now, archivedAt: null });
  db.createProjectLink("pOriginPeer", "pTargetPeer");
  db.insertAgent({ id: "agentPeer", projectId: "pOriginPeer", name: "Mgr", startupPrompt: "", position: 0 });
  db.insertSession({
    id: "MGR_PEER", projectId: "pOriginPeer", agentId: "agentPeer", engineSessionId: null, title: null,
    cwd: tmpHome2, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "manager", parentSessionId: null,
  });
  // Seed an existing card on the TARGET board carrying the same rare identifiers as the peer_message below —
  // if the check somehow reached this path, this is exactly what it would try to refuse against.
  createProjectTask(db, "pTargetPeer", { title: SPEC.p1b.title, body: SPEC.p1b.body });
  class SeamHost extends createSeamHost(PtyHost) {
    createPty(opts) { return { ...super.createPty(opts), pid: 1 }; }
    enqueueStdin() { throw new Error("no live target manager in this test — enqueueStdin should never be reached"); }
  }
  const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
  const svc = new SessionService(db, host, new OrchestrationControl());
  const tasksBeforePeer = db.listTasks("pTargetPeer").length;
  const peerResult = svc.messagePeerManager("MGR_PEER", "pTargetPeer", text(SPEC.p1a));
  check("(boarding) peer_message boards a card even though its text duplicates an existing card on the target board",
    peerResult.deliveryStatus === "boarded" && !!peerResult.taskId && !peerResult.error);
  check("(boarding) the duplicate peer_message card actually landed", db.listTasks("pTargetPeer").length === tasksBeforePeer + 1);

  // --- (c) platform-escalation landing still lands a duplicate card (distinct title, duplicate body content) ---
  db.insertProject({ id: "pHomeEsc", name: "Loom Platform", repoPath: tmpHome2, vaultPath: tmpHome2, config: {}, createdAt: now, archivedAt: null, reserved: true });
  db.insertProject({ id: "pOriginEsc", name: "Origin Esc", repoPath: tmpHome2, vaultPath: tmpHome2, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentEsc", projectId: "pOriginEsc", name: "Mgr", startupPrompt: "", position: 0 });
  db.insertSession({
    id: "MGR_ESC", projectId: "pOriginEsc", agentId: "agentEsc", engineSessionId: null, title: null,
    cwd: tmpHome2, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
    role: "manager", parentSessionId: null,
  });
  // A pre-existing card on the Platform board carrying the SAME rare identifiers, under a DIFFERENT title
  // (so platform_escalate's OWN same-title dedup — a real, separate mechanism — can never be what's tested here).
  createProjectTask(db, "pHomeEsc", { title: SPEC.p2a.title, body: SPEC.p2a.body });
  const tasksBeforeEsc = db.listTasks("pHomeEsc").length;
  const escResult = svc.platformEscalate("MGR_ESC", { title: SPEC.p2b.title, detail: SPEC.p2b.body, severity: "high" });
  check("(boarding) platform_escalate lands a fresh card even though its detail duplicates an existing Platform card (distinct title)",
    !!escResult.taskId && !escResult.deduped);
  check("(boarding) the duplicate escalation card actually landed", db.listTasks("pHomeEsc").length === tasksBeforeEsc + 1);

  db.close();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome2, { recursive: true, force: true }); break; } catch { /* WAL/handle retry (Windows) */ } }
} catch (e) {
  check(`boarding-path regression section threw: ${e.stack}`, false);
}

for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry (Windows) */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — findSuspectedDuplicate flags the real 47340c82/dde0ce24 duplicate pair (shared session id + branch, a STRONG match) in BOTH directions and does NOT flag the genuinely distinct negative-control pair (522cf573/66d91a11); card b6eab182's redesign is verified directly — weak evidence (code symbols/file:line/naming conventions), however many distinct categories it spans, NEVER qualifies a match alone (regression-tested against the file:line+error-constant shape and against a strong-less weak match directly), which as an ACCEPTED, explicitly-documented cost also means the module's own founding abcf0eba/bc91e86c pair (caught purely via weak evidence) is no longer auto-flagged; a genuine duplicate sharing a real STRONG identifier (session id) is still blocked, naming the counterpart plus the allowDuplicate/supersedes/relatedTo escape hatches (DoD-2/DoD-4); two genuinely-distinct cards sharing only a code landmark + naming convention now create CLEANLY with no refusal (DoD-1/DoD-3); the three Code-Review-round-2 false-positive mechanisms (ALL-CAPS-as-PascalCase, single-weak-token-sufficient, file:line-single-hit-sufficient) remain regression-tested with a minimal pair (plus one REAL verbatim specimen, aa4e24ff/7acee6d4); ranking (M2) is re-tested among strong-qualifying candidates, the rarity-threshold boundary (m5) and the bounded shared-identifier list (n8) are covered; the tasks_create MCP tool refuses a suspected duplicate naming the counterpart id, is overridable via allowDuplicate/supersedes/relatedTo, and rejects passing both supersedes+relatedTo together (m3); a supersedes/relatedTo override back-links BOTH cards, not just the new one (m7, card 0ef0270b) — the superseded/related (loser) card's own body is back-noted with a pointer to the new card, so either card is discoverable from the other; and every automated boarding path (createProjectTask directly, peer_message boarding, platform-escalation landing) still lands a duplicate card with no refusal — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
