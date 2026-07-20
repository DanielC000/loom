// Two agent-config-override security/correctness guards (ONE branch). HERMETIC — imports the built
// validators (dist/mcp/platform.js) + resolveConfig (@loom/shared); no daemon, no claude.
//
// Fix A (host-exec capability leak): the agent-facing config validator rejects every NAMED host-exec
// field (gateCommand/alertWebhook/obsidian.path/python.interpreterPath/platform), but `sessionEnv` is an
// INTERNAL transport for those same human-only fields (e.g. LOOM_PYTHON_INTERPRETER → discoverBasePython
// → spawn(override) = host RCE; LOOM_OBSIDIAN_PATH → preflight launches the exe; NODE_OPTIONS=--require /
// PATH). `sessionEnv` is now DROPPED from the agent shape (`.strict()` → rejected unknown key), while the
// HUMAN/REST validator still accepts it.
//
// Fix B (allow baseline must survive a custom permission.allow): resolveConfig used to SUBSTITUTE the
// override allow wholesale, silently dropping the load-bearing default allow (mcp__loom-tasks + git globs)
// that stops the unattended permission-prompt hang. It now UNIONS the override onto the baseline, deduped.
import { validateProjectConfigOverride, validateAgentProjectConfigOverride } from "../dist/mcp/platform.js";
import { resolveConfig, PLATFORM_DEFAULTS } from "@loom/shared";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Fix A: sessionEnv is HUMAN-only -----------------------------------------------------------------
{
  // The exploit payloads that motivated the fix — each is a host-exec/exfil capability smuggled as env.
  const payloads = [
    { LOOM_PYTHON_INTERPRETER: "/tmp/evil" },     // → spawn(override) host RCE (the python.interpreterPath rejection's analogue)
    { LOOM_OBSIDIAN_PATH: "/tmp/evil" },          // → preflight launches the exe
    { LOOM_OBSIDIAN_AUTOSTART: "1" },             // → arms the preflight launch
    { NODE_OPTIONS: "--require /tmp/evil.js" },   // → arbitrary module load in the spawned node
    { PATH: "/tmp/evil:/usr/bin" },               // → PATH hijack
  ];
  for (const env of payloads) {
    const r = validateAgentProjectConfigOverride({ sessionEnv: env });
    const key = Object.keys(env)[0];
    check(`agent path: sessionEnv {${key}} REJECTED (human-only, dropped from agent shape)`, r.ok === false);
    check(`agent path: rejection reason names sessionEnv (${key})`, r.ok === false && /sessionEnv/.test(r.error));
  }
  // An otherwise-valid agent override that ALSO carries sessionEnv is rejected as a whole (.strict()).
  check("agent path: a valid override + sessionEnv is rejected (strict unknown key)",
    validateAgentProjectConfigOverride({ docLint: false, sessionEnv: { FOO: "bar" } }).ok === false);

  // The HUMAN/REST validator STILL accepts sessionEnv and round-trips it unchanged.
  const human = validateProjectConfigOverride({ sessionEnv: { LOOM_PYTHON_INTERPRETER: "/usr/bin/python3", FOO: "bar" } });
  check("human path: sessionEnv accepted", human.ok === true);
  check("human path: sessionEnv round-trips unchanged",
    human.ok && human.value.sessionEnv?.LOOM_PYTHON_INTERPRETER === "/usr/bin/python3" && human.value.sessionEnv?.FOO === "bar");

  // Sanity: an agent override WITHOUT sessionEnv is still accepted (the drop is surgical, not a blanket break).
  check("agent path: an override without sessionEnv still accepted", validateAgentProjectConfigOverride({ docLint: false }).ok === true);
}

// --- Fix B: a custom permission.allow UNIONS (never replaces) the default baseline --------------------
{
  const baseline = PLATFORM_DEFAULTS.permission.allow; // mcp__loom-tasks + git/obsidian globs
  const CUSTOM = "Bash(echo CUSTOM_OK:*)";
  const resolved = resolveConfig({ permission: { allow: [CUSTOM] } }).permission.allow;

  // Every baseline entry survives the custom allow (the load-bearing healing — was wholesale-dropped before).
  for (const b of baseline) {
    check(`custom allow KEEPS baseline entry "${b}"`, resolved.includes(b));
  }
  check("custom allow keeps its OWN entry too (union ADDS, not replaces)", resolved.includes(CUSTOM));
  // Deduped: every entry appears exactly once (the union must not duplicate).
  check("union is deduped (no entry appears twice)", new Set(resolved).size === resolved.length);
  // Specifically the mcp__loom-tasks baseline (the hang-preventer) appears exactly once.
  check("mcp__loom-tasks present exactly once", resolved.filter((t) => t === "mcp__loom-tasks").length === 1);

  // A custom allow that already restates a baseline entry doesn't duplicate it — both the MCP baseline
  // (re-added by the spawn-path withBaselineAllow → must stay idempotent with this union) AND a git glob.
  const overlap = resolveConfig({ permission: { allow: ["mcp__loom-tasks", "Bash(git status:*)", CUSTOM] } }).permission.allow;
  check("a custom allow restating the mcp__loom-tasks baseline stays deduped", overlap.filter((t) => t === "mcp__loom-tasks").length === 1);
  check("a custom allow restating a baseline GIT GLOB stays deduped", overlap.filter((t) => t === "Bash(git status:*)").length === 1);
  // Idempotency with the spawn-path re-add: every entry unique, so a later withBaselineAllow (which only
  // appends MISSING baseline entries) is a no-op — no double-add regardless of overlap.
  check("overlap union is fully deduped (spawn-path withBaselineAllow re-add is a no-op)", new Set(overlap).size === overlap.length);

  // Default config (no allow override) is BYTE-IDENTICAL to the baseline — additive-when-absent.
  const def = resolveConfig({}).permission.allow;
  check("default config: allow equals the baseline (byte-identical, no dupes)", JSON.stringify(def) === JSON.stringify(baseline));
  const defNoArg = resolveConfig(undefined).permission.allow;
  check("no-override fast path: allow equals the baseline", JSON.stringify(defNoArg) === JSON.stringify(baseline));
}

// --- Fix A corollary: the human sessionEnv SYNTHESIS transport is untouched ---------------------------
// The drop is ONLY on the agent VALIDATOR schema. resolveConfig still SYNTHESIZES sessionEnv from the
// human-only fields (python.interpreterPath → LOOM_PYTHON_INTERPRETER; obsidian.path/autoStart →
// LOOM_OBSIDIAN_*), so a legit human-set value still reaches the spawn. The drop must not break this path.
{
  const py = resolveConfig({ python: { interpreterPath: "/usr/bin/python3" } }).sessionEnv;
  check("human python.interpreterPath still synthesizes sessionEnv.LOOM_PYTHON_INTERPRETER", py.LOOM_PYTHON_INTERPRETER === "/usr/bin/python3");
  const ob = resolveConfig({ obsidian: { autoStart: true, path: "/opt/Obsidian.AppImage" } }).sessionEnv;
  check("human obsidian.autoStart still synthesizes sessionEnv.LOOM_OBSIDIAN_AUTOSTART", ob.LOOM_OBSIDIAN_AUTOSTART === "1");
  check("human obsidian.path still synthesizes sessionEnv.LOOM_OBSIDIAN_PATH", ob.LOOM_OBSIDIAN_PATH === "/opt/Obsidian.AppImage");
  // The default alt-screen sessionEnv vars are preserved regardless (no transport regression).
  const base = resolveConfig({}).sessionEnv;
  check("default sessionEnv alt-screen vars preserved", base.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN === "1" && base.CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT === "1");
}

// --- Fix C (card c1f2f095): orchestration.resumeDocFilename is a STRICT BARE FILENAME ------------------
// Unlike gateCommand/alertWebhook (dropped entirely from the agent shape), resumeDocFilename stays
// agent-settable on BOTH validators — it's benign (no host-launch/exfil capability) — but it's a PATH
// COMPONENT the daemon later joins onto vaultPath and presents as an AUTHORITATIVE path in a TRUSTED
// prompt block, so a traversal value must be rejected at validation time on both surfaces, not just
// caught by the resolver's own defense-in-depth (resolveResumeDocPath — covered separately).
{
  const traversalPayloads = [
    "../../.ssh/id_rsa",
    "..\\..\\Windows\\System32\\config\\SAM",
    "/etc/passwd",
    "C:\\Users\\evil.md",
    "C:evil.md",
    "..",
    ".",
    "sub/dir.md",
    "sub\\dir.md",
  ];
  for (const bad of traversalPayloads) {
    const a = validateAgentProjectConfigOverride({ orchestration: { resumeDocFilename: bad } });
    check(`agent path: resumeDocFilename "${bad}" REJECTED`, a.ok === false);
    const h = validateProjectConfigOverride({ orchestration: { resumeDocFilename: bad } });
    check(`human path: resumeDocFilename "${bad}" REJECTED too (not just agent-gated)`, h.ok === false);
  }
  // A legitimate bare filename (incl. spaces + non-ASCII, a real-world project convention) passes on both.
  const good = "Selbstläufer — Orchestrator Resume.md";
  const a = validateAgentProjectConfigOverride({ orchestration: { resumeDocFilename: good } });
  check("agent path: a bare filename with spaces/unicode is accepted", a.ok === true && a.value.orchestration?.resumeDocFilename === good);
  const h = validateProjectConfigOverride({ orchestration: { resumeDocFilename: good } });
  check("human path: same bare filename accepted", h.ok === true && h.value.orchestration?.resumeDocFilename === good);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — sessionEnv is HUMAN-only on the agent VALIDATOR (rejects every host-exec env payload) while the human path + the server-side python/obsidian sessionEnv SYNTHESIS transport are untouched, a custom permission.allow UNIONS the full default baseline (mcp__loom-tasks + git globs) deduped (idempotent with the spawn-path withBaselineAllow re-add) instead of substituting it wholesale, and orchestration.resumeDocFilename rejects every path-traversal/absolute-path payload on BOTH the agent and human validators while accepting a real bare filename."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
