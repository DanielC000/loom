// Card fbb6e8ec — the config write validator rejects a `sessionEnv` key named CLAUDE_CONFIG_DIR outright
// (full rationale: docs/decisions/fbb6e8ec-sessionenv-claude-config-dir-rejected.md). A per-project
// override of this var relocates where the REAL engine writes its transcripts
// (card a92a0913) while Loom's own transcript reads and deny rules still resolve the DAEMON's own
// CLAUDE_CONFIG_DIR — a fail-open gap on a trust boundary. This test pins the fix at
// `validateProjectConfigOverride` (`mcp/platform.ts`) — the SAME function the human REST PATCH
// (gateway/server.ts) and the elevated Platform Lead's project_configure both call
// (`validateAgentProjectConfigOverride` never sees `sessionEnv` at all — it's omitted from that schema
// entirely, pre-existing and unrelated to this card).
//
// Hermetic — imports the built validator from dist/* only (no daemon, no db, no claude), mirroring
// test/sessionenv-dotted-key-guard.mjs's style for this exact sibling check.
//
// SCOPE (not completeness): this pins `validateProjectConfigOverride` only — it covers the human REST
// PATCH and the elevated Platform Lead's project_configure, both of which route through it. It does NOT
// cover POST /api/projects or POST /api/setup/project-init (gateway/server.ts), which store a raw,
// unvalidated `config` (sessionEnv included) with no call to this validator at all — the real backstop
// against THOSE two routes is the spawn-time scrub pinned by claude-config-dir-sessionenv-spawn-scrub.mjs,
// not this file.
//
// Proves:
//   (1) POSITIVE CONTROL — a plain, unrelated sessionEnv key is still accepted, so the rejection below is
//       scoped to this one name, not an accidental full-field lockout.
//   (2) The exact-case key "CLAUDE_CONFIG_DIR" is rejected, and the reason names the offending key and
//       explains WHY (never a bare/opaque zod path+type error).
//   (3) A CLAUDE_CONFIG_DIR key mixed alongside otherwise-valid plain keys still fails the WHOLE write
//       (fail closed, never a silent partial-drop of just the bad key).
//   (4) There is NO rotation carve-out, unlike the dotted-key check's `priorSessionEnvKeys` — a write is
//       rejected even when CLAUDE_CONFIG_DIR is already present with the SAME intended value.
//   (5) Case-insensitivity split: on win32, any case-variant spelling ("claude_config_dir",
//       "Claude_Config_Dir") is ALSO rejected (env var names are case-insensitive there); on POSIX, a
//       differently-cased key is accepted unchanged (only the exact case is reserved there). Pinned for
//       BOTH platforms EXPLICITLY, regardless of which host this runs on — never gated behind an
//       `if (process.platform === ...)` branch that only ever exercises the ambient host's own half
//       (lesson from review round 2: the dedupe'd shared predicate, `isClaudeConfigDirEnvKey`, takes an
//       explicit `platform` param for exactly this; the integration-level `validateProjectConfigOverride`
//       call doesn't, so that half is pinned via a temporary `process.platform` override instead,
//       restored immediately after — same precedent as test/start-guard-race.mjs).
//   (6) Composes correctly alongside the pre-existing dotted-key check (card 12400719) — a payload
//       tripping BOTH checks still fails closed, and neither check accidentally swallows the other when
//       only one of the two keys is actually bad.
//   (7) sessionEnv is not reachable on the agent-facing schema at all (pre-existing, included only so a
//       future schema change that re-adds sessionEnv to the agent path doesn't silently skip this guard).
//   (8) An empty/absent sessionEnv is untouched (no false positive on the common no-op case).
import { validateProjectConfigOverride, validateAgentProjectConfigOverride } from "../dist/mcp/platform.js";
import { isClaudeConfigDirEnvKey } from "../dist/pty/claude-config.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const withEnv = (sessionEnv) => ({ sessionEnv });

// --- (1) positive control: a plain, unrelated key is unaffected --------------------------------------
{
  const ok = validateProjectConfigOverride(withEnv({ LOOM_DEJA_BIN: "/usr/bin/deja" }));
  check("(1) positive control: an unrelated sessionEnv key is accepted", ok.ok === true);
  check("(1) positive control: the accepted value round-trips unchanged",
    ok.ok === true && ok.value.sessionEnv?.LOOM_DEJA_BIN === "/usr/bin/deja");
}

// --- (2) the exact-case key is rejected with a usable, specific reason -------------------------------
{
  const bad = validateProjectConfigOverride(withEnv({ CLAUDE_CONFIG_DIR: "/some/other/root" }));
  check("(2) a CLAUDE_CONFIG_DIR sessionEnv key is rejected", bad.ok === false);
  check("(2) the reason NAMES the offending key",
    bad.ok === false && bad.error.includes('"CLAUDE_CONFIG_DIR"'));
  check("(2) the reason explains WHY (the trust-boundary gap), not a bare zod error",
    bad.ok === false && /transcript/i.test(bad.error) && /CLAUDE_CONFIG_DIR/.test(bad.error));
  check("(2) the reason is not a generic/opaque zod message",
    bad.ok === false && !/^\(root\): Invalid$/i.test(bad.error.trim()));
}

// --- (3) mixed with otherwise-valid plain keys still fails the WHOLE write ---------------------------
{
  const bad = validateProjectConfigOverride(withEnv({ GOOD_KEY: "1", CLAUDE_CONFIG_DIR: "/x" }));
  check("(3) a CLAUDE_CONFIG_DIR key mixed with plain keys still rejects the whole sessionEnv write", bad.ok === false);
  check("(3) the reason still names the offending key", bad.ok === false && bad.error.includes('"CLAUDE_CONFIG_DIR"'));
}

// --- (4) no rotation carve-out — unlike the dotted-key check, a "same value" rewrite is still rejected ---
{
  // Simulates a caller passing `priorSessionEnvKeys` the way the dotted-key check's own rotation
  // exception would — this check must ignore that option entirely and reject regardless.
  const priorSessionEnvKeys = new Set(["CLAUDE_CONFIG_DIR"]);
  const stillRejected = validateProjectConfigOverride(withEnv({ CLAUDE_CONFIG_DIR: "/same/value" }), { priorSessionEnvKeys });
  check("(4) a write is rejected even when the key is already present (no rotation carve-out)", stillRejected.ok === false);
}

// --- (5a) case-insensitivity split, direct predicate test — explicit `platform` param, BOTH branches
// pinned unconditionally regardless of which host this actually runs on -------------------------------
{
  check("(5a) win32: exact case matches", isClaudeConfigDirEnvKey("CLAUDE_CONFIG_DIR", "win32") === true);
  check("(5a) win32: lowercase case-variant ALSO matches", isClaudeConfigDirEnvKey("claude_config_dir", "win32") === true);
  check("(5a) win32: mixed-case case-variant ALSO matches", isClaudeConfigDirEnvKey("Claude_Config_Dir", "win32") === true);
  check("(5a) win32: an unrelated key does not match", isClaudeConfigDirEnvKey("OTHER_VAR", "win32") === false);
  check("(5a) POSIX: exact case matches", isClaudeConfigDirEnvKey("CLAUDE_CONFIG_DIR", "linux") === true);
  check("(5a) POSIX: a lowercase case-variant does NOT match (exact case only)", isClaudeConfigDirEnvKey("claude_config_dir", "linux") === false);
  check("(5a) POSIX: a mixed-case case-variant does NOT match (exact case only)", isClaudeConfigDirEnvKey("Claude_Config_Dir", "linux") === false);
  check("(5a) POSIX: darwin behaves the same as linux (anything non-win32 is exact-case)", isClaudeConfigDirEnvKey("claude_config_dir", "darwin") === false);
}

// --- (5b) case-insensitivity split, through the REAL integration (validateProjectConfigOverride) — both
// branches pinned explicitly via a temporary process.platform override, restored immediately after each
// (same pattern as test/start-guard-race.mjs), so this test is not at the mercy of whichever OS ran it --
{
  const realPlatform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const lowerWin = validateProjectConfigOverride(withEnv({ claude_config_dir: "/x" }));
    const mixedWin = validateProjectConfigOverride(withEnv({ Claude_Config_Dir: "/x" }));
    check("(5b) win32: a lowercase case-variant key is ALSO rejected", lowerWin.ok === false);
    check("(5b) win32: a mixed-case case-variant key is ALSO rejected", mixedWin.ok === false);

    Object.defineProperty(process, "platform", { value: "linux" });
    const lowerPosix = validateProjectConfigOverride(withEnv({ claude_config_dir: "/x" }));
    const mixedPosix = validateProjectConfigOverride(withEnv({ Claude_Config_Dir: "/x" }));
    check("(5b) POSIX: a differently-cased key is accepted (only the exact case is reserved there)",
      lowerPosix.ok === true && mixedPosix.ok === true);
  } finally {
    Object.defineProperty(process, "platform", { value: realPlatform });
  }
}

// --- (6) composes correctly alongside the pre-existing dotted-key check ------------------------------
{
  const bothBad = validateProjectConfigOverride(withEnv({ CLAUDE_CONFIG_DIR: "/x", "a.b": "y" }));
  check("(6) a payload tripping BOTH checks still fails closed", bothBad.ok === false);

  const onlyDotted = validateProjectConfigOverride(withEnv({ "a.b": "y" }));
  check("(6) the dotted-key check still fires on its own when CLAUDE_CONFIG_DIR isn't present",
    onlyDotted.ok === false && /unset/i.test(onlyDotted.error) && /dot-path/i.test(onlyDotted.error));

  const onlyClaude = validateProjectConfigOverride(withEnv({ CLAUDE_CONFIG_DIR: "/x" }));
  check("(6) this check still fires on its own when no dotted key is present",
    onlyClaude.ok === false && onlyClaude.error.includes("CLAUDE_CONFIG_DIR") && !/dot-path/i.test(onlyClaude.error));
}

// --- (7) sanity: sessionEnv is omitted from the agent-facing schema entirely (pre-existing) -----------
{
  const bad = validateAgentProjectConfigOverride(withEnv({ CLAUDE_CONFIG_DIR: "/x" }));
  check("(7) sanity: sessionEnv is not an agent-settable field at all (rejected as unknown key)", bad.ok === false);
}

// --- (8) no false positive on the common empty/absent case --------------------------------------------
{
  check("(8) an absent sessionEnv is accepted", validateProjectConfigOverride({}).ok === true);
  check("(8) an empty sessionEnv object is accepted", validateProjectConfigOverride(withEnv({})).ok === true);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the config write validator rejects a sessionEnv key named CLAUDE_CONFIG_DIR (exact-case on POSIX, case-insensitive on win32) with a reason naming the key and the trust-boundary gap, with no rotation carve-out, fails the whole write when mixed with valid/dotted keys, composes correctly with the pre-existing dotted-key check, is unreachable on the agent-facing schema, and leaves a plain/absent/empty sessionEnv untouched."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
