import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Multi-repo epic 49136451, PHASE 3 — the manager + worker startup-prompt blocks that surface a project's
// writable repo registry, and (the load-bearing half) the proof that a project WITHOUT a registry composes
// BYTE-IDENTICALLY to before those blocks existed.
//
// The byte-identical assertions are the point of this file. "The new param is optional, so nothing else
// changed" is a claim about the code, not a fact about the output — and every spawn in every single-repo
// project on every Loom install flows through these two functions. So the no-registry case is pinned
// against a literal expected string built from the OLD composition rules, not merely compared to itself.
//
// PURE + hermetic: both composers are exported pure functions, so this needs no Db, no daemon, no pty, no
// git, and no network — it just imports dist and compares strings.
//
// Run: 1) build (turbo builds shared first), 2) node test/multi-repo-prompt.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME (set BEFORE importing dist — paths.ts reads it at import time) ---
const tmpHome = path.join(os.tmpdir(), `loom-mrprompt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { composeWorkerStartupPrompt, buildWorkerRepoContext } = await import("../dist/sessions/worker-prompt.js");
const { composeManagerStartupPrompt } = await import("../dist/sessions/manager-prompt.js");

const REGISTRY = [
  { key: "api", path: "/work/aurora-api", gateCommand: "pytest -q" },
  { key: "site", path: "/work/aurora-site" }, // deliberately gateless — the "unverified" branch
];

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (1) WORKER — a project with NO registry composes byte-identically to the pre-multi-repo output.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const brief = "You are a Dev worker. Step 0: run `/worker`.";
  const kickoff = "TASK: card abc123 — do the thing.";
  const cwd = "/wt/loom/abc123";

  // The literal expected output under the OLD rules: location block, then blank line, then brief, then
  // the "---" separator, then the kickoff. Written out by hand so a regression in ANY of the interleaving
  // (not just the presence of the new block) fails this.
  const expected =
    "## Where you edit (your isolated git worktree)\n" +
    `- **Your worktree (make ALL edits here, never the main checkout):** \`${cwd}\`\n\n` +
    "This worktree IS your cwd. If anything else in your context names the main repo path, that's for " +
    "reference, not where you edit — make every change here, on your assigned branch." +
    `\n\n${brief}\n\n---\n\n${kickoff}`;

  // Every shape a single-repo spawn can take: the param omitted entirely, and explicitly undefined.
  const omitted = composeWorkerStartupPrompt(brief, kickoff, cwd, []);
  const explicitUndefined = composeWorkerStartupPrompt(brief, kickoff, cwd, [], undefined, undefined, undefined);

  check("(1) worker · no registry · param OMITTED is byte-identical to the pre-multi-repo output", omitted === expected);
  check("(1) worker · no registry · param explicitly undefined is byte-identical too", explicitUndefined === expected);
  check("(1) worker · no registry · output contains NO repo-block text at all",
    !omitted.includes("This task targets") && !omitted.includes("One task = one repo"));

  // buildWorkerRepoContext is the guard that MAKES the above true in production: an empty registry must
  // yield undefined, so a single-repo project can never reach the block even though the call site always
  // calls it. Assert that directly rather than trusting the call site.
  const ctx = buildWorkerRepoContext({ repos: [] }, { key: "primary", path: "/work/loom", gateCommand: "pnpm build" });
  check("(1) buildWorkerRepoContext returns undefined for a project with an EMPTY registry", ctx === undefined);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (2) MANAGER — a project with NO registry composes byte-identically to the pre-multi-repo output.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const own = "You are the Orchestrator for Aurora.";
  // vaultPath "" (a project with no vault bound) is chosen deliberately: it is the one fully
  // DETERMINISTIC branch of this composer. Any vault path pulls in resolveResumeDocPath + a real
  // fs.statSync size probe, so a hand-written expectation there would be pinning the resume-doc
  // machinery rather than the additive guarantee this section exists to prove.
  const loc = { repoPath: "/work/loom", vaultPath: "", name: "Aurora" };

  // The literal expected output under the OLD (pre-multi-repo) rules, written out by hand rather than
  // captured from the function under test. An earlier version of this section compared the no-registry
  // output to ITSELF (`before` vs `withEmptyRegistry`, both from the current build), which proves only
  // that the three call shapes agree with each other — it would have passed no matter what the block
  // did to all three. This is the real pin, and it matches how section (1) pins the worker composer.
  const expected =
    "## Where things live (this project's absolute paths)\n" +
    "- **Repo root (your cwd):** `/work/loom`\n" +
    "\n" +
    "Read project files by ABSOLUTE path from these roots — never Glob from your home directory " +
    "for them (a broad Glob hits the search timeout)." +
    " This project has no vault bound — there is no resume doc; keep any handoff/progress notes on the board task instead." +
    `\n\n${own}`;

  const omitted = composeManagerStartupPrompt(own, loc);
  const withEmptyRegistry = composeManagerStartupPrompt(own, { ...loc, repos: [] });
  const withUndefinedRegistry = composeManagerStartupPrompt(own, { ...loc, repos: undefined });

  check("(2) manager · no registry · field OMITTED is byte-identical to the pre-multi-repo output", omitted === expected);
  check("(2) manager · no registry · repos:[] is byte-identical to the pre-multi-repo output", withEmptyRegistry === expected);
  check("(2) manager · no registry · repos:undefined is byte-identical to the pre-multi-repo output", withUndefinedRegistry === expected);
  check("(2) manager · no registry · output contains NO registry-block text at all",
    !omitted.includes("Registered repos") && !omitted.includes("One task = one repo"));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (3) WORKER — a NON-primary target on a registry project.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const out = composeWorkerStartupPrompt("BRIEF", "KICKOFF", "/wt/api/x", [], undefined, undefined, {
    targetKey: "api", targetPath: "/work/aurora-api", targetGateCommand: "pytest -q", registry: REGISTRY,
  });
  check("(3) names the target repo by key", out.includes("**This task targets the `api` repo** (`/work/aurora-api`)"));
  check("(3) says the worktree was cut from that repo and the merge lands there",
    out.includes("cut FROM that repo, and your branch, your gate and your merge all land there"));
  // Manager ruling C1: the gate fact is the one a worker most needs, and it must name THIS repo's command.
  check("(3) names THIS repo's own gate command for run_gate + the merge gate",
    out.includes("Your `run_gate` self-check and the merge gate both run THIS repo's own gate command (`pytest -q`)"));
  check("(3) lists the OTHER registered repos, including primary, as not-yours",
    out.includes("**Other repos registered on this project (NOT yours for this task):**")
    && out.includes("- `primary` — the project's primary repo")
    && out.includes("- `site` — `/work/aurora-site`"));
  check("(3) does NOT list the target repo among the others", !out.includes("- `api` — `/work/aurora-api`"));
  // Manager ruling C3: this sentence encodes the repoKey-authority ruling and is required verbatim.
  check("(3) carries the dispatch-authority sentence VERBATIM",
    out.includes("You never choose or change which repo a task targets — that is your manager's dispatch decision."));
  check("(3) teaches cross-repo work as a sibling card, escalated up",
    out.includes("that is a SEPARATE card") && out.includes("sequence a sibling"));
  check("(3) the block still leads into the brief and kickoff", out.indexOf("This task targets") < out.indexOf("BRIEF"));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (4) WORKER — a PRIMARY target on a registry project STILL gets the block (manager ruling C2).
// A worker on the primary repo of a multi-repo project is precisely the one who might wander into
// another repo, so silence here would be the wrong default.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const out = composeWorkerStartupPrompt("BRIEF", "KICKOFF", "/wt/loom/x", [], undefined, undefined, {
    targetKey: null, targetPath: "/work/loom", targetGateCommand: "pnpm build", registry: REGISTRY,
  });
  check("(4) a PRIMARY-targeted card on a registry project still emits the block",
    out.includes("**This task targets the `primary` repo** (`/work/loom`)"));
  check("(4) it lists both registered repos as not-yours",
    out.includes("- `api` — `/work/aurora-api`") && out.includes("- `site` — `/work/aurora-site`"));
  check("(4) it does NOT list a redundant `primary` line among the others",
    !out.includes("- `primary` — the project's primary repo"));
  check("(4) it still carries the one-task-one-repo rule", out.includes("**One task = one repo.**"));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (5) WORKER — a GATELESS target repo says "unverified" and explicitly denies any fallback.
// The no-fallback ruling is settled (a gate that passed for an unrelated repo would look like
// verification without being any), so the copy must never imply the project gate applies.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const out = composeWorkerStartupPrompt("BRIEF", "KICKOFF", "/wt/site/x", [], undefined, undefined, {
    targetKey: "site", targetPath: "/work/aurora-site", targetGateCommand: undefined, registry: REGISTRY,
  });
  check("(5) a gateless target repo reports the merge as unverified",
    out.includes("NO gate command configured") && out.includes("**unverified**"));
  check("(5) it explicitly denies falling back to another repo's gate",
    out.includes("does not fall back to another repo's gate"));
  check("(5) it tells the worker to say what is unverified in its report",
    out.includes("what is unverified"));
  check("(5) it does NOT claim run_gate will run some other command",
    !out.includes("both run THIS repo's own gate command"));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (6) MANAGER — a registry project gets the routing block.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const out = composeManagerStartupPrompt("OWN PROMPT", {
    repoPath: "/work/loom", vaultPath: "", name: "Aurora", repos: REGISTRY,
  });
  check("(6) lists primary first, as the default target and the manager's own cwd",
    out.includes("- `primary` — `/work/loom` (the default target, and your own cwd)"));
  check("(6) lists a gated repo with its own gate command", out.includes("- `api` — `/work/aurora-api` · gate: `pytest -q`"));
  check("(6) flags a gateless repo as merging unverified",
    out.includes("- `site` — `/work/aurora-site` · **no gate configured** — merges here report as unverified"));
  check("(6) teaches routing at card-CREATION time via repoKey",
    out.includes("Route each card at CREATION time by setting its `repoKey`"));
  check("(6) states repoKey is the manager's own authority and a worker cannot set it",
    out.includes("a worker cannot set or change") && out.includes("its own card's repo"));
  check("(6) teaches cross-repo work as two sequenced sibling cards, never one",
    out.includes("**One task = one repo.**") && out.includes("TWO") && out.includes("sibling cards you sequence"));
  check("(6) states the no-inherit gate rule for a registered repo",
    out.includes("does NOT inherit this project's gate"));
  check("(6) the block still precedes the agent's own prompt", out.endsWith("OWN PROMPT"));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// (7) buildWorkerRepoContext maps a resolved repo onto the block's inputs.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const primary = buildWorkerRepoContext({ repos: REGISTRY }, { key: "primary", path: "/work/loom", gateCommand: "pnpm build" });
  check("(7) a primary resolution maps to targetKey null (the Task/Session repoKey convention)", primary?.targetKey === null);
  check("(7) a primary resolution carries the primary path + gate", primary?.targetPath === "/work/loom" && primary?.targetGateCommand === "pnpm build");
  const entry = buildWorkerRepoContext({ repos: REGISTRY }, { key: "api", path: "/work/aurora-api", gateCommand: "pytest -q" });
  check("(7) a registry resolution keeps its key", entry?.targetKey === "api");
  const gateless = buildWorkerRepoContext({ repos: REGISTRY }, { key: "site", path: "/work/aurora-site", gateCommand: undefined });
  check("(7) a gateless registry entry keeps gateCommand undefined (never coerced to a fallback)", gateless?.targetGateCommand === undefined);
  check("(7) the full registry rides along for the not-yours list", entry?.registry.length === 2);
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — the multi-repo registry blocks surface the target repo, its gate, and the one-task-one-repo rule; a project with NO registry composes byte-identically on BOTH composers."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
