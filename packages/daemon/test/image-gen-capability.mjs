import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Agent-tooling P4 follow-on (board card b93cfd10, provider decided a4058e7a): the SECOND real
// credential-tied catalog capability — image generation via Google Gemini/Imagen. CARD e7d6e43b migrated
// this row off its original "bundled" (npx-resolved) shape onto the new seed-only "npm-pinned" kind
// (installed once under `<LOOM_HOME>/node/`, never a per-spawn npx re-resolve) — see
// npm-pinned-provision.mjs/npm-pinned-migration.mjs for that kind's own hermetic coverage. This test's job
// mirrors github-capability.mjs: prove the (now npm-pinned) seed shape, the generic
// resolveCapabilityServer/buildMcpServers dispatch, the credential tie (secret in env, never args), AND the
// scratch-dir env-var injection this row is the first to actually exercise (`outputDirEnvVar`) — via a
// fixture "echo-env" script standing in for the real `mcp-imagenate` package so this stays DETERMINISTIC +
// CLAUDE-FREE + NETWORK-FREE (no real install/network resolution of the seeded row itself is exercised
// here; `LOOM_NPM_PINNED_NO_PROVISION=1` keeps the real row's own cold resolve from kicking a real install
// as a side effect of this test).
//
// Proves:
//   (a) seedDefaultCapabilities seeds an "image-gen" row (alongside "github"), seed-if-absent (idempotent),
//       with the documented shape: requiresConnection, secretEnvVar "GEMINI_API_KEY", provision
//       {kind:"npm-pinned", package:"mcp-imagenate", version:<pinned exact semver>, binRelativeToPackageJson,
//       outputDirEnvVar}, wantsScratchDir true, and an "mcp__image-gen" tool allow entry.
//   (b) the description states the spend-guard gap (Loom's connection rate/spend guard doesn't cover this
//       MCP-subprocess path) — the card's explicit "say this at grant time" requirement.
//   (c) resolveCapabilityServer resolves the seeded row generically (the SAME dispatch an owner-added row
//       gets) — a cold (not-yet-installed) row resolves null, never throws.
//   (d) end-to-end through buildMcpServers with a REAL P1 connection (created + decrypted via the real
//       connections/store.ts): the Gemini key lands ONLY in the mounted server's env under GEMINI_API_KEY,
//       never in args — proven via a fixture-forced resolution (bypassing any real install/network
//       dependency; the fixture row uses kind "bundled" pointed directly at the echo-env script, which is
//       orthogonal to the real row's own kind).
//   (e) wantsScratchDir: true actually injects the session scratch dir into the mounted server's env under
//       the row's own `outputDirEnvVar` ("NANO_BANANA_OUTPUT_DIR") — the bundled/command/npm-pinned-kind
//       mechanism this row is the first to need (node-package's `--output-dir` CLI-arg convention doesn't
//       apply to any of those kinds at all until a provision opts into `outputDirEnvVar`).
//   (f) the HARD DoD: the secret never rides claude's own argv (buildSpawnArgs) or the redacted spawn-log
//       line, for THIS specific capability's mcp-config.
//   (g) a REAL child_process spawn (not a mocked exec call) of the resolved {command,args,env} proves the
//       secret AND the scratch dir arrive through the OS process env, and the secret is ABSENT from the
//       spawned process's own argv — the "throwaway echo-env MCP" the task's stub-verify path calls for.
//
// Run: 1) build (turbo builds shared first), 2) node test/image-gen-capability.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-imggen-cap-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// The github row's own binary-download provisioning is irrelevant to this test, but seedDefaultCapabilities
// seeds both rows together — disable it so a cold resolve of the seeded "github" row never kicks a real
// network download as a side effect of exercising this file.
process.env.LOOM_GITHUB_MCP_NO_PROVISION = "1";
// The image-gen row's own npm-pinned provisioning (card e7d6e43b) is likewise irrelevant to this test —
// disable it so a cold resolve of the REAL seeded row never kicks a real background `npm install` as a
// side effect of exercising this file (the credential-tie/scratch-dir plumbing is proven below via a
// FIXTURE row instead, which never touches this real-provisioning path at all).
process.env.LOOM_NPM_PINNED_NO_PROVISION = "1";

const { Db } = await import("../dist/db.js");
const { seedDefaultCapabilities, bundledCapabilities } = await import("../dist/capabilities/seed.js");
const { resolveCapabilityServer } = await import("../dist/capabilities/registry.js");
const {
  buildMcpServers, buildSpawnArgs, collectMcpEnvSecrets, mcpConfigHasSecret, redactSecrets,
} = await import("../dist/pty/host.js");
const { writeSessionMcpConfig } = await import("../dist/pty/claude-settings.js");
const { SETTINGS_DIR, sessionScratchDir } = await import("../dist/paths.js");
const { createConnection, getSecretForUse } = await import("../dist/connections/store.js");
fs.mkdirSync(SETTINGS_DIR, { recursive: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ECHO_ENV_FIXTURE = path.join(__dirname, "fixtures", "echo-env.mjs");

// A distinctive stub key/path — presence anywhere OTHER than the spawned fixture's own env is a hard failure.
const STUB_KEY = "AIzaSTUB-do-not-leak-abcdefghijklmnop";
const STUB_SCRATCH_DIR = path.join(tmpHome, "stub-scratch-dir");

// ===================== (a) seedDefaultCapabilities =====================
const db = new Db();
check("(seed) pristine db has no capability_defs rows yet", db.listCapabilityDefs().length === 0);
const seeded = seedDefaultCapabilities(db);
check("(seed) seeds 'image-gen' (among the bundled set)", seeded.includes("image-gen"));
const igRow = db.getCapabilityDefBySlug("image-gen");
check("(seed) the row exists in the db", !!igRow);
check("(seed) name mentions Gemini/Imagen", /gemini|imagen/i.test(igRow.name));
check("(seed) transport is stdio", igRow.transport === "stdio");
check("(seed) kind is 'npm-pinned' (installed once under LOOM_HOME, NOT a per-spawn npx re-resolve — card e7d6e43b)", igRow.kind === "npm-pinned");
check("(seed) requiresConnection is true", igRow.requiresConnection === true);
check("(seed) secretEnvVar is 'GEMINI_API_KEY'", igRow.secretEnvVar === "GEMINI_API_KEY");
check("(seed) wantsScratchDir is true (images must land on disk, not in the agent's context)", igRow.wantsScratchDir === true);
check("(seed) tool allowlist grants the whole 'mcp__image-gen' server (mirrors the mcp__github convention)",
  JSON.parse(igRow.toolAllowlistJson).includes("mcp__image-gen"));
const igProvision = JSON.parse(igRow.provisionJson);
check("(seed) provision kind is 'npm-pinned'", igProvision.kind === "npm-pinned");
check("(seed) provision.package is 'mcp-imagenate'", igProvision.package === "mcp-imagenate");
// CODE-REVIEW FIX (Major, carried forward from the original bundled/npx shape): the package must be PINNED
// to an exact version — an unpinned resolve would re-resolve to whatever is "latest" at install time, so a
// future compromised release would silently run with the user's live Gemini key, and the trust review
// documented in seed.ts's own doc comment is specific to the version actually inspected (disk-write
// behavior, NANO_BANANA_OUTPUT_DIR realpathSync sandboxing, provider-gated-by-key model registry) — not to
// "whatever mcp-imagenate becomes."
check("(seed) the version is PINNED to an exact semver, never a bare/unpinned/range spec", /^\d+\.\d+\.\d+/.test(igProvision.version));
check("(seed) provision.binRelativeToPackageJson names the installed package's own bin entry point",
  typeof igProvision.binRelativeToPackageJson === "string" && igProvision.binRelativeToPackageJson.length > 0);
check("(seed) provision.outputDirEnvVar names the env var the chosen MCP reads for its output directory",
  typeof igProvision.outputDirEnvVar === "string" && igProvision.outputDirEnvVar.length > 0);

// (b) the SPEND-GUARD GAP must be stated plainly in the description at grant time (the card's explicit ask).
check("(seed) description names the spend/rate guard gap for this MCP-subprocess path",
  /spend/i.test(igRow.description) && /guard/i.test(igRow.description));
check("(seed) description says Loom's guard covers the P2 authenticated_request path, not this one",
  igRow.description.includes("authenticated_request"));
check("(seed) description points to an owner-set provider-side spend cap as the actual control",
  /owner-set spend cap/i.test(igRow.description));

// seed-if-absent: calling again on the SAME db is a no-op (idempotent), never a duplicate/throw.
const secondSeedCall = seedDefaultCapabilities(db);
check("(seed) a second call seeds nothing (idempotent, seed-if-absent by slug)", secondSeedCall.length === 0);
check("(seed) exactly the bundled row count persists (github + image-gen, no dupes)", db.listCapabilityDefs().length === bundledCapabilities().length);

// bundledCapabilities() itself is a pure function callers can inspect without a db.
check("(seed) bundledCapabilities() includes the 'image-gen' definition", bundledCapabilities().some((c) => c.slug === "image-gen"));

// ===================== (c) resolveCapabilityServer resolves the REAL seeded row generically =====================
// A fresh LOOM_HOME has never installed this package, and LOOM_NPM_PINNED_NO_PROVISION=1 (set above) means
// the cold miss classifies 'disabled' rather than kicking a real install — so this resolves null
// deterministically, never a real/unresolved-npx ambiguity like the old bundled/npx shape had.
const resolvedNoSecret = resolveCapabilityServer(igRow, {});
check("(resolve) cold (not yet installed) + provisioning disabled ⇒ resolves null, never partially mounts", resolvedNoSecret === null);

// ===================== (d)+(e) end-to-end through buildMcpServers: credential tie AND scratch-dir env injection =====================
const conn = createConnection(db, { name: "Test Gemini key", host: "generativelanguage.googleapis.com", authScheme: "bearer", secret: STUB_KEY });
check("(connection) a real encrypted P1 connection round-trips back to the stub key", getSecretForUse(db, conn.id) === STUB_KEY);

// Force resolution via the fixture (bypassing any real npx/network dependency) so this DoD-critical
// assertion is NEVER environment-dependent — the whole point is proving the plumbing, independent of
// whether `mcp-imagenate` is actually installed/reachable on the machine running this test.
const igRowFixture = {
  ...igRow,
  provisionJson: JSON.stringify({ kind: "bundled", command: process.execPath, args: [ECHO_ENV_FIXTURE], outputDirEnvVar: igProvision.outputDirEnvVar }),
};

// (c continued) prove the REAL seeded row's own generic dispatch first — a cold/not-yet-installed row
// resolves to null (graceful skip), never throws; the fixture-forced row below is what proves the actual
// env-injection plumbing deterministically.
let realResolveThrew = false;
try { resolveCapabilityServer(igRow, { scratchDir: STUB_SCRATCH_DIR, connectionSecret: STUB_KEY }); } catch { realResolveThrew = true; }
check("(resolve) the real seeded row's generic dispatch never throws (graceful skip if not yet installed)", !realResolveThrew);

const resolvedFixture = resolveCapabilityServer(igRowFixture, { scratchDir: STUB_SCRATCH_DIR, connectionSecret: STUB_KEY });
check("(fixture) the fixture-backed row resolves", !!resolvedFixture);
check("(fixture) the Gemini key rides the env under GEMINI_API_KEY, never args",
  resolvedFixture?.env?.GEMINI_API_KEY === STUB_KEY && !(resolvedFixture?.args ?? []).includes(STUB_KEY));
check("(fixture) wantsScratchDir injects the session scratch dir under the row's own outputDirEnvVar",
  resolvedFixture?.env?.[igProvision.outputDirEnvVar] === STUB_SCRATCH_DIR);

// A row with wantsScratchDir but no ctx.scratchDir (or no outputDirEnvVar) must NOT inject a scratch env —
// the mechanism is additive/opt-in, never a surprise env var for a row that didn't ask for it.
const resolvedNoCtxScratch = resolveCapabilityServer(igRowFixture, { connectionSecret: STUB_KEY });
check("(fixture) no ctx.scratchDir ⇒ no scratch env var injected (only the secret)",
  resolvedNoCtxScratch?.env?.GEMINI_API_KEY === STUB_KEY && !(igProvision.outputDirEnvVar in (resolvedNoCtxScratch?.env ?? {})));

const withImageGenFixture = buildMcpServers({
  sessionId: "s-ig1", port: 4317, role: "worker",
  capabilities: [{ slug: "image-gen", connectionId: conn.id }],
  capabilityCatalog: [igRowFixture],
  resolveConnectionSecret: (id) => getSecretForUse(db, id),
});
check("(e2e) the fixture-backed row mounts under its OWN slug key through buildMcpServers", "image-gen" in withImageGenFixture);
check("(e2e) the real stub key rides the mounted server's OWN env under GEMINI_API_KEY",
  withImageGenFixture["image-gen"]?.env?.GEMINI_API_KEY === STUB_KEY);
// buildMcpServers computes its OWN scratch dir internally (sessionScratchDir(sessionId)) — not the STUB_
// SCRATCH_DIR used in the direct resolveCapabilityServer calls above — so this asserts against that real path.
check("(e2e) wantsScratchDir injects buildMcpServers' OWN session scratch dir under outputDirEnvVar",
  withImageGenFixture["image-gen"]?.env?.[igProvision.outputDirEnvVar] === sessionScratchDir("s-ig1"));

// ===================== (f) HARD DoD: the secret never rides claude's argv or the redacted spawn log =====================
check("(leak) collectMcpEnvSecrets finds the stub key embedded in the fixture row's env", collectMcpEnvSecrets(withImageGenFixture).includes(STUB_KEY));
check("(leak) mcpConfigHasSecret is true for the fixture mcp-config", mcpConfigHasSecret(withImageGenFixture) === true);

const igSecrets = collectMcpEnvSecrets(withImageGenFixture);
const igMcpConfigPath = writeSessionMcpConfig("s-ig1", withImageGenFixture);
check("(leak) a secret-bearing spawn diverts --mcp-config to a FILE (never inline in the claude argv)",
  fs.readFileSync(igMcpConfigPath, "utf8").includes(STUB_KEY));

const igSpawnArgs = buildSpawnArgs({ settingsPath: "/fake/settings.json", mode: "acceptEdits", mcpServers: withImageGenFixture, mcpConfigPath: igMcpConfigPath });
check("(leak) the claude spawn argv uses the FILE PATH, not inline JSON", igSpawnArgs.includes(igMcpConfigPath));
check("(leak) the stub key NEVER appears anywhere in the claude process argv", !JSON.stringify(igSpawnArgs).includes(STUB_KEY));

const igSpawnLog = redactSecrets(JSON.stringify(igSpawnArgs), igSecrets);
check("(leak) the stub key never appears in the (redacted) daemon spawn-log line either", !igSpawnLog.includes(STUB_KEY));

// ===================== (g) REAL child_process spawn: env-only delivery, argv-free (the stub-verify DoD) =====================
// Spawns the ACTUAL resolved {command,args,env} entry — not a mocked exec call — so this proves the OS-level
// env transmission genuinely works cross-platform for BOTH the secret and the scratch dir, and that the
// secret is absent from the spawned process's own argv.
const igServer = withImageGenFixture["image-gen"];
const { stdout } = await execFileAsync(igServer.command, igServer.args, {
  env: { ...process.env, ...igServer.env },
});
const echoed = JSON.parse(stdout);
check("(spawn) the REAL spawned subprocess received the Gemini key via its OWN env", echoed.env.GEMINI_API_KEY === STUB_KEY);
check("(spawn) the REAL spawned subprocess received the scratch dir via its OWN env", echoed.env[igProvision.outputDirEnvVar] === sessionScratchDir("s-ig1"));
check("(spawn) the REAL spawned subprocess's own argv does NOT contain the Gemini key", !JSON.stringify(echoed.argv).includes(STUB_KEY));
check("(spawn) the command line handed to the subprocess never embedded the secret either",
  !igServer.args.join(" ").includes(STUB_KEY) && !igServer.command.includes(STUB_KEY));

db.close();
try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — Image-generation capability (agent-tooling P4 follow-on b93cfd10, provider decided a4058e7a; migrated to npm-pinned by card e7d6e43b): seed-if-absent seeding of the Gemini/Imagen 'image-gen' row (npm-pinned, requiresConnection, GEMINI_API_KEY, wantsScratchDir, the spend-guard-gap description), generic resolveCapabilityServer/buildMcpServers dispatch, a REAL P1 connection's key injected ONLY into the mounted server's env, the outputDirEnvVar scratch-dir injection (opt-in, additive), secret-free claude argv + redacted spawn log, and a REAL child_process spawn proving OS-level env-only delivery of BOTH the secret and the scratch dir with an argv-free subprocess — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
