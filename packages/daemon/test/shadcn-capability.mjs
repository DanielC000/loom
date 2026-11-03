import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c3f9ce1f: seed a pinned shadcn/ui MCP capability (kind "npm-pinned", a direct bin — never a bare
// `npx`, per card 5b1c19c0's measured cold-start headroom). Mirrors github-capability.mjs/
// image-gen-capability.mjs's shape, but shadcn needs neither a connection nor a secret — its own risk is
// the OPPOSITE direction: card 5b1c19c0 measured that shadcn's own registry client expands `${VAR}` from
// its process env into registry URLs/headers named by a repo-controlled components.json, so this row must
// receive NOTHING beyond the shared launcher's base allowlist (no passEnv, no proxy vars). DETERMINISTIC +
// CLAUDE-FREE + NETWORK-FREE (LOOM_NPM_PINNED_NO_PROVISION=1 disables any real install of the seeded row).
//
// Proves:
//   (a) seedDefaultCapabilities seeds a "shadcn" row, seed-if-absent, with the documented shape:
//       kind "npm-pinned", pinned version, provision.args ["mcp"], toolAllowlist "mcp__shadcn", no
//       connection, no secret, passEnv:[].
//   (b) buildMcpServers: a granted profile mounts "shadcn"; an UNGRANTED spawn's map is byte-identical to
//       one with no capabilities at all.
//   (c) the mounted server unwraps (via the shared _env-isolation-helpers.mjs unwrap) to
//       {realCommand: process.execPath, realArgs: ["--import", <SHADCN_NO_DOTENV_PRELOAD_SCRIPT file://
//       URL>, bin, "mcp"], allowKeys: []} — card c3f9ce1f's dotenv-exfil preload rides BEFORE the row's
//       own `args` (neither silently dropped), and the allow-list is EMPTY (no env, no passEnv) —
//       RED-proved against a mutant that drops `args`. The preload mechanism itself (the resolve-redirect
//       to the no-op stub, and a RED proof against a mutant that disables it) is covered by the dedicated
//       test/shadcn-no-dotenv-preload.mjs, not here.
//   (d) a REAL child_process spawn (not a mocked exec) of the actual env-isolated-launch.mjs launcher,
//       with THIS row's real (empty) allow-list and a fixture standing in for the pinned bin, with a
//       sentinel planted in the PARENT env for EACH of HTTP_PROXY, HTTPS_PROXY, ALL_PROXY/all_proxy (one
//       case form planted per spawn — Windows env vars are case-insensitive, so planting both cases at
//       once collapses to one OS-level slot; the readback checks BOTH case keys regardless of which one
//       won), a userinfo-shaped npm_config_registry, and a generic var — asserts ALL are absent from the
//       spawned fixture's own observed env. Do not weaken or skip these assertions to mask a regression
//       if either guard (the BASE_ALLOWLIST proxy-key drop, or its npm_config_registry counterpart) ever
//       erodes.
//   (e) profiles/validate.ts rejects an explicit codex profile holding the "shadcn" grant specifically
//       (the existing codexStdioOffenders mechanism is generic over any non-empty capabilities array;
//       this names "shadcn" for this card's own traceability).
//   (f) no bundled profile (profiles/seed.ts) pre-ticks the "shadcn" capability.
//   (g) "npm-pinned" (with an `args` field present) is still REJECTED from owner input — the new `args`
//       field does not open a new owner-reachable path onto a seed-only kind.
//   (h) image-gen's own mount shape stays byte-identical `[bin]` (no `args` set on that row) — the new
//       optional `args` field on the npm-pinned provision is additive, not a regression for the sibling row.
//
// Run: 1) build (turbo builds shared first), 2) node test/shadcn-capability.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

const execFileAsync = promisify(execFile);
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = useOwnLoomHome("loom-shadcn-cap-");
// The github row's download provisioning and the image-gen/shadcn rows' own npm-pinned provisioning are
// all irrelevant to this test (seedDefaultCapabilities seeds every bundled row together) — disable both
// so a cold resolve of any OTHER seeded row never kicks a real network download/install as a side effect
// of exercising this file.
process.env.LOOM_GITHUB_MCP_NO_PROVISION = "1";
process.env.LOOM_NPM_PINNED_NO_PROVISION = "1";

const { Db } = await import("../dist/db.js");
const { seedDefaultCapabilities, bundledCapabilities } = await import("../dist/capabilities/seed.js");
const { resolveCapabilityServer, validateCapabilityDefInput } = await import("../dist/capabilities/registry.js");
const { loomNpmPinnedBin } = await import("../dist/capabilities/npm-pinned.js");
const { buildMcpServers } = await import("../dist/pty/host.js");
const { validateProfile } = await import("../dist/profiles/validate.js");
const { BUNDLED_PROFILES } = await import("../dist/profiles/seed.js");
const { ENV_ISOLATED_LAUNCH_SCRIPT, SHADCN_NO_DOTENV_PRELOAD_SCRIPT } = await import("../dist/paths.js");
const { unwrapLauncherMount } = await import("./_env-isolation-helpers.mjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ECHO_ENV_FIXTURE = path.join(__dirname, "fixtures", "echo-env.mjs");

// ===================== (a) seedDefaultCapabilities =====================
const db = new Db();
check("(seed) pristine db has no capability_defs rows yet", db.listCapabilityDefs().length === 0);
const seeded = seedDefaultCapabilities(db);
check("(seed) seeds 'shadcn' (among the bundled set)", seeded.includes("shadcn"));
const scRow = db.getCapabilityDefBySlug("shadcn");
check("(seed) the row exists in the db", !!scRow);
check("(seed) name mentions shadcn", /shadcn/i.test(scRow.name));
check("(seed) transport is stdio", scRow.transport === "stdio");
check("(seed) kind is 'npm-pinned' (direct bin, NEVER a bare npx — card 5b1c19c0's measured cold-start)", scRow.kind === "npm-pinned");
check("(seed) requiresConnection is false (no credential — this row has none)", scRow.requiresConnection === false);
check("(seed) secretEnvVar is null", scRow.secretEnvVar === null);
check("(seed) wantsScratchDir is false (read-only tools; no output to disk)", scRow.wantsScratchDir === false);
check("(seed) passEnv is [] (deliberately, never widened for this row)", Array.isArray(scRow.passEnv) && scRow.passEnv.length === 0);
check("(seed) tool allowlist grants the whole 'mcp__shadcn' server",
  JSON.parse(scRow.toolAllowlistJson).includes("mcp__shadcn"));
const scProvision = JSON.parse(scRow.provisionJson);
check("(seed) provision kind is 'npm-pinned'", scProvision.kind === "npm-pinned");
check("(seed) provision.package is 'shadcn'", scProvision.package === "shadcn");
check("(seed) the version is PINNED to an exact semver, never a bare/unpinned/range spec", /^\d+\.\d+\.\d+/.test(scProvision.version));
check("(seed) provision.binRelativeToPackageJson names the installed package's own bin entry point",
  typeof scProvision.binRelativeToPackageJson === "string" && scProvision.binRelativeToPackageJson.length > 0);
check("(seed) provision.args is ['mcp'] (the bin is a multi-command entry point)",
  JSON.stringify(scProvision.args) === JSON.stringify(["mcp"]));

// The card's own required description content (React+Tailwind, network dependency, agent's own `shadcn
// add` + merge-gate-as-backstop, and — per this card's own proxy finding — the deliberate no-proxy posture).
check("(seed) description names the React + Tailwind requirement", /react/i.test(scRow.description) && /tailwind/i.test(scRow.description));
check("(seed) description states the network dependency", /network dependency/i.test(scRow.description));
check("(seed) description says component code enters via the agent's own 'shadcn add'", scRow.description.includes("shadcn add"));
check("(seed) description names the merge gate as the backstop", /merge gate/i.test(scRow.description));
check("(seed) description states it fetches without proxy settings configured", /without any proxy configured/i.test(scRow.description));

// seed-if-absent: calling again on the SAME db is a no-op (idempotent), never a duplicate/throw.
const secondSeedCall = seedDefaultCapabilities(db);
check("(seed) a second call seeds nothing (idempotent, seed-if-absent by slug)", secondSeedCall.length === 0);
check("(seed) exactly the bundled row count persists (github + image-gen + shadcn, no dupes)", db.listCapabilityDefs().length === bundledCapabilities().length);

// bundledCapabilities() itself is a pure function callers can inspect without a db.
check("(seed) bundledCapabilities() includes the 'shadcn' definition", bundledCapabilities().some((c) => c.slug === "shadcn"));

// ===================== (c, cold) resolveCapabilityServer on the REAL (not-yet-installed) row =====================
// A fresh LOOM_HOME has never installed this package, and LOOM_NPM_PINNED_NO_PROVISION=1 (set above) means
// a cold miss classifies 'disabled' rather than kicking a real install — so this resolves null
// deterministically (never partially mounts), same shape as image-gen-capability.mjs's own (c). Checked
// BEFORE warming the row below.
const coldResolved = resolveCapabilityServer(scRow, {});
check("(c, cold) resolveCapabilityServer on the REAL (cold, provisioning-disabled) row resolves null, never throws/partially mounts", coldResolved === null);

// ===================== warm the REAL row: simulate an already-installed bin (no real npm install) =====================
// resolveNpmPinned's hot path is a bare fs.existsSync(bin) against the FINAL install path — creating a
// file there directly (mirrors npm-pinned-provision.mjs's own 'READY_BIN' pattern) proves the REAL
// "npm-pinned" kind dispatch end to end, through the ACTUAL seeded row, rather than swapping in a
// different provision kind as a stand-in.
const realBinPath = loomNpmPinnedBin(scProvision.package, scProvision.version, scProvision.binRelativeToPackageJson);
fs.mkdirSync(path.dirname(realBinPath), { recursive: true });
fs.writeFileSync(realBinPath, "// test stand-in, never executed by this test\n");

// ===================== (b) buildMcpServers: granted mounts it; ungranted is byte-identical =====================
// SAME sessionId across every call in this section — buildMcpServers embeds sessionId into every mounted
// URL (loom-tasks/loom-orchestration), so comparing calls with DIFFERENT session ids would never be
// byte-identical regardless of the capabilities grant; holding it fixed isolates the one variable this
// section actually means to test.
const SC_SESSION_ID = "s-sc-fixed";
const catalog = db.listCapabilityDefs();
const ungrantedBaseline = buildMcpServers({ sessionId: SC_SESSION_ID, port: 4317, role: "worker", capabilities: [], capabilityCatalog: catalog });
const ungrantedOmitted = buildMcpServers({ sessionId: SC_SESSION_ID, port: 4317, role: "worker", capabilityCatalog: catalog });
check("(b) an ungranted spawn's mcpServers map is byte-identical whether capabilities is [] or omitted entirely",
  JSON.stringify(ungrantedBaseline) === JSON.stringify(ungrantedOmitted));
check("(b) an ungranted spawn never mounts 'shadcn'", !("shadcn" in ungrantedBaseline));

const granted = buildMcpServers({ sessionId: SC_SESSION_ID, port: 4317, role: "worker", capabilities: [{ slug: "shadcn" }], capabilityCatalog: catalog });
check("(b) a granted spawn mounts 'shadcn'", "shadcn" in granted);
// Every OTHER key besides 'shadcn' must still match the ungranted baseline exactly — proves the grant is
// purely additive, not a side effect on anything else buildMcpServers mounts.
const grantedMinusShadcn = { ...granted };
delete grantedMinusShadcn.shadcn;
check("(b) every OTHER mounted key is byte-identical to the ungranted baseline", JSON.stringify(grantedMinusShadcn) === JSON.stringify(ungrantedBaseline));

// ===================== (c, warm) mount shape: args reaches the mount; allow-list is empty =====================
const unwrapped = unwrapLauncherMount(granted.shadcn);
const SHADCN_PRELOAD_URL = pathToFileURL(SHADCN_NO_DOTENV_PRELOAD_SCRIPT).href;

check("(c) the mounted 'shadcn' server IS wrapped by the env-isolating launcher", !!unwrapped);
check("(c) realCommand is process.execPath (node + an absolute bin script, like node-package)", unwrapped?.realCommand === process.execPath);
check("(c) realArgs is ['--import', <preload file:// URL>, <resolved bin path>, 'mcp'] — card c3f9ce1f's dotenv-exfil preload rides BEFORE provision.args reaches the mount (neither silently dropped)",
  JSON.stringify(unwrapped?.realArgs) === JSON.stringify(["--import", SHADCN_PRELOAD_URL, realBinPath, "mcp"]));
check("(c) the allow-list is EMPTY — no env, no passEnv for this row, so only the base allowlist reaches the child",
  Array.isArray(unwrapped?.allowKeys) && unwrapped.allowKeys.length === 0);

// Direct resolveCapabilityServer call (bypassing buildMcpServers' wrap/catalog-lookup) on the now-warm REAL
// row proves the SAME args-appending behavior at the one function that actually builds the raw mount —
// belt-and-suspenders with the end-to-end (c) check above, at a narrower unit.
const warmResolved = resolveCapabilityServer(scRow, {});
check("(c) the warm REAL row's raw (unwrapped) mount is {command: process.execPath, args:['--import', <preload url>, bin, 'mcp']}",
  warmResolved?.command === process.execPath && JSON.stringify(warmResolved?.args) === JSON.stringify(["--import", SHADCN_PRELOAD_URL, realBinPath, "mcp"]));

// ===================== (d) REAL spawn: the launcher's child env, with planted sentinels =====================
// Builds the SAME {command, args} the launcher mechanism exposes for the shadcn row's allow-list (empty,
// per (c) above), and spawns env-isolated-launch.mjs DIRECTLY (a real child_process.spawn, not a mocked
// exec) with ECHO_ENV_FIXTURE standing in for the pinned bin — avoiding any real npm/network dependency
// while still proving the REAL OS-level env-isolation mechanism end to end for this row's own allow-list.
// NOTE: ALL_PROXY/all_proxy are tested as ONE logical var, not two — Windows env vars are
// case-insensitive, so planting both cases in a single JS env object collapses to one OS-level slot
// (whichever case wins is a Windows implementation detail, not something this test should depend on).
// buildIsolatedEnv's own matching is already case-insensitive BY CODE (`k.toLowerCase()`), which is the
// actual thing proving case doesn't matter — a second real OS spawn to re-prove that would be redundant,
// not a stronger check. This spawn uses the lowercase form (`all_proxy`) since that's the POSIX-canonical
// casing for this proxy var generally — it is NOT in BASE_ALLOWLIST at all (neither case form is; see
// env-isolated-launch.mjs's own list), which is exactly what this section asserts.
const SENTINEL_HTTP_PROXY = "http://u:SENTINEL-HTTP@proxy.example:8080";
const SENTINEL_HTTPS_PROXY = "https://u:SENTINEL-HTTPS@proxy.example:8443";
const SENTINEL_ALL_PROXY = "socks5://u:SENTINEL-ALL@proxy.example:1080";
const SENTINEL_NPM_REGISTRY = "https://u:SENTINEL-REGISTRY@registry.example/";
const SENTINEL_GENERIC = "SENTINEL-GENERIC-do-not-leak";

const plantedParentEnv = {
  ...process.env,
  HTTP_PROXY: SENTINEL_HTTP_PROXY,
  HTTPS_PROXY: SENTINEL_HTTPS_PROXY,
  all_proxy: SENTINEL_ALL_PROXY,
  npm_config_registry: SENTINEL_NPM_REGISTRY,
  SHADCN_PROBE_GENERIC_VAR: SENTINEL_GENERIC,
};

const { stdout } = await execFileAsync(process.execPath, [
  ENV_ISOLATED_LAUNCH_SCRIPT, "--allow", (unwrapped?.allowKeys ?? []).join(","), "--", process.execPath, ECHO_ENV_FIXTURE,
], { env: plantedParentEnv });
const echoed = JSON.parse(stdout);

// Card 3def5ccf: `plantedParentEnv` spreads the REAL ambient `process.env` (unlike the sibling
// echo-env tests, which build an explicit, hardcoded-key env object), so on a Windows host where the
// parent process's own env block carries the Windows-normal key casing "Path" (e.g. a daemon launched
// from PowerShell), buildIsolatedEnv's case-insensitive-but-casing-preserving match hands the fixture
// back a "Path" key, not "PATH" — a case-SENSITIVE JS property read then misses it. Read every env-name
// assertion below case-insensitively so this test is correct under either key casing.
const envKeyCI = (env, name) => {
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((k) => k.toUpperCase() === upper);
  return key === undefined ? undefined : env[key];
};

check("(d) the fixture actually ran under the launcher (received SOME env)", echoed && typeof echoed.env === "object");
// CR NIT: the check above passes trivially on an empty {} — PATH is in BASE_ALLOWLIST (every mount gets
// it), so asserting it's actually present and non-empty proves the fixture received a REAL, non-empty
// isolated env rather than an empty object that happened to satisfy the typeof check.
check("(d) PATH is PRESENT and non-empty (proves a real, non-empty isolated env reached the fixture, not just {})",
  typeof envKeyCI(echoed.env, "PATH") === "string" && envKeyCI(echoed.env, "PATH").length > 0);
check("(d) HTTP_PROXY is ABSENT from shadcn's child env", envKeyCI(echoed.env, "HTTP_PROXY") === undefined);
check("(d) HTTPS_PROXY is ABSENT from shadcn's child env", envKeyCI(echoed.env, "HTTPS_PROXY") === undefined);
// Either case form may carry the planted value through to the launcher's own inherited env (Windows env
// vars are case-insensitive — which literal case name wins is an OS implementation detail, not something
// to assume) — the case-insensitive lookup above already covers both case keys the output could possibly
// carry it under.
check("(d) ALL_PROXY/all_proxy (either case) is ABSENT from shadcn's child env", envKeyCI(echoed.env, "ALL_PROXY") === undefined);
check("(d) a userinfo-shaped npm_config_registry is ABSENT from shadcn's child env", envKeyCI(echoed.env, "npm_config_registry") === undefined);
check("(d) an un-allowlisted generic var is ABSENT from shadcn's child env", envKeyCI(echoed.env, "SHADCN_PROBE_GENERIC_VAR") === undefined);
check("(d) no sentinel VALUE leaked under any OTHER key name either (defense in depth on the name-based checks above)",
  !JSON.stringify(echoed.env).includes("SENTINEL"));

// ===================== (e) codex rejection, named for THIS capability =====================
check("(e) harness:codex + capabilities:[{slug:'shadcn'}] is rejected", (() => {
  const r = validateProfile({ name: "X", harness: "codex", capabilities: [{ slug: "shadcn" }] });
  return r.ok === false && /capabilities is not supported on harness "codex"/.test(r.error);
})());
check("(e) harness:claude + capabilities:[{slug:'shadcn'}] is still accepted (the gate is codex-only)", (() => {
  const r = validateProfile({ name: "X", harness: "claude", capabilities: [{ slug: "shadcn" }] });
  return r.ok === true;
})());

// ===================== (f) no bundled profile pre-ticks it =====================
for (const p of BUNDLED_PROFILES) {
  check(`(f) bundled profile '${p.name}' does not pre-tick 'shadcn'`, !(p.capabilities ?? []).some((c) => c.slug === "shadcn"));
}

// ===================== (g) 'npm-pinned' (even carrying 'args') is still owner-REJECTED =====================
check("(g) kind 'npm-pinned' with an 'args' field present is still REJECTED — seed-only, never owner-typeable",
  validateCapabilityDefInput({
    slug: "arb-npm-args", name: "x", description: "", transport: "stdio", kind: "npm-pinned",
    provision: { package: "cowsay", version: "1.6.0", binRelativeToPackageJson: "cli.js", args: ["mcp"] },
    toolAllowlist: [],
  }).ok === false);

// ===================== (h) image-gen's own mount shape stays byte-identical [bin] =====================
const igRow = db.getCapabilityDefBySlug("image-gen");
const igProvision = JSON.parse(igRow.provisionJson);
check("(h) image-gen's provision carries no 'args' field (the new field is opt-in, unused by this sibling row)", igProvision.args === undefined);

const igColdResolved = resolveCapabilityServer(igRow, {});
check("(h) image-gen's own real row resolves null when cold + provisioning disabled (never throws)", igColdResolved === null);

// Warm image-gen's REAL row the SAME way (c) warmed shadcn's — a direct fs.existsSync hit against its
// own FINAL install path, no fixture/kind swap — so this is a true byte-identity proof of the SAME
// resolveCapabilityServer npm-pinned branch both rows share, not a different code path.
const igBinPath = loomNpmPinnedBin(igProvision.package, igProvision.version, igProvision.binRelativeToPackageJson);
fs.mkdirSync(path.dirname(igBinPath), { recursive: true });
fs.writeFileSync(igBinPath, "// test stand-in, never executed by this test\n");
const igWarmResolved = resolveCapabilityServer(igRow, {});
check("(h) image-gen's warm mount shape is BYTE-IDENTICAL to {command: process.execPath, args:[bin]} — no 'mcp' or any other extra arg leaks in from the shared branch",
  igWarmResolved?.command === process.execPath && JSON.stringify(igWarmResolved?.args) === JSON.stringify([igBinPath]));

db.close();

console.log(failures === 0
  ? "\n✅ ALL PASS — shadcn capability (card c3f9ce1f): seed-if-absent seeding of the npm-pinned 'shadcn' row (pinned version, 'mcp' subcommand args, no connection/secret/passEnv), generic buildMcpServers dispatch (ungranted byte-identical, granted purely additive), the env-isolating launcher wrap with an EMPTY allow-list, a REAL child_process spawn proving the proxy keys + a userinfo-shaped npm_config_registry + a generic var are ALL absent from this row's child env, codex rejection named for this capability, no bundled profile pre-ticking it, the npm-pinned kind staying owner-unreachable even with 'args' present, and image-gen's own sibling-row shape staying byte-identical — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
