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
// injectSkills() call against a curated skill store, and a real PlatformMcpRouter read back over an
// in-memory MCP client for surface (d).
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

// ===================== THE DENYLIST — re-derived against real shipped content, not copied verbatim =====
const DENY_PATTERNS = [
  // §3e structural rule: zero @decision/card-id citations of the 8-hex shape, full stop — the id-space is
  // never resolvable off an npm install (no docs/decisions/ ships). Matches `@decision <id>`, `card <id>`,
  // and a bare backtick-wrapped 8-hex id (the third citation shape this repo's own doctrine uses).
  { name: "decision/card id citation", re: /@decision\s+[0-9a-f]{8}\b|\bcard\s+[0-9a-f]{8}\b|`[0-9a-f]{8}`/i },
  { name: "packages/ path", re: /packages\// },
  { name: "@loom/ package scope", re: /@loom\// },
  { name: "pnpm --filter", re: /pnpm --filter/ },
  { name: "pnpm build command", re: /\bpnpm build\b/ },
  { name: "pnpm daemon command", re: /\bpnpm daemon\b/ },
  { name: "worktrees.ts", re: /worktrees\.ts/ },
  // Narrowed (see header): a repo/dev-process artifact noun, never a bare "Loom's own <anything>" —
  // the broad form false-positived on ordinary product-behavior prose in the real delivered corpus.
  // The extra nouns (project/board/home/recommended/command/web UI) are the real dogfood shapes this
  // repo's own CLAUDE.md actually uses ("Loom's own recommended value", "Loom's own project until the
  // owner sets it", "Loom's own command", "Loom's own web UI") — measured zero false positives against
  // the real delivered skill corpus (see the pattern self-check below, drawn from that same CLAUDE.md text).
  { name: "\"Loom's own\" repo/dev-process artifact", re: /Loom's own (?:repo(?:sitory)?|codebase|source(?: code)?|CLAUDE\.md|dev(?:elopment)? team|git history|commit history|project|board|home|recommended|command|web UI)\b/i },
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
  // widened alternation (project/board/home/recommended/command/web UI) exists to catch.
  check("(pattern self-check) REAL CLAUDE.md text \"Loom's own recommended value\" DOES trip it",
    loomsOwnRe.test("Loom's own recommended value** (measured on this host, card `bd9a483b`)"));
  check("(pattern self-check) REAL CLAUDE.md text \"Eyeballing Loom's own web UI\" DOES trip it",
    loomsOwnRe.test("Eyeballing Loom's own web UI with a real, authenticated browser"));
  check("(pattern self-check) REAL CLAUDE.md text \"Loom's own project until the owner sets it\" DOES trip it",
    loomsOwnRe.test("a GREEN proceeds exactly as an ordinary ungated landing did before this existed — Loom's own project until the owner sets it"));
  check("(pattern self-check) REAL CLAUDE.md text \"without naming Loom's own command\" DOES trip it",
    loomsOwnRe.test("shipped skills/docs describe it without naming Loom's own command"));
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
const { injectSkills } = await import("../dist/skills/inject.js");
const { claudeSkillsDir } = await import("../dist/pty/claude-doctrine.js");
const { resolvePlatformLeadResumeDocPath, platformLeadBaseResumeDocPath } = await import("../dist/sessions/platform-lead-prompt.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
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

function freshRepo(tag) {
  const dir = path.join(os.tmpdir(), `loom-eu-nodogfood-repo-${tag}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# no-dogfood test repo\n");
  execSync("git init -q", { cwd: dir });
  commitAll(dir, "init", "-c user.email=nodogfood@loom -c user.name=nodogfood");
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
{
  const cwd = path.join(tmpHome, "skill-surface-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  injectSkills(cwd, "scan-session-b", null, "platform", false);
  const deliveredDir = claudeSkillsDir(cwd);
  check("(b) sanity: injectSkills actually delivered something to this cwd", fs.existsSync(deliveredDir));
  const deliveredNames = fs.readdirSync(deliveredDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  check(`(b) sanity: the Lead's locked-role/subset-null resolution delivers the FULL curated set, not a narrowed one (delivered: ${deliveredNames.length}, curated: ${curatedSkillNames.length})`,
    deliveredNames.length === curatedSkillNames.length);
  check("(b) sanity: the dev-only skills are absent from the DELIVERED set too (never merely undelivered from an absent store)",
    !deliveredNames.includes("platform-audit") && !deliveredNames.includes("codescape") && !deliveredNames.includes("research"));

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

fs.rmSync(tmpHome, { recursive: true, force: true });

console.log(failures === 0
  ? "\n✅ ALL PASS — the end-user Platform Lead's seeded prompt, the REAL composed fresh-spawn AND recycle startupPrompt text, EVERY skill its own injectSkills resolution actually delivers (derived, not hand-picked — SKILL.md + references/** + scripts/**, minus the dev-only three), and the non-dev PlatformMcpRouter's rendered tool descriptions + representative (lookup-miss AND deeper-validation) error strings all carry ZERO Loom-dogfood/card-id/internal-package tokens — each surface positive-controlled by PLANTING at its real source (a db row, the recycle handoff argument, the real skill store, a wrapped real McpServer.registerTool call) and re-running that surface's own real capture path, never a bare string-concatenation copy."
  : `\n🛑 ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
