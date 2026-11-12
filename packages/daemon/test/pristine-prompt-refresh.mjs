import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Pristine-only prompt refresh for the seeded agent prompts (setup/pristine-prompt-refresh.ts + the
// setup/seed.ts and platform/seed.ts wiring). HERMETIC + CLAUDE-FREE + NETWORK-FREE: REAL Db handles over an
// isolated short LOOM_HOME, no pty/daemon, no DB column or schema change.
//
// Proves, per seeded prompt (setup: Platform operator-Lead, Workspace Auditor, Companion;
// platform: Platform Lead, Platform Auditor):
//   (1) PRISTINE: an agent whose stored prompt is byte-identical to a PRIOR shipped value moves to the
//       current text;
//   (2) CUSTOMIZED: an edited prompt is NEVER touched;
//   (3) ALREADY CURRENT: an agent on the current text is a no-op (and a second run changes nothing).
// Plus (4) the byte-exactness of each list's first entry against the text shipped at a FIXED sha (never
// HEAD: HEAD moves with the trims this list exists to survive), and (5) the helper's own semantics on a
// synthetic spec, which is where "treat everything as pristine" goes RED.
//
// Run: 1) build (turbo builds shared first), 2) node test/pristine-prompt-refresh.mjs
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const home = useOwnLoomHome("ppr-"); // short temp LOOM_HOME, set BEFORE any ../dist import
delete process.env.LOOM_DEV; // CORE path by default; the platform half flips it on explicitly below

const { Db } = await import("../dist/db.js");
const { seedDefaultProfiles } = await import("../dist/profiles/seed.js");
const { refreshPristinePrompts, isPristineStalePrompt } = await import("../dist/setup/pristine-prompt-refresh.js");
const setupSeed = await import("../dist/setup/seed.js");
const platformSeed = await import("../dist/platform/seed.js");

// The commit whose seeded prompts every list's first entry must equal, byte for byte.
const BASE_SHA = "3a70c6c7";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const showAt = (sha, file) => {
  try { return execFileSync("git", ["--no-pager", "show", `${sha}:${file}`], { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return null; } // sha not present (shallow clone): reported as an explicit SKIP below
};
const showAtBase = (file) => showAt(BASE_SHA, file);
const literalAtBase = (src, name) => {
  const m = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;\\n`).exec(src);
  return m ? new Function(`return \`${m[1]}\``)() : null; // same cooking as the compiler gives the source literal
};

// Older shipped texts appended after each list's first entry (card c08055cc), each pinned byte-exact at the FIXED
// first-parent-of-main sha that shipped it. `index` is the entry's position in the list.
const OLDER_PINS = [
  { label: "WORKSPACE_AUDITOR_PROMPT", sha: "aecc6551", index: 1 },
  { label: "WORKSPACE_AUDITOR_PROMPT", sha: "838ddedc", index: 2 },
  { label: "COMPANION_PROMPT", sha: "38188873", index: 1 },
  { label: "PLATFORM_LEAD_PROMPT", sha: "a8622f82", index: 1 },
  { label: "PLATFORM_LEAD_PROMPT", sha: "85f4c1db", index: 2 },
  { label: "PLATFORM_AUDIT_PROMPT", sha: "a8622f82", index: 1 },
  { label: "PLATFORM_AUDIT_PROMPT", sha: "4ee722e2", index: 2 },
  { label: "PLATFORM_AUDIT_PROMPT", sha: "85f4c1db", index: 3 },
];

// ---- the five prompts under test ----
const SETUP_FILE = "packages/daemon/src/setup/seed.ts";
const PLATFORM_FILE = "packages/daemon/src/platform/seed.ts";
const PROMPTS = [
  { label: "PLATFORM_LEAD_OPERATOR_PROMPT", where: "setup", agent: setupSeed.SETUP_AGENT_NAME, current: setupSeed.PLATFORM_LEAD_OPERATOR_PROMPT, priors: setupSeed.PLATFORM_LEAD_OPERATOR_PROMPT_PRIOR_VALUES, file: SETUP_FILE },
  { label: "WORKSPACE_AUDITOR_PROMPT", where: "setup", agent: setupSeed.SETUP_AUDITOR_AGENT_NAME, current: setupSeed.WORKSPACE_AUDITOR_PROMPT, priors: setupSeed.WORKSPACE_AUDITOR_PROMPT_PRIOR_VALUES, file: SETUP_FILE },
  { label: "COMPANION_PROMPT", where: "setup", agent: setupSeed.COMPANION_AGENT_NAME, current: setupSeed.COMPANION_PROMPT, priors: setupSeed.COMPANION_PROMPT_PRIOR_VALUES, file: SETUP_FILE },
  { label: "PLATFORM_LEAD_PROMPT", where: "platform", agent: "Platform Lead", current: platformSeed.PLATFORM_LEAD_PROMPT, priors: platformSeed.PLATFORM_LEAD_PROMPT_PRIOR_VALUES, file: PLATFORM_FILE },
  { label: "PLATFORM_AUDIT_PROMPT", where: "platform", agent: "Platform Auditor", current: platformSeed.PLATFORM_AUDIT_PROMPT, priors: platformSeed.PLATFORM_AUDIT_PROMPT_PRIOR_VALUES, file: PLATFORM_FILE },
];

// ===================== (5) helper semantics on a synthetic spec =====================
{
  const db = new Db(path.join(home, "helper.db"));
  const proj = { id: "p1", name: "H", repoPath: home, vaultPath: home, config: {}, createdAt: new Date().toISOString(), archivedAt: null, reserved: false, referenceRepos: [], noGateByDesign: false, denyGlobs: [], repos: [], vaultOnly: true };
  db.insertProject(proj);
  const mk = (id, name, prompt, position) => db.insertAgent({ id, projectId: "p1", name, startupPrompt: prompt, position, profileId: null, endpoint: false, ioSchema: null });
  mk("a-pristine", "Bot", "OLD-1", 0);
  mk("a-custom", "Bot2", "OLD-1 + my edit", 1);
  mk("a-current", "Bot3", "NEW", 2);
  mk("a-renamed", "Renamed", "OLD-1", 3);
  const specs = [
    { agentName: "Bot", current: "NEW", priorValues: ["OLD-0", "OLD-1"] },
    { agentName: "Bot2", current: "NEW", priorValues: ["OLD-0", "OLD-1"] },
    { agentName: "Bot3", current: "NEW", priorValues: ["OLD-0", "OLD-1", "NEW"] },
  ];
  const out = refreshPristinePrompts(db, db.listAgents("p1"), specs);
  const get = (id) => db.getAgent(id).startupPrompt;
  check("(5) pristine (byte-equal to a prior value) -> upgraded to current", get("a-pristine") === "NEW");
  check("(5) customized (prior value + an edit) -> untouched", get("a-custom") === "OLD-1 + my edit");
  check("(5) already current (even when listed among the priors) -> unchanged", get("a-current") === "NEW");
  check("(5) a prior text under an unrelated/renamed agent name -> untouched", get("a-renamed") === "OLD-1");
  check("(5) only the pristine agent is reported refreshed", out.length === 1 && out[0] === "Bot");
  check("(5) a second run is a no-op", refreshPristinePrompts(db, db.listAgents("p1"), specs).length === 0);
  check("(5) isPristineStalePrompt: current is never stale, an unknown text is never stale",
    !isPristineStalePrompt("NEW", specs[2]) && !isPristineStalePrompt("something else", specs[0]) && isPristineStalePrompt("OLD-0", specs[0]));
}

// ===================== real homes: one setup home (CORE path), one platform home (LOOM_DEV) =====================
const setupDb = new Db(path.join(home, "setup.db"));
seedDefaultProfiles(setupDb);
setupSeed.seedSetupHome(setupDb);
setupSeed.seedSetupAuditorAgent(setupDb);
setupSeed.seedCompanionAgent(setupDb);
const setupHome = setupDb.getReservedProjectByName(setupSeed.SETUP_PROJECT_NAME);

process.env.LOOM_DEV = "1"; // the platform layer is dev-gated: seedPlatformHome and the refresh only exist here
const platformDb = new Db(path.join(home, "platform.db"));
seedDefaultProfiles(platformDb);
platformSeed.seedPlatformHome(platformDb);
const platformHome = platformDb.getReservedProjectByName(platformSeed.PLATFORM_PROJECT_NAME);

const ctx = {
  setup: { db: setupDb, home: setupHome, run: () => setupSeed.refreshSetupHomePromptsPristine(setupDb) },
  platform: { db: platformDb, home: platformHome, run: () => platformSeed.refreshPlatformPromptsPristine(platformDb) },
};
const agentOf = (c, name) => c.db.listAgents(c.home.id).find((a) => a.name === name);
const setPrompt = (c, name, prompt) => c.db.updateAgent(agentOf(c, name).id, { startupPrompt: prompt });

let baseSrc = {};
for (const f of [SETUP_FILE, PLATFORM_FILE]) baseSrc[f] = showAtBase(f);

for (const p of PROMPTS) {
  const c = ctx[p.where];
  check(`[${p.label}] seeded agent '${p.agent}' exists and a fresh seed carries the CURRENT text`, agentOf(c, p.agent)?.startupPrompt === p.current);
  check(`[${p.label}] PRIOR_VALUES is a non-empty list of strings`, Array.isArray(p.priors) && p.priors.length > 0 && p.priors.every((x) => typeof x === "string" && x.length > 0));

  // (4) first entry == the text shipped at the fixed base sha
  if (baseSrc[p.file] === null) console.log(`SKIP  [${p.label}] base sha ${BASE_SHA} not present in this checkout; byte-exactness vs the shipped text NOT verified here`);
  else {
    const shipped = literalAtBase(baseSrc[p.file], p.label);
    check(`[${p.label}] literal found at ${BASE_SHA} (extraction sanity)`, typeof shipped === "string" && shipped.length > 200);
    check(`[${p.label}] PRIOR_VALUES[0] is byte-identical to the text shipped at ${BASE_SHA}`, p.priors[0] === shipped);
  }

  // (3) already current -> no-op
  setPrompt(c, p.agent, p.current);
  const before = c.run();
  check(`[${p.label}] already-current is a no-op (nothing refreshed for it)`, !before.includes(p.agent) && agentOf(c, p.agent).startupPrompt === p.current);

  // (2) customized -> untouched, for the current text AND for every prior text carrying one extra edit
  for (const [i, base] of [p.current, ...p.priors].entries()) {
    const edited = `${base}\n\nUser addition ${i}.`;
    setPrompt(c, p.agent, edited);
    c.run();
    check(`[${p.label}] customized (${i === 0 ? "current" : `prior[${i - 1}]`} + an edit) is left untouched`, agentOf(c, p.agent).startupPrompt === edited);
  }
  setPrompt(c, p.agent, "A prompt the user wrote from scratch.");
  c.run();
  check(`[${p.label}] a from-scratch custom prompt is left untouched`, agentOf(c, p.agent).startupPrompt === "A prompt the user wrote from scratch.");

  // (1) pristine -> upgraded: every prior text that differs from the current one
  const stale = p.priors.filter((x) => x !== p.current);
  for (const [i, prior] of stale.entries()) {
    setPrompt(c, p.agent, prior);
    const refreshed = c.run();
    check(`[${p.label}] pristine stale prior #${i} is upgraded to the current text`, agentOf(c, p.agent).startupPrompt === p.current && refreshed.includes(p.agent));
    check(`[${p.label}] ...and a second run is then a no-op`, !c.run().includes(p.agent));
  }
  // Every prompt in this table has been trimmed once, so its first prior differs from the current text: the
  // pristine -> upgraded loop above must have run at least once (else it passed vacuously).
  check(`[${p.label}] at least one stale prior was exercised (${stale.length} of ${p.priors.length} listed) - the upgrade loop was not vacuous`, stale.length >= 1 && p.priors[0] !== p.current);
  check(`[${p.label}] the first prior differs from the current text (the list was introduced by an edit)`, p.priors[0] !== p.current);
  check(`[${p.label}] no prior value is listed twice`, new Set(p.priors).size === p.priors.length);

  // (4b) each older appended entry == the text shipped at ITS fixed sha
  for (const pin of OLDER_PINS.filter((x) => x.label === p.label)) {
    const src = showAt(pin.sha, p.file);
    if (src === null) { console.log(`SKIP  [${p.label}] sha ${pin.sha} not present in this checkout; byte-exactness of PRIOR_VALUES[${pin.index}] NOT verified here`); continue; }
    const shipped = literalAtBase(src, p.label);
    check(`[${p.label}] literal found at ${pin.sha} (extraction sanity)`, typeof shipped === "string" && shipped.length > 200);
    check(`[${p.label}] PRIOR_VALUES[${pin.index}] is byte-identical to the text shipped at ${pin.sha}`, p.priors[pin.index] === shipped);
    // Behavioural, independent of list position: an install holding exactly the text shipped at that sha moves to current.
    setPrompt(c, p.agent, shipped);
    const moved = c.run();
    check(`[${p.label}] an install holding the text shipped at ${pin.sha} is refreshed to the current text`, agentOf(c, p.agent).startupPrompt === p.current && moved.includes(p.agent));
  }
  check(`[${p.label}] every OLDER_PINS entry for it points at an existing list index`, OLDER_PINS.filter((x) => x.label === p.label).every((x) => x.index < p.priors.length));
  if (OLDER_PINS.some((x) => x.label === p.label)) {
    check(`[${p.label}] list length == 1 + pinned older entries (no unpinned prior)`, p.priors.length === 1 + OLDER_PINS.filter((x) => x.label === p.label).length);
  }
  setPrompt(c, p.agent, p.current);
}

// A byte-identical prior under a bundled agent NAME in a NON-reserved project is never touched: the refresh only
// ever looks inside the reserved home.
for (const [where, c, bundledNames] of [
  ["setup", ctx.setup, [[setupSeed.SETUP_AUDITOR_AGENT_NAME, setupSeed.WORKSPACE_AUDITOR_PROMPT_PRIOR_VALUES[0]], [setupSeed.COMPANION_AGENT_NAME, setupSeed.COMPANION_PROMPT_PRIOR_VALUES[0]]]],
  ["platform", ctx.platform, [["Platform Lead", platformSeed.PLATFORM_LEAD_PROMPT_PRIOR_VALUES[0]], ["Platform Auditor", platformSeed.PLATFORM_AUDIT_PROMPT_PRIOR_VALUES[0]]]],
]) {
  const pid = `plain-${where}`;
  c.db.insertProject({ id: pid, name: `Plain ${where}`, repoPath: home, vaultPath: home, config: {}, createdAt: new Date().toISOString(), archivedAt: null, reserved: false, referenceRepos: [], noGateByDesign: false, denyGlobs: [], repos: [], vaultOnly: true });
  bundledNames.forEach(([name, prior], i) => c.db.insertAgent({ id: `${pid}-${i}`, projectId: pid, name, startupPrompt: prior, position: i, profileId: null, endpoint: false, ioSchema: null }));
  c.run();
  check(`(${where}) byte-identical priors under bundled names in a NON-reserved project stay untouched`,
    bundledNames.every(([, prior], i) => c.db.getAgent(`${pid}-${i}`).startupPrompt === prior));
}

// A prior text only matches under ITS OWN agent name: a Companion row carrying the Workspace Auditor's prior is not refreshed.
{
  const c = ctx.setup;
  setPrompt(c, setupSeed.COMPANION_AGENT_NAME, setupSeed.WORKSPACE_AUDITOR_PROMPT_PRIOR_VALUES[0]);
  c.run();
  check("a prior value of ANOTHER prompt under the wrong agent name is not refreshed",
    agentOf(c, setupSeed.COMPANION_AGENT_NAME).startupPrompt === setupSeed.WORKSPACE_AUDITOR_PROMPT_PRIOR_VALUES[0]);
  setPrompt(c, setupSeed.COMPANION_AGENT_NAME, setupSeed.COMPANION_PROMPT);
}

// No home at all -> both entry points are a clean no-op.
{
  const empty = new Db(path.join(home, "empty.db"));
  check("refreshSetupHomePromptsPristine with no setup home returns [] without throwing", setupSeed.refreshSetupHomePromptsPristine(empty).length === 0);
  check("refreshPlatformPromptsPristine with no platform home returns [] without throwing", platformSeed.refreshPlatformPromptsPristine(empty).length === 0);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
