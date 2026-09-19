import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — pure source-text scan, no Db used
// Card c5fddaef (Code Reviewer `1e7efc4f`'s design, filed while reviewing card `bb267ade` — attribution
// theirs). `bb267ade` masked `config.sessionEnv` at ONE chokepoint — `projectFields()` in
// `mcp/entityRowFields.ts` — for the six MCP project-read sites known at the time. A seventh leak site
// (`mcp/operator.ts`'s `my_project`, card `a4637a0c`) was then found only by a human-directed attack on a
// completeness claim — nothing mechanical enforced "every whole-project MCP return flows through the
// chokepoint". This file is that mechanism, SIBLING to (never a port of) the REST equivalent
// (`project-response-redaction-drift-guard.mjs`) — the chokepoint makes the MCP case structurally
// easier: no cross-route provenance tracking, no route-registration parsing.
//
// MECHANISM (pure source-text scan of packages/daemon/src/mcp/*.ts, comment-stripped, no dist/no Db):
//   1. Per file, resolve a "reaches a raw project" set of LOCALLY-DEFINED helper names (class methods,
//      named functions, and `const x = (...) => ...` arrow consts) — a helper is unsafe if its own
//      RETURN EXPRESSION (a `return <expr>;` statement, or the whole expression for an arrow with an
//      EXPRESSION body) starts with `db.getProject(`/`this.db.getProject(`/`db.listAllProjects(`/
//      `db.listArchivedProjects(`, OR is a bare call to an ALREADY-unsafe helper name — resolved to a
//      fixed point (bounded iterations), so a wrapper-of-a-wrapper (operator.ts's real violation:
//      `my_project`'s `ok(p)` traces `p = ownProject()` -> `ownProject` calls
//      `this.resolveOperatorProject(...)` -> THAT method's own `return this.db.getProject(...) ?? null;`
//      — two hops, neither of which is a direct call in `my_project`'s own handler body) is still caught.
//      Deliberately anchored at the START of the return expression (not a substring search anywhere in
//      the body) — a substring search would false-positive on `getByIdPrefix(projectId, (id) =>
//      db.getProject(id), ...)`, whose raw call is buried inside a CALLBACK ARGUMENT it passes to a
//      shared utility, never its own return value.
//   2. Per `server.registerTool(` block (sliced to the next registration or EOF, same slicing shape as
//      the REST guard's per-route blocks), find block-LOCAL variables assigned straight from a raw
//      source: the same anchored-return-expression check as (1) applied to the RHS of `const x = ...`/
//      `let x = ...`, OR a `const x: Project = { ... }` typed-literal construction (the project_create/
//      project_init shape — a FRESH project built in-process, never a DB read, but still whole-Project-
//      shaped and still carrying `config.sessionEnv` if the caller's config override slipped one through).
//   3. Within the SAME block, every `ok(` call's balanced-paren payload is inspected: safe if the bare
//      word `projectFields` appears anywhere in it — a CALL (`projectFields(x)`) or a bare FUNCTION
//      REFERENCE (`.map(projectFields)`, the list_all_projects shape on both routers) both count, mirrors
//      the REST guard's own note for `.map(redactSessionEnvForRead)`. Otherwise a LEAK if the payload's
//      own top-level content (i) itself starts with one of the three raw-call signatures, or (ii) bare-
//      references (not immediately followed by `.` or `:` — a field-read or an object-key spelling, not
//      a whole-value use; not inside a quoted string) one of the unsafe block-local variables from (2).
//
// ⚠ HONEST LIMITS (named, not oversold as airtight — same posture the REST guard's own header states):
//   - Textual, not a type-checker. A project value smuggled through a mechanism this scan doesn't know
//     the shape of (e.g. field-by-field reconstruction into a fresh untyped object literal) is not caught.
//   - The helper-indirection resolution (1) is ONE mechanism deep per file — it does not cross files
//     (`getByIdPrefix` itself, defined in `id-prefix.ts`, is never a "local helper" to any mcp/*.ts file,
//     so a variable assigned from it is judged ONLY by whether ITS OWN block re-derives/returns it raw,
//     never by what getByIdPrefix's own callback arguments happen to mention).
//   - Fixed-point iteration is bounded (10 rounds) — sufficient for every helper chain in this corpus
//     (measured: the real violation needs exactly 2), not a claim about unbounded depth.
//
// Run: node packages/daemon/test/mcp-project-fields-chokepoint-guard.mjs (no build needed — pure
// source-text scan, mirrors project-response-redaction-drift-guard.mjs's own no-dist-dependency posture)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./_strip-comments.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "src");
const MCP_DIR = path.join(SRC_DIR, "mcp");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// No trailing "(" required — `.map(projectFields)` passes the masker as a bare function REFERENCE (the
// list_all_projects shape on both routers), never calls it inline; a masker requiring a call would miss
// exactly that pattern (mirrors the REST guard's own MASKER note for `.map(redactSessionEnvForRead)`).
const MASKER_RE = /\bprojectFields\b/;
// Anchored at the START of a (trimmed) expression — deliberately NOT a substring search; see header (1).
const RAW_GETTER_ANCHOR_RE = /^(?:this\.)?db\.(?:getProject|listAllProjects|listArchivedProjects)\(/;
const TYPED_LITERAL_RE = /\b(?:const|let)\s+(\w+)\s*:\s*Project\s*=\s*\{/g;
const REGISTER_RE = /server\.registerTool\(\s*\n?\s*["'](\w+)["']/g;

/** Is `idx` inside a `"`/`'`/`` ` `` quoted region of `line`? Same guard the REST guard uses — a bare-
 *  name match inside an error-message string ("no project bound to this session") must not count. */
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

/** Balanced-paren extraction of a call's argument text, given the index of its OWN opening "(". */
function extractParenArgs(text, openParenIdx) {
  let depth = 1;
  for (let i = openParenIdx + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") { depth--; if (depth === 0) return text.slice(openParenIdx + 1, i); }
  }
  return text.slice(openParenIdx + 1); // unterminated — best effort
}

/** Balanced-brace extraction of a block's body text, given the index of its OWN opening "{". */
function extractBraceBody(text, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) return text.slice(openIdx + 1, i); }
  }
  return text.slice(openIdx + 1); // unterminated — best effort
}

/** Does `expr` (trimmed) start with a raw getter call, or is it a bare call to a name in `unsafeNames`? */
function isUnsafeExpr(expr, unsafeNames) {
  const trimmed = expr.trim();
  if (RAW_GETTER_ANCHOR_RE.test(trimmed)) return true;
  const callMatch = /^(?:this\.)?(\w+)\(/.exec(trimmed);
  return !!callMatch && unsafeNames.has(callMatch[1]);
}

/**
 * Resolve the set of locally-defined helper names (in ONE file) whose own return value reaches a raw
 * project read — directly, or via a call to another already-unsafe local helper (fixed point). See
 * header (1). Pure function so the positive-control section below can probe it against a synthetic file
 * body, independent of the real corpus's current (evolving) shape.
 */
function resolveUnsafeHelpers(strippedSource) {
  const NON_FN_NAMES = new Set(["if", "for", "while", "switch", "catch", "function"]);
  const defs = new Map(); // name -> array of return-expression strings

  const addReturnsFromBlockBody = (name, body) => {
    const returns = [];
    const RETURN_RE = /return\s+([^;]+);/g;
    let rm;
    while ((rm = RETURN_RE.exec(body)) !== null) returns.push(rm[1]);
    if (returns.length > 0) defs.set(name, [...(defs.get(name) ?? []), ...returns]);
  };

  // Named function/method declarations with a block body: `name(...) { ... }` (optionally private/async).
  const DEF_RE = /(?:^|\n)[ \t]*(?:private\s+|public\s+|protected\s+)?(?:async\s+)?(?:function\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{;=]+)?\{/g;
  let m;
  while ((m = DEF_RE.exec(strippedSource)) !== null) {
    const name = m[1];
    if (NON_FN_NAMES.has(name)) continue;
    const openIdx = strippedSource.indexOf("{", m.index + m[0].length - 1);
    if (openIdx === -1) continue;
    addReturnsFromBlockBody(name, extractBraceBody(strippedSource, openIdx));
  }

  // `const/let name = (...) => EXPR;` — arrow with an EXPRESSION body (no braces immediately after `=>`).
  const ARROW_EXPR_RE = /(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>\s*(?!\{)/g;
  while ((m = ARROW_EXPR_RE.exec(strippedSource)) !== null) {
    const name = m[1];
    const rest = strippedSource.slice(m.index + m[0].length);
    const semiIdx = rest.indexOf(";");
    const expr = semiIdx === -1 ? rest.slice(0, 300) : rest.slice(0, semiIdx);
    defs.set(name, [...(defs.get(name) ?? []), expr]);
  }

  // `const/let name = (...) => { ... }` — arrow with a BLOCK body.
  const ARROW_BLOCK_RE = /(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>\s*\{/g;
  while ((m = ARROW_BLOCK_RE.exec(strippedSource)) !== null) {
    const name = m[1];
    const openIdx = strippedSource.indexOf("{", m.index + m[0].length - 1);
    if (openIdx === -1) continue;
    addReturnsFromBlockBody(name, extractBraceBody(strippedSource, openIdx));
  }

  const unsafe = new Set();
  const isDirectlyUnsafe = (name) => (defs.get(name) ?? []).some((expr) => RAW_GETTER_ANCHOR_RE.test(expr.trim()));
  for (const name of defs.keys()) if (isDirectlyUnsafe(name)) unsafe.add(name);

  let changed = true;
  let iterations = 0;
  while (changed && iterations++ < 10) {
    changed = false;
    for (const [name, returns] of defs) {
      if (unsafe.has(name)) continue;
      if (returns.some((expr) => isUnsafeExpr(expr, unsafe))) { unsafe.add(name); changed = true; }
    }
  }
  return unsafe;
}

/**
 * Scan comment-stripped `mcp/*.ts` source text for `server.registerTool(` blocks whose `ok(...)` exit
 * returns a whole raw project without `projectFields(` anywhere in that same call's payload. See header
 * (2)/(3). Returns {leaks: [{tool,payload}], projectTouchingTools: Set<toolName>}.
 */
function findWholeProjectLeaks(strippedSource) {
  const unsafeHelpers = resolveUnsafeHelpers(strippedSource);

  const registrations = [];
  let m;
  REGISTER_RE.lastIndex = 0;
  while ((m = REGISTER_RE.exec(strippedSource)) !== null) registrations.push({ tool: m[1], index: m.index });

  const leaks = [];
  const projectTouchingTools = new Set();

  for (let i = 0; i < registrations.length; i++) {
    const { tool, index: start } = registrations[i];
    const end = i + 1 < registrations.length ? registrations[i + 1].index : strippedSource.length;
    const block = strippedSource.slice(start, end);

    const unsafeVars = new Set();
    TYPED_LITERAL_RE.lastIndex = 0;
    while ((m = TYPED_LITERAL_RE.exec(block)) !== null) unsafeVars.add(m[1]);
    const ASSIGN_RE = /\b(?:const|let)\s+(\w+)\s*=\s*([^;\n]+)/g;
    let am;
    while ((am = ASSIGN_RE.exec(block)) !== null) {
      if (isUnsafeExpr(am[2], unsafeHelpers)) unsafeVars.add(am[1]);
    }

    if (unsafeVars.size > 0 || RAW_GETTER_ANCHOR_RE.test(block.trim())) projectTouchingTools.add(tool);
    // Block-wide (not anchored) touch signal for reporting purposes only — the raw call may sit deep in
    // the block, not just at its very start; use a looser test for the "touches a project" tally.
    if (/(?:this\.)?db\.(?:getProject|listAllProjects|listArchivedProjects)\(/.test(block)) projectTouchingTools.add(tool);

    const OK_CALL_RE = /(?<![.\w])ok\(/g;
    let om;
    while ((om = OK_CALL_RE.exec(block)) !== null) {
      const openParenIdx = om.index + om[0].length - 1;
      const payload = extractParenArgs(block, openParenIdx);
      if (MASKER_RE.test(payload)) continue; // masked in this exact call — safe

      let leak = RAW_GETTER_ANCHOR_RE.test(payload.trim());
      if (!leak) {
        for (const v of unsafeVars) {
          const re = new RegExp(`\\b${v}\\b(?![.:])`, "g");
          let vm;
          while ((vm = re.exec(payload)) !== null) {
            if (!isInsideQuotedRegion(payload, vm.index)) { leak = true; break; }
            if (re.lastIndex === vm.index) re.lastIndex++;
          }
          if (leak) break;
        }
      }
      if (leak) leaks.push({ tool, payload: payload.trim().replace(/\s+/g, " ").slice(0, 160) });
    }
  }
  return { leaks, projectTouchingTools };
}

// KNOWN-SAFE EXITS — allowlisted by (file, tool), each individually justified (card DoD-3). Both
// project_create and project_init, on BOTH the platform (Lead) and setup routers, construct a FRESH
// `Project` object in-process from `validateAgentProjectConfigOverride`'s OWN output — that validator
// REJECTS `sessionEnv` outright (confirmed by the reviewer's own execution, not by reading its source),
// so a freshly-created project's `config` structurally cannot carry one. This is safe by a DIFFERENT
// mechanism than masking — a validator upstream of the write, not a projection downstream of the read —
// and the allowlist entry is what makes that asymmetry visible: it breaks (correctly) the moment
// `validateAgentProjectConfigOverride` is ever relaxed to accept `sessionEnv`, because at that point the
// safety argument below is no longer true and this guard should start flagging these sites again.
const ALLOWLIST = new Set([
  "platform.ts::project_create",
  "platform.ts::project_init",
  "setup.ts::project_create",
  "setup.ts::project_init",
]);

// ============================= (0) sanity: the mcp/ dir is readable =============================
const mcpFiles = fs.readdirSync(MCP_DIR).filter((f) => f.endsWith(".ts"));
check(`(0) packages/daemon/src/mcp/ is readable and has a non-trivial number of .ts files (found ${mcpFiles.length})`,
  mcpFiles.length >= 10);

// ============================= (1) POSITIVE CONTROL — synthetic fixtures =============================
// Proves the DETECTOR generalizes to a tool/variable name it has never seen, including the two-hop
// helper-indirection shape (the REAL violation's shape — operator.ts's my_project traces THROUGH TWO
// wrapper hops, never a direct call in its own handler), not merely a direct-call leak.
{
  const DIRECT_LEAK = `
class FixtureRouter {
  buildServer() {
    const server = new McpServer();
    server.registerTool(
      "fixture_never_real_direct",
      { inputSchema: strictShape({}) },
      async ({ projectId }) => {
        return ok(db.getProject(projectId));
      },
    );
    return server;
  }
}
`;
  const { leaks: directLeaks } = findWholeProjectLeaks(DIRECT_LEAK);
  check("(1a) synthetic DIRECT raw-getter leak (never-seen tool name) is caught",
    directLeaks.some((l) => l.tool === "fixture_never_real_direct"));

  const DIRECT_FIXED = DIRECT_LEAK.replace("return ok(db.getProject(projectId));", "return ok(projectFields(db.getProject(projectId)));");
  const { leaks: directFixedLeaks } = findWholeProjectLeaks(DIRECT_FIXED);
  check("(1a-control) the SAME tool, once wrapped in projectFields, is clean", directFixedLeaks.length === 0);

  // The TWO-HOP shape: a bare var assigned from a LOCAL wrapper-of-a-wrapper — never a direct call in the
  // tool's own block — is exactly operator.ts's real, unfixed violation shape.
  const TWO_HOP_LEAK = `
class FixtureRouter {
  private resolveFixtureProject(id) {
    return this.db.getProject(id) ?? null;
  }
  buildServer() {
    const ownFixtureProject = () => this.resolveFixtureProject("x");
    const server = new McpServer();
    server.registerTool(
      "fixture_never_real_two_hop",
      { inputSchema: strictShape({}) },
      async () => {
        const p = ownFixtureProject();
        return p ? ok(p) : ok({ error: "no project for this session" });
      },
    );
    return server;
  }
}
`;
  const { leaks: twoHopLeaks } = findWholeProjectLeaks(TWO_HOP_LEAK);
  check("(1b) synthetic TWO-HOP helper-indirection leak (never-seen names, operator.ts's real shape) is caught",
    twoHopLeaks.some((l) => l.tool === "fixture_never_real_two_hop"));

  const TWO_HOP_FIXED = TWO_HOP_LEAK.replace(
    "return p ? ok(p) : ok({ error: \"no project for this session\" });",
    "return p ? ok(projectFields(p)) : ok({ error: \"no project for this session\" });",
  );
  const { leaks: twoHopFixedLeaks } = findWholeProjectLeaks(TWO_HOP_FIXED);
  check("(1b-control) the SAME two-hop tool, once wrapped, is clean", twoHopFixedLeaks.length === 0);

  // A TYPED-LITERAL leak — the project_create/project_init shape (a FRESH object, never a DB read).
  const TYPED_LITERAL_LEAK = `
class FixtureRouter {
  buildServer() {
    const server = new McpServer();
    server.registerTool(
      "fixture_never_real_typed_literal",
      { inputSchema: strictShape({}) },
      async ({ name }) => {
        const project: Project = { id: randomUUID(), name, config: v.value };
        db.insertProject(project);
        return ok(project);
      },
    );
    return server;
  }
}
`;
  const { leaks: typedLeaks } = findWholeProjectLeaks(TYPED_LITERAL_LEAK);
  check("(1c) synthetic TYPED-LITERAL leak (a freshly-constructed Project, never a DB read) is caught",
    typedLeaks.some((l) => l.tool === "fixture_never_real_typed_literal"));

  // Field-access / object-key exclusions must NOT false-positive.
  const FIELD_ACCESS_SAFE = `
class FixtureRouter {
  buildServer() {
    const server = new McpServer();
    server.registerTool(
      "fixture_field_access_only",
      { inputSchema: strictShape({}) },
      async ({ projectId }) => {
        const p = db.getProject(projectId);
        if (!p) return ok({ error: "project not found" });
        return ok({ repoPath: p.repoPath, name: p.name });
      },
    );
    return server;
  }
}
`;
  const { leaks: fieldAccessLeaks } = findWholeProjectLeaks(FIELD_ACCESS_SAFE);
  check("(1d-control) a response that only reads FIELDS off a raw project var (never the whole value) is NOT flagged",
    fieldAccessLeaks.length === 0);

  // getByIdPrefix's own callback-argument shape must NOT false-positive: the raw getter appears only
  // INSIDE a callback it passes to a shared cross-file utility, never as ITS OWN return value.
  const GET_BY_ID_PREFIX_SAFE = `
class FixtureRouter {
  buildServer() {
    const server = new McpServer();
    server.registerTool(
      "fixture_get_by_id_prefix_narrowed",
      { inputSchema: strictShape({}) },
      async ({ projectId }) => {
        const resolved = getByIdPrefix(projectId, (id) => db.getProject(id), () => db.listAllProjects(), "project");
        if ("error" in resolved) return ok(resolved);
        return ok(projectFields(resolved));
      },
    );
    return server;
  }
}
`;
  const { leaks: getByIdPrefixLeaks } = findWholeProjectLeaks(GET_BY_ID_PREFIX_SAFE);
  check("(1e-control) a getByIdPrefix-narrowed error branch (never the whole project) is NOT flagged",
    getByIdPrefixLeaks.length === 0);
}

// ============================= (2) THE REAL SCAN — mcp/*.ts today =============================
{
  const allLeaks = [];
  let projectTouchingCount = 0;
  for (const file of mcpFiles) {
    const raw = fs.readFileSync(path.join(MCP_DIR, file), "utf8");
    const stripped = stripComments(raw);
    const { leaks, projectTouchingTools } = findWholeProjectLeaks(stripped);
    projectTouchingCount += projectTouchingTools.size;
    for (const l of leaks) allLeaks.push({ file, ...l });
  }

  check(`(2) the scan finds a non-trivial population of project-touching tools today (found ${projectTouchingCount}, floor 5)`,
    projectTouchingCount >= 5);

  const nonAllowlisted = allLeaks.filter((l) => !ALLOWLIST.has(`${l.file}::${l.tool}`));
  const allowlisted = allLeaks.filter((l) => ALLOWLIST.has(`${l.file}::${l.tool}`));

  // Every allowlist entry must actually correspond to a REAL raw finding today — an allowlist entry that
  // matches NOTHING is silently guarding nothing (the code moved on and the entry is stale window-
  // dressing); assert the allowlist isn't vacuous.
  const matchedAllowlistKeys = new Set(allowlisted.map((l) => `${l.file}::${l.tool}`));
  const staleAllowlistEntries = [...ALLOWLIST].filter((k) => !matchedAllowlistKeys.has(k));
  check(`(2) every allowlist entry matches a real raw finding today (stale entries: ${staleAllowlistEntries.join(", ") || "none"})`,
    staleAllowlistEntries.length === 0);

  // ⚠️ THE LOAD-BEARING RED PROOF (card DoD-2): as of this writing, `mcp/operator.ts`'s `my_project` is a
  // REAL, PROVEN, UNFIXED violation (card `a4637a0c`, not yet dispatched — see that card and
  // `c5fddaef`'s own body). This assertion is EXPECTED TO FAIL until `a4637a0c` lands; that failure IS
  // the proof this guard can catch the class it exists for, not a bug in this file. Once `a4637a0c`
  // ships, this assertion goes green with no further change here.
  check(`(2) EVERY non-allowlisted whole-project MCP exit passes through projectFields (offenders: ${nonAllowlisted.length === 0 ? "none" : nonAllowlisted.map((l) => `${l.file}::${l.tool} [${l.payload}]`).join(" | ")})`,
    nonAllowlisted.length === 0);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the chokepoint-drift detector catches a synthetic direct-getter, two-hop-helper-indirection, and typed-literal leak on tool/variable names it has never seen (and clears once each is wrapped through projectFields), a field-access-only response and a getByIdPrefix-narrowed error branch are correctly left unflagged, every allowlist entry matches a real finding, and every non-allowlisted whole-project MCP exit in mcp/*.ts today passes through projectFields."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
