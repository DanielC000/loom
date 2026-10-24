import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure fs/regex below, no daemon/Db used
// RAW-TRANSACTION APPENDEVENT-REACHABILITY GUARD (card 18689f24, follow-up to card 87b1c8a1 —
// docs/decisions/87b1c8a1-defer-pin-events-until-commit.md).
//
// `Db.appendEvent` (db.ts) now QUEUES its listener notification while `this.db.inTransaction` is true,
// and only the public `Db.runInTransaction` ever FLUSHES that queue (after its own outermost, non-nested
// commit) or TRUNCATES it back to its entry snapshot (on its own throw). A raw `this.db.transaction(...)`
// mutator that reaches `appendEvent` (directly, or transitively through another Db method it calls) never
// flushes or truncates anything — the queued notification sits until some UNRELATED later
// `runInTransaction` call happens to flush it (arbitrarily late), or never does; on a rollback it is never
// truncated at all, so a rolled-back event could still announce itself, reopening 87b1c8a1's bug.
//
// This is executor option (b) from card 18689f24's two offered executors: a STATIC test, not a source
// rewrite of the ~34-38 raw `this.db.transaction(` sites in db.ts (several on hot paths) — chosen because
// a blanket conversion's blast radius is not uniform per call site (see the card body), while this check
// gives the SAME protection (catching a future regression at the exact moment it's introduced) with zero
// behavioural change to any existing call site.
//
// METHOD (reads real packages/daemon/src/db.ts SOURCE TEXT via fs.readFileSync, never imports it):
//   1. Strip line comments and block comments (string/template-literal aware — see stripComments) so that comment
//      PROSE mentioning `this.appendEvent(`/`this.db.transaction(` (db.ts has exactly this prose, e.g. the
//      doc comment immediately above `runInTransaction` itself) can never be mistaken for a real call.
//      This is what makes this guard IMMUNE to a comment-only diff — see worktrees.ts's own
//      CHANGED_TS_TEXT_SCANNER_REPO_PATHS doc, shape (3): an explicit comment-stripped whole-file scan is
//      already immune by construction, so this file is NOT added to that list (stated explicitly in this
//      card's own worker_report, per the card's own DoD instruction to say what was decided).
//   2. Locate the `class Db { ... }` body by brace-depth matching (string/template-aware) from its
//      declaration.
//   3. Walk the class body at brace-depth 0 to split it into named methods (brace-depth matching again,
//      so a multi-line signature or deeply nested method body is handled the same as a one-liner — this
//      extraction does NOT depend on line structure at all). A `{`-opening construct whose preceding
//      signature text doesn't match a `name(` / `name<T>(` shape (e.g. a class-field object/array default)
//      is kept as an unnamed, unaddressable node — still scanned for calls, just never a graph EDGE TARGET.
//   4. Build a call graph: for each named method, every `this.<name>(` occurring anywhere in its body
//      (textual — see LIMITATIONS below).
//   5. Compute the transitive closure of "reaches appendEvent" over that graph (fixed-point iteration).
//   6. Find every `this.db.transaction(` call site in the class body, extract its callback argument via
//      paren-balance (string/template-aware), and flag it if that callback text itself calls
//      `this.appendEvent(` or any method in the closure from step 5 — EXCEPT the one sanctioned
//      passthrough shape `this.db.transaction(fn)()` (a bare identifier argument — `runInTransaction`'s own
//      implementation, which can never be text-scanned since the callback is a runtime parameter; asserted
//      below to be exactly the one site this is, by name, as a sanity cross-check).
//
// LIMITATIONS (named per this file's own scope/limits requirement — read before trusting a clean run as
// proof of anything these don't cover):
//   - Call-graph edges are purely TEXTUAL (`this.<identifier>(`). A call through a stored reference
//     (`const f = this.appendEvent; f(...)`) or dynamic property access (`this["appendEvent"](...)`) is
//     invisible to this check. Neither shape appears anywhere in db.ts today (grepped); if one is ever
//     added, this guard cannot see it.
//   - A call to a FREE FUNCTION (not `this.<name>(`) that itself calls back into `this.appendEvent` via a
//     captured `this` (e.g. a closure handed to a free helper) is invisible. db.ts's own free functions
//     (outside the Db class, e.g. `toMergeGateState` at the bottom of the file) never receive `this` this
//     way today.
//   - This guard is intentionally scoped to ONE class (`Db`) in ONE file (db.ts) — the exact scope
//     87b1c8a1 and this card's own body describe. It says nothing about any other class.
//
// Run: node packages/daemon/test/raw-tx-appendevent-reach-guard.mjs (no build needed — pure fs/regex)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const DB_TS_PATH = path.join(repoRoot, "packages", "daemon", "src", "db.ts");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ── Tokenizer helpers — string/template literal aware, shared by comment-stripping and brace-matching ──

/** Strip line comments and block comments from `src`, preserving every other byte (including
 *  string/template contents verbatim) and the overall newline count (so a line-count-based diagnostic
 *  stays roughly aligned). String literals are quote-aware so a string containing a block-comment-opener-
 *  looking substring (db.ts has one: the `deny_globs` default `'["mockups/**"]'` contains the two
 *  characters slash-then-star inside "mockups" followed by two stars) is never mistaken for a comment
 *  start. */
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : "";
    if (c === "/" && c2 === "/") {
      let j = src.indexOf("\n", i);
      if (j === -1) j = n;
      i = j;
      continue;
    }
    if (c === "/" && c2 === "*") {
      let j = src.indexOf("*/", i + 2);
      if (j === -1) j = n; else j += 2;
      const removed = src.slice(i, j);
      for (const ch of removed) if (ch === "\n") out += "\n";
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === quote) { j++; break; }
        if (src[j] === "\n") break; // unterminated single-line string literal; bail conservatively
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      let depth = 0; // nested `${ ... }` depth within the template literal
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (depth === 0 && src[j] === "`") { j++; break; }
        if (src[j] === "$" && src[j + 1] === "{") { depth++; j += 2; continue; }
        if (depth > 0 && src[j] === "{") { depth++; j++; continue; }
        if (depth > 0 && src[j] === "}") { depth--; j++; continue; }
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Find the index of the `}` that matches the `{` at `openIdx`, scanning `src` (already comment-stripped)
 *  and skipping over string/template literal contents so a brace inside one is never counted. Returns -1
 *  if unbalanced (never happens on well-formed, already-comment-stripped TypeScript). */
function matchingBrace(src, openIdx) {
  const n = src.length;
  let depth = 1;
  let i = openIdx + 1;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        if (src[i] === "\n") break;
        i++;
      }
      continue;
    }
    if (c === "`") {
      i++;
      let tdepth = 0;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (tdepth === 0 && src[i] === "`") { i++; break; }
        if (src[i] === "$" && src[i + 1] === "{") { tdepth++; i += 2; continue; }
        if (tdepth > 0 && src[i] === "{") { tdepth++; i++; continue; }
        if (tdepth > 0 && src[i] === "}") { tdepth--; i++; continue; }
        i++;
      }
      continue;
    }
    if (c === "{") { depth++; i++; continue; }
    if (c === "}") { depth--; i++; if (depth === 0) return i - 1; continue; }
    i++;
  }
  return -1;
}

/** Same string/template-aware scan as {@link matchingBrace}, but for the `)` matching an already-consumed
 *  `(` at `openIdx` (the char AFTER the opening paren). Returns -1 if unbalanced. */
function matchingParen(src, startAfterOpenParen) {
  const n = src.length;
  let depth = 1;
  let i = startAfterOpenParen;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        if (src[i] === "\n") break;
        i++;
      }
      continue;
    }
    if (c === "`") {
      i++;
      let tdepth = 0;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (tdepth === 0 && src[i] === "`") { i++; break; }
        if (src[i] === "$" && src[i + 1] === "{") { tdepth++; i += 2; continue; }
        if (tdepth > 0 && src[i] === "{") { tdepth++; i++; continue; }
        if (tdepth > 0 && src[i] === "}") { tdepth--; i++; continue; }
        i++;
      }
      continue;
    }
    if (c === "(") { depth++; i++; continue; }
    if (c === ")") { depth--; i++; if (depth === 0) return i - 1; continue; }
    i++;
  }
  return -1;
}

const MODIFIER_RE = /^\s*(private|protected|public|static|readonly|async|get|set|override)\b\s*/;
function extractMethodName(signatureText) {
  let s = signatureText;
  // Strip leading whitespace/modifiers repeatedly (e.g. "\n  private async foo(" / "  static get foo(")
  // — the signature text always carries leading newlines/indentation (and often a stripped-comment's
  // worth of blank lines) ahead of any modifier keyword, so the modifier regex itself must tolerate
  // leading whitespace or it never matches at all. Cap the loop so a pathological signature can never
  // spin forever.
  for (let guard = 0; guard < 8; guard++) {
    const before = s;
    s = s.replace(MODIFIER_RE, "");
    if (s === before) break;
  }
  const m = /^\s*([A-Za-z_$][\w$]*)\s*(<[^>(]*>)?\s*\(/.exec(s);
  return m ? m[1] : null;
}

/**
 * Locate the `class <className> { ... }` body in already-comment-stripped `src` and split it into named
 * methods via brace-depth matching (see file header, step 3). Returns
 * {classBody, methods: [{name, body, start, end}], bareTransactionForwardCount, violations}.
 * `violations` is computed here too (step 4-6) so the SAME call serves both the real-file assertion and
 * the synthetic-fixture controls below, against one shared implementation.
 */
function analyzeDbClass(strippedSrc, className) {
  const classDeclRe = new RegExp(`\\bclass\\s+${className}\\b[^{]*\\{`);
  const declMatch = classDeclRe.exec(strippedSrc);
  if (!declMatch) throw new Error(`class ${className} not found`);
  const classOpenBrace = declMatch.index + declMatch[0].length - 1;
  const classCloseBrace = matchingBrace(strippedSrc, classOpenBrace);
  if (classCloseBrace === -1) throw new Error(`class ${className} body is unbalanced`);
  const classBody = strippedSrc.slice(classOpenBrace + 1, classCloseBrace);

  // Step 3: split into named methods via depth-0 `{` transitions. A `{` is only treated as a method
  // BODY opener when it occurs OUTSIDE any unclosed `(...)`/`[...]` — a class member's own signature can
  // contain a `{` before its body even starts (e.g. an inline object-TYPE parameter default/annotation,
  // such as `constructor(file = DB_PATH, opts?: { allowProdDb?: boolean }) {` in the real db.ts — the
  // `{ allowProdDb?: boolean }` sits inside the still-open parameter-list parens, well before the real
  // body-opening `{`); naive depth-0-on-braces-alone misreads that inner `{` as the body start and
  // corrupts every method boundary found after it. Tracked with simple counters, not full nesting
  // (sufficient here: we only need "are we currently inside an unclosed paren/bracket", not how deep).
  const methods = [];
  let i = 0;
  let sigStart = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let angleDepth = 0;
  const n = classBody.length;
  while (i < n) {
    const c = classBody[i];
    if (c === "(") { parenDepth++; i++; continue; }
    if (c === ")") { parenDepth = Math.max(0, parenDepth - 1); i++; continue; }
    if (c === "[") { bracketDepth++; i++; continue; }
    if (c === "]") { bracketDepth = Math.max(0, bracketDepth - 1); i++; continue; }
    // Angle brackets: a generic type param/return annotation (e.g. `Array<{ a: string }>`) can wrap an
    // object-type `{...}` that must not be mistaken for a method body either. `<`/`>` are heavily
    // overloaded in real expression code (comparisons, bitshifts, JSX) — but NOT in this top-level,
    // depth-0-relative-to-the-class scan: everything reachable here is a signature/field type
    // annotation, never a runtime expression (those only occur inside a method body, already fully
    // consumed in one go via matchingBrace once a real body is found). The one real token that LOOKS
    // like it closes an angle bracket but doesn't is the arrow `=>` — skip its `>` specifically.
    if (c === "<") { angleDepth++; i++; continue; }
    if (c === ">") { if (classBody[i - 1] !== "=") angleDepth = Math.max(0, angleDepth - 1); i++; continue; }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n) {
        if (classBody[i] === "\\") { i += 2; continue; }
        if (classBody[i] === quote) { i++; break; }
        if (classBody[i] === "\n") break;
        i++;
      }
      continue;
    }
    if (c === "`") {
      i++;
      let tdepth = 0;
      while (i < n) {
        if (classBody[i] === "\\") { i += 2; continue; }
        if (tdepth === 0 && classBody[i] === "`") { i++; break; }
        if (classBody[i] === "$" && classBody[i + 1] === "{") { tdepth++; i += 2; continue; }
        if (tdepth > 0 && classBody[i] === "{") { tdepth++; i++; continue; }
        if (tdepth > 0 && classBody[i] === "}") { tdepth--; i++; continue; }
        i++;
      }
      continue;
    }
    if (c === "{" && parenDepth === 0 && bracketDepth === 0 && angleDepth === 0) {
      const close = matchingBrace(classBody, i);
      if (close === -1) throw new Error(`unbalanced brace in class ${className} body at offset ${i}`);
      // A return-type position can ITSELF be (a union/intersection of) inline object type literals —
      // e.g. real db.ts: `backfillDeferralEdgesOnce(): { rows: number; edges: number; skipped: number }
      // | undefined {` — syntactically indistinguishable, by brace shape alone, from a real method body.
      // Disambiguate by what immediately follows the matched close brace (past whitespace/newlines): a
      // real method body is NEVER followed by `|`/`&` (that's only valid in a type position) and is NEVER
      // immediately followed by another `{` (two adjacent object-literal statements isn't valid class-
      // member syntax either) — either of those means this `{...}` was a type-annotation chunk, not the
      // body; skip past it and keep scanning the SAME signature for the real body-opening `{`.
      let afterClose = close + 1;
      while (afterClose < n && /\s/.test(classBody[afterClose])) afterClose++;
      const nextChar = classBody[afterClose];
      if (nextChar === "|" || nextChar === "&" || nextChar === "{") {
        i = close + 1;
        continue;
      }
      const sig = classBody.slice(sigStart, i);
      const name = extractMethodName(sig);
      methods.push({ name, body: classBody.slice(i + 1, close), start: i + 1, end: close, sig });
      i = close + 1;
      sigStart = i;
      parenDepth = 0;
      bracketDepth = 0;
      angleDepth = 0;
      continue;
    }
    i++;
  }

  // Step 4: call graph (named methods only — unnamed nodes can't be call TARGETS, only sources, and we
  // don't need them as sources either: an unnamed node is never reachable FROM a raw transaction's own
  // callback via a `this.<name>(` call, since it has no name to be called by).
  const callGraph = new Map();
  for (const m of methods) {
    if (!m.name) continue;
    const calls = new Set();
    const re = /this\.([A-Za-z_$][\w$]*)\s*\(/g;
    let mm;
    while ((mm = re.exec(m.body))) calls.add(mm[1]);
    callGraph.set(m.name, calls);
  }

  // Step 5: transitive closure of "reaches appendEvent".
  const reaches = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, calls] of callGraph) {
      if (reaches.has(name)) continue;
      if (calls.has("appendEvent") || [...calls].some((c) => reaches.has(c))) {
        reaches.add(name);
        changed = true;
      }
    }
  }

  // Step 6: raw transaction call sites.
  const violations = [];
  let bareTransactionForwardCount = 0;
  const bareTransactionForwardSites = [];
  const txRe = /this\.db\.transaction\s*\(/g;
  let tm;
  while ((tm = txRe.exec(classBody))) {
    const argStart = tm.index + tm[0].length;
    const argEnd = matchingParen(classBody, argStart);
    if (argEnd === -1) throw new Error(`unbalanced this.db.transaction( call at offset ${tm.index}`);
    const callbackText = classBody.slice(argStart, argEnd);
    const trimmed = callbackText.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
      bareTransactionForwardCount++;
      // Identify the enclosing named method for the sanity cross-check below.
      const enclosing = methods.find((m) => tm.index >= m.start && tm.index < m.end);
      bareTransactionForwardSites.push(enclosing?.name ?? null);
      continue;
    }
    const calledNames = new Set();
    const callRe = /this\.([A-Za-z_$][\w$]*)\s*\(/g;
    let cm;
    while ((cm = callRe.exec(callbackText))) calledNames.add(cm[1]);
    const hits = [...calledNames].filter((nm) => nm === "appendEvent" || reaches.has(nm));
    if (hits.length > 0) {
      const line = classBody.slice(0, tm.index).split("\n").length;
      violations.push({ line, hits, snippet: callbackText.slice(0, 120).replace(/\s+/g, " ") });
    }
  }

  return { classBody, methods, callGraph, reaches, violations, bareTransactionForwardCount, bareTransactionForwardSites };
}

// ── Real-file check ──────────────────────────────────────────────────────────────────────────────────

const realSrc = fs.readFileSync(DB_TS_PATH, "utf8");
const realStripped = stripComments(realSrc);
const real = analyzeDbClass(realStripped, "Db");

check("(1) sanity: db.ts's Db class parses into a non-trivial number of named methods (parser isn't silently bailing early)", real.methods.filter((m) => m.name).length >= 200);
check(
  "(2) sanity: the transitive 'reaches appendEvent' closure is non-vacuous and matches the 87b1c8a1 decision record's own enumeration — updateProject/deleteProject/archiveDeadRecycleSuccessor/finishHaltedRecyclePending/markCredentialUndeliverableAndAudit (and the two it names as the chain: resetMainlineBaselinesForRepoChange/unpinCommondirTrustIfOwned) are all present",
  ["resetMainlineBaselinesForRepoChange", "unpinCommondirTrustIfOwned", "updateProject", "deleteProject",
    "archiveDeadRecycleSuccessor", "finishHaltedRecyclePending", "markCredentialUndeliverableAndAudit"]
    .every((nm) => real.reaches.has(nm)),
);
check(
  "(3) sanity: exactly ONE `this.db.transaction(fn)()`-shaped bare passthrough exists in db.ts today, and it is inside runInTransaction (the sanctioned wrapper's own implementation) — a second such passthrough elsewhere would silently widen what this guard skips without review",
  real.bareTransactionForwardCount === 1 && real.bareTransactionForwardSites[0] === "runInTransaction",
);
check(
  `(4) MAIN ASSERTION: no raw this.db.transaction(...) call site in db.ts's real Db class reaches appendEvent (directly or transitively) without going through runInTransaction's queuing — 0 violations expected, found ${real.violations.length}`,
  real.violations.length === 0,
);
if (real.violations.length > 0) {
  for (const v of real.violations) console.log(`      VIOLATION near class-body line ${v.line}: calls [${v.hits.join(", ")}] — "${v.snippet}..."`);
}

// ── Synthetic-fixture controls — proves the check can actually FAIL, and discriminates a safe raw
//    transaction from an unsafe one, without ever touching the real tracked db.ts ──────────────────────

const FIXTURE_PREFIX = `
class Db {
  private pendingEventNotifications = [];
  appendEvent(evt) {
    this.db.prepare("INSERT ...").run(evt);
  }
  private flushPendingEventNotifications() {
    for (const evt of this.pendingEventNotifications) this.eventListener(evt);
  }
  runInTransaction(fn) {
    const nested = this.db.inTransaction;
    try {
      const result = this.db.transaction(fn)();
      if (!nested) this.flushPendingEventNotifications();
      return result;
    } catch (e) {
      throw e;
    }
  }
  helperReachesAppendEvent(x) {
    this.appendEvent(x);
  }
  indirectHelper(x) {
    this.helperReachesAppendEvent(x);
  }
  safeMutator() {
    this.db.transaction(() => {
      this.db.prepare("UPDATE sessions SET x = 1").run();
    })();
  }
`;
const FIXTURE_DIRECT_PLANT = `
  directBadMutator() {
    this.db.transaction(() => {
      this.appendEvent({ kind: "x" });
    })();
  }
`;
const FIXTURE_INDIRECT_PLANT = `
  indirectBadMutator() {
    this.db.transaction(() => {
      this.indirectHelper({ kind: "y" });
    })();
  }
`;
const FIXTURE_FIXED = `
  directBadMutator() {
    this.runInTransaction(() => {
      this.appendEvent({ kind: "x" });
    });
  }
  indirectBadMutator() {
    this.runInTransaction(() => {
      this.indirectHelper({ kind: "y" });
    });
  }
`;
const FIXTURE_SUFFIX = `
}
`;

function runFixture(middle) {
  const src = FIXTURE_PREFIX + middle + FIXTURE_SUFFIX;
  return analyzeDbClass(stripComments(src), "Db");
}

// (5) PLANTED — both a direct appendEvent call and an indirect (two-hop) one inside raw transactions must
//     both be caught.
{
  const planted = runFixture(FIXTURE_DIRECT_PLANT + FIXTURE_INDIRECT_PLANT);
  check("(5a) positive control sanity: the planted fixture's safe raw transaction is NOT itself flagged (the control isn't vacuously flagging everything)", !planted.violations.some((v) => v.snippet.includes("UPDATE sessions")));
  check("(5b) RED: a DIRECT this.appendEvent( call inside a raw this.db.transaction(...) callback is caught", planted.violations.some((v) => v.hits.includes("appendEvent")));
  check("(5c) RED: an INDIRECT (two-hop: raw tx -> indirectHelper -> helperReachesAppendEvent -> appendEvent) reach through a raw this.db.transaction(...) callback is caught", planted.violations.some((v) => v.hits.includes("indirectHelper")));
  check("(5d) exactly the two planted violations are found, nothing extra", planted.violations.length === 2);
}

// (6) FIXED — removing the raw this.db.transaction(...) wrapper (routing the SAME bodies through
//     runInTransaction instead) must clear every violation: GREEN after the plant is removed.
{
  const fixed = runFixture(FIXTURE_FIXED);
  check("(6) GREEN: the same two call shapes, routed through runInTransaction instead of a raw this.db.transaction(...), are no longer flagged", fixed.violations.length === 0);
}

// (7) The sanctioned bare `this.db.transaction(fn)()` passthrough inside the fixture's own runInTransaction
//     must never itself be mistaken for a violation, in either the planted or fixed fixture.
{
  const planted = runFixture(FIXTURE_DIRECT_PLANT + FIXTURE_INDIRECT_PLANT);
  check("(7) the fixture's own runInTransaction passthrough is recognized and excluded (bareTransactionForwardCount === 1)", planted.bareTransactionForwardCount === 1 && planted.bareTransactionForwardSites[0] === "runInTransaction");
}

// (8) REAL-CORPUS PLANT — per this project's standing verification posture, a synthetic fixture's clean
//     result doesn't prove the check would catch the SAME shape inside the real, much larger call graph
//     (a small fixture "could not have produced the failure" the real file might hide behind). Splice a
//     single extra statement into an IN-MEMORY COPY of the real, already-comment-stripped db.ts text —
//     never written to disk, the tracked file is untouched — inside `migrateTopicsToAgents`'s real,
//     today-safe raw `this.db.transaction(() => { ... })` (the exact one shown safe by assertion (4)
//     above), calling `this.unpinCommondirTrustIfOwned(...)` — a method assertion (2) already proved is
//     IN the real `reaches appendEvent` closure. This must turn the REAL file's own check RED, using the
//     real call graph, not a hand-built one.
{
  const ANCHOR = 'this.db.exec("ALTER TABLE topics RENAME TO agents");';
  const anchorCount = (realStripped.match(new RegExp(ANCHOR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
  check("(8) sanity: the real-corpus plant anchor is unique in db.ts (so the splice below targets exactly one, known site)", anchorCount === 1);
  const plantedRealStripped = realStripped.replace(
    ANCHOR,
    `${ANCHOR} this.unpinCommondirTrustIfOwned("plantedProjectId", "primary", "plantedRepoPath");`,
  );
  check("(8) sanity: the splice actually changed the text (replace found its anchor)", plantedRealStripped !== realStripped);
  const plantedReal = analyzeDbClass(plantedRealStripped, "Db");
  check(
    "(8) RED on the REAL db.ts call graph: splicing a call to a real appendEvent-reaching method into migrateTopicsToAgents's existing raw transaction is caught",
    plantedReal.violations.some((v) => v.hits.includes("unpinCommondirTrustIfOwned")),
  );
}

console.log(failures === 0
  ? "\n✅ ALL PASS — no raw this.db.transaction(...) call site in the real db.ts Db class reaches appendEvent " +
    "(directly or transitively) outside runInTransaction's queuing/flush discipline; the check is shown to " +
    "discriminate (a safe raw transaction is never flagged) and to actually catch a planted violation, both " +
    "a direct and a two-hop indirect one, clearing once the plant is routed through runInTransaction instead."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
