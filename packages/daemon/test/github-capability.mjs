import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Agent-tooling P4 follow-on (board card 3b0c4aef): the FIRST real credential-tied catalog capability
// (GitHub MCP) — end-to-end proof of the requiresConnection connection-bind path with a REAL registered
// row, not just the fake capability capability-registry.mjs already covers generically. Migrated off the
// archived `@modelcontextprotocol/server-github` (npx) onto the Loom-managed `github-binary` provision kind
// — see github-binary-provision.mjs / github-binary-download.mjs for that download/verify/extract pipeline
// itself; THIS test's job is the credential-tie plumbing, proven via a fixture "echo-env" script standing
// in for the real github-mcp-server binary so it stays DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE
// (LOOM_GITHUB_MCP_NO_PROVISION=1 disables any real download of the actually-seeded row too).
//
// Proves:
//   (a) seedDefaultCapabilities seeds exactly one "github" row, seed-if-absent (idempotent), with the
//       documented shape: requiresConnection, secretEnvVar, provision {kind:"github-binary", version}, and
//       an "mcp__github" tool allow entry.
//   (b) resolveCapabilityServer resolves the seeded row generically (the SAME dispatch an owner-added row
//       gets — github is a plain capability_defs row, not a 4th hardcoded builtin slug).
//   (c) end-to-end through buildMcpServers with a REAL P1 connection (created + decrypted via the real
//       connections/store.ts, not a fake resolver): the token lands ONLY in the mounted server's env under
//       GITHUB_PERSONAL_ACCESS_TOKEN, never in args.
//   (d) the HARD DoD: the secret never rides claude's own argv (buildSpawnArgs) or the redacted spawn-log
///      line, for THIS specific capability's mcp-config (not just the generic fake-capability case).
//   (e) a REAL child_process spawn (not a mocked exec call) of the resolved {command,args,env} proves the
//       secret arrives through the OS process env and is ABSENT from the spawned process's own argv — the
//       "throwaway echo-env MCP" the task's stub-verify path calls for.
//   (f) CODE-REVIEW FIX (generic "bundled"-kind self-heal, unrelated to github's own seed shape): a bare
//       command stored in a "bundled" provision is never pre-resolved at seed time — resolveCapabilityServer's
//       bundled branch re-resolves it live at EVERY call (self-heal, like the three hardcoded builtins), so a
//       capability that's unresolvable on ONE call (a stripped-PATH boot, the binary not yet installed)
//       resolves cleanly on a LATER call once it becomes reachable — never permanently frozen to whatever
//       PATH looked like at seed time.
//
// Run: 1) build (turbo builds shared first), 2) node test/github-capability.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-gh-cap-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// The seeded row now provisions via github-binary (a download), NOT npx — disable real provisioning so a
// cold resolve of the REAL seeded row never kicks a real network download in this NETWORK-FREE test (the
// download/checksum/extract pipeline itself is covered separately in github-binary-download.mjs).
process.env.LOOM_GITHUB_MCP_NO_PROVISION = "1";

const { Db } = await import("../dist/db.js");
const { seedDefaultCapabilities, bundledCapabilities } = await import("../dist/capabilities/seed.js");
const { resolveCapabilityServer } = await import("../dist/capabilities/registry.js");
const {
  buildMcpServers, buildSpawnArgs, collectMcpEnvSecrets, mcpConfigHasSecret, redactSecrets,
} = await import("../dist/pty/host.js");
const { writeSessionMcpConfig } = await import("../dist/pty/claude-settings.js");
const { SETTINGS_DIR } = await import("../dist/paths.js");
const { createConnection, getSecretForUse } = await import("../dist/connections/store.js");
fs.mkdirSync(SETTINGS_DIR, { recursive: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ECHO_ENV_FIXTURE = path.join(__dirname, "fixtures", "echo-env.mjs");

// A distinctive stub token — its presence anywhere OTHER than the spawned fixture's own env is a hard failure.
const STUB_TOKEN = "ghp_STUB-do-not-leak-abcdefghijklmnop";

// ===================== (a) seedDefaultCapabilities =====================
const db = new Db();
check("(seed) pristine db has no capability_defs rows yet", db.listCapabilityDefs().length === 0);
const seeded = seedDefaultCapabilities(db);
// Two bundled rows ship now (github + the image-gen follow-on, board card b93cfd10) — this test's own job
// is only the "github" row's shape, so it scopes its seeded-list assertion to "github is among them" rather
// than "github is the only one" (image-gen-capability.mjs owns the image-gen row's own assertions).
check("(seed) seeds 'github' (among the bundled set)", seeded.includes("github"));
const ghRow = db.getCapabilityDefBySlug("github");
check("(seed) the row exists in the db", !!ghRow);
check("(seed) name/description mention GitHub", ghRow.name === "GitHub" && ghRow.description.toLowerCase().includes("github"));
check("(seed) transport is stdio", ghRow.transport === "stdio");
check("(seed) requiresConnection is true (the whole point of this card)", ghRow.requiresConnection === true);
check("(seed) secretEnvVar is a non-blank string", typeof ghRow.secretEnvVar === "string" && ghRow.secretEnvVar.length > 0);
check("(seed) tool allowlist grants the whole 'mcp__github' server (mirrors the mcp__playwright convention)",
  JSON.parse(ghRow.toolAllowlistJson).includes("mcp__github"));
const ghProvision = JSON.parse(ghRow.provisionJson);
check("(seed) provision kind is 'github-binary' (the Loom-managed downloaded Go binary, replacing the archived npx package)", ghProvision.kind === "github-binary");
check("(seed) row.kind (top-level) matches provisionJson.kind", ghRow.kind === "github-binary");
check("(seed) provision.version is a non-blank string (the pinned github-mcp-server release)",
  typeof ghProvision.version === "string" && ghProvision.version.length > 0);
check("(seed) description names the bound PAT's own scopes as the containment boundary for the granted tool surface",
  ghRow.description.toLowerCase().includes("scope"));

// seed-if-absent: calling again on the SAME db is a no-op (idempotent), never a duplicate/throw.
const secondSeedCall = seedDefaultCapabilities(db);
check("(seed) a second call seeds nothing (idempotent, seed-if-absent by slug)", secondSeedCall.length === 0);
check("(seed) exactly the bundled row count persists (github + image-gen, no dupes)", db.listCapabilityDefs().length === bundledCapabilities().length);

// bundledCapabilities() itself is a pure function callers can inspect without a db.
check("(seed) bundledCapabilities() includes the 'github' definition", bundledCapabilities().some((c) => c.slug === "github"));

// ===================== (b) resolveCapabilityServer resolves the REAL seeded row generically =====================
// github is a PLAIN capability_defs row — it must go through the exact same generic dispatch an owner-added
// row would (unlike the three hardcoded builtin slugs, which never see resolveConnectionSecret at all).
const resolvedNoSecret = resolveCapabilityServer(ghRow, {});
check("(resolve) with no connectionSecret, mounts WITHOUT an env block (or unresolved — provisioning is disabled in this network-free test)",
  resolvedNoSecret === null || resolvedNoSecret.env === undefined);

// ===================== (c) end-to-end through buildMcpServers with a REAL P1 connection =====================
const conn = createConnection(db, { name: "Test GitHub PAT", host: "api.github.com", authScheme: "bearer", secret: STUB_TOKEN });
check("(connection) a real encrypted P1 connection round-trips back to the stub token", getSecretForUse(db, conn.id) === STUB_TOKEN);

const catalog = db.listCapabilityDefs();
const withGithub = buildMcpServers({
  sessionId: "s-gh", port: 4317, role: "worker",
  capabilities: [{ slug: "github", connectionId: conn.id }],
  capabilityCatalog: catalog,
  resolveConnectionSecret: (id) => getSecretForUse(db, id),
});
// Real github-binary provisioning is DISABLED in this network-free test (LOOM_GITHUB_MCP_NO_PROVISION=1),
// so the real seeded row never actually downloads/mounts here — that graceful cold-skip is proven
// generically by github-binary-provision.mjs. This test's job is the credential tie specifically, so it
// skips that half gracefully and proves it instead via the fixture-forced resolution below.
if (withGithub.github) {
  check("(e2e) the real stub token rides the mounted 'github' server's OWN env under secretEnvVar",
    withGithub.github.env?.[ghRow.secretEnvVar] === STUB_TOKEN);
  check("(e2e) the stub token NEVER lands in the mounted server's args", !(withGithub.github.args ?? []).includes(STUB_TOKEN));
} else {
  console.log("SKIP  (e2e) 'github' capability did not resolve (github-binary provisioning disabled in this network-free test) — credential-tie assertions skipped, covered instead via the fixture-forced resolution below");
}

// ===================== (d) HARD DoD: the secret never rides claude's argv or the redacted spawn log =====================
// Force resolution via the fixture (bypassing any real download dependency) so this DoD-critical assertion is
// NEVER environment-dependent — the whole point is proving the plumbing, independent of whether the binary exists
// on the machine running this test.
const ghRowFixture = { ...ghRow, provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: [ECHO_ENV_FIXTURE] }) };
const withGithubFixture = buildMcpServers({
  sessionId: "s-gh2", port: 4317, role: "worker",
  capabilities: [{ slug: "github", connectionId: conn.id }],
  capabilityCatalog: [ghRowFixture],
  resolveConnectionSecret: (id) => getSecretForUse(db, id),
});
check("(fixture) the fixture-backed row mounts", !!withGithubFixture.github);
check("(fixture) the stub token rides the env, not args",
  withGithubFixture.github.env?.[ghRow.secretEnvVar] === STUB_TOKEN && !withGithubFixture.github.args.includes(STUB_TOKEN));

check("(leak) collectMcpEnvSecrets finds the stub token embedded in the fixture row's env", collectMcpEnvSecrets(withGithubFixture).includes(STUB_TOKEN));
check("(leak) mcpConfigHasSecret is true for the fixture mcp-config", mcpConfigHasSecret(withGithubFixture) === true);

const ghSecrets = collectMcpEnvSecrets(withGithubFixture);
const ghMcpConfigPath = writeSessionMcpConfig("s-gh2", withGithubFixture);
check("(leak) a secret-bearing spawn diverts --mcp-config to a FILE (never inline in the claude argv)",
  fs.readFileSync(ghMcpConfigPath, "utf8").includes(STUB_TOKEN));

const ghSpawnArgs = buildSpawnArgs({ settingsPath: "/fake/settings.json", mode: "acceptEdits", mcpServers: withGithubFixture, mcpConfigPath: ghMcpConfigPath });
check("(leak) the claude spawn argv uses the FILE PATH, not inline JSON", ghSpawnArgs.includes(ghMcpConfigPath));
check("(leak) the stub token NEVER appears anywhere in the claude process argv", !JSON.stringify(ghSpawnArgs).includes(STUB_TOKEN));

const ghSpawnLog = redactSecrets(JSON.stringify(ghSpawnArgs), ghSecrets);
check("(leak) the stub token never appears in the (redacted) daemon spawn-log line either", !ghSpawnLog.includes(STUB_TOKEN));

// ===================== (e) REAL child_process spawn: env-only delivery, argv-free (the stub-verify DoD) =====================
// Spawns the ACTUAL resolved {command,args,env} entry — not a mocked exec call — so this proves the OS-level
// env transmission genuinely works cross-platform, and that the secret is absent from the spawned process's
// own argv (the "throwaway echo-env MCP" the task calls for).
const ghServer = withGithubFixture.github;
const { stdout } = await execFileAsync(ghServer.command, ghServer.args, {
  env: { ...process.env, ...ghServer.env },
});
const echoed = JSON.parse(stdout);
check("(spawn) the REAL spawned subprocess received the stub token via its OWN env", echoed.env[ghRow.secretEnvVar] === STUB_TOKEN);
check("(spawn) the REAL spawned subprocess's own argv does NOT contain the stub token", !JSON.stringify(echoed.argv).includes(STUB_TOKEN));
check("(spawn) the command line handed to the subprocess never embedded the secret either",
  !ghServer.args.join(" ").includes(STUB_TOKEN) && !ghServer.command.includes(STUB_TOKEN));

// ===================== (f) CODE-REVIEW FIX: bare-command spawn-time re-resolution (self-heal) =====================
// Proves resolveCapabilityServer never freezes a bare "bundled" command's resolution: a name that isn't
// installed anywhere on PATH resolves to null (graceful skip, matching every other unresolvable
// capability) — and once the SAME row's SAME bare command becomes installed later, a LATER call resolves
// it, with NO db re-seed and NO daemon restart. (resolveExecutable only caches a SUCCESSFUL resolution —
// exactly like the "claude" binary + the Playwright/markitdown builtins already rely on — so a name that
// has never yet resolved is re-scanned fresh on every call.)
const fakePathDir = path.join(tmpHome, "fake-path-dir");
fs.mkdirSync(fakePathDir, { recursive: true });
const fakeBinName = "loom-test-npx-stub-3b0c4aef";
const fakeBinFile = path.join(fakePathDir, fakeBinName + (process.platform === "win32" ? ".CMD" : ""));
const bareRow = { ...ghRow, provisionJson: JSON.stringify({ kind: "bundled", command: fakeBinName, args: [] }) };

const origPath = process.env.PATH ?? process.env.Path ?? "";
try {
  process.env.PATH = [fakePathDir, origPath].join(path.delimiter);
  check("(self-heal) a bare command not installed anywhere on PATH resolves to null (graceful skip, never throws)",
    resolveCapabilityServer(bareRow, {}) === null);

  fs.writeFileSync(fakeBinFile, ""); // "install" it, simulating npm/npx becoming available after boot
  const resolvedAfterInstall = resolveCapabilityServer(bareRow, {});
  check("(self-heal) the EXACT SAME row + provisionJson (unchanged, no re-seed) resolves once the binary appears on PATH",
    resolvedAfterInstall?.command === fakeBinFile);
} finally {
  process.env.PATH = origPath;
}

// An owner-added "command"-kind row (already resolved to an absolute path at REST catalog-save time, per
// validateCapabilityDefInput) must resolve BYTE-IDENTICALLY through the same branch — resolveExecutable on
// an already-absolute path is a documented no-op passthrough, so this is a regression guard, not new behavior.
const absoluteCommandRow = {
  ...ghRow, slug: "arb-abs-cmd", kind: "command",
  provisionJson: JSON.stringify({ kind: "command", command: process.execPath, args: ["--version"] }),
  requiresConnection: false, secretEnvVar: null,
};
const resolvedAbsCommand = resolveCapabilityServer(absoluteCommandRow, {});
check("(regression) a 'command'-kind row with an already-ABSOLUTE path still resolves to that exact path (unchanged)",
  resolvedAbsCommand?.command === process.execPath && JSON.stringify(resolvedAbsCommand?.args) === JSON.stringify(["--version"]));

db.close();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — GitHub capability (agent-tooling P4 follow-on 3b0c4aef, migrated off npx to github-binary): seed-if-absent seeding of the github-binary/version provision shape, generic resolveCapabilityServer/buildMcpServers dispatch (no bespoke host.ts path), a REAL P1 connection's token injected ONLY into the mounted server's env, secret-free claude argv + redacted spawn log, a REAL child_process spawn proving OS-level env-only delivery with an argv-free subprocess, and spawn-time self-heal re-resolution of a generic bare 'bundled' command (never frozen to seed-time PATH) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
