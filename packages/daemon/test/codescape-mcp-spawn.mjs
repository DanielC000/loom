import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Codescape wiring epic `369dde3c`, card C2 → P4 REWRITE (card 088afc94) — inject the built-in Codescape
// MCP for agents on a LOOM_DEV Codescape-enabled project. DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE,
// hermetic: isolated LOOM_HOME + a sandboxed HOME, a REAL Db + SessionService driven against a FAKE pty
// injected via PtyHost's createPty() seam, and a FAKE CodescapeSupervisor injected via SessionService's
// `opts.codescape` — no real supervisor/serve process, no real claude spawn.
//
// HISTORY: C2 (e068a2ab) was a shared `codescape serve` HTTP mount scoped by the LOOM projectId — codescape
// ingested the repo under its OWN derived id, so scope lookups 400/404'd and the MCP never registered
// (agents got zero tools). C2/C3-REWRITE moved to a per-session STDIO `codescape mcp --graph <graph.json>`
// process reading a Loom-maintained snapshot file. P4 (088afc94) REPLACES BOTH: the per-session mount is
// now a streamable-HTTP entry pointed at the SHARED `codescape serve` process, scoped via codescape's OWN
// project id — resolved by READING BACK codescape's manifest file (never reimplementing their id hash),
// so the project-id-mismatch bug that killed the C2 attempt can't recur. Card 088afc94 ALSO ruled: no
// stdio-snapshot fallback when serve is down — a clean skip, logged, never a stale/absent mount.
//
// Proves the DoD:
//   (helpers) shared/src/config.ts's `codescape.enabled` resolves default-false / per-project-override
//       through resolveConfig; paths.ts's `isCodescapeEnabled` combines the daemon-wide supervisor gate
//       with the per-project flag.
//   (resolver) `codescapeHttpMcpServer` returns null when serve isn't up (port null) or codescape's
//       manifest has no entry for the repo yet (clean-skip, never a fallback), and a real
//       `{type:"http", url}` entry — bare `/mcp/<codescapeId>` project route, or `/mcp/<codescapeId>/
//       <worktreeId>` when a worktreeId is given — once both resolve.
//   (a) buildMcpServers mounts that http entry for "codescape" iff codescapeEnabled && isLoomDev() &&
//       isCodescapeSupervisorEnabled() && codescape's manifest resolves an id for repoPath && serve's port
//       is live — a manager gets the bare project route, a worker tied to a task gets the worktree-scoped
//       route (SAME stable URL shape codescape confirmed it will serve worktree-adjusted content through
//       later — this is not a placeholder to simplify back to the bare route).
//   NEGATIVE CASES (byte-identical to a no-flag spawn): LOOM_DEV off / no codescape CLI detected on the
//       host / project not enabled / codescape has no manifest entry for this repo (never ingested) /
//       serve not up (port null) — ALL clean-skip, never a stale/absent fallback.
//   (b) CODESCAPE_TOOL_ALLOW carries exactly the 7 read tools, none of the 5 control/write tools; createPty
//       allowlists them iff the mcpServers map actually carries the "codescape" entry (shape-independent —
//       keys off presence, not transport).
//   plus end-to-end: spawnWorker's opts carry repoPath (the project's MAIN repo, not its own worktree) and
//       worktreeId (a task-tied worker); the manifest-based resolver + buildMcpServers connect end to end.
//
// Run: 1) build (turbo builds shared first), 2) node test/codescape-mcp-spawn.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, execFileSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// CR fix (card 088afc94, item 5, the flagged test gap): capture console.warn output around a call so the
// clean-skip WARN's actual TEXT can be asserted, not just the resulting mcpServers shape — a future
// refactor that silently dropped the warn (or re-merged the split messages) would otherwise pass every
// other check in this file untouched.
function captureWarnings(fn) {
  const original = console.warn;
  const lines = [];
  console.warn = (...args) => { lines.push(args.join(" ")); };
  try { fn(); } finally { console.warn = original; }
  return lines;
}

// --- Hermetic LOOM_HOME (host.ts log dir) AND a sandboxed HOME so resume()'s engineTranscriptExists
// reads under the temp dir, never the real ~/.claude. Set BEFORE importing dist. ---
const tmpHome = path.join(os.tmpdir(), `loom-cs-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
// The isLoomDev() gate check below needs the TRUE default-off state — delete any inherited LOOM_DEV=1
// (e.g. this test running inside a LOOM_DEV=1 self-hosting/orchestration shell).
delete process.env.LOOM_DEV;
delete process.env.LOOM_CODESCAPE_ENABLED;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureCli = path.join(__dirname, "fixtures", "fake-codescape-cli.mjs");
delete process.env.LOOM_CODESCAPE_BIN;
process.env.LOOM_CODESCAPE_BIN = fixtureCli;

const { Db } = await import("../dist/db.js");
const { PtyHost, buildMcpServers, buildSpawnArgs, disallowedToolsForSpawn, codescapeHttpMcpServer, CODESCAPE_TOOL_ALLOW, CODESCAPE_WRITE_TOOLS } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { isLoomDev, isCodescapeSupervisorEnabled, isCodescapeEnabled, resolveCodescapeBin, codescapeBinCandidate, hostToolBinExists, resolveHostToolBin } = await import("../dist/paths.js");
const { resolveCodescapeProjectId } = await import("../dist/codescape/manifest.js");
const { resolveConfig } = await import("@loom/shared");

// Manifest helper (mirrors codescape-manifest.mjs's writeManifest) — codescape's OWN plain-JSON
// project-id registry, read back by resolveCodescapeProjectId. Hand-written here rather than driven
// through a real ingest: the fixture CLI's `ingest` (no `--out`) doesn't simulate manifest-writing, and
// this file's own manifest.mjs unit tests already cover that resolver in isolation.
function writeManifest(homeDir, entries) {
  const p = path.join(homeDir, ".codescape", "projects", "index.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, projects: entries }));
}

// ===================== shared config: codescape.enabled default-false / per-project override =====================
check("(config) default resolveConfig(undefined) ⇒ codescape.enabled === false", resolveConfig(undefined).codescape.enabled === false);
check("(config) resolveConfig({}) ⇒ codescape.enabled === false", resolveConfig({}).codescape.enabled === false);
check("(config) resolveConfig({codescape:{enabled:true}}) ⇒ true", resolveConfig({ codescape: { enabled: true } }).codescape.enabled === true);
check("(config) resolveConfig({codescape:{enabled:false}}) ⇒ false", resolveConfig({ codescape: { enabled: false } }).codescape.enabled === false);

// ===================== isCodescapeEnabled: daemon-wide supervisor gate AND the per-project flag =====================
// Card 503a30a0: the daemon-wide gate is now HOST-CLI-PRESENCE-based — isLoomDev() AND a codescape binary
// actually resolvable (DB path ?? LOOM_CODESCAPE_BIN ?? bare "codescape" on PATH) — never a hand-set env
// toggle. `LOOM_CODESCAPE_BIN` is already pointed at the fixture CLI (a REAL file) from the top of this
// test, so "detected" is the ambient state for the rest of the file once LOOM_DEV is on; the nested
// block below proves the CLI-ABSENT negative case by temporarily clearing it, then restores it.
check("(gate) isLoomDev() is FALSE by default (LOOM_DEV unset)", isLoomDev() === false);
check("(gate) isCodescapeSupervisorEnabled() is FALSE by default (LOOM_DEV off, even though the fixture CLI exists)", isCodescapeSupervisorEnabled() === false);
check("(gate) isCodescapeEnabled: LOOM_DEV off + project enabled ⇒ still false (daemon-wide gate wins)",
  isCodescapeEnabled({ codescape: { enabled: true } }) === false);
process.env.LOOM_DEV = "1";
{
  const savedBin = process.env.LOOM_CODESCAPE_BIN;
  delete process.env.LOOM_CODESCAPE_BIN;
  check("(gate) LOOM_DEV=1 but no codescape CLI resolvable at all ⇒ isCodescapeEnabled still false",
    isCodescapeEnabled({ codescape: { enabled: true } }) === false);
  process.env.LOOM_CODESCAPE_BIN = savedBin;
}
check("(gate) LOOM_DEV=1 + the fixture CLI resolvable (LOOM_CODESCAPE_BIN) + project enabled ⇒ true",
  isCodescapeEnabled({ codescape: { enabled: true } }) === true);
check("(gate) daemon-wide gate on but project NOT enabled ⇒ false",
  isCodescapeEnabled({ codescape: { enabled: false } }) === false);
check("(gate) dbPath param: an explicit nonexistent dbPath overrides LOOM_CODESCAPE_BIN and resolves not-detected",
  isCodescapeSupervisorEnabled(path.join(tmpHome, "no-such-codescape-binary")) === false);
check("(gate) dbPath param: an explicit REAL dbPath wins and resolves detected",
  isCodescapeSupervisorEnabled(process.execPath) === true);
delete process.env.LOOM_DEV;

// ===================== CODESCAPE_TOOL_ALLOW: exactly the 7 read tools, none of the 5 write tools =====================
const expectedRead = ["mcp__codescape__list_flows", "mcp__codescape__trace_flow", "mcp__codescape__what_touches",
  "mcp__codescape__describe_symbol", "mcp__codescape__render_tree", "mcp__codescape__boundary_map", "mcp__codescape__scenario_space"];
const forbiddenWrite = ["mcp__codescape__focus_flow", "mcp__codescape__highlight", "mcp__codescape__open_view",
  "mcp__codescape__annotate", "mcp__codescape__show_diff"];
check("(allowlist) CODESCAPE_TOOL_ALLOW has exactly the 7 read tools",
  CODESCAPE_TOOL_ALLOW.length === 7 && expectedRead.every((t) => CODESCAPE_TOOL_ALLOW.includes(t)));
check("(allowlist) CODESCAPE_TOOL_ALLOW contains NONE of the 5 control/write tools",
  forbiddenWrite.every((t) => !CODESCAPE_TOOL_ALLOW.includes(t)));

// ===================== CR fix: the 5 write tools are actually UNREACHABLE, not just un-allowlisted =====================
// The allowlist checks above only prove the write tools are absent from --allowedTools; under
// `acceptEdits` a mounted-but-unallowlisted MCP tool still PROMPTS (it isn't auto-denied), which would
// wedge a Loom-driven worker session. disallowedToolsForSpawn must union CODESCAPE_WRITE_TOOLS into
// `--disallowedTools` whenever the codescape MCP is actually mounted — proving the write tools are
// structurally unreachable, not merely unallowlisted. Shape-independent: it keys off the "codescape"
// entry's mere PRESENCE in mcpServers, not its transport, so this holds for the http shape too.
check("(CODESCAPE_WRITE_TOOLS) carries exactly the 5 control/write tool names",
  CODESCAPE_WRITE_TOOLS.length === 5 && forbiddenWrite.every((t) => CODESCAPE_WRITE_TOOLS.includes(t)));

check("(disallow) codescapeMounted=false ⇒ disallowedToolsForSpawn has NONE of the write tools",
  forbiddenWrite.every((t) => !disallowedToolsForSpawn("worker", false, false).includes(t)));
check("(disallow) codescapeMounted=true ⇒ disallowedToolsForSpawn has ALL 5 write tools",
  forbiddenWrite.every((t) => disallowedToolsForSpawn("worker", false, true).includes(t)));
check("(disallow) codescapeMounted=true still keeps the role's own disallow list (union, not replace)",
  ["AskUserQuestion", "ExitPlanMode", "EnterPlanMode"].every((t) => disallowedToolsForSpawn("worker", false, true).includes(t)));
check("(disallow) codescapeMounted + restrictedTools both off ⇒ byte-identical to disallowedToolsForSpawn(role) alone",
  JSON.stringify(disallowedToolsForSpawn("worker", false, false)) === JSON.stringify(disallowedToolsForSpawn("worker")));

// End-to-end through buildSpawnArgs: the write tools actually land in `--disallowedTools` argv when
// codescape is mounted (now an http entry), and are absent when it isn't — proving the flag is emitted,
// not just the array.
{
  const mcpNoCodescape = { "loom-tasks": { type: "http", url: "http://127.0.0.1:4317/mcp/s1" } };
  const mcpWithCodescape = { ...mcpNoCodescape, codescape: { type: "http", url: "http://127.0.0.1:55000/mcp/myrepo-abc12345" } };
  const argsWithout = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers: mcpNoCodescape, startupPrompt: "GO", disallowedTools: disallowedToolsForSpawn("worker", false, !!mcpNoCodescape.codescape) });
  const argsWith = buildSpawnArgs({ settingsPath: "S", mode: "acceptEdits", mcpServers: mcpWithCodescape, startupPrompt: "GO", disallowedTools: disallowedToolsForSpawn("worker", false, !!mcpWithCodescape.codescape) });
  check("(e2e-disallow) codescape NOT mounted: none of the 5 write tools appear in argv",
    forbiddenWrite.every((t) => !argsWithout.includes(t)));
  check("(e2e-disallow) codescape MOUNTED: all 5 write tools appear in --disallowedTools argv",
    forbiddenWrite.every((t) => argsWith.includes(t)));
  const d = argsWith.indexOf("--disallowedTools");
  const strict = argsWith.indexOf("--strict-mcp-config");
  check("(e2e-disallow) --disallowedTools still precedes --strict-mcp-config (flag-ordering invariant preserved)",
    d !== -1 && strict !== -1 && d < strict);
}

// ===================== codescapeHttpMcpServer: the streamable-HTTP URL resolver (P4 seam) =====================
// `resolveProjectId` is an INJECTED function (never a raw homeDir) — production wiring passes
// `CodescapeSupervisor.resolveProjectId` (its own boot-registration cache first, falling back to the
// cold manifest read); here a plain manifest-backed resolver stands in, proving the seam itself works
// against ANY conforming resolver, cache or not.
{
  const repoA = path.join(tmpHome, "repo-a");
  const homeDirA = path.join(tmpHome, "codescape-home-a");
  writeManifest(homeDirA, [{ id: "repo-a-deadbeef", name: "repo-a", path: repoA, lastIngested: "2026-07-22T00:00:00.000Z", graphPath: "/x/graph.json" }]);
  const manifestResolver = (repoPath) => resolveCodescapeProjectId(repoPath, homeDirA);

  check("(resolver) port null (serve not up) ⇒ null, even with a resolvable id",
    codescapeHttpMcpServer({ repoPath: repoA, port: null, resolveProjectId: manifestResolver }) === null);
  check("(resolver) resolveProjectId undefined ⇒ null (nothing to resolve an id with)",
    codescapeHttpMcpServer({ repoPath: repoA, port: 4400, resolveProjectId: undefined }) === null);
  check("(resolver) no manifest entry for this repo (never ingested) ⇒ null, clean-skip",
    codescapeHttpMcpServer({ repoPath: path.join(tmpHome, "never-ingested-repo"), port: 4400, resolveProjectId: manifestResolver }) === null);

  const bareEntry = codescapeHttpMcpServer({ repoPath: repoA, port: 4400, resolveProjectId: manifestResolver });
  check("(resolver) resolved: {type:'http', url} shape", bareEntry?.type === "http" && typeof bareEntry?.url === "string");
  check("(resolver) bare project route (no worktreeId): /mcp/<codescapeId>", bareEntry?.url === "http://127.0.0.1:4400/mcp/repo-a-deadbeef");

  const scopedEntry = codescapeHttpMcpServer({ repoPath: repoA, port: 4400, worktreeId: "wt-123", resolveProjectId: manifestResolver });
  check("(resolver) worktree-scoped route: /mcp/<codescapeId>/<worktreeId>", scopedEntry?.url === "http://127.0.0.1:4400/mcp/repo-a-deadbeef/wt-123");
}

// ===================== DB-first, env-fallback precedence (card 8dc5ebb9) — the SUPERVISOR's own bin resolution =====================
// codescapeBinCandidate/resolveCodescapeBin back the supervisor's ingest/serve spawn (codescape/supervisor.ts)
// and the isCodescapeSupervisorEnabled gate — NOT the per-session mount, which is a pure URL build with no
// bin resolution at all (P4). hostToolBinExists backs the same detection.
{
  const otherFixtureCli = path.join(__dirname, "fixtures", "fake-codescape-cli-2.mjs");
  fs.copyFileSync(fixtureCli, otherFixtureCli);
  check("(precedence) codescapeBinCandidate: a DB path wins over LOOM_CODESCAPE_BIN", codescapeBinCandidate(otherFixtureCli) === otherFixtureCli);
  const viaDb = resolveCodescapeBin(otherFixtureCli);
  check("(precedence) resolveCodescapeBin: DB path wins, still shape-resolved (.mjs wrapped in process.execPath)",
    viaDb.command === process.execPath && JSON.stringify(viaDb.args) === JSON.stringify([otherFixtureCli]));
  // A blank/whitespace DB path is treated as absent — falls through to env, not a literal "" bin.
  check("(precedence) a blank DB path falls back to the env var", codescapeBinCandidate("   ") === fixtureCli);
  // Neither DB nor env set ⇒ the bare PATH-resolvable default name "codescape" (unchanged today-behavior).
  const savedEnv = process.env.LOOM_CODESCAPE_BIN;
  delete process.env.LOOM_CODESCAPE_BIN;
  check("(precedence) neither DB path nor env set ⇒ the bare default name", codescapeBinCandidate(undefined) === "codescape");
  process.env.LOOM_CODESCAPE_BIN = savedEnv;
  fs.rmSync(otherFixtureCli, { force: true });

  // hostToolBinExists: the /api/integrations detect endpoint's building block — proves existence for
  // BOTH resolveHostToolBin shapes without re-deriving the shape logic.
  check("(detect) hostToolBinExists: a real .mjs fixture exists", hostToolBinExists(fixtureCli) === true);
  check("(detect) hostToolBinExists: a missing absolute path does not", hostToolBinExists(path.join(tmpHome, "no-such-file.mjs")) === false);
  check("(detect) hostToolBinExists: process.execPath (a real, non-.mjs binary) exists", hostToolBinExists(process.execPath) === true);
  check("(detect) hostToolBinExists: an unresolvable bare PATH name does not", hostToolBinExists("no-such-codescape-binary-xyz") === false);
}

// ===================== REAL cross-process spawn: the direct-launch (non-.mjs) shape actually runs =====================
{
  // The .mjs-shape real spawn is already proven for Codescape by the C1/C3 real-spawn coverage elsewhere
  // (codescape-supervisor.mjs actually execs fixtureCli via the production spawn path). Here we prove the
  // OTHER shape — a bare/compiled binary launched directly, unwrapped — using process.execPath as a
  // stand-in real OS binary (it has no .js/.mjs/.cjs suffix, so resolveHostToolBin resolves it exactly
  // like it would a real compiled `codescape` binary).
  const direct = resolveHostToolBin(process.execPath);
  check("(real-spawn) a non-.mjs bin resolves UNWRAPPED (direct-launch shape)", direct.command === process.execPath && direct.args.length === 0);
  let directShapeRan = false;
  try { execFileSync(direct.command, [...direct.args, "-e", "process.exit(0)"], { stdio: "pipe" }); directShapeRan = true; } catch { /* reported as a failed check below */ }
  check("(real-spawn) the direct-launch shape {command,args} actually runs", directShapeRan);
}

// ===================== buildMcpServers: NEGATIVE CASES — byte-identical to a no-flag spawn =====================
const posRepo = path.join(tmpHome, "pos-repo");
const posHomeDir = path.join(tmpHome, "pos-home");
writeManifest(posHomeDir, [{ id: "pos-repo-cafe1234", name: "pos-repo", path: posRepo, lastIngested: "2026-07-22T00:00:00.000Z", graphPath: "/x/graph.json" }]);
const posResolver = (repoPath) => resolveCodescapeProjectId(repoPath, posHomeDir);

const noFlag = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker" });

// (1) LOOM_DEV off (everything else on) — the hard gate wins first.
delete process.env.LOOM_DEV;
const devOff = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", codescapeEnabled: true, repoPath: posRepo, codescapePort: 55000, codescapeResolveProjectId: posResolver });
check("(neg-1) LOOM_DEV off ⇒ NO 'codescape' entry", !("codescape" in devOff));
check("(neg-1) LOOM_DEV off ⇒ mcpServers byte-identical to a no-flag spawn", JSON.stringify(devOff) === JSON.stringify(noFlag));

// (2) LOOM_DEV on, but no codescape CLI resolvable at all (the daemon-wide feature switch itself off) —
// temporarily clears the ambient fixture-CLI env var this file otherwise keeps set throughout.
process.env.LOOM_DEV = "1";
const savedBinForNeg2 = process.env.LOOM_CODESCAPE_BIN;
delete process.env.LOOM_CODESCAPE_BIN;
const supervisorOff = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", codescapeEnabled: true, repoPath: posRepo, codescapePort: 55000, codescapeResolveProjectId: posResolver });
check("(neg-2) no codescape CLI detected ⇒ NO 'codescape' entry", !("codescape" in supervisorOff));
check("(neg-2) byte-identical to a no-flag spawn", JSON.stringify(supervisorOff) === JSON.stringify(noFlag));
process.env.LOOM_CODESCAPE_BIN = savedBinForNeg2;

// (3) project NOT enabled (codescapeEnabled: false), everything else on.
const notEnabled = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", codescapeEnabled: false, repoPath: posRepo, codescapePort: 55000, codescapeResolveProjectId: posResolver });
check("(neg-3) project not enabled ⇒ NO 'codescape' entry", !("codescape" in notEnabled));
check("(neg-3) project not enabled ⇒ mcpServers byte-identical to a no-flag spawn", JSON.stringify(notEnabled) === JSON.stringify(noFlag));

// (4) codescape has no manifest entry for this repo (a DIFFERENT, never-ingested repo) — the honest
// clean-skip, never a guessed/fallback id.
let missingManifestEntry;
const idUnresolvedWarnings = captureWarnings(() => {
  missingManifestEntry = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", codescapeEnabled: true, repoPath: path.join(tmpHome, "never-ingested"), codescapePort: 55000, codescapeResolveProjectId: posResolver });
});
check("(neg-4) no manifest entry for this repo ⇒ NO 'codescape' entry (clean-skip, never throws)", !("codescape" in missingManifestEntry));
check("(neg-4) mcpServers byte-identical to a no-flag spawn", JSON.stringify(missingManifestEntry) === JSON.stringify(noFlag));
// CR fix (item 5): the clean-skip WARN actually fires, and its TEXT names the id-unresolved cause
// specifically (not the merged "serve down or id unresolved" wording the review flagged) — port WAS live
// (55000) here, so this can only be the manifest-miss case.
check("(neg-4) the clean-skip WARN fires exactly once", idUnresolvedWarnings.length === 1);
check("(neg-4) its text names the id-unresolved cause, not serve-down",
  idUnresolvedWarnings[0]?.includes("no id resolvable") && !idUnresolvedWarnings[0]?.includes("serve isn't up"));

// (5) serve not up (codescapePort null) — everything else resolvable. Card 088afc94 ruling: NO
// stdio-snapshot (or any other) fallback here — a clean skip is the whole point.
let serveDown;
const serveDownWarnings = captureWarnings(() => {
  serveDown = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", codescapeEnabled: true, repoPath: posRepo, codescapePort: null, codescapeResolveProjectId: posResolver });
});
check("(neg-5) serve not up (port null) ⇒ NO 'codescape' entry, no fallback of any kind", !("codescape" in serveDown));
check("(neg-5) mcpServers byte-identical to a no-flag spawn", JSON.stringify(serveDown) === JSON.stringify(noFlag));
// CR fix (item 5): the split message's OTHER half — port was null, so this must name serve-down, distinct
// from the id-unresolved wording checked above.
check("(neg-5) the clean-skip WARN fires exactly once", serveDownWarnings.length === 1);
check("(neg-5) its text names the serve-down cause, not id-unresolved",
  serveDownWarnings[0]?.includes("serve isn't up") && !serveDownWarnings[0]?.includes("no id resolvable"));

// unset entirely (no codescapeEnabled key at all) ⇒ also byte-identical (fully additive).
const unset = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", repoPath: posRepo });
check("(neg-6) codescapeEnabled unset ⇒ mcpServers byte-identical to a no-flag spawn", JSON.stringify(unset) === JSON.stringify(noFlag));

// ===================== buildMcpServers: POSITIVE — worktree-scoped for a worker, bare for a manager =====================
const workerOn = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", codescapeEnabled: true, repoPath: posRepo, codescapePort: 55000, codescapeResolveProjectId: posResolver, worktreeId: "wt-9" });
check("(a) worker: 'codescape' entry present", "codescape" in workerOn);
check("(a) worker: entry shape is {type:'http', url}", workerOn.codescape.type === "http" && typeof workerOn.codescape.url === "string");
check("(a) worker: url is the worktree-scoped route /mcp/<id>/<worktreeId>",
  workerOn.codescape.url === "http://127.0.0.1:55000/mcp/pos-repo-cafe1234/wt-9");

const managerOn = buildMcpServers({ sessionId: "s1", port: 4317, role: "manager", codescapeEnabled: true, repoPath: posRepo, codescapePort: 55000, codescapeResolveProjectId: posResolver });
check("(a) manager (no worktreeId): bare project route /mcp/<id>",
  managerOn.codescape.url === "http://127.0.0.1:55000/mcp/pos-repo-cafe1234");

const plainOn = buildMcpServers({ sessionId: "s1", port: 4317, codescapeEnabled: true, repoPath: posRepo, codescapePort: 55000, codescapeResolveProjectId: posResolver });
check("(a) plain (role-less) session also gets the bare route (orthogonal to role, absent a worktreeId)",
  plainOn.codescape.url === managerOn.codescape.url);

// ON adds exactly the codescape key, nothing else changes vs the negative-case map.
check("(a) ON adds exactly the codescape key (everything else unchanged)",
  JSON.stringify({ ...managerOn, codescape: undefined }) === JSON.stringify({ ...notEnabled, codescape: undefined }));

// ===================== byte-identical-when-absent + DB-path precedence for the GATE (card 8dc5ebb9) =====================
{
  const withEmptyIntegrationPaths = buildMcpServers({ sessionId: "s1", port: 4317, role: "manager", codescapeEnabled: true, repoPath: posRepo, codescapePort: 55000, codescapeResolveProjectId: posResolver, integrationPaths: {} });
  check("(byte-identical) integrationPaths:{} is byte-identical to integrationPaths omitted entirely",
    JSON.stringify(withEmptyIntegrationPaths) === JSON.stringify(managerOn));
  // A DB path threaded through integrationPaths wins over LOOM_CODESCAPE_BIN for the GATE check — proven
  // by making LOOM_CODESCAPE_BIN point at a NONEXISTENT binary (gate would otherwise fail) while the DB
  // path still resolves to the real fixture — the mount must still succeed.
  const savedBin = process.env.LOOM_CODESCAPE_BIN;
  process.env.LOOM_CODESCAPE_BIN = path.join(tmpHome, "no-such-bin.mjs");
  const withDbPath = buildMcpServers({ sessionId: "s1", port: 4317, role: "manager", codescapeEnabled: true, repoPath: posRepo, codescapePort: 55000, codescapeResolveProjectId: posResolver, integrationPaths: { codescape: fixtureCli } });
  check("(precedence, e2e) integrationPaths.codescape wins over a broken LOOM_CODESCAPE_BIN for the gate — mount still succeeds",
    "codescape" in withDbPath && withDbPath.codescape.url === managerOn.codescape.url);
  process.env.LOOM_CODESCAPE_BIN = savedBin;
}

// ===================== end-to-end threading through SessionService (seam-captured opts) =====================
const repo = path.join(os.tmpdir(), `loom-cs-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# codescape-mcp-spawn test\n");
execSync(`git init -q && git add . && git -c user.email=cs@loom -c user.name=cs commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
// Project A: codescape enabled. Its manifest entry is seeded up front (mirrors a repo already ingested
// by a prior boot/merge — the register-worktree hook doesn't itself ingest, see the class doc).
const e2eHomeDir = path.join(tmpHome, "e2e-codescape-home");
writeManifest(e2eHomeDir, [{ id: "pa-e2e-1234abcd", name: "A", path: repo, lastIngested: now, graphPath: "/x/graph.json" }]);
db.insertProject({ id: "pA", name: "A", repoPath: repo, vaultPath: repo, config: { codescape: { enabled: true } }, createdAt: now, archivedAt: null });
db.insertAgent({ id: "agentMgrA", projectId: "pA", name: "Mgr", startupPrompt: "MGR_PROMPT", position: 0, profileId: null });
db.insertAgent({ id: "agentWorkerA", projectId: "pA", name: "Worker", startupPrompt: "WORKER_PROMPT", position: 1, profileId: null });

class SeamHost extends PtyHost {
  constructor(events) { super(events); this.capture = []; }
  createPty(opts) { this.capture.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  isAlive() { return false; }
}
const events = {
  onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); },
  onBusy(id, busy) { db.setBusy(id, busy); },
  onContextStats() {}, onRateLimited() {},
  onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
};
const host = new SeamHost(events);
// A fake CodescapeSupervisor: only registerWorktree is exercised by this file (the mount-side threading);
// codescape-lifecycle-hooks.mjs covers the full register/reingest/drop lifecycle in depth.
const registerCalls = [];
const fakeSupervisor = {
  getHomeDir: () => e2eHomeDir,
  resolveProjectId: (repoPath) => resolveCodescapeProjectId(repoPath, e2eHomeDir),
  async registerWorktree(projectId, info) {
    registerCalls.push({ projectId, ...info });
    return { ok: true };
  },
};
const svc = new SessionService(db, host, new OrchestrationControl(), { codescape: fakeSupervisor });
const optsFor = (sid) => host.capture.find((o) => o.sessionId === sid);

let workerWorktree = null;
try {
  const mgrA = svc.startManager("agentMgrA");
  const oMgrA = optsFor(mgrA.id);
  check("(e2e) manager: opts.codescapeEnabled === true (project A opted in)", oMgrA?.codescapeEnabled === true);
  check("(e2e) manager: opts.repoPath === the project's repo", oMgrA?.repoPath === repo);
  check("(e2e) manager: opts carry NO worktreeId (a manager runs in the main repo)", !oMgrA?.worktreeId);

  const tW1 = "22222222-2222-4222-8222-222222222222";
  db.insertTask({ id: tW1, projectId: "pA", title: "t", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  const worker = await svc.spawnWorker(mgrA.id, { taskId: tW1, agentId: "agentWorkerA", kickoffPrompt: "GO" });
  workerWorktree = worker.worktreePath;
  const oWorker = optsFor(worker.id);
  check("(e2e) worker: opts.codescapeEnabled === true", oWorker?.codescapeEnabled === true);
  check("(e2e) worker: opts.repoPath === the PROJECT's main repo (not its own new worktree)", oWorker?.repoPath === repo && oWorker?.repoPath !== worker.worktreePath);
  check("(e2e) worker: opts.worktreeId is a stable, non-empty string (task-tied)", typeof oWorker?.worktreeId === "string" && oWorker.worktreeId.length > 0);

  // fireCodescapeRegisterWorktree is fire-and-forget (not awaited by spawnWorker) — give it a beat to land.
  for (let i = 0; i < 100 && registerCalls.length === 0; i++) await sleep(20);
  check("(e2e) spawnWorker's register-worktree hook fired exactly once", registerCalls.length === 1);
  check("(e2e) it registered under codescape's OWN manifest-resolved id (not Loom's project.id)", registerCalls[0]?.projectId === "pa-e2e-1234abcd");
  check("(e2e) it registered the SAME worktreeId that landed in the spawn opts", registerCalls[0]?.worktreeId === oWorker.worktreeId);
  check("(e2e) it registered the worker's actual worktree path", registerCalls[0]?.path === worker.worktreePath);

  // NOW buildMcpServers (fed the SAME real spawn opts, plus a live port/homeDir as the boot wiring would
  // supply) mounts the codescape entry — proving the manifest resolution + mount connect end to end.
  const workerMcp = buildMcpServers({ sessionId: worker.id, port: 4317, role: oWorker.role, codescapeEnabled: oWorker.codescapeEnabled, repoPath: oWorker.repoPath, worktreeId: oWorker.worktreeId, codescapePort: 55000, codescapeResolveProjectId: fakeSupervisor.resolveProjectId });
  check("(e2e) buildMcpServers mounts the codescape http entry once port+manifest both resolve", workerMcp.codescape?.type === "http");
  check("(e2e) its url is worktree-scoped to THIS worker's own worktreeId", workerMcp.codescape.url === `http://127.0.0.1:55000/mcp/pa-e2e-1234abcd/${oWorker.worktreeId}`);
} finally {
  try {
    const { removeWorktree } = await import("../dist/git/worktrees.js");
    if (workerWorktree) { try { await removeWorktree(repo, workerWorktree); } catch { /* best-effort */ } }
  } catch { /* best-effort */ }
  db.close();
  delete process.env.LOOM_DEV;
  delete process.env.LOOM_CODESCAPE_BIN;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Codescape MCP wiring (P4 rewrite, card 088afc94): shared config default-false/per-project-override; isCodescapeEnabled combines the daemon-wide + per-project gates; codescapeHttpMcpServer clean-skips when serve is down (port null) or codescape's manifest has no entry for the repo, and returns a real {type:'http', url} entry — bare /mcp/<id> or worktree-scoped /mcp/<id>/<worktreeId> — once both resolve, via a manifest read-back rather than a reimplemented id hash; buildMcpServers mounts it iff enabled+isLoomDev+supervisorEnabled+manifest-resolves+serve-up, with all 5 negative cases (incl. the NEW 'serve down' clean-skip — no stdio fallback) byte-identical off; the 7-tool read-only allowlist excludes the 5 write tools and they're structurally disallowed once mounted; end-to-end, spawnWorker's opts carry the project's MAIN repoPath (never its own worktree) plus a stable worktreeId, its register-worktree hook fires exactly once under codescape's OWN manifest-resolved id (never Loom's), and buildMcpServers (fed those same opts) mounts the matching worktree-scoped route — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
