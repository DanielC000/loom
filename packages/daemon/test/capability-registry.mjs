import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Agent-tooling epic P4 — capability registry. DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like
// browser-testing-spawn.mjs/document-conversion-spawn.mjs: isolated LOOM_HOME, a FAKE python-venv
// provisioner (no real venv/pip/network), and a FAKE capability catalog (no real DB-backed MCP package).
//
// Proves:
//   (a) resolveProfileCapabilities bridges the legacy browserTesting/documentConversion booleans + the new
//       capabilities array into ONE resolved grant list, in the documented order.
//   (b) buildMcpServers' ONE generalized loop: byte-identical when nothing is enabled; the two legacy
//       slugs still resolve through their EXISTING bespoke code (mounted under "playwright"/"markitdown"
//       exactly as before — see browser-testing-spawn.mjs / document-conversion-spawn.mjs for that half);
//       an owner-added capability mounts under its OWN slug via the generic resolver; an enabled-but-
//       catalog-absent slug is log-and-skipped, never thrown.
//   (c) the credential tie (OQ1): a requiresConnection capability with a bound connectionId gets its
//       resolved secret injected ONLY into the mounted server's own `env` block (never args) — and a grant
//       with no connectionId mounts WITHOUT a secret, without ever calling the secret resolver.
//   (d) the byte-identical BRIDGE regression: an old-shape buildMcpServers call (booleans only, no
//       `capabilities` field at all) is byte-for-byte identical to the equivalent new-shape call.
//   (e) validateCapabilityDefInput: reserved-slug rejection, the deferred `command` kind rejection,
//       requiresConnection needing secretEnvVar, and a well-formed input.
//   (f) DB round-trip: createCapabilityDef/listCapabilitySummaries (builtins first)/duplicate-slug
//       rejection/deleteCapabilityDef.
//   (gate) listCapabilitySummaries drops "deja-corpus" on a non-LOOM_DEV build (Deja is a PRIVATE
//       product) and includes it once LOOM_DEV=1 — independent of the UI-level toggle hides.
//   (g) the per-slug python-venv provisioning tracker: COLD resolves null + kicks background provisioning
//       (a FAKE provisioner, never a real pip install); a LATER call resolves the now-warm binary.
//   (h) CODE-REVIEW FIX (critical): a capability secret must NEVER ride claude's own argv or the daemon
//       spawn log. A secret-bearing mcpServers map diverts --mcp-config to a 0600 FILE (buildSpawnArgs'
//       mcpConfigPath); a secret-FREE spawn stays byte-identical to the inline JSON form; the log line's
//       redaction is proven directly via redactSecrets.
//   (i) CODE-REVIEW FIX (major): resolveCapabilityServer / capabilityToolAllowlist never throw on a
//       malformed provisionJson/toolAllowlistJson row — that ONE capability is skipped, buildMcpServers
//       still mounts every other enabled capability.
//   (j) hardening: transport:"http" is rejected in v1 (resolveCapabilityServer hardcodes stdio); a
//       PROFILE capabilities grant naming a reserved legacy slug is rejected (validate.ts), not just a
//       catalog-def create.
//
// Run: 1) build (turbo builds shared first), 2) node test/capability-registry.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-cr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// listCapabilitySummaries' isLoomDev() gate check below needs the TRUE default-off state — delete any
// inherited LOOM_DEV=1 (e.g. this test running inside a LOOM_DEV=1 self-hosting/orchestration shell;
// mirrors platform-dev-flag.mjs).
delete process.env.LOOM_DEV;

const { resolveProfileCapabilities } = await import("@loom/shared");
const {
  buildMcpServers, buildSpawnArgs, collectMcpEnvSecrets, mcpConfigHasSecret, redactSecrets, capabilityToolAllowlist,
} = await import("../dist/pty/host.js");
const { writeSessionMcpConfig } = await import("../dist/pty/claude-settings.js");
const { SETTINGS_DIR, isLoomDev } = await import("../dist/paths.js");
const { Db } = await import("../dist/db.js");
const {
  validateCapabilityDefInput, createCapabilityDef, listCapabilitySummaries, deleteCapabilityDef,
  resolveCapabilityServer, __setCapabilityProvisionerForTest, getCapabilityProvisionStatus,
} = await import("../dist/capabilities/registry.js");
const { validateProfile, agentProfileKeyError } = await import("../dist/profiles/validate.js");
fs.mkdirSync(SETTINGS_DIR, { recursive: true });

// ===================== validateProfile / AGENT_FORBIDDEN_PROFILE_KEYS: capabilities is HUMAN-only =====================
const validCaps = validateProfile({ name: "P", capabilities: [{ slug: "gh-mcp", connectionId: "conn1" }] });
check("(validate-profile) a well-formed capabilities grant validates ok", validCaps.ok === true && JSON.stringify(validCaps.value.capabilities) === JSON.stringify([{ slug: "gh-mcp", connectionId: "conn1" }]));
check("(validate-profile) capabilities normalizes to [] when absent", validateProfile({ name: "P" }).ok === true && JSON.stringify(validateProfile({ name: "P" }).value.capabilities) === "[]");
check("(agent-forbidden) an agent MCP profile writer's payload with 'capabilities' is REJECTED",
  typeof agentProfileKeyError({ capabilities: [{ slug: "x" }] }) === "string");
check("(agent-forbidden) 'connections' stays rejected too (no regression)", typeof agentProfileKeyError({ connections: ["c1"] }) === "string");
check("(agent-forbidden) a payload with neither forbidden key passes", agentProfileKeyError({ name: "P", browserTesting: true }) === null);

// ===================== (a) resolveProfileCapabilities bridge =====================
check("(bridge) neither boolean nor capabilities ⇒ []",
  JSON.stringify(resolveProfileCapabilities({})) === "[]");
check("(bridge) browserTesting only ⇒ [{slug:'browser-testing'}]",
  JSON.stringify(resolveProfileCapabilities({ browserTesting: true })) === JSON.stringify([{ slug: "browser-testing" }]));
check("(bridge) documentConversion only ⇒ [{slug:'document-conversion'}]",
  JSON.stringify(resolveProfileCapabilities({ documentConversion: true })) === JSON.stringify([{ slug: "document-conversion" }]));
check("(bridge) both legacy booleans + a capabilities array ⇒ legacy first (stable order), then the array verbatim",
  JSON.stringify(resolveProfileCapabilities({ browserTesting: true, documentConversion: true, capabilities: [{ slug: "custom" }] }))
  === JSON.stringify([{ slug: "browser-testing" }, { slug: "document-conversion" }, { slug: "custom" }]));
check("(bridge) capabilities alone (both legacy booleans false/absent) ⇒ just the array",
  JSON.stringify(resolveProfileCapabilities({ capabilities: [{ slug: "custom", connectionId: "c1" }] }))
  === JSON.stringify([{ slug: "custom", connectionId: "c1" }]));

// ===================== (b) buildMcpServers: byte-identical-when-none + the ONE generalized loop =====================
const off = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker" });
check("(mcp) no capabilities ⇒ only loom-tasks + loom-orchestration (byte-identical to today)",
  Object.keys(off).sort().join(",") === "loom-orchestration,loom-tasks");
const withLegacyBoolean = buildMcpServers({ sessionId: "s1", port: 4317, role: "worker", browserTesting: true });
check("(mcp) browserTesting=true still mounts 'playwright' through the ONE generalized loop", "playwright" in withLegacyBoolean);

const fakeBundled = {
  id: "cap1", slug: "fake-thing", name: "Fake Thing", description: "test", transport: "stdio", kind: "bundled",
  provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: ["--version"] }),
  toolAllowlistJson: JSON.stringify(["mcp__fake-thing"]), wantsScratchDir: false, requiresConnection: false,
  secretEnvVar: null, createdAt: new Date().toISOString(),
};
const withFake = buildMcpServers({
  sessionId: "s2", port: 4317, role: "worker",
  capabilities: [{ slug: "fake-thing" }], capabilityCatalog: [fakeBundled],
});
check("(owner-added) an enabled owner-added bundled capability mounts under its OWN slug key", "fake-thing" in withFake);
check("(owner-added) command/args come straight from the bundled provision recipe",
  withFake["fake-thing"].command === process.execPath && JSON.stringify(withFake["fake-thing"].args) === JSON.stringify(["--version"]));

const withUnknownSlug = buildMcpServers({ sessionId: "s3", port: 4317, role: "worker", capabilities: [{ slug: "nope" }], capabilityCatalog: [] });
check("(log-and-skip) an enabled capability absent from the catalog is skipped, never thrown",
  !("nope" in withUnknownSlug) && Object.keys(withUnknownSlug).sort().join(",") === "loom-orchestration,loom-tasks");

// ===================== (c) credential tie (agent-tooling P4 OQ1) =====================
const credDef = {
  ...fakeBundled, id: "cap2", slug: "needs-cred", requiresConnection: true, secretEnvVar: "FAKE_TOKEN",
  provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: [] }),
};
let secretResolverCalls = 0;
const withCred = buildMcpServers({
  sessionId: "s4", port: 4317, role: "worker",
  capabilities: [{ slug: "needs-cred", connectionId: "conn1" }], capabilityCatalog: [credDef],
  resolveConnectionSecret: (id) => { secretResolverCalls++; return id === "conn1" ? "super-secret-value" : undefined; },
});
check("(credential-tie) the resolved secret rides the server's OWN env under secretEnvVar",
  withCred["needs-cred"].env?.FAKE_TOKEN === "super-secret-value");
check("(credential-tie) the secret NEVER lands in args", !withCred["needs-cred"].args.includes("super-secret-value"));

secretResolverCalls = 0;
const withCredNoBinding = buildMcpServers({
  sessionId: "s5", port: 4317, role: "worker",
  capabilities: [{ slug: "needs-cred" }], capabilityCatalog: [credDef], // no connectionId granted on this profile
  resolveConnectionSecret: () => { secretResolverCalls++; return "should-never-be-used"; },
});
check("(credential-tie) no connectionId on the grant ⇒ mounts WITHOUT an env secret", withCredNoBinding["needs-cred"]?.env === undefined);
check("(credential-tie) no connectionId on the grant ⇒ the secret resolver is never even called", secretResolverCalls === 0);

// ===================== CODE-REVIEW FIX: the secret must NEVER ride claude's argv or the spawn log =====================
// Simulates createPty's EXACT sequence: buildMcpServers → collectMcpEnvSecrets → (conditionally)
// writeSessionMcpConfig → buildSpawnArgs → the redacted log line. Proves the whole chain, not just one link.
check("(mcp-secret) collectMcpEnvSecrets finds the secret embedded in withCred's env",
  collectMcpEnvSecrets(withCred).includes("super-secret-value"));
check("(mcp-secret) mcpConfigHasSecret is true for withCred, false for a plain map", mcpConfigHasSecret(withCred) === true && mcpConfigHasSecret(off) === false);

const secretsForSpawn = collectMcpEnvSecrets(withCred);
const mcpConfigPath = writeSessionMcpConfig("s4", withCred);
check("(mcp-secret) writeSessionMcpConfig writes a FILE containing the secret", fs.readFileSync(mcpConfigPath, "utf8").includes("super-secret-value"));
if (process.platform !== "win32") {
  const mode = fs.statSync(mcpConfigPath).mode & 0o777;
  check("(mcp-secret) the written mcp-config file is 0600 (owner-only)", mode === 0o600);
}

const secretArgs = buildSpawnArgs({ settingsPath: "/fake/settings.json", mode: "acceptEdits", mcpServers: withCred, mcpConfigPath });
check("(mcp-secret) a secret-bearing spawn's argv uses the FILE PATH, not inline JSON", secretArgs.includes(mcpConfigPath));
check("(mcp-secret) the secret NEVER appears anywhere in buildSpawnArgs' output", !JSON.stringify(secretArgs).includes("super-secret-value"));

const secretArgsLog = redactSecrets(JSON.stringify(secretArgs), secretsForSpawn);
check("(mcp-secret) the secret never appears in the (redacted) spawn-log line either", !secretArgsLog.includes("super-secret-value"));

// ===================== CODE-REVIEW FIX regression: a NO-secret spawn stays BYTE-IDENTICAL (the conditional branch) =====================
const noSecretArgsOldShape = buildSpawnArgs({ settingsPath: "/fake/settings.json", mode: "acceptEdits", mcpServers: off });
const noSecretArgsNewShape = buildSpawnArgs({ settingsPath: "/fake/settings.json", mode: "acceptEdits", mcpServers: off, mcpConfigPath: undefined });
check("(mcp-secret) a no-secret spawn's buildSpawnArgs output is BYTE-IDENTICAL whether or not mcpConfigPath is threaded (undefined ⇒ today's inline form)",
  JSON.stringify(noSecretArgsOldShape) === JSON.stringify(noSecretArgsNewShape));
check("(mcp-secret) a no-secret spawn still inlines the JSON (never diverts to a file)",
  noSecretArgsOldShape[noSecretArgsOldShape.indexOf("--mcp-config") + 1] === JSON.stringify({ mcpServers: off }));

// ===================== MAJOR FIX regression: capabilityToolAllowlist never throws on a malformed catalog row =====================
const malformedAllowlistDef = { ...fakeBundled, slug: "broken-allow", toolAllowlistJson: "{not valid json" };
const allowWithBroken = capabilityToolAllowlist([{ slug: "broken-allow" }, { slug: "browser-testing" }], [malformedAllowlistDef]);
check("(major-fix) a malformed toolAllowlistJson degrades to no extra allow for THAT capability, never throws",
  JSON.stringify(allowWithBroken) === JSON.stringify(["mcp__playwright"]));

// ===================== MAJOR FIX regression: resolveCapabilityServer never throws on a malformed provisionJson row =====================
const malformedProvisionDef = { ...fakeBundled, slug: "broken-provision", provisionJson: "{not valid json" };
let resolveThrew = false;
let resolvedBroken;
try { resolvedBroken = resolveCapabilityServer(malformedProvisionDef, {}); } catch { resolveThrew = true; }
check("(major-fix) resolveCapabilityServer NEVER throws on a malformed provisionJson row", !resolveThrew && resolvedBroken === null);
// End-to-end through buildMcpServers: the malformed capability is skipped; every OTHER enabled capability
// (here the legacy browser-testing slug) still mounts — the spawn continues, it doesn't crash wholesale.
const mcpWithBrokenRow = buildMcpServers({
  sessionId: "s7", port: 4317, role: "worker", browserTesting: true,
  capabilities: [{ slug: "broken-provision" }], capabilityCatalog: [malformedProvisionDef],
});
check("(major-fix) buildMcpServers with a malformed catalog row still mounts every OTHER capability (never crashes the whole spawn)",
  !("broken-provision" in mcpWithBrokenRow) && "playwright" in mcpWithBrokenRow);

// ===================== hardening: reject transport:"http" (v1 is subprocess-only) =====================
check("(hardening) transport:'http' is rejected in v1 (resolveCapabilityServer hardcodes stdio)",
  validateCapabilityDefInput({ slug: "http-thing", name: "x", description: "", transport: "http", kind: "bundled", provision: { command: process.execPath }, toolAllowlist: [] }).ok === false);

// ===================== hardening: a PROFILE capabilities grant may not name a reserved legacy slug =====================
const reservedInProfile = validateProfile({ name: "P", capabilities: [{ slug: "browser-testing" }] });
check("(hardening) a profile's capabilities array naming 'browser-testing' is rejected (use the boolean instead)", reservedInProfile.ok === false);
const reservedInProfile2 = validateProfile({ name: "P", capabilities: [{ slug: "document-conversion" }] });
check("(hardening) a profile's capabilities array naming 'document-conversion' is rejected too", reservedInProfile2.ok === false);
const nonReservedInProfile = validateProfile({ name: "P", capabilities: [{ slug: "my-custom-thing" }] });
check("(hardening) a profile's capabilities array naming a NON-reserved slug still validates ok", nonReservedInProfile.ok === true);

// ===================== (d) byte-identical BRIDGE regression =====================
const oldShape = buildMcpServers({ sessionId: "s6", port: 4317, role: "worker", browserTesting: true });
const newShapeEquivalent = buildMcpServers({ sessionId: "s6", port: 4317, role: "worker", browserTesting: true, documentConversion: false, capabilities: [], capabilityCatalog: [] });
check("(regression) an old-shape call (no capabilities/capabilityCatalog fields at all) is BYTE-IDENTICAL to the explicit new-shape equivalent",
  JSON.stringify(oldShape) === JSON.stringify(newShapeEquivalent));

// ===================== (e) validateCapabilityDefInput =====================
check("(validate) a reserved slug is rejected",
  validateCapabilityDefInput({ slug: "browser-testing", name: "x", description: "", transport: "stdio", kind: "bundled", provision: { command: "/bin/x" }, toolAllowlist: [] }).ok === false);
// ===================== command provision-kind (P4 follow-on): owner-typed-therefore-trusted =====================
const commandOk = validateCapabilityDefInput({
  slug: "arb", name: "x", description: "", transport: "stdio", kind: "command",
  provision: { command: process.execPath, args: ["--version"] }, toolAllowlist: [],
});
check("(validate) a resolvable 'command' provision is accepted", commandOk.ok === true);
check("(validate) 'command' is resolved to an ABSOLUTE path at save time",
  commandOk.ok === true && path.isAbsolute(commandOk.value.provision.command) && commandOk.value.provision.command === process.execPath);
const commandBadArgs = validateCapabilityDefInput({
  slug: "arb2", name: "x", description: "", transport: "stdio", kind: "command",
  provision: { command: process.execPath, args: "not-an-array" }, toolAllowlist: [],
});
check("(validate) 'command' provision rejects non-array args", commandBadArgs.ok === false);
const commandUnresolvable = validateCapabilityDefInput({
  slug: "arb3", name: "x", description: "", transport: "stdio", kind: "command",
  provision: { command: "totally-not-a-real-binary-xyz123" }, toolAllowlist: [],
});
check("(validate) an unresolvable bare 'command' name is REJECTED at save time (not deferred to a silent per-spawn skip)", commandUnresolvable.ok === false);

// CODE-REVIEW FIX: resolveExecutable trusts an already-absolute (or slash-containing) path with NO
// existence check — only a bare PATH-searched name gets fs-verified. Without an explicit fs.existsSync
// in validateCapabilityDefInput, a NONEXISTENT absolute path would pass this guard and silently no-op at
// every spawn. This case must be rejected too.
const nonexistentAbsPath = path.join(os.tmpdir(), "loom-cr-does-not-exist-xyz123", "nope.exe");
const commandNonexistentAbs = validateCapabilityDefInput({
  slug: "arb4", name: "x", description: "", transport: "stdio", kind: "command",
  provision: { command: nonexistentAbsPath }, toolAllowlist: [],
});
check("(validate) a NONEXISTENT absolute 'command' path is REJECTED at save time (not just a bare unresolvable name)",
  commandNonexistentAbs.ok === false);

const commandDef = {
  ...fakeBundled, slug: "arb-cmd", kind: "command",
  provisionJson: JSON.stringify({ kind: "command", command: process.execPath, args: ["--version"] }),
};
const resolvedCommand = resolveCapabilityServer(commandDef, {});
check("(command) resolveCapabilityServer mounts a command capability from its resolved abs command + args",
  resolvedCommand?.command === process.execPath && JSON.stringify(resolvedCommand?.args) === JSON.stringify(["--version"]));

// credential tie (OQ1) covered for the command kind too, not just bundled.
const commandCredDef = {
  ...commandDef, slug: "arb-cmd-cred", requiresConnection: true, secretEnvVar: "ARB_TOKEN",
};
const resolvedCommandCred = resolveCapabilityServer(commandCredDef, { connectionSecret: "arb-secret-value" });
check("(command) resolveCapabilityServer injects the bound secret into the mounted server's OWN env, under secretEnvVar",
  resolvedCommandCred?.env?.ARB_TOKEN === "arb-secret-value");
check("(command) the secret NEVER lands in the mounted server's args", !(resolvedCommandCred?.args ?? []).includes("arb-secret-value"));
check("(validate) requiresConnection WITHOUT secretEnvVar is rejected",
  validateCapabilityDefInput({ slug: "gh", name: "GitHub", description: "", transport: "stdio", kind: "bundled", provision: { command: "/bin/x" }, toolAllowlist: [], requiresConnection: true }).ok === false);
const goodInput = validateCapabilityDefInput({
  slug: "gh", name: "GitHub", description: "d", transport: "stdio", kind: "bundled",
  provision: { command: process.execPath, args: [] }, toolAllowlist: ["mcp__gh"], requiresConnection: true, secretEnvVar: "GITHUB_TOKEN",
});
check("(validate) a well-formed input validates ok", goodInput.ok === true);

// ===================== outputDirEnvVar (agent-tooling P4 follow-on, image-gen capability b93cfd10) =====================
// The wantsScratchDir mechanism for bundled/command kinds (node-package's is the hardcoded `--output-dir`
// CLI arg — this is the OTHER one, an env-var name of the owner's/seed's choosing). Owner-REST input, not
// just the seed path, must validate it: reject a blank/non-string/over-long name, accept + round-trip a
// well-formed one — for BOTH kinds that support it.
const LONG_ENV_VAR = "A".repeat(201);
for (const kind of ["bundled", "command"]) {
  const baseProvision = kind === "bundled" ? { command: "npx", args: ["-y", "x"] } : { command: process.execPath, args: [] };
  check(`(validate) ${kind} rejects a blank outputDirEnvVar`,
    validateCapabilityDefInput({ slug: `odv-blank-${kind}`, name: "x", description: "", transport: "stdio", kind, provision: { ...baseProvision, outputDirEnvVar: "   " }, toolAllowlist: [] }).ok === false);
  check(`(validate) ${kind} rejects a non-string outputDirEnvVar`,
    validateCapabilityDefInput({ slug: `odv-nonstr-${kind}`, name: "x", description: "", transport: "stdio", kind, provision: { ...baseProvision, outputDirEnvVar: 42 }, toolAllowlist: [] }).ok === false);
  check(`(validate) ${kind} rejects an outputDirEnvVar over 200 characters`,
    validateCapabilityDefInput({ slug: `odv-long-${kind}`, name: "x", description: "", transport: "stdio", kind, provision: { ...baseProvision, outputDirEnvVar: LONG_ENV_VAR }, toolAllowlist: [] }).ok === false);
  const okResult = validateCapabilityDefInput({ slug: `odv-ok-${kind}`, name: "x", description: "", transport: "stdio", kind, provision: { ...baseProvision, outputDirEnvVar: "MY_OUTPUT_DIR" }, toolAllowlist: [] });
  check(`(validate) ${kind} accepts + round-trips a well-formed outputDirEnvVar onto the stored provision`,
    okResult.ok === true && okResult.value.provision.outputDirEnvVar === "MY_OUTPUT_DIR");
  // omitted entirely ⇒ still validates ok, undefined on the stored provision (fully optional, additive).
  const omittedResult = validateCapabilityDefInput({ slug: `odv-omit-${kind}`, name: "x", description: "", transport: "stdio", kind, provision: baseProvision, toolAllowlist: [] });
  check(`(validate) ${kind} with outputDirEnvVar omitted still validates ok, with it undefined on the stored provision`,
    omittedResult.ok === true && omittedResult.value.provision.outputDirEnvVar === undefined);
}
// Small guard (CR nit): outputDirEnvVar === secretEnvVar would collide in the mounted server's env block
// (one silently clobbers the other) — reject that self-harm at save time.
check("(validate) outputDirEnvVar equal to secretEnvVar is rejected (they'd collide in the mounted env)",
  validateCapabilityDefInput({
    slug: "odv-collide", name: "x", description: "", transport: "stdio", kind: "bundled",
    provision: { command: "npx", args: ["-y", "x"], outputDirEnvVar: "SAME_VAR" },
    toolAllowlist: [], requiresConnection: true, secretEnvVar: "SAME_VAR",
  }).ok === false);
check("(validate) outputDirEnvVar different from secretEnvVar still validates ok",
  validateCapabilityDefInput({
    slug: "odv-nocollide", name: "x", description: "", transport: "stdio", kind: "bundled",
    provision: { command: "npx", args: ["-y", "x"], outputDirEnvVar: "OUT_DIR" },
    toolAllowlist: [], requiresConnection: true, secretEnvVar: "A_TOKEN",
  }).ok === true);

// ===================== (f) DB round-trip =====================
const db = new Db();
const created = createCapabilityDef(db, {
  slug: "gh-mcp", name: "GitHub", description: "d", transport: "stdio", kind: "python-venv",
  provision: { packages: ["a-fake-pypi-pkg"], binary: "a-fake-pypi-pkg" }, toolAllowlist: ["mcp__gh"],
  requiresConnection: true, secretEnvVar: "GITHUB_TOKEN",
});
check("(db) createCapabilityDef persists + returns a REST summary (never the raw provisioning recipe)",
  created.slug === "gh-mcp" && created.builtin === false && !("provision" in created) && !("provisionJson" in created));
check("(db) createCapabilityDef's summary carries the row id (the Settings UI's DELETE target)", typeof created.id === "string" && created.id.length > 0);

// ===================== (gate) listCapabilitySummaries drops "deja-corpus" on a non-LOOM_DEV build =====
// Deja is a PRIVATE product (Loom is public on npm) — a regular loomctl user's GET /api/capabilities
// must never even NAME it, independent of the UI-level toggle hides (Profiles.tsx/Settings.tsx).
// "open-design" is a PUBLIC OSS builtin (unlike deja-corpus) — it's NEVER dropped, dev build or not.
check("(gate) isLoomDev() is FALSE by default (LOOM_DEV unset)", isLoomDev() === false);
const summariesNonDev = listCapabilitySummaries(db);
check("(gate) non-dev build: listCapabilitySummaries returns the 3 non-Deja builtins + the owner-added row (NO deja-corpus)",
  summariesNonDev.length === 4 && summariesNonDev[0].slug === "browser-testing" && summariesNonDev[1].slug === "document-conversion" && summariesNonDev[2].slug === "open-design" && summariesNonDev[3].slug === "gh-mcp");

process.env.LOOM_DEV = "1";
check("(gate) isLoomDev() is TRUE once LOOM_DEV=1", isLoomDev() === true);
const summaries = listCapabilitySummaries(db);
check("(db) listCapabilitySummaries returns the 4 BUILTINS first, then the owner-added row (LOOM_DEV=1)",
  summaries.length === 5 && summaries[0].slug === "browser-testing" && summaries[1].slug === "document-conversion" && summaries[2].slug === "deja-corpus" && summaries[3].slug === "open-design" && summaries[4].slug === "gh-mcp");
check("(db) the 4 BUILTIN summaries carry NO id (they aren't capability_defs rows and can't be deleted)",
  summaries[0].id === undefined && summaries[1].id === undefined && summaries[2].id === undefined && summaries[3].id === undefined);
let dupThrew = false;
try {
  createCapabilityDef(db, { slug: "gh-mcp", name: "x", description: "", transport: "stdio", kind: "bundled", provision: { command: process.execPath }, toolAllowlist: [] });
} catch { dupThrew = true; }
check("(db) createCapabilityDef throws on a duplicate slug", dupThrew);
const capRow = db.getCapabilityDefBySlug("gh-mcp");
deleteCapabilityDef(db, capRow.id);
check("(db) deleteCapabilityDef removes the row", db.getCapabilityDefBySlug("gh-mcp") === undefined);
db.close();

// ===================== (g) per-slug python-venv provisioning tracker (FAKE provisioner — no real venv/network) =====================
__setCapabilityProvisionerForTest(async () => ({ outcome: "ready", binary: "/fake/venv/bin/a-fake-pypi-pkg" }));
const venvDef = { ...fakeBundled, slug: "venv-thing", kind: "python-venv", provisionJson: JSON.stringify({ kind: "python-venv", packages: ["a-fake-pypi-pkg"], binary: "a-fake-pypi-pkg" }) };
const coldAttempt = resolveCapabilityServer(venvDef, {});
check("(venv) COLD resolves null the FIRST time (never blocks) and kicks background provisioning", coldAttempt === null);
await new Promise((r) => setTimeout(r, 50)); // let the fake (async) provisioner's promise settle
check("(venv) provisioning status reaches 'ready' via the FAKE provisioner", getCapabilityProvisionStatus("venv-thing")?.state === "ready");
const warmAttempt = resolveCapabilityServer(venvDef, {});
check("(venv) a LATER call resolves the now-warm binary (no re-provisioning)", warmAttempt?.command === "/fake/venv/bin/a-fake-pypi-pkg");
__setCapabilityProvisionerForTest(); // restore + reset all per-slug state

delete process.env.LOOM_DEV;
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — capability registry (agent-tooling P4): resolveProfileCapabilities bridge, buildMcpServers' ONE generalized loop (byte-identical-when-none, log-and-skip, owner-added dispatch, credential-tie env injection, the byte-identical bridge regression), validateCapabilityDefInput (incl. the http-transport + reserved-legacy-slug hardening), DB CRUD, the per-slug python-venv provisioning tracker, the mcp-config-to-argv/log secret-leak fix (conditional file-diversion + redaction, byte-identical when secret-free), and malformed-JSON-row never-throws hardening — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
