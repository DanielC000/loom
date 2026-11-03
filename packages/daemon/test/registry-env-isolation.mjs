import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 3faaab0d: npm_config_registry (a registry URL may carry `user:pass@host` credentials, the same
// shape card 188d6a8c scoped HTTP_PROXY/HTTPS_PROXY/ALL_PROXY out for) is no longer in
// env-isolated-launch.mjs's unconditional BASE_ALLOWLIST (see that file's own test, section (b3), for the
// base-allowlist-level pure-function proof). This file proves `buildMcpServers`'s (pty/host.ts) own
// per-mount ENTITLEMENT decision for registry specifically: UNLIKE the proxy keys, there is no fixed/
// kind-keyed entitlement for registry (no seeded row needs it at runtime — card 3faaab0d's own
// investigation) — the ONLY path to it is an owner-added catalog row's own `passEnv`.
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE: LOOM_MARKITDOWN_BIN/LOOM_GITHUB_MCP_BIN point at
// process.execPath so neither resolver needs a real install.
//
// Proves:
//   (a) an ordinary owner-added capability with NO passEnv does NOT receive a credentialed
//       npm_config_registry — real spawn, both polarities checked: the key is absent, AND the planted
//       credential value does not leak under any OTHER key name either (a generic sentinel, planted
//       under a second, unrelated key, is used to catch exactly that).
//   (b) an owner-added capability whose OWN passEnv:["npm_config_registry"] DOES receive the raw
//       credentialed value — real spawn — and ONLY under that one key, never duplicated elsewhere.
//   (c) the two mounts that get a FIXED proxy-key entitlement (markitdown, the seeded github-binary
//       capability) do NOT also get npm_config_registry — there is no such fixed entitlement for it.
//
// Run: 1) build (turbo builds shared first), 2) node test/registry-env-isolation.mjs
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { useOwnLoomHome, cleanupPathSync } from "./_tmp-fixture.mjs";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = useOwnLoomHome("loom-registry-env-iso-");
// HUMAN-only override seams (mirror LOOM_CLAUDE_BIN) — point both at a real absolute path so neither
// resolver needs a real markitdown/github-mcp-server install. Set BEFORE importing dist.
process.env.LOOM_MARKITDOWN_BIN = process.execPath;
process.env.LOOM_GITHUB_MCP_BIN = process.execPath;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ECHO_ENV_FIXTURE = path.join(__dirname, "fixtures", "echo-env.mjs");

const { buildMcpServers } = await import("../dist/pty/host.js");
const { unwrapLauncherMount } = await import("./_env-isolation-helpers.mjs");

const REGISTRY_SENTINEL = "https://probeuser:SENTINEL_REGISTRY_CRED@registry.corp.example/";
const BASE_SPAWN_ENV = {
  PATH: process.env.PATH ?? process.env.Path ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "",
  TEMP: process.env.TEMP ?? process.env.TMP ?? os.tmpdir(), HOME: process.env.HOME ?? "",
  USERPROFILE: process.env.USERPROFILE ?? "",
};
// The SAME credential value planted under a second, unrelated key name — catches a bug that would leak
// the sentinel under any key OTHER than the one actually under test, not just under its own name.
const PLANTED_ENV = {
  ...BASE_SPAWN_ENV,
  npm_config_registry: REGISTRY_SENTINEL,
  PROBE_GENERIC_SENTINEL: REGISTRY_SENTINEL,
};

/** How many keys in `env` hold EXACTLY `value` — used to catch a leak under an unexpected key name. */
function countKeysWithValue(env, value) {
  return Object.values(env).filter((v) => v === value).length;
}

// ===================== (a) an ordinary owner-added capability, NO passEnv: no registry either =====================
const plainRow = {
  id: "cap-plain", slug: "plain-thing", name: "Plain Thing", description: "", transport: "stdio", kind: "bundled",
  provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: [ECHO_ENV_FIXTURE] }),
  toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: false, secretEnvVar: null,
  passEnv: [], createdAt: new Date().toISOString(),
};
{
  const mcpServers = buildMcpServers({
    sessionId: "s-plain", port: 4317, role: "worker",
    capabilities: [{ slug: "plain-thing" }], capabilityCatalog: [plainRow],
  });
  const resolved = mcpServers["plain-thing"];
  const unwrapped = unwrapLauncherMount(resolved);
  check("(a) the plain owner-added row mounted", unwrapped !== null);
  check("(a) its --allow list does NOT carry npm_config_registry", !unwrapped?.allowKeys.includes("npm_config_registry"));

  const { stdout } = await execFileAsync(resolved.command, resolved.args, { env: PLANTED_ENV });
  const echoed = JSON.parse(stdout);
  check("(a) the real spawned target did NOT receive npm_config_registry", !("npm_config_registry" in echoed.env));
  check("(a) the planted credential value does not leak under ANY key name (generic-sentinel check)",
    countKeysWithValue(echoed.env, REGISTRY_SENTINEL) === 0);
}

// ===================== (b) an owner-added row with its OWN passEnv:["npm_config_registry"] =====================
const passEnvRegistryRow = {
  id: "cap-passenv-registry", slug: "passenv-registry-fixture", name: "PassEnv Registry Fixture", description: "",
  transport: "stdio", kind: "bundled",
  provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: [ECHO_ENV_FIXTURE] }),
  toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: false, secretEnvVar: null,
  passEnv: ["npm_config_registry"], createdAt: new Date().toISOString(),
};
{
  const mcpServers = buildMcpServers({
    sessionId: "s-passenv-registry", port: 4317, role: "worker",
    capabilities: [{ slug: "passenv-registry-fixture" }], capabilityCatalog: [passEnvRegistryRow],
  });
  const resolved = mcpServers["passenv-registry-fixture"];
  const unwrapped = unwrapLauncherMount(resolved);
  check("(b) the fixture row's --allow list carries the owner's own passEnv:['npm_config_registry']",
    unwrapped?.allowKeys.includes("npm_config_registry"));

  const { stdout } = await execFileAsync(resolved.command, resolved.args, { env: PLANTED_ENV });
  const echoed = JSON.parse(stdout);
  check("(b) the real spawned target received the owner's passEnv-named npm_config_registry, credentials included",
    echoed.env.npm_config_registry === REGISTRY_SENTINEL);
  check("(b) the credential value appears under EXACTLY ONE key (no duplicate leak elsewhere)",
    countKeysWithValue(echoed.env, REGISTRY_SENTINEL) === 1);
}

// ===================== (c) the two FIXED proxy-entitled mounts do NOT also get npm_config_registry =====================
{
  const mcpServers = buildMcpServers({ sessionId: "s-markitdown", port: 4317, role: "worker", documentConversion: true });
  const unwrapped = unwrapLauncherMount(mcpServers.markitdown);
  check("(c) markitdown mounted", unwrapped !== null);
  check("(c) markitdown's --allow list does NOT carry npm_config_registry (no fixed entitlement for it)",
    !unwrapped?.allowKeys.includes("npm_config_registry"));
}
const githubBinaryRow = {
  id: "cap-fake-github", slug: "github", name: "GitHub", description: "", transport: "stdio", kind: "github-binary",
  provisionJson: JSON.stringify({ kind: "github-binary", version: "0.0.0-test" }),
  toolAllowlistJson: "[]", wantsScratchDir: false, requiresConnection: false, secretEnvVar: null,
  passEnv: [], createdAt: new Date().toISOString(),
};
{
  const mcpServers = buildMcpServers({
    sessionId: "s-github", port: 4317, role: "worker",
    capabilities: [{ slug: "github" }], capabilityCatalog: [githubBinaryRow],
  });
  const unwrapped = unwrapLauncherMount(mcpServers.github);
  check("(c) the seeded github-binary capability mounted", unwrapped !== null);
  check("(c) the seeded github-binary capability's --allow list does NOT carry npm_config_registry (no fixed entitlement for it)",
    !unwrapped?.allowKeys.includes("npm_config_registry"));
}

cleanupPathSync(tmpHome);

console.log(failures === 0
  ? "\n✅ ALL PASS — npm_config_registry entitlement (card 3faaab0d): an ordinary owner-added row with no passEnv never receives a credentialed registry value (and it never leaks under any other key name either); an owner's own passEnv:['npm_config_registry'] forwards it end to end, under exactly that one key; and neither of the two fixed proxy-entitled mounts (markitdown, the seeded github-binary capability) picks it up — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
