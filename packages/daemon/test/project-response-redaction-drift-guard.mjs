import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text scan, no Db used
// Card ce9a3a91 — THE POINT OF THIS CARD, not the route: a STRUCTURAL drift guard that fails when a NEW
// project-returning gateway response ships `config.sessionEnv` unredacted, so route #10 never again ships
// silently and gets discovered by a sixth hand-count. History (see the card body for the full table): the
// set of "project-returning routes that leak sessionEnv" was hand-enumerated FOUR times in one day
// (a5ecb6fd: 1, 6bfc3bfb: +3, 0c5d6851: +4, this card: +1 route / +2 exits) by four different parties, each
// believing theirs was complete. The defect was never the missing route — it was the absence of a
// mechanism. This file is that mechanism.
//
// MECHANISM (source-text scan of packages/daemon/src/gateway/server.ts, comment-stripped):
//   1. Every top-level `app.(get|post|patch|put|delete)("path", ...)` registration is found and the file
//      is sliced into one block per route, from its own registration to the next one (or EOF).
//   2. Within each block, a "project-returning exit" is any RESPONSE STATEMENT (a `.send(...)` call, a
//      bare `return ...;`, or — for an arrow-EXPRESSION-bodied handler like `GET /api/projects` — the
//      registration line's own `=> ...` payload) whose payload text contains one of FOUR signatures that
//      this corpus has proven actually carry raw Project data: an inline `deps.db.getProject(`/
//      `deps.db.getReservedProjectByName(` call, a bare reference to a block-local variable that was
//      itself assigned straight from one of those two calls (or from a literal `const x: Project = {`
//      construction) WITHOUT going through `redactSessionEnvForRead` at the point of assignment, or a bare
//      `deps.db.listProjects()`/`deps.db.listArchivedProjects()` call.
//   3. A payload signature is a LEAK unless `redactSessionEnvForRead(` appears SOMEWHERE in that SAME
//      payload — this is deliberately payload-scoped, not just block-scoped: `return { ...project,
//      identityWarning }` and `return redactSessionEnvForRead(project)` differ only in whether the masker
//      wraps the value AT THE EXIT, which is exactly the shape of the two-exit `project-init` bug this
//      card fixed (one exit wrapped, `identityWarning`'s sibling exit not).
//   4. "Bare reference, not followed by `.` or `:`" is the whole-value test — `p.repoPath` (a field read)
//      and `{ project: redacted }` (an object KEY literally spelled "project") are both excluded by
//      design; only a spread/positional/shorthand VALUE use trips it. This is what lets `GET /api/setup/
//      home` pass cleanly even though it reassigns `const project = redactSessionEnvForRead(foundSetup)`
//      and then returns `{ project, ... }` — the SAFE final name is untracked (never assigned via a raw
//      DB call), and the UNSAFE raw name (`foundSetup`) never appears in the response payload at all.
//
// THIS IS FAIL-CLOSED ON AN UNRECOGNISED EXIT: nothing here is a hardcoded route allowlist. A brand-new
// route added anywhere in server.ts that reads a project via any of the four signatures above and forgets
// the masker is caught by construction — the scan walks the REAL registered route text every run, it does
// not consult a list of routes this card already knows about. (1) below is a POSITIVE control proving
// this generalizes to a route/variable-name the scan has never seen, not just the ones already fixed.
//
// ⚠ HONEST LIMITS (the card explicitly asks for these, not a guard oversold as airtight):
//   - This is a TEXTUAL scan, not a type-checker. A project object smuggled through a mechanism these four
//     signatures don't cover (e.g. a NEW db.ts read helper this scan doesn't know the name of, or Project
//     data reconstructed field-by-field into a fresh object literal instead of spread/returned whole)
//     would not be caught. Every incident on this card's own history table (9 real exits across a5ecb6fd/
//     6bfc3bfb/0c5d6851/this card) took the "read via getProject*/listProjects*, then send/return the
//     value whole" shape — this guard targets exactly that shape because that is the population that has
//     actually recurred, not a hypothetical broader one.
//   - It does not run `deps.db.getProject`-style checks against helper functions OUTSIDE server.ts (e.g. a
//     future refactor that moves project-reading into a `gateway/projects.ts` module) — scoped to this one
//     file, matching every prior fix in this lineage (a5ecb6fd/6bfc3bfb/0c5d6851 all live in server.ts; see
//     (2) below, which asserts server.ts is still the ONLY file registering routes at all).
//   - A payload that references `redactSessionEnvForRead(` ANYWHERE in itself is treated as safe even if a
//     leak signature elsewhere in the SAME payload isn't literally passed through it (e.g. a payload that
//     spreads one redacted project and one raw one side by side). Not observed in this corpus; named here
//     rather than silently assumed away.
//
// Run: node packages/daemon/test/project-response-redaction-drift-guard.mjs (no build needed — pure
// source-text scan, mirrors human-only-surface-leak-guard.mjs's own no-dist-dependency posture)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./_strip-comments.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "src");
const GATEWAY_DIR = path.join(SRC_DIR, "gateway");
const SERVER_TS_PATH = path.join(GATEWAY_DIR, "server.ts");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// No trailing "(" — `.map(redactSessionEnvForRead)` passes the masker as a bare function REFERENCE (the
// GET /api/projects / GET /api/projects/archived shape), never calls it inline, so a MASKER that required
// a call would miss the exact pattern the two already-fixed list routes actually use.
const MASKER = "redactSessionEnvForRead";
const RAW_GETTER_RE = /\b(?:const|let)\s+(\w+)\s*=\s*deps\.db\.(?:getProject|getReservedProjectByName)\(/g;
const TYPED_LITERAL_RE = /\b(?:const|let)\s+(\w+)\s*:\s*Project\s*=\s*\{/g;
// Plain (non-global) forms for a one-shot `.test()`; `g`-flagged siblings below are RECREATED at each use
// site (never a shared stateful global regex — a global regex's `.lastIndex` persisting across an
// unrelated call is a real footgun this file deliberately avoids) for `.exec()`-based iteration.
const LIST_CALL_RE = /deps\.db\.(?:listProjects|listArchivedProjects)\(\)/;
const INLINE_GETTER_RE = /deps\.db\.(?:getProject|getReservedProjectByName)\(/;
const ROUTE_RE = /^\s*app\.(get|post|patch|put|delete)\(\s*["']([^"']+)["']/gm;

/** Is `idx` inside a `"`/`'`/`` ` `` quoted region of `line`, scanning from column 0? Guards the bare-
 *  variable-name check below against matching an English-prose mention of the identifier inside an error
 *  message or template-literal string (e.g. `` `no project ${s.projectId}` `` legitimately contains the
 *  word "project" with nothing to do with the tracked variable) — single-line scan only (this file's
 *  response statements are always one physical line; see the module doc comment). Backslash-escapes are
 *  honored so `"\""` doesn't prematurely close the quote. */
function isInsideQuotedRegion(line, idx) {
  let quote = null;
  for (let i = 0; i < idx; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
  }
  return quote !== null;
}

/**
 * Scan comment-stripped `server.ts` source text for project-returning response exits that never pass
 * through `redactSessionEnvForRead`. Pure function so (1) below can positive-control it against a
 * synthetic fixture, independent of the real file's current (fixed) state.
 * Returns {leaks: [{method,pattern,line}], projectTouchingRoutes: Set<"METHOD pattern">}.
 */
function findProjectResponseLeaks(strippedSource) {
  const registrations = [];
  let m;
  ROUTE_RE.lastIndex = 0;
  while ((m = ROUTE_RE.exec(strippedSource)) !== null) {
    registrations.push({ method: m[1].toUpperCase(), pattern: m[2], index: m.index });
  }
  const leaks = [];
  const projectTouchingRoutes = new Set();

  for (let i = 0; i < registrations.length; i++) {
    const { method, pattern, index: start } = registrations[i];
    const end = i + 1 < registrations.length ? registrations[i + 1].index : strippedSource.length;
    const block = strippedSource.slice(start, end);

    // Block-local variables assigned straight from a raw project-read (RHS not itself wrapped — the
    // masker call, if present, would be textually between `=` and the DB call, which these regexes don't
    // match through, so an already-wrapped assignment like `const project = redactSessionEnvForRead(x)`
    // is correctly NOT captured here).
    const trackedVars = new Set();
    RAW_GETTER_RE.lastIndex = 0;
    while ((m = RAW_GETTER_RE.exec(block)) !== null) trackedVars.add(m[1]);
    TYPED_LITERAL_RE.lastIndex = 0;
    while ((m = TYPED_LITERAL_RE.exec(block)) !== null) trackedVars.add(m[1]);

    const blockTouchesProject = trackedVars.size > 0 || LIST_CALL_RE.test(block) || INLINE_GETTER_RE.test(block);
    if (blockTouchesProject) projectTouchingRoutes.add(`${method} ${pattern}`);

    for (const rawLine of block.split("\n")) {
      const line = rawLine;
      const sendIdx = line.indexOf(".send(");
      const returnMatch = /^\s*return\b/.test(line);
      const arrowIdx = line.indexOf("=>");
      let anchor = -1;
      if (sendIdx !== -1) {
        anchor = sendIdx;
      } else if (returnMatch) {
        anchor = line.indexOf("return");
      } else if (arrowIdx !== -1 && /^\s*app\.(get|post|patch|put|delete)\(/.test(line)) {
        // Arrow-EXPRESSION-bodied route registration (e.g. `app.get("/api/projects", async () =>
        // deps.db.listProjects().map(...))` all on one line) — only when NOT immediately followed by a
        // block body `{`, which has its own `return`/`.send(` inside it that the checks above already
        // reach on their own line.
        const after = line.slice(arrowIdx + 2).trim();
        if (!after.startsWith("{")) anchor = arrowIdx;
      }
      if (anchor === -1) continue;
      const payload = line.slice(anchor);
      if (payload.includes(MASKER)) continue; // masked in this exact statement — safe

      // Every signature check below is evaluated against `line` (not `payload`) — via a match INDEX, not a
      // substring `.includes` — so each candidate match can be checked both for being AT/AFTER `anchor`
      // (inside the response payload, not e.g. an earlier `if` guard on the same line) and for NOT being
      // inside a quoted string (an English-language mention of the same word/call in an error message).
      const anyMatchIsRealLeak = (re) => {
        re.lastIndex = 0;
        let vm;
        while ((vm = re.exec(line)) !== null) {
          if (vm.index >= anchor && !isInsideQuotedRegion(line, vm.index)) return true;
          if (re.lastIndex === vm.index) re.lastIndex++; // guard a theoretical zero-width match
        }
        return false;
      };
      let leak = anyMatchIsRealLeak(new RegExp(LIST_CALL_RE.source, "g"))
        || anyMatchIsRealLeak(new RegExp(INLINE_GETTER_RE.source, "g"));
      if (!leak) {
        for (const v of trackedVars) {
          if (anyMatchIsRealLeak(new RegExp(`\\b${v}\\b(?![.:])`, "g"))) { leak = true; break; }
        }
      }
      if (leak) leaks.push({ method, pattern, line: line.trim() });
    }
  }
  return { leaks, projectTouchingRoutes };
}

// ============================= (0) sanity: the source file is readable =============================
const realSourceRaw = fs.readFileSync(SERVER_TS_PATH, "utf8");
check("(0) gateway/server.ts is readable and non-empty", realSourceRaw.length > 1000);

// ============================= (1) POSITIVE CONTROL — synthetic fixtures =============================
// Proves the DETECTOR generalizes to a route and variable name it has never seen, not merely to the exact
// project-init lines this card fixed. Three shapes: a bare-variable leak (the project-init bug shape), an
// inline-getProject leak (the restore/config-PATCH shape had this NOT been fixed), and a raw list-call
// leak (the GET /api/projects shape had `.map(redactSessionEnvForRead)` been forgotten) — each proven to
// trip the scanner, and each proven CLEAN once redacted, so the control cuts both directions.
{
  const BAD_VAR = `
  app.post("/api/fixture/never-real-route", async (req, reply) => {
    const brandNewVar: Project = { id: "x", name: "y" };
    deps.db.insertProject(brandNewVar);
    return reply.code(201).send({ ...brandNewVar, extra: true });
  });
`;
  const { leaks: badVarLeaks } = findProjectResponseLeaks(BAD_VAR);
  check("(1a) synthetic bare-variable leak (never-seen route + variable name) is caught",
    badVarLeaks.some((l) => l.pattern === "/api/fixture/never-real-route"));

  const GOOD_VAR = BAD_VAR.replace(
    "return reply.code(201).send({ ...brandNewVar, extra: true });",
    "return reply.code(201).send({ ...redactSessionEnvForRead(brandNewVar), extra: true });",
  );
  const { leaks: goodVarLeaks } = findProjectResponseLeaks(GOOD_VAR);
  check("(1a-control) the SAME route, once wrapped, is clean", goodVarLeaks.length === 0);

  const BAD_INLINE = `
  app.get("/api/fixture/never-real-inline/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    return deps.db.getProject(id);
  });
`;
  const { leaks: badInlineLeaks } = findProjectResponseLeaks(BAD_INLINE);
  check("(1b) synthetic inline-getProject leak (no intermediate variable at all) is caught",
    badInlineLeaks.some((l) => l.pattern === "/api/fixture/never-real-inline/:id"));

  const GOOD_INLINE = BAD_INLINE.replace(
    "return deps.db.getProject(id);",
    "return redactSessionEnvForRead(deps.db.getProject(id)!);",
  );
  const { leaks: goodInlineLeaks } = findProjectResponseLeaks(GOOD_INLINE);
  check("(1b-control) the SAME route, once wrapped, is clean", goodInlineLeaks.length === 0);

  const BAD_LIST = `
  app.get("/api/fixture/never-real-list", async () => deps.db.listProjects());
`;
  const { leaks: badListLeaks } = findProjectResponseLeaks(BAD_LIST);
  check("(1c) synthetic raw list-call leak (.map(redactSessionEnvForRead) forgotten) is caught",
    badListLeaks.some((l) => l.pattern === "/api/fixture/never-real-list"));

  const GOOD_LIST = BAD_LIST.replace(
    "deps.db.listProjects()",
    "deps.db.listProjects().map(redactSessionEnvForRead)",
  );
  const { leaks: goodListLeaks } = findProjectResponseLeaks(GOOD_LIST);
  check("(1c-control) the SAME route, once mapped through the masker, is clean", goodListLeaks.length === 0);

  // Field-access / object-key exclusions must NOT false-positive — this is what lets the real GET
  // /api/setup/home (which reassigns to a new `project` name and returns `{ project, ... }`) pass clean.
  const FIELD_ACCESS_SAFE = `
  app.get("/api/fixture/field-access-only/:id", async (req, reply) => {
    const found = deps.db.getProject((req.params as { id: string }).id);
    return { repoPath: found.repoPath, name: found.name };
  });
`;
  const { leaks: fieldAccessLeaks } = findProjectResponseLeaks(FIELD_ACCESS_SAFE);
  check("(1d-control) a response that only reads FIELDS off a project var (never the whole value) is NOT flagged",
    fieldAccessLeaks.length === 0);

  const REASSIGN_SAFE = `
  app.get("/api/fixture/reassign-then-return", async (req, reply) => {
    const raw = deps.db.getProject((req.params as { id: string }).id);
    const project = redactSessionEnvForRead(raw);
    return { project, extra: true };
  });
`;
  const { leaks: reassignLeaks } = findProjectResponseLeaks(REASSIGN_SAFE);
  check("(1e-control) a raw var wrapped at ASSIGNMENT time and returned under a new name is NOT flagged",
    reassignLeaks.length === 0);
}

// ============================= (2) scope sanity — server.ts is the ONLY route-registering file =============================
// If a future refactor moves route registrations into a sibling gateway/*.ts file, THIS scan (scoped to
// server.ts alone, matching every fix in this lineage) would silently stop covering them. Fail loudly
// instead of silently under-scoping.
{
  const gatewayFiles = fs.readdirSync(GATEWAY_DIR).filter((f) => f.endsWith(".ts"));
  const offenders = [];
  for (const f of gatewayFiles) {
    if (f === "server.ts") continue;
    const content = stripComments(fs.readFileSync(path.join(GATEWAY_DIR, f), "utf8"));
    if (/\bapp\.(get|post|patch|put|delete)\(/.test(content)) offenders.push(f);
  }
  check(`(2) no sibling gateway/*.ts file registers an app.METHOD(...) route outside server.ts (offenders: ${offenders.join(", ") || "none"})`,
    offenders.length === 0);
}

// ============================= (3) THE REAL SCAN — server.ts must ship zero leaks today =============================
{
  const stripped = stripComments(realSourceRaw);
  const { leaks, projectTouchingRoutes } = findProjectResponseLeaks(stripped);
  check(`(3) the scan finds a non-trivial population of project-touching routes today (found ${projectTouchingRoutes.size}, floor 8 — a5ecb6fd:1 + 6bfc3bfb:3 + 0c5d6851:4)`,
    projectTouchingRoutes.size >= 8);
  check(`(3) EVERY project-returning exit in gateway/server.ts passes config.sessionEnv through redactSessionEnvForRead (offenders: ${leaks.length === 0 ? "none" : leaks.map((l) => `${l.method} ${l.pattern} [${l.line}]`).join(" | ")})`,
    leaks.length === 0);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the drift-guard detector catches a synthetic bare-variable, inline-getProject, and raw-list-call leak on a route/variable name it has never seen (and clears once each is properly wrapped), a field-access-only response and a wrap-then-rename response are correctly left unflagged, server.ts remains the sole route-registering file, and every real project-returning exit in gateway/server.ts today passes sessionEnv through redactSessionEnvForRead."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
