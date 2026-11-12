import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Epic f437d4e9 C6 (the verification card) — DoD-2 NO-DOGFOOD DENYLIST, per §3e of
// docs/decisions/f437d4e9-end-user-platform-lead.md. Proves that NONE of the four surfaces a fresh
// end-user Platform Lead session receives on a NON-DEV install carry Loom-dogfood/personal content:
//   (a) the seeded startup prompt (fresh seed) + the ACTUAL composed fresh-spawn text (real spawn).
//   (b) EVERY skill the Lead's OWN injectSkills resolution actually delivers (derived from a real
//       injectSkills() call against a curated store, never a hand-picked file list) — SKILL.md, every
//       references/** file, and every scripts/** file, since a shipped script's own comments are file
//       content an agent can Read like any other.
//   (c) injected blocks a fresh end-user session gets: the "Where things live" pre-block, the real
//       continuation/recycle text, and the resume-doc operational notes (size + staleness), all captured
//       off REAL spawn/recycle calls — never hand-constructed strings.
//   (d) the PlatformMcpRouter's own rendered tool `description` strings (tools/list) + representative
//       runtime error strings — including a DEEPER validation error per tool family, not only a
//       project-lookup-miss — on the NON-DEV surface.
//   (e) card a2f2becc: EVERY OTHER shipped, end-user-reachable MCP router's rendered tool descriptions —
//       OrchestrationMcpRouter (manager/worker/companion), TaskMcpRouter, SetupMcpRouter,
//       RunMcpRouter, WorkspaceAuditMcpRouter — scanned by TWO independent ratchets: the "decision/card id
//       citation" pattern alone (ROUTER_ID_CITATION_ALLOWLIST, from a2f2becc) and, since card 0018c8ab,
//       every OTHER DENY_PATTERNS entry too (ROUTER_NON_ID_HIT_ALLOWLIST — see that const's own header for
//       why it's a separate table, never merged with the id-citation one).
//       SetupMcpRouter/RunMcpRouter are zero-tolerance on BOTH ratchets; the other three
//       carry a SIZED, exact-count backlog on the id-citation ratchet, and — after card 0018c8ab's cleanup
//       — a small, FULLY REASONED (never backlog) set of entries on the non-id one. audit.ts
//       (role==="auditor") is deliberately excluded — LOOM_DEV-only seed, unreachable on a real install.
//
// OUT OF SCOPE (deliberately, stated here so it's never mistaken for an oversight): the project-memory
// digest injected at kickoff is USER-AUTHORED content on a real end-user install (notes THEIR workers/
// managers wrote) — there is nothing Loom-shipped in it to scan, and scanning a user's own notes for
// "dogfood" is a category error. The owner's real name/email is also never written into any shipped
// surface in the first place (confirmed by inspection, not by a runtime check here) — embedding it as a
// literal in this test would itself be the kind of disclosure this repo's own conventions avoid.
//
// PATTERN CHOICE (per C6's own triage note + the Code Review on C6's first pass): the shipped
// `platform-lead/SKILL.md` legitimately says "the Loom Platform Lead" — a product+role name allowed by
// spec §3a — and `setup-assistant/SKILL.md` legitimately says "the Loom Platform operator" (the SAME
// product naming, "Platform" being the end-user operator's own display name, setup/seed.ts's
// SETUP_AGENT_NAME). A bare "Loom Platform" substring match would FALSE-POSITIVE on both. The denylist
// instead targets the reserved DEV home/project name IN CONTEXT: "Loom Platform" NOT immediately followed
// by " Lead"/" Auditor"/" operator" (the three role-name phrases the shipped corpus actually uses).
// Separately, a bare "Loom's own" pattern was found (against the REAL delivered skill corpus, not
// hypothetically) to false-positive on ordinary product-behavior prose used throughout orchestrate/
// SKILL.md ("Loom's own retry budget", "Loom's own give-up/retry", …) and web-design's own NOTICE ("Loom's
// own voice") — none of these leak anything repo-internal. Narrowed to the shape that actually IS a tell:
// "Loom's own" followed by a noun identifying the REPO/DEV-PROCESS artifact itself (repo, codebase, source,
// CLAUDE.md, dev team, git/commit history) — none of which appear anywhere in the real corpus today, so
// this narrower form currently finds zero real hits (a standing regression guard, not dead code: see the
// positive control, which still proves it fires).
//
// Per §3e's own "literal-token checks... re-derive at test-authoring time... don't copy this list into
// the test as gospel" — every pattern below was re-derived against the REAL current shipped content at
// authoring time, not copied from the decision record's own illustrative examples.
//
// POSITIVE CONTROLS (required by this card's own DoD, all four surfaces) are PLANTS, not string
// concatenation copies: each one writes (or injects) a denylisted token into the REAL source the surface
// is read from, then re-runs that surface's OWN real capture path (re-spawn, re-inject, or a wrapped real
// McpServer.registerTool) and scans what comes back out — never a bare `cleanText + contaminant` JS
// string, which would only prove the scan() function works on arbitrary text, not that it's wired to the
// real surface.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: real seeders + a real Db + SessionService against a fake
// pty (the shared `_seam-host-fixture.mjs` seam, same pattern as platform-lead-recycle.mjs), a real
// injectSkills() call against a curated skill store, and a real PlatformMcpRouter (surface (d)) / every
// other router in SHIPPED_END_USER_MCP_SURFACES (surface (e)) read back over an in-memory MCP client.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-end-user-no-dogfood.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, "..", "assets");

// A hex-shaped id that is NOT purely numeric (a date, a record count) and NOT purely alphabetic (an
// unlikely but possible all-[a-f] token) — requires at least one digit AND at least one a-f letter — AND
// is a genuine standalone TOKEN, not a substring of something longer: bounded on both sides by neither a
// word character NOR a hyphen. The hyphen exclusion (beyond plain `\b`) is load-bearing, not cosmetic —
// `\b` alone treats a hyphen as a valid boundary, so a bare v4-uuid's own first 8-hex segment (e.g.
// "1c48279c-a4e7-4c55-...", a real session/project id shape used throughout this repo's own generated
// content) would otherwise false-positive identically to a real short id (measured directly: a real
// composed fresh-spawn prompt's own temp-path segment tripped the bare form before this exclusion was
// added). Card 3a721c44.
const HEX_ID_CORE =
  "(?<![\\w-])(?=[0-9a-f]{8}(?![\\w-]))(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{8}";

// Single source of truth for an id-citation shape — `@decision <id>`, `@decision sha:<id>`, `card <id>`/
// `cards <id>`, `decision <id>`/`decisions <id>`, `record <id>`/`records <id>`, `task <id>`/`tasks <id>`,
// a backtick-wrapped id, OR a BARE id anywhere, word-bounded (card 3a721c44) — all equally unresolvable
// off an npm install. The bare final alternative is a SUPERSET of every other alternative here (each of
// them already leaves the id itself word-bounded) — it is what catches a parenthetical "(db9b0130)", a
// possessive "99a1cf6f's", and a plural list's SECOND-and-later id ("cards X, Y" — the keyword
// alternative catches the first, this one catches the rest) without a separate list-continuation
// grammar. The other alternatives exist only for readability; don't rely on their absence to skip a case
// the bare one already covers. Shared by DENY_PATTERNS's own entry below, idCitationCount, and every
// positive control that plants or strips one, so widening this ONE source widens every consumer at once
// (card a2f2becc round 2 CR; card 3a721c44 widened it further).
const ID_CITATION_RE_SOURCE =
  "@decision\\s+(?:sha:)?" + HEX_ID_CORE +
  "|\\b(?:cards?|decisions?|records?|tasks?)\\s+" + HEX_ID_CORE +
  "|`" + HEX_ID_CORE + "`" +
  "|\\b" + HEX_ID_CORE + "\\b";

// ===================== THE DENYLIST — re-derived against real shipped content, not copied verbatim =====
const DENY_PATTERNS = [
  // §3e structural rule: zero @decision/card-id citations of the 8-hex shape, full stop — the id-space is
  // never resolvable off an npm install (no docs/decisions/ ships).
  { name: "decision/card id citation", re: new RegExp(ID_CITATION_RE_SOURCE, "i") },
  { name: "packages/ path", re: /packages\// },
  { name: "@loom/ package scope", re: /@loom\// },
  { name: "pnpm --filter", re: /pnpm --filter/ },
  { name: "pnpm build command", re: /\bpnpm build\b/ },
  { name: "pnpm daemon command", re: /\bpnpm daemon\b/ },
  { name: "worktrees.ts", re: /worktrees\.ts/ },
  // Narrowed (see header): a repo/dev-process artifact noun, never a bare "Loom's own <anything>" —
  // the broad form false-positived on ordinary product-behavior prose in the real delivered corpus.
  // The extra nouns (project/board/recommended/command/web UI) are the real dogfood shapes this
  // repo's own CLAUDE.md actually uses ("Loom's own recommended value", "Loom's own project until the
  // owner sets it", "Loom's own command", "Loom's own web UI") — measured zero false positives against
  // the real delivered skill corpus (see the pattern self-check below, drawn from that same CLAUDE.md text).
  // Card 0018c8ab: "home" was REMOVED from this alternation — it had no real CLAUDE.md/corpus example
  // backing it (unlike every sibling noun above, which the self-check quotes verbatim from CLAUDE.md),
  // and it false-positived on vault_write's own genuine, per-install-generic "Loom's own [operational]
  // home directory" text (the daemon's own LOOM_HOME concept, present on every install — not the
  // reserved dev-home PROJECT the sibling "dev reserved-home name in context" pattern below already
  // covers). See the pattern self-check below for the negative control on that exact text.
  { name: "\"Loom's own\" repo/dev-process artifact", re: /Loom's own (?:repo(?:sitory)?|codebase|source(?: code)?|CLAUDE\.md|dev(?:elopment)? team|git history|commit history|project|board|recommended|command|web UI)\b/i },
  { name: "\"Loom-product development\"", re: /Loom-product development/ },
  { name: "\"self-hosting Loom\"", re: /self-hosting Loom/i },
  { name: "\"orchestrating Loom with Loom\"", re: /orchestrating Loom with Loom/i },
  { name: "Projects/Loom vault path", re: /Projects\/Loom/ },
  { name: "daemon_restart tool name", re: /daemon_restart/ },
  { name: "LOOM_DEV env var token", re: /\bLOOM_DEV\b/ }, // word boundary: a sibling-named var like LOOM_DEV_SERVER_PORT_TIMEOUT_MS is a different, unrelated env var, not a hit
  // The reserved DEV home/project's own display name IN CONTEXT — never the product+role phrases "the
  // Loom Platform Lead"/"...Auditor"/"...operator" (§3a-allowed, and "operator" is setup-assistant's own
  // end-user-facing naming — its agent is literally display-named "Platform"). A bare "Loom Platform" not
  // immediately followed by one of those three role words is the dev-home-name usage this denylist exists
  // to catch.
  { name: "dev reserved-home name in context (not \"...Lead\"/\"...Auditor\"/\"...operator\")", re: /Loom Platform(?!\s+(Lead|Auditor|operator))/ },
];

function scan(text) {
  const hits = [];
  for (const p of DENY_PATTERNS) if (p.re.test(text)) hits.push(p.name);
  return hits;
}

function assertClean(surfaceLabel, text) {
  const hits = scan(text);
  check(`(clean) ${surfaceLabel} carries ZERO dogfood tokens (offenders: ${hits.join(", ") || "none"})`, hits.length === 0);
}

// A per-FILE scan for surface (b), honoring a judgment-curated, reasoned allowlist of real, pre-approved
// occurrences (same posture as this repo's own KNOWN_BARE_DEBT-style guards: explicit, never silent, and
// re-verified every run rather than trusted forever). An allowlist entry is honored ONLY when the file's
// text still contains its own `mustContain` anchor VERBATIM and the pattern fires EXACTLY the expected
// count on that file — so a NEW, different occurrence of the same pattern (or the known one changing
// shape) still fails loud instead of riding the exemption.
const SKILL_SURFACE_ALLOWLIST = [
  {
    file: "orchestrate/SKILL.md",
    pattern: "daemon_restart tool name",
    expectedCount: 1,
    mustContain: "a `daemon_restart`/deploy where your surface has",
    reason:
      "orchestrate is shared doctrine read by BOTH managers (daemon_restart is UNCONDITIONALLY registered " +
      "for every manager, mcp/orchestration.ts — no isLoomDev() gate) and the Platform Lead (whose OWN copy " +
      "IS isLoomDev()-gated, mcp/platform.ts) — the wording is conditional (\"where your surface has it\"), " +
      "never a flat claim the reader definitely holds the tool. Code Review ruling on C6.",
  },
];

// ===================== (e) infra — the ROUTER id-citation RATCHET =======================================
// @decision a2f2becc — this ratchet covers id-citations ONLY; never treat it as proof the OTHER denylist
// hits found on these routers are gone (a separate, unfixed finding), and never lower an allowlist entry
// below without a real landed cleanup backing it.
//
// SCOPE: this ratchet covers ONLY the "decision/card id citation" pattern — NOT the full DENY_PATTERNS
// set surface (d)'s assertClean uses for PlatformMcpRouter. A clean run of section (e) below is NOT proof
// every other denylist pattern is clean on these routers — section (e) never scans for them.
//
// A SIZED CLEANUP BACKLOG, not a permanent exemption (same posture as SKILL_SURFACE_ALLOWLIST above) —
// EXACT-count per (surface, tool), re-measured every run: an INCREASE fails loud (a new citation slipped
// in), and so does a DECREASE (the stale-entry check — see positive control (ii) below) until the number
// here is lowered to match a real landed cleanup.
//
// Card 3a721c44: the widened pattern's own bare-hex alternative (see ID_CITATION_RE_SOURCE's own doc)
// catches two legitimate FORMAT EXAMPLES that were always there but that the OLD, narrower pattern never
// saw — a tool's description illustrating the shape of an id a caller might pass, not a citation of a
// real decision/card. Both are REASONED, permanent entries (never backlog debt — unlike the cleanup-
// backlog entries this list used to carry before cards 6927a53f/03249f1e drained it to empty), re-
// verified every run exactly like every other entry here: an increase OR a decrease still fails loud.
// Every OTHER shipped, end-user-reachable MCP router/tool stays at the implicit expectedCount of 0.
const ROUTER_ID_CITATION_ALLOWLIST = [
  {
    surface: "TaskMcpRouter(worker)", tool: "decisions_for", expectedCount: 2,
    reason: "the description illustrates `query`'s own accepted SHAPES with real-looking examples — " +
      "\"a32533a1\" (a bare 8-hex id) and \"sha:c70a5e0e\" (the sha: form) — never a citation of either as " +
      "a real decision/card; TaskMcpRouter renders identically for worker and manager.",
  },
  {
    surface: "TaskMcpRouter(manager)", tool: "decisions_for", expectedCount: 2,
    reason: "same format-example precedent as TaskMcpRouter(worker)::decisions_for above — one render per role.",
  },
  {
    surface: "OrchestrationMcpRouter(manager)", tool: "agent_list", expectedCount: 1,
    reason: "the description illustrates resolving an agent-id PREFIX with a real-looking example " +
      "(\"b5d7304f…\") — never a citation of a real decision/card.",
  },
];

function idCitationCount(text) {
  return [...text.matchAll(new RegExp(ID_CITATION_RE_SOURCE, "gi"))].length;
}
function idCitationExpected(surface, tool) {
  const entry = ROUTER_ID_CITATION_ALLOWLIST.find((e) => e.surface === surface && e.tool === tool);
  return entry ? entry.expectedCount : 0; // no entry ⇒ hard zero-tolerance (Setup/Operator/Run/Platform)
}
// The ONE pure predicate the live check AND every positive control below call — never a second,
// independently-reimplemented comparison. A mutant that weakens this function's own `ok` logic (e.g.
// "real <= expected", or an unconditional `true`) must turn EVERY caller red, live check and controls
// alike; before this extraction, the controls recomputed `real > expected` / `real < expected` inline
// and so proved nothing about the live check's actual comparison (card a2f2becc round 2 CR).
function ratchetVerdict(surface, toolName, text) {
  const real = idCitationCount(text);
  const expected = idCitationExpected(surface, toolName);
  return { ok: real === expected, real, expected };
}
// THE ONE function every ratchet consumer calls — the live loop below AND every positive control (i)/(ii)/
// (iii). A mutant that corrupts this function's own verdict (e.g. a wrapper that always reports `ok:true`)
// must turn every caller red identically, live check and controls alike (card a2f2becc round 3 CR, mutant
// m3) — before this extraction, each control called `ratchetVerdict` directly itself, so a mutation scoped
// to the LIVE LOOP's own wrapper could silently stop catching regressions while a control (on its own
// separately-computed verdict) kept passing, masking exactly the kind of drift this exists to catch.
function scanSurfaceRatchet(surfaceLabel, tools) {
  return tools.map((t) => ({ tool: t.name, ...ratchetVerdict(surfaceLabel, t.name, t.description ?? "") }));
}

// Card a2f2becc round 3, task 3: every BASELINED (surface, tool) pair in ROUTER_ID_CITATION_ALLOWLIST must
// have been actually SEEN in that surface's own render. The live loop below only iterates the tools that
// DID render, so a baselined tool that silently stops rendering (its gating config dropped, it was
// renamed, or removed outright) would otherwise never get checked at all, rather than failing loud. Call
// ONCE per surface, right after that surface's own render.
function assertAllowlistEntriesSeen(surfaceLabel, renderedToolNames) {
  for (const entry of ROUTER_ID_CITATION_ALLOWLIST) {
    if (entry.surface !== surfaceLabel) continue;
    check(`(ratchet coverage) ${surfaceLabel} :: ${entry.tool} is baselined in ROUTER_ID_CITATION_ALLOWLIST ` +
      `and was actually SEEN in this surface's own render (a vanished baselined tool must fail, not go ` +
      `silently unchecked)`, renderedToolNames.has(entry.tool));
  }
}

// ===================== (e) infra — the ROUTER NON-ID DENYLIST RATCHET (card 0018c8ab) ===================
// Card 0018c8ab — this ratchet covers EVERY DENY_PATTERNS entry EXCEPT "decision/card id citation"
// (that one keeps its own separate ROUTER_ID_CITATION_ALLOWLIST ratchet above — the two are independent
// and never merged: an id-citation count change and a non-id hit change are different kinds of drift).
//
// SAME POSTURE as ROUTER_ID_CITATION_ALLOWLIST: a SIZED, EXACT-count backlog per (surface, tool, pattern),
// re-measured every run — an INCREASE fails loud (a new leak slipped in) and so does a DECREASE (the
// stale-entry check below) until the baseline here is lowered to match a real landed cleanup. UNLIKE that
// ratchet, every entry here is REQUIRED to carry a one-line `reason` — card 0018c8ab's own investigation
// found these are the ONLY non-id hits surviving a full cleanup pass, and each one is a deliberate,
// reasoned choice (conditional phrasing naming a tool the reader may not have), never backlog debt. A
// NEW tool/surface with no entry below is implicitly expectedCount:0 for every non-id pattern — hard
// zero-tolerance, matching the id-citation ratchet's own default.
const ROUTER_NON_ID_HIT_ALLOWLIST = [
  {
    surface: "OrchestrationMcpRouter(manager)", tool: "served_status", pattern: "daemon_restart tool name", expectedCount: 2,
    reason: "conditional phrasing (\"via daemon_restart where your surface has it, or a human relaunch " +
      "otherwise\") naming the tool for a reader who may not have it — the orchestrate/SKILL.md precedent " +
      "(SKILL_SURFACE_ALLOWLIST above), never a flat claim the reader holds it.",
  },
];

function nonIdHitCounts(text) {
  const out = {};
  for (const p of DENY_PATTERNS) {
    if (p.name === "decision/card id citation") continue; // owned by the separate id-citation ratchet
    const re = new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : p.re.flags + "g");
    const n = [...text.matchAll(re)].length;
    if (n > 0) out[p.name] = n;
  }
  return out;
}
function nonIdHitExpected(surface, tool, pattern) {
  const entry = ROUTER_NON_ID_HIT_ALLOWLIST.find((e) => e.surface === surface && e.tool === tool && e.pattern === pattern);
  return entry ? entry.expectedCount : 0; // no entry ⇒ hard zero-tolerance
}
// THE ONE predicate every non-id-ratchet consumer calls — same mutant-resistance shape as ratchetVerdict
// above (card a2f2becc round 3 CR precedent): a live-loop-only wrapper bug and a control-only bug must
// both be caught by the SAME function, never two independently-reimplemented comparisons.
function nonIdRatchetVerdicts(surface, toolName, text) {
  const real = nonIdHitCounts(text);
  const names = new Set([...Object.keys(real), ...ROUTER_NON_ID_HIT_ALLOWLIST.filter((e) => e.surface === surface && e.tool === toolName).map((e) => e.pattern)]);
  return [...names].map((pattern) => {
    const r = real[pattern] ?? 0;
    const expected = nonIdHitExpected(surface, toolName, pattern);
    return { pattern, ok: r === expected, real: r, expected };
  });
}
// Mirrors assertAllowlistEntriesSeen above: a baselined (surface, tool, pattern) triple that silently
// stops rendering (tool renamed/removed/regated) must fail loud, not go unchecked — the live loop below
// only iterates tools that DID render.
function assertNonIdAllowlistEntriesSeen(surfaceLabel, renderedToolNames) {
  for (const entry of ROUTER_NON_ID_HIT_ALLOWLIST) {
    if (entry.surface !== surfaceLabel) continue;
    check(`(non-id ratchet coverage) ${surfaceLabel} :: ${entry.tool} is baselined in ` +
      `ROUTER_NON_ID_HIT_ALLOWLIST and was actually SEEN in this surface's own render`, renderedToolNames.has(entry.tool));
  }
}

// ===================== (e) infra — STRUCTURAL COVERAGE (card a2f2becc round 3) ==========================
// Never trust a hand-maintained "every router/surface I remembered to add" render list; the EXPECTED tool
// set for each shipped router is instead DERIVED from its own SOURCE (every literal
// `.registerTool("<name>"` call in that router's file(s)) — so a NEW conditional tool nobody renders FAILS
// this check, instead of silently escaping the scan the way it did for two prior rounds of this ratchet
// (each one patched a hand-maintained render list only after a Code Review caught the hole by hand).
//
// EXTRACTION METHOD: a plain source-TEXT regex scan for `.registerTool(` followed (across whitespace/
// newlines) by a double-quoted literal name — never an AST parse. Every call site across every file this
// scan reads passes a literal first arg today (verified directly, see the sanity check below) — a FUTURE
// non-literal registration (a computed/templated name) must fail THIS run LOUD, not silently escape the
// scan: every extraction call first asserts the file's own `.registerTool(` call COUNT matches the
// literal-name match count, and fails if they ever diverge.
const REGISTER_TOOL_CALL_RE = /\.registerTool\(/g;
const REGISTER_TOOL_LITERAL_RE = /\.registerTool\(\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/g;

function expectedToolNamesFromSource(relSrcPaths) {
  const names = new Set();
  for (const relPath of relSrcPaths) {
    const text = fs.readFileSync(path.join(__dirname, "..", "src", relPath), "utf8");
    const callCount = [...text.matchAll(REGISTER_TOOL_CALL_RE)].length;
    const literalMatches = [...text.matchAll(REGISTER_TOOL_LITERAL_RE)];
    check(`(coverage) sanity: every .registerTool( call site in ${relPath} resolves to a literal name ` +
      `(calls=${callCount}, literal-matches=${literalMatches.length}) — a non-literal registration must ` +
      `fail this run loudly, never silently escape the source scan`, callCount === literalMatches.length);
    for (const m of literalMatches) names.add(m[1]);
  }
  return names;
}

// Which shipped-router SOURCE FILE(S) back each SURFACE LABEL in SHIPPED_END_USER_MCP_SURFACES below —
// several surfaces (the manager/worker/assistant role-variants of one router, or worker/manager of
// another) share ONE file group, since a role-gated tool only appears in SOME role's render: the expected-
// vs-actual comparison is a UNION across every surface sharing a group, never one surface's render alone.
const ROUTER_SOURCE_FILE_GROUPS = {
  OrchestrationMcpRouter: ["mcp/orchestration.ts", "companion/capabilities.ts"],
  TaskMcpRouter: ["mcp/server.ts", "mcp/decisions.ts"],
  SetupMcpRouter: ["mcp/setup.ts"],
  RunMcpRouter: ["mcp/run.ts"],
  // repo-read.ts's literal registerTool() names are shared by its DEV (mcp/audit.ts, excluded below) and
  // END-USER (mcp/user-audit.ts) call sites under the SAME three names (repo_read_file/repo_grep/
  // repo_glob) — the structural-coverage scan can't tell the two variants apart by name alone; see task
  // (d)'s own gate_cancel check below for why that matters and how both call sites are still verified.
  WorkspaceAuditMcpRouter: ["mcp/user-audit.ts", "mcp/transcript-read.ts", "mcp/repo-read.ts"],
  // Card a2f2becc round 4: PlatformMcpRouter was the one shipped, end-user-reachable router with NO
  // structural-coverage group at all — fed by section (d)'s existing non-dev render, never a new render
  // scenario here (PlatformMcpRouter is not, and does not need to be, in SHIPPED_END_USER_MCP_SURFACES).
  PlatformMcpRouter: ["mcp/platform.ts"],
};
function fileGroupForSurfaceLabel(label) {
  const key = Object.keys(ROUTER_SOURCE_FILE_GROUPS).find((k) => label.startsWith(k));
  if (!key) throw new Error(`no ROUTER_SOURCE_FILE_GROUPS entry for surface label "${label}" — add one`);
  return key;
}

// A literal registerTool() name that can NEVER appear in ANY of this file's own renders, with a REASON —
// never used to wave off a genuine coverage gap (a tool that SHOULD render belongs in a new render
// scenario among SHIPPED_END_USER_MCP_SURFACES below, not an exclusion here).
const ROUTER_COVERAGE_EXCLUSIONS = [
  {
    fileGroup: "OrchestrationMcpRouter",
    tool: "daemon_restart",
    reason: "isSupervised()-gated (mcp/orchestration.ts) — never registers on a non-supervised, non-dev " +
      "npm end-user install, which is this whole test file's premise (LOOM_SUPERVISED is deliberately " +
      "deleted above); CLAUDE.md: \"the end-user daemon runs NO supervisor\".",
  },
  {
    fileGroup: "PlatformMcpRouter",
    tool: "daemon_restart",
    reason: "isLoomDev()-gated (mcp/platform.ts) — never registers on a non-dev npm end-user install, " +
      "which is this whole test file's premise (LOOM_DEV is deliberately deleted above) — the Lead-surface " +
      "twin of the manager's own daemon_restart exclusion directly above.",
  },
];

// A plain source-TEXT scan (never an AST parse, same posture as REGISTER_TOOL_CALL_RE above): every file
// under packages/daemon/src/**/*.ts containing a literal `.registerTool(` call must be named in SOME
// ROUTER_SOURCE_FILE_GROUPS entry above, or carry a reasoned entry here — so a brand-new router file, or a
// new registerTool call landing in a file nobody added to a group, fails this run loudly instead of
// silently escaping both the structural-coverage scan and this meta-check (card a2f2becc round 4, task b).
const FILE_LEVEL_COVERAGE_EXCLUSIONS = [
  {
    file: "mcp/audit.ts",
    reason: "AuditMcpRouter (role===\"auditor\") — LOOM_DEV-only seed (the Platform Auditor); structurally " +
      "unreachable on a real end-user install, same posture as this file's own header note on why audit.ts " +
      "is absent from SHIPPED_END_USER_MCP_SURFACES.",
  },
];

function scanSkillFile(relPath, text) {
  const hits = [];
  for (const p of DENY_PATTERNS) {
    const allowed = SKILL_SURFACE_ALLOWLIST.find((a) => a.file === relPath && a.pattern === p.name);
    const matches = text.match(new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : p.re.flags + "g")) || [];
    if (matches.length === 0) continue;
    if (allowed && matches.length === allowed.expectedCount && text.includes(allowed.mustContain)) continue; // reasoned, re-verified exemption
    hits.push(`${p.name} (x${matches.length}${allowed ? ", allowlist anchor mismatch — treated as a real hit" : ""})`);
  }
  return hits;
}

// Sanity: the "Lead"/"Auditor"/"operator" exemption in the dev-home pattern must NOT itself create a hole
// a real dev-home-name leak could hide behind.
{
  const devHomeRe = DENY_PATTERNS.find((p) => p.name.startsWith("dev reserved-home")).re;
  check("(pattern self-check) \"the Loom Platform Lead\" (the legit, spec-allowed phrase) does NOT trip the dev-home-name pattern",
    !devHomeRe.test("the operating doctrine for the Loom Platform Lead"));
  check("(pattern self-check) \"the Loom Platform Auditor\" also does NOT trip it",
    !devHomeRe.test("field findings to the Loom Platform Auditor"));
  check("(pattern self-check) \"the Loom Platform operator\" (setup-assistant's own product naming) also does NOT trip it",
    !devHomeRe.test("the operating doctrine for the Loom Platform operator"));
  check("(pattern self-check) a BARE \"Loom Platform\" (the dev home's own display name, no role suffix) DOES trip it",
    devHomeRe.test("no reserved Loom Platform project exists"));

  const loomsOwnRe = DENY_PATTERNS.find((p) => p.name.startsWith("\"Loom's own\"")).re;
  check("(pattern self-check) \"Loom's own retry budget\" (real orchestrate/SKILL.md prose) does NOT trip the narrowed Loom's-own pattern",
    !loomsOwnRe.test("Loom's own retry budget giving up, not evidence the"));
  check("(pattern self-check) \"Loom's own voice\" (real web-design/NOTICE prose) does NOT trip it either",
    !loomsOwnRe.test("This skill is original prose written in Loom's own voice."));
  check("(pattern self-check) \"Loom's own repo\" (the genuine dogfood shape) DOES trip it",
    loomsOwnRe.test("a fix landed in Loom's own repo last week"));
  check("(pattern self-check) \"Loom's own CLAUDE.md\" DOES trip it too",
    loomsOwnRe.test("per Loom's own CLAUDE.md"));
  // The following four are REAL excerpts (not invented strings built off this pattern's own alternation)
  // — lifted verbatim from this repo's own CLAUDE.md, which is exactly the kind of dogfood prose the
  // widened alternation (project/board/recommended/command/web UI) exists to catch.
  check("(pattern self-check) REAL CLAUDE.md text \"Loom's own recommended value\" DOES trip it",
    loomsOwnRe.test("Loom's own recommended value** (measured on this host, card `bd9a483b`)"));
  check("(pattern self-check) REAL CLAUDE.md text \"Eyeballing Loom's own web UI\" DOES trip it",
    loomsOwnRe.test("Eyeballing Loom's own web UI with a real, authenticated browser"));
  check("(pattern self-check) REAL CLAUDE.md text \"Loom's own project until the owner sets it\" DOES trip it",
    loomsOwnRe.test("a GREEN proceeds exactly as an ordinary ungated landing did before this existed — Loom's own project until the owner sets it"));
  check("(pattern self-check) REAL CLAUDE.md text \"without naming Loom's own command\" DOES trip it",
    loomsOwnRe.test("shipped skills/docs describe it without naming Loom's own command"));
  // Card 0018c8ab: "home" was removed from this pattern's alternation — negative control proves the
  // REAL vault_write text (and its companion/capabilities.ts sibling wording) no longer trips it; the
  // positive control for "the reserved dev-home PROJECT phrasing still matches" is the separate
  // devHomeRe checks just above (386-387) — a DIFFERENT pattern, deliberately unaffected by this change.
  check("(pattern self-check) the REAL vault_write text \"Loom's own home directory\" no longer trips the narrowed Loom's-own pattern",
    !loomsOwnRe.test("'operational-dir' if this project's vault points at Loom's own home directory, 'error')"));
  check("(pattern self-check) the REAL companion/capabilities.ts sibling wording \"Loom's own operational home directory\" also does not trip it",
    !loomsOwnRe.test("this project's vault points at Loom's own operational home directory — refusing to commit or push it"));
  check("(pattern self-check) the dev reserved-home PROJECT phrasing still trips its OWN separate pattern after this narrowing (devHomeRe, unaffected)",
    devHomeRe.test("no reserved Loom Platform project exists"));
}

// Card 3a721c44: the widened ID_CITATION_RE_SOURCE — plural lists, `task <id>`, bare parenthetical/
// possessive forms, and `@decision sha:<id>` — plus the false-positive guards the letter+digit-mix
// heuristic exists to satisfy. Tested directly against the shared source, the same way devHomeRe/
// loomsOwnRe above are tested against DENY_PATTERNS's own entries.
{
  const idRe = DENY_PATTERNS.find((p) => p.name === "decision/card id citation").re;

  // ---- NEW SHAPES — each must trip the pattern ----
  check("(pattern self-check 3a721c44) plural \"cards X, Y\" trips it on BOTH ids (idCitationCount === 2)",
    idCitationCount("gate state tracked across cards 99a1cf6f, db9b0130") === 2);
  check("(pattern self-check 3a721c44) a v4-uuid's own first 8-hex segment (a real session/project-id " +
    "shape, e.g. in a generated temp path) does NOT trip it — the hyphen exclusion, not just \\b",
    !idRe.test("C:\\\\Users\\\\x\\\\AppData\\\\Local\\\\Temp\\\\loom-eu-1c48279c-a4e7-4c55-9be4-ae5c0123abcd\\\\projects"));
  check("(pattern self-check 3a721c44) \"task <id>\" (worker_merge_confirm's real shape) trips it",
    idRe.test("WORKTREE-GC WARNING (task 035fb673): distinct from the nested-repo case"));
  check("(pattern self-check 3a721c44) a bare parenthetical \"(<id>)\" trips it",
    idRe.test("the inert-diff proof (db9b0130) backs this"));
  check("(pattern self-check 3a721c44) a bare possessive \"<id>'s\" trips it",
    idRe.test("99a1cf6f's own admission is reused by the retry"));
  check("(pattern self-check 3a721c44) the `@decision sha:<id>` form trips it",
    idRe.test("@decision sha:c70a5e0e — a verified-commit anchor, not a card"));

  // ---- FALSE-POSITIVE GUARDS — none of these may trip it ----
  check("(pattern self-check 3a721c44) \"record 12345678 entries\" (all-digit, the keyword-adjacent trap) does NOT trip it",
    !idRe.test("record 12345678 entries"));
  check("(pattern self-check 3a721c44) a bare date-like token \"20261103\" does NOT trip it",
    !idRe.test("the deploy landed on 20261103 with no incident"));
  check("(pattern self-check 3a721c44) an all-digit 8-char token in parens \"(12345678)\" does NOT trip it",
    !idRe.test("row count (12345678) was sampled"));
  check("(pattern self-check 3a721c44) an all-letter 8-char token (no digit) \"deadbeef\" does NOT trip it",
    !idRe.test("the fixture seeds a deadbeef placeholder value"));
  check("(pattern self-check 3a721c44) an all-letter possessive \"deadbeef's\" does NOT trip it either",
    !idRe.test("deadbeef's own default stays unchanged"));
}

// --- Hermetic LOOM_HOME + a sandboxed HOME. LOOM_DEV deliberately LEFT UNSET — every surface here must
// be clean on the NON-DEV install. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-eu-nodogfood-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.LOOM_DEV;
// Card a2f2becc / section (e): isSupervised() (orchestration/restart.ts) reads LOOM_SUPERVISED LIVE, with
// no caching, from `process.env` — and THIS test's own process can inherit `LOOM_SUPERVISED=1` from the
// supervised daemon it happens to be running under (CLAUDE.md's own documented ambient-env trap). Left
// set, OrchestrationMcpRouter's manager daemon_restart tool would wrongly register here, which a real
// non-dev, non-supervised npm end-user install never does (CLAUDE.md: "the end-user daemon runs NO
// supervisor"). Confirmed by direct measurement: deleting this is what makes the manager-role render below
// match a genuine end-user reading.
delete process.env.LOOM_SUPERVISED;

// ===================== CURATE THE SKILL STORE LIKE A REAL NON-DEV `loomctl` INSTALL ====================
// seedGlobalSkills() seeds straight from the dev checkout's assets/skills/** — which, on a REAL end-user
// install, was already curated at npm-package-build time (scripts/curate-release-skills.mjs), dropping
// DEV_ONLY_SKILLS (platform-audit/codescape/research). Running THIS test straight off a dev checkout would
// otherwise seed those three into the store too (per project memory
// loom-dev-flag-does-not-curate-skills-store — LOOM_DEV does NOT curate the store, only the npm package
// build does), which would misrepresent what a real end-user Lead actually receives. Reproduce the real
// install by pre-curating a throwaway assets copy and pointing seedGlobalSkills() at it via its own
// documented LOOM_ASSET_SKILLS override.
const { curateSkillDirs } = await import("../../../scripts/curate-release-skills.mjs");
const realAssetSkillsDir = path.join(__dirname, "..", "assets", "skills");
const allSkillDirNames = fs.readdirSync(realAssetSkillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const curatedSkillNames = curateSkillDirs(allSkillDirNames);
check("(setup) sanity: curation actually dropped at least one dev-only skill (precondition for this fixture to mean anything)",
  curatedSkillNames.length < allSkillDirNames.length);
const curatedAssetsDir = path.join(tmpHome, "curated-assets-skills");
fs.mkdirSync(curatedAssetsDir, { recursive: true });
for (const name of curatedSkillNames) fs.cpSync(path.join(realAssetSkillsDir, name), path.join(curatedAssetsDir, name), { recursive: true });
process.env.LOOM_ASSET_SKILLS = curatedAssetsDir; // read once at seed.ts's own module-load time — set before importing it

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();
const { commitAll } = await import("./_git-commit.mjs");

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const { seedSetupHome } = await import("../dist/setup/seed.js");
const { seedGlobalSkills } = await import("../dist/skills/seed.js");
const { injectSkills, CAPABILITY_BOUND_SKILLS } = await import("../dist/skills/inject.js");
const { claudeSkillsDir } = await import("../dist/pty/claude-doctrine.js");
const { resolvePlatformLeadResumeDocPath, platformLeadBaseResumeDocPath } = await import("../dist/sessions/platform-lead-prompt.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { RunMcpRouter } = await import("../dist/mcp/run.js");
const { WorkspaceAuditMcpRouter } = await import("../dist/mcp/user-audit.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const seededSkillNames = seedGlobalSkills();
check("(setup) seedGlobalSkills populated the curated store (not a no-op)", seededSkillNames.length === curatedSkillNames.length);
check("(setup) the dev-only skills never reached the store at all (genuinely absent, not merely undelivered)",
  !fs.existsSync(path.join(tmpHome, "skills", "platform-audit")) &&
  !fs.existsSync(path.join(tmpHome, "skills", "codescape")) &&
  !fs.existsSync(path.join(tmpHome, "skills", "research")));

class SeamHost extends createSeamHost(PtyHost) {
  constructor(events) { super(events); this.spawned = []; }
  createPty(opts) { this.spawned.push(opts); return super.createPty(opts); }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };

// Every dir THIS run creates, captured so the cleanup at the bottom of the file removes exactly these
// paths — never a sweep of os.tmpdir() by name pattern, which could delete a sibling session's own
// concurrently-running fixture (card a2f2becc round 2 CR).
const createdRepoDirs = [];
function freshRepo(tag) {
  const dir = path.join(os.tmpdir(), `loom-eu-nodogfood-repo-${tag}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# no-dogfood test repo\n");
  execSync("git init -q", { cwd: dir });
  commitAll(dir, "init", "-c user.email=nodogfood@loom -c user.name=nodogfood");
  createdRepoDirs.push(dir);
  return dir;
}

// A brand-new, fully independent non-dev Lead fixture (own db/project/agent/repo) — used once per
// scenario below so a positive-control PLANT in one scenario can never contaminate another, and so the
// per-install "exactly one live Lead" singleton never collides across scenarios.
function freshNonDevLeadFixture(tag) {
  const db = new Db(path.join(tmpHome, `db-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`));
  seedDefaultProfiles(db);
  seedSetupHome(db);
  const home = db.listAllProjects().find((p) => p.reserved);
  const repo = freshRepo(tag);
  db.updateProject(home.id, { repoPath: repo, vaultPath: repo });
  const agent = db.listAgents(home.id)[0];
  const host = new SeamHost(events);
  const svc = new SessionService(db, host, new OrchestrationControl());
  return { db, host, svc, agent, repo, home };
}

const CONTAMINANT = "@decision a1b2c3d4 — see packages/daemon/worktrees.ts (@loom/shared), part of Loom Platform's own orchestrating Loom with Loom deploy via pnpm --filter / pnpm build / pnpm daemon, Projects/Loom, daemon_restart, LOOM_DEV, Loom-product development, self-hosting Loom, Loom's own repo.";

// ===================== MAIN (clean) fixture — surfaces (a) + (c) ========================================
const main = freshNonDevLeadFixture("main");

// (a) the seeded startup prompt (fresh install)
const seededPrompt = main.db.getAgent(main.agent.id).startupPrompt;
check("(a) sanity: the seeded prompt is real, non-trivial content", seededPrompt.length > 200);
assertClean("(a) the seeded fresh-install startup prompt", seededPrompt);

// (c) pre-trigger the resume-doc operational notes (size + staleness) so the real spawn below actually
// exercises that injected block instead of the common "nothing to warn about" empty string.
{
  const basePath = platformLeadBaseResumeDocPath(main.repo);
  fs.writeFileSync(basePath, "# Platform Lead resume doc\n" + "x".repeat(46 * 1024)); // > RESUME_DOC_WARN_BYTES (45KB)
  const past = new Date(Date.now() - 50 * 60 * 60 * 1000); // 50h ago > the 48h staleness threshold
  fs.utimesSync(basePath, past, past);
  const siblingPath = path.join(main.repo, "PLATFORM-LEAD-RESUME-sibling-lineage.md");
  fs.writeFileSync(siblingPath, "# a concurrent Lead's resume doc\n");
}

const mainFresh = main.svc.startPlatformLead(main.agent.id);
const freshSpawnPrompt = main.host.spawned.at(-1)?.startupPrompt ?? "";
check("(a+c) sanity: the real fresh-spawn startupPrompt is substantial content", freshSpawnPrompt.length > 500);
check("(c) sanity: the resume-doc SIZE warning genuinely fired in this real spawn (positive-controlled precondition)",
  /resume doc/i.test(freshSpawnPrompt) && /rotat/i.test(freshSpawnPrompt));
check("(c) sanity: the resume-doc STALENESS warning genuinely fired too", /\[loom:resume-doc-stale\]/.test(freshSpawnPrompt));
assertClean("(a+c) the REAL composed fresh-spawn startupPrompt (prompt + \"Where things live\" + resume-doc notes)", freshSpawnPrompt);

const mainSucc = await main.svc.recyclePlatformLead(mainFresh.id, "HANDOFF: three projects stood up, backlog drained, next wire the fourth repo.");
const recyclePrompt = main.host.spawned.at(-1)?.startupPrompt ?? "";
check("(c) sanity: the recycle successor's prompt carries the continuation framing", recyclePrompt.includes("[loom:continuation]"));
check("(c) sanity: the recycle successor is a genuinely different session", mainSucc.id !== mainFresh.id);
assertClean("(c) the REAL composed recycle/continuation startupPrompt", recyclePrompt);
main.db.close();

// ===================== (a) POSITIVE CONTROL — plant at the REAL source (db.updateAgent), then re-spawn =
{
  const ctl = freshNonDevLeadFixture("a-plant");
  const original = ctl.db.getAgent(ctl.agent.id).startupPrompt;
  const planted = original + "\n" + CONTAMINANT;
  ctl.db.updateAgent(ctl.agent.id, { startupPrompt: planted });
  check("(a positive control) the plant actually landed on the real agent row (not a local copy)",
    ctl.db.getAgent(ctl.agent.id).startupPrompt === planted);
  const spawned = ctl.svc.startPlatformLead(ctl.agent.id);
  const capturedPrompt = ctl.host.spawned.at(-1)?.startupPrompt ?? "";
  check("(a positive control) sanity: the plant survived into the REAL captured spawn text", capturedPrompt.includes(CONTAMINANT));
  check("(a positive control) spawnId sanity: a session actually spawned", !!spawned.id);
  const hits = scan(capturedPrompt);
  check(`(a positive control) re-spawning with a planted db row trips the denylist (fired: ${hits.length}/${DENY_PATTERNS.length} patterns)`, hits.length === DENY_PATTERNS.length);
  ctl.db.close();
}

// ===================== (c) POSITIVE CONTROL — plant in the REAL recycle handoff text, confirm it reaches
// =====================     host.spawned (the same capture path the clean read above used). ==============
{
  const ctl = freshNonDevLeadFixture("c-plant");
  const fresh = ctl.svc.startPlatformLead(ctl.agent.id);
  const succ = await ctl.svc.recyclePlatformLead(fresh.id, "HANDOFF: " + CONTAMINANT);
  const capturedPrompt = ctl.host.spawned.at(-1)?.startupPrompt ?? "";
  check("(c positive control) sanity: the recycle successor is a genuinely different session", succ.id !== fresh.id);
  check("(c positive control) sanity: the plant survived into the REAL captured recycle text", capturedPrompt.includes(CONTAMINANT));
  const hits = scan(capturedPrompt);
  check(`(c positive control) a planted recycle handoff trips the denylist (fired: ${hits.length}/${DENY_PATTERNS.length} patterns)`, hits.length === DENY_PATTERNS.length);
  ctl.db.close();
}

// ===================== (b) EVERY SKILL THE LEAD'S injectSkills RESOLUTION ACTUALLY DELIVERS =============
// Derived structurally: call the REAL injectSkills() (role "platform", subset null — the Platform-lead
// profile's actual shape, profiles/seed.ts) against the curated store above, then read back whichever
// directory names actually landed — never a hand-picked "orchestrate, worker, …" list.
//
// This cwd is a plain tmp dir, not worktree-isolated, and no capability is granted — so `injectSkills`'s
// own capability-bound-skill gate (the real `CAPABILITY_BOUND_SKILLS` export + `isWorktreeCwd`) correctly
// WITHHOLDS every capability-bound skill here, same as it would for any non-worker, non-granted session.
// The expected delivered set is therefore the curated set MINUS whichever capability-bound names the real
// export carries — DERIVED from `CAPABILITY_BOUND_SKILLS` itself, never a hand-written name list, so a
// future capability-bound skill addition (or removal) is reflected automatically.
{
  const cwd = path.join(tmpHome, "skill-surface-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  injectSkills(cwd, "scan-session-b", null, "platform", false);
  const deliveredDir = claudeSkillsDir(cwd);
  check("(b) sanity: injectSkills actually delivered something to this cwd", fs.existsSync(deliveredDir));
  const deliveredNames = fs.readdirSync(deliveredDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const capabilityBoundNamesInCuratedSet = Object.keys(CAPABILITY_BOUND_SKILLS).filter((n) => curatedSkillNames.includes(n));
  const expectedDeliveredCount = curatedSkillNames.length - capabilityBoundNamesInCuratedSet.length;
  check(`(b) sanity: the Lead's locked-role/subset-null resolution delivers the curated set MINUS the real capability-bound skills withheld for this ungranted, non-worktree cwd (delivered: ${deliveredNames.length}, curated: ${curatedSkillNames.length}, capability-bound: ${capabilityBoundNamesInCuratedSet.length})`,
    deliveredNames.length === expectedDeliveredCount);
  check("(b) sanity: the dev-only skills are absent from the DELIVERED set too (never merely undelivered from an absent store)",
    !deliveredNames.includes("platform-audit") && !deliveredNames.includes("codescape") && !deliveredNames.includes("research"));
  for (const boundName of capabilityBoundNamesInCuratedSet) {
    check(`(b) sanity: capability-bound skill "${boundName}" is genuinely WITHHELD for this ungranted, non-worktree cwd (not merely absent from the store)`,
      !deliveredNames.includes(boundName));
  }

  function allFilesUnder(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...allFilesUnder(p));
      else out.push(p);
    }
    return out;
  }

  let totalFilesScanned = 0;
  for (const name of deliveredNames) {
    const skillRoot = path.join(deliveredDir, name);
    for (const absFile of allFilesUnder(skillRoot)) {
      const relPath = path.relative(deliveredDir, absFile).split(path.sep).join("/");
      const text = fs.readFileSync(absFile, "utf8");
      totalFilesScanned++;
      const hits = scanSkillFile(relPath, text);
      check(`(clean) (b) ${relPath} carries ZERO dogfood tokens (offenders: ${hits.join(", ") || "none"})`, hits.length === 0);
    }
  }
  check(`(b) sanity: a non-trivial number of delivered files were actually scanned (scanned ${totalFilesScanned})`, totalFilesScanned > 10);

  // Confirm the one allowlisted exemption is actually load-bearing (i.e. it would have failed without it) —
  // re-scan that ONE file with a bare scan() (no allowlist) and show the pattern DOES fire there.
  const orchestrateSkillMd = fs.readFileSync(path.join(deliveredDir, "orchestrate", "SKILL.md"), "utf8");
  check("(b) sanity: the allowlisted daemon_restart mention genuinely WOULD fail a bare (non-allowlisted) scan",
    scan(orchestrateSkillMd).includes("daemon_restart tool name"));

  // Exercise scanSkillFile's ALLOWLIST REJECTION branch directly: a SECOND daemon_restart mention beyond
  // the one allowlisted occurrence must still surface as a real hit (expectedCount mismatch), not be
  // silently waved through by the exemption. This is what stops a future regression to a bare
  // `if (allowed) continue;` (which would exempt the pattern unconditionally, any count) from passing.
  const hitsWithExtraMention = scanSkillFile("orchestrate/SKILL.md", orchestrateSkillMd + " daemon_restart");
  check("(b) sanity: scanSkillFile's allowlist REJECTS once the real count no longer matches expectedCount (a second daemon_restart mention still reports a hit)",
    hitsWithExtraMention.some((h) => h.startsWith("daemon_restart tool name")));

  // ===================== (b) POSITIVE CONTROL — plant in the REAL STORE copy (the injected/store copy a
  // =====================     session actually reads, not assets/), re-inject into a FRESH cwd, read the ===
  // =====================     DELIVERED copy back. ===========================================================
  const storeWorkerSkillPath = path.join(tmpHome, "skills", "worker", "SKILL.md");
  const storeOriginal = fs.readFileSync(storeWorkerSkillPath, "utf8");
  fs.writeFileSync(storeWorkerSkillPath, storeOriginal + "\n" + CONTAMINANT);
  const cwd2 = path.join(tmpHome, "skill-surface-cwd-plant");
  fs.mkdirSync(cwd2, { recursive: true });
  injectSkills(cwd2, "scan-session-b-plant", null, "platform", false);
  const deliveredWorkerSkillPath2 = path.join(claudeSkillsDir(cwd2), "worker", "SKILL.md");
  check("(b positive control) sanity: the delivered copy at the FRESH cwd exists", fs.existsSync(deliveredWorkerSkillPath2));
  const deliveredWorkerText2 = fs.readFileSync(deliveredWorkerSkillPath2, "utf8");
  check("(b positive control) sanity: the plant survived from the STORE into the DELIVERED copy", deliveredWorkerText2.includes(CONTAMINANT));
  const hitsB = scan(deliveredWorkerText2);
  check(`(b positive control) planting in the real store copy + re-injecting trips the denylist (fired: ${hitsB.length}/${DENY_PATTERNS.length} patterns)`, hitsB.length === DENY_PATTERNS.length);
}

// fileGroup -> Set<toolName>, accumulated across every surface/render sharing a group — declared here
// (rather than down in section (e)) because section (d)'s render below is what feeds PlatformMcpRouter's
// own entry (card a2f2becc round 4): PlatformMcpRouter has no render scenario of its own among
// SHIPPED_END_USER_MCP_SURFACES, so its structural coverage rides on the ordinary non-dev render (d)
// already does for the full-denylist scan.
const renderedNamesByFileGroup = new Map();

// ===================== (d) PlatformMcpRouter rendered tool descriptions + representative error strings,
// =====================     on the NON-DEV surface (LOOM_DEV unset throughout this whole file). ==========
{
  const d = freshNonDevLeadFixture("d");
  // A second, ORDINARY (non-reserved) project — needed for one of the deeper validation samples below
  // (an elevated-role profile bind refused outside a reserved/system project).
  const now = new Date().toISOString();
  const ordinaryProjectId = "d-ordinary-project";
  d.db.insertProject({ id: ordinaryProjectId, name: "Ordinary", repoPath: d.repo, vaultPath: d.repo, config: {}, createdAt: now, archivedAt: null, reserved: false });

  const router = new PlatformMcpRouter(d.db, d.svc);
  const server = router.buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "eu-no-dogfood-test", version: "0" });
  await client.connect(clientT);
  const tools = (await client.listTools()).tools;
  check("(d) sanity: a non-trivial non-dev tool surface was actually scanned", tools.length > 10);
  // Card a2f2becc round 4: feed this render's own tool names into PlatformMcpRouter's structural-coverage
  // entry — this IS the "fed by section (d)'s existing render" the decision record names, not a new render.
  renderedNamesByFileGroup.set("PlatformMcpRouter", new Set(tools.map((t) => t.name)));

  const allDescriptions = tools.map((t) => t.description ?? "").join("\n---\n");
  assertClean("(d) every registered (non-dev) PlatformMcpRouter tool description, concatenated", allDescriptions);

  // Representative runtime error strings — EACH family gets a project/lookup MISS *and* a DEEPER
  // validation error (a real rejection reached by a well-formed, existing-target call), per the ruling
  // that a lookup-miss alone under-samples what this router can actually say back.
  const parse = (res) => JSON.parse(res.content[0].text);
  const errorSamples = [];

  const cfgMiss = await parse(await client.callTool({ name: "project_configure", arguments: { projectId: "no-such-project", config: {} } }));
  errorSamples.push(["project_configure (lookup-miss)", cfgMiss.error ?? ""]);
  const cfgDeep = await parse(await client.callTool({ name: "project_configure", arguments: { projectId: d.home.id, config: { orchestration: { gateCommandTimeoutMs: 1 } } } }));
  errorSamples.push(["project_configure (deeper: out-of-bounds gateCommandTimeoutMs)", cfgDeep.error ?? ""]);

  const vaultMiss = await parse(await client.callTool({ name: "vault_write", arguments: { projectId: "no-such-project", path: "a.md", content: "x" } }));
  errorSamples.push(["vault_write (lookup-miss)", vaultMiss.error ?? ""]);
  const vaultDeep = await parse(await client.callTool({ name: "vault_write", arguments: { projectId: d.home.id, path: "../escape.md", content: "x" } }));
  errorSamples.push(["vault_write (deeper: path traversal)", vaultDeep.reason ?? ""]);

  const gitMiss = await parse(await client.callTool({ name: "git_commit", arguments: { projectId: "no-such-project", message: "x" } }));
  errorSamples.push(["git_commit (lookup-miss)", gitMiss.error ?? ""]);
  const gitDeep = await parse(await client.callTool({ name: "git_commit", arguments: { projectId: d.home.id, message: "x", repoKey: "no-such-repo-key" } }));
  errorSamples.push(["git_commit (deeper: unknown repoKey)", gitDeep.error ?? ""]);

  const agentMiss = await parse(await client.callTool({ name: "agent_create", arguments: { projectId: "no-such-project", name: "x" } }));
  errorSamples.push(["agent_create (lookup-miss)", agentMiss.error ?? ""]);
  const leadProfile = d.db.listProfiles().find((p) => p.name === "Platform-lead");
  const agentDeep = await parse(await client.callTool({ name: "agent_create", arguments: { projectId: ordinaryProjectId, name: "x", profileId: leadProfile.id } }));
  errorSamples.push(["agent_create (deeper: elevated profile outside a reserved project)", agentDeep.error ?? ""]);

  const transcriptMiss = await parse(await client.callTool({ name: "session_transcript", arguments: { sessionId: "no-such-session" } }));
  errorSamples.push(["session_transcript (lookup-miss)", transcriptMiss.error ?? ""]);

  for (const [label, text] of errorSamples) {
    check(`(d) sanity: ${label} error text is real, non-empty content`, typeof text === "string" && text.trim().length > 0);
  }
  const joinedErrors = errorSamples.map(([, text]) => text).join("\n---\n");
  assertClean("(d) representative runtime error strings across distinct tool families (lookup-miss + deeper validation each)", joinedErrors);

  await client.close();
  await server.close();
  d.db.close();
}

// ===================== (d) POSITIVE CONTROL — wrap the REAL McpServer.registerTool so one REAL tool's
// =====================     description carries the token, then read it back via a REAL tools/list. =====
{
  const d2 = freshNonDevLeadFixture("d-plant");
  const origRegisterTool = McpServer.prototype.registerTool;
  let planted = false;
  McpServer.prototype.registerTool = function (name, config, handler) {
    if (!planted && name === "project_get") {
      planted = true;
      config = { ...config, description: (config.description ?? "") + "\n" + CONTAMINANT };
    }
    return origRegisterTool.call(this, name, config, handler);
  };
  let tools;
  try {
    const router2 = new PlatformMcpRouter(d2.db, d2.svc);
    const server2 = router2.buildServer();
    const [clientT2, serverT2] = InMemoryTransport.createLinkedPair();
    await server2.connect(serverT2);
    const client2 = new Client({ name: "eu-no-dogfood-plant-test", version: "0" });
    await client2.connect(clientT2);
    tools = (await client2.listTools()).tools;
    await client2.close();
    await server2.close();
  } finally {
    McpServer.prototype.registerTool = origRegisterTool; // restore unconditionally, even on throw
  }
  check("(d positive control) sanity: the wrapper actually fired on a real registerTool call", planted);
  const plantedTool = tools.find((t) => t.name === "project_get");
  check("(d positive control) sanity: the plant survived into the REAL rendered tools/list description", plantedTool?.description?.includes(CONTAMINANT));
  const allDescriptions2 = tools.map((t) => t.description ?? "").join("\n---\n");
  const hitsD = scan(allDescriptions2);
  check(`(d positive control) a REAL contaminated tool registration trips the denylist via a genuine tools/list read (fired: ${hitsD.length}/${DENY_PATTERNS.length} patterns)`, hitsD.length === DENY_PATTERNS.length);
  d2.db.close();
}

// ===================== (e) EVERY OTHER SHIPPED, END-USER-REACHABLE MCP ROUTER — id-citation ratchet =====
// Card a2f2becc. audit.ts (AuditMcpRouter, role==="auditor") is DELIBERATELY ABSENT from this list — its
// surface is seeded ONLY under LOOM_DEV (the dev-only Platform Auditor; CLAUDE.md's LOOM_DEV section), so
// it is structurally unreachable on a real end-user install, not an oversight.
// `extra` merges onto the inserted session row — used below to render a CONFIG-GATED tool's MAXIMAL
// surface (e.g. `vaultWrite: true` so TaskMcpRouter's vault_write tool actually registers) rather than
// leaving it permanently unregistered, and so unscanned (card a2f2becc round 2 CR).
function insertFakeSessionForRole(fx, role, extra = {}) {
  const sessionId = `fake-${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  fx.db.insertSession({
    id: sessionId, projectId: fx.home.id, agentId: fx.agent.id, engineSessionId: null, title: null,
    cwd: fx.repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role, parentSessionId: null, ...extra,
  });
  return sessionId;
}
async function renderToolsViaRealClient(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "eu-no-dogfood-router-test", version: "0" });
  await client.connect(clientT);
  const tools = (await client.listTools()).tools;
  await client.close();
  await server.close();
  return tools;
}

const SHIPPED_END_USER_MCP_SURFACES = [
  {
    label: "OrchestrationMcpRouter(manager)",
    render: async (fx) => {
      // MAXIMAL render (card a2f2becc round 2 CR): `deploy` and `peer_message`/`peer_list`/
      // `peer_message_status` are CONFIG-GATED (a resolved orchestration.deployCommand / a project_links
      // row, mcp/orchestration.ts) — without these, they never register and the ratchet below silently
      // never scans them. The peer project lives in the SAME db as fx (project_links is a foreign-key'd
      // pair of project ids) and is never otherwise used.
      const peerProjectId = `peer-${fx.home.id}`;
      fx.db.insertProject({
        id: peerProjectId, name: "Peer", repoPath: fx.repo, vaultPath: fx.repo, config: {},
        createdAt: new Date().toISOString(), archivedAt: null, reserved: false,
      });
      fx.db.setProjectConfig(fx.home.id, { orchestration: { deployCommand: "echo shipping" } });
      fx.db.createProjectLink(fx.home.id, peerProjectId);
      const sid = insertFakeSessionForRole(fx, "manager");
      const router = new OrchestrationMcpRouter(fx.db, fx.svc, {});
      return renderToolsViaRealClient(router.buildServer(sid, "manager"));
    },
  },
  {
    label: "OrchestrationMcpRouter(worker)",
    render: async (fx) => {
      const sid = insertFakeSessionForRole(fx, "worker");
      const router = new OrchestrationMcpRouter(fx.db, fx.svc, {});
      return renderToolsViaRealClient(router.buildServer(sid, "worker"));
    },
  },
  {
    label: "OrchestrationMcpRouter(assistant)",
    render: async (fx) => {
      // MAXIMAL render (card a2f2becc round 3): a companion session in BOTH companionSessionIds (the
      // chat_reply/skill_*/memory_*/reminder_* gate) AND companionLeadMode true — the latter synthesizes a
      // full ACT-mode ResolvedGrantScope for EVERY companion/capabilities.ts lever at once
      // (synthesizeLeadModeScope, gated on db.listAllProjects() being non-empty, which fx's own home
      // project satisfies) — the simplest way to render every companion-gated tool this router can ever
      // show an end user, without hand-granting each of the nine COMPANION_CAPABILITY_SLUGS levers one at
      // a time via db.upsertCompanionCapabilityGrant.
      const sid = insertFakeSessionForRole(fx, "assistant");
      fx.db.setCompanionLeadMode(sid, true);
      const router = new OrchestrationMcpRouter(fx.db, fx.svc, { companionSessionIds: new Set([sid]) });
      return renderToolsViaRealClient(router.buildServer(sid, "assistant"));
    },
  },
  {
    label: "TaskMcpRouter(worker)",
    render: async (fx) => {
      // MAXIMAL render: vault_write is CONFIG-GATED (session.vaultWrite, mcp/server.ts) — without it,
      // the tool never registers and the ratchet below silently never scans it.
      const sid = insertFakeSessionForRole(fx, "worker", { vaultWrite: true });
      const router = new TaskMcpRouter(fx.db, new WakeService({ db: fx.db, pty: {}, resume: () => {} }));
      return renderToolsViaRealClient(router.buildServer(fx.home.id, sid));
    },
  },
  {
    label: "TaskMcpRouter(manager)",
    render: async (fx) => {
      // MAXIMAL render: authenticated_request is ALSO config-gated (session.connections non-empty,
      // mcp/server.ts) — without a pinned connection, the tool never registers and the structural coverage
      // scan below would silently never see it (card a2f2becc round 3).
      // ssh_exec is gated the same way but additionally needs a REAL ssh connection row to resolve.
      const { createSshConnection } = await import("../dist/connections/store.js");
      const { generateParseableEd25519 } = await import("./_ssh-test-keys.mjs"); // ssh2's ed25519 generator is malformed 1/256 (card 28c304b2)
      const sshKey = generateParseableEd25519((await import("ssh2")).default.utils);
      const sshConn = createSshConnection(fx.db, {
        name: "render-ssh", host: "ssh.example", port: 22, user: "loom",
        privateKey: sshKey.private, hostKeyFingerprint: "SHA256:" + "A".repeat(43),
      });
      const sid = insertFakeSessionForRole(fx, "manager", { vaultWrite: true, connections: ["fake-connection-id", sshConn.id] });
      const router = new TaskMcpRouter(fx.db, new WakeService({ db: fx.db, pty: {}, resume: () => {} }));
      return renderToolsViaRealClient(router.buildServer(fx.home.id, sid));
    },
  },
  {
    label: "SetupMcpRouter",
    render: async (fx) => {
      const sid = insertFakeSessionForRole(fx, "setup");
      const router = new SetupMcpRouter(fx.db, fx.svc);
      return renderToolsViaRealClient(router.buildServer(sid));
    },
  },
  {
    label: "RunMcpRouter",
    render: async (fx) => {
      // RunMcpRouter.buildServer(runSessionId) never reads the DB at render time (only submit_result's
      // handler does, at CALL time) — no fake session row needed for this one.
      const router = new RunMcpRouter(fx.db, fx.svc);
      return renderToolsViaRealClient(router.buildServer("fake-run-session"));
    },
  },
  {
    label: "WorkspaceAuditMcpRouter",
    render: async (fx) => {
      const sid = insertFakeSessionForRole(fx, "workspace-auditor");
      const router = new WorkspaceAuditMcpRouter(fx.db, fx.svc);
      return renderToolsViaRealClient(router.buildServer(sid));
    },
  },
];

// renderedNamesByFileGroup is declared earlier (fed first by section (d)'s PlatformMcpRouter render).
// renderedNamesBySurface keeps each surface's OWN render separate — needed below (task d) because two
// DISTINCT literal registerTool("gate_cancel") call sites in mcp/orchestration.ts (manager + worker)
// collapse to one name in the UNION the structural-coverage check above uses, so "covered by the union"
// alone can't prove both call sites actually rendered.
const renderedNamesBySurface = new Map();
for (const surface of SHIPPED_END_USER_MCP_SURFACES) {
  const fx = freshNonDevLeadFixture(`e-${surface.label.replace(/[^a-zA-Z0-9]/g, "")}`);
  const tools = await surface.render(fx);
  check(`(e) sanity: ${surface.label} rendered a non-trivial tool surface`, tools.length > 0);
  if (surface.label === "OrchestrationMcpRouter(manager)") {
    // Pins the NON-SUPERVISED surface this whole file is measuring (LOOM_SUPERVISED deliberately unset
    // above) — daemon_restart registers only under isSupervised(), so its absence here is what makes the
    // MAXIMAL render above (deploy+peer configured) still a genuine non-dev, non-supervised reading.
    check("(e) sanity: daemon_restart is ABSENT from the manager render (non-supervised, non-dev surface)",
      !tools.some((t) => t.name === "daemon_restart"));
  }
  const toolNames = new Set(tools.map((t) => t.name));
  renderedNamesBySurface.set(surface.label, toolNames);
  const fileGroup = fileGroupForSurfaceLabel(surface.label);
  const acc = renderedNamesByFileGroup.get(fileGroup) ?? new Set();
  for (const n of toolNames) acc.add(n);
  renderedNamesByFileGroup.set(fileGroup, acc);
  assertAllowlistEntriesSeen(surface.label, toolNames);
  for (const v of scanSurfaceRatchet(surface.label, tools)) {
    check(`(ratchet) ${surface.label} :: ${v.tool} carries EXACTLY its baselined ${v.expected} id citation(s) (measured ${v.real})`, v.ok);
  }
  assertNonIdAllowlistEntriesSeen(surface.label, toolNames);
  for (const t of tools) {
    for (const v of nonIdRatchetVerdicts(surface.label, t.name, t.description ?? "")) {
      check(`(non-id ratchet) ${surface.label} :: ${t.name} carries EXACTLY its baselined ${v.expected} ` +
        `"${v.pattern}" hit(s) (measured ${v.real})`, v.ok);
    }
  }
  fx.db.close();
}

// Card a2f2becc round 4, task (d): gate_cancel's two literal registerTool() call sites in
// mcp/orchestration.ts (manager ~5193, worker ~2462) must each be independently confirmed rendered —
// not merely covered once by the cross-surface union the structural-coverage check above uses.
check("(coverage) sanity (task d): gate_cancel's manager AND worker call sites are BOTH independently " +
  "rendered (not merely covered once by the union)",
  !!renderedNamesBySurface.get("OrchestrationMcpRouter(manager)")?.has("gate_cancel") &&
  !!renderedNamesBySurface.get("OrchestrationMcpRouter(worker)")?.has("gate_cancel"));

// ===================== (e) STRUCTURAL COVERAGE — the union of every surface's render above must cover
// =====================     EVERY literal registerTool() name found in that router's own source, minus a
// =====================     reasoned ROUTER_COVERAGE_EXCLUSIONS entry (card a2f2becc round 3). ============
for (const [fileGroup, srcFiles] of Object.entries(ROUTER_SOURCE_FILE_GROUPS)) {
  const expected = expectedToolNamesFromSource(srcFiles);
  const actual = renderedNamesByFileGroup.get(fileGroup) ?? new Set();
  const exclusions = ROUTER_COVERAGE_EXCLUSIONS.filter((e) => e.fileGroup === fileGroup);
  const exclusionNames = new Set(exclusions.map((e) => e.tool));
  const missing = [...expected].filter((n) => !actual.has(n) && !exclusionNames.has(n));
  check(`(coverage) ${fileGroup}: the union of this file's own renders covers EVERY literal registerTool() ` +
    `name found in ${srcFiles.join(", ")}, minus its reasoned exclusions (missing: ${missing.join(", ") || "none"})`,
    missing.length === 0);
  for (const excl of exclusions) {
    check(`(coverage) sanity: exclusion ${fileGroup}::${excl.tool} still names a real literal in source (else it is stale)`,
      expected.has(excl.tool));
  }
}

// ===================== (e) META-CHECK — the GROUP LIST itself cannot silently rot (card a2f2becc round 4,
// =====================     task b). A plain source-TEXT scan (never an AST parse): walk every .ts file
// =====================     under packages/daemon/src/**, and assert every file containing a literal
// =====================     `.registerTool(` call is named in SOME ROUTER_SOURCE_FILE_GROUPS entry above,
// =====================     or carries a reasoned FILE_LEVEL_COVERAGE_EXCLUSIONS entry — so a brand-new
// =====================     router file nobody added to a group fails THIS run loudly, instead of silently
// =====================     escaping both the structural-coverage scan above and this meta-check. ==========
function walkTsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkTsFiles(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}
{
  const srcRoot = path.join(__dirname, "..", "src");
  const groupedFiles = new Set(Object.values(ROUTER_SOURCE_FILE_GROUPS).flat());
  const excludedFiles = new Set(FILE_LEVEL_COVERAGE_EXCLUSIONS.map((e) => e.file));
  const unaccountedFiles = [];
  for (const absFile of walkTsFiles(srcRoot)) {
    const relPath = path.relative(srcRoot, absFile).split(path.sep).join("/");
    if (!fs.readFileSync(absFile, "utf8").includes(".registerTool(")) continue;
    if (groupedFiles.has(relPath) || excludedFiles.has(relPath)) continue;
    unaccountedFiles.push(relPath);
  }
  check(`(meta-check) every packages/daemon/src/**/*.ts file containing a literal .registerTool( call is ` +
    `named in a ROUTER_SOURCE_FILE_GROUPS entry or a reasoned FILE_LEVEL_COVERAGE_EXCLUSIONS entry — a ` +
    `plain source-text scan (unaccounted: ${unaccountedFiles.join(", ") || "none"})`,
    unaccountedFiles.length === 0);
  for (const excl of FILE_LEVEL_COVERAGE_EXCLUSIONS) {
    const fullPath = path.join(srcRoot, excl.file);
    const text = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";
    check(`(meta-check) sanity: FILE_LEVEL_COVERAGE_EXCLUSIONS entry ${excl.file} still contains a real ` +
      `.registerTool( call (else it is stale)`, text.includes(".registerTool("));
  }
}

// ===================== (e) POSITIVE CONTROL (i) — a planted EXTRA id citation on a LOW-count manager tool
// =====================     trips the ratchet. Plant via a wrapped REAL registerTool call (same discipline
// =====================     as every other positive control in this file), re-render through the real
// =====================     client, confirm the per-tool count no longer matches its baseline. ============
{
  const fx = freshNonDevLeadFixture("e-plant-extra");
  const sid = insertFakeSessionForRole(fx, "manager");
  const origRegisterTool = McpServer.prototype.registerTool;
  McpServer.prototype.registerTool = function (name, config, handler) {
    // Card 3a721c44: "0a1b2c3d" (not "00000000") — the new HEX_ID_CORE requires a letter+digit MIX, so an
    // all-digit synthetic plant would silently stop tripping the ratchet this control exists to prove.
    if (name === "idle_report") config = { ...config, description: (config.description ?? "") + "\ncard 0a1b2c3d" };
    return origRegisterTool.call(this, name, config, handler);
  };
  let tools;
  try {
    const router = new OrchestrationMcpRouter(fx.db, fx.svc, {});
    tools = await renderToolsViaRealClient(router.buildServer(sid, "manager"));
  } finally {
    McpServer.prototype.registerTool = origRegisterTool; // restore unconditionally, even on throw
  }
  const idleReport = tools.find((t) => t.name === "idle_report");
  check("(e positive control i) sanity: the plant landed on the real idle_report description", idleReport?.description?.includes("card 0a1b2c3d"));
  // Goes through the SAME scanSurfaceRatchet function the live check uses — never a separately
  // reimplemented comparison (card a2f2becc round 2 CR, sharpened round 3: a mutant that corrupts
  // scanSurfaceRatchet's own verdict must turn THIS control red too, not just the live loop).
  const verdict = scanSurfaceRatchet("OrchestrationMcpRouter(manager)", tools).find((v) => v.tool === "idle_report");
  check(`(e positive control i) a planted EXTRA id citation on a low-count manager tool trips the ratchet — RED (measured ${verdict?.real} vs baselined ${verdict?.expected})`, !!verdict && !verdict.ok);
  fx.db.close();
}

// ===================== (e) POSITIVE CONTROL (ii) — the STALE-ENTRY check: a tool's REAL count DROPS below
// =====================     its baselined expectedCount without the baseline being lowered to match — this
// =====================     must ALSO trip the ratchet, not silently pass through a too-generous stale
// =====================     baseline. SYNTHETIC, not a real-source strip: prior cleanup passes retargeted
// =====================     this control from gate_cancel to worker_list to gate_status to gate_queue, each
// =====================     cleaned to 0 in turn — the cleanup that removed gate_queue/gate_history/
// =====================     served_status from the allowlist left no nonzero-baselined entry on THIS
// =====================     surface/tool to retarget to (card 3a721c44 later added two reasoned, PERMANENT
// =====================     format-example entries elsewhere — TaskMcpRouter::decisions_for and
// =====================     OrchestrationMcpRouter(manager)::agent_list — but those are real tools this
// =====================     control must not perturb, so it still plants on idle_report instead), so
// =====================     instead of stripping a real citation out of some still-dirty tool's description,
// =====================     this plants a TEMPORARY allowlist entry against
// =====================     a REAL rendered tool's MEASURED citation count + 1 (never a hand-assumed
// =====================     count, so it can never silently stop proving anything as the real corpus
// =====================     changes), through the exact same ratchetVerdict/idCitationExpected/
// =====================     scanSurfaceRatchet functions the live check uses — never a separately
// =====================     reimplemented comparison — then restores the allowlist unconditionally so no
// =====================     synthetic entry survives into any other check in this file. ===================
{
  const fx = freshNonDevLeadFixture("e-plant-stale");
  const sid = insertFakeSessionForRole(fx, "manager");
  const router = new OrchestrationMcpRouter(fx.db, fx.svc, {});
  const tools = await renderToolsViaRealClient(router.buildServer(sid, "manager"));
  const target = tools.find((t) => t.name === "idle_report");
  check("(e positive control ii) sanity: the target tool actually rendered", !!target);
  const realCount = idCitationCount(target?.description ?? "");
  const syntheticExpected = realCount + 1; // always exactly one above whatever the real count measures as
  ROUTER_ID_CITATION_ALLOWLIST.push({ surface: "OrchestrationMcpRouter(manager)", tool: "idle_report", expectedCount: syntheticExpected });
  try {
    // Goes through the SAME scanSurfaceRatchet function the live check uses (see control (i)'s own note).
    const verdict = scanSurfaceRatchet("OrchestrationMcpRouter(manager)", tools).find((v) => v.tool === "idle_report");
    check(`(e positive control ii) sanity: the planted SYNTHETIC baseline (measured real count + 1) genuinely exceeds the measured real count (measured ${verdict?.real} vs baselined ${verdict?.expected})`, !!verdict && verdict.real < verdict.expected);
    check(`(e positive control ii) the stale-entry check trips the ratchet on a DECREASE too — RED (measured ${verdict?.real} vs baselined ${verdict?.expected})`, !!verdict && !verdict.ok);
  } finally {
    // Restore unconditionally, even on a thrown check — never leave the synthetic entry in the real table.
    const idx = ROUTER_ID_CITATION_ALLOWLIST.findIndex((e) => e.surface === "OrchestrationMcpRouter(manager)" && e.tool === "idle_report");
    if (idx !== -1) ROUTER_ID_CITATION_ALLOWLIST.splice(idx, 1);
  }
  fx.db.close();
}

// ===================== (e) POSITIVE CONTROL (iii) — a RE-INTRODUCED id citation on SetupMcpRouter (now
// =====================     fully clean, zero allowlist entries) must ALSO trip the ratchet — proving
// =====================     Setup is a genuine zero-tolerance surface, not merely clean by accident. ======
{
  const fx = freshNonDevLeadFixture("e-plant-setup");
  const sid = insertFakeSessionForRole(fx, "setup");
  const origRegisterTool = McpServer.prototype.registerTool;
  McpServer.prototype.registerTool = function (name, config, handler) {
    // Card 3a721c44: same all-digit trap as control (i) above — "0a1b2c3d" is letter+digit mixed.
    if (name === "list_all_sessions") config = { ...config, description: (config.description ?? "") + "\ncard 0a1b2c3d" };
    return origRegisterTool.call(this, name, config, handler);
  };
  let tools;
  try {
    const router = new SetupMcpRouter(fx.db, fx.svc);
    tools = await renderToolsViaRealClient(router.buildServer(sid));
  } finally {
    McpServer.prototype.registerTool = origRegisterTool;
  }
  const listAllSessions = tools.find((t) => t.name === "list_all_sessions");
  check("(e positive control iii) sanity: the plant landed on the real list_all_sessions description", listAllSessions?.description?.includes("card 0a1b2c3d"));
  // Goes through the SAME scanSurfaceRatchet function the live check uses (see control (i)'s own note).
  const verdict = scanSurfaceRatchet("SetupMcpRouter", tools).find((v) => v.tool === "list_all_sessions");
  check(`(e positive control iii) a re-introduced id citation on the now-clean SetupMcpRouter trips the ratchet — RED (baseline is a hard ${verdict?.expected}, measured ${verdict?.real})`, !!verdict && !verdict.ok && verdict.expected === 0);
  fx.db.close();
}

fs.rmSync(tmpHome, { recursive: true, force: true });
// Remove ONLY the repo dirs this run itself created (captured in createdRepoDirs as each one was made) —
// never a pattern sweep of os.tmpdir(), which risks deleting a concurrently-running sibling session's
// own fixture (card a2f2becc round 2 CR).
for (const dir of createdRepoDirs) fs.rmSync(dir, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — the end-user Platform Lead's seeded prompt, the REAL composed fresh-spawn AND recycle startupPrompt text, EVERY skill its own injectSkills resolution actually delivers (derived, not hand-picked — SKILL.md + references/** + scripts/**, minus the dev-only three), the non-dev PlatformMcpRouter's rendered tool descriptions + representative (lookup-miss AND deeper-validation) error strings all carry ZERO Loom-dogfood/card-id/internal-package tokens (each surface positive-controlled by PLANTING at its real source and re-running that surface's own real capture path, never a bare string-concatenation copy) — AND (card a2f2becc, section (e)) every OTHER shipped end-user-reachable MCP router's rendered tool descriptions carry EXACTLY their ratcheted, baselined count of id citations, no more and no less, proven both ways by three real plants (an extra citation, a stale decrease, a Setup re-introduction)."
  : `\n🛑 ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
