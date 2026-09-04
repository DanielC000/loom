import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card b3a89191 — project_configure's tool description (mcp/platform.ts) enumerated its settable
// top-level keys as a hand-typed sentence, and that sentence had ALREADY silently drifted from
// projectConfigOverrideSchema TWICE (missing `codescape` and `memory`, both deliberately agent-settable
// — see their own doc comments in mcp/platform.ts). Since the description also says "unknown keys
// rejected", the two together read as an authoritative CLOSED list — a Platform Lead hit this
// first-hand mid-triage and nearly escalated an agent-settable knob to the owner as human-only.
//
// Card a6f1b29b (this card) — the SIBLING surface, mcp/setup.ts's project_configure, has the SAME
// hand-typed sentence and had drifted FURTHER: missing `codescape`/`memory` (the same false-negative
// class) AND advertising `sessionEnv` as settable when the AGENT schema (agentProjectConfigOverrideSchema,
// mcp/platform.ts) `.omit()`s it and is `.strict()` — a FALSE POSITIVE the platform-router card's test
// could not have caught, because that test only ever checked "every real key is present", never "no
// omitted key is advertised". So this file now guards BOTH routers' project_configure description, and
// BOTH directions, off ONE shared pair of helpers (extractSettableClause/evaluateSettableClause) rather
// than duplicating the logic into a second near-identical file — the two call sites below (platform,
// setup) are the entire reason the helpers are factored out at all.
//
// This test makes both drift classes mechanically impossible to reintroduce silently: for each router it
// derives the schema's REAL top-level key set — CONFIG_TOP_LEVEL_KEYS for the platform router's FULL
// validator, AGENT_CONFIG_TOP_LEVEL_KEYS for the setup router's AGENT validator (both built once from the
// respective schema's `.shape`, in mcp/platform.ts, so neither can itself drift from its validator) — and
// asserts, against the LIVE registered tool description (read via a real MCP client over the real
// router, never a hand-copied string):
//   FORWARD  — every accepted key appears, as a whole word, within the "Settable top-level keys:" clause.
//   REVERSE  — every key the AGENT schema OMITS (currently: sessionEnv — computed as
//              CONFIG_TOP_LEVEL_KEYS minus AGENT_CONFIG_TOP_LEVEL_KEYS, never hand-typed) does NOT appear
//              within that same clause — it may still be named elsewhere in the description (e.g. the
//              rejection clause), just not advertised as settable.
// extractSettableClause isolates that one clause (from the "Settable top-level keys:" anchor to the next
// top-level '.', tracking paren depth so an internal "e.g. codescape.enabled" or "python.interpreterPath"
// doesn't truncate it early) so the REVERSE check can't be defeated by a rejected key being correctly
// named later in the same sentence, in the rejection clause, which is exactly what this card's fix does.
//
// A THIRD hand-typed copy (a duplicate expected-keys array in this file) would rot the exact same way the
// descriptions themselves already have twice, so this test deliberately has none — both key sets are
// schema-derived imports, and the REVERSE key set is a computed set-difference of the two, not a literal.
//
// Run: 1) build (turbo builds shared first), 2) node test/project-configure-description-drift.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-pcd-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
import { commitAll } from "./_git-commit.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter, CONFIG_TOP_LEVEL_KEYS, AGENT_CONFIG_TOP_LEVEL_KEYS } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so SessionService's constructor has something valid to reference; nothing
// here is actually spawned (project_configure's handler never touches sessions/pty). ---
const repo = path.join(os.tmpdir(), `loom-pcd-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# project-configure description drift test repo\n");
execSync(`git init -q`, { cwd: repo });
commitAll(repo, "init", "-c user.email=pcd@loom -c user.name=pcd");

const db = new Db();
class SeamHost extends createSeamHost(PtyHost) {}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new SeamHost(events);
const svc = new SessionService(db, host, new OrchestrationControl());

// --- shared helpers (the whole point of extending this file instead of forking a second one) ---

const hasWholeWord = (text, key) => new RegExp(`\\b${key}\\b`).test(text);

/** Isolate the "Settable top-level keys: ..." clause: from the anchor to the next '.' that sits at PAREN
 *  DEPTH 0 (so an internal parenthetical like "(codescape.enabled — ...)" or "(... MEMORY_CONFIG_MAX)."
 *  can contain its own '.' / can itself end in ')' without truncating the clause early). Returns "" if
 *  the anchor sentence itself is missing (a description that dropped the anchor entirely fails every
 *  downstream key check, which is the correct, informative failure). */
function extractSettableClause(description) {
  const anchor = "Settable top-level keys:";
  const idx = description.indexOf(anchor);
  if (idx === -1) return "";
  const start = idx + anchor.length;
  let depth = 0;
  let end = description.length;
  for (let i = start; i < description.length; i++) {
    const c = description[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "." && depth <= 0) { end = i; break; }
  }
  return description.slice(start, end);
}

/** FORWARD: every `acceptedKeys` entry is a whole word in the clause. REVERSE: no `rejectedKeys` entry
 *  is a whole word in the clause (it may still appear elsewhere in the full description, e.g. the
 *  rejection clause — this function only ever looks at the isolated settable-keys clause). */
function evaluateSettableClause(description, acceptedKeys, rejectedKeys) {
  const clause = extractSettableClause(description);
  const missing = acceptedKeys.filter((k) => !hasWholeWord(clause, k));
  const wronglyAdvertised = rejectedKeys.filter((k) => hasWholeWord(clause, k));
  return { ok: missing.length === 0 && wronglyAdvertised.length === 0, missing, wronglyAdvertised, clause };
}

/** Run the full check set for one router's project_configure description against one accepted/rejected
 *  key pair, via `check()`, prefixing every assertion with `label` so a failure names its router. */
function assertProjectConfigureDescription(label, description, acceptedKeys, rejectedKeys) {
  check(`${label}: description contains the "Settable top-level keys:" anchor sentence`, description.includes("Settable top-level keys:"));

  // POSITIVE CONTROL: a key long known to be correctly documented (kanbanColumns) must be found by this
  // exact matching logic — proves the whole-word regex itself works, so a later "missing" verdict can't
  // be a broken matcher masquerading as drift.
  check(`${label}: positive control — a key long known to be documented (kanbanColumns) is found`, hasWholeWord(extractSettableClause(description), "kanbanColumns"));
  // NEGATIVE CONTROL: a key that is deliberately NOT part of any schema must NOT be found — proves the
  // match logic is specific to real key names, not just "the clause is long so everything matches".
  check(`${label}: negative control — a made-up key not in any schema is NOT found`, !hasWholeWord(extractSettableClause(description), "notARealConfigKey"));

  const result = evaluateSettableClause(description, acceptedKeys, rejectedKeys);
  if (result.missing.length) console.log(`  ${label}: missing from settable clause: ${result.missing.join(", ")}`);
  if (result.wronglyAdvertised.length) console.log(`  ${label}: wrongly advertised as settable (schema rejects these): ${result.wronglyAdvertised.join(", ")}`);
  check(
    `${label}: names every accepted key AND advertises no rejected key (accepted: ${acceptedKeys.join(", ")}${rejectedKeys.length ? `; rejected: ${rejectedKeys.join(", ")}` : ""})`,
    result.ok,
  );
}

try {
  const platformRouter = new PlatformMcpRouter(db, svc);
  const setupRouter = new SetupMcpRouter(db, svc);

  const connect = async (server) => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "project-configure-description-drift-test", version: "0" });
    await client.connect(clientT);
    return client;
  };
  const describeTool = async (client, name) => {
    const tools = (await client.listTools()).tools;
    const tool = tools.find((t) => t.name === name);
    return { tool, description: tool?.description ?? "" };
  };

  check("sanity: CONFIG_TOP_LEVEL_KEYS is non-empty (a vacuous pass would hide a broken import)", CONFIG_TOP_LEVEL_KEYS.length > 0);
  check("sanity: AGENT_CONFIG_TOP_LEVEL_KEYS is non-empty (a vacuous pass would hide a broken import)", AGENT_CONFIG_TOP_LEVEL_KEYS.length > 0);
  // sessionEnv is the ONE key the agent schema omits today; this is a schema-derived set difference, not
  // a hand-typed literal, so it tracks the validator if a future key is ever added/removed from either side.
  const agentRejectedKeys = CONFIG_TOP_LEVEL_KEYS.filter((k) => !AGENT_CONFIG_TOP_LEVEL_KEYS.includes(k));
  check("sanity: the agent schema omits exactly sessionEnv relative to the full schema (today)", agentRejectedKeys.length === 1 && agentRejectedKeys[0] === "sessionEnv");

  // --- platform.ts's project_configure (P3-elevated, FULL validator: nothing top-level is omitted, so
  // there is no "rejected key" direction to check here — passing [] keeps the same shared assertion). ---
  const platformClient = await connect(platformRouter.buildServer());
  const platformDesc = await describeTool(platformClient, "project_configure");
  check("platform: project_configure is registered on the platform surface", !!platformDesc.tool);
  assertProjectConfigureDescription("platform", platformDesc.description, CONFIG_TOP_LEVEL_KEYS, []);

  // --- setup.ts's project_configure (AGENT validator: sessionEnv is omitted + strict-rejected). ---
  const setupClient = await connect(setupRouter.buildServer("SETUP"));
  const setupDesc = await describeTool(setupClient, "project_configure");
  check("setup: project_configure is registered on the setup surface", !!setupDesc.tool);
  assertProjectConfigureDescription("setup", setupDesc.description, AGENT_CONFIG_TOP_LEVEL_KEYS, agentRejectedKeys);

  // --- MUTATION CONTROL — prove the guard actually fires, using the REAL pre-fix text (card a6f1b29b),
  // not a synthesized string: this is the exact "Settable top-level keys:" sentence setup.ts's
  // project_configure carried before this card, verbatim. Run it through the SAME evaluator with the
  // SAME (current, correct) accepted/rejected key sets and confirm it goes RED on all three drift
  // classes the card described — codescape/memory missing (false negative) AND sessionEnv wrongly
  // advertised (false positive) AND python missing too (the old text implied the whole `python` key was
  // rejected, which is also imprecise — see setup.ts's current description for the corrected framing).
  // A guard that could not catch the bug it was written for is worse than no guard: it would report
  // "PASS" on the exact defect this card exists to prevent from recurring.
  const PRE_FIX_SETUP_DESCRIPTION =
    "PATCH a project's config override: the given keys are DEEP-MERGED into the project's EXISTING " +
    "override (a single-key change preserves your other overrides — it does NOT clobber them; arrays " +
    "like kanbanColumns and scalars replace, nested objects merge). projectId accepts the full id OR an " +
    "unambiguous 8-char id-prefix (mirrors project_get). Validated against the AGENT project-config " +
    "schema (NOT the elevated platform validator); resolveConfig merges the result over the platform " +
    "defaults. Settable top-level keys: kanbanColumns (the board's column layout — array of " +
    "{key,label,role?}), permission, pty, sessionEnv, orchestration, docLint, obsidian. The human-only " +
    "orchestration.gateCommand (host-RCE) and alertWebhook (data-exfil), obsidian.path/python " +
    "(host-launch) — and any unknown key — are REJECTED and the stored config is left unchanged.";
  const mutationResult = evaluateSettableClause(PRE_FIX_SETUP_DESCRIPTION, AGENT_CONFIG_TOP_LEVEL_KEYS, agentRejectedKeys);
  check("mutation control: the pre-fix setup.ts text is correctly flagged RED by the guard (not ok)", !mutationResult.ok);
  check("mutation control: pre-fix text is missing codescape (false negative, card b3a89191's class)", mutationResult.missing.includes("codescape"));
  check("mutation control: pre-fix text is missing memory (false negative, card b3a89191's class)", mutationResult.missing.includes("memory"));
  check("mutation control: pre-fix text is missing python (the imprecise 'rejected' framing item (3) called out)", mutationResult.missing.includes("python"));
  check("mutation control: pre-fix text wrongly advertises sessionEnv as settable (the false positive this card fixes)", mutationResult.wronglyAdvertised.includes("sessionEnv"));
} finally {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — both project_configure descriptions (platform + setup) name every key their own " +
    "schema accepts and advertise no key their own schema rejects as settable; the mutation control " +
    "confirms the guard would have caught card a6f1b29b's pre-fix text."
  : `\n❌ ${failures} FAILURE(S) — a project_configure description has drifted from its validator's real ` +
    "key set, or the guard itself failed its mutation control. See the FAIL lines above.");
process.exit(failures === 0 ? 0 : 1);
