import "./_guard.mjs"; // prod-guard: arms the Db backstop (LOOM_TEST=1) — no Db used below, pure source-text scan
// STANDING GUARD (card 27d6c5a4) — closes a REDUCED-MERGE-GATE blind spot the Code Reviewer found (finding
// #3, session 45577716): `STATIC_GUARD_REPO_PATHS` (git/worktrees.ts) is the list of guards a REDUCED merge
// gate (card 2154b6ad — comment-only `src/` diffs skip the ~668-test runtime suite) still runs
// unconditionally. Several existing `test/*.mjs` files carry a "this human-only surface is NEVER exposed as
// an MCP tool" sub-assertion that is itself a pure SOURCE-TEXT scan — invalidated by something OTHER than a
// behavioural `.ts` edit (e.g. a comment quoting the forbidden literal) — but those files are NOT in
// `STATIC_GUARD_REPO_PATHS`, so a comment-only `src/mcp/**` edit can slip the reduced gate straight past
// them: eligible:true, the runtime suite (where these files actually run) never fires, and the leak ships
// green.
//
// This file CONSOLIDATES those sub-assertions (rather than one new guard file per feature) — the "human-only
// surface, prove no MCP router exposes it" shape recurs often enough in this corpus (six confirmed instances
// below) that a table entry is cheaper to add for the NEXT one than a whole new file + a new
// STATIC_GUARD_REPO_PATHS line. It does NOT replace the original assertions in their home files — those stay
// (still exercised by the full suite / a changed-file run through the harness) — this guard exists solely so
// the SAME property is also checked on the reduced gate's own unconditional path.
//
// SIX CONFIRMED INSTANCES (found by reading every `test/*.mjs` file matching /no (compiled )?MCP (router|tool)/i
// — 10 raw hits, 4 of them ruled OUT as purely DYNAMIC tool-listing checks that a real router already forces
// through the full gate on any behavioural edit: companion-capability-grants.mjs, connections-oauth.mjs,
// connections-store.mjs, gate-history.mjs):
//   1. setup-project-init-rest.mjs (7)  — no src/mcp/*.ts references "/api/setup/project-init"
//   2. setup-templates-rest.mjs (5)     — no src/mcp/*.ts references "/api/setup/templates"
//   3. companion-lead-mode.mjs (e)      — setCompanionLeadMode( is called ONLY from db.ts + gateway/server.ts
//   4. event-trigger-mcp-absence.mjs (1)— no src/mcp/*.ts mentions event_trigger/eventTrigger machinery
//   5. update-endpoint.mjs (d)          — no registerTool() name on any src/mcp/*.ts router is self-update-shaped
//   6. shell-terminal.mjs               — mcp/server.ts, mcp/orchestration.ts, mcp/platform.ts never reference
//                                          the shell-spawn surface, and register no terminal/shell-shaped tool
// (4) and (5) originally scanned the COMPILED `dist/mcp/*.js` — this guard scans SOURCE `src/mcp/*.ts`
// instead, same content (TypeScript doesn't rename string literals) and consistent with every OTHER member of
// STATIC_GUARD_REPO_PATHS, none of which depend on `dist/` having just been rebuilt.
//
// SCOPE NOTE (6): shell-terminal.mjs's own scan is narrower than "every src/mcp/*.ts file" — it only checks
// server.ts/orchestration.ts/platform.ts. Reproduced FAITHFULLY here (not widened) — widening it is a
// separate, pre-existing design question about shell-terminal.mjs itself, out of this card's scope.
//
// Run: node packages/daemon/test/human-only-surface-leak-guard.mjs (no build needed — pure source-text scan)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..", "src");
const MCP_DIR = path.join(SRC_DIR, "mcp");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// RECURSIVE (card 7efc2bff item 2, fixing a real gap: a bare fs.readdirSync(MCP_DIR) only sees the TOP
// LEVEL of src/mcp — a router moved to src/mcp/<subdir>/x.ts would silently leave the scanned population
// short a file, with nothing here to notice. src/mcp has no subdirectories today (enumerated), so this
// changes nothing about which files are found right now — it only makes that stay true if one is ever added.
function walkTsFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...walkTsFiles(full, base)); continue; }
    if (entry.name.endsWith(".ts")) out.push(path.relative(base, full).replace(/\\/g, "/"));
  }
  return out;
}
const mcpFiles = walkTsFiles(MCP_DIR);
check(`the real corpus scan opened at least one src/mcp/*.ts file (found ${mcpFiles.length})`, mcpFiles.length > 0);
// `mcpFileContents` is keyed off `mcpFiles` itself (same array, same iteration) — every key this map is ever
// queried with elsewhere in this file (SUBSTRING_FORBIDDEN below, the registerTool scan) comes FROM
// `mcpFiles`, so `.get(f)` is structurally guaranteed present there and is left unguarded. Section (6) below
// is the one place this file queries the map with an INDEPENDENTLY hardcoded name list (SHELL_FILES) that
// is not guaranteed to intersect the real corpus — that is what actually needs (and keeps) the undefined
// guard, not this loop.
const mcpFileContents = new Map(mcpFiles.map((f) => [f, fs.readFileSync(path.join(MCP_DIR, f), "utf8")]));

// ── (1)+(2) substring-absence table — one entry per forbidden REST-path literal ──────────────────────────
const SUBSTRING_FORBIDDEN = [
  { label: "setup-project-init-rest.mjs (7)", needle: "/api/setup/project-init" },
  { label: "setup-templates-rest.mjs (5)", needle: "/api/setup/templates" },
  { label: "event-trigger-mcp-absence.mjs (1) [event_trigger]", needle: "event_trigger" },
  { label: "event-trigger-mcp-absence.mjs (1) [eventTrigger]", needle: "eventTrigger" },
];
for (const { label, needle } of SUBSTRING_FORBIDDEN) {
  const offenders = mcpFiles.filter((f) => mcpFileContents.get(f).includes(needle));
  check(`${label}: no src/mcp/*.ts file references "${needle}" (offenders: ${offenders.join(", ") || "none"})`,
    offenders.length === 0);
}
// Positive-control anchor for the two REST-path needles: gateway/server.ts (outside mcp/, so safe to read
// without touching the scanned population) registers both routes by these exact literals.
const gatewayText = fs.readFileSync(path.join(SRC_DIR, "gateway", "server.ts"), "utf8");
check('positive control: "/api/setup/project-init" IS findable in gateway/server.ts (proves the needle isn\'t a typo matching nothing anywhere)',
  gatewayText.includes("/api/setup/project-init"));
check('positive control: "/api/setup/templates" IS findable in gateway/server.ts (same reasoning)',
  gatewayText.includes("/api/setup/templates"));
const eventTriggersText = fs.readFileSync(path.join(SRC_DIR, "orchestration", "event-triggers.ts"), "utf8");
check('positive control: "event_trigger" or "eventTrigger" IS findable in orchestration/event-triggers.ts',
  /event_trigger|eventTrigger/i.test(eventTriggersText));

// ── (3) setCompanionLeadMode( call-site allowlist — corpus-wide src/**/*.ts, not just mcp/ ────────────────
{
  const ALLOWLIST = new Set(["db.ts", "gateway/server.ts"]);
  const offenders = [];
  const seen = new Set();
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      const text = fs.readFileSync(full, "utf8");
      if (!text.includes("setCompanionLeadMode(")) continue;
      const rel = path.relative(SRC_DIR, full).replace(/\\/g, "/");
      seen.add(rel);
      if (!ALLOWLIST.has(rel)) offenders.push(rel);
    }
  }
  walk(SRC_DIR);
  // POSITIVE CONTROL: both allowlisted sites must actually be found — proves the walk/pattern genuinely
  // reaches known-present call sites rather than passing vacuously because nothing matched at all.
  check(`positive control: both allowlisted setCompanionLeadMode( sites are found (${[...ALLOWLIST].join(", ")}) — found ${[...seen].filter((f) => ALLOWLIST.has(f)).length}/${ALLOWLIST.size}`,
    [...ALLOWLIST].every((f) => seen.has(f)));
  check(`companion-lead-mode.mjs (e): setCompanionLeadMode( is called ONLY from db.ts + gateway/server.ts (offenders: ${offenders.join(", ") || "none"})`,
    offenders.length === 0);
}

// ── (5) registerTool() name extraction — no self-update-shaped tool name on any router ─────────────────────
{
  const SELF_UPDATE_NAMES = new Set([
    "loom_update", "self_update", "daemon_update", "update_loom", "update_daemon",
    "app_update", "trigger_update", "version_update", "loom_self_update", "update",
  ]);
  const names = [];
  const re = /registerTool\(\s*["'`]([^"'`]+)["'`]/g;
  for (const f of mcpFiles) {
    const src = mcpFileContents.get(f);
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) names.push(m[1]);
  }
  check(`update-endpoint.mjs (d): the registerTool() scan actually found tools (sanity, found ${names.length})`, names.length > 0);
  check('positive control: the scan sees a known benign data-editing tool ("tasks_update") — proves names are read correctly, not just absent',
    names.includes("tasks_update"));
  const offenders = names.filter((n) => SELF_UPDATE_NAMES.has(n));
  check(`update-endpoint.mjs (d): NO MCP tool can trigger a Loom self-update (offenders: ${offenders.join(", ") || "none"})`,
    offenders.length === 0);
}

// ── (6) shell-terminal surface — three named routers only, faithful to shell-terminal.mjs's own scope ─────
{
  const SHELL_FILES = ["server.ts", "orchestration.ts", "platform.ts"];
  const SHELL_SURFACE = ["spawnShell", "listShells", "/api/terminals", "createShellPty"];
  const offenders = [];
  for (const f of SHELL_FILES) {
    const body = mcpFileContents.get(f);
    if (body === undefined) { offenders.push(`${f} (MISSING — expected file not found)`); continue; }
    for (const needle of SHELL_SURFACE) {
      if (body.includes(needle)) offenders.push(`${f} references "${needle}"`);
    }
    if (/registerTool\(\s*["'][^"']*(terminal|shell)/i.test(body)) offenders.push(`${f} registers a terminal/shell tool`);
  }
  check(`shell-terminal.mjs: no MCP server (${SHELL_FILES.join(", ")}) exposes a shell-spawn tool (offenders: ${offenders.join("; ") || "none"})`,
    offenders.length === 0);
  // POSITIVE CONTROL (card 7efc2bff item 2): every other absence assertion in this file proves its needle
  // is findable SOMEWHERE known-present before trusting an empty result here — section (6) was the one
  // exception, so an absence here could not be told apart from a needle that's simply been renamed out from
  // under it. Anchored OUTSIDE mcp/ (gateway/server.ts, pty/host.ts — the real shell-spawn implementation),
  // same "safe to read without touching the scanned population" reasoning as the (1)+(2) anchor above.
  const ptyHostText = fs.readFileSync(path.join(SRC_DIR, "pty", "host.ts"), "utf8");
  for (const needle of SHELL_SURFACE) {
    check(`positive control: "${needle}" IS findable outside mcp/ (gateway/server.ts or pty/host.ts) — proves the needle isn't stale/renamed`,
      gatewayText.includes(needle) || ptyHostText.includes(needle));
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — every human-only surface's no-MCP-exposure sub-assertion (setup/project-init, setup/templates, companion lead-mode write, event-triggers, self-update, shell terminals) holds against the current src/ tree."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
