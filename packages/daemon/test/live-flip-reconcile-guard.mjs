import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no daemon/Db used below, pure source scan
// STANDING GUARD (card 8b194419, Code Review finding #2 on 6ca4155f) — every site in
// packages/daemon/src/sessions/service.ts that flips a session row to processState:"live" BEFORE wiring
// its pty must be followed, in the SAME block, by a try/catch whose catch reconciles that row via
// reconcileFailedSpawn — the shared helper 6ca4155f introduced so a synchronous throw between the flip
// and a successful pty.spawn never strands the row phantom-live. That invariant is otherwise
// CALLER-OWNED: 14 near-identical `try { ...; this.pty.spawn(...); } catch (e) { this.reconcileFailedSpawn(...); throw e; }`
// blocks (one per live-flip spawn site) keep "flip live" and "reconcile on throw" separable, so a future
// 15th site can omit the catch silently — exactly the shape this guard exists to catch, the same day it's
// introduced rather than the next time someone traces a phantom-live row by hand.
//
// v2 (Code Review, same card): the FIRST version of this scanner was too loose — it verified only "a try
// exists and ITS catch calls reconcileFailedSpawn SOMEWHERE", which the reviewer falsified with 10 of 11
// probes: a throwing statement between flip and try, `pty.spawn` sitting OUTSIDE the try it "found",
// a conditional/nested/wrong-id reconcile call, a catch that never rethrows, and a live-flip inside a
// catch clause excluded unconditionally rather than only when that SAME catch already reconciles a
// DIFFERENT row. This version tightens every one of those — see THE INVARIANT CHECKED below — and the
// POSITIVE CONTROL block reproduces every falsifying probe as its own named check.
//
// SCOPE DECISION 1 — a guard over a shared helper: the card's own finding offered two directions — "a
// helper that owns flip + try + reconcile together, OR at minimum a static guard test". A shared
// flip+try+reconcile helper would need a materially different shape for the three recycle sites
// (recycleWorker/recycleManager/recyclePlatformLead), whose catches do MORE than reconcileFailedSpawn
// alone (restore-old-to-live, unlink recycledFrom, archive, audit-event — see decisions 4be56c33/
// 08320d02) than for the eleven plain start*/resume sites — refactoring all fourteen onto one helper is
// real, wide-reaching surgery for a P3 non-blocking follow-up finding. This guard is the lower-risk "at
// minimum" option the finding itself names as acceptable; the report accompanying this card recommends
// the helper refactor as a follow-up a human can size deliberately, rather than silently taking the
// larger, riskier path.
//
// SCOPE DECISION 2 — NOT a `STATIC_GUARD_REPO_PATHS` member, deliberately (Code Review finding on card
// 8b194419 itself): that list exists for a guard whose verdict something OTHER than a behavioural
// `service.ts` edit can invalidate — a `.mjs` test-corpus change it must re-scan, a comment-only diff the
// transpile-identity emit-compare proof can't see through (the reason `working-tree-eol-guard.mjs` and
// `real-home-scope-guard.mjs` are always-run members). This guard reads the real TS AST — it is
// COMMENT-BLIND by construction (a `//` line carries no syntax node) — so the ONLY thing that can flip
// its verdict is a genuine BEHAVIOURAL change to `sessions/service.ts`'s live-flip/try/catch shape. That
// is exactly the class of diff emit-compare's own transpile-identity proof does NOT reduce the gate on:
// a behavioural `.ts` change always runs the full corpus, which runs this file anyway (bare `node <path>`,
// same as any other test). Same reasoning `emit-compare-soundness-guard.mjs`'s own membership-criterion
// doc comment gives for its own exclusion from that list — see that file for the fuller argument. Run
// standalone via `node <path>` (no build needed — see the header note below), identical invocation shape
// to a `STATIC_GUARD_REPO_PATHS` member; it just never needs to be ONE to get exercised on every diff that
// could actually break it.
//
// WHAT THIS IS: a static AST scan (via the `typescript` compiler API — same dependency, same walk+check
// shape as onexit-discard-guard.mjs) over ONE real source file's TS syntax tree — not compiled output (no
// build needed first; contrast the emit-compare DIST_TEXT_SCANNER_REPO_PATHS class, which this is not).
//
// THE INVARIANT CHECKED, PRECISELY: for every call `<expr>.setProcessState(<id>, "live")` —
//   1. find the nearest enclosing BLOCK the call's own statement is a direct member of;
//   2. skip it ONLY if that block belongs to a CatchClause that ITSELF, as one of its own direct
//      statements, already calls `reconcileFailedSpawn` — the legitimate restore-inside-a-catch shape
//      (recyclePlatformLead's catch reconciles the FRESH successor, then restores the OLD row to 'live'
//      in the same catch; see decision 08320d02). A live-flip inside a catch clause that has NO
//      reconcile call of its own is NOT excluded — it is checked exactly like any other flip (v2 fix:
//      the reviewer's "FRESH flip+spawn inside a catch clause" false negative — v1's exclusion fired on
//      ANY catch clause, unconditionally);
//   3. scan FORWARD through that same block's remaining statements. Each intervening statement, before
//      the next `try`, must be either an INITIALIZER-FREE variable declaration (`let x: T;` — cannot
//      throw, nothing is evaluated) or a call to a small NAMED ALLOWLIST (today: `releaseCapSlotClaim`,
//      spawnWorker's own bookkeeping call) — the only two shapes the real corpus uses between a flip and
//      its try. Any OTHER intervening statement (an initializer that evaluates an expression, a call not
//      on the allowlist, an `if`, an early `return`, …) is a violation in its own right: it could itself
//      throw UNCAUGHT before the reconciling try is ever reached (v2 fix: the reviewer's "throwing
//      statement between flip and try" and "early return" false negatives — v1 accepted ANY intervening
//      statement);
//   4. require the found try's OWN block to actually contain a `this.pty.spawn(...)` call (recursively —
//      it may be nested inside other expressions) — not merely that SOME try/catch downstream reconciles
//      (v2 fix: the reviewer's "pty.spawn placed AFTER the try/catch" false negative);
//   5. require a `catch` clause whose block contains `reconcileFailedSpawn(...)` as a DIRECT, unconditional
//      statement (not nested inside an `if`, not inside an uncalled closure — v2 fix: the reviewer's
//      "conditional reconcile" and "reconcile inside an uncalled closure" false negatives), called with
//      the SAME first argument (compared as source text) as the flip's own first argument (v2 fix: the
//      reviewer's "reconcile on a different id" false negative);
//   6. require the catch block's OWN LAST statement to be a `throw` (v2 fix: the reviewer's "a catch that
//      swallows and returns live" false negative — a catch that reconciles but never rethrows still
//      reports success on a failed spawn).
//
// WHAT THIS CANNOT SEE (stated plainly, per DoD-2, mirroring onexit-discard-guard.mjs's own posture):
//   - Only the NEXT try statement in the same block is checked — a violation could theoretically hide
//     behind a closer, unrelated try/catch that doesn't reconcile while a LATER one in the same block
//     does; not observed anywhere in this real corpus. Covered by its own falsification check below
//     (kept from v1, still a real boundary, not a miss).
//   - `"live"` reached via a VARIABLE or TEMPLATE LITERAL (`setProcessState(id, someVar)` where `someVar`
//     is `"live"` at runtime, or `` setProcessState(id, `live`) ``) is invisible — `isLiveFlipCall` only
//     matches a literal string-literal `"live"`. Not observed anywhere in this real corpus (every flip
//     spells it as a plain string literal); accepted as a documented gap rather than a fix (Code Review,
//     card 8b194419) — closing it needs either a constant-folding pass or a broader "any string-valued
//     2nd argument to setProcessState" scan, out of proportion to a gap this corpus doesn't exhibit today.
//   - The named-allowlist check (step 3 above) is a FIXED list of TODAY's known-safe intervening shapes,
//     not a general "prove this statement cannot throw" analysis — a future intervening statement this
//     guard doesn't recognize (even a genuinely safe one) is correctly treated as a violation until the
//     allowlist is deliberately widened by a human who has verified it cannot throw. This is a stated
//     false-positive risk, not a false-negative one — the guard errs toward flagging, never toward
//     silently trusting a new shape.
//   - A flip nested inside an `if`/`for`/`while` block rather than directly in its enclosing
//     function/try block is not specially handled — none exist in this corpus today (verified: every
//     real flip is a direct statement in its function body or an outer try block). Real interprocedural
//     analysis (a flip inside a helper THIS method calls) is out of scope, as it is for the sibling guard.
//
// Run: node packages/daemon/test/live-flip-reconcile-guard.mjs (no build needed — pure source-text/AST scan)
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(__filename);
const SERVICE_TS = path.join(TEST_DIR, "..", "src", "sessions", "service.ts");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ---------------------------------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------------------------------

/** Is `node` a call `<expr>.setProcessState(<any>, "live")`? */
function isLiveFlipCall(node) {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "setProcessState") return false;
  const second = node.arguments[1];
  return !!second && ts.isStringLiteral(second) && second.text === "live";
}

/** Is `node` a call `<expr>.reconcileFailedSpawn(...)`? */
function isReconcileCall(node) {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "reconcileFailedSpawn";
}

/** Is `node` a call `<expr>.pty.spawn(...)`? (checks THE ACTUAL guarded spawn is inside the try, not
 *  merely that a try/catch exists somewhere downstream — v2 fix, see header step 4.) */
function isPtySpawnCall(node) {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "spawn") return false;
  const obj = node.expression.expression;
  return ts.isPropertyAccessExpression(obj) && obj.name.text === "pty";
}

/** Walk up from `node` to the nearest ancestor that is itself a direct member of an enclosing Block's
 *  `.statements` array. Returns {block, statement} or null (e.g. at the top of a source file). */
function enclosingBlockStatement(node) {
  let cur = node;
  while (cur.parent) {
    const p = cur.parent;
    if (ts.isBlock(p) && p.statements.includes(cur)) return { block: p, statement: cur };
    cur = p;
  }
  return null;
}

/** Does any node within `root` (inclusive) satisfy `pred`? */
function containsMatching(root, pred) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (pred(n)) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return found;
}

// Named allowlist of intervening-statement CALL NAMES the real corpus uses TODAY between a live-flip and
// its reconciling try (see header step 3 + WHAT THIS CANNOT SEE). Only `releaseCapSlotClaim`
// (spawnWorker) — every other real site's only intervening statements are initializer-free `let`
// declarations, handled separately below.
const ALLOWED_INTERVENING_CALL_NAMES = new Set(["releaseCapSlotClaim"]);

/** Is `stmt` one of the two known-safe shapes allowed between a flip and its try? */
function isAllowedInterveningStatement(stmt) {
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations.every((d) => d.initializer === undefined);
  }
  if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
    const callee = stmt.expression.expression;
    const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : (ts.isIdentifier(callee) ? callee.text : null);
    if (name && ALLOWED_INTERVENING_CALL_NAMES.has(name)) return true;
  }
  return false;
}

/** The DIRECT (non-recursive) `ExpressionStatement` in `block.statements` calling reconcileFailedSpawn,
 *  or null — "direct" is load-bearing: a conditional/nested/closure-wrapped call does not count (header
 *  step 5). */
function directReconcileStatement(block) {
  for (const stmt of block.statements) {
    if (ts.isExpressionStatement(stmt) && isReconcileCall(stmt.expression)) return stmt;
  }
  return null;
}

/** Check ONE live-flip call site against every rule in THE INVARIANT CHECKED (header). Returns a
 *  `{line, snippet, reason}` hit, or null if the site is clean. */
function checkFlip(sf, node) {
  const loc = enclosingBlockStatement(node);
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const snippet = node.getText(sf).slice(0, 100);
  const flipIdText = node.arguments[0] ? node.arguments[0].getText(sf).trim() : null;

  if (!loc) return { line, snippet, reason: "live-flip call is not a direct statement of any enclosing block (unhandled shape)" };

  // Step 2: excluded ONLY when this catch clause ITSELF already reconciles a (different) row — the
  // restore-inside-a-catch shape. A live-flip inside a catch with no reconcile of its own is NOT
  // excluded (v2 fix) and falls through to the normal checks below.
  if (ts.isCatchClause(loc.block.parent) && directReconcileStatement(loc.block)) return null;

  // Step 3: walk forward tolerating only the two known-safe intervening shapes.
  const stmts = loc.block.statements;
  let i = stmts.indexOf(loc.statement) + 1;
  let blocker = null;
  let tryStmt = null;
  while (i < stmts.length) {
    if (ts.isTryStatement(stmts[i])) { tryStmt = stmts[i]; break; }
    if (!isAllowedInterveningStatement(stmts[i])) { blocker = stmts[i]; break; }
    i++;
  }
  if (!tryStmt) {
    return {
      line, snippet,
      reason: blocker
        ? "a statement between the flip and any following try is neither an initializer-free variable declaration nor an allowlisted call — it could itself throw, uncaught, before the reconciling try is ever reached"
        : "no following try statement in the same block",
    };
  }

  // Step 4: the try's OWN block must actually contain the guarded pty.spawn call.
  if (!containsMatching(tryStmt.tryBlock, isPtySpawnCall)) {
    return { line, snippet, reason: "the following try's own block never calls this.pty.spawn(...) — the actual spawn may sit unprotected outside it" };
  }
  if (!tryStmt.catchClause) return { line, snippet, reason: "the following try statement has no catch clause" };

  // Step 5: a DIRECT, unconditional reconcile call on the SAME id.
  const catchBlock = tryStmt.catchClause.block;
  const reconcileStmt = directReconcileStatement(catchBlock);
  if (!reconcileStmt) {
    return { line, snippet, reason: "the following try/catch does not call reconcileFailedSpawn as a direct, unconditional statement of the catch block (a conditional/nested/wrong-target call does not count)" };
  }
  const reconcileArg = reconcileStmt.expression.arguments[0];
  const reconcileIdText = reconcileArg ? reconcileArg.getText(sf).trim() : null;
  if (flipIdText !== null && reconcileIdText !== flipIdText) {
    return { line, snippet, reason: `reconcileFailedSpawn is called with a different id ('${reconcileIdText}') than the flip's own id ('${flipIdText}')` };
  }

  // Step 6: the catch must actually rethrow — its own last statement is a throw.
  const last = catchBlock.statements[catchBlock.statements.length - 1];
  if (!last || !ts.isThrowStatement(last)) {
    return { line, snippet, reason: "the catch block does not end in a throw — a swallowed spawn failure would silently report success" };
  }

  return null;
}

/**
 * THE ONE traversal — scan a parsed `SourceFile` for live-flip sites violating any rule in THE INVARIANT
 * CHECKED above. Both the real scan and the positive-control block below call THIS function (never a
 * re-implementation) — see onexit-discard-guard.mjs's own header for why that matters (a control
 * exercising a separate copy of the walk certifies nothing about what the real scan does).
 */
function scanSourceFile(sf) {
  const hits = [];
  const visit = (node) => {
    if (isLiveFlipCall(node)) {
      const hit = checkFlip(sf, node);
      if (hit) hits.push(hit);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/** Scan a synthetic source SNIPPET (not a real file) through `scanSourceFile`. */
function scanSnippet(text) {
  const sf = ts.createSourceFile("synthetic.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return scanSourceFile(sf);
}

// =====================================================================================================
// POSITIVE CONTROL — prove the scanner can actually catch a missing/broken catch (RED), and correctly
// clears every real shape this corpus uses (GREEN), before trusting a "clean" result on the real file.
// Each [falsification] BAD case below reproduces one of the 11 probes Code Review ran against v1 of this
// file (card 8b194419) — labeled (a)-(h) matching the review comment's own lettering.
// =====================================================================================================
{
  // --- BAD: flagged shapes ---
  check(
    "[falsification] flags a live-flip with NO following try statement at all",
    scanSnippet(`class S { f() { this.db.setProcessState(id, "live"); return session; } }`).length > 0
  );
  check(
    "[falsification] flags a live-flip whose following try/catch does NOT call reconcileFailedSpawn",
    scanSnippet(`class S { f() { this.db.setProcessState(id, "live"); try { this.pty.spawn(x); } catch (e) { throw e; } } }`).length > 0
  );
  check(
    "[falsification] flags a live-flip whose following try has NO catch clause at all (try/finally only)",
    scanSnippet(`class S { f() { this.db.setProcessState(id, "live"); try { this.pty.spawn(x); } finally { cleanup(); } } }`).length > 0
  );
  check(
    "[falsification] flags a live-flip whose NEAREST following try/catch doesn't reconcile, even if a LATER one in the block would (stated blind-spot boundary, not a miss)",
    scanSnippet(`class S { f() { this.db.setProcessState(id, "live"); try { a(); } catch (e) { throw e; } try { this.pty.spawn(x); } catch (e) { this.reconcileFailedSpawn(id, e); throw e; } } }`).length > 0
  );
  check(
    "[falsification] (a) flags a THROWING statement between flip and try (was a false negative in v1 — reviewer's own repro)",
    scanSnippet(`class S { f() { this.db.setProcessState(id, "live"); const p = this.compose(JSON.parse(y)); try { this.pty.spawn(x); } catch (e) { this.reconcileFailedSpawn(id, e); throw e; } } }`).length > 0
  );
  check(
    "[falsification] (b) flags pty.spawn placed AFTER the try/catch — the exact 6ca4155f defect shape (was a false negative in v1)",
    scanSnippet(`class S { f() { this.db.setProcessState(id, "live"); try { something(); } catch (e) { this.reconcileFailedSpawn(id, e); throw e; } this.pty.spawn(x); } }`).length > 0
  );
  check(
    "[falsification] (c) flags a CONDITIONAL reconcile call (nested inside an if — was a false negative in v1)",
    scanSnippet(`class S { f() { this.db.setProcessState(id, "live"); try { this.pty.spawn(x); } catch (e) { if (cond) { this.reconcileFailedSpawn(id, e); } throw e; } } }`).length > 0
  );
  check(
    "[falsification] flags a reconcile call inside an UNCALLED CLOSURE (never actually invoked — was a false negative in v1)",
    scanSnippet(`class S { f() { this.db.setProcessState(id, "live"); try { this.pty.spawn(x); } catch (e) { const g = () => { this.reconcileFailedSpawn(id, e); }; throw e; } } }`).length > 0
  );
  check(
    "[falsification] (e) flags reconcileFailedSpawn called with a DIFFERENT id than the flip's own (was a false negative in v1)",
    scanSnippet(`class S { f() { this.db.setProcessState(id, "live"); try { this.pty.spawn(x); } catch (e) { this.reconcileFailedSpawn(other.id, e); throw e; } } }`).length > 0
  );
  check(
    "[falsification] flags a catch that reconciles but SWALLOWS the error (returns instead of rethrowing — was a false negative in v1)",
    scanSnippet(`class S { f() { this.db.setProcessState(id, "live"); try { this.pty.spawn(x); } catch (e) { this.reconcileFailedSpawn(id, e); return session; } } }`).length > 0
  );
  check(
    "[falsification] flags an EARLY RETURN between the flip and its try (was a false negative in v1)",
    scanSnippet(`class S { f() { this.db.setProcessState(id, "live"); if (x) return session; try { this.pty.spawn(x); } catch (e) { this.reconcileFailedSpawn(id, e); throw e; } } }`).length > 0
  );
  check(
    "[falsification] (h) flags a FRESH flip+spawn genuinely nested inside an unrelated catch clause that has NO reconcile of its own (v1's catch-clause exclusion fired unconditionally; was a false negative)",
    scanSnippet(`class S { f() { try { risky(); } catch (e) { this.db.setProcessState(fresh.id, "live"); this.pty.spawn(x); } } }`).length > 0
  );

  // --- GOOD: the real corpus's own shapes must clear ---
  check(
    "[falsification] clears a live-flip immediately followed by a try/catch that reconciles",
    scanSnippet(`class S { f() { this.db.setProcessState(id, "live"); try { this.pty.spawn(x); } catch (e) { this.reconcileFailedSpawn(id, e); throw e; } } }`).length === 0
  );
  check(
    "[falsification] clears a live-flip followed by an INITIALIZER-FREE variable declaration, then a reconciling try/catch (the startManager/recycleWorker shape — `let codescapeStatus: T;` before the try)",
    scanSnippet(`class S { f() { this.db.setProcessState(id, "live"); let codescapeStatus: T; try { codescapeStatus = this.resolve(project); this.pty.spawn(x); } catch (e) { this.reconcileFailedSpawn(id, e); throw e; } } }`).length === 0
  );
  check(
    "[falsification] clears a live-flip followed by the ALLOWLISTED releaseCapSlotClaim() call plus initializer-free declarations, then a reconciling try/catch (spawnWorker's exact real shape)",
    scanSnippet(`class S { async f() { this.db.setProcessState(worker.id, "live"); this.releaseCapSlotClaim(); let workerProjectMemoryFramed: string | null; let codescapeStatus: T; try { this.pty.spawn(opts); } catch (e) { this.reconcileFailedSpawn(worker.id, e); throw e; } } }`).length === 0
  );
  check(
    "[falsification] clears the NESTED-OUTER-TRY shape (spawnWorker): the flip sits inside an outer try block, and the reconciling inner try/catch is a LATER sibling statement in that SAME outer block",
    scanSnippet(`class S { async f() { try { this.db.insertSession(w); this.db.setProcessState(w.id, "live"); this.releaseCapSlotClaim(); let x; try { this.pty.spawn(opts); } catch (e) { this.reconcileFailedSpawn(w.id, e); throw e; } } catch (outer) { throw outer; } } }`).length === 0
  );
  check(
    "[falsification] clears a catch whose reconcile call is not the catch's ONLY statement, provided it's DIRECT + unconditional + same-id + the block still ends in throw (the three recycle sites' real shape)",
    scanSnippet(`class S { f() { this.db.setProcessState(fresh.id, "live"); try { this.pty.spawn(x); } catch (e) { this.reconcileFailedSpawn(fresh.id, e); this.db.setProcessState(old.id, "live"); this.db.archiveSession(fresh.id); throw e; } } }`).length === 0
  );
  check(
    "[falsification] clears a FRESH flip+spawn genuinely nested inside an unrelated catch clause WHEN it is properly guarded by its OWN inner try/catch (proves the narrowed catch-clause exclusion doesn't over-flag legitimate nesting, symmetric with the (h) BAD case above)",
    scanSnippet(`class S { f() { try { risky(); } catch (e) { this.db.setProcessState(fresh.id, "live"); try { this.pty.spawn(x); } catch (e2) { this.reconcileFailedSpawn(fresh.id, e2); throw e2; } } } }`).length === 0
  );

  // --- THE DISCRIMINATOR ITSELF: prove it tells a fresh flip apart from an UNRELATED flip-to-'exited'
  // and from a RESTORE-to-'live' that legitimately lives inside a catch clause which ITSELF already
  // reconciles a different row (decision 08320d02) — vs. the (h) BAD case above, which is the SAME
  // "inside a catch clause" shape but with NO reconcile of its own, and must NOT be excluded. ---
  check(
    "[discriminator] does NOT flag a flip to 'exited' (wrong literal — not a live-flip at all)",
    scanSnippet(`class S { f() { this.db.setProcessState(id, "exited"); } }`).length === 0
  );
  check(
    "[discriminator] does NOT flag a 'live' restore that lives directly inside a catch clause which ITSELF already reconciles a DIFFERENT row (recyclePlatformLead's own restore-old-to-live shape) — even with no following try",
    scanSnippet(`class S { f() { try { this.pty.spawn(x); } catch (e) { this.reconcileFailedSpawn(fresh.id, e); this.db.setProcessState(old.id, "live"); throw e; } } }`).length === 0
  );
  check(
    "[discriminator] DOES flag a 'live' restore inside a catch clause that does NOT itself reconcile anything (the narrowed exclusion's own negative space — contrast the check above)",
    scanSnippet(`class S { f() { try { this.pty.spawn(x); } catch (e) { this.db.setProcessState(old.id, "live"); throw e; } } }`).length > 0
  );

  // --- DOCUMENTED GAP (WHAT THIS CANNOT SEE, accepted per Code Review on card 8b194419): a "live" value
  // reached via a variable or template literal is invisible to isLiveFlipCall's literal string-literal
  // match. Asserted here so the gap is a proven, current fact rather than an unverified claim in prose —
  // and so a future narrowing of the isLiveFlipCall match is caught if it accidentally starts matching this. ---
  check(
    "[documented gap] does NOT see a 'live' flip spelled via a variable (`setProcessState(id, liveStr)`) — accepted gap, not observed in this real corpus",
    scanSnippet(`class S { f() { const liveStr = "live"; this.db.setProcessState(id, liveStr); return session; } }`).length === 0
  );
}

// =====================================================================================================
// THE REAL SCAN — packages/daemon/src/sessions/service.ts.
// =====================================================================================================

const text = fs.readFileSync(SERVICE_TS, "utf8");
const sf = ts.createSourceFile(SERVICE_TS, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

// Population control (card 6e9a9209 class B): prove the real scan actually opened + parsed a non-trivial
// file, not that it silently found nothing because it never ran — count every setProcessState(...) call
// (any state) as the population floor, independent of the "live" filter above.
const anySetProcessStateCalls = [];
{
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "setProcessState") anySetProcessStateCalls.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
check(`the real file was parsed and scanned (found ${anySetProcessStateCalls.length} total setProcessState(...) calls of any kind)`, anySetProcessStateCalls.length >= 10);

const realHits = scanSourceFile(sf);
// MEASURED (this run): 14 "live" flips outside a catch — 13 original reconcileFailedSpawn call sites
// (card 6ca4155f) + spawnWorker's own, folded onto the shared helper by this same card (item 3) — all 14
// now clear this guard uniformly. The exact count is NOT hardcoded as a pass/fail floor (a legitimate
// future 15th site raises it without needing this guard edited) — only reported for visibility.
const liveFlipCount = (() => {
  let n = 0;
  const visit = (node) => {
    if (isLiveFlipCall(node)) {
      const loc = enclosingBlockStatement(node);
      const excludedRestore = loc && ts.isCatchClause(loc.block.parent) && directReconcileStatement(loc.block);
      if (!excludedRestore) n++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
})();
check(`at least one real live-flip site was found to check (found ${liveFlipCount}, restore-inside-a-reconciling-catch excluded)`, liveFlipCount >= 1);

check(`every live-flip spawn site in service.ts is followed by a reconciling try/catch (found ${realHits.length} violation(s))`, realHits.length === 0);
for (const h of realHits) {
  console.log(`  VIOLATION  service.ts:${h.line}  ${h.reason}`);
  console.log(`             ${h.snippet}`);
}

console.log(failures === 0
  ? `\n✅ ALL PASS — every processState:"live" flip in sessions/service.ts (${liveFlipCount} sites) is followed, in the same block, by a try/catch that guards the real pty.spawn call and reconciles that SAME id, unconditionally, before rethrowing — the invariant 6ca4155f introduced holds structurally, not just where a human happened to check. See this file's header for its stated blind spots.`
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
