// Boot-not-blocked-on-worktree-GC test (perf card 460d3178). Owner-directed: boot was taking ~2 minutes
// because 8 dangling worktrees with stuck Windows dir handles each blocked reconcile's Pass A/B
// `removeWorktree` for the full GIT_OP_TIMEOUT_MS (15s), and reconcileOrchestrationOnBoot was `await`ed
// in index.ts BEFORE app.listen() — so the port stayed unbound for the whole serial span. The fix moves
// the call to a fire-and-forget kick AFTER app.listen(), keeping the removals serial (never parallelized
// — the threadpool-slot caveat) and the reconcile logic byte-unchanged.
//
// Two proofs, hermetic, no daemon, no real claude:
//   (1) STRUCTURAL — parses src/index.ts's AST (card fdf93d3a) and asserts, by actual syntax-tree shape
//       (not text position/distance): app.listen() is called; sessions.reconcileOrchestrationOnBoot(...)
//       is called strictly AFTER it and is chained `void <call>.then(...).catch(...)` (never `await`ed);
//       reconcileRunsOnBoot (cheap, pure DB) stays synchronous BEFORE listen; the `.then()`/`.catch()`
//       callback bodies still contain the same summary/warn log markers. Reading real syntax-tree node
//       boundaries (not a fixed character budget) means this is immune to unrelated growth near the call
//       site — a longer log line or an added comment changes node text length, not tree shape, so it
//       can't spuriously fail; only an actual `.catch()` removal (or reordering) changes the shape.
//       (Earlier version read compiled dist/index.js and sliced a fixed ~1500-char window from the call
//       site to find the sibling `.catch()` text — that slice-length was sensitive to unrelated nearby
//       text growth and broke twice in one unrelated fix-pass. See card fdf93d3a for the history.)
//   (2) BEHAVIORAL — reusing the SAME BoundedGitDeps.removeDir seam worktrees.mjs already proves bounded,
//       drive N never-resolving "stuck handle" removeWorktree calls SERIALLY through the exact
//       `void chain().then().catch()` idiom index.ts now uses, and prove the caller's next synchronous
//       statement (standing in for app.listen() returning) runs BEFORE any of the N removals settle, while
//       the background chain still completes all N, serially (elapsed ~= N * tinyMs, not ~= tinyMs).
// Run: 1) build daemon, 2) node test/boot-listen-not-blocked.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const { removeWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
// See worktrees.mjs's TIMER_SLACK_MS: MONOTONIC performance.now() + slack for the bounded-timing floor,
// so a loaded CI runner can't flake a lower-bound assertion (v0.3.0 release-CI timing flake).
const TIMER_SLACK_MS = 50;

// ════════ (1) STRUCTURAL — the actual call-site ordering, parsed from the real AST ════════
{
  const srcPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");
  const srcText = fs.readFileSync(srcPath, "utf8");
  const sourceFile = ts.createSourceFile(srcPath, srcText, ts.ScriptTarget.Latest, /* setParentNodes */ true);

  // Every call expression `<...>.<methodName>(...)` in the file, in source order. `receiverName`, when
  // given, restricts matches to `<receiverName>.<methodName>(...)` (a bare identifier receiver) — without
  // it, `listen` would match ANY `.listen(` call in the file (not just `app.listen(`), and the ordering
  // assertions below would silently compare against the wrong call site if one were ever added earlier.
  function findMethodCalls(methodName, receiverName) {
    const out = [];
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === methodName) {
        const receiver = node.expression.expression;
        if (!receiverName || (ts.isIdentifier(receiver) && receiver.text === receiverName)) out.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return out;
  }

  // Given a CallExpression, if it is immediately chained as `<call>.<methodName>(...)`, return that
  // outer CallExpression; else null. Walks real parent-node links, so it's exact regardless of how
  // much text (comments, log content) sits inside either call's arguments.
  function chainedCall(callExpr, methodName) {
    const prop = callExpr.parent;
    if (!prop || !ts.isPropertyAccessExpression(prop) || prop.expression !== callExpr || prop.name.text !== methodName) return null;
    const outer = prop.parent;
    if (!outer || !ts.isCallExpression(outer) || outer.expression !== prop) return null;
    return outer;
  }

  const listenCalls = findMethodCalls("listen", "app");
  const reconcileCalls = findMethodCalls("reconcileOrchestrationOnBoot");
  const runsCalls = findMethodCalls("reconcileRunsOnBoot");

  check("(1) src/index.ts calls app.listen(", listenCalls.length > 0);
  check("(1) src/index.ts calls sessions.reconcileOrchestrationOnBoot( exactly once", reconcileCalls.length === 1);
  check("(1) src/index.ts calls sessions.reconcileRunsOnBoot( exactly once", runsCalls.length === 1);

  const listenPos = listenCalls[0]?.getStart(sourceFile) ?? -1;
  const reconcileCall = reconcileCalls[0];
  const reconcilePos = reconcileCall?.getStart(sourceFile) ?? -1;
  const runsPos = runsCalls[0]?.getStart(sourceFile) ?? -1;

  check("(1) reconcileOrchestrationOnBoot is called AFTER app.listen() (was before — the outage)",
    listenPos >= 0 && reconcilePos >= 0 && reconcilePos > listenPos);
  check("(1) reconcileRunsOnBoot (cheap, pure DB) STAYS synchronous BEFORE app.listen()",
    listenPos >= 0 && runsPos >= 0 && runsPos < listenPos);

  // Fire-and-forget with the error handler genuinely attached: reconcileOrchestrationOnBoot(...) must be
  // chained `.then(...).catch(...)` (not just `.then(...)` with no error handler, and not a bare
  // `await` that would re-block boot), and that whole chain must sit under a `void` operator.
  const thenCall = reconcileCall ? chainedCall(reconcileCall, "then") : null;
  check("(1) reconcileOrchestrationOnBoot(...) is chained with .then(", thenCall !== null);
  const catchCall = thenCall ? chainedCall(thenCall, "catch") : null;
  check("(1) ...then(...) is chained with .catch( — the error handler is genuinely attached", catchCall !== null);
  check("(1) the whole chain is void-kicked (fire-and-forget, never awaited)",
    catchCall !== null && catchCall.parent !== undefined && ts.isVoidExpression(catchCall.parent) && catchCall.parent.expression === catchCall);

  // The .then()/.catch() callback bodies still carry the same summary/warn log markers — bounded by
  // the REAL syntax-tree extent of each callback's argument, not a character budget, so growing the
  // log text or adding a comment anywhere near the call site cannot push content out of range.
  const thenCallbackText = thenCall ? thenCall.arguments[0]?.getText(sourceFile) ?? "" : "";
  const catchCallbackText = catchCall ? catchCall.arguments[0]?.getText(sourceFile) ?? "" : "";
  check("(1) the backgrounded reconcile still logs its boot summary on success",
    /\[boot\] orchestration reconcile:/.test(thenCallbackText));
  check("(1) the backgrounded reconcile still warns (swallowed) on failure",
    /\[boot\] orchestration reconcile failed \(continuing boot\)/.test(catchCallbackText));
}

// ════════ (2) BEHAVIORAL — N never-resolving "stuck handle" removals don't block the caller ════════
{
  const N = 8; // mirrors the owner's reported 8-dangler outage
  const tinyMs = 120; // small but nonzero: distinguishes "returned instantly" from "waited ~the bound"
  const stubFastGit = () => ({ raw: async () => "" }); // git ops succeed fast → only the removal hangs
  const neverRemoveDir = () => new Promise(() => {}); // a stuck dir handle: this removal never settles
  const repoDummy = path.dirname(fileURLToPath(import.meta.url)); // never touched: git ops are stubbed

  // Mirrors reconcile's Pass B loop: SERIAL `await`ed removeWorktree calls (never parallelized — each
  // removal now runs in its own OS process, but Pass B still processes worktrees one at a time).
  async function serialPassB() {
    let processed = 0;
    for (let i = 0; i < N; i++) {
      await removeWorktree(repoDummy, path.join(repoDummy, `stuck-${i}`), { gitFactory: stubFastGit, removeDir: neverRemoveDir, timeoutMs: tinyMs });
      processed++;
    }
    return processed;
  }

  let reachedListen = false;
  const t0 = performance.now(); // MONOTONIC (see TIMER_SLACK_MS)
  const backgroundDone = new Promise((resolve) => {
    // The EXACT idiom index.ts now uses: void <call>().then(...).catch(...) — never awaited.
    void serialPassB().then((n) => resolve({ n, elapsed: performance.now() - t0 })).catch(() => resolve({ n: -1, elapsed: performance.now() - t0 }));
  });
  reachedListen = true; // stands in for "boot reaches app.listen()" — runs in the SAME synchronous tick

  check("(2) the caller's next statement (stand-in for app.listen()) runs BEFORE any removal settles",
    reachedListen === true && (performance.now() - t0) < tinyMs);

  const { n: processed, elapsed } = await backgroundDone;
  check(`(2) the background reconcile still processes all ${N} stuck worktrees (got ${processed})`, processed === N);
  check(`(2) removals ran SERIALLY, not parallelized — elapsed ${Math.round(elapsed)}ms ~= ${N}*${tinyMs}ms, not ~= ${tinyMs}ms`,
    elapsed >= N * tinyMs - TIMER_SLACK_MS);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the built daemon calls app.listen() BEFORE the fire-and-forget reconcileOrchestrationOnBoot kick (reconcileRunsOnBoot stays synchronous before listen); and N never-resolving stuck-handle removals (the BoundedGitDeps.rm seam) still let the caller's next statement run immediately while the background reconcile keeps processing them serially to completion."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
